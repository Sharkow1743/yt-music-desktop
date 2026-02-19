import json
import os
import sys
import importlib.util
from typing import Any, Dict, Optional
import typing
import webview
from pydantic import BaseModel, TypeAdapter, model_validator

def get_base_path():
    if hasattr(sys, 'frozen'):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

class ConfigPropertyModel(BaseModel):
    name: str
    type: str
    default: Any = None
    value: Any = None

    @model_validator(mode='after')
    def validate_and_sync(self) -> 'ConfigPropertyModel':
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
    python_script: Optional[str] = None  # New field for the python entry point
    config: list[ConfigPropertyModel] = []

class Plugin:
    def __init__(self, folder: str, manifest_file: str = 'manifest.json'):
        self.folder = folder
        self.manifest_file = manifest_file
        self.manifest: ManifestModel = ManifestModel()
        self.python_instance = None # Holds the loaded python module instance
        self.load()

    def load(self):
        manifest_path = os.path.join(self.folder, self.manifest_file)
        if not os.path.exists(manifest_path):
            return

        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = ManifestModel.model_validate_json(f.read())
        
        # Load Python script if defined
        if self.manifest.python_script:
            self._load_python_module()

    def _load_python_module(self):
        """Dynamically imports the python file defined in manifest"""
        script_path = os.path.join(self.folder, self.manifest.python_script)
        if not os.path.exists(script_path):
            print(f"Python script {script_path} not found.")
            return

        try:
            module_name = f"plugin_{self.manifest.name.replace(' ', '_')}"
            spec = importlib.util.spec_from_file_location(module_name, script_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            # Check if the module has a 'PluginInstance' class or 'initialize' function
            # We expect a class named 'PluginAPI' to expose to the frontend
            if hasattr(module, 'PluginAPI'):
                # Pass config to the class constructor if needed
                config_dict = {p.name: p.value for p in self.manifest.config}
                self.python_instance = module.PluginAPI(config_dict)
            else:
                self.python_instance = module
        except Exception as e:
            print(f"Failed to load Python module for {self.manifest.name}: {e}")

    def _read_file(self, filename: str) -> str:
        path = os.path.join(self.folder, filename)
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        return ""

    def apply(self, window: webview.Window):
        """Injects settings, CSS, and JS into the webview window"""
        print(f"Applying plugin: {self.manifest.name}")

        config_data = {prop.name: prop.value for prop in self.manifest.config}
        config_js = f"""
            window.pluginConfig = window.pluginConfig || {{}};
            window.pluginConfig["{self.manifest.name}"] = {json.dumps(config_data)};
        """
        window.run_js(config_js)

        # Inject CSS and JS
        for file in self.manifest.files:
            content = self._read_file(file)
            if not content: continue

            if file.endswith('.css'):
                window.run_js(f"var s=document.createElement('style');s.innerHTML=`{content.replace('`','\\`')}`;document.head.appendChild(s);")
            elif file.endswith('.js'):
                window.run_js(content)

class PluginManager:
    def __init__(self):
        self.plugin_base = os.path.join(get_base_path(), 'plugins')
        if not os.path.exists(self.plugin_base):
            os.makedirs(self.plugin_base)
        self.plugins: dict[str, Plugin] = {}

    def load_plugins(self):
        self.plugins = {}
        for entry in os.scandir(self.plugin_base):
            if entry.is_dir():
                try:
                    plugin = Plugin(entry.path)
                    self.plugins[plugin.manifest.name] = plugin
                except Exception as e:
                    print(f"Failed to load plugin at {entry.path}: {e}")

    def get_combined_api(self):
        """
        Returns a single object containing all plugin Python APIs.
        This object should be passed to webview.create_window(js_api=...)
        """
        class CombinedAPI:
            pass

        api = CombinedAPI()
        for name, plugin in self.plugins.items():
            if plugin.python_instance:
                # We nest each plugin's API under its own name
                # Accessible in JS via: pywebview.api.PluginName.function()
                safe_name = name.replace(" ", "_")
                setattr(api, safe_name, plugin.python_instance)
        return api

    def inject_plugins(self, window: webview.Window):
        for plugin in self.plugins.values():
            plugin.apply(window)