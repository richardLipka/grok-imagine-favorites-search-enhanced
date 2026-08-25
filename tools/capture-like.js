/* Teach grokSearch.js how to like a post — paste into the DevTools console on grok.com,
   then click Grok's OWN like button on any image.

   Nothing is guessed: this records the exact request Grok's UI sends and stores it as a
   template, so the userscript replays that same request rather than an invented endpoint.
   It observes only; it sends nothing itself. Run it once. */
(() => {
  const STORAGE_KEY = 'grokSearchLikeRequest';
  const IGNORE = /\/(list|get|feed|conversations|rest\/app-chat|statsig|metrics|log|telemetry)\b/i;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  if (window.__grokLikeCaptureActive) {
    console.log('%cCapture already running — click a like button.', 'color:#4af');
    return;
  }
  window.__grokLikeCaptureActive = true;

  const findBooleanPath = (obj, path = []) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'boolean') return [...path, k];
      const hit = findBooleanPath(v, [...path, k]);
      if (hit) return hit;
    }
    return null;
  };

  const record = (method, url, bodyText) => {
    if (!url || IGNORE.test(url)) return;
    if (!/^https?:/.test(url)) url = new URL(url, location.origin).href;
    if (!/grok\.com/.test(url)) return;

    let body = null;
    if (bodyText) { try { body = JSON.parse(bodyText); } catch { /* not JSON */ } }

    const idInUrl = UUID.exec(url)?.[0] || null;
    let idPath = null;
    let postId = idInUrl;
    if (body) {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string' && UUID.test(v)) { idPath = [k]; postId = v; break; }
      }
      if (!idPath) {
        const deep = JSON.stringify(body).match(UUID);
        if (deep) {
          const walk = (o, p = []) => {
            if (typeof o === 'string' && o === deep[0]) return p;
            if (!o || typeof o !== 'object') return null;
            for (const [k, v] of Object.entries(o)) { const r = walk(v, [...p, k]); if (r) return r; }
            return null;
          };
          idPath = walk(body);
          postId = deep[0];
        }
      }
    }
    if (!postId) return;                 // not a per-post action
    if (!/like|favou?rite|react/i.test(url) && !/like|favou?rite/i.test(bodyText || '')) return;

    const template = {
      url: idInUrl ? url.replace(idInUrl, '{id}') : url,
      method,
      body: body || {},
      idPath: idPath || ['postId'],
      likedPath: body ? findBooleanPath(body) : null,
      capturedAt: new Date().toISOString(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(template));
    console.log('%c✓ Captured a like request — grokSearch.js can now like posts.', 'color:#4c4;font-weight:bold');
    console.log(JSON.stringify(template, null, 2));
    console.log('%cReload grok.com/imagine to pick it up. To undo: localStorage.removeItem(\'' + STORAGE_KEY + '\')', 'color:#888');
    cleanup();
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
      if (method !== 'GET') record(method, url, typeof init?.body === 'string' ? init.body : null);
    } catch { /* never break the page */ }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__grokMethod = String(method || '').toUpperCase();
    this.__grokUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__grokMethod && this.__grokMethod !== 'GET') {
        record(this.__grokMethod, this.__grokUrl, typeof body === 'string' ? body : null);
      }
    } catch { /* never break the page */ }
    return origSend.apply(this, arguments);
  };

  function cleanup() {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    window.__grokLikeCaptureActive = false;
    clearTimeout(timer);
  }

  const timer = setTimeout(() => {
    if (!window.__grokLikeCaptureActive) return;
    console.warn('[capture-like] Timed out after 3 minutes without seeing a like request. '
      + 'Re-run and click Grok\'s own like button (not the userscript heart).');
    cleanup();
  }, 180000);

  console.log('%cListening… now click Grok\'s OWN like button on any image.', 'color:#4af;font-weight:bold');
  console.log('%cThis records only; it sends nothing. Auto-stops after the first capture.', 'color:#888');
})();
