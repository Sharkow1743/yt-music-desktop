import os
from os import path
from pathlib import Path
from logger import get_logger
from shellac import Window
from plugin import PluginManager, get_base_path

logger = get_logger('main')

TRUSTED_TYPES_BYPASS = """
if (window.trustedTypes && window.trustedTypes.createPolicy && !window.trustedTypes.defaultPolicy) {
    window.trustedTypes.createPolicy('default', {
        createHTML: (s) => s,
        createScriptURL: (s) => s,
        createScript: (s) => s,
    });
}
"""

def main():
    win = Window()
    win.config.width = 1200
    win.config.height = 900
    win.config.hide_controls = True 
    win.config.data_dir = path.abspath(path.join(get_base_path(), 'data'))

    manager = PluginManager(win)
    manager.load()
    manager.bind()

    # Show the initial page
    win.show('https://music.youtube.com/')
    
    # Post-load initialization
    logger.success("Window initialized")
    win.run_js(TRUSTED_TYPES_BYPASS)
    
    # Load Purify.js
    purify_path = os.path.join(str(Path(__file__).parent.resolve()), 'purify.js')
    if os.path.exists(purify_path):
        with open(purify_path, 'r', encoding='utf-8') as f:
            win.run_js(f.read())

    # Inject plugins
    manager.inject()
    
    win.wait()

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass