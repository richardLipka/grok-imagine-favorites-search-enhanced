// ==UserScript==
// @name         Grok Imagine Post Sidebar (prompt + tags)
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  Sidebar on /imagine/post/{id}: prompt from GrokSearch IndexedDB, Grok tags (folders) with create/add/remove via grok.com API.
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
  const API = {
    POST_GET: 'https://grok.com/rest/media/post/get',
    FOLDER_LIST: 'https://grok.com/rest/media/folder/list',
    POST_LIST: 'https://grok.com/rest/media/post/list',
  };
  const ENDPOINT_CACHE_KEY = 'grokPostSidebarApiCache';

  let postId = null;
  let db = null;
  let allFolders = [];
  let postFolderIds = [];
  let remotePost = null;
  let busy = false;
  let lastLoadedPostId = null;
  let refreshSeq = 0;
  let refreshDebounce = null;
  let watchersInstalled = false;
  let urlPollTimer = null;
  let activePostCache = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const REFRESH_DEBOUNCE_MS = 280;
  const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const POST_ID_RE = /\/imagine\/post\/([0-9a-f-]{36})/i;

  function getPostIdFromUrl() {
    const m = location.href.match(POST_ID_RE);
    return m ? m[1] : null;
  }

  function getPostIdFromHistoryState() {
    const st = history.state;
    if (!st || typeof st !== 'object') return null;
    const raw = st.postId ?? st.id ?? st.mediaPostId ?? st.post?.id;
    if (!raw) return null;
    const s = String(raw);
    return UUID_RE.test(s) ? s.match(UUID_RE)[1] : null;
  }

  function extractPostIdFromHref(href) {
    if (!href) return null;
    const m = String(href).match(POST_ID_RE);
    return m ? m[1] : null;
  }

  function getPostIdFromDom() {
    const root = document.querySelector('main') || document.body;

    const selectedSelectors = [
      'a[aria-selected="true"][href*="/imagine/post/"]',
      'a[aria-current="page"][href*="/imagine/post/"]',
      '[data-state="active"] a[href*="/imagine/post/"]',
      '[data-active="true"] a[href*="/imagine/post/"]',
      '[data-selected="true"] a[href*="/imagine/post/"]',
    ];
    for (const sel of selectedSelectors) {
      const el = root.querySelector(sel);
      const id = extractPostIdFromHref(el?.href || el?.getAttribute?.('href'));
      if (id) return id;
    }

    const thumbs = root.querySelectorAll('a[href*="/imagine/post/"]');
    for (const a of thumbs) {
      const hop = [a, a.parentElement, a.parentElement?.parentElement].filter(Boolean);
      for (const el of hop) {
        const cls = `${el.className || ''}`;
        if (/ring-2|ring-primary|border-2|border-white|outline-white|selected|active|current/i.test(cls)) {
          const id = extractPostIdFromHref(a.href);
          if (id) return id;
        }
        if (el.getAttribute?.('aria-selected') === 'true' || el.getAttribute?.('data-state') === 'active') {
          const id = extractPostIdFromHref(a.href);
          if (id) return id;
        }
      }
    }

    const media = root.querySelector('video[src], img[src*="grok"], img[src*="x.ai"]');
    if (media) {
      let el = media;
      for (let i = 0; i < 10 && el; i++) {
        for (const attr of ['data-post-id', 'data-id', 'data-media-post-id']) {
          const v = el.getAttribute?.(attr);
          if (v && UUID_RE.test(v)) return v.match(UUID_RE)[1];
        }
        el = el.parentElement;
      }
    }

    return null;
  }

  function getActivePostId() {
    const urlId = getPostIdFromUrl();
    const domId = getPostIdFromDom();
    const stateId = getPostIdFromHistoryState();
    const cacheId = activePostCache?.id ? String(activePostCache.id) : null;

    if (domId && urlId && domId !== urlId) return domId;
    if (domId) return domId;
    if (cacheId && urlId && cacheId !== urlId) return cacheId;
    if (stateId && stateId !== urlId) return stateId;
    return cacheId || stateId || urlId;
  }

  function clearTagsForPostSwitch(nextId) {
    postId = nextId;
    activePostCache = null;
    remotePost = null;
    postFolderIds = [];
    const idEl = document.getElementById('grok-post-sidebar-post-id');
    if (idEl) idEl.textContent = nextId;
    setStatus('Loading…');
    renderTags();
  }

  function applyActivePostFromApi(post) {
    if (!post?.id) return;
    const id = String(post.id);
    const changed = id !== lastLoadedPostId;
    activePostCache = post;
    postId = id;
    if (changed) clearTagsForPostSwitch(id);
    scheduleRefresh(false);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg, isError) {
    const el = document.getElementById('grok-post-sidebar-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error', Boolean(isError));
  }

  // ─── IndexedDB (shared with grokSearch.js) ─────────────────────────────────
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

  // ─── Grok API ──────────────────────────────────────────────────────────────
  function grokRequest(url, body) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body ?? {}),
        withCredentials: true,
        onload: res => {
          let data = null;
          try { data = JSON.parse(res.responseText); } catch { /* ignore */ }
          resolve({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            data,
            text: res.responseText,
          });
        },
        onerror: () => resolve({ ok: false, status: 0, data: null, text: '' }),
      });
    });
  }

  function loadEndpointCache() {
    try {
      return JSON.parse(sessionStorage.getItem(ENDPOINT_CACHE_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function saveEndpointCache(key, url) {
    const cache = loadEndpointCache();
    cache[key] = url;
    try { sessionStorage.setItem(ENDPOINT_CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  }

  function parseFolders(data) {
    const raw = data?.folders ?? data?.tags ?? data?.items ?? data?.data ?? [];
    if (!Array.isArray(raw)) return [];
    return raw.map(f => ({
      id: String(f.id ?? f.folderId ?? ''),
      name: String(f.name ?? f.label ?? f.title ?? 'Untitled').trim(),
    })).filter(f => f.id);
  }

  function parsePostObject(data) {
    if (!data) return null;
    return data.post ?? data.mediaPost ?? data.item ?? data;
  }

  function parsePostFolderIds(post) {
    if (!post) return [];
    const ids = new Set();
    const add = v => { if (v) ids.add(String(v)); };
    if (Array.isArray(post.folderIds)) post.folderIds.forEach(add);
    if (Array.isArray(post.tagIds)) post.tagIds.forEach(add);
    if (post.folderId) add(post.folderId);
    if (post.tagId) add(post.tagId);
    const lists = [post.folders, post.tags, post.folderList, post.tagList];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === 'string') add(item);
        else add(item?.id ?? item?.folderId ?? item?.tagId);
      }
    }
    return [...ids];
  }

  function getPromptText(post, cached) {
    const p = post?.prompt || post?.originalPrompt || cached?.prompt || '';
    return String(p).trim();
  }

  async function fetchRemotePost(id) {
    const res = await grokRequest(API.POST_GET, { id });
    if (!res.ok) return null;
    return parsePostObject(res.data);
  }

  async function fetchAllFolders() {
    const res = await grokRequest(API.FOLDER_LIST, {});
    if (!res.ok) {
      console.warn('[GrokPostSidebar] folder/list failed', res.status, res.text?.slice?.(0, 200));
      return [];
    }
    return parseFolders(res.data);
  }

  async function findPostFoldersByScan(id, folders) {
    const found = [];
    const max = Math.min(folders.length, 80);
    for (let i = 0; i < max; i++) {
      const folder = folders[i];
      setStatus(`Checking tags… ${i + 1}/${max}`);
      const res = await grokRequest(API.POST_LIST, {
        limit: 40,
        filter: {
          source: 'MEDIA_POST_SOURCE_LIKED',
          folderId: folder.id,
          safeForWork: false,
        },
      });
      if (!res.ok) continue;
      const posts = res.data?.posts ?? res.data?.mediaPosts ?? res.data?.items ?? [];
      if (posts.some(p => String(p.id) === id)) found.push(folder.id);
      await sleep(80);
    }
    return found;
  }

  async function tryMutation(candidates, cacheKey) {
    const cache = loadEndpointCache();
    if (cache[cacheKey]) {
      const hit = candidates.find(c => c.url === cache[cacheKey]);
      if (hit) {
        for (const body of hit.bodies) {
          const res = await grokRequest(hit.url, body);
          if (res.ok) return res;
        }
      }
    }
    for (const cand of candidates) {
      for (const body of cand.bodies) {
        const res = await grokRequest(cand.url, body);
        if (res.ok) {
          saveEndpointCache(cacheKey, cand.url);
          console.log('[GrokPostSidebar] mutation ok', cacheKey, cand.url, body);
          return res;
        }
      }
    }
    return null;
  }

  function buildCreateCandidates(name) {
    return [
      { url: 'https://grok.com/rest/media/folder/create', bodies: [{ name }, { folder: { name } }] },
      { url: 'https://grok.com/rest/media/folder/save', bodies: [{ name }, { folder: { name } }] },
      { url: 'https://grok.com/rest/media/tag/create', bodies: [{ name }, { tag: { name } }] },
    ];
  }

  function buildAddCandidates(folderId, id, folderIds) {
    const nextIds = [...new Set([...folderIds, folderId])];
    return [
      { url: 'https://grok.com/rest/media/folder/add', bodies: [{ folderId, postId: id }, { folderId, id }] },
      { url: 'https://grok.com/rest/media/folder/add_post', bodies: [{ folderId, postId: id }, { folderId, id }] },
      { url: 'https://grok.com/rest/media/post/add_to_folder', bodies: [{ folderId, postId: id }, { folderId, id }] },
      { url: 'https://grok.com/rest/media/post/move_to_folder', bodies: [{ folderId, postId: id }, { folderId, id }] },
      { url: 'https://grok.com/rest/media/post/update', bodies: [{ id, folderIds: nextIds }, { id, folderId }] },
      { url: 'https://grok.com/rest/media/tag/add', bodies: [{ folderId, postId: id }, { tagId: folderId, postId: id }] },
    ];
  }

  function buildRemoveCandidates(folderId, id, folderIds) {
    const nextIds = folderIds.filter(f => f !== folderId);
    return [
      { url: 'https://grok.com/rest/media/folder/remove', bodies: [{ folderId, postId: id }, { folderId, id }] },
      { url: 'https://grok.com/rest/media/folder/remove_post', bodies: [{ folderId, postId: id }, { folderId, id }] },
      { url: 'https://grok.com/rest/media/post/remove_from_folder', bodies: [{ folderId, postId: id }, { folderId, id }] },
      { url: 'https://grok.com/rest/media/post/update', bodies: [{ id, folderIds: nextIds }] },
      { url: 'https://grok.com/rest/media/tag/remove', bodies: [{ folderId, postId: id }, { tagId: folderId, postId: id }] },
    ];
  }

  function parseCreatedFolderId(data) {
    const f = data?.folder ?? data?.tag ?? data;
    return String(f?.id ?? f?.folderId ?? data?.id ?? data?.folderId ?? '');
  }

  async function createFolder(name) {
    const res = await tryMutation(buildCreateCandidates(name), 'folderCreate');
    if (!res) throw new Error('Could not create tag (folder API)');
    const id = parseCreatedFolderId(res.data);
    if (!id) throw new Error('Create succeeded but no folder id returned');
    return { id, name };
  }

  async function addPostToFolder(folderId) {
    const res = await tryMutation(
      buildAddCandidates(folderId, postId, postFolderIds),
      'folderAdd'
    );
    if (!res) throw new Error('Could not add tag to post');
    if (!postFolderIds.includes(folderId)) postFolderIds.push(folderId);
  }

  async function removePostFromFolder(folderId) {
    const res = await tryMutation(
      buildRemoveCandidates(folderId, postId, postFolderIds),
      'folderRemove'
    );
    if (!res) throw new Error('Could not remove tag from post');
    postFolderIds = postFolderIds.filter(f => f !== folderId);
  }

  function handlePostGetResponse(url, responseText) {
    if (!url?.includes('/rest/media/post/get')) return;
    try {
      const data = JSON.parse(responseText);
      const post = parsePostObject(data);
      if (post?.id) applyActivePostFromApi(post);
    } catch { /* ignore */ }
  }

  // ─── Sniff native Grok API (tags + post/get for active image) ─────────────
  function installNetworkSniffer() {
    if (window.__grokPostSidebarSniffer) return;
    window.__grokPostSidebarSniffer = true;

    const noteTagRequest = (url, bodyStr) => {
      if (!url || !url.includes('/rest/media/')) return;
      if (!/folder|tag/i.test(url)) return;
      if (/create|save/i.test(url)) saveEndpointCache('folderCreate', url.split('?')[0]);
      if (/add/i.test(url)) saveEndpointCache('folderAdd', url.split('?')[0]);
      if (/remove|delete/i.test(url) && /folder|tag/i.test(url)) saveEndpointCache('folderRemove', url.split('?')[0]);
    };

    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      noteTagRequest(url, init?.body);
      const res = await origFetch.apply(this, arguments);
      if (url?.includes('/rest/media/post/get')) {
        try {
          const clone = res.clone();
          const text = await clone.text();
          handlePostGetResponse(url, text);
        } catch { /* ignore */ }
      }
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__grokSidebarUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const reqUrl = this.__grokSidebarUrl;
      noteTagRequest(reqUrl, body);
      this.addEventListener('load', function () {
        if (reqUrl?.includes('/rest/media/post/get') && this.responseText) {
          handlePostGetResponse(reqUrl, this.responseText);
        }
      });
      return origSend.apply(this, arguments);
    };
  }

  // ─── Sidebar UI ────────────────────────────────────────────────────────────
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
      .grok-post-sidebar-section {
        margin-bottom: 18px;
      }
      .grok-post-sidebar-section h3 {
        margin: 0 0 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.45);
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
        max-height: 240px;
        overflow-y: auto;
      }
      #grok-post-sidebar-prompt.empty {
        color: rgba(255, 255, 255, 0.35);
        font-style: italic;
      }
      #grok-post-sidebar-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 28px;
      }
      .grok-post-tag-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px 4px 10px;
        border-radius: 999px;
        background: rgba(139, 92, 246, 0.22);
        border: 1px solid rgba(139, 92, 246, 0.45);
        font-size: 11px;
        color: #e9d5ff;
      }
      .grok-post-tag-chip button {
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.65);
        cursor: pointer;
        padding: 0 2px;
        font-size: 14px;
        line-height: 1;
      }
      .grok-post-tag-chip button:hover { color: #fff; }
      .grok-post-tag-chip button:disabled { opacity: 0.35; cursor: default; }
      #grok-post-sidebar-tag-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #grok-post-sidebar-tag-input {
        width: 100%;
        box-sizing: border-box;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        color: #fff;
        font-size: 12px;
        padding: 8px 10px;
        outline: none;
      }
      #grok-post-sidebar-tag-input:focus {
        border-color: rgba(139, 92, 246, 0.6);
      }
      .grok-post-sidebar-btn-row {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .grok-post-sidebar-btn {
        flex: 1;
        min-width: 0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.85);
        font-size: 11px;
        padding: 7px 10px;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .grok-post-sidebar-btn:hover:not(:disabled) {
        border-color: rgba(139, 92, 246, 0.5);
        background: rgba(139, 92, 246, 0.18);
      }
      .grok-post-sidebar-btn.primary {
        background: rgba(139, 92, 246, 0.35);
        border-color: rgba(139, 92, 246, 0.55);
      }
      .grok-post-sidebar-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }
      #grok-post-sidebar-add-existing {
        width: 100%;
        box-sizing: border-box;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.85);
        font-size: 11px;
        padding: 7px 8px;
      }
      #grok-post-sidebar-status {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.4);
        min-height: 1.2em;
        margin-top: 4px;
      }
      #grok-post-sidebar-status.error { color: #fca5a5; }
      #grok-post-sidebar-refresh {
        margin-top: 8px;
        width: 100%;
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
        <p id="grok-post-sidebar-post-id"></p>
      </div>
      <div id="grok-post-sidebar-body">
        <section class="grok-post-sidebar-section">
          <h3>Prompt</h3>
          <div id="grok-post-sidebar-prompt" class="empty">Loading…</div>
        </section>
        <section class="grok-post-sidebar-section">
          <h3>Tags</h3>
          <div id="grok-post-sidebar-tags"></div>
          <div id="grok-post-sidebar-tag-form">
            <input type="text" id="grok-post-sidebar-tag-input" placeholder="New or existing tag name…" autocomplete="off" spellcheck="false" />
            <div class="grok-post-sidebar-btn-row">
              <button type="button" class="grok-post-sidebar-btn primary" id="grok-post-sidebar-create-add">Create &amp; add</button>
              <button type="button" class="grok-post-sidebar-btn" id="grok-post-sidebar-add-existing-btn">Add selected</button>
            </div>
            <select id="grok-post-sidebar-add-existing" aria-label="Add existing tag">
              <option value="">Add existing tag…</option>
            </select>
            <button type="button" class="grok-post-sidebar-btn" id="grok-post-sidebar-refresh">Refresh</button>
          </div>
          <div id="grok-post-sidebar-status"></div>
        </section>
      </div>
    `;
    document.body.appendChild(aside);

    document.getElementById('grok-post-sidebar-create-add').addEventListener('click', onCreateAndAdd);
    document.getElementById('grok-post-sidebar-add-existing-btn').addEventListener('click', onAddExisting);
    document.getElementById('grok-post-sidebar-add-existing').addEventListener('change', onAddExistingSelect);
    document.getElementById('grok-post-sidebar-refresh').addEventListener('click', () => refreshAll(true));
    document.getElementById('grok-post-sidebar-tag-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') onCreateAndAdd();
    });
  }

  function folderNameById(id) {
    const f = allFolders.find(x => x.id === id);
    return f?.name || id.slice(0, 8);
  }

  function renderTags() {
    const wrap = document.getElementById('grok-post-sidebar-tags');
    const select = document.getElementById('grok-post-sidebar-add-existing');
    if (!wrap || !select) return;

    if (!postFolderIds.length) {
      wrap.innerHTML = '<span style="font-size:11px;color:rgba(255,255,255,0.35)">No tags on this post</span>';
    } else {
      wrap.innerHTML = postFolderIds.map(fid => `
        <span class="grok-post-tag-chip" data-folder-id="${escapeHtml(fid)}">
          ${escapeHtml(folderNameById(fid))}
          <button type="button" title="Remove tag" aria-label="Remove tag" ${busy ? 'disabled' : ''}>×</button>
        </span>
      `).join('');
      wrap.querySelectorAll('.grok-post-tag-chip button').forEach(btn => {
        btn.addEventListener('click', async () => {
          const chip = btn.closest('.grok-post-tag-chip');
          const fid = chip?.dataset?.folderId;
          if (!fid || busy) return;
          await runBusy(async () => {
            setStatus('Removing tag…');
            await removePostFromFolder(fid);
            setStatus('Tag removed');
            renderTags();
            populateAddSelect();
          });
        });
      });
    }

    populateAddSelect();
  }

  function populateAddSelect() {
    const select = document.getElementById('grok-post-sidebar-add-existing');
    if (!select) return;
    const available = allFolders.filter(f => !postFolderIds.includes(f.id));
    select.innerHTML = '<option value="">Add existing tag…</option>' +
      available.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join('');
  }

  function renderPrompt(text, fromDb) {
    const el = document.getElementById('grok-post-sidebar-prompt');
    if (!el) return;
    if (!text) {
      el.textContent = 'No prompt in index or API for this post.';
      el.classList.add('empty');
      return;
    }
    el.textContent = text;
    el.classList.remove('empty');
    if (fromDb) el.title = 'From GrokSearch IndexedDB';
    else el.title = 'From Grok API';
  }

  async function runBusy(fn) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('.grok-post-sidebar-btn, .grok-post-tag-chip button').forEach(b => { b.disabled = true; });
    try {
      await fn();
    } catch (e) {
      console.error('[GrokPostSidebar]', e);
      setStatus(e.message || String(e), true);
    } finally {
      busy = false;
      document.querySelectorAll('.grok-post-sidebar-btn').forEach(b => { b.disabled = false; });
      renderTags();
    }
  }

  async function onCreateAndAdd() {
    const input = document.getElementById('grok-post-sidebar-tag-input');
    const name = (input?.value || '').trim();
    if (!name) {
      setStatus('Enter a tag name', true);
      return;
    }
    await runBusy(async () => {
      const existing = allFolders.find(f => f.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        setStatus('Adding existing tag…');
        await addPostToFolder(existing.id);
        if (input) input.value = '';
        setStatus(`Added “${existing.name}”`);
        return;
      }
      setStatus('Creating tag on Grok…');
      const created = await createFolder(name);
      allFolders.push(created);
      allFolders.sort((a, b) => a.name.localeCompare(b.name));
      setStatus('Adding to post…');
      await addPostToFolder(created.id);
      if (input) input.value = '';
      setStatus(`Created and added “${created.name}”`);
    });
  }

  async function onAddExisting() {
    const select = document.getElementById('grok-post-sidebar-add-existing');
    const folderId = select?.value;
    if (!folderId) {
      setStatus('Pick a tag from the list', true);
      return;
    }
    await runBusy(async () => {
      setStatus('Adding tag…');
      await addPostToFolder(folderId);
      if (select) select.value = '';
      setStatus('Tag added');
    });
  }

  function onAddExistingSelect() {
    const select = document.getElementById('grok-post-sidebar-add-existing');
    if (select?.value) onAddExisting();
  }

  function isStaleRefresh(seq) {
    return seq !== refreshSeq || getActivePostId() !== postId;
  }

  function notePossiblePostSwitch() {
    const domId = getPostIdFromDom();
    const urlId = getPostIdFromUrl();
    const id = domId || (activePostCache?.id && String(activePostCache.id) !== urlId ? String(activePostCache.id) : null) || urlId;
    if (!id || id === lastLoadedPostId) return;
    if (activePostCache && String(activePostCache.id) !== id) activePostCache = null;
    clearTagsForPostSwitch(id);
  }

  function scheduleRefresh(forceRemote) {
    notePossiblePostSwitch();
    clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => {
      refreshDebounce = null;
      if (busy) {
        scheduleRefresh(forceRemote);
        return;
      }
      onPostContextChange(forceRemote);
    }, REFRESH_DEBOUNCE_MS);
  }

  function onPostContextChange(forceRemote) {
    const id = getActivePostId();
    if (!id) {
      document.getElementById('grok-post-sidebar')?.remove();
      lastLoadedPostId = null;
      postId = null;
      remotePost = null;
      postFolderIds = [];
      activePostCache = null;
      return;
    }
    if (!document.getElementById('grok-post-sidebar')) {
      injectStyles();
      installNetworkSniffer();
      buildSidebar();
    }
    const postChanged = id !== lastLoadedPostId;
    if (postChanged) clearTagsForPostSwitch(id);
    refreshAll(Boolean(forceRemote || postChanged));
  }

  async function refreshAll(forceRemote) {
    postId = getActivePostId();
    if (!postId) return;

    const seq = ++refreshSeq;
    const postChanged = postId !== lastLoadedPostId;
    if (postChanged) {
      activePostCache = null;
      remotePost = null;
      postFolderIds = [];
      forceRemote = true;
      renderTags();
    }

    const idEl = document.getElementById('grok-post-sidebar-post-id');
    if (idEl) idEl.textContent = postId;

    setStatus('Loading…');

    let cached = null;
    try {
      if (!db) db = await openDB();
      cached = await dbGetPost(postId);
    } catch (e) {
      console.warn('[GrokPostSidebar] IndexedDB:', e);
    }
    if (isStaleRefresh(seq)) return;

    if (activePostCache && String(activePostCache.id) === postId) {
      remotePost = activePostCache;
    } else if (forceRemote || !remotePost || String(remotePost.id) !== postId) {
      remotePost = await fetchRemotePost(postId);
      if (remotePost?.id) activePostCache = remotePost;
    }
    if (isStaleRefresh(seq)) return;

    const prompt = getPromptText(remotePost, cached);
    renderPrompt(prompt, Boolean(cached?.prompt && !remotePost?.prompt));
    if (isStaleRefresh(seq)) return;

    allFolders = await fetchAllFolders();
    if (isStaleRefresh(seq)) return;

    postFolderIds = parsePostFolderIds(remotePost);

    if (!postFolderIds.length && allFolders.length) {
      setStatus('Resolving tags…');
      postFolderIds = await findPostFoldersByScan(postId, allFolders);
      if (isStaleRefresh(seq)) return;
      setStatus('');
    }

    lastLoadedPostId = postId;
    renderTags();
    if (!allFolders.length) {
      setStatus('No tags on account yet — create one above.');
    } else if (!postFolderIds.length) {
      setStatus('');
    }
  }

  function hookHistoryNavigation() {
    if (window.__grokPostSidebarHistoryHook) return;
    window.__grokPostSidebarHistoryHook = true;
    const wrap = fn => function (...args) {
      const result = fn.apply(this, args);
      scheduleRefresh(true);
      return result;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => scheduleRefresh(true));
  }

  function watchDomAndMedia() {
    if (window.__grokPostSidebarDomWatch) return;
    window.__grokPostSidebarDomWatch = true;

    const root = document.querySelector('main') || document.body;
    const mo = new MutationObserver(() => scheduleRefresh(true));
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data-id', 'data-post-id', 'aria-selected', 'aria-current', 'data-state', 'class'],
    });

    const onMediaReady = () => scheduleRefresh(true);

    document.addEventListener('load', e => {
      const t = e.target;
      if (!t || (t.tagName !== 'IMG' && t.tagName !== 'VIDEO')) return;
      if (!root.contains(t)) return;
      onMediaReady();
    }, true);

    document.addEventListener('loadeddata', e => {
      const t = e.target;
      if (t?.tagName === 'VIDEO' && root.contains(t)) onMediaReady();
    }, true);
  }

  function startUrlPolling() {
    if (urlPollTimer) return;
    urlPollTimer = setInterval(() => {
      const id = getActivePostId();
      if (!id) {
        if (document.getElementById('grok-post-sidebar')) onPostContextChange(false);
        return;
      }
      if (id !== lastLoadedPostId) scheduleRefresh(true);
    }, 400);
  }

  function installWatchers() {
    if (watchersInstalled) return;
    watchersInstalled = true;
    hookHistoryNavigation();
    watchDomAndMedia();
    startUrlPolling();
    new MutationObserver(() => scheduleRefresh(true)).observe(document.body, {
      childList: true,
      subtree: false,
    });
  }

  function init() {
    if (!getPostIdFromUrl() && !getPostIdFromDom()) return;
    injectStyles();
    installNetworkSniffer();
    buildSidebar();
    installWatchers();
    lastLoadedPostId = null;
    scheduleRefresh(true);
    setTimeout(() => scheduleRefresh(true), 900);
    setTimeout(() => scheduleRefresh(true), 2200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();