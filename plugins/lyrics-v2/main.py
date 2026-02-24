import json
import re
import urllib.parse
import requests
from bs4 import BeautifulSoup
import threading
import base64

class LRCParser:
    @staticmethod
    def parse(text):
        if not text: return []
        lines = []
        regex = re.compile(r'\[(\d+):(\d+)[.:](\d+)\](.*)')
        
        for line in text.split('\n'):
            line = line.strip()
            if not line: continue
            
            match = regex.match(line)
            if match:
                minutes, seconds, fraction, content = match.groups()
                ms = int(fraction) * 10 if len(fraction) == 2 else int(fraction)
                total_ms = (int(minutes) * 60 * 1000) + (int(seconds) * 1000) + ms
                
                text_content = content.strip()
                if not text_content: text_content = "♪"
                
                lines.append({"time": total_ms, "text": text_content})
        
        lines.sort(key=lambda x: x["time"])
        for i in range(len(lines) - 1):
            lines[i]["duration"] = lines[i+1]["time"] - lines[i]["time"]
            
        if lines:
            lines[-1]["duration"] = 5000 
        return lines

class MusixMatchProvider:
    def __init__(self, logger):
        self.log = logger
        self.session = requests.Session()
        self.session.headers.update({
            'Authority': 'apic-desktop.musixmatch.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': 'x-mxm-user-id=' 
        })
        self.token = None
        self.app_id = 'web-desktop-app-v1.0'
        self.base_url = 'https://apic-desktop.musixmatch.com/ws/1.1/'

    def _get_token(self):
        try:
            url = f"{self.base_url}token.get?app_id={self.app_id}"
            r = self.session.get(url, timeout=5)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict):
                    msg = data.get('message', {})
                    if isinstance(msg, dict):
                        body = msg.get('body', {})
                        if isinstance(body, dict) and 'user_token' in body:
                            token = body['user_token']
                            if 'Set-Cookie' in r.headers:
                                self.session.headers['Cookie'] = r.headers['Set-Cookie']
                            return token
        except Exception as e:
            self.log.error(f"MXM Token Error: {e}")
        return None

    def search(self, meta):
        if not self.token:
            self.token = self._get_token()
            if not self.token: return None

        params = {
            'app_id': self.app_id,
            'usertoken': self.token,
            'q_track': meta['title'],
            'q_artist': meta['artist'],
            'q_duration': meta['duration'],
            'namespace': 'lyrics_richsynched',
            'subtitle_format': 'lrc',
            'format': 'json'
        }

        try:
            r = self.session.get(f"{self.base_url}macro.subtitles.get", params=params, timeout=5)
            if r.status_code != 200: return None
            data = r.json()
            if not isinstance(data, dict): return None

            # Helper to perform deep dictionary value extractions safely
            def sget(d, *keys):
                for k in keys:
                    if isinstance(d, dict):
                        d = d.get(k, {})
                    else:
                        return {}
                return d

            if sget(data, 'message', 'header', 'status_code') == 401:
                self.log.warning("MXM Token expired, refreshing...")
                self.token = self._get_token()
                if self.token:
                    params['usertoken'] = self.token
                    r = self.session.get(f"{self.base_url}macro.subtitles.get", params=params, timeout=5)
                    data = r.json()
                    if not isinstance(data, dict): return None

            macros = sget(data, 'message', 'body', 'macro_calls')
            if not isinstance(macros, dict):
                macros = {}
            
            # Synced
            subs = sget(macros, 'track.subtitles.get', 'message', 'body', 'subtitle_list')
            if subs and isinstance(subs, list) and len(subs) > 0:
                subtitle = subs[0].get('subtitle', {}) if isinstance(subs[0], dict) else {}
                lrc_body = subtitle.get('subtitle_body')
                if lrc_body:
                    return {"type": "synced", "lyrics": LRCParser.parse(lrc_body), "provider": "MusixMatch"}

            # Plain
            lyrics = sget(macros, 'track.lyrics.get', 'message', 'body', 'lyrics')
            if isinstance(lyrics, dict) and lyrics.get('lyrics_body'):
                return {"type": "plain", "lyrics": lyrics['lyrics_body'], "provider": "MusixMatch"}

        except Exception as e:
            self.log.error(f"MXM Search Error: {e}")
        return None

class LRCLibProvider:
    def search(self, meta):
        url = "https://lrclib.net/api/get"
        params = {'artist_name': meta['artist'], 'track_name': meta['title'], 'album_name': meta['album'], 'duration': meta['duration']}
        try:
            resp = requests.get(url, params=params, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                if data.get('syncedLyrics'):
                    return {"type": "synced", "lyrics": LRCParser.parse(data['syncedLyrics']), "provider": "LRCLib"}
                elif data.get('plainLyrics'):
                    return {"type": "plain", "lyrics": data['plainLyrics'], "provider": "LRCLib"}
        except: pass
        return None

class GeniusProvider:
    def search(self, meta):
        query = f"{meta['title']} {meta['artist']}"
        try:
            r = requests.get(f"https://genius.com/api/search/song?q={urllib.parse.quote(query)}", headers={'User-Agent': 'Mozilla/5.0'}, timeout=5)
            if r.status_code != 200: return None
            hits = r.json().get('response', {}).get('sections', [])[0].get('hits', [])
            if not hits: return None
            
            path = hits[0]['result']['path']
            page = requests.get(f"https://genius.com{path}", headers={'User-Agent': 'Mozilla/5.0'}, timeout=5)
            soup = BeautifulSoup(page.text, 'html.parser')
            
            lyrics = soup.select('div[data-lyrics-container="true"]')
            if lyrics:
                text = "\n".join([div.get_text(separator="\n") for div in lyrics])
                return {"type": "plain", "lyrics": text, "provider": "Genius"}
        except: pass
        return None

class Main:
    def __init__(self, config, logger):
        self.config = config
        self.log = logger
        self.window = None 
        self.cache = {}
        
        self.providers = {
            "LRCLib": LRCLibProvider(),
            "Genius": GeniusProvider(),
            "MusixMatch": MusixMatchProvider(logger),
        }

    def on_ready(self):
        if self.window:
            self.window.run_js("window.dispatchEvent(new CustomEvent('sl-unblock'));")

    # Exposed to JS. We run this in a thread to NOT freeze Pywebview UI.
    def fetch_async(self, title, artist, album, duration, videoId, preferred_provider, callback_id):
        def worker():
            try:
                res = self._fetch_sync(title, artist, album, duration, videoId, preferred_provider)
            except Exception as e:
                self.log.error(f"Async fetch crashed: {e}")
                res = {"error": "Internal Error"}
            
            # Send result back via Base64 JSON to prevent escaping syntax errors in JS injection
            try:
                json_str = json.dumps(res)
                b64_str = base64.b64encode(json_str.encode('utf-8')).decode('utf-8')
                js_code = f"if(window.sl_python_callback) window.sl_python_callback('{callback_id}', JSON.parse(atob('{b64_str}')));"
                self.window.evaluate_js(js_code)
            except Exception as e:
                self.log.error(f"Failed to trigger JS callback: {e}")

        threading.Thread(target=worker, daemon=True).start()

    def _fetch_sync(self, title, artist, album, duration, videoId, preferred_provider):
        if not title or not artist:
            return {"error": "Missing metadata"}

        cache_key = f"{videoId}-{preferred_provider or 'Auto'}"
        if cache_key in self.cache: return self.cache[cache_key]

        meta = {"title": title, "artist": artist, "album": album, "duration": duration, "videoId": videoId}
        self.log.info(f"Fetching: {title} ({preferred_provider or 'Auto'})")
        
        prov_list = []
        if preferred_provider and preferred_provider in self.providers:
            prov_list.append((preferred_provider, self.providers[preferred_provider]))
        for k, v in self.providers.items():
            if k != preferred_provider: prov_list.append((k, v))

        for name, provider in prov_list:
            try:
                res = provider.search(meta)
                if res:
                    self.log.info(f"Found lyrics via {name}")
                    self.cache[cache_key] = res
                    return res
            except Exception as e:
                self.log.error(f"Error in {name}: {e}")

        return {"error": "Lyrics not found"}