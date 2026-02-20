from typing import Optional
import requests
import urllib.parse
import time
import re
import random
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

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

    def _get_variations(self, artist, title, album):
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

    def get_lyrics(self, artist, title, album, duration) -> Optional[tuple[str, str]]:
        """
        Abstract method to be implemented by child classes.
        Must return a tuple (synced, plain) or None.
        """
        raise NotImplementedError

    def search(self, artist, title, album, duration):
        """
        Main entry point. Generates variations and calls get_lyrics 
        until a match is found.
        """
        queries = self._get_variations(artist, title, album)
        
        for q in queries:
            try:
                self.log.verbose(f"{self.name}: Trying '{q['a']}' - '{q['t']}'")
                
                # Perform the specific provider request
                synced, plain = self.get_lyrics(q['a'], q['t'], q['alb'], duration)
                
                if synced or plain:
                    self.log.success(f"{self.name}: Match found using '{q['a']}'")
                    return {
                        "provider": self.name,
                        "synced": synced,
                        "plain": plain
                    }
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

    def get_lyrics(self, artist, title, album, duration):
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
            if data.get("syncedLyrics") or data.get("plainLyrics"):
                return (
                    data.get("syncedLyrics"),
                    data.get("plainLyrics")
                )
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
                if result: return result

        # 2. Try remaining providers
        for p_id, provider in self.providers.items():
            if p_id not in priority:
                result = provider.search(artist, title, album, duration)
                if result: return result
        
        self.log.notice(f"No lyrics found for {artist} - {title} across all providers.")
        return {"error": "Not found"}