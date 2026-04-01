import inspect
import json
import os
from pathlib import Path
import sys
import types
from typing import Any, Optional
import typing
from shellac import Window
from pydantic import BaseModel, TypeAdapter, model_validator
import sqlite3

from logger import get_logger

logger = get_logger("plugins")

sys.dont_write_bytecode = True

# --- Models ---

class ConfigPropertyModel(BaseModel):
    name: str
    type: str
    default: Any = None
    value: Any = None

    @model_validator(mode='after')
    def validate_and_sync(self) -> 'ConfigPropertyModel':
        # This part runs during Pydantic validation
        namespace = {k: v for k, v in typing.__dict__.items() if not k.startswith("__")}
        namespace.update({"int": int, "str": str, "float": float, "bool": bool, "list": list, "dict": dict})
        
        try:
            resolved_type = eval(self.type, {}, namespace)
        except NameError as e:
            raise ValueError(f"Unsupported type string: {self.type}. Error: {e}")

        if self.value is None:
            self.value = self.default

        adapter = TypeAdapter(resolved_type)
        try:
            self.default = adapter.validate_python(self.default)
            self.value = adapter.validate_python(self.value)
        except Exception as e:
            raise ValueError(f"Value validation failed for type {self.type}: {e}")

        return self
    
class ManifestModel(BaseModel):
    name: str = 'Unknown Plugin'
    files: list[str] = []
    python_script: Optional[str] = None
    config: list[ConfigPropertyModel] = []
    dependencies: list[str] =[]

# --- Core Logic ---

def get_base_path():
    """Get the root directory of the application reliably."""
    if getattr(sys, 'frozen', False):
        return str(Path(sys.executable).parent.resolve())
    
    return str(Path(__file__).parent.resolve())

class PluginStorage:
    def __init__(self, db_path):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute('CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT)')
        self.conn.commit()

    def get(self, key):
        cur = self.conn.execute('SELECT value FROM storage WHERE key = ?', (key,))
        row = cur.fetchone()
        return json.loads(row[0]) if row else None

    def set(self, key, value):
        self.conn.execute('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)', (key, json.dumps(value)))
        self.conn.commit()

    def delete(self, key):
        self.conn.execute('DELETE FROM storage WHERE key = ?', (key,))
        self.conn.commit()

class Plugin:
    def __init__(self, window: Window, folder: str, manifest_file: str = 'manifest.json'):
        self.window = window
        self.folder = folder
        self.manifest_file = manifest_file
        self.manifest: ManifestModel = ManifestModel()
        self.python_instance = None
        self._is_loaded = False
        
        self.log = get_logger(f"plugin.{os.path.basename(folder)}")
        self.load()

    @property
    def is_valid(self) -> bool:
        return self._is_loaded

    def load(self):
        manifest_path = os.path.join(self.folder, self.manifest_file)
        self.log.verbose(f"Looking for manifest at: {manifest_path}")

        if not os.path.exists(manifest_path):
            self.log.warning("Manifest not found. Skipping directory.")
            return

        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                content = f.read()
                self.manifest = ManifestModel.model_validate_json(content)
            
            self._is_loaded = True
            self.log.success(f"Loaded manifest for '{self.manifest.name}'")
            self.log.verbose(f"Resources: {len(self.manifest.files)} files, {len(self.manifest.config)} config props")
        except Exception as e:
            self.log.error(f"Failed to parse manifest: {e}")
            return

        if self.manifest.python_script:
            self._load_python_module()
        else:
            self.log.verbose("No python_script defined in manifest.")

    def _load_python_module(self):
        """
        Loads the plugin's Python module using exec() to bypass timestamp/metadata checks.
        """
        script_path = os.path.join(self.folder, self.manifest.python_script)
        vendor_path = os.path.join(self.folder, 'lib') 
        self.log.verbose(f"Attempting to load Python backend from: {script_path}")

        if not os.path.exists(script_path):
            self.log.error(f"Python script '{self.manifest.python_script}' missing from folder.")
            return

        if os.path.isdir(vendor_path):
            sys.path.insert(0, vendor_path)

        try:
            module_name = f"plugin_mod_{self.manifest.name.replace(' ', '_')}"
            
            with open(script_path, 'r', encoding='utf-8') as f:
                source_code = f.read()

            module = types.ModuleType(module_name)
            module.__file__ = script_path
            sys.modules[module_name] = module

            exec(source_code, module.__dict__)

            if hasattr(module, 'Main'):
                self.log.verbose("Found 'Main' class. Instantiating with dependency injection...")
                
                config_dict = {p.name: p.value for p in self.manifest.config}
                storage_path = os.path.join(self.folder, 'storage.db')
                self.storage = PluginStorage(storage_path)
                logger_instance = get_logger(f'plugin.{self.manifest.name.replace(" ", "_")}')

                available_dependencies = {
                    'config': config_dict,
                    'logger': logger_instance,
                    'storage': self.storage,
                    'c': config_dict,
                    'l': logger_instance,
                    's': self.storage
                }

                sig = inspect.signature(module.Main)
                kwargs_to_pass = {}
                accepts_kwargs = False
                
                for param_name, param in sig.parameters.items():
                    if param.kind == inspect.Parameter.VAR_KEYWORD:
                        accepts_kwargs = True
                        break
                    
                    if param_name in available_dependencies:
                        kwargs_to_pass[param_name] = available_dependencies[param_name]
                    else:
                        self.log.warning(f"Plugin requested unknown argument: '{param_name}'")

                if accepts_kwargs:
                    kwargs_to_pass = available_dependencies

                self.python_instance = module.Main(**kwargs_to_pass)
            else:
                self.log.verbose("No 'Main' class found. Using raw module export.")
                self.python_instance = module
            
            self.log.success("Python backend initialized successfully.")
        except Exception as e:
            self.log.error(f"Failed to load Python module: {e}", exc_info=True)
        finally:
            if os.path.isdir(vendor_path) and vendor_path in sys.path:
                sys.path.remove(vendor_path)

    def _read_file(self, filename: str) -> str:
        path = os.path.join(self.folder, filename)
        try:
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    return f.read()
            else:
                self.log.error(f"File not found: {path}")
        except Exception as e:
            self.log.error(f"Error reading file {filename}: {e}")
        return ""

    def apply(self):
        self.log.info(f"Injecting {self.manifest.name}...")

        if self.python_instance:
            if hasattr(self.python_instance, 'on_ready') and callable(self.python_instance.on_ready):
                try:
                    self.log.verbose(f"Calling on_ready for {self.manifest.name}")
                    self.python_instance.on_ready()
                except Exception as e:
                    self.log.error(f"Error in {self.manifest.name} on_ready: {e}")

        # 1. Prepare Configuration
        config_data = {prop.name: prop.value for prop in self.manifest.config}
        
        bootstrap_path = os.path.join(get_base_path(), 'bootstrap.js')
        if os.path.exists(bootstrap_path):
            with open(bootstrap_path, 'r', encoding='utf-8') as f:
                bootstrap_js = f.read()
            
            setup_vars_js = f"""
                window._currentPluginInitName = {json.dumps(self.manifest.name)};
                window._currentPluginInitConfig = {json.dumps(config_data)};
            """
            self.window.run_js(setup_vars_js)
            self.window.run_js(bootstrap_js)
        else:
            self.log.error(f"'bootstrap.js' not found at {bootstrap_path}")

        # 3. Inject Files
        for file in self.manifest.files:
            content = self._read_file(file)
            if not content: 
                continue
            
            if file.endswith('.css'):
                safe_css = json.dumps(content)
                self.window.run_js(f"""
                    (function() {{
                        const styleTag = document.createElement('style');
                        styleTag.id = 'plugin-style-{self.manifest.name}';
                        styleTag.innerHTML = {safe_css};
                        document.head.appendChild(styleTag);
                    }})();
                """)
                
            elif file.endswith('.js'):
                safe_js = content
                self.window.run_js(f"""
                    try {{
                        {safe_js}
                    }} catch (e) {{
                        console.error("Error in plugin script {file}:", e);
                    }}
                """)

        self.log.success(f"Injection complete for {self.manifest.name}")

class PluginManager:
    def __init__(self, window: Window):
        self.window = window
        self.plugin_base = os.path.join(get_base_path(), 'plugins')
        
        if not os.path.exists(self.plugin_base):
            os.makedirs(self.plugin_base)
            logger.notice(f"Created missing plugins directory at {self.plugin_base}")
        
        self.plugins: dict[str, Plugin] = {}
        self.log = get_logger("manager")

    def load(self):
        self.plugins = {}
        self.log.info(f"Scanning: {self.plugin_base}")
        
        if not os.path.isdir(self.plugin_base):
            self.log.error("Plugin path is not a directory.")
            return

        all_items = os.listdir(self.plugin_base)
        self.log.verbose(f"Items found in plugins folder: {all_items}")

        for item in all_items:
            item_path = os.path.join(self.plugin_base, item)
            
            if item.startswith(('.', '__')): 
                continue
            if not os.path.isdir(item_path):
                continue

            plugin = Plugin(self.window, item_path)
            if plugin.is_valid:
                self.plugins[plugin.manifest.name] = plugin
            else:
                self.log.verbose(f"Skipping '{item}': No valid manifest found.")
        
        self.log.success(f"Total plugins loaded: {len(self.plugins)}")

    def bind(self):
        for name, plugin in self.plugins.items():
            if plugin.python_instance:
                safe_name = name.replace(" ", "_")
                self.window.bind(safe_name, plugin.python_instance)

    def inject(self):
        if not self.plugins:
            self.log.verbose("No plugins to inject.")
            return

        self.log.info(f"Starting injection for {len(self.plugins)} plugins...")
        for name, plugin in self.plugins.items():
            try:
                plugin.apply()
            except Exception as e:
                self.log.error(f"Failed to inject plugin '{name}': {e}")
        self.log.success("All plugins processed.")