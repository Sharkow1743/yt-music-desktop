(function () {
    const PLUGIN_NAME = 'Synced_Lyrics';
    const G_CONFIG = window.pluginConfig ? (window.pluginConfig[PLUGIN_NAME] || {}) : {};

    /**
     * @class SyncedLyricsPlugin
     * Manages the entire lifecycle of the synced lyrics feature.
     */
    class SyncedLyricsPlugin {
        /**
         * @param {object} config The plugin configuration.
         */
        constructor(config) {
            this.config = {
                enabled: true,
                default_provider: 'MusixMatch',
                offset: 0,
                line_effect: 'default',
                show_time_codes: false,
                debug: true, // Toggle for verbose logging
                ...config
            };

            this.state = {
                videoId: null,
                lyrics: null,
                provider: this.config.default_provider,
                activeIdx: -1,
                isFetching: false
            };

            this.dom = {
                parent: null,
                container: null,
                content: null,
                video: null,
                ytmusicApp: null
            };

            this.fetchSequence = 0; 
            
            this._syncLoop = this._syncLoop.bind(this);
            this._handleTrackChange = this._handleTrackChange.bind(this);
            
            this._log("Plugin instance created.");
        }

        /**
         * Internal logging helper
         */
        _log(msg, data = '', level = 'log') {
            const prefix = `[Synced Lyrics]`;
            if (level === 'error') {
                console.error(prefix, msg, data);
            } else if (level === 'warn') {
                console.warn(prefix, msg, data);
            } else if (this.config.debug) {
                console.log(prefix, msg, data);
            }
        }

        /**
         * Initializes the plugin, sets up observers and starts the loops.
         */
        init() {
            if (!this.config.enabled) {
                this._log("Plugin is disabled in config.");
                return;
            }

            this._log("Initializing...");

            this._setupObservers();
            requestAnimationFrame(this._syncLoop);
            
            window.addEventListener('sl-unblock', () => {
                this._log("Received sl-unblock event");
                this._unblockLyricsTab();
            });
            
            this._unlockTabs();
        }

        /**
         * Sets up MutationObservers to react to DOM and URL changes.
         */
        _setupObservers() {
            this._log("Setting up MutationObservers...");
            const observer = new MutationObserver(() => {
                // 1. Detect Video ID change
                const currentVideoId = new URLSearchParams(window.location.search).get('v');
                if (currentVideoId && currentVideoId !== this.state.videoId) {
                    this._log(`URL Change detected. New ID: ${currentVideoId}`);
                    this._handleTrackChange(currentVideoId);
                }
                
                // 2. Check if container needs re-render
                this.dom.parent = document.querySelector('ytmusic-tab-renderer');
                if (this.dom.parent && !document.getElementById('sl-container')) {
                     if (this.state.lyrics || this.state.isFetching) {
                        this._log("Lyrics container missing from DOM, re-rendering...");
                        this.render();
                    }
                }

                this._unlockTabs();
            });

            observer.observe(document.body, { childList: true, subtree: true });
        }
        
        /**
         * Handles the logic for a new song.
         */
        _handleTrackChange(videoId) {
            const oldTitle = navigator.mediaSession?.metadata?.title;
            this._log(`Handling track change: ${oldTitle || 'Unknown'} -> (waiting for metadata)`);
            
            this.state.videoId = videoId;
            this.state.activeIdx = -1;
            this.state.lyrics = null;
            this.render(); 

            let attempts = 0;
            const checkMetadata = setInterval(() => {
                const currentTitle = navigator.mediaSession?.metadata?.title;
                const currentArtist = navigator.mediaSession?.metadata?.artist;
                attempts++;

                if ((currentTitle && currentTitle !== oldTitle) || attempts > 15) {
                    clearInterval(checkMetadata);
                    this._log(`Metadata stabilized after ${attempts} attempts: "${currentTitle}" by ${currentArtist}`);
                    this.fetchData();
                }
            }, 200);
        }

        /**
         * Main data fetching orchestration.
         */
async fetchData() {
            if (!this.state.videoId) return;

            const title = navigator.mediaSession?.metadata?.title;
            const artist = navigator.mediaSession?.metadata?.artist;
            const album = navigator.mediaSession?.metadata?.album || "";

            if (!title || !artist) {
                this._log("Missing Metadata.", {title, artist}, 'warn');
                return;
            }

            // --- CRITICAL FIX 1: Reset state for new song ---
            this.state.lyrics = null;     // Clear old lyrics
            this.state.isFetching = true; // Mark as loading
            this.render();                // Show loading spinner/message

            try {
                // Start the background process
                await window.Synced_Lyrics_start_fetch_lyrics(
                    title, artist, album, 
                    this.dom.video?.duration || 0, 
                    this.state.videoId
                );

                // Start polling (isFetching remains true during polling)
                this._pollLyricsResult(this.state.videoId, title);

            } catch (e) {
                this._log("Fetch invocation error:", e, 'error');
                this.state.isFetching = false;
                this.render();
            }
            // Note: No 'finally' block here, because the process isn't done yet!
        }

        async _pollLyricsResult(videoId, title) {
            const pollInterval = 500;

            const check = async () => {
                // If song changed during polling, stop this poll
                if (this.state.videoId !== videoId) return;

                try {
                    const result = await window.Synced_Lyrics_check_lyrics_result(videoId);

                    if (result && result.status === "pending") {
                        setTimeout(check, pollInterval);
                        return;
                    }

                    // --- CRITICAL FIX 2: Data has arrived ---
                    if (result && !result.error) {
                        this.state.lyrics = result;
                    } else {
                        this._log(`No lyrics for ${title}`, result?.error, 'warn');
                        this.state.lyrics = null;
                    }
                } catch (e) {
                    this._log("Polling error:", e, 'error');
                } finally {
                    // --- CRITICAL FIX 3: Only stop loading state NOW ---
                    this.state.isFetching = false;
                    this.render(); 
                }
            };

            setTimeout(check, pollInterval);
        }

        // New Polling logic
        async _pollLyricsResult(videoId, title) {
            const pollInterval = 500; // Check every 500ms

            const check = async () => {
                // Important: If the user changed the track while we were waiting, abort cleanly!
                if (this.state.videoId !== videoId) return;

                try {
                    // Call the fast, non-blocking check function
                    const result = await window.Synced_Lyrics_check_lyrics_result(videoId);

                    if (result?.status === "pending") {
                        // Not ready yet, check again in 500ms
                        setTimeout(check, pollInterval);
                        return;
                    }

                    // We got the final result!
                    if (result && !result.error) {
                        const typeStr = result.type === 0 ? 'Plain' : (result.type === 2 ? 'Rich/Word' : 'Line-synced');
                        this._log(`Successfully fetched ${typeStr} lyrics from ${result.provider || 'Backend'}`);
                        this.state.lyrics = result;
                    } else {
                        this._log(`Backend returned no lyrics or error for ${title}`, result?.error, 'warn');
                        this.state.lyrics = null;
                    }
                } catch (e) {
                    this._log("Critical error during fetch polling:", e, 'error');
                    this.state.lyrics = null;
                } finally {
                    this.state.isFetching = false;
                    this.render();
                }
            };

            // Start the loop
            setTimeout(check, pollInterval);
        }
        
        /**
         * Internal YTMusic scraper fallback (Alternative source)
         */
        async _fetchYTMusicLyrics() {
            this._log("Attempting internal YTMusic API fetch fallback...");
            try {
                this.dom.ytmusicApp = this.dom.ytmusicApp || document.querySelector('ytmusic-app');
                const networkManager = this.dom.ytmusicApp?.networkManager;
                if (!networkManager) return null;

                const nextData = await networkManager.fetch('/next?prettyPrint=false', { videoId: this.state.videoId });
                const tabs = nextData?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
                if (!tabs) return null;

                const lyricsTab = tabs.find(t => t.tabRenderer?.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS');
                if (!lyricsTab) return null;

                const browseId = lyricsTab.tabRenderer.endpoint.browseEndpoint.browseId;
                const browseData = await networkManager.fetch('/browse?prettyPrint=false', { browseId });

                const timedLyrics = browseData?.contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel?.lyricsData?.timedLyricsData;
                if (timedLyrics) {
                    this._log("Found synced lyrics in YTMusic response");
                    const lines = timedLyrics.map(line => ({
                        time: Number.parseInt(line.cueRange.startTimeMilliseconds),
                        text: line.lyricLine
                    })).sort((a, b) => a.time - b.time);
                    return { type: 1, lyrics: lines, provider: 'YTMusic' };
                }

                const section = browseData?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
                const text = section?.description?.runs?.map(r => r.text).join('');
                if (text) {
                    this._log("Found plain lyrics in YTMusic response");
                    return { type: 0, lyrics: text, provider: 'YTMusic' };
                }

            } catch (e) {
                this._log("YTMusic internal fetch failed", e, 'warn');
            }
            return null;
        }

        /**
         * Main render function.
         */
        render() {
            this.dom.parent = this.dom.parent || document.querySelector('ytmusic-tab-renderer');
            if (!this.dom.parent) {
                this._log("Render failed: parent 'ytmusic-tab-renderer' not found", '', 'warn');
                return;
            }

            if (this.dom.parent.getAttribute('page-type') !== 'MUSIC_PAGE_TYPE_TRACK_LYRICS') { return }

            this._renderContainer();
            this._renderContent();
        }
        
        _renderContainer() {
            if (document.getElementById('sl-container')) return;

            this._log("Creating container DOM elements");
            this.dom.container = document.createElement('div');
            this.dom.container.id = 'sl-container';
            this.dom.container.className = `sl-theme-${this.config.line_effect}`;

            this.dom.content = document.createElement('div');
            this.dom.content.id = 'sl-content';

            this.dom.container.appendChild(this.dom.content);
            this.dom.parent.appendChild(this.dom.container);
        }

        _renderContent() {
            this.dom.content = this.dom.content || document.getElementById('sl-content');
            if (!this.dom.content) return;

            if (this.state.isFetching) {
                this.dom.content.innerHTML = '<div class="sl-msg">Fetching Lyrics...</div>';
            } else if (this.state.lyrics) {
                this._renderLyrics();
            } else {
                this.dom.content.innerHTML = '<div class="sl-msg">Lyrics not found :(</div>';
            }
        }
        
        _renderLyrics() {
            const currentHash = this.state.videoId + (this.state.lyrics.provider || 'unknown');
            if (this.dom.content.dataset.hash === currentHash) return;

            this._log(`Rendering lyrics list. Type: ${this.state.lyrics.type}`);
            this.dom.content.innerHTML = '';
            this.dom.content.dataset.hash = currentHash;
            this.state.activeIdx = -1;
            
            if (this.state.lyrics.type === 0) {
                const txt = document.createElement('div');
                txt.className = 'sl-plain-text';
                txt.innerText = this.state.lyrics.lyrics;
                this.dom.content.appendChild(txt);
                return;
            } 
            
            this.state.lyrics.lyrics.forEach((line, idx) => {
                const row = document.createElement('div');
                row.className = 'sl-line';
                row.dataset.idx = idx;
                
                if (this.config.show_time_codes) {
                    row.innerHTML += `<span class="sl-ts">[${(line.time / 1000).toFixed(2)}]</span>`;
                }

                const hasParts = line.parts && line.parts.length > 0;
                
                if (hasParts) {
                    const lineContent = document.createElement('span');
                    lineContent.className = 'sl-line-content';
                    
                    line.parts.forEach(part => {
                        const wordSpan = document.createElement('span');
                        wordSpan.className = 'sl-word';
                        wordSpan.innerText = part.text + (part.text.endsWith(' ') ? '' : ' ');
                        wordSpan.dataset.start = part.time;
                        wordSpan.dataset.duration = part.duration;
                        lineContent.appendChild(wordSpan);
                    });
                    row.appendChild(lineContent);
                } else {
                    const textSpan = document.createElement('span');
                    textSpan.className = 'sl-line-text';
                    textSpan.innerText = line.text;
                    row.appendChild(textSpan);
                }

                row.onclick = () => {
                    this._log(`User seeking to: ${line.time}ms`);
                    this.dom.video = this.dom.video || document.querySelector('video');
                    if (this.dom.video) this.dom.video.currentTime = (line.time / 1000);
                };
                this.dom.content.appendChild(row);
            });
        }


        /**
         * The main loop for synchronizing lyrics with video playback.
         */
         _syncLoop() {
            if (this.state.lyrics?.type === 0 || !this.state.lyrics || this.state.isFetching) {
                requestAnimationFrame(this._syncLoop);
                return;
            }
            
            this.dom.video = this.dom.video || document.querySelector('video');
            if (!this.dom.video || this.dom.video.paused) {
                requestAnimationFrame(this._syncLoop);
                return;
            }

            const currentTimeMs = (this.dom.video.currentTime * 1000) + this.config.offset;
            const lines = this.state.lyrics.lyrics;

            // 1. Find active Line
            let newActiveIdx = lines.findIndex(line => line.time > currentTimeMs);
            if (newActiveIdx === -1) newActiveIdx = lines.length - 1;
            else newActiveIdx -= 1;
            
            if (newActiveIdx !== this.state.activeIdx) {
                this._log(`Sync: Line change [${this.state.activeIdx} -> ${newActiveIdx}]`);
                this.state.activeIdx = newActiveIdx;
                const rows = this.dom.content.querySelectorAll('.sl-line');
                
                rows.forEach((row, idx) => {
                    const isActive = idx === this.state.activeIdx;
                    row.classList.toggle('active', isActive);
                    if (isActive) {
                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                });
            }

            // 2. Handle Word Highlighting (Type 2 / Karaoke)
            if (this.state.lyrics.type === 2 && this.state.activeIdx !== -1) {
                const activeRow = this.dom.content.children[this.state.activeIdx];
                if (activeRow) {
                    const words = activeRow.querySelectorAll('.sl-word');
                    words.forEach(word => {
                        const start = parseInt(word.dataset.start);
                        const duration = parseInt(word.dataset.duration);
                        const end = start + duration;

                        if (currentTimeMs >= end) {
                            word.classList.add('passed');
                            word.style.backgroundPosition = '0 0';
                        } else if (currentTimeMs >= start) {
                            const progress = ((currentTimeMs - start) / duration) * 100;
                            const bgPos = 100 - progress; 
                            word.style.backgroundPosition = `${bgPos}% 0`;
                            word.classList.remove('passed');
                        } else {
                            word.classList.remove('passed');
                            word.style.backgroundPosition = '100% 0';
                        }
                    });
                }
            }
            
            requestAnimationFrame(this._syncLoop);
        }

        // --- DOM Helpers ---
        _unlockTabs() {
            const tabs = document.querySelectorAll('#tabsContent tp-yt-paper-tab'); 
            if (!tabs || tabs.length === 0) return;
            
            tabs.forEach((tab) => {
                if (tab.hasAttribute('disabled')) {
                    this._log("Unlocking disabled UI tabs");
                    tab.removeAttribute('disabled');
                    tab.setAttribute('aria-disabled', 'false');
                    tab.disabled = false;
                    tab.style.pointerEvents = 'auto';
                    tab.style.cursor = 'pointer';
                    tab.style.opacity = '1';
                }
            });
        };
    }

    /**
     * Plugin Entry Point
     */
    function main() {
        console.log("[Synced Lyrics] Script loaded. Checking for dependencies...");
        const plugin = new SyncedLyricsPlugin(G_CONFIG);
        plugin.init();
    }
    
    // Slight delay to ensure host environment (pywebview) is injected
    setTimeout(main, 500);

})();