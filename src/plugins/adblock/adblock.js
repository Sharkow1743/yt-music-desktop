(function () {
    console.log("[Adblocker] Initializing Zero-Delay Turbo Block...");

    // 2. Sanitizer: Tells the YouTube engine there are 0 ad placements
    function sanitize(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        
        // Explicitly clear ad arrays so the engine doesn't wait/buffer for them
        if (obj.adPlacements) obj.adPlacements = [];
        if (obj.playerAds) obj.playerAds = [];
        if (obj.adSlots) obj.adSlots = [];
        
        const keysToKill = ['adBreakParams', 'adsConfig', 'adSignalsInfo'];
        keysToKill.forEach(key => delete obj[key]);
        
        for (const key in obj) sanitize(obj[key]);
        return obj;
    }

    // Intercept Initial Page Load Data
    let rawResponse = window.ytInitialPlayerResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
        get: () => rawResponse,
        set: (val) => { rawResponse = sanitize(val); },
        configurable: true
    });

    // 3. Network Intercept: Sanitize dynamic song changes
    const { fetch: originalFetch } = window;
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;

        if (url.includes('youtubei/v1/player')) {
            try {
                const data = await response.json();
                return new Response(JSON.stringify(sanitize(data)), { headers: response.headers });
            } catch (e) { return response; }
        }
        return response;
    };

    // 4. Turbo Skipper: Detects and kills ads in 50ms
    setInterval(() => {
        const video = document.querySelector('video');
        const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        const isAd = document.querySelector('.ad-showing, .ad-interrupting') || (player && player.classList.contains('ad-showing'));

        if (isAd) {
            if (video) {
                video.muted = true;
                video.playbackRate = 16; // Speed through the ad instantly
                if (isFinite(video.duration)) video.currentTime = video.duration;
            }
            
            // Call internal YouTube Player API to skip
            if (player) {
                if (typeof player.skipVideoAd === 'function') player.skipVideoAd();
                if (typeof player.stopVideoAd === 'function') player.stopVideoAd();
            }

            // Click skip button fallback
            const skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button');
            if (skipBtn) skipBtn.click();
        }
    }, 50);
})();