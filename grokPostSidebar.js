// ==UserScript==
// @name         Grok Imagine Post Sidebar (prompt)
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Sidebar on /imagine/post/{id} showing prompt from GrokSearch IndexedDB or Grok API.
// @author       AnnaLynn (with fixes)
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

  let db = null;
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

  function getPromptText(post, cached) {
    return String(post?.prompt || post?.originalPrompt || cached?.prompt || '').trim();
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
      #grok-post-sidebar-post-id {
        margin: 6px 0 0;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
        word-break: break-all;
        font-variant-numeric: tabular-nums;
      }
      #grok-post-sidebar-body {
        flex: 1;
        overflow-y: auto;
        padding: 14px 16px 20px;
        -webkit-overflow-scrolling: touch;
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
        <h2>Prompt</h2>
        <p id="grok-post-sidebar-post-id"></p>
      </div>
      <div id="grok-post-sidebar-body">
        <div id="grok-post-sidebar-prompt" class="empty">Loading…</div>
      </div>
    `;
    document.body.appendChild(aside);
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

  async function refreshPrompt() {
    const postId = getPostIdFromUrl();
    if (!postId) {
      document.getElementById('grok-post-sidebar')?.remove();
      lastLoadedPostId = null;
      return;
    }

    const seq = ++refreshSeq;
    const idEl = document.getElementById('grok-post-sidebar-post-id');
    if (idEl) idEl.textContent = postId;

    const promptEl = document.getElementById('grok-post-sidebar-prompt');
    if (postId !== lastLoadedPostId && promptEl) {
      promptEl.textContent = 'Loading…';
      promptEl.classList.add('empty');
    }

    let cached = null;
    try {
      if (!db) db = await openDB();
      cached = await dbGetPost(postId);
    } catch (e) {
      console.warn('[GrokPostSidebar] IndexedDB:', e);
    }
    if (seq !== refreshSeq || getPostIdFromUrl() !== postId) return;

    let prompt = getPromptText(null, cached);
    let source = cached?.prompt ? 'From GrokSearch IndexedDB' : '';

    if (!prompt) {
      const remote = await fetchRemotePost(postId);
      if (seq !== refreshSeq || getPostIdFromUrl() !== postId) return;
      prompt = getPromptText(remote, null);
      if (prompt) source = 'From Grok API';
    }

    lastLoadedPostId = postId;
    renderPrompt(prompt, source);
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshPrompt, 400);
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
    hookHistory();
    refreshPrompt();
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