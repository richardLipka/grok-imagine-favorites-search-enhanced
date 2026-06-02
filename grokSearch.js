// ==UserScript==
// @name         Grok Imagine Favorites Search + Saved Item Pass-Through
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Search saved Grok images/videos on the saved list page. Clicks open saved item detail page (/imagine/post/{id}). No custom UI on detail pages.
// @author       AnnaLynn (with fixes)
// @match        https://grok.com/imagine*
// @grant        GM_xmlhttpRequest
// @connect      grok.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Skip everything if we're on a detail page
  if (location.href.includes('/imagine/post/')) {
    console.log('[GrokSearch] Detail page detected — disabling custom UI');
    return;
  }

  const PAGE_SIZE = 20;
  const ENDPOINT = 'https://grok.com/rest/media/post/list';
  const DB_NAME = 'GrokSearchIndex';
  const DB_VERSION = 1;
  const STORE_NAME = 'posts';

  let allPosts = [];
  const knownIds = new Set();
  let currentQuery = '';
  let currentPage = 0;
  let currentSort = 'newest';
  let matchedPosts = [];
  let loaded = false;
  let db = null;
  let indexing = false;
  let rendering = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // IndexedDB functions (unchanged)
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createTime', 'createTime', { unique: false });
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbGetAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbPutMany(posts) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      posts.forEach(p => store.put(p));
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  // ─── API & fetch ───────────────────────────────────────────────────────────
  function fetchPage(cursor) {
    return new Promise(resolve => {
      const body = { limit: 40, filter: { source: 'MEDIA_POST_SOURCE_LIKED', safeForWork: false } };
      if (cursor) body.cursor = String(cursor);
      GM_xmlhttpRequest({
        method: 'POST', url: ENDPOINT,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        withCredentials: true,
        onload: res => { try { resolve(JSON.parse(res.responseText)); } catch { resolve(null); } },
        onerror: () => resolve(null),
      });
    });
  }

  function parsePost(post) {
    if (!post.id) return null;
    const prompt = post.prompt || post.originalPrompt || '';
    return {
      id: post.id,
      prompt,
      thumbnail: post.thumbnailImageUrl || post.mediaUrl || '',
      mediaUrl: post.mediaUrl || '',
      createTime: post.createTime || '',
    };
  }

  async function fetchNewPosts(statusEl) {
    let cursor = null;
    let newCount = 0;
    const newPosts = [];
    while (true) {
      const data = await fetchPage(cursor);
      if (!data) break;
      const posts = data.posts || [];
      let hitKnown = false;
      for (const post of posts) {
        if (knownIds.has(post.id)) { hitKnown = true; break; }
        const parsed = parsePost(post);
        if (parsed) { newPosts.push(parsed); newCount++; }
      }
      if (hitKnown || !data.nextCursor || posts.length === 0) break;
      cursor = data.nextCursor;
      if (statusEl) statusEl.textContent = `checking new… +${newCount}`;
      await sleep(100);
    }
    if (newPosts.length > 0) {
      for (const p of newPosts) {
        allPosts.unshift(p);
        knownIds.add(p.id);
      }
      await dbPutMany(newPosts);
    }
    return newCount;
  }

  async function fetchFullIndex(statusEl) {
    const allFetched = [];
    let cursor = null;
    while (true) {
      const data = await fetchPage(cursor);
      if (!data) break;
      const posts = data.posts || [];
      for (const post of posts) {
        if (knownIds.has(post.id)) continue;
        const parsed = parsePost(post);
        if (parsed) { allFetched.push(parsed); knownIds.add(parsed.id); }
      }
      if (statusEl) statusEl.textContent = `indexing… ${allFetched.length.toLocaleString()}`;
      cursor = data.nextCursor || null;
      if (!cursor || posts.length === 0) break;
    }
    allFetched.sort((a, b) => {
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      return tb - ta;
    });
    for (const p of allFetched) allPosts.push(p);
    const chunkSize = 500;
    for (let i = 0; i < allFetched.length; i += chunkSize) {
      await dbPutMany(allFetched.slice(i, i + chunkSize));
      if (statusEl) statusEl.textContent = `saving… ${Math.min(i + chunkSize, allFetched.length)}/${allFetched.length}`;
    }
    return allFetched.length;
  }

  async function loadAllPosts() {
    if (indexing || loaded) return;
    indexing = true;
    const statusEl = document.getElementById('grok-stamp-status');
    try {
      db = await openDB();
    } catch (e) {
      console.error('[GrokSearch] IndexedDB failed:', e);
      if (statusEl) statusEl.textContent = 'DB error';
      return;
    }
    const cached = await dbGetAll();
    if (cached.length > 0) {
      const seen = new Set();
      for (const p of cached) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        knownIds.add(p.id);
        allPosts.push(p);
      }
      allPosts.sort((a, b) => {
        const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
        const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
        return tb - ta;
      });
      loaded = true;
      console.log(`[GrokSearch] ${allPosts.length} posts loaded from IndexedDB`);
      if (statusEl) {
        statusEl.textContent = `${allPosts.length.toLocaleString()} cached`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
      }
      if (statusEl) statusEl.textContent = 'checking for new…';
      const newCount = await fetchNewPosts(statusEl);
      if (statusEl) {
        statusEl.textContent = newCount > 0
          ? `+${newCount} new (${allPosts.length.toLocaleString()} total)`
          : 'up to date';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
    } else {
      if (statusEl) statusEl.textContent = 'first-time indexing…';
      const count = await fetchFullIndex(statusEl);
      loaded = true;
      console.log(`[GrokSearch] Full index done: ${count} posts`);
      if (statusEl) {
        statusEl.textContent = `${count.toLocaleString()} indexed`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
      }
    }
    indexing = false;
    applyFilter();
  }

  // ─── Results ───────────────────────────────────────────────────────────────
  function getGrokGrid() {
    const card = document.querySelector('[class*="media-post-masonry-card"]');
    if (!card) return null;
    let el = card.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!el) break;
      if (el.children.length > 3) return el;
      el = el.parentElement;
    }
    return card.parentElement;
  }

  function showResults() {
    if (rendering) return;
    rendering = true;
    setTimeout(() => { rendering = false; }, 50);

    const totalPages = Math.max(1, Math.ceil(matchedPosts.length / PAGE_SIZE));
    currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
    const start = currentPage * PAGE_SIZE;
    const page = matchedPosts.slice(start, start + PAGE_SIZE);

    const nativeGrid = getGrokGrid();
    if (nativeGrid) {
      nativeGrid.style.display = 'none';
      nativeGrid.style.visibility = 'hidden';
    }

    let container = document.getElementById('grok-results-grid');
    if (!container) {
      container = document.createElement('div');
      container.id = 'grok-results-grid';
      const insertTarget = nativeGrid?.parentElement || document.body;
      insertTarget.appendChild(container);
    }
    container.style.display = 'grid';

    container.innerHTML = page.map(post => `
      <div class="grok-result-card" data-id="${escapeHtml(post.id)}" data-media="${escapeHtml(post.mediaUrl)}" title="${escapeHtml(post.prompt)}">
        <img src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.prompt)}" loading="lazy" style="width:100%; display:block; border-radius:12px; aspect-ratio:3/4; object-fit:cover;" />
        <div class="grok-result-prompt">${escapeHtml(post.prompt)}</div>
      </div>
    `).join('');

    container.querySelectorAll('.grok-result-card').forEach(card => {
      card.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();

        const postId = card.dataset.id;
        if (postId) {
          console.log('[GrokSearch] Opening saved item detail page:', postId);
          window.open(`https://grok.com/imagine/post/${postId}`, '_blank');
        } else {
          console.log('[GrokSearch] No postId – opening media directly');
          window.open(card.dataset.media, '_blank');
        }
      });
    });

    updatePager();
    window.scrollTo({ top: 100, behavior: 'smooth' });
  }

  function hideResults() {
    const container = document.getElementById('grok-results-grid');
    if (container) container.style.display = 'none';
    const nativeGrid = getGrokGrid();
    if (nativeGrid) {
      nativeGrid.style.display = '';
      nativeGrid.style.visibility = '';
    }
    updatePager();
  }

  function applyFilter() {
    if (!loaded) {
      const noResults = document.getElementById('grok-no-results');
      if (noResults) {
        noResults.classList.add('visible');
        noResults.querySelector('span').textContent = '⏳';
        noResults.lastChild.textContent = 'Still indexing…';
      }
      return;
    }

    let queryLower = (currentQuery || '').toLowerCase().trim();

    if (!queryLower) {
      matchedPosts = [...allPosts];
    } else {
      const terms = queryLower.split(/\s+/).filter(Boolean);
      matchedPosts = allPosts.filter(post => {
        const p = post.prompt.toLowerCase();
        return terms.every(t => p.includes(t));
      });
    }

    matchedPosts.sort((a, b) => {
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      return currentSort === 'oldest' ? ta - tb : tb - ta;
    });

    currentPage = 0;
    const noResults = document.getElementById('grok-no-results');
    if (matchedPosts.length === 0) {
      hideResults();
      if (noResults) noResults.classList.add('visible');
    } else {
      if (noResults) noResults.classList.remove('visible');
      showResults();
    }
    updatePager();
  }

  function updatePager() {
    const totalPages = Math.max(1, Math.ceil(matchedPosts.length / PAGE_SIZE));
    const countEl = document.getElementById('grok-search-count');
    const pagerEl = document.getElementById('grok-pager');
    const pageLabel = document.getElementById('grok-page-label');
    const firstBtn = document.getElementById('grok-page-first');
    const prevBtn = document.getElementById('grok-page-prev');
    const nextBtn = document.getElementById('grok-page-next');
    const lastBtn = document.getElementById('grok-page-last');

    if (countEl) {
      countEl.textContent = currentQuery.trim()
        ? `${matchedPosts.length.toLocaleString()} match${matchedPosts.length !== 1 ? 'es' : ''}`
        : `${matchedPosts.length.toLocaleString()} saved`;
    }

    if (pagerEl) {
      pagerEl.style.display = (totalPages > 1) ? 'flex' : 'none';
    }

    if (pageLabel) pageLabel.textContent = `${(currentPage + 1).toLocaleString()} / ${totalPages.toLocaleString()}`;
    if (firstBtn) firstBtn.disabled = currentPage === 0;
    if (prevBtn) prevBtn.disabled = currentPage === 0;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages - 1;
    if (lastBtn) lastBtn.disabled = currentPage >= totalPages - 1;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─── Styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('grok-search-styles')) return;
    const s = document.createElement('style');
    s.id = 'grok-search-styles';
    s.textContent = `
      #grok-search-wrap {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 99999; display: flex; flex-direction: column; align-items: center;
        gap: 8px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      }
      #grok-search-bar {
        display: flex; align-items: center; gap: 8px;
        background: rgba(15,15,20,0.93); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px; padding: 10px 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        min-width: 340px; max-width: 600px; width: 44vw;
        transition: box-shadow 0.2s, border-color 0.2s;
      }
      #grok-search-bar:focus-within {
        border-color: rgba(139,92,246,0.6);
        box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 3px rgba(139,92,246,0.15);
      }
      #grok-search-icon { color: rgba(255,255,255,0.4); flex-shrink: 0; }
      #grok-search-input {
        background: transparent; border: none; outline: none;
        color: #fff; font-size: 14px; width: 100%; caret-color: #8b5cf6;
      }
      #grok-search-input::placeholder { color: rgba(255,255,255,0.28); }
      #grok-search-count {
        font-size: 11px; color: rgba(255,255,255,0.4);
        white-space: nowrap; font-variant-numeric: tabular-nums; flex-shrink: 0;
      }
      #grok-stamp-status { font-size: 10px; color: rgba(255,255,255,0.22); white-space: nowrap; flex-shrink: 0; }
      #grok-search-clear {
        background: none; border: none; cursor: pointer; color: rgba(255,255,255,0.3);
        padding: 2px; border-radius: 4px; display: none; align-items: center;
        justify-content: center; flex-shrink: 0; transition: color 0.15s;
      }
      #grok-search-clear:hover { color: rgba(255,255,255,0.7); }
      #grok-search-clear.visible { display: flex; }
      #grok-sort-select {
        background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px; color: rgba(255,255,255,0.7); font-size: 11px;
        padding: 3px 6px; outline: none; cursor: pointer; flex-shrink: 0;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        transition: border-color 0.15s, color 0.15s;
      }
      #grok-sort-select:hover { border-color: rgba(139,92,246,0.5); color: #fff; }
      #grok-sort-select option { background: #1a1a2e; color: #fff; }
      #grok-pager {
        display: none; align-items: center; gap: 5px;
        background: rgba(15,15,20,0.88); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px; padding: 5px 10px;
        backdrop-filter: blur(12px); box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      }
      .grok-page-btn {
        background: none; border: 1px solid rgba(255,255,255,0.12);
        border-radius: 7px; color: rgba(255,255,255,0.7);
        cursor: pointer; padding: 4px 10px; font-size: 12px;
        display: flex; align-items: center; gap: 3px;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .grok-page-btn:hover:not(:disabled) {
        background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.5); color: #fff;
      }
      .grok-page-btn:disabled { opacity: 0.25; cursor: default; }
      .grok-page-btn.icon-only { padding: 4px 8px; }
      #grok-page-label {
        font-size: 12px; color: rgba(255,255,255,0.45);
        font-variant-numeric: tabular-nums; min-width: 56px; text-align: center;
      }
      #grok-results-grid {
        display: none;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 12px; padding: 80px 24px 24px;
        width: 100%; box-sizing: border-box;
        max-width: 1400px; margin: 0 auto;
      }
      .grok-result-card {
        position: relative; cursor: pointer; border-radius: 12px;
        overflow: hidden; background: rgba(255,255,255,0.05);
        transition: transform 0.2s, box-shadow 0.2s;
      }
      .grok-result-card:hover { transform: scale(1.03); box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
      .grok-result-card img { width: 100%; display: block; border-radius: 12px; aspect-ratio: 3/4; object-fit: cover; }
      .grok-result-prompt {
        position: absolute; bottom: 0; left: 0; right: 0;
        background: linear-gradient(transparent, rgba(0,0,0,0.85));
        color: rgba(255,255,255,0.85); font-size: 10px; line-height: 1.4;
        padding: 20px 8px 8px; border-radius: 0 0 12px 12px;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
        overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        opacity: 0; transition: opacity 0.2s;
      }
      .grok-result-card:hover .grok-result-prompt { opacity: 1; }
      #grok-no-results {
        display: none; position: fixed; top: 50%; left: 50%;
        transform: translate(-50%,-50%); z-index: 99998; text-align: center;
        pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        color: rgba(255,255,255,0.3); font-size: 15px;
      }
      #grok-no-results.visible { display: block; }
      #grok-no-results span { display: block; font-size: 36px; margin-bottom: 10px; }
    `;
    document.head.appendChild(s);
  }

  // ─── UI ────────────────────────────────────────────────────────────────────
  function buildSearchBar() {
    if (document.getElementById('grok-search-wrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'grok-search-wrap';
    wrap.innerHTML = `
      <div id="grok-search-bar">
        <svg id="grok-search-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="8.5" cy="8.5" r="5.5"/><line x1="12.5" y1="12.5" x2="17" y2="17"/>
        </svg>
        <input id="grok-search-input" type="text" placeholder="Search saved images by prompt…" autocomplete="off" spellcheck="false" />
        <span id="grok-stamp-status"></span>
        <span id="grok-search-count"></span>
        <select id="grok-sort-select" title="Sort order">
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </select>
        <button id="grok-search-clear" title="Clear">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
          </svg>
        </button>
      </div>
      <div id="grok-pager">
        <button class="grok-page-btn icon-only" id="grok-page-first" title="First page">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="1" y1="1" x2="1" y2="10"/><polyline points="10,1 4,5.5 10,10"/>
          </svg>
        </button>
        <button class="grok-page-btn" id="grok-page-prev">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"><polyline points="7,1 3,5 7,9"/></svg>
          Prev
        </button>
        <span id="grok-page-label">1 / 1</span>
        <button class="grok-page-btn" id="grok-page-next">
          Next
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,1 7,5 3,9"/></svg>
        </button>
        <button class="grok-page-btn icon-only" id="grok-page-last" title="Last page">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="10" y1="1" x2="10" y2="10"/><polyline points="1,1 7,5.5 1,10"/>
          </svg>
        </button>
      </div>
    `;
    document.body.appendChild(wrap);

    const noResults = document.createElement('div');
    noResults.id = 'grok-no-results';
    noResults.innerHTML = `<span>🔍</span>No images match your search`;
    document.body.appendChild(noResults);

    const input = document.getElementById('grok-search-input');
    const clearBtn = document.getElementById('grok-search-clear');
    const sortSel = document.getElementById('grok-sort-select');
    const firstBtn = document.getElementById('grok-page-first');
    const prevBtn = document.getElementById('grok-page-prev');
    const nextBtn = document.getElementById('grok-page-next');
    const lastBtn = document.getElementById('grok-page-last');

    input.addEventListener('input', () => {
      currentQuery = input.value.trim();
      currentPage = 0;
      clearBtn.classList.toggle('visible', currentQuery.length > 0);
      document.getElementById('grok-no-results').classList.remove('visible');
      applyFilter();
    });

    clearBtn.addEventListener('click', () => {
      input.value = ''; currentQuery = ''; currentPage = 0;
      clearBtn.classList.remove('visible');
      applyFilter(); input.focus();
    });

    sortSel.addEventListener('change', () => {
      currentSort = sortSel.value; currentPage = 0;
      applyFilter();
    });

    firstBtn.addEventListener('click', () => { currentPage = 0; showResults(); });
    prevBtn.addEventListener('click', () => { currentPage--; showResults(); });
    nextBtn.addEventListener('click', () => { currentPage++; showResults(); });
    lastBtn.addEventListener('click', () => {
      currentPage = Math.max(0, Math.ceil(matchedPosts.length / PAGE_SIZE) - 1);
      showResults();
    });

    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); input.focus(); input.select(); }
      if (e.key === 'Escape' && document.activeElement === input) input.blur();
      if (currentQuery && document.activeElement !== input) {
        if (e.key === 'ArrowRight') { e.preventDefault(); currentPage++; showResults(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); currentPage--; showResults(); }
      }
    });
  }

  let initiated = false;
  function init() {
    if (!location.href.includes('/imagine')) return;
    if (initiated) return;
    initiated = true;
    injectStyles();
    buildSearchBar();
    setTimeout(loadAllPosts, 1000);
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 800);
    }
  }).observe(document.body, { childList: true, subtree: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();