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
                isFetching: false,
                isEditing: false // Track edit mode
            };

            this.dom = {
                parent: null,
                container: null,
                controls: null,
                content: null,
                video: null,
                ytmusicApp: null
            };

            this._syncLoop = this._syncLoop.bind(this);
            this._handleTrackChange = this._handleTrackChange.bind(this);
            this._toggleEditMode = this._toggleEditMode.bind(this);
            
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

            const initialVideoId = new URLSearchParams(window.location.search).get('v');
            if (initialVideoId) {
                this._log(`Initial song detected: ${initialVideoId}`);
                this._handleTrackChange(initialVideoId);
            }

            requestAnimationFrame(this._syncLoop);
            
            window.addEventListener('sl-unblock', () => {
                this._log("Received sl-unblock event");
                this._unlockTabs();
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
            this.state.isEditing = false; // Reset edit mode on track change
            this.state.isFetching = true; // Show fetching state immediately while waiting for metadata
            this.render(); 

            let attempts = 0;
            const checkMetadata = setInterval(() => {
                const currentTitle = navigator.mediaSession?.metadata?.title;
                const currentArtist = navigator.mediaSession?.metadata?.artist;
                attempts++;

                if ((currentTitle && currentTitle !== oldTitle) || attempts > 15) {
                    clearInterval(checkMetadata);
                    
                    if (currentTitle && currentArtist) {
                        this._log(`Metadata stabilized after ${attempts} attempts: "${currentTitle}" by ${currentArtist}`);
                        this.fetchData();
                    } else {
                        // If metadata resolution completely fails, exit fetch state safely
                        this._log("Failed to fetch metadata", "", "warn");
                        this.state.isFetching = false;
                        this.render();
                    }
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
                this.state.isFetching = false;
                this.render();
                return;
            }

            this.state.lyrics = null;
            this.state.isFetching = true;
            this.render(); 

            try {
                // Fetch using Pywebview API tree
                await window.pywebview.api.Synced_Lyrics.start_fetch_lyrics(
                    title, artist, album, 
                    this.dom.video?.duration || 0, 
                    this.state.videoId,
                    null
                );

                this._pollLyricsResult(this.state.videoId, title);

            } catch (e) {
                this._log("Fetch invocation error:", e, 'error');
                this.state.isFetching = false;
                this.render();
            }
        }

        /**
         * Polls the backend for the lyrics result.
         */
        async _pollLyricsResult(videoId, title) {
            const pollInterval = 500; // Check every 500ms

            const check = async () => {
                if (this.state.videoId !== videoId) return;

                try {
                    // Check Result using Pywebview API tree
                    const result = await window.pywebview.api.Synced_Lyrics.check_lyrics_result(videoId);

                    if (result?.status === "pending") {
                        setTimeout(check, pollInterval);
                        return;
                    }

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

            if (this.dom.parent.getAttribute('page-type') !== 'MUSIC_PAGE_TYPE_TRACK_LYRICS') { return; }

            this._renderContainer();
            this._renderControls();
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

        _renderControls() {
            if (document.getElementById('sl-controls')) {
                const info = document.getElementById('sl-provider-info');
                if (info) {
                    info.innerText = this.state.lyrics ? `Source:\n${this.state.lyrics.provider || 'Unknown'}` : '';
                }
                return;
            }

            this.dom.controls = document.createElement('div');
            this.dom.controls.id = 'sl-controls';

            this.dom.controls.innerHTML = `
                <select id="sl-provider-select">
                    <option value="">Auto Provider</option>
                    <option value="MusixMatch">MusixMatch</option>
                    <option value="LRCLib">LRCLib</option>
                    <option value="Genius">Genius</option>
                </select>
                <button id="sl-refetch-btn" class="sl-control-btn">Refetch</button>
                <button id="sl-edit-btn" class="sl-control-btn">Edit</button>
                <span id="sl-provider-info"></span>
            `;
                
            this.dom.container.insertBefore(this.dom.controls, this.dom.content);['sl-refetch-btn', 'sl-edit-btn'].forEach(id => {
                const btn = document.getElementById(id);
                btn.addEventListener('mouseover', () => btn.style.background = 'rgba(255,255,255,0.2)');
                btn.addEventListener('mouseout', () => btn.style.background = 'rgba(255,255,255,0.1)');
            });

            document.getElementById('sl-refetch-btn').onclick = async () => {
                if (this.state.isEditing) return; 
                
                const provider = document.getElementById('sl-provider-select').value;
                this.state.isFetching = true;
                this.state.lyrics = null;
                this.render();
                
                const title = navigator.mediaSession?.metadata?.title;
                const artist = navigator.mediaSession?.metadata?.artist;
                const album = navigator.mediaSession?.metadata?.album || "";
                
                try {
                    // Refetch call Using Pywebview API tree
                    await window.pywebview.api.Synced_Lyrics.start_fetch_lyrics(
                        title, artist, album, 
                        this.dom.video?.duration || 0, 
                        this.state.videoId, 
                        provider || null
                    );
                    this._pollLyricsResult(this.state.videoId, title);
                } catch (e) {
                    this._log("Refetch error", e, "error");
                    this.state.isFetching = false;
                    this.render();
                }
            };
            
            document.getElementById('sl-edit-btn').onclick = this._toggleEditMode;
        }

        async _toggleEditMode() {
            const btn = document.getElementById('sl-edit-btn');
            
            if (this.state.isEditing) {
                // --- SAVE LOGIC ---
                const textarea = document.getElementById('sl-edit-textarea');
                if (!textarea) return;

                const rawText = textarea.value;
                this.state.isEditing = false;
                this.state.isFetching = true;
                btn.innerText = 'Edit';
                this.render(); 
                
                try {
                    // Save call Using Pywebview API tree
                    const res = await window.pywebview.api.Synced_Lyrics.save_edited_lyrics(this.state.videoId, rawText);
                    if (res && !res.error) {
                        this.state.lyrics = res;
                    } else {
                        this._log("Save returned error", res.error, "warn");
                    }
                } catch (e) {
                    this._log("Save failed", e, "error");
                } finally {
                    this.state.isFetching = false;
                    this.render();
                }
            } else {
                // --- ENTER EDIT MODE ---
                this.state.isEditing = true;
                btn.innerText = 'Save';
                
                let textContent = '';
                if (this.state.lyrics) {
                    if (this.state.lyrics.type === 0) {
                        textContent = this.state.lyrics.lyrics; // Plain text
                    } else {
                        textContent = this.state.lyrics.lyrics.map(line => {
                            const totalSec = Math.floor(line.time / 1000);
                            const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
                            const s = String(totalSec % 60).padStart(2, '0');
                            const msStr = String(line.time % 1000).padStart(3, '0').slice(0, 2);
                            return `[${m}:${s}.${msStr}] ${line.text}`;
                        }).join('\n');
                    }
                }
                
                this.dom.content.innerHTML = `
                    <textarea id="sl-edit-textarea" placeholder="Enter LRC or plain lyrics here..."></textarea>
                `;
                document.getElementById('sl-edit-textarea').value = textContent;
            }
        }

        _renderContent() {
            if (this.state.isEditing) return;

            this.dom.content = this.dom.content || document.getElementById('sl-content');
            if (!this.dom.content) return;

            if (this.state.isFetching) {
                this.dom.content.dataset.hash = ''; 
                this.dom.content.innerHTML = '<div class="sl-msg">Fetching Lyrics...</div>';
            } else if (this.state.lyrics) {
                this._renderLyrics();
            } else {
                this.dom.content.dataset.hash = ''; 
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

        _syncLoop() {
            if (this.state.isEditing || this.state.isFetching || this.state.lyrics?.type === 0 || !this.state.lyrics) {
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

        _unlockTabs() {
            const tabs = document.querySelectorAll('#tabsContent tp-yt-paper-tab'); 
            if (!tabs || tabs.length === 0) return;
            
            tabs.forEach((tab) => {
                if (tab.hasAttribute('disabled')) {
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
    
    setTimeout(main, 500);

})();