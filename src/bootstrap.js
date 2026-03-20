// bootstrap.js
(function() {
    const pluginName = window._currentPluginInitName;
    const configData = window._currentPluginInitConfig;
    if (!pluginName) return;

    // --- 1. TrustedHTML Policy (The Purify Bypass) ---
    if (window.trustedTypes && !window.trustedTypes.defaultPolicy) {
        try {
            window.trustedTypes.createPolicy('default', {
                createHTML: (s) => {
                    // Use the core-loaded DOMPurify to sanitize and "Trust" the HTML
                    if (window.DOMPurify) {
                        return window.DOMPurify.sanitize(s, { RETURN_TRUSTED_TYPE: true });
                    }
                    return s; // Fallback if Purify failed to load
                },
                createScript: (s) => s, // Browser usually allows this if created by policy
                createScriptURL: (s) => s
            });
        } catch (e) { console.warn("TrustedTypes policy failed:", e); }
    }

    // --- 2. CSS Enforcement ---
    window._pluginStyles = window._pluginStyles || {};
    window._pluginStyles[pluginName] = [];

    if (!window._pluginObserver) {
        window._pluginObserver = new MutationObserver(() => {
            Object.values(window._pluginStyles).forEach(rules => {
                rules.forEach(rule => {
                    document.querySelectorAll(rule.selector).forEach(el => {
                        Object.entries(rule.styles).forEach(([prop, val]) => {
                            if (el.style.getPropertyValue(prop) !== val) {
                                el.style.setProperty(prop, val, 'important');
                            }
                        });
                    });
                });
            });
        });
        window._pluginObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }

    window.enforceStyle = (selector, styleObject) => {
        window._pluginStyles[pluginName].push({selector, styles: styleObject});
    };

    // --- 3. Config ---
    window.pluginConfig = window.pluginConfig || {};
    window.pluginConfig[pluginName] = configData;

    delete window._currentPluginInitName;
    delete window._currentPluginInitConfig;
})();