import webview
import os
from plugin import PluginManager

def main():
    manager = PluginManager()
    
    data_dir = os.path.join(os.getcwd(), 'ytm_data')
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)

    window = webview.create_window(
        'YouTube Music', 
        'https://music.youtube.com',
        width=1200, height=800,
        min_size=(800, 600),
        js_api=manager.get_combined_api()
    )

    window.events.before_load += manager.inject_plugins

    webview.start(
        private_mode=False, 
        storage_path=data_dir,
        debug=False
    )

if __name__ == '__main__':
    main()