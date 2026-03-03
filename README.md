# YouTube Music Desktop with Plugins

A lightweight desktop client for YouTube Music built with Python and `webview_python`. It features a powerful, flexible plugin system that allows you to inject custom JavaScript, enforce CSS styles, and even run Python backend code to extend the app's functionality

App don`t bundled with web engine: it will use already installed engine 

---

## For Users

### Getting Started
1. Run the application executable (or `main.py` if running from source)
2. The app will open YouTube Music in a standalone desktop window
3. On the first run, a `plugins` folder and a `ytm_data` folder will be created in the same directory as the app

### Installing Plugins
To install a new plugin:
1. Download the plugin folder
2. Drop the entire folder into the `plugins/` directory
3. Restart the application. The plugin will be automatically detected and injected

---

## For Developers

### Prerequisites
To run the project from source, you need Python installed along with a few dependencies.

```bash
pip install -r requirements.txt
```

### Running the App
```bash
python src/main.py
```

### Plugin Development Guide
Plugins are stored in the `plugins/` directory. Each plugin must be in its own folder and contain a `manifest.json` file

#### 1. Folder Structure
```text
plugins/
└── my_custom_plugin/
    ├── manifest.json
    ├── style.css
    ├── script.js
    └── backend.py
```

#### 2. The Manifest (`manifest.json`)
The manifest tells the Plugin Manager what to load.
```json
{
  "name": "My Custom Plugin",
  "files": ["style.css", "script.js"],
  "python_script": "backend.py",
  "config":[
    {
      "name": "auto_play",
      "type": "bool",
      "default": true
    }
  ]
}
```

#### 3. Frontend Injection (JS & CSS)
* **JS Files**: Executed automatically when the YouTube Music DOM is ready
* **CSS Files**: Automatically injected and appended to the document head
* **Config**: Available in the frontend via `window.pluginConfig['My_Custom_Plugin']` or via passed into class dict in the backend

#### 4. Python Backend (Optional)
If your plugin requires backend logic (file system access, OS-level requests), define a `python_script` in the manifest. 

Create a `Main` class in your Python file. Public methods (not starting with `_`) will be automatically bound to the frontend `window` object so your JavaScript can call them!

**backend.py:**
```python
class Main:
    def __init__(self, window, config, logger):
        self.window = window
        self.config = config
        self.log = logger

    def on_ready(self):
        self.log.info("Backend is ready!")

    def python_hello(self):
        return f"Hello from Python! Configured autoplay is: {self.config.get('auto_play')}"
```

**script.js:**
```javascript
window.My_Custom_Plugin_python_hello().then(response => {
    console.log(response);
});
```

### Notes
* The app automatically handles window binding, prefixing your Python methods with your plugin's name (spaces replaced with underscores)
* Any dependencies your Python plugin needs can be placed in a `lib/` folder inside your plugin's directory or using dependencies in manifest (you can use it only if you will compile app through `build.py`)