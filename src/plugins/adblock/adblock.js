(function () {
  // Prevent multiple injections
  if (window._ytAdBlockerInjected) return;
  window._ytAdBlockerInjected = true;

  console.log('[AdBlocker] Initializing combined Block and In-Player modes...');

  // ===========================================================================
  // MODE 1: IN-PLAYER (JSON & Object Pruning)
  // ===========================================================================

  // Removes ad-related properties from YouTube API responses
  const pruner = function (o) {
    if (!o || typeof o !== 'object') return o;

    delete o.playerAds;
    delete o.adPlacements;
    delete o.adSlots;

    if (o.playerResponse) {
      delete o.playerResponse.playerAds;
      delete o.playerResponse.adPlacements;
      delete o.playerResponse.adSlots;
    }
    if (o.ytInitialPlayerResponse) {
      delete o.ytInitialPlayerResponse.playerAds;
      delete o.ytInitialPlayerResponse.adPlacements;
      delete o.ytInitialPlayerResponse.adSlots;
    }

    return o;
  };

  // Expose pruner globally for potential debugging or external hook
  window._pruner = pruner;

  // Intercept and prune JSON.parse
  window.JSON.parse = new Proxy(window.JSON.parse, {
    apply(target, thisArg, args) {
      return pruner(Reflect.apply(target, thisArg, args));
    },
  });

  // Intercept and prune Response.prototype.json (Fetch API)
  window.Response.prototype.json = new Proxy(window.Response.prototype.json, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, args).then((o) => pruner(o));
    },
  });

  // Object Property Trapping (Derived from uBlock Origin set-constant.js)
  // Forces specific ad-related properties on the window object to be `undefined`
  const chains = [
    'playerResponse.adPlacements',
    'ytInitialPlayerResponse.playerAds',
    'ytInitialPlayerResponse.adPlacements',
    'ytInitialPlayerResponse.adSlots'
  ];

  chains.forEach(function (chain) {
    let cValue = undefined; // Force ad properties to undefined
    let aborted = false;

    const mustAbort = function (v) {
      if (aborted) return true;
      aborted = v !== undefined && v !== null && typeof v !== typeof cValue;
      return aborted;
    };

    const trapProp = function (owner, prop, configurable, handler) {
      if (handler.init(owner[prop]) === false) return;

      const odesc = Object.getOwnPropertyDescriptor(owner, prop);
      let previousGetter;
      let previousSetter;

      if (odesc instanceof Object) {
        if (odesc.configurable === false) return;
        if (odesc.get instanceof Function) previousGetter = odesc.get;
        if (odesc.set instanceof Function) previousSetter = odesc.set;
      }

      Object.defineProperty(owner, prop, {
        configurable,
        get() {
          if (previousGetter !== undefined) previousGetter();
          return handler.getter();
        },
        set(a) {
          if (previousSetter !== undefined) previousSetter(a);
          handler.setter(a);
        },
      });
    };

    const trapChain = function (owner, chain) {
      const pos = chain.indexOf('.');
      if (pos === -1) {
        trapProp(owner, chain, false, {
          v: undefined,
          getter() {
            return cValue;
          },
          setter(a) {
            if (mustAbort(a) === false) return;
            cValue = a;
          },
          init(v) {
            if (mustAbort(v)) return false;
            this.v = v;
            return true;
          },
        });
        return;
      }

      const prop = chain.slice(0, pos);
      const v = owner[prop];
      chain = chain.slice(pos + 1);

      if (v instanceof Object || (typeof v === 'object' && v !== null)) {
        trapChain(v, chain);
        return;
      }

      trapProp(owner, prop, true, {
        v: undefined,
        getter() {
          return this.v;
        },
        setter(a) {
          this.v = a;
          if (a instanceof Object) trapChain(a, chain);
        },
        init(v) {
          this.v = v;
          return true;
        },
      });
    };

    trapChain(window, chain);
  });


  // ===========================================================================
  // MODE 2: BLOCK (Network Interception / Blocklists Emulator)
  // ===========================================================================
  
  // List of keywords typically found in YouTube ad tracking / serving URLs
  const AD_KEYWORDS = [
    '/pagead/',
    '/api/stats/ads',
    '/api/stats/qoe?ad',
    'doubleclick.net',
    'googlesyndication.com',
    'adformat=',
    'ad_type=',
    'ad_break'
  ];

  function isAdUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lowerUrl = url.toLowerCase();
    return AD_KEYWORDS.some((kw) => lowerUrl.includes(kw));
  }

  // Intercept Fetch API requests
  window.fetch = new Proxy(window.fetch, {
    apply(target, thisArg, args) {
      let url = args[0];
      if (url instanceof Request) {
        url = url.url;
      } else if (typeof url !== 'string') {
        url = String(url);
      }

      if (isAdUrl(url)) {
        // Return a mocked successful response for blocked requests
        return Promise.resolve(new Response('{}', { 
            status: 200, 
            statusText: 'OK',
            headers: new Headers({ 'Content-Type': 'application/json' })
        }));
      }

      return Reflect.apply(target, thisArg, args);
    },
  });

  // Intercept XMLHttpRequest
  const origXhrOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (method, url) {
    if (isAdUrl(url)) {
      // By changing the URL to a dummy data URL, we safely "block" the request 
      // natively without fighting `Object.defineProperty` read-only errors on XHR.
      arguments[1] = 'data:application/json,{}';
    }
    return origXhrOpen.apply(this, arguments);
  };

  console.log('[AdBlocker] Combined Block & In-Player injected successfully.');
})();