import webview
import os

from logger import get_logger
from plugin import PluginManager

logger = get_logger('main')

def main():
    manager = PluginManager()
    
    data_dir = os.path.join(os.getcwd(), 'ytm_data')
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)

    # 1. Load plugins before starting the window
    manager.load_plugins()

    window = webview.create_window(
        'YouTube Music', 
        'https://music.youtube.com',
        width=1200, height=800,
        min_size=(800, 600),
        js_api=manager.get_combined_api()
    )

    def on_page_finished():
        manager.inject_plugins(window)

    window.events.loaded += on_page_finished

    webview.start(
        private_mode=False, 
        storage_path=data_dir,
        debug=True
    )

if __name__ == '__main__':
    main()