(function () {
    const PLUGIN_NAME = 'SyncedLyrics';
    const G_CONFIG = window.pluginConfig[PLUGIN_NAME] || {};

    /**
     * -----------------------------------------------------------------------------
     * Global Callback Receiver
     * Handles asynchronous calls from the Python backend.
     * -----------------------------------------------------------------------------
     */
    window.sl_callbacks = window.sl_callbacks || {};
    window.sl_python_callback = function (cb_id, data) {
        if (window.sl_callbacks[cb_id]) {
            window.sl_callbacks[cb_id](data);
            delete window.sl_callbacks[cb_id];
        }
    };

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

            this.fetchSequence = 0; // Prevents race conditions
            
            // Bind methods to ensure 'this' context is correct
            this._syncLoop = this._syncLoop.bind(this);
            this._handleTrackChange = this._handleTrackChange.bind(this);
        }

        /**
         * Initializes the plugin, sets up observers and starts the loops.
         */
        init() {
            if (!this.config.enabled) return;

            console.log("Synced Lyrics Initializing...");

            this._setupObservers();
            requestAnimationFrame(this._syncLoop);
            
            // Allow the lyrics tab to be clicked
            window.addEventListener('sl-unblock', this._unblockLyricsTab);
            this._unlockTabs();
        }

        /**
         * Sets up MutationObservers to react to DOM and URL changes.
         * This is more efficient than a setInterval poll.
         */
        _setupObservers() {
            const observer = new MutationObserver(() => {
                // 1. Detect Video ID change for new track
                const currentVideoId = new URLSearchParams(window.location.search).get('v');
                if (currentVideoId && currentVideoId !== this.state.videoId) {
                    this._handleTrackChange(currentVideoId);
                }
                
                // 2. Check if our container needs to be re-rendered
                this.dom.parent = document.querySelector('ytmusic-tab-renderer');
                if (this.dom.parent && !document.getElementById('sl-container')) {
                     if (this.state.lyrics || this.state.isFetching) {
                        this.render();
                    }
                }

                this._unlockTabs()
            });

            observer.observe(document.body, { childList: true, subtree: true });
        }
        
        /**
         * Handles the logic for a new song.
         * @param {string} videoId The new YouTube video ID.
         */
        _handleTrackChange(videoId) {
            const oldTitle = navigator.mediaSession?.metadata?.title;
            this.state.videoId = videoId;
            this.state.activeIdx = -1;
            this.state.lyrics = null;
            this.render(); // Show loader/clear old lyrics immediately

            // Polling function to wait for metadata to flip
            let attempts = 0;
            const checkMetadata = setInterval(() => {
                const currentTitle = navigator.mediaSession?.metadata?.title;
                attempts++;

                // If title changed OR we've waited too long (3s)
                if ((currentTitle && currentTitle !== oldTitle) || attempts > 15) {
                    clearInterval(checkMetadata);
                    this.fetchData();
                }
            }, 200); // Check every 200ms
        }

        /**
         * Main data fetching orchestration.
         */
        async fetchData() {
            if (!this.state.videoId) return;

            const title = navigator.mediaSession?.metadata?.title;
            const artist = navigator.mediaSession?.metadata?.artist;
            if (!title || !artist) return; // Metadata not ready

            const currentSeq = ++this.fetchSequence;
            this.state.isFetching = true;
            
            this.render(); // Show loader

            try {
                let result = null;
                result = await this._fetchFromBackend(title, artist);

                // Fallback to Python backend if YTMusic fails or another provider is chosen
                if (!result) {
                    result = await this._fetchYTMusicLyrics(title, artist);
                }

                // Discard result if a newer fetch request has started
                if (this.fetchSequence !== currentSeq) return;
                
                this.state.lyrics = result && result.error ? null : result;

            } catch (e) {
                console.error("Synced Lyrics: Fetch failed.", e);
                this.state.lyrics = null;
            } finally {
                if (this.fetchSequence === currentSeq) {
                    this.state.isFetching = false;
                    this.render();
                }
            }
        }

        /**
         * Fetches lyrics from the Python backend via pywebview.
         * @param {string} title
         * @param {string} artist
         * @returns {Promise<object|null>}
         */
        _fetchFromBackend(title, artist) {
            if (!window.pywebview?.api?.Synced_Lyrics) {
                 console.warn("Synced Lyrics: Python backend not available.");
                 return Promise.resolve(null);
            }
           
            const album = navigator.mediaSession?.metadata?.album || "";
            const duration = this.dom.video?.duration || 0;

            return new Promise(resolve => {
                const cb_id = Math.random().toString(36).substring(2);
                window.sl_callbacks[cb_id] = resolve;
                window.pywebview.api.Synced_Lyrics.fetch_async(
                    title, artist, album, duration, this.state.videoId, cb_id
                );
            });
        }
        
        /**
         * Fetches lyrics using the internal YTMusic frontend API.
         * @returns {Promise<object|null>}
         */
        async _fetchYTMusicLyrics() {
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

                // Process Synced Lyrics
                const timedLyrics = browseData?.contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel?.lyricsData?.timedLyricsData;
                if (timedLyrics) {
                    const lines = timedLyrics.map(line => ({
                        time: Number.parseInt(line.cueRange.startTimeMilliseconds),
                        text: !Number.isNaN(line.lyricLine)
                    })).sort((a, b) => a.time - b.time);
                    return { type: 'synced', lyrics: lines, provider: 'YTMusic' };
                }

                // Process Plain Lyrics
                const section = browseData?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
                const text = section?.description?.runs?.map(r => r.text).join('');
                if (text) return { type: 'plain', lyrics: text, provider: 'YTMusic' };

            } catch (e) {
                console.warn("Synced Lyrics: YTMusic fetch failed:", e);
            }
            return null;
        }

        /**
         * Main render function. Hides original content and renders the lyrics container.
         */
        render() {
            this.dom.parent = this.dom.parent || document.querySelector('ytmusic-tab-renderer');
            if (!this.dom.parent) return;

            this._renderContainer();
            this._updateHeader();
            this._renderContent();
        }
        
        /**
         * Creates the main plugin container and header if they don't exist.
         */
        _renderContainer() {
            if (document.getElementById('sl-container')) return;

            this.dom.container = document.createElement('div');
            this.dom.container.id = 'sl-container';
            this.dom.container.className = `sl-theme-${this.config.line_effect}`;

            this.dom.content = document.createElement('div');
            this.dom.content.id = 'sl-content';

            this.dom.container.appendChild(this.dom.content);
            this.dom.parent.appendChild(this.dom.container);
        }

        /**
         * Updates the active class on provider buttons.
         */
        _updateHeader() {
            if (!this.dom.header) return;
            Array.from(this.dom.header.children).forEach(btn => {
                btn.classList.toggle('active', btn.dataset.p === this.state.provider);
            });
        }
        
        /**
         * Renders the content area based on the current state (loading, not found, or lyrics).
         */
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
        
        /**
         * Renders the actual lyrics, either plain or synced.
         */
        _renderLyrics() {
            const currentHash = this.state.videoId + this.state.lyrics.provider;
            if (this.dom.content.dataset.hash === currentHash) return;

            this.dom.content.innerHTML = '';
            this.dom.content.dataset.hash = currentHash;
            this.state.activeIdx = -1;
            
            // Type 0: Plain
            if (this.state.lyrics.type === 0) {
                const txt = document.createElement('div');
                txt.className = 'sl-plain-text';
                txt.innerText = this.state.lyrics.lyrics;
                this.dom.content.appendChild(txt);
                return;
            } 
            
            // Type 1 (Line) & Type 2 (Word)
            // Both use the same structure, Type 2 has 'parts'
            this.state.lyrics.lyrics.forEach((line, idx) => {
                const row = document.createElement('div');
                row.className = 'sl-line';
                row.dataset.idx = idx;
                
                // Optional timestamp display
                if (this.config.show_time_codes) {
                    row.innerHTML += `<span class="sl-ts">[${(line.time / 1000).toFixed(2)}]</span>`;
                }

                // If parts exist (Type 2), render words. Otherwise render full line.
                const hasParts = line.parts && line.parts.length > 0;
                
                if (hasParts) {
                    const lineContent = document.createElement('span');
                    lineContent.className = 'sl-line-content';
                    
                    line.parts.forEach(part => {
                        const wordSpan = document.createElement('span');
                        wordSpan.className = 'sl-word';
                        wordSpan.innerText = part.text + (part.text.endsWith(' ') ? '' : ' '); // Ensure spacing
                        
                        // Metadata for CSS filling effect
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
                    this.dom.video = this.dom.video || document.querySelector('video');
                    if (this.dom.video) this.dom.video.currentTime = (line.time / 1000);
                };
                this.dom.content.appendChild(row);
            });

            this._injectCSS();
        }


        /**
         * The main loop for synchronizing lyrics with video playback.
         */
         _syncLoop() {
            // Check if synced types (1 or 2)
            if (this.state.lyrics?.type === 0 || !this.state.lyrics) {
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

            // 2. Handle Word Highlighting (If Type 2)
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
                            word.style.backgroundPosition = '0 0'; // Fully active color
                        } else if (currentTimeMs >= start) {
                            // Calculating percentage for karaoke fill
                            const progress = ((currentTimeMs - start) / duration) * 100;
                            // 100% pos is empty, 0% pos is full. 
                            const bgPos = 100 - progress; 
                            word.style.backgroundPosition = `${bgPos}% 0`;
                            word.classList.remove('passed');
                        } else {
                            word.classList.remove('passed');
                            word.style.backgroundPosition = '100% 0'; // Fully inactive color
                        }
                    });
                }
            }
            
            requestAnimationFrame(this._syncLoop);
        }

        // --- DOM Helpers ---
        _unlockTabs() {
            const tabs = document.querySelectorAll('#tabsContent tp-yt-paper-tab'); 
            if (!tabs) return;
            tabs.forEach((tab, idx) => {
                tab.removeAttribute('disabled');
                tab.setAttribute('aria-disabled', 'false');
                tab.disabled = false;
                tab.style.pointerEvents = 'auto';
                tab.style.cursor = 'pointer';
                tab.style.opacity = '1';
            })
        };
    }

    /**
     * -----------------------------------------------------------------------------
     *  Plugin Entry Point
     *  Waits for the pywebview backend to be ready, then inits the plugin.
     * -----------------------------------------------------------------------------
     */
    function main() {
        const plugin = new SyncedLyricsPlugin(G_CONFIG);
        plugin.init();
    }
    
    if (window.pywebview) {
        main();
    } else {
        window.addEventListener('pywebviewready', main);
    }

})();