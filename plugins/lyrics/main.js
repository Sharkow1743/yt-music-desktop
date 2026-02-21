(function() {
    let lastTrackKey = "";
    let lyricsData = [];
    let lastActiveIdx = -1;
    let isFetching = false;

    // Selectors
    const LYRICS_TAB_INDEX = 1; // The "Lyrics" tab is usually the second one
    const TAB_BUTTON_SELECTOR = 'ytmusic-player-page #tabsContent tp-yt-paper-tab';
    const RENDERER_SELECTOR = 'ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]';

    /**
     * 1. TAB UNLOCKER
     * Forces the tab to be clickable and visible even if YT says no lyrics exist.
     */
    const unlockUI = () => {
        const tabs = document.querySelectorAll(TAB_BUTTON_SELECTOR);
        const lyricsTab = tabs[LYRICS_TAB_INDEX];
        
        if (lyricsTab) {
            // Remove YT's "disabled" state
            if (lyricsTab.hasAttribute('disabled')) {
                lyricsTab.removeAttribute('disabled');
                lyricsTab.setAttribute('aria-disabled', 'false');
                lyricsTab.style.pointerEvents = 'all';
                lyricsTab.style.opacity = '1';
            }
        }

        // Force the renderer to be part of the DOM layout
        const renderer = document.querySelector(RENDERER_SELECTOR);
        if (renderer) {
            renderer.style.display = 'block';
            // Hide the "Lyrics not available" message renderer
            const msg = renderer.querySelector('ytmusic-message-renderer');
            if (msg) msg.style.display = 'none';
            const wrapper = renderer.querySelector('div.ytmusic-tab-renderer')
            wrapper.removeAttribute('hidden')
        }
    };

    /**
     * 2. DATA FETCHING & INJECTION
     */
    async function updateLyrics() {
        if (isFetching) return;

        // Check if the Lyrics Tab is actually selected by looking at the tab button
        const tabs = document.querySelectorAll(TAB_BUTTON_SELECTOR);
        const lyricsTab = tabs[LYRICS_TAB_INDEX];
        const isTabSelected = lyricsTab && lyricsTab.getAttribute('aria-selected') === 'true';
        
        const container = document.getElementById('plugin-lyrics-container');

        if (!isTabSelected) {
            if (container) container.classList.remove('active-view');
            return;
        }

        const playerBar = document.querySelector('ytmusic-player-bar');
        const title = playerBar?.querySelector('.title')?.innerText;
        const artist = playerBar?.querySelector('.byline')?.innerText?.split(' • ')[0];
        
        if (!title || !artist) return;
        const key = `${title}-${artist}`;

        // If track hasn't changed, just ensure view is active
        if (key === lastTrackKey) {
            if (container) container.classList.add('active-view');
            return;
        }
        
        isFetching = true;
        lastTrackKey = key;
        lastActiveIdx = -1;

        try {
            const renderer = document.querySelector(RENDERER_SELECTOR);
            if (!renderer) throw "Renderer not found";

            const activeContainer = getOrCreateContainer(renderer);
            activeContainer.classList.add('active-view');
            activeContainer.innerHTML = `
                <div class="status-wrapper">
                    <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
                    <div class="status">FETCHING SYNCED DATA...</div>
                </div>
            `;
            
            const data = await window.pywebview.api.lyrics.get_lyrics(artist, title);
            
            if (data?.synced) {
                render(data.synced, activeContainer);
            } else {
                activeContainer.innerHTML = `<div class="status">No synced lyrics found for this track</div>`;
            }
        } catch (e) {
            console.error("Lyrics Plugin Error:", e);
        } finally {
            isFetching = false;
        }
    }

    function getOrCreateContainer(renderer) {
        let c = document.getElementById('plugin-lyrics-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'plugin-lyrics-container';
            
            // On songs with NO native lyrics, #contents might be empty or missing
            // We target #contents if it exists, otherwise append to renderer root
            const target = renderer;
            target.prepend(c);
        }
        return c;
    }

    /**
     * 3. RENDERER & SYNC
     */
    function render(lines, container) {
        container.innerHTML = "";
        lyricsData = lines;
        const fragment = document.createDocumentFragment();

        lines.forEach((line) => {
            const lineDiv = document.createElement('div');
            lineDiv.className = `synced-line ${line.type || 'line'}`;
            
            lineDiv.onclick = () => { 
                const video = document.querySelector('video');
                if(video) video.currentTime = line.startTime; 
            };

            if (line.type === 'instrumental') {
                lineDiv.innerHTML = `<div class="instrumental-animation"></div>`;
            } else {
                line.words.forEach(word => {
                    const wordSpan = document.createElement('span');
                    wordSpan.className = 'word';
                    const text = word.text + (word.text.endsWith(' ') ? '' : ' ');
                    wordSpan.innerText = text;
                    wordSpan.setAttribute('data-word', text.trim());
                    wordSpan.style.setProperty('--word-start', parseFloat(word.startTime) - parseFloat(line.startTime));
                    wordSpan.style.setProperty('--word-duration', parseFloat(word.duration));
                    lineDiv.appendChild(wordSpan);
                });
            }

            line.el = lineDiv;
            fragment.appendChild(lineDiv);
        });

        container.appendChild(fragment);
    }

    function syncLoop() {
        const video = document.querySelector('video');
        const container = document.getElementById('plugin-lyrics-container');
        
        if (!video || !lyricsData.length || !container || !container.classList.contains('active-view')) {
            requestAnimationFrame(syncLoop);
            return;
        }

        const now = video.currentTime;
        let activeIdx = -1;

        for (let i = 0; i < lyricsData.length; i++) {
            if (now >= lyricsData[i].startTime) activeIdx = i;
            else break;
        }

        if (activeIdx !== -1 && activeIdx !== lastActiveIdx) {
            lyricsData.forEach((line, idx) => {
                if (line.el) {
                    line.el.classList.toggle('current', idx === activeIdx);
                    line.el.classList.toggle('past', idx < activeIdx);
                }
            });
            
            const activeEl = lyricsData[activeIdx].el;
            if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            lastActiveIdx = activeIdx;
        }

        if (activeIdx !== -1) {
            container.style.setProperty('--line-offset', now - lyricsData[activeIdx].startTime);
        }

        requestAnimationFrame(syncLoop);
    }

    // Initialize
    const uiObserver = new MutationObserver(unlockUI);
    uiObserver.observe(document.body, { attributes: true, childList: true, subtree: true });
    
    setInterval(updateLyrics, 1000);
    syncLoop();
})();