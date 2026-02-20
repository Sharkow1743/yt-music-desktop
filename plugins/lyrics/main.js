(function() {
    let lastTrackKey = "";
    let lyricLines = []; // Stores line elements for row-level styling
    let lyricChars = []; // Stores character elements for precise karaoke timing
    let lastActiveLineIdx = -1;
    let isFetching = false;

    // --- UTILITIES ---

    const parseTime = (str) => {
        if (!str || str.includes('NaN')) return null;
        const parts = str.split(':');
        return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    };

    // --- PARSER (Supports LRC, LRCv2, LySy, Multi-Singer) ---

    const parseLRC = (lrcRaw) => {
        const lines = [];
        const rawLines = lrcRaw.split('\n');
        
        const lineTimeReg = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
        const bgReg = /\[bg:(.*?)\]/; 
        const singerReg = /^(v\d+):/;

        rawLines.forEach(raw => {
            const match = lineTimeReg.exec(raw.trim());
            if (!match) return;

            const lineStartTime = parseInt(match[1]) * 60 + parseFloat(match[2]);
            let content = match[3].trim();

            // 1. Extract Background Vocals
            const bgMatch = bgReg.exec(content);
            if (bgMatch) {
                content = content.replace(bgMatch[0], '').trim();
                const bgParsed = parseLineContent(bgMatch[1], lineStartTime, "bg");
                if (bgParsed) lines.push(bgParsed);
            }

            // 2. Extract Singer ID
            let type = "main";
            const singerMatch = singerReg.exec(content);
            if (singerMatch) {
                type = singerMatch[1];
                content = content.substring(singerMatch[0].length).trim();
            }

            // 3. Process Main Content
            if (content) {
                const mainParsed = parseLineContent(content, lineStartTime, type);
                if (mainParsed) lines.push(mainParsed);
            }
        });

        return lines.sort((a, b) => a.time - b.time);
    };

    const parseLineContent = (content, defaultStartTime, type) => {
        const wordTimeReg = /<(\d+):(\d+(?:\.\d+)?)|NaN:000NaN>/g;
        
        // Check for inner timestamps (LRCv2/LySy)
        if (content.match(wordTimeReg)) {
            const words = [];
            let lastIndex = 0;
            let match;
            
            while ((match = wordTimeReg.exec(content)) !== null) {
                const text = content.substring(lastIndex, match.index).trim();
                const timeStr = match[1] && match[2] ? `${match[1]}:${match[2]}` : null;
                const time = parseTime(timeStr);

                if (text) words.push({ text: text, endTime: time }); // Word before tag
                
                // Determine start time for NEXT word
                words.push({ text: "", startTime: time, isMarker: true });
                lastIndex = match.index + match[0].length;
            }

            const remaining = content.substring(lastIndex).trim();
            if (remaining) words.push({ text: remaining });

            // Consolidate times
            const finalWords = [];
            let currentStartTime = defaultStartTime;

            words.forEach(w => {
                if (w.isMarker) {
                    if (w.startTime !== null) currentStartTime = w.startTime;
                } else {
                    finalWords.push({
                        text: w.text,
                        startTime: currentStartTime
                    });
                }
            });
            
            return { time: defaultStartTime, content, words: finalWords, type };
        } else {
            // Standard LRC
            return {
                time: defaultStartTime,
                content: content,
                type: type,
                words: [{ text: content, startTime: defaultStartTime }]
            };
        }
    };

    // --- DOM MANIPULATION ---
    const unlockTabs = () => {
        const playerPage = document.querySelector('.ytmusic-player-page');
        if (!playerPage) return;

        // Use a more specific selector to get the tabs container (the parent element)
        // We look for the main tabs, not just the content div
        const tabs = playerPage.querySelector('#tabsContent'); 
        if (!tabs) return;

        // Get the second tab (Lyrics)
        // Note: Use tabs.querySelectorAll to ensure we get children of the main wrapper
        const tab = tabs.querySelectorAll('tp-yt-paper-tab')[1];
        if (!tab) return;

        // 1. Remove HTML disabled attributes
        if (tab.hasAttribute('disabled')) {
            tab.removeAttribute('disabled');
            tab.setAttribute('aria-disabled', 'false');
        }

        // 2. Remove Property disabled state (Crucial for Polymer)
        if (tab.disabled) {
            tab.disabled = false;
        }

        // 3. Force Styles
        tab.style.pointerEvents = 'auto';
        tab.style.cursor = 'pointer';
        tab.style.opacity = '1';

        // 4. Safety Click Listener (Capture Phase)
        // We do NOT stop propagation. We just ensure it's enabled 
        // exactly when the user clicks, in case YTM tries to disable it again.
        if (!tab._customListenerAdded) {
            console.log('➕ Adding enable-on-click safeguard');
            tab.addEventListener('click', (e) => {
                console.log('🔊 Click passing through to YTM...');
                // Force enable just before the app handles the event
                tab.disabled = false;
                tab.removeAttribute('disabled');
                tab.setAttribute('aria-disabled', 'false');
                
                // WE DO NOT CALL e.preventDefault() OR e.stopImmediatePropagation()
                // We let the event bubble up so YTM handles the view switch.
            }, true);
            tab._customListenerAdded = true;
        }
    };

    const uiObserver = new MutationObserver((mutations) => {
        unlockTabs();
    });

    // Observe the player page specifically if possible, otherwise body is fine
    uiObserver.observe(document.body, { attributes: true, childList: true, subtree: true });

    function createContainer(tabRenderer) {
        // 1. Check if already exists
        let container = document.getElementById('plugin-lyrics-container');
        if (container) return container;

        // 2. Create Element
        container = document.createElement('div');
        container.id = 'plugin-lyrics-container';

        // 3. Find insertion point
        // A. Try the standard shelf (if song has native lyrics)
        const shelf = tabRenderer.querySelector('ytmusic-description-shelf-renderer');
        if (shelf) {
            shelf.style.display = 'none'; // Hide native lyrics if we are overriding
            shelf.parentElement.insertBefore(container, shelf);
            return container;
        }

        // B. Try the "Message Renderer" (The "Lyrics not available" message)
        const messageRenderer = tabRenderer.querySelector('ytmusic-message-renderer');
        if (messageRenderer) {
            messageRenderer.style.display = 'none'; // Hide "Not Available" message
            messageRenderer.parentElement.appendChild(container);
            return container;
        }

        // C. Fallback: Append to the main content container
        const contentDiv = tabRenderer.querySelector('#contents');
        if (contentDiv) {
            contentDiv.appendChild(container);
            return container;
        }

        // D. Last Resort: Append directly to the renderer
        tabRenderer.appendChild(container);
        return container;
    }

    async function checkAndRefresh() {
        if (isFetching) return;

        const playerBar = document.querySelector('ytmusic-player-bar');
        if (!playerBar) return;

        const title = playerBar.querySelector('.title')?.innerText;
        const byline = playerBar.querySelector('.byline')?.innerText;
        const artist = byline?.split(' • ')[0];
        const key = `${title}-${artist}`;

        // Get the renderer content area
        const lyricsTabRenderer = document.querySelector('ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]');
        
        // Only run if the tab content is actually loaded/visible
        // Note: YTM renders the tab content only AFTER the first click
        if (!lyricsTabRenderer || lyricsTabRenderer.offsetWidth === 0) return;

        const container = document.getElementById('plugin-lyrics-container');
        const hasContent = container && container.querySelectorAll('.synced-line').length > 0;

        if (key === lastTrackKey && hasContent) return;

        isFetching = true;
        lastTrackKey = key;

        // Create container using the fixed function
        let targetContainer = createContainer(lyricsTabRenderer);
        targetContainer.innerHTML = `<div class="status">Searching enhanced lyrics...</div>`;

        try {
            // Mocking the call since I don't have pywebview. 
            // In your code: const data = await window.pywebview.api.lyrics.get_lyrics(artist, title);
            const data = await window.pywebview.api.lyrics.get_lyrics(artist, title);
            
            if (data?.synced) {
                const parsedData = parseLRC(data.synced);
                renderLyrics(parsedData, targetContainer);
            } else {
                targetContainer.innerHTML = `<div class="status">Synced lyrics not found for this track</div>`;
                lyricLines = [];
            }
        } catch (e) {
            console.error("Lyrics Error:", e);
            targetContainer.innerHTML = `<div class="status">Lyrics Error or Not Found</div>`;
        } finally {
            isFetching = false;
        }
    }

    function renderLyrics(parsedLines, container) {
        container.innerHTML = "";
        lyricLines = [];
        lyricChars = [];
        const video = document.querySelector('video');

        parsedLines.forEach((line, lineIdx) => {
            const lineDiv = document.createElement('div');
            lineDiv.className = `synced-line ${line.type}`;
            
            lineDiv.onclick = (e) => {
                e.stopPropagation();
                if (video) video.currentTime = line.time;
            };

            const nextLineTime = parsedLines[lineIdx + 1] ? parsedLines[lineIdx + 1].time : line.time + 5;
            
            line.words.forEach((word, wordIdx) => {
                const wordSpan = document.createElement('span');
                wordSpan.className = 'word';
                lineDiv.appendChild(wordSpan);

                let wordEndTime = nextLineTime;
                if (line.words[wordIdx + 1]) wordEndTime = line.words[wordIdx + 1].startTime;
                if (wordEndTime < word.startTime) wordEndTime = word.startTime + 0.5;
                
                const wordDuration = wordEndTime - word.startTime;
                const charDuration = wordDuration / word.text.length;

                for (let i = 0; i < word.text.length; i++) {
                    const charSpan = document.createElement('span');
                    charSpan.className = 'char';
                    charSpan.innerText = word.text[i];
                    wordSpan.appendChild(charSpan);
                    lyricChars.push({ el: charSpan, time: word.startTime + (i * charDuration) });
                }
                if (wordIdx < line.words.length - 1) {
                     const spaceSpan = document.createElement('span');
                     spaceSpan.className = 'char';
                     spaceSpan.innerText = ' '; 
                     wordSpan.appendChild(spaceSpan);
                     lyricChars.push({ el: spaceSpan, time: wordEndTime }); 
                }
            });
            container.appendChild(lineDiv);
            lyricLines.push({ el: lineDiv, time: line.time });
        });
        
        lyricChars.sort((a,b) => a.time - b.time);
    }

    function syncLoop() {
        const video = document.querySelector('video');
        if (!video || lyricLines.length === 0) {
            requestAnimationFrame(syncLoop);
            return;
        }

        const now = video.currentTime;
        
        // 1. Line Level Synchronization (Current, Past, Future)
        let activeLineIdx = -1;
        for (let i = 0; i < lyricLines.length; i++) {
            if (now >= lyricLines[i].time) activeLineIdx = i;
            else break;
        }

        if (activeLineIdx !== lastActiveLineIdx) {
            lyricLines.forEach((line, idx) => {
                line.el.classList.remove('current', 'past');
                if (idx < activeLineIdx) {
                    line.el.classList.add('past');
                } else if (idx === activeLineIdx) {
                    line.el.classList.add('current');
                    line.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
            lastActiveLineIdx = activeLineIdx;
        }

        // 2. Character Level Synchronization (Karaoke Highlight)
        // Optimization: Find the rough range of chars based on current time
        // Since we are sorting, we can just iterate. For <5000 chars this is cheap.
        
        // We only really need to update chars if we are playing
        if (!video.paused) {
            // Find the last active char index
            let activeCharIdx = -1;
            // Simple binary search or just linear scan is fine here
            for(let i=0; i<lyricChars.length; i++) {
                 if (now >= lyricChars[i].time) activeCharIdx = i;
                 else break;
            }

            // Apply classes
            // To save DOM ops, only toggle if classList doesn't match
            // But doing it every frame for changed range is cleaner logic
            lyricChars.forEach((char, idx) => {
                if (idx <= activeCharIdx) {
                    if (!char.el.classList.contains('active')) char.el.classList.add('active');
                } else {
                    if (char.el.classList.contains('active')) char.el.classList.remove('active');
                }
            });
        }

        requestAnimationFrame(syncLoop);
    }

    setInterval(checkAndRefresh, 1000);
    requestAnimationFrame(syncLoop);
    unlockTabs();
})();