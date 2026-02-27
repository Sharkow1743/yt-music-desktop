import json
import re
from typing import Any, Dict, List, Optional
import urllib.parse
import requests
from bs4 import BeautifulSoup
import threading
import base64
from abc import ABC, abstractmethod
import xml.etree.ElementTree as ET
import logging

# Fallback logger if none is provided
logging.basicConfig(level=logging.INFO)
DEFAULT_LOGGER = logging.getLogger("LyricsModule")

LYRIC_TYPE_PLAIN = 0
LYRIC_TYPE_SYNCED = 1
LYRIC_TYPE_WORD_SYNCED = 2

class LyricsParser:
    @staticmethod
    def _time_to_ms(time_str: str) -> int:
        if not time_str: return 0
        time_str = time_str.strip('[]<> ')
        try:
            parts = time_str.split(':')
            if len(parts) == 3:
                seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
            elif len(parts) == 2:
                seconds = int(parts[0]) * 60 + float(parts[1])
            else:
                seconds = float(parts[0])
            return int(seconds * 1000)
        except (ValueError, IndexError):
            return 0

    @staticmethod
    def parse_json_description(text: str, logger=None):
        """Parses JSON format: [{"text": "Line", "time": {"total": 12.34}}]"""
        if logger: logger.debug("Attempting JSON Description parsing...")
        lines = []
        try:
            data = json.loads(text)
            if not isinstance(data, list):
                return [], LYRIC_TYPE_PLAIN
                
            for entry in data:
                if not isinstance(entry, dict): continue
                
                text_content = entry.get('text', '')
                time_obj = entry.get('time')
                
                if not time_obj or 'total' not in time_obj:
                    continue
                
                total_sec = time_obj.get('total', 0)
                ms = int(float(total_sec) * 1000)
                
                lines.append({
                    "time": ms,
                    "text": text_content,
                    "duration": 0, 
                    "parts": None
                })
            
            if logger: logger.debug(f"JSON parsing successful. Found {len(lines)} lines.")
            return lines, LYRIC_TYPE_SYNCED
        except (json.JSONDecodeError, ValueError) as e:
            if logger: logger.warning(f"JSON parsing failed: {e}")
            pass
        return [], LYRIC_TYPE_PLAIN

    @staticmethod
    def parse_ttml(xml_content: str, logger=None):
        """Parses TTML/XML and determines if it is 'line' or 'word' synced."""
        if logger: logger.debug("Attempting TTML/XML parsing...")
        lines = []
        is_word_level = False
        try:
            # Strip namespaces for easier parsing
            xml_content = re.sub(r'\sxmlns="[^"]+"', '', xml_content, count=1)
            root = ET.fromstring(xml_content)
            
            for p in root.iter('p'):
                line_begin = LyricsParser._time_to_ms(p.attrib.get('begin'))
                line_end = LyricsParser._time_to_ms(p.attrib.get('end'))
                
                parts = []
                spans = list(p.findall('span'))
                if spans:
                    is_word_level = True
                    for span in spans:
                        s_begin = LyricsParser._time_to_ms(span.attrib.get('begin', p.attrib.get('begin')))
                        s_end = LyricsParser._time_to_ms(span.attrib.get('end', p.attrib.get('end')))
                        parts.append({
                            "time": s_begin,
                            "duration": max(0, s_end - s_begin),
                            "text": "".join(span.itertext())
                        })
                
                full_text = "".join(p.itertext()).strip()
                if not full_text: continue

                lines.append({
                    "time": line_begin,
                    "duration": max(0, line_end - line_begin),
                    "text": full_text,
                    "parts": parts if parts else None
                })
            
            if logger: logger.debug(f"TTML parsing successful. WordSync={is_word_level}, Lines={len(lines)}")

        except Exception as e:
            if logger: logger.warning(f"TTML parsing failed: {e}")
            pass
        
        return lines, (LYRIC_TYPE_WORD_SYNCED if is_word_level else LYRIC_TYPE_SYNCED)

    @staticmethod
    def parse_lrc(text: str, logger=None):
        """Parses LRC and Enhanced LRC (word-by-word)."""
        if logger: logger.debug("Attempting LRC parsing...")
        lines = []
        is_word_level = False
        line_regex = re.compile(r'\[(\d+:\d+[.:]\d+)\](.*)')
        word_ts_regex = re.compile(r'<(\d+:\d+[.:]\d+)>')
        
        for raw_line in text.split('\n'):
            match = line_regex.match(raw_line.strip())
            if not match: continue
            
            line_time = LyricsParser._time_to_ms(match.group(1))
            content = match.group(2).strip()
            
            word_matches = list(word_ts_regex.finditer(content))
            parts = []
            
            if word_matches:
                is_word_level = True
                texts = word_ts_regex.split(content)
                for i in range(1, len(texts), 2):
                    p_time = LyricsParser._time_to_ms(texts[i])
                    p_text = texts[i+1] if i+1 < len(texts) else ""
                    parts.append({"time": p_time, "text": p_text, "duration": 0})
                
                for i in range(len(parts) - 1):
                    parts[i]["duration"] = parts[i+1]["time"] - parts[i]["time"]
            
            lines.append({
                "time": line_time,
                "text": word_ts_regex.sub('', content).strip(),
                "parts": parts if parts else None,
                "duration": 0
            })
            
        if logger: logger.debug(f"LRC parsing successful. WordSync={is_word_level}, Lines={len(lines)}")
        return lines, (LYRIC_TYPE_WORD_SYNCED if is_word_level else LYRIC_TYPE_SYNCED)

    @classmethod
    def parse(cls, text: str, logger=None):
        if not text: 
            if logger: logger.debug("Parser received empty text.")
            return LYRIC_TYPE_PLAIN, []
        
        text = text.strip()
        lines = []
        sync_type = LYRIC_TYPE_PLAIN

        # 1. Detect JSON Custom Format
        if text.startswith('[{') and '"total"' in text:
             if logger: logger.debug("Format detected: JSON Description")
             lines, sync_type = cls.parse_json_description(text, logger)
        
        # 2. Detect TTML/XML
        elif text.startswith('<') or '<?xml' in text[:50]:
            if logger: logger.debug("Format detected: TTML/XML")
            lines, sync_type = cls.parse_ttml(text, logger)
            
        # 3. Detect LRC
        elif '[' in text[:50]:
            if logger: logger.debug("Format detected: LRC")
            lines, sync_type = cls.parse_lrc(text, logger)
            
        else:
            if logger: logger.debug("Format detected: Plain Text (Fallback)")
            return LYRIC_TYPE_PLAIN, text

        # If parsing failed or returned empty
        if not lines: 
            if logger: logger.warning("Parser matched a format but failed to extract lines. Returning Plain.")
            return LYRIC_TYPE_PLAIN, text

        # 4. Post-Process
        if logger: logger.debug(f"Post-processing {len(lines)} lines (Sorting & Duration calc).")
        lines.sort(key=lambda x: x["time"])
        for i in range(len(lines)):
            if lines[i]["duration"] <= 0:
                if i < len(lines) - 1:
                    lines[i]["duration"] = lines[i+1]["time"] - lines[i]["time"]
                else:
                    lines[i]["duration"] = 5000 
            
            if lines[i]["parts"]:
                last_p = lines[i]["parts"][-1]
                if last_p["duration"] <= 0:
                    line_end = lines[i]["time"] + lines[i]["duration"]
                    last_p["duration"] = max(0, line_end - last_p["time"])

        return sync_type, lines

class BaseLyricsProvider(ABC):
    def __init__(self, logger):
        self.log = logger
        self.session = requests.Session()
        self.session.headers.update({'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'})

    def _clean_string(self, text: str) -> str:
        """Removes noise like (Official Video), [Lyrics], etc., from strings."""
        if not text: return ""
        text = re.sub(r'\s*\(.*?\)|\[.*?\]', '', text)
        text = re.sub(r'(?i)\s*(official|music|lyric|video|audio|hd|hq|4k|visualizer)\s*', '', text)
        return text.strip()

    def _get_variations(self, meta: dict) -> List[Dict[str, Any]]:
        """Generates a list of search metadata variations from most to least specific."""
        variations = []
        clean_title = self._clean_string(meta['title'])
        clean_artist = self._clean_string(meta['artist'])

        # 1. Title contains both artist and title (e.g., "Artist - Title")
        if ' - ' in clean_title or ' – ' in clean_title:
            parts = re.split(r'\s*-\s*|\s*–\s*', clean_title, 1)
            if len(parts) == 2:
                variations.append({'artist': parts[0], 'title': parts[1]})

        # 2. Standard, cleaned metadata
        variations.append({'artist': clean_artist, 'title': clean_title})

        # 3. Primary artist only (remove "feat. Artist" etc.)
        primary_artist = re.split(r' feat\.?| ft\.?| & |, | и ', clean_artist, 1, flags=re.IGNORECASE)[0].strip()
        if primary_artist.lower() != clean_artist.lower():
            variations.append({'artist': primary_artist, 'title': clean_title})
        
        # Remove duplicates while preserving order
        seen = set()
        unique_vars = []
        for v in variations:
            key = (v['artist'].lower(), v['title'].lower())
            if key not in seen:
                unique_vars.append(v)
                seen.add(key)
        return unique_vars

    def search(self, meta: dict) -> Optional[Dict[str, Any]]:
        """
        Main entry point. Generates metadata variations and calls the provider-specific
        fetch logic for each until a result is found.
        """
        queries = self._get_variations(meta)
        
        for q in queries:
            self.log.debug(f"[{self.__class__.__name__}] Trying variation: '{q['title']}' by '{q['artist']}'")
            try:
                result = self._fetch_lyrics(
                    title=q['title'],
                    artist=q['artist'],
                    duration=meta['duration']
                )
                if result:
                    self.log.info(f"[{self.__class__.__name__}] Found a match with variation: '{q['title']}'")
                    # Enrich result with provider name before returning
                    result['provider'] = self.__class__.__name__.replace("Provider", "")
                    return result
            except Exception as e:
                self.log.error(f"[{self.__class__.__name__}] Error during fetch: {e}", exc_info=True)
                continue
        return None

    @abstractmethod
    def _fetch_lyrics(self, title: str, artist: str, duration: int) -> Optional[Dict[str, Any]]:
        """
        Provider-specific implementation for fetching lyrics.
        This method should be overridden by each concrete provider class.
        It must return a dictionary with 'type' and 'lyrics' keys on success.
        """
        pass

# --- Concrete Provider Implementations ---

class MusixMatchProvider(BaseLyricsProvider):
    def __init__(self, logger):
        super().__init__(logger)
        self.session.headers.update({'Authority': 'apic-desktop.musixmatch.com', 'Cookie': 'x-mxm-user-id='})
        self.token = None
        self.app_id = 'web-desktop-app-v1.0'
        self.base_url = 'https://apic-desktop.musixmatch.com/ws/1.1/'

    def _get_token(self):
        # (Token fetching logic remains the same)
        self.log.info("[MXM] Fetching new user token...")
        try:
            url = f"{self.base_url}token.get?app_id={self.app_id}"
            r = self.session.get(url, timeout=7)
            r.raise_for_status()
            token = r.json().get('message', {}).get('body', {}).get('user_token')
            if token:
                self.log.info(f"[MXM] Token acquired: {token[:10]}...")
                return token
            self.log.error("[MXM] Response OK but token missing in body.")
        except Exception as e:
            self.log.error(f"[MXM] Exception fetching token: {e}")
        return None

    def _fetch_lyrics(self, title: str, artist: str, duration: int) -> Optional[Dict[str, Any]]:
        if not self.token:
            self.token = self._get_token()
            if not self.token:
                self.log.warning("[MXM] Aborting search: No token available.")
                return None

        params = {
            'app_id': self.app_id, 'usertoken': self.token, 'q_track': title,
            'q_artist': artist, 'q_duration': duration, 'namespace': 'lyrics_richsynched',
            'subtitle_format': 'DFXP', 'format': 'json' # Request JSON for easier parsing
        }

        r = self.session.get(f"{self.base_url}macro.subtitles.get", params=params, timeout=7)
        if r.status_code != 200:
            self.log.warning(f"[MXM] API returned {r.status_code}")
            return None

        macro_body = r.json().get('message', {}).get('body', {}).get('macro_calls', {})
        
        # Priority 1: Synced Lyrics
        track_subs = macro_body.get('track.subtitles.get', {}).get('message', {}).get('body', {})
        if track_subs and track_subs.get('subtitle_list'):
            body = track_subs['subtitle_list'][0]['subtitle']['subtitle_body']
            sync_type, parsed = LyricsParser.parse(body, self.log)
            return {"type": sync_type, "lyrics": parsed}

        # Priority 2: Plain Lyrics
        track_lyrics = macro_body.get('track.lyrics.get', {}).get('message', {}).get('body', {}).get('lyrics', {})
        if track_lyrics and track_lyrics.get('lyrics_body'):
             return {"type": LYRIC_TYPE_PLAIN, "lyrics": track_lyrics['lyrics_body']}
        
        return None

class LRCLibProvider(BaseLyricsProvider):
    def _fetch_lyrics(self, title: str, artist: str, duration: int) -> Optional[Dict[str, Any]]:
        # Pass 1: Direct hit search
        self.log.debug(f"[LRCLib] Pass 1: Direct search for '{title}'")
        params = {'artist_name': artist, 'track_name': title, 'duration': duration}
        try:
            resp = self.session.get("https://lrclib.net/api/get", params=params, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                if data and (data.get('syncedLyrics') or data.get('plainLyrics')):
                    self.log.info("[LRCLib] Pass 1: Direct hit found.")
                    return self._process_response(data)
        except Exception as e:
            self.log.warning(f"[LRCLib] Pass 1 API error: {e}")

        # Pass 2: Broader search and match (if direct hit fails)
        self.log.debug(f"[LRCLib] Pass 2: Broad search for '{title}'")
        search_params = {'q': f"{title} {artist}"}
        try:
            resp = self.session.get("https://lrclib.net/api/search", params=search_params, timeout=5)
            if resp.status_code == 200:
                results = resp.json()
                # Basic matching: find first result that matches artist name approximately
                for res in results:
                    if artist.lower() in res.get('artistName', '').lower():
                        self.log.info(f"[LRCLib] Pass 2: Found potential match '{res['trackName']}'.")
                        return self._process_response(res)
        except Exception as e:
            self.log.warning(f"[LRCLib] Pass 2 API error: {e}")
        
        return None

    def _process_response(self, data: dict) -> Optional[Dict[str, Any]]:
        """Helper to process a successful API response from LRCLib."""
        if data.get('syncedLyrics'):
            sync_type, parsed = LyricsParser.parse(data['syncedLyrics'], self.log)
            return {"type": sync_type, "lyrics": parsed}
        elif data.get('plainLyrics'):
            return {"type": LYRIC_TYPE_PLAIN, "lyrics": data['plainLyrics']}
        return None


class GeniusProvider(BaseLyricsProvider):
    def _fetch_lyrics(self, title: str, artist: str, duration: int) -> Optional[Dict[str, Any]]:
        query = f"{title} {artist}"
        try:
            r = self.session.get(f"https://genius.com/api/search/song?q={urllib.parse.quote(query)}", timeout=5)
            if r.status_code != 200:
                self.log.warning(f"[Genius] API Error {r.status_code}")
                return None
            
            hits = r.json().get('response', {}).get('sections', [{}])[0].get('hits', [])
            if not hits: return None
            
            # For simplicity, we take the first hit, but a scoring system could be added here.
            path = hits[0]['result']['path']
            self.log.debug(f"[Genius] Scraping page: {path}")
            
            page = self.session.get(f"https://genius.com{path}", timeout=5)
            soup = BeautifulSoup(page.text, 'html.parser')
            
            lyrics_divs = soup.select('div[data-lyrics-container="true"]')
            if lyrics_divs:
                text = "\n".join([div.get_text(separator="\n") for div in lyrics_divs])
                return {"type": LYRIC_TYPE_PLAIN, "lyrics": text}
        except Exception as e:
            self.log.error(f"[Genius] Unexpected error: {e}")
        return None

    
class Main:
    def __init__(self, config, logger):
        self.config = config
        self.log = logger
        self.window = None 
        self.cache = {}
        
        self.providers: dict[str, BaseLyricsProvider] = {
            "LRCLib": LRCLibProvider(logger),
            "Genius": GeniusProvider(logger),
            "MusixMatch": MusixMatchProvider(logger),
        }

    def on_ready(self):
        self.log.info("System Ready. Unblocking JS.")
        if self.window:
            self.window.run_js("window.dispatchEvent(new CustomEvent('sl-unblock'));")

    def fetch_async(self, title, artist, album, duration, videoId, callback_id):
        self.log.info(f"Starting async fetch for ID: {videoId}")
        def worker():
            try:
                res = self._fetch_sync(title, artist, album, duration, videoId)
            except Exception as e:
                self.log.critical(f"Async worker crashed: {e}", exc_info=True)
                res = {"error": "Internal Error"}
            
            try:
                json_str = json.dumps(res)
                b64_str = base64.b64encode(json_str.encode('utf-8')).decode('utf-8')
                js_code = f"if(window.sl_python_callback) window.sl_python_callback('{callback_id}', JSON.parse(atob('{b64_str}')));"
                self.window.evaluate_js(js_code)
                self.log.debug(f"Callback {callback_id} executed successfully.")
            except Exception as e:
                self.log.error(f"Failed to trigger JS callback: {e}")

        threading.Thread(target=worker, daemon=True).start()

    def _fetch_sync(self, title, artist, album, duration, videoId):
        if not title or not artist:
            self.log.warning("Fetch requested with missing metadata.")
            return {"error": "Missing metadata"}

        cache_key = videoId
        if cache_key in self.cache: 
            self.log.info(f"Cache HIT for {videoId} ({self.cache[cache_key]['provider']})")
            return self.cache[cache_key]

        meta = {"title": title, "artist": artist, "album": album, "duration": duration, "videoId": videoId}
        self.log.info(f"Fetching: '{title}' - '{artist}' (Duration: {duration})")

        best_result = None

        for name, provider in self.providers.items():
            self.log.debug(f"Trying provider: {name}...")
            res = provider.search(meta)
            
            if res:
                self.log.info(f"Provider {name} returned type: {res['type']}")
                
                # Priority Logic: Word (2) > Line (1) > Plain (0)
                if best_result is None or res['type'] > best_result['type']:
                    best_result = res
                    if best_result['type'] == LYRIC_TYPE_WORD_SYNCED:
                        self.log.info("Found optimal Word-Synced lyrics. Stopping search.")
                        break 
                else:
                    self.log.debug(f"Keeping existing result (Type {best_result['type']}) over new result (Type {res['type']})")
            else:
                self.log.debug(f"Provider {name} returned nothing.")

        if best_result:
            self.cache[cache_key] = best_result
            self.log.info(f"Final Selection: {best_result['provider']} (Type: {best_result['type']})")
            return best_result
        
        self.log.warning("All providers failed to find lyrics.")
        return {"type": -1, "error": "Lyrics not found"}