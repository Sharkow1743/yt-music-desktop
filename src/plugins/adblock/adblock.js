(function () {
    const config = window.pluginConfig['Adblocker'] || { enabled: true };

    console.log("[Adblocker] Initializing In-Player pruning...");

    // List of keys YouTube uses to inject ads into the player config
    const AD_SIGNATURES = [
        'adPlacements',
        'playerAds',
        'adSlots',
        'adsConfig',
        'adBreakParams'
    ];

    /**
     * Recursively scans an object and removes any keys associated with ads.
     */
    function pruneAds(obj) {
        if (!obj || typeof obj !== 'object') return obj;

        if (Array.isArray(obj)) {
            return obj
                .filter(item => {
                    // Check if the item itself is an ad placement object
                    if (item && typeof item === 'object') {
                        return !AD_SIGNATURES.some(sig => item.hasOwnProperty(sig));
                    }
                    return true;
                })
                .map(pruneAds);
        }

        const cleaned = {};
        for (const key in obj) {
            if (AD_SIGNATURES.includes(key)) {
                continue; // Skip this property (Block the ad)
            }
            cleaned[key] = pruneAds(obj[key]);
        }
        return cleaned;
    }

    // --- Intercept JSON.parse ---
    // This catches the initial player data embedded in the page
    const originalParse = JSON.parse;
    JSON.parse = function (text, reviver) {
        const result = originalParse.call(this, text, reviver);
        try {
            return pruneAds(result);
        } catch (e) {
            return result;
        }
    };

    // --- Intercept Fetch API ---
    // This catches dynamic updates to the player (e.g., when switching videos)
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        
        // We only care about JSON responses that might contain ad data
        if (response.url.includes('youtubei/v1/player') || response.url.includes('watch')) {
            const originalJson = response.json;
            response.json = async () => {
                const data = await originalJson.call(response);
                try {
                    return pruneAds(data);
                } catch (e) {
                    return data;
                }
            };
        }
        return response;
    };

    // --- Intercept XMLHttpRequest ---
    // Fallback for older data fetching methods
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
        this.addEventListener('readystatechange', function() {
            if (this.readyState === 4 && this.responseType === 'json') {
                try {
                    const pruned = pruneAds(this.response);
                    Object.defineProperty(this, 'response', { writable: true, value: pruned });
                } catch (e) {}
            }
        });
        originalOpen.apply(this, arguments);
    };

    console.log("[Adblocker] Interceptors injected.");
})();