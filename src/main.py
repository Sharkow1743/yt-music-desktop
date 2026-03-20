import os
from pathlib import Path
import sys
import certifi
from logger import get_logger
import webview
from plugin import PluginManager

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

os.environ['QT_API'] = 'pyqt6'

logger = get_logger('main')

TRUSTED_TYPES_BYPASS = """
(function() {
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        if (!window.trustedTypes.defaultPolicy) {
            window.trustedTypes.createPolicy('default', {
                createHTML: (string) => string,
                createScriptURL: (string) => string,
                createScript: (string) => string,
            });
            console.log("Trusted Types policy created.");
        }
    }
})();
"""


def main():
    data_dir = os.path.join(os.getcwd(), 'ytm_data')
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)

    manager = PluginManager()
    manager.load_plugins()

    # Get the synthesized plugin API classes exposed to frontend
    api = manager.get_combined_api()

    # Standard pywebview creation
    window = webview.create_window(
        title="YouTube Music",
        url="https://music.youtube.com",
        width=1000,
        height=600,
        min_size=(1000, 600),
        js_api=api
    )
    

    # Fired natively when the page successfully navigates and loads
    def on_loaded():
        # 1. Inject security bypass
        window.run_js(TRUSTED_TYPES_BYPASS)

        # 2. Inject purify.js
        purify_path = os.path.join(str(Path(__file__).parent.resolve()), 'purify.js')
        if os.path.exists(purify_path):
            with open(purify_path, 'r', encoding='utf-8') as f:
                try:
                    window.run_js(f.read())
                except Exception as e:
                    logger.error(f"purify.js failed: {e}")
        
        # 3. Inject Plugins
        manager.inject_plugins(window)

        
        manager.inject_plugins(window)

    window.events.loaded += on_loaded

    webview.start(debug=True)

if __name__ == '__main__':
    main()