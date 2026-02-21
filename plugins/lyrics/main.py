from typing import Optional
import requests
import urllib.parse
import time
import re
import random
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

class LyricParser:
    @staticmethod
    def parse_time(time_str: str) -> float:
        if not time_str: return 0.0
        try:
            parts = time_str.split(':')
            return int(parts[0]) * 60 + float(parts[1])
        except: return 0.0

    @staticmethod
    def normalize_text(text: str) -> str:
        # Layer 3: JSON3 Sanitization/Normalization
        if not text: return ""
        upper_count = sum(1 for c in text if c.isupper())
        if len(text) > 0 and (upper_count / len(text)) > 0.9:
            return text.capitalize()
        return text

    @staticmethod
    def process_lrc(lrc_content: str) -> list[dict]:
        lines = []
        raw_lines = lrc_content.splitlines()
        line_reg = re.compile(r'^\[(\d+:\d+\.\d+)\](.*)')
        word_reg = re.compile(r'<(\d+:\d+\.\d+)>')

        # 1. Initial Parse
        for line in raw_lines:
            match = line_reg.match(line.strip())
            if not match: continue

            start_time = LyricParser.parse_time(match.group(1))
            content = match.group(2).strip()
            
            singer_type = "main"
            if content.startswith('v2:'): singer_type = "v2"
            elif content.startswith('bg:'): singer_type = "bg"
            
            # If the line is empty or explicitly says instrumental, mark it
            if "instrumental" in content.lower():
                singer_type = "instrumental"
                content = "" # Clear text

            words = []
            # Only process words if not instrumental
            if singer_type != "instrumental" and '<' in content:
                parts = word_reg.split(content)
                current_time = start_time
                for i in range(0, len(parts), 2):
                    text = parts[i]
                    if not text and i == 0: continue
                    next_time = LyricParser.parse_time(parts[i+1]) if i+1 < len(parts) else 0
                    
                    if text.strip() == "" and len(words) > 0 and next_time > 0:
                        words[-1]["endTime"] = next_time
                        words[-1]["duration"] = next_time - words[-1]["startTime"]
                    else:
                        words.append({
                            "text": text,
                            "startTime": current_time,
                            "endTime": next_time if next_time > 0 else current_time + 0.3,
                            "duration": 0.3
                        })
                    if next_time > 0: current_time = next_time
            else:
                # Fallback for line-by-line or instrumental
                words.append({"text": content, "startTime": start_time, "duration": 0})

            lines.append({
                "startTime": start_time,
                "type": singer_type,
                "words": words
            })

        # 2. Fix Line-by-Line Timing & Automatic Gap Detection
        processed = []
        for i in range(len(lines)):
            curr = lines[i]
            next_start = lines[i+1]["startTime"] if i+1 < len(lines) else curr["startTime"] + 5.0
            line_duration = next_start - curr["startTime"]
            
            if curr["type"] != "instrumental" and len(curr["words"]) == 1 and curr["words"][0]["duration"] == 0:
                curr["words"][0]["duration"] = line_duration
                curr["words"][0]["endTime"] = next_start

            processed.append(curr)

            # Auto-insert instrumental if there's a large gap ( > 4 seconds)
            if i < len(lines) - 1:
                gap = lines[i+1]["startTime"] - (curr["startTime"] + (line_duration if curr["type"] != "instrumental" else 0))
                if gap > 4.0:
                    processed.append({
                        "startTime": curr["startTime"] + (line_duration if curr["type"] != "instrumental" else 2.0),
                        "type": "instrumental",
                        "words": [{"text": "", "startTime": 0, "duration": gap}]
                    })

        return sorted(processed, key=lambda x: x['startTime'])

class LyricsProvider:
    def __init__(self, id, name, logger):
        self.id = id
        self.name = name
        self.log = logger

    def _clean_string(self, text):
        """Cleans up strings to remove noise like (Official Video), HD, etc."""
        if not text: return ""
        # Remove (Official Video), [Lyrics], HD, 4K, etc.
        text = re.sub(r'\(.*?\)|\[.*?\]', '', text)
        text = re.sub(r'(?i)official\s+(video|audio|music|lyric|track|visualizer)', '', text)
        text = re.sub(r'(?i)(full\s+)?hd|4k|hq', '', text)
        return text.strip()

    def _get_variations(self, artist, title, album = None, duration = None, id = None):
        """Generates a list of search queries from most specific to most generic."""
        variations = []

        clean_a = self._clean_string(artist)
        clean_t = self._clean_string(title)
        
        # Scenario: "Artist - Title" format in the title string
        if re.search(r'\s[–—-]\s', clean_t):
            parts = re.split(r'\s[–—-]\s', clean_t, 1)
            derived_artist = parts[0].strip()
            derived_title = parts[1].strip()
            variations.append({"a": derived_artist, "t": derived_title, "alb": album})
            variations.append({"a": derived_artist, "t": derived_title, "alb": ""})

        # Standard clean search
        if album:
            variations.append({"a": clean_a, "t": clean_t, "alb": album})

        variations.append({"a": clean_a, "t": clean_t, "alb": ""})

        # Handle "Artist feat. X" by stripping features
        primary_artist = re.split(r'[,&]|\sfeat\.?\s|и', clean_a, flags=re.IGNORECASE)[0].strip()
        if primary_artist != clean_a:
            variations.append({"a": primary_artist, "t": clean_t, "alb": ""})

        # Remove duplicates while preserving order
        seen = set()
        unique_vars = []
        for v in variations:
            key = (v['a'].lower(), v['t'].lower(), v['alb'].lower())
            if key not in seen and v['a'] and v['t']:
                unique_vars.append(v)
                seen.add(key)
        
        return unique_vars

    def request(self, artist, title, album = None, duration = None, id = None) -> Optional[str]:
        """
        Abstract method to be implemented by child classes.
        Must return a string with lrc or None.
        """
        raise NotImplementedError

    def search(self, artist, title, album = None, duration = None, id = None) -> Optional[list[dict]]:
        """
        Main entry point. Generates variations and calls get_lyrics 
        until a match is found.
        """
        queries = self._get_variations(artist, title, album)
        
        for q in queries:
            try:
                self.log.verbose(f"{self.name}: Trying '{q['a']}' - '{q['t']}'")
                
                # Perform the specific provider request
                lrc = self.request(q['a'], q['t'], q['alb'], duration)
                
                if lrc:
                    self.log.success(f"{self.name}: Match found using '{q['a']}' = '{q['t']}")
                    return LyricParser.process_lrc(lrc)
            except Exception as e:
                # Log error but continue to next variation
                self.log.error(f"{self.name}: Error processing '{q['a']}': {str(e)}")
                continue

        return None


class LRCLibProvider(LyricsProvider):
    def __init__(self, logger):
        super().__init__("lrclib", "LRCLib", logger)
        self.session = requests.Session()
        
        # Headers to prevent SSL/Handshake blocks
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
        })

        # Retry logic for network/SSL stability
        retries = Retry(total=3, backoff_factor=0.5, status_forcelist=[502, 503, 504])
        self.session.mount("https://", HTTPAdapter(max_retries=retries))

    def request(self, artist, title, album = None, duration = None, id = None):
        params = {
            "artist_name": artist,
            "track_name": title,
        }
        if album: params["album_name"] = album
        if duration > 0: params["duration"] = int(duration)

        url = f"https://lrclib.net/api/get?{urllib.parse.urlencode(params)}"
        
        # Random tiny sleep to prevent EOF during rapid retries (specific to this API/Session)
        time.sleep(random.uniform(0.1, 0.3)) 
        
        resp = self.session.get(url, timeout=8)
        
        if resp.status_code == 200:
            data = resp.json()
            return data.get("syncedLyrics")
        elif resp.status_code == 404:
            return None
        else:
            self.log.warning(f"LRCLib: Server returned {resp.status_code}")
            return None

class Main:
    def __init__(self, conf, logger):
        self.conf = conf
        self.log = logger
        self.log.info("Lyrics plugin backend loaded.")
        
        # Internal registry for providers
        self.providers = {}

        self.register_provider(LRCLibProvider(logger))

    def register_provider(self, provider_instance):
        if hasattr(provider_instance, 'id') and hasattr(provider_instance, 'search'):
            self.providers[provider_instance.id] = provider_instance
            self.log.success(f"Registered Provider: {provider_instance.id}")
            return True
        return False

    def get_lyrics(self, artist, title, album="", duration=0):
        """Called from JS to start the search chain."""
        self.log.info(f"Incoming Request: {artist} - {title}")
        
        # Respect user priority from config
        priority = self.conf.get("provider_priority", ["lrclib"])
        
        # 1. Try prioritized providers
        for p_id in priority:
            if p_id in self.providers:
                result = self.providers[p_id].search(artist, title, album, duration)
                if result: return {"synced": result}

        # 2. Try remaining providers
        for p_id, provider in self.providers.items():
            if p_id not in priority:
                result = provider.search(artist, title, album, duration)
                if result: return {"synced": result}
        
        self.log.notice(f"No lyrics found for {artist} - {title} across all providers.")
        return {"error": "Not found"}