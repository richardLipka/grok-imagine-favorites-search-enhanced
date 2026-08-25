/* Teach grokSearch.js which request returns your whole library — paste into the DevTools
   console on grok.com/imagine, then scroll your library so it loads a page or two.

   The script guesses `filter.source` because the enum covering everything is undocumented. When
   that guess only ever reaches your likes, images you never liked are unreachable. This records
   the exact request Grok's own view sends and stores it as a template, so the userscript replays
   that request instead of guessing.

   It observes only; it sends nothing itself. Auto-stops after 2 minutes, or call
   __grokFinishListCapture() to stop now and keep the best capture so far. */
(() => {
  const STORAGE_KEY = 'grokSearchListRequest';
  const TIMEOUT_MS = 120000;
  const CURSOR_KEYS = ['cursor', 'pageToken', 'nextCursor', 'after', 'pageCursor', 'offset'];
  const LIMIT_KEYS = ['limit', 'pageSize', 'count', 'first', 'take'];
  const POSTS_KEYS = ['posts', 'mediaPosts', 'items', 'results', 'media', 'data'];

  if (window.__grokListCaptureActive) {
    console.log('%cCapture already running — scroll your library.', 'color:#4af');
    return;
  }
  window.__grokListCaptureActive = true;

  let best = null;   // { count, template }

  /** Path to the first key from `names` found anywhere in `obj`, breadth-first. */
  const findPath = (obj, names, path = []) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of Object.keys(obj)) {
      if (names.includes(k)) return [...path, k];
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const hit = findPath(v, names, [...path, k]);
        if (hit) return hit;
      }
    }
    return null;
  };

  /** An array of objects that look like media posts (have an id, and a media-ish field). */
  const countPosts = data => {
    if (!data || typeof data !== 'object') return 0;
    const scan = obj => {
      for (const key of POSTS_KEYS) {
        const v = obj[key];
        if (!Array.isArray(v) || !v.length) continue;
        const first = v[0];
        if (first && typeof first === 'object' && first.id) return v.length;
      }
      return 0;
    };
    let n = scan(data);
    if (n) return n;
    for (const v of Object.values(data)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        n = scan(v);
        if (n) return n;
      }
    }
    return 0;
  };

  const record = (method, url, bodyText, responseText) => {
    if (!url) return;
    if (!/^https?:/.test(url)) url = new URL(url, location.origin).href;
    if (!/grok\.com/.test(url)) return;

    let body = null;
    let data = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { return; }
    try { data = responseText ? JSON.parse(responseText) : null; } catch { return; }
    if (!body || typeof body !== 'object') return;

    const count = countPosts(data);
    if (!count) return;                          // not a media feed response
    if (best && count <= best.count) return;     // keep the request that returns the most

    // The cursor key is often absent on the first page, so fall back to plain "cursor" —
    // grokSearch.js writes it at that path when paginating.
    const cursorPath = findPath(body, CURSOR_KEYS) || ['cursor'];
    const limitPath = findPath(body, LIMIT_KEYS);

    // Strip the cursor from the stored body: the template describes page one.
    const clean = JSON.parse(JSON.stringify(body));
    let node = clean;
    for (let i = 0; i < cursorPath.length - 1; i++) node = node?.[cursorPath[i]];
    if (node && typeof node === 'object') delete node[cursorPath[cursorPath.length - 1]];

    best = {
      count,
      template: {
        url,
        method: method || 'POST',
        body: clean,
        cursorPath,
        limitPath,
        capturedAt: new Date().toISOString(),
      },
    };
    console.log(`%c● captured a feed request returning ${count} posts`, 'color:#4c4');
    console.log('  ', url, JSON.stringify(clean));
  };

  const finish = quiet => {
    cleanup();
    if (!best) {
      if (!quiet) {
        console.warn('[capture-list] Nothing captured. Reload grok.com/imagine, re-run this, and '
          + 'scroll the library view so it fetches a page.');
      }
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(best.template));
    console.log('%c✓ Stored. grokSearch.js will now replay this request instead of guessing.',
      'color:#4c4;font-weight:bold');
    console.log(JSON.stringify(best.template, null, 2));
    console.log('%cReload grok.com/imagine and click Reindex to rebuild from it.', 'color:#4af');
    console.log(`%cTo undo: localStorage.removeItem('${STORAGE_KEY}')`, 'color:#888');
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const p = origFetch.apply(this, arguments);
    if (method !== 'GET' && bodyText) {
      p.then(res => { res.clone().text().then(t => { try { record(method, url, bodyText, t); } catch { /* never break the page */ } }, () => {}); },
        () => {});
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__grokMethod = String(method || '').toUpperCase();
    this.__grokUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__grokMethod && this.__grokMethod !== 'GET' && typeof body === 'string') {
      this.addEventListener('load', () => {
        try { record(this.__grokMethod, this.__grokUrl, body, this.responseText); } catch { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  function cleanup() {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.send = origSend;
    window.__grokListCaptureActive = false;
    delete window.__grokFinishListCapture;
    clearTimeout(timer);
  }

  window.__grokFinishListCapture = () => finish(false);
  const timer = setTimeout(() => finish(false), TIMEOUT_MS);

  console.log('%cListening… now scroll your Imagine library so it loads more images.',
    'color:#4af;font-weight:bold');
  console.log('%cThis records only; it sends nothing. It keeps whichever request returns the most '
    + 'posts. Stops on its own after 2 minutes, or call __grokFinishListCapture() to stop now.',
    'color:#888');
})();
