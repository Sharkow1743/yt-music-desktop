import json
import os
import sys
import importlib.util
from typing import Any, Dict, Optional
import typing
import webview
from pydantic import BaseModel, TypeAdapter, model_validator

from logger import get_logger

logger = get_logger("plugins")

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

# --- Core Logic ---

def get_base_path():
    if hasattr(sys, 'frozen'):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

class Plugin:
    def __init__(self, folder: str, manifest_file: str = 'manifest.json'):
        self.folder = folder
        self.manifest_file = manifest_file
        self.manifest: ManifestModel = ManifestModel()
        self.python_instance = None
        # Create a sub-logger for this specific plugin directory
        self.log = get_logger(f"plugin/{os.path.basename(folder)}")
        self.load()

    def load(self):
        manifest_path = os.path.join(self.folder, self.manifest_file)
        self.log.verbose(f"Looking for manifest at: {manifest_path}")

        if not os.path.exists(manifest_path):
            self.log.warning(f"Manifest not found. Skipping directory.")
            return

        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                content = f.read()
                self.manifest = ManifestModel.model_validate_json(content)
            
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
        script_path = os.path.join(self.folder, self.manifest.python_script)
        self.log.verbose(f"Attempting to load Python backend from: {script_path}")

        if not os.path.exists(script_path):
            self.log.error(f"Python script '{self.manifest.python_script}' missing from folder.")
            return

        try:
            module_name = f"plugin_mod_{self.manifest.name.replace(' ', '_')}"
            spec = importlib.util.spec_from_file_location(module_name, script_path)
            module = importlib.util.module_from_spec(spec)
            
            # This executes the module code
            spec.loader.exec_module(module)

            if hasattr(module, 'PluginAPI'):
                self.log.verbose("Found 'PluginAPI' class. Instantiating with config...")
                config_dict = {p.name: p.value for p in self.manifest.config}
                self.python_instance = module.PluginAPI(config_dict)
            else:
                self.log.verbose("No 'PluginAPI' class found. Using raw module export.")
                self.python_instance = module
            
            self.log.success(f"Python backend initialized successfully.")
        except Exception as e:
            self.log.error(f"Failed to load Python module: {e}", exc_info=True)

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

    def apply(self, window: webview.Window):
        self.log.info(f"Injecting frontend assets...")

        # 1. Inject Configuration
        config_data = {prop.name: prop.value for prop in self.manifest.config}
        config_js = f"""
            window.pluginConfig = window.pluginConfig || {{}};
            window.pluginConfig["{self.manifest.name}"] = {json.dumps(config_data)};
        """
        window.run_js(config_js)
        self.log.verbose(f"Injected config keys: {list(config_data.keys())}")

        # 2. Inject CSS and JS files
        js_count = 0
        css_count = 0

        for file in self.manifest.files:
            content = self._read_file(file)
            if not content:
                continue

            if file.endswith('.css'):
                self.log.verbose(f"Injecting CSS: {file}")
                # Escape backticks for JS template literal
                escaped_content = content.replace('`', '\\`').replace('\\', '\\\\')
                window.run_js(f"var s=document.createElement('style');s.innerHTML=`{escaped_content}`;document.head.appendChild(s);")
                css_count += 1
            elif file.endswith('.js'):
                self.log.verbose(f"Injecting JS: {file}")
                window.run_js(content)
                js_count += 1
            else:
                self.log.warning(f"Unsupported file type for injection: {file}")

        self.log.success(f"Injection complete ({js_count} JS, {css_count} CSS).")

class PluginManager:
    def __init__(self):
        self.plugin_base = os.path.join(get_base_path(), 'plugins')
        if not os.path.exists(self.plugin_base):
            os.makedirs(self.plugin_base)
            logger.notice(f"Created missing plugins directory at {self.plugin_base}")
        
        self.plugins: dict[str, Plugin] = {}
        self.log = get_logger("manager")

    def load_plugins(self):
        self.plugins = {}
        self.log.info(f"Scanning directory: {self.plugin_base}")
        
        try:
            entries = [e for e in os.scandir(self.plugin_base) if e.is_dir()]
            self.log.verbose(f"Found {len(entries)} candidate folders.")
        except Exception as e:
            self.log.error(f"Could not scan plugin directory: {e}")
            return

        count = 0
        for entry in entries:
            # Ignore hidden folders or __pycache__
            if entry.name.startswith(('.', '__')):
                self.log.verbose(f"Skipping internal folder: {entry.name}")
                continue

            try:
                plugin = Plugin(entry.path)
                # Ensure the plugin actually loaded a manifest
                if plugin.manifest.name != 'Unknown Plugin':
                    self.plugins[plugin.manifest.name] = plugin
                    count += 1
                else:
                    self.log.warning(f"Plugin at {entry.name} has no valid manifest name.")
            except Exception as e:
                self.log.error(f"Critical failure loading plugin '{entry.name}': {e}")
        
        self.log.success(f"Total plugins loaded: {count}")

    def get_combined_api(self):
        self.log.verbose("Synthesizing combined API for Webview...")
        class CombinedAPI:
            pass

        api = CombinedAPI()
        attached_count = 0
        
        for name, plugin in self.plugins.items():
            if plugin.python_instance:
                # Replace spaces with underscores for valid JS object property access
                safe_name = name.replace(" ", "_")
                setattr(api, safe_name, plugin.python_instance)
                attached_count += 1
                self.log.verbose(f"Bound backend: {name} -> pywebview.api.{safe_name}")
        
        self.log.info(f"Combined API generated with {attached_count} backends.")
        return api

    def inject_plugins(self, window: webview.Window):
        self.log.info(f"Starting injection for {len(self.plugins)} plugins...")
        for name, plugin in self.plugins.items():
            try:
                plugin.apply(window)
            except Exception as e:
                self.log.error(f"Failed to inject plugin '{name}': {e}")
        self.log.success("All plugins processed.")