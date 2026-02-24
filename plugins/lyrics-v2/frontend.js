(function () {
    const PLUGIN_NAME = 'Synced Lyrics';
    const config = window.pluginConfig[PLUGIN_NAME] || {};
    
    let state = {
        videoId: null,
        lyrics: null,
        provider: config.default_provider || 'MusixMatch',
        offset: config.offset || 0,
        activeIdx: -1,
        fetching: false
    };

    let fetchSequence = 0; // Prevent race conditions on spam clicks

    // --- Async Callback Receiver ---
    window.sl_callbacks = {};
    window.sl_python_callback = function(cb_id, data) {
        if (window.sl_callbacks[cb_id]) {
            window.sl_callbacks[cb_id](data);
            delete window.sl_callbacks[cb_id];
        }
    };

    // --- DOM Manipulators ---
    function unblockLyricsTab() {
        const secondTab = document.querySelectorAll('#tabsContent > .tab-header')[1];
        if (secondTab) {
            secondTab.removeAttribute('disabled');
            secondTab.setAttribute('aria-disabled', 'false');
            secondTab.style.opacity = '1';
            secondTab.style.pointerEvents = 'all';
        }
    }

    function hideOriginalContent() {
        const renderer = document.querySelector('ytmusic-description-shelf-renderer');
        if (renderer) {
            const description = renderer.querySelector('#description');
            if (description) description.style.display = 'none';
            const footer = renderer.querySelector('#footer');
            if (footer) footer.style.display = 'none';
            const msg = document.querySelector('ytmusic-message-renderer');
            if (msg && renderer.contains(msg)) msg.style.display = 'none';
        }
    }

    // --- YTMusic Frontend Fetcher ---
    async function fetchYTMusicLyrics(videoId) {
        try {
            const app = document.querySelector('ytmusic-app');
            if (!app || !app.networkManager) return null;
            
            const nextData = await app.networkManager.fetch('/next?prettyPrint=false', { videoId });
            const tabs = nextData?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
            if (!tabs) return null;
            
            const lyricsTab = tabs.find(t => t.tabRenderer?.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS');
            if (!lyricsTab) return null;
            
            const browseId = lyricsTab.tabRenderer.endpoint.browseEndpoint.browseId;
            const browseData = await app.networkManager.fetch('/browse?prettyPrint=false', { browseId });
            
            const contents = browseData?.contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel?.lyricsData?.timedLyricsData;
            
            if (contents) {
                const lines = contents.map(line => ({
                    time: parseInt(line.cueRange.startTimeMilliseconds),
                    text: line.lyricLine === '♪' ? '' : line.lyricLine
                }));
                lines.sort((a,b) => a.time - b.time);
                for(let i=0; i < lines.length - 1; i++) lines[i].duration = lines[i+1].time - lines[i].time;
                if (lines.length > 0) lines[lines.length-1].duration = 5000;
                
                return { type: 'synced', lyrics: lines, provider: 'YTMusic' };
            } else {
                const section = browseData?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
                const text = section?.description?.runs?.map(r => r.text).join('\n');
                if (text) return { type: 'plain', lyrics: text, provider: 'YTMusic' };
            }
        } catch(e) { console.warn("YTMusic fetch failed:", e); }
        return null;
    }

    // --- API & State ---

    async function fetchData(forceProv = null) {
        const vid = state.videoId;
        if (!vid) return;

        const title = navigator.mediaSession?.metadata?.title;
        const artist = navigator.mediaSession?.metadata?.artist;
        if (!title || !artist) return; // Wait until metadata fully loaded

        const album = navigator.mediaSession?.metadata?.album || "";
        const duration = document.querySelector('video')?.duration || 0;

        const currentSeq = ++fetchSequence;
        
        state.fetching = true;
        if (forceProv) state.provider = forceProv;
        
        render(); // Show loader

        try {
            let res = null;

            if (state.provider === 'YTMusic') {
                res = await fetchYTMusicLyrics(vid);
            } 
            
            // Call Python asynchronously if YTMusic failed or another provider is chosen
            if (!res && window.pywebview && window.pywebview.api.Synced_Lyrics) {
                res = await new Promise(resolve => {
                    const cb_id = Math.random().toString(36).substring(2);
                    window.sl_callbacks[cb_id] = resolve;
                    window.pywebview.api.Synced_Lyrics.fetch_async(
                        title, artist, album, duration, vid, state.provider, cb_id
                    );
                });
            }

            // If a newer request was made while we were waiting, discard this one
            if (fetchSequence !== currentSeq) return;

            state.lyrics = res && res.error ? null : res;
        } catch (e) {
            console.error(e);
        } finally {
            if (fetchSequence === currentSeq) {
                state.fetching = false;
                render();
            }
        }
    }

    // --- Rendering ---

    function render() {
        const parent = document.querySelector('ytmusic-description-shelf-renderer');
        if (!parent) return;

        hideOriginalContent();

        let root = document.getElementById('sl-container');
        if (!root) {
            root = document.createElement('div');
            root.id = 'sl-container';
            root.className = `sl-theme-${config.line_effect}`;
            parent.appendChild(root);
        }

        // Header (Provider Switcher)
        const provs = ['MusixMatch', 'YTMusic', 'LRCLib', 'Genius'];
        let header = document.getElementById('sl-header');
        if (!header) {
            header = document.createElement('div');
            header.id = 'sl-header';
            
            provs.forEach(p => {
                const btn = document.createElement('span');
                btn.className = 'sl-prov-btn';
                btn.innerText = p;
                btn.dataset.p = p;
                btn.onclick = () => fetchData(p);
                header.appendChild(btn);
            });
            root.appendChild(header);
        }
        
        // Optimize class toggling to prevent unnecessary DOM mutations
        Array.from(header.children).forEach(btn => {
            if (btn.dataset.p === state.provider) {
                if (!btn.classList.contains('active')) btn.classList.add('active');
            } else {
                if (btn.classList.contains('active')) btn.classList.remove('active');
            }
        });

        // Content
        let content = document.getElementById('sl-content');
        if (!content) {
            content = document.createElement('div');
            content.id = 'sl-content';
            root.appendChild(content);
        }

        // Check if currently fetching
        if (state.fetching) {
            if (content.dataset.hash !== 'fetching') {
                content.innerHTML = '<div class="sl-msg">Fetching Lyrics...</div>';
                content.dataset.hash = 'fetching';
            }
            return;
        }

        // Check if no lyrics found
        if (!state.lyrics) {
            if (content.dataset.hash !== 'notfound') {
                content.innerHTML = '<div class="sl-msg">Lyrics not found :(</div>';
                content.dataset.hash = 'notfound';
            }
            return;
        }

        // Stop full re-render if the hash is already the same
        const currentHash = state.videoId + state.lyrics.provider;
        if (content.dataset.hash === currentHash) return;
        
        content.dataset.hash = currentHash;
        content.innerHTML = '';
        state.activeIdx = -1;
        
        if (state.lyrics.type === 'plain') {
            const txt = document.createElement('div');
            txt.className = 'sl-plain-text';
            txt.innerText = state.lyrics.lyrics;
            content.appendChild(txt);
        } else {
            state.lyrics.lyrics.forEach((line, idx) => {
                const row = document.createElement('div');
                row.className = 'sl-line';
                row.dataset.idx = idx;
                
                if (config.show_time_codes) {
                    const ts = document.createElement('span');
                    ts.className = 'sl-ts';
                    ts.innerText = `[${(line.time/1000).toFixed(2)}] `;
                    row.appendChild(ts);
                }

                const txt = document.createElement('span');
                txt.innerText = line.text;
                row.appendChild(txt);

                row.onclick = () => {
                    const v = document.querySelector('video');
                    if (v) v.currentTime = (line.time / 1000);
                };

                content.appendChild(row);
            });

            const spacerBot = document.createElement('div');
            spacerBot.style.height = "60vh";
            content.appendChild(spacerBot);
        }
    }

    // --- Loops ---

    function syncLoop() {
        const root = document.getElementById('sl-content');
        if (!root || !state.lyrics || state.lyrics.type !== 'synced') {
            requestAnimationFrame(syncLoop);
            return;
        }

        const vid = document.querySelector('video');
        if (!vid || vid.paused) {
            requestAnimationFrame(syncLoop);
            return;
        }

        const time = (vid.currentTime * 1000) + state.offset;
        const lines = state.lyrics.lyrics;

        let idx = -1;
        for(let i=0; i < lines.length; i++) {
            if (lines[i].time <= time) idx = i;
            else break;
        }

        if (idx !== state.activeIdx) {
            state.activeIdx = idx;
            const rows = root.querySelectorAll('.sl-line');
            
            rows.forEach(r => {
                if (r.classList.contains('active')) r.classList.remove('active');
            });

            if (idx !== -1 && rows[idx]) {
                const el = rows[idx];
                el.classList.add('active');
                el.scrollIntoView({behavior: 'smooth', block: 'center'});
            }
        }
        
        requestAnimationFrame(syncLoop);
    }

    function init() {
        if (!config.enabled) return;

        window.addEventListener('sl-unblock', unblockLyricsTab);

        setInterval(() => {
            unblockLyricsTab();
            hideOriginalContent();
            
            const vid = new URLSearchParams(window.location.search).get('v');
            if (vid && vid !== state.videoId) {
                state.videoId = vid;
                state.activeIdx = -1;
                setTimeout(() => fetchData(null), 500); 
            }
        }, 500);

        requestAnimationFrame(syncLoop);

        // Fixed Observer: Only injects 'render' if ytmusic overwrote our container
        const mo = new MutationObserver(() => {
            const shelf = document.querySelector('ytmusic-description-shelf-renderer');
            if (shelf && !document.getElementById('sl-container')) {
                if (state.lyrics || state.fetching) {
                    render();
                }
            }
        });
        mo.observe(document.body, {childList: true, subtree: true});
        
        console.log("Synced Lyrics Loaded (Async Enabled)");
    }

    if (window.pywebview) init();
    else window.addEventListener('pywebviewready', init);

})();