// ==UserScript==
// @name         Grok Imagine Post Sidebar (prompt)
// @namespace    http://tampermonkey.net/
// @version      1.6.0
// @description  Collapsible sidebar on /imagine/post/{id}: metadata and prompt from IndexedDB and Grok API.
// @author       Richard Lipka
// @homepage     https://github.com/richardLipka/grok-imagine-favorites-search-enhanced
// @supportURL   https://github.com/richardLipka/grok-imagine-favorites-search-enhanced/issues
// @license      GPL-3.0-only
// @updateURL    https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokPostSidebar.user.js
// @downloadURL  https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokPostSidebar.user.js
// @match        https://grok.com/imagine/post/*
// @grant        GM_xmlhttpRequest
// @connect      grok.com
// @run-at       document-idle
// ==/UserScript==

// Grok Imagine Favorites Search — prompt sidebar for Grok Imagine post pages
// Copyright (C) 2026 Richard Lipka
// Copyright (C) 2026 IronSniper1 — https://github.com/ironsniper1/Grok-imagine-favorite-image-search
//
// This program is free software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License, version 3, as published by the Free Software Foundation.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
// See the GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with this program.
// If not, see <https://www.gnu.org/licenses/>.

(function () {
  'use strict';

  const DB_NAME = 'GrokSearchIndex';
  const STORE_NAME = 'posts';
  const POST_GET = 'https://grok.com/rest/media/post/get';
  const ASSETS_ENDPOINT = 'https://grok.com/rest/assets';
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

  function isUploadedPost(post) {
    if (!post) return false;
    if (post.isUploaded === true) return true;
    if (post.fileSource === 'IMAGINE_SELF_UPLOAD_FILE_SOURCE' ||
        String(post.fileSource || '').toUpperCase().includes('UPLOAD') ||
        String(post.mediaPostSource || '').toUpperCase().includes('UPLOAD') ||
        String(post.source || '').toUpperCase().includes('UPLOAD')) {
      return true;
    }
    const url = String(post.mediaUrl || post.thumbnail || '').toLowerCase();
    return url.includes('/upload/') || url.includes('/uploaded/') || url.includes('/user_upload/');
  }

  function walkDescendantPosts(node, visitor) {
    const children = node?.childPosts || [];
    for (const child of children) {
      visitor(child);
      walkDescendantPosts(child, visitor);
    }
  }

  function extractChildMediaCounts(post) {
    let childPostCount = 0;
    let childImageCount = 0;
    let childVideoCount = 0;
    walkDescendantPosts(post, child => {
      childPostCount++;
      if (isVideoMediaType(child.mediaType)) childVideoCount++;
      else childImageCount++;
    });
    const parentIsVideo = isVideoMediaType(post?.mediaType);
    const videoCount = (parentIsVideo ? 1 : 0) + childVideoCount;
    return {
      childPostCount,
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

    const parentId = r.parentId || c.parentId || null;
    const parentPrompt = r.parentPrompt || c.parentPrompt || c.rootPrompt || null;
    const ownPrompt = String(r.prompt || r.originalPrompt || c.prompt || '').trim();
    const promptInherited = Boolean(r.promptInherited || (!ownPrompt && parentPrompt));
    const effectivePrompt = ownPrompt || parentPrompt || '';

    return {
      id: String(r.id || c.id || getPostIdFromUrl() || ''),
      prompt: effectivePrompt,
      parentPrompt,
      parentId,
      promptInherited,
      createTime: r.createTime || r.createdAt || r.create_time || c.createTime || '',
      model: r.modelName || r.model || r.modelId || c.model || '',
      mediaType: r.mediaType || c.mediaType || '',
      mediaUrl: r.mediaUrl || r.hdMediaUrl || c.mediaUrl || '',
      thumbnail: r.thumbnailImageUrl || r.thumbnail || c.thumbnail || '',
      childPostCount: hasChildFields ? (childPostCount ?? 0) : null,
      childImageCount: fromChildren?.childImageCount ?? c.childImageCount ?? null,
      childVideoCount: fromChildren?.childVideoCount ?? c.childVideoCount ?? null,
      videoCount: fromChildren?.videoCount ?? c.videoCount ?? null,
      isUploaded: Boolean(c.isUploaded || r.isUploaded || isUploadedPost(c) || isUploadedPost(r)),
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
    if (meta.parentId) {
      push('Parent ID', meta.parentId, {
        mono: true,
        copyValue: meta.parentId,
        href: `/imagine/post/${encodeURIComponent(meta.parentId)}`,
      });
    }
    push('Date', formatDate(meta.createTime));
    push('Model', meta.model);
    push('Type', formatMediaType(meta.mediaType));
    if (meta.childPostCount != null) {
      push('Child posts', formatCount(meta.childPostCount), { showZero: true });
      push('Child images', formatCount(meta.childImageCount), { showZero: true });
      push('Child videos', formatCount(meta.childVideoCount), { showZero: true });
      push('Videos total', formatCount(meta.videoCount), { showZero: true });
    }
    if (meta.isUploaded) {
      push('Source', 'User upload');
    }
    push('Data', formatDataSource(meta));

    return rows;
  }

  // Read-only consumer: open without a version and abort onupgradeneeded so visiting a post
  // detail page before grokSearch.user.js never creates an empty v1 database without the store.
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onupgradeneeded = e => {
        try { e.target.transaction.abort(); } catch { /* ignore */ }
      };
      req.onsuccess = e => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.close();
          reject(new Error(`Store "${STORE_NAME}" not found`));
          return;
        }
        database.onversionchange = () => {
          database.close();
          if (db === database) db = null;
        };
        resolve(database);
      };
      req.onerror = e => reject(e.target.error || new Error('IndexedDB unavailable'));
    });
  }

  function dbGetPost(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function fetchRemoteAsset(id) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${ASSETS_ENDPOINT}/${encodeURIComponent(id)}`,
        headers: { Accept: 'application/json' },
        withCredentials: true,
        timeout: 30000,
        onload: res => {
          if (res.status < 200 || res.status >= 300) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            resolve(data?.asset ?? data);
          } catch {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
        onabort: () => resolve(null),
      });
    });
  }

  function assetGenInput(asset) {
    const gen = asset?.mediaGenInput;
    if (!gen || typeof gen !== 'object') return null;
    const KINDS = ['textToImage', 'imageToImage', 'textToVideo', 'imageToVideo', 'referenceToVideo', 'videoExtension'];
    for (const k of KINDS) {
      if (gen[k] && typeof gen[k] === 'object') return gen[k];
    }
    for (const value of Object.values(gen)) {
      if (value && typeof value === 'object' && (value.prompt || value.modelName || value.inputAssets || value.hydratedContext || value.parentPostId)) {
        return value;
      }
    }
    return null;
  }

  function getAssetParentId(asset, gen) {
    if (!gen) gen = assetGenInput(asset);
    const inputAssets = gen?.inputAssets || gen?.input?.inputAssets;
    if (Array.isArray(inputAssets) && inputAssets.length > 0) {
      const first = inputAssets[0];
      const id = typeof first === 'string' ? first : String(first?.assetId || first?.id || '');
      if (id) return id;
    } else if (typeof inputAssets === 'string' && inputAssets) {
      return inputAssets;
    }

    const ctx = gen?.hydratedContext || gen?.input?.hydratedContext || asset?.mediaGenInput?.hydratedContext;
    if (ctx?.parentPostId) return String(ctx.parentPostId);
    if (ctx?.parentAssetId) return String(ctx.parentAssetId);

    if (gen?.parentPostId) return String(gen.parentPostId);
    if (gen?.parentId) return String(gen.parentId);

    if (asset?.auxKeys?.parent_post_id) return String(asset.auxKeys.parent_post_id);
    if (asset?.auxKeys?.parent_asset_id) return String(asset.auxKeys.parent_asset_id);
    if (asset?.auxKeys?.duplicated_from_asset_id && String(asset.auxKeys.imagine_official_asset) !== 'true') {
      return String(asset.auxKeys.duplicated_from_asset_id);
    }
    return null;
  }

  async function fetchRemotePost(id, depth = 0, maxDepth = 3) {
    let remote = await new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: POST_GET,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ id }),
        withCredentials: true,
        timeout: 30000,
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
        ontimeout: () => resolve(null),
        onabort: () => resolve(null),
      });
    });

    const hasPrompt = Boolean(remote?.prompt?.trim());
    if (!hasPrompt) {
      const asset = await fetchRemoteAsset(id);
      if (asset) {
        const gen = assetGenInput(asset);
        const assetParentId = getAssetParentId(asset, gen);
        const ownPrompt = String(gen?.prompt || asset?.summary || '').trim();
        const model = gen?.modelName || '';
        if (remote) {
          remote.prompt = ownPrompt || remote.prompt || '';
          if (model && !remote.model) remote.model = model;
          if (assetParentId && assetParentId !== id && !remote.parentId) remote.parentId = assetParentId;
        } else {
          remote = {
            id,
            prompt: ownPrompt,
            model,
            parentId: assetParentId && assetParentId !== id ? assetParentId : null,
            mediaType: asset?.mimeType?.startsWith('video/') ? 'MEDIA_POST_TYPE_VIDEO' : 'MEDIA_POST_TYPE_IMAGE',
            createTime: String(asset?.createTime || ''),
          };
        }

        // If prompt is still blank and parent exists, resolve from parent
        if (!remote.prompt && remote.parentId && remote.parentId !== id && depth < maxDepth) {
          let parent = null;
          try {
            if (db) parent = await dbGetPost(remote.parentId);
          } catch { /* ignore */ }
          if (parent?.prompt) {
            remote.parentPrompt = parent.prompt;
            remote.prompt = parent.prompt;
            remote.promptInherited = true;
          } else {
            const parentRemote = await fetchRemotePost(remote.parentId, depth + 1, maxDepth);
            if (parentRemote?.prompt) {
              remote.parentPrompt = parentRemote.prompt;
              remote.prompt = parentRemote.prompt;
              remote.promptInherited = true;
            }
          }
        }
      }
    }
    return remote;
  }

  function injectStyles() {
    if (document.getElementById('grok-post-sidebar-styles')) return;
    const s = document.createElement('style');
    s.id = 'grok-post-sidebar-styles';
    s.textContent = `
      #grok-post-sidebar-backdrop {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 99994;
        background: rgba(0, 0, 0, 0.55);
      }
      @media (max-width: 767px) {
        #grok-post-sidebar-backdrop.visible {
          display: block;
        }
      }
      #grok-post-sidebar {
        position: fixed;
        top: 0;
        right: 0;
        width: min(320px, 88vw);
        height: 100vh;
        z-index: 99995;
        display: flex;
        flex-direction: column;
        background: rgba(12, 12, 18, 0.97);
        border-left: 1px solid rgba(255, 255, 255, 0.2);
        box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(14px);
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        color: rgba(255, 255, 255, 0.9);
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
      .grok-post-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      .grok-post-section-head h3 {
        margin: 0;
      }
      .grok-post-sidebar-section h3 {
        margin: 0 0 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.68);
      }
      .grok-post-meta-list {
        margin: 0;
        display: grid;
        grid-template-columns: minmax(76px, 38%) 1fr;
        gap: 6px 10px;
        font-size: 12px;
      }
      .grok-post-meta-list dt {
        margin: 0;
        color: rgba(255, 255, 255, 0.68);
        font-weight: 500;
      }
      .grok-post-meta-list dd {
        margin: 0;
        color: rgba(255, 255, 255, 0.92);
        word-break: break-word;
      }
      .grok-post-meta-list dd.mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        line-height: 1.45;
      }
      .grok-post-meta-link {
        color: #c4b5fd;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .grok-post-meta-link:hover {
        color: #ede9fe;
      }
      .grok-post-meta-copy {
        margin-left: 6px;
        min-block-size: 24px;
        min-inline-size: 24px;
        padding: 3px 8px;
        font-size: 11px;
        border-radius: 5px;
        border: 1px solid rgba(255, 255, 255, 0.26);
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.88);
        cursor: pointer;
        vertical-align: baseline;
      }
      .grok-post-meta-copy:hover {
        border-color: rgba(139, 92, 246, 0.7);
        background: rgba(139, 92, 246, 0.2);
        color: #fff;
      }
      .grok-post-meta-empty {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.64);
        font-style: italic;
      }
      #grok-post-sidebar-prompt {
        font-size: 12.5px;
        line-height: 1.55;
        color: rgba(255, 255, 255, 0.9);
        white-space: pre-wrap;
        word-break: break-word;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 10px;
        padding: 10px 12px;
      }
      #grok-post-sidebar-prompt.empty {
        color: rgba(255, 255, 255, 0.64);
        font-style: italic;
      }
      #grok-post-sidebar-status {
        margin-top: 8px;
        min-height: 1.3em;
        font-size: 11px;
        color: #c4b5fd;
      }
      #grok-post-sidebar-status:empty {
        display: none;
      }
      .grok-post-prompt-inherited-badge {
        display: inline-block;
        margin-bottom: 6px;
        padding: 2px 7px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 4px;
        background: rgba(139, 92, 246, 0.25);
        border: 1px solid rgba(139, 92, 246, 0.55);
        color: #ddd6fe;
        letter-spacing: 0.02em;
      }
      #grok-post-sidebar :focus-visible,
      #grok-post-sidebar-toggle:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 2px;
        box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.45);
      }
      @media (pointer: coarse) {
        .grok-post-meta-copy {
          min-block-size: 36px;
          min-inline-size: 36px;
          padding: 6px 10px;
          font-size: 12px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        #grok-post-sidebar,
        #grok-post-sidebar-toggle {
          transition: none !important;
        }
      }
      @media (forced-colors: active) {
        #grok-post-sidebar,
        #grok-post-sidebar-toggle,
        .grok-post-meta-copy,
        #grok-post-sidebar-prompt {
          border: 1px solid CanvasText;
        }
        #grok-post-sidebar :focus-visible,
        #grok-post-sidebar-toggle:focus-visible {
          outline: 2px solid Highlight;
          outline-offset: 2px;
          box-shadow: none;
        }
      }
    `;
    document.head.appendChild(s);
  }

  let currentPromptText = '';
  let sidebarStatusTimer = null;

  function announceSidebarStatus(message) {
    const el = document.getElementById('grok-post-sidebar-status');
    if (!el) return;
    el.textContent = message || '';
    if (sidebarStatusTimer) clearTimeout(sidebarStatusTimer);
    if (message) {
      sidebarStatusTimer = setTimeout(() => {
        if (el.isConnected) el.textContent = '';
      }, 2200);
    }
  }

  function bindSidebarKeyboardDismiss() {
    if (document.body.dataset.grokPostSidebarKeysBound) return;
    document.body.dataset.grokPostSidebarKeysBound = '1';
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !sidebarExpanded) return;
      const panel = document.getElementById('grok-post-sidebar');
      if (!panel) return;
      const target = e.target;
      const isField = target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
      if (isField && !panel.contains(target)) return;
      if (document.querySelector('[role="dialog"]:not([hidden])')) return;
      setSidebarExpanded(false);
      document.getElementById('grok-post-sidebar-toggle')?.focus();
    });
  }

  function buildSidebar() {
    if (document.getElementById('grok-post-sidebar')) return;
    let backdrop = document.getElementById('grok-post-sidebar-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'grok-post-sidebar-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.addEventListener('click', () => {
        setSidebarExpanded(false);
        document.getElementById('grok-post-sidebar-toggle')?.focus();
      });
      document.body.appendChild(backdrop);
    }
    const aside = document.createElement('aside');
    aside.id = 'grok-post-sidebar';
    aside.setAttribute('aria-label', 'Saved post information');
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
          <div class="grok-post-section-head">
            <h3>Prompt</h3>
            <button type="button" id="grok-post-copy-prompt" class="grok-post-meta-copy" aria-label="Copy prompt" title="Copy prompt to clipboard" hidden>Copy prompt</button>
          </div>
          <div id="grok-post-sidebar-prompt" class="empty">Loading…</div>
          <div id="grok-post-sidebar-status" role="status" aria-live="polite" aria-atomic="true"></div>
        </section>
      </div>
    `;
    document.body.appendChild(aside);
    aside.querySelector('#grok-post-copy-prompt')?.addEventListener('click', async e => {
      const btn = e.currentTarget;
      const ok = await copyText(currentPromptText);
      btn.textContent = ok ? 'Copied' : 'Failed';
      announceSidebarStatus(ok ? 'Prompt copied' : 'Copy failed');
      setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy prompt'; }, 1400);
    });
    bindSidebarKeyboardDismiss();
    ensureToggleButton();
  }

  function ensureToggleButton() {
    if (document.getElementById('grok-post-sidebar-toggle')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'grok-post-sidebar-toggle';
    btn.setAttribute('aria-label', 'Toggle post info panel');
    btn.setAttribute('aria-controls', 'grok-post-sidebar');
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
    const backdrop = document.getElementById('grok-post-sidebar-backdrop');
    const btn = document.getElementById('grok-post-sidebar-toggle');
    if (panel) {
      panel.classList.toggle('collapsed', !expanded);
      panel.inert = !expanded;
    }
    if (backdrop) {
      backdrop.classList.toggle('visible', expanded);
    }
    if (btn) {
      btn.title = expanded ? 'Hide post info (Esc)' : 'Show post info';
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

  async function copyText(text) {
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* fall through to execCommand */ }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
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
      const valHtml = row.href
        ? `<a class="grok-post-meta-link" href="${escapeHtml(row.href)}" title="Open parent post">${escapeHtml(row.value)}</a>`
        : escapeHtml(row.value);
      const copyBtn = row.copyValue
        ? `<button type="button" class="grok-post-meta-copy" data-copy="${escapeHtml(row.copyValue)}" data-label="${escapeHtml(row.label)}" aria-label="Copy ${escapeHtml(row.label)}" title="Copy ${escapeHtml(row.label)}">Copy</button>`
        : '';
      return `<dt>${escapeHtml(row.label)}</dt><dd${ddClass}>${valHtml}${copyBtn}</dd>`;
    }).join('')}</dl>`;
    el.querySelectorAll('.grok-post-meta-copy').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await copyText(btn.dataset.copy);
        btn.textContent = ok ? 'Copied' : 'Failed';
        announceSidebarStatus(ok ? `${btn.dataset.label || 'Value'} copied` : 'Copy failed');
        setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1200);
      });
    });
  }

  function renderPrompt(text, sourceHint, isInherited) {
    const el = document.getElementById('grok-post-sidebar-prompt');
    const copyBtn = document.getElementById('grok-post-copy-prompt');
    currentPromptText = text || '';
    if (copyBtn) copyBtn.hidden = !currentPromptText;
    if (!el) return;
    if (!text) {
      el.textContent = 'No prompt in index or API for this post.';
      el.classList.add('empty');
      el.title = '';
      return;
    }
    if (isInherited) {
      el.innerHTML = `<span class="grok-post-prompt-inherited-badge">Inherited from parent post</span><div>${escapeHtml(text)}</div>`;
      el.classList.remove('empty');
      el.title = sourceHint ? `${sourceHint} (inherited from parent)` : 'Inherited from parent post';
    } else {
      el.textContent = text;
      el.classList.remove('empty');
      el.title = sourceHint || '';
    }
  }

  async function refreshContent() {
    const postId = getPostIdFromUrl();
    if (!postId) {
      document.getElementById('grok-post-sidebar')?.remove();
      document.getElementById('grok-post-sidebar-backdrop')?.remove();
      document.getElementById('grok-post-sidebar-toggle')?.remove();
      lastLoadedPostId = null;
      return;
    }

    // Rebuild the sidebar if an SPA navigation away from /imagine/post/* previously removed it.
    injectStyles();
    buildSidebar();
    ensureToggleButton();

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
    renderPrompt(meta.prompt, promptSource, meta.promptInherited);

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