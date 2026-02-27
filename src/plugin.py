import json
import os
import sys
import importlib.util
from typing import Any, Dict, Optional
import typing
import webview
from pydantic import BaseModel, TypeAdapter, model_validator
import subprocess

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
    dependencies: list[str] = []

# --- Core Logic ---

def get_base_path():
    """Get the root directory of the application reliably."""
    if hasattr(sys, 'frozen'):
        # If running as a compiled .exe (PyInstaller)
        return os.path.dirname(sys.executable)
    
    # Get the directory where this specific file (e.g., plugin.py) is located
    # current_file_dir = os.path.dirname(os.path.abspath(__file__))
    current_file_dir = os.getcwd()
    
    return current_file_dir

class Plugin:
    def __init__(self, folder: str, manifest_file: str = 'manifest.json'):
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
        Loads the plugin's Python module, temporarily adding its 'lib' 
        directory to the system path to resolve vendored dependencies.
        """
        script_path = os.path.join(self.folder, self.manifest.python_script)
        vendor_path = os.path.join(self.folder, 'lib') # Standardized library folder
        self.log.verbose(f"Attempting to load Python backend from: {script_path}")

        if not os.path.exists(script_path):
            self.log.error(f"Python script '{self.manifest.python_script}' missing from folder.")
            return

        # Temporarily add the vendored library path to sys.path
        if os.path.isdir(vendor_path):
            self.log.verbose(f"Adding vendored library path to sys.path: {vendor_path}")
            sys.path.insert(0, vendor_path)

        try:
            module_name = f"plugin_mod_{self.manifest.name.replace(' ', '_')}"
            spec = importlib.util.spec_from_file_location(module_name, script_path)
            if spec is None:
                raise ImportError(f"Could not create module spec for {script_path}")
                
            module = importlib.util.module_from_spec(spec)
            
            spec.loader.exec_module(module)

            if hasattr(module, 'Main'):
                self.log.verbose("Found 'Main' class. Instantiating with config...")
                config_dict = {p.name: p.value for p in self.manifest.config}
                self.python_instance = module.Main(config_dict, get_logger(f'plugin.{self.manifest.name.replace(" ", "_")}'))
            else:
                self.log.verbose("No 'Main' class found. Using raw module export.")
                self.python_instance = module
            
            self.log.success("Python backend initialized successfully.")
        except Exception as e:
            self.log.error(f"Failed to load Python module: {e}")
        finally:
            # IMPORTANT: Clean up sys.path to avoid conflicts with other plugins
            if os.path.isdir(vendor_path) and vendor_path in sys.path:
                self.log.verbose(f"Removing vendored library path from sys.path: {vendor_path}")
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

    def apply(self, window: webview.Window):
        self.log.info(f"Injecting {self.manifest.name}...")

        if self.python_instance:
            self.python_instance.window = window
            self.log.verbose('Found python inctance. Injected window')
            
            # 2. (Optional) Call a lifecycle method if the plugin defines it
            if hasattr(self.python_instance, 'on_ready'):
                try:
                    self.log.verbose(f"Calling on_ready for {self.manifest.name}")
                    self.python_instance.on_ready()
                except Exception as e:
                    self.log.error(f"Error in {self.manifest.name} on_ready: {e}")

        # 1. Prepare Configuration
        config_data = {prop.name: prop.value for prop in self.manifest.config}
        
        # 2. The "Bootstrap" script: Bypasses TrustedHTML and sets up the CSS enforcer
        bootstrap_js = f"""
        (function() {{
            // --- 1. TrustedHTML Bypass ---
            if (window.trustedTypes && !window.trustedTypes.defaultPolicy) {{
                try {{
                    window.trustedTypes.createPolicy('default', {{
                        createHTML: (s) => s,
                        createScript: (s) => s,
                        createScriptURL: (s) => s
                    }});
                }} catch (e) {{ console.warn("TrustedTypes policy could not be created:", e); }}
            }}

            // --- 2. CSS Enforcement Engine ---
            // This system ensures styles are applied directly to elements and stay there.
            window._pluginStyles = window._pluginStyles || {{}};
            window._pluginStyles['{self.manifest.name}'] = [];

            const applyEnforcedStyles = () => {{
                window._pluginStyles['{self.manifest.name}'].forEach(rule => {{
                    document.querySelectorAll(rule.selector).forEach(el => {{
                        for (let [prop, value] of Object.entries(rule.styles)) {{
                            // Apply with !important and use setProperty to bypass standard attribute blocks
                            if (el.style.getPropertyValue(prop) !== value) {{
                                el.style.setProperty(prop, value, 'important');
                            }}
                        }}
                    }});
                }});
            }};

            // Observe DOM changes to re-apply styles to new elements immediately
            const observer = new MutationObserver(applyEnforcedStyles);
            observer.observe(document.documentElement, {{ childList: true, subtree: true, attributes: true }});
            
            window.enforceStyle = (selector, styleObject) => {{
                window._pluginStyles['{self.manifest.name}'].push({{selector, styles: styleObject}});
                applyEnforcedStyles();
            }};

            // --- 3. Configuration ---
            window.pluginConfig = window.pluginConfig || {{}};
            window.pluginConfig['{self.manifest.name}'] = {json.dumps(config_data)};
        }})();
        """
        
        # Execute bootstrap
        window.run_js(bootstrap_js)

        # 3. Inject Files
        for file in self.manifest.files:
            content = self._read_file(file)
            if not content: 
                continue
            
            if file.endswith('.css'):
                # Convert CSS string to a JS-compatible object for the Enforcer
                # Note: For complex CSS, you might need a small parser here. 
                # This logic assumes a helper or simple direct injection for the "system" you requested.
                safe_css = json.dumps(content)
                window.run_js(f"""
                    (function() {{
                        const styleTag = document.createElement('style');
                        styleTag.id = 'plugin-style-{self.manifest.name}';
                        styleTag.innerHTML = {safe_css};
                        document.head.appendChild(styleTag);
                        // Optional: If you want the 'direct apply' system for specific selectors:
                        // window.enforceStyle('.target-class', {{ 'color': 'red' }});
                    }})();
                """)
                
            elif file.endswith('.js'):
                # Inject JS with no restrictions
                # Wrapping in a try-catch to ensure one failing file doesn't break the loop
                safe_js = content # Content is already raw JS
                window.run_js(f"""
                    try {{
                        {safe_js}
                    }} catch (e) {{
                        console.error("Error in plugin script {file}:", e);
                    }}
                """)

        self.log.success(f"Injection complete for {self.manifest.name}")

class PluginManager:
    def __init__(self):
        # Locate the /plugins folder relative to this script
        self.plugin_base = os.path.join(get_base_path(), 'plugins')
        
        if not os.path.exists(self.plugin_base):
            os.makedirs(self.plugin_base)
            logger.notice(f"Created missing plugins directory at {self.plugin_base}")
        
        self.plugins: dict[str, Plugin] = {}
        self.log = get_logger("manager")

    def load_plugins(self):
        self.plugins = {}
        self.log.info(f"Scanning: {self.plugin_base}")
        
        if not os.path.isdir(self.plugin_base):
            self.log.error("Plugin path is not a directory.")
            return

        all_items = os.listdir(self.plugin_base)
        self.log.verbose(f"Items found in plugins folder: {all_items}")

        for item in all_items:
            item_path = os.path.join(self.plugin_base, item)
            
            # Skip hidden folders or python metadata
            if item.startswith(('.', '__')): 
                continue
            
            # Only process folders
            if not os.path.isdir(item_path):
                continue

            plugin = Plugin(item_path)
            if plugin.is_valid:
                self.plugins[plugin.manifest.name] = plugin
            else:
                self.log.verbose(f"Skipping '{item}': No valid manifest found.")
        
        self.log.success(f"Total plugins loaded: {len(self.plugins)}")

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
        if not self.plugins:
            self.log.verbose("No plugins to inject.")
            return

        self.log.info(f"Starting injection for {len(self.plugins)} plugins...")
        for name, plugin in self.plugins.items():
            try:
                plugin.apply(window)
            except Exception as e:
                self.log.error(f"Failed to inject plugin '{name}': {e}")
        self.log.success("All plugins processed.")