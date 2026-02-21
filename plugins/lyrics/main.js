(function() {
    let lastTrackKey = "";
    let lyricLines = [];
    let lyricChars = [];
    let lastActiveLineIdx = -1;
    let isFetching = false;

    // --- TAB UNLOCKER (Polymer Compatible) ---
    const unlockTabs = () => {
        const tabs = document.querySelector('#tabsContent'); 
        if (!tabs) return;
        const tab = tabs.querySelectorAll('tp-yt-paper-tab')[1];
        if (!tab || tab.disabled === false) return;

        tab.removeAttribute('disabled');
        tab.setAttribute('aria-disabled', 'false');
        tab.disabled = false;
        tab.style.pointerEvents = 'auto';
        tab.style.cursor = 'pointer';
        tab.style.opacity = '1';
    };

    const uiObserver = new MutationObserver(unlockTabs);
    uiObserver.observe(document.body, { attributes: true, childList: true, subtree: true });

    // --- LYRICS ENGINE ---
    async function checkAndRefresh() {
        if (isFetching) return;

        const playerBar = document.querySelector('ytmusic-player-bar');
        const lyricsTab = document.querySelector('ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]');
        if (!playerBar || !lyricsTab || lyricsTab.offsetWidth === 0) return;

        const title = playerBar.querySelector('.title')?.innerText;
        const byline = playerBar.querySelector('.byline')?.innerText;
        const artist = byline?.split(' • ')[0];
        const key = `${title}-${artist}`;

        if (key === lastTrackKey && document.getElementById('plugin-lyrics-container')) return;

        isFetching = true;
        lastTrackKey = key;

        let container = document.getElementById('plugin-lyrics-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'plugin-lyrics-container';
            const shelf = lyricsTab.querySelector('ytmusic-description-shelf-renderer') || lyricsTab.querySelector('#contents');
            shelf.parentElement.insertBefore(container, shelf);
            if (shelf.tagName === 'YTMUSIC-DESCRIPTION-SHELF-RENDERER') shelf.style.display = 'none';
        }

        container.innerHTML = `<div class="status">Requesting backend for ${title}...</div>`;

        try {
            // Calling the Python Backend (Bridge)
            const data = await window.pywebview.api.lyrics.get_lyrics(artist, title);
            
            if (data?.synced) {
                renderLyrics(data.synced, container);
            } else {
                container.innerHTML = `<div class="status">No synchronized lyrics available</div>`;
            }
        } catch (e) {
            container.innerHTML = `<div class="status">Search Failed</div>`;
            console.log(e)
        } finally {
            isFetching = false;
        }
    }

    function renderLyrics(parsedLines, container) {
        container.innerHTML = "";
        lyricLines = [];
        lyricChars = [];
        const video = document.querySelector('video');

        parsedLines.forEach((line) => {
            const lineDiv = document.createElement('div');
            lineDiv.className = `synced-line ${line.type}`;
            lineDiv.onclick = () => { if (video) video.currentTime = line.time; };

            line.words.forEach((word) => {
                const wordSpan = document.createElement('span');
                wordSpan.className = 'word';
                
                const charDuration = (word.endTime - word.startTime) / word.text.length;

                for (let i = 0; i < word.text.length; i++) {
                    const charSpan = document.createElement('span');
                    charSpan.className = 'char';
                    charSpan.innerText = word.text[i];
                    wordSpan.appendChild(charSpan);
                    lyricChars.push({ el: charSpan, time: word.startTime + (i * charDuration) });
                }
                
                lineDiv.appendChild(wordSpan);
                // Add space
                lineDiv.appendChild(document.createTextNode(' '));
            });

            container.appendChild(lineDiv);
            lyricLines.push({ el: lineDiv, time: line.time });
        });
        lyricChars.sort((a, b) => a.time - b.time);
    }

    function syncLoop() {
        const video = document.querySelector('video');
        if (!video || lyricLines.length === 0) {
            requestAnimationFrame(syncLoop);
            return;
        }

        const now = video.currentTime;
        
        // 1. Line Level
        let activeLineIdx = -1;
        for (let i = 0; i < lyricLines.length; i++) {
            if (now >= lyricLines[i].time) activeLineIdx = i;
            else break;
        }

        if (activeLineIdx !== lastActiveLineIdx) {
            lyricLines.forEach((line, idx) => {
                line.el.classList.toggle('current', idx === activeLineIdx);
                line.el.classList.toggle('past', idx < activeLineIdx);
                if (idx === activeLineIdx) line.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            lastActiveLineIdx = activeLineIdx;
        }

        // 2. Word/Char Level (Karaoke Highlighting)
        if (!video.paused) {
            lyricChars.forEach(char => {
                char.el.classList.toggle('active', now >= char.time);
            });
        }

        requestAnimationFrame(syncLoop);
    }

    setInterval(checkAndRefresh, 1000);
    syncLoop();
})();