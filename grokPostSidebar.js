// ==UserScript==
// @name         Grok Imagine Post Sidebar (prompt)
// @namespace    http://tampermonkey.net/
// @version      1.3.1
// @description  Collapsible sidebar on /imagine/post/{id}: metadata and prompt from IndexedDB and Grok API.
// @author       Richard Lipka
// @homepage     https://github.com/richardLipka/grok-imagine-favorites-search-enhanced
// @supportURL   https://github.com/richardLipka/grok-imagine-favorites-search-enhanced/issues
// @updateURL    https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokPostSidebar.js
// @downloadURL  https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokPostSidebar.js
// @match        https://grok.com/imagine/post/*
// @grant        GM_xmlhttpRequest
// @connect      grok.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DB_NAME = 'GrokSearchIndex';
  const DB_VERSION = 1;
  const STORE_NAME = 'posts';
  const POST_GET = 'https://grok.com/rest/media/post/get';
  const POST_ID_RE = /\/imagine\/post\/([0-9a-f-]{36})/i;
  const COLLAPSED_KEY = 'grokPostSidebarCollapsed';

  let db = null;
  let sidebarExpanded = true;
  let lastLoadedPostId = null;
  let refreshSeq = 0;
  let refreshTimer = null;

  function getPostIdFromUrl() {
    const m = location.href.match(POST_ID_RE);
    return m ? m[1] : null;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isVideoMediaType(mediaType) {
    const t = String(mediaType || '');
    return t === 'MEDIA_POST_TYPE_VIDEO' || t.includes('VIDEO');
  }

  function extractChildMediaCounts(post) {
    const children = post?.childPosts || [];
    let childImageCount = 0;
    let childVideoCount = 0;
    for (const child of children) {
      if (isVideoMediaType(child.mediaType)) childVideoCount++;
      else childImageCount++;
    }
    const parentIsVideo = isVideoMediaType(post?.mediaType);
    const videoCount = (parentIsVideo ? 1 : 0) + childVideoCount;
    return {
      childPostCount: children.length,
      childImageCount,
      childVideoCount,
      videoCount,
    };
  }

  function mergePostData(cached, remote) {
    const r = remote || {};
    const c = cached || {};
    const fromChildren = remote ? extractChildMediaCounts(remote) : null;
    const childPostCount = fromChildren?.childPostCount ?? c.childPostCount;
    const hasChildFields = childPostCount != null;

    return {
      id: String(r.id || c.id || getPostIdFromUrl() || ''),
      prompt: String(r.prompt || r.originalPrompt || c.prompt || '').trim(),
      createTime: r.createTime || r.createdAt || r.create_time || c.createTime || '',
      model: r.modelName || r.model || r.modelId || '',
      mediaType: r.mediaType || '',
      mediaUrl: r.mediaUrl || r.hdMediaUrl || c.mediaUrl || '',
      thumbnail: r.thumbnailImageUrl || r.thumbnail || c.thumbnail || '',
      childPostCount: hasChildFields ? (childPostCount ?? 0) : null,
      childImageCount: fromChildren?.childImageCount ?? c.childImageCount ?? null,
      childVideoCount: fromChildren?.childVideoCount ?? c.childVideoCount ?? null,
      videoCount: fromChildren?.videoCount ?? c.videoCount ?? null,
      fromIndex: Boolean(c.id),
      fromApi: Boolean(r.id),
    };
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatMediaType(mediaType) {
    if (!mediaType) return '';
    if (isVideoMediaType(mediaType)) return 'Video';
    if (String(mediaType).includes('IMAGE')) return 'Image';
    return String(mediaType).replace(/^MEDIA_POST_TYPE_/i, '').replace(/_/g, ' ').toLowerCase()
      || mediaType;
  }

  function formatDataSource(meta) {
    if (meta.fromIndex && meta.fromApi) return 'Index + API';
    if (meta.fromIndex) return 'Index';
    if (meta.fromApi) return 'API';
    return '';
  }

  function formatCount(n) {
    return n == null ? '' : String(n);
  }

  function buildMetadataRows(meta) {
    const rows = [];
    const push = (label, value, extra = {}) => {
      const v = value == null ? '' : String(value).trim();
      if (!v && !extra.showZero) return;
      rows.push({ label, value: v || '0', ...extra });
    };

    push('Post ID', meta.id, { mono: true, copyValue: meta.id });
    push('Date', formatDate(meta.createTime));
    push('Model', meta.model);
    push('Type', formatMediaType(meta.mediaType));
    if (meta.childPostCount != null) {
      push('Child posts', formatCount(meta.childPostCount), { showZero: true });
      push('Child images', formatCount(meta.childImageCount), { showZero: true });
      push('Child videos', formatCount(meta.childVideoCount), { showZero: true });
      push('Videos total', formatCount(meta.videoCount), { showZero: true });
    }
    push('Data', formatDataSource(meta));

    return rows;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbGetPost(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function fetchRemotePost(id) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: POST_GET,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ id }),
        withCredentials: true,
        onload: res => {
          if (res.status < 200 || res.status >= 300) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            resolve(data?.post ?? data?.mediaPost ?? data?.item ?? data);
          } catch {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
      });
    });
  }

  function injectStyles() {
    if (document.getElementById('grok-post-sidebar-styles')) return;
    const s = document.createElement('style');
    s.id = 'grok-post-sidebar-styles';
    s.textContent = `
      #grok-post-sidebar {
        position: fixed;
        top: 0;
        right: 0;
        width: min(320px, 92vw);
        height: 100vh;
        z-index: 99995;
        display: flex;
        flex-direction: column;
        background: rgba(12, 12, 18, 0.97);
        border-left: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(14px);
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        color: rgba(255, 255, 255, 0.88);
        box-sizing: border-box;
        pointer-events: auto;
        transition: transform 0.28s ease, opacity 0.22s ease, visibility 0.28s;
      }
      #grok-post-sidebar.collapsed {
        transform: translateX(100%);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
      }
      #grok-post-sidebar-toggle {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 99996;
        width: 44px;
        height: 44px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(12, 12, 18, 0.94);
        color: rgba(255, 255, 255, 0.9);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(12px);
        transition: background 0.15s, border-color 0.15s, transform 0.15s;
        padding: 0;
      }
      #grok-post-sidebar-toggle:hover {
        border-color: rgba(139, 92, 246, 0.55);
        background: rgba(139, 92, 246, 0.22);
        color: #fff;
      }
      #grok-post-sidebar-toggle svg {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }
      #grok-post-sidebar-header {
        padding: 14px 16px 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        flex-shrink: 0;
      }
      #grok-post-sidebar-header h2 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.92);
      }
      #grok-post-sidebar-body {
        flex: 1;
        overflow-y: auto;
        padding: 14px 16px 20px;
        -webkit-overflow-scrolling: touch;
      }
      .grok-post-sidebar-section {
        margin-bottom: 16px;
      }
      .grok-post-sidebar-section h3 {
        margin: 0 0 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.45);
      }
      .grok-post-meta-list {
        margin: 0;
        display: grid;
        grid-template-columns: minmax(72px, 38%) 1fr;
        gap: 6px 10px;
        font-size: 11px;
      }
      .grok-post-meta-list dt {
        margin: 0;
        color: rgba(255, 255, 255, 0.45);
        font-weight: 500;
      }
      .grok-post-meta-list dd {
        margin: 0;
        color: rgba(255, 255, 255, 0.88);
        word-break: break-word;
      }
      .grok-post-meta-list dd.mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10px;
        line-height: 1.4;
      }
      .grok-post-meta-copy {
        margin-left: 6px;
        padding: 1px 6px;
        font-size: 10px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.7);
        cursor: pointer;
        vertical-align: baseline;
      }
      .grok-post-meta-copy:hover {
        border-color: rgba(139, 92, 246, 0.5);
        color: #fff;
      }
      .grok-post-meta-empty {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.35);
        font-style: italic;
      }
      #grok-post-sidebar-prompt {
        font-size: 12px;
        line-height: 1.55;
        color: rgba(255, 255, 255, 0.82);
        white-space: pre-wrap;
        word-break: break-word;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 10px 12px;
      }
      #grok-post-sidebar-prompt.empty {
        color: rgba(255, 255, 255, 0.35);
        font-style: italic;
      }
    `;
    document.head.appendChild(s);
  }

  function buildSidebar() {
    if (document.getElementById('grok-post-sidebar')) return;
    const aside = document.createElement('aside');
    aside.id = 'grok-post-sidebar';
    aside.innerHTML = `
      <div id="grok-post-sidebar-header">
        <h2>Saved post</h2>
      </div>
      <div id="grok-post-sidebar-body">
        <section class="grok-post-sidebar-section">
          <h3>Metadata</h3>
          <div id="grok-post-sidebar-meta" class="grok-post-meta-empty">Loading…</div>
        </section>
        <section class="grok-post-sidebar-section">
          <h3>Prompt</h3>
          <div id="grok-post-sidebar-prompt" class="empty">Loading…</div>
        </section>
      </div>
    `;
    document.body.appendChild(aside);
    ensureToggleButton();
  }

  function ensureToggleButton() {
    if (document.getElementById('grok-post-sidebar-toggle')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'grok-post-sidebar-toggle';
    btn.setAttribute('aria-label', 'Toggle post info panel');
    btn.addEventListener('click', () => setSidebarExpanded(!sidebarExpanded));
    document.body.appendChild(btn);
    try {
      sidebarExpanded = localStorage.getItem(COLLAPSED_KEY) !== '1';
    } catch {
      sidebarExpanded = true;
    }
    setSidebarExpanded(sidebarExpanded);
  }

  function setSidebarExpanded(expanded) {
    sidebarExpanded = expanded;
    const panel = document.getElementById('grok-post-sidebar');
    const btn = document.getElementById('grok-post-sidebar-toggle');
    if (panel) panel.classList.toggle('collapsed', !expanded);
    if (btn) {
      btn.title = expanded ? 'Hide post info' : 'Show post info';
      btn.setAttribute('aria-expanded', String(expanded));
      btn.innerHTML = expanded
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="15 6 9 12 15 18"/>
           </svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/>
            <path d="M17 8l4 4-4 4"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
           </svg>`;
    }
    try {
      localStorage.setItem(COLLAPSED_KEY, expanded ? '0' : '1');
    } catch { /* ignore */ }
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }

  function renderMetadata(rows) {
    const el = document.getElementById('grok-post-sidebar-meta');
    if (!el) return;
    if (!rows.length) {
      el.className = 'grok-post-meta-empty';
      el.textContent = 'No metadata in index or API. Run Grok Search reindex on the saved list.';
      return;
    }
    el.className = '';
    el.innerHTML = `<dl class="grok-post-meta-list">${rows.map(row => {
      const ddClass = row.mono ? ' class="mono"' : '';
      const copyBtn = row.copyValue
        ? `<button type="button" class="grok-post-meta-copy" data-copy="${escapeHtml(row.copyValue)}" title="Copy">Copy</button>`
        : '';
      return `<dt>${escapeHtml(row.label)}</dt><dd${ddClass}>${escapeHtml(row.value)}${copyBtn}</dd>`;
    }).join('')}</dl>`;
    el.querySelectorAll('.grok-post-meta-copy').forEach(btn => {
      btn.addEventListener('click', () => copyText(btn.dataset.copy));
    });
  }

  function renderPrompt(text, sourceHint) {
    const el = document.getElementById('grok-post-sidebar-prompt');
    if (!el) return;
    if (!text) {
      el.textContent = 'No prompt in index or API for this post.';
      el.classList.add('empty');
      el.title = '';
      return;
    }
    el.textContent = text;
    el.classList.remove('empty');
    el.title = sourceHint || '';
  }

  async function refreshContent() {
    const postId = getPostIdFromUrl();
    if (!postId) {
      document.getElementById('grok-post-sidebar')?.remove();
      document.getElementById('grok-post-sidebar-toggle')?.remove();
      lastLoadedPostId = null;
      return;
    }

    const seq = ++refreshSeq;
    const metaEl = document.getElementById('grok-post-sidebar-meta');
    const promptEl = document.getElementById('grok-post-sidebar-prompt');
    if (postId !== lastLoadedPostId) {
      if (metaEl) {
        metaEl.className = 'grok-post-meta-empty';
        metaEl.textContent = 'Loading…';
      }
      if (promptEl) {
        promptEl.textContent = 'Loading…';
        promptEl.classList.add('empty');
      }
    }

    let cached = null;
    try {
      if (!db) db = await openDB();
      cached = await dbGetPost(postId);
    } catch (e) {
      console.warn('[GrokPostSidebar] IndexedDB:', e);
    }
    if (seq !== refreshSeq || getPostIdFromUrl() !== postId) return;

    const remote = await fetchRemotePost(postId);
    if (seq !== refreshSeq || getPostIdFromUrl() !== postId) return;

    const meta = mergePostData(cached, remote);
    renderMetadata(buildMetadataRows(meta));

    let promptSource = '';
    if (meta.prompt) {
      if (meta.fromIndex && meta.fromApi) promptSource = 'Index + API';
      else if (meta.fromIndex) promptSource = 'From GrokSearch IndexedDB';
      else promptSource = 'From Grok API';
    }
    renderPrompt(meta.prompt, promptSource);

    lastLoadedPostId = postId;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshContent, 400);
  }

  function hookHistory() {
    if (window.__grokPostSidebarHistoryHook) return;
    window.__grokPostSidebarHistoryHook = true;
    const wrap = fn => function (...args) {
      const r = fn.apply(this, args);
      scheduleRefresh();
      return r;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', scheduleRefresh);
  }

  function init() {
    if (!getPostIdFromUrl()) return;
    injectStyles();
    buildSidebar();
    ensureToggleButton();
    hookHistory();
    refreshContent();
    setInterval(() => {
      const id = getPostIdFromUrl();
      if (id && id !== lastLoadedPostId) scheduleRefresh();
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();