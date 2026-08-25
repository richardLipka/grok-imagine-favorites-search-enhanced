/* GrokSearch index diagnostic — paste into the DevTools console on https://grok.com/imagine
   Read-only: it reads IndexedDB and calls the same liked-list endpoint the script uses.
   It changes nothing. Copy the printed report back. */
(async () => {
  const CUTOFF = '2026-08-21';           // the date after which posts appear to be missing
  const MAX_PAGES = 30;                  // safety cap on the API walk
  const out = {};

  // ── 1. what is actually in the local index ────────────────────────────────
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('GrokSearchIndex');
      r.onsuccess = e => res(e.target.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise((res, rej) => {
      const rq = db.transaction('posts', 'readonly').objectStore('posts').getAll();
      rq.onsuccess = e => res(e.target.result);
      rq.onerror = () => rej(rq.error);
    });
    const ts = r => { const t = Date.parse(r.createTime || ''); return Number.isNaN(t) ? null : t; };
    const good = rows.map(r => ({ r, t: ts(r) })).filter(d => d.t !== null).sort((a, b) => b.t - a.t);
    const byDay = {};
    for (const d of good) {
      const k = new Date(d.t).toISOString().slice(0, 10);
      byDay[k] = (byDay[k] || 0) + 1;
    }
    out.index = {
      rows: rows.length,
      parents: rows.filter(r => !r.isChild).length,
      children: rows.filter(r => r.isChild).length,
      noUsableDate: rows.length - good.length,
      newestRow: good[0] ? { id: good[0].r.id, createTime: good[0].r.createTime, isChild: !!good[0].r.isChild } : null,
      countsPerDay_last14: Object.fromEntries(
        Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)),
      rowsNewerThanCutoff: good.filter(d => d.r.createTime > CUTOFF).length,
    };
  } catch (e) {
    out.index = { error: String(e) };
  }

  // ── 2. what the API actually returns ──────────────────────────────────────
  const listPage = async cursor => {
    const body = { limit: 40, filter: { source: 'MEDIA_POST_SOURCE_LIKED', safeForWork: false } };
    if (cursor) body.cursor = String(cursor);
    const res = await fetch('https://grok.com/rest/media/post/list', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, snippet: data ? null : text.slice(0, 160) };
  };

  const pages = [];
  const apiIds = new Set();
  let newestSeen = '';
  let newerThanCutoff = 0;
  let cursor = null;
  let stoppedBecause = 'reached end of feed';

  for (let i = 0; i < MAX_PAGES; i++) {
    let page;
    try { page = await listPage(cursor); } catch (e) { stoppedBecause = 'fetch threw: ' + e; break; }
    if (page.status !== 200) { stoppedBecause = `HTTP ${page.status}`; pages.push({ page: i, status: page.status, body: page.snippet }); break; }
    if (!page.data) { stoppedBecause = 'response was not JSON'; pages.push({ page: i, snippet: page.snippet }); break; }

    const posts = page.data.posts || [];
    const dates = posts.map(p => p.createTime || p.createdAt || p.create_time || '').filter(Boolean).sort();
    for (const p of posts) {
      if (p.id) apiIds.add(String(p.id));
      const d = p.createTime || p.createdAt || p.create_time || '';
      if (d > newestSeen) newestSeen = d;
      if (d > CUTOFF) newerThanCutoff++;
    }
    pages.push({
      page: i,
      posts: posts.length,
      oldest: dates[0] || null,
      newest: dates[dates.length - 1] || null,
      postsWithoutDate: posts.filter(p => !(p.createTime || p.createdAt || p.create_time)).length,
      nextCursor: page.data.nextCursor ? 'yes' : 'no',
    });
    cursor = page.data.nextCursor;
    if (!cursor || posts.length === 0) break;
    if (i === MAX_PAGES - 1) stoppedBecause = `hit the ${MAX_PAGES}-page diagnostic cap (feed continues)`;
    await new Promise(r => setTimeout(r, 60));
  }

  const first = pages[0] || {};
  const last = pages[pages.length - 1] || {};
  out.api = {
    pagesWalked: pages.length,
    stoppedBecause,
    totalPostsSeen: apiIds.size,
    newestCreateTimeInFeed: newestSeen || null,
    postsNewerThanCutoff: newerThanCutoff,
    feedOrder: first.newest && last.newest
      ? (first.newest >= last.newest ? 'newest-first' : 'oldest-first')
      : 'unknown',
    pages,
  };

  // ── 3. is anything hiding rows in the UI? ─────────────────────────────────
  out.storedPrefs = Object.fromEntries(
    Object.keys(localStorage).filter(k => k.toLowerCase().startsWith('groksearch'))
      .map(k => [k, localStorage.getItem(k)]));

  // ── 4. conflicting databases / duplicate scripts ──────────────────────────
  try {
    out.databases = (await indexedDB.databases()).map(d => `${d.name}@${d.version}`);
  } catch { out.databases = 'unavailable'; }
  out.searchBarsOnPage = document.querySelectorAll('#grok-search-wrap').length;
  out.scriptVersionHint = out.searchBarsOnPage > 1 ? 'MORE THAN ONE search script is running' : 'single search bar';

  // ── verdict ───────────────────────────────────────────────────────────────
  const inIndex = out.index.rowsNewerThanCutoff;
  const inApi = out.api.postsNewerThanCutoff;
  out.verdict =
    inApi === 0 ? `The API returned NO liked posts newer than ${CUTOFF} — the posts are not in the liked feed the script reads (not liked? different source?).`
    : inIndex === 0 ? `The API HAS ${inApi} posts newer than ${CUTOFF} but the index stored none — indexing is dropping them.`
    : `Index holds ${inIndex} rows newer than ${CUTOFF} and the API reports ${inApi} — the data is there, so the UI is filtering or sorting them out of view.`;

  console.log('%c=== GrokSearch diagnostic ===', 'font-weight:bold');
  console.log(JSON.stringify(out, null, 2));
  return out;
})();
