import os
import certifi
from logger import get_logger

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

import webview
from plugin import PluginManager

logger = get_logger('main')

def main():
    data_dir = os.path.join(os.getcwd(), 'ytm_data')
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)

    os.environ['WEBKIT_DISABLE_COMPOSITING_MODE'] = '1'
    os.environ['WEBKIT_FORCE_SANDBOX'] = '0'

    w = webview.webview.Webview(debug=True, size=webview.Size(1000, 600, webview.SizeHint.NONE))
    w.size = webview.Size(1000, 600, webview.SizeHint.MIN)
    w.title = "YouTube Music"
    w.navigate("https://music.youtube.com")

    manager = PluginManager(w)

    manager.load_plugins()

    def on_dom_ready():
        logger.info("DOM Ready signal received. Injecting plugins...")
        manager.inject_plugins()

    w.bind("python_init_ready", on_dom_ready)

    w.eval("""
        (function() {
            const check = () => {
                if (document.body) { window.python_init_ready(); }
                else { setTimeout(check, 100); }
            };
            check();
        })();
    """)

    w.run()

if __name__ == '__main__':
    main()