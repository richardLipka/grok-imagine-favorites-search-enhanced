// ==UserScript==
// @name         Grok Imagine Favorites Search + Saved Item Pass-Through
// @namespace    http://tampermonkey.net/
// @version      1.35
// @description  Search saved Grok media; child posts in DB with own dates in results. Fast list/deep sync. Per-page count, sliders, filters, results panel.
// @author       AnnaLynn (original), Richard Lipka (enhanced fork)
// @homepage     https://github.com/YOUR_USER/YOUR_REPO
// @supportURL   https://github.com/YOUR_USER/YOUR_REPO/issues
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

  const DEFAULT_PAGE_SIZE = 44;
  const DEFAULT_GRID_SIZE_PCT = 100;
  const BASE_GRID_MIN_PX = 180;
  const BASE_GRID_GAP_PX = 17;
  const PAGE_SIZE_MIN = 1;
  const PAGE_SIZE_MAX = 300;
  const GRID_SIZE_MIN_PCT = 10;
  const GRID_SIZE_MAX_PCT = 200;
  const ENDPOINT = 'https://grok.com/rest/media/post/list';
  const POST_GET = 'https://grok.com/rest/media/post/get';
  /** Liked-list pages to walk for metadata (40 posts/page; includes childPosts). */
  const SYNC_LIST_REFRESH_PAGES = 4;
  const SYNC_LIST_PAGE_DELAY_MS = 40;
  /** Parallel post/get for items with children (full child tree from API). */
  const SYNC_DEEP_REFRESH_LIMIT = 24;
  const SYNC_DEEP_CONCURRENCY = 5;
  const SYNC_FOCUS_MIN_INTERVAL_MS = 60 * 1000;
  const METADATA_REFRESH_KEY = 'metadataRefreshedAt';
  const INDEX_SCHEMA_VERSION = 3;
  const DB_NAME = 'GrokSearchIndex';
  const DB_VERSION = 1;
  const STORE_NAME = 'posts';
  const RESULTS_ONLY_KEY = 'grokSearchResultsOnly';
  const FILTER_VIDEO_KEY = 'grokSearchFilterVideo';
  const FILTER_CHILDREN_KEY = 'grokSearchFilterChildren';
  const FILTER_VIDEO_MIN_KEY = 'grokSearchFilterVideoMin';
  const FILTER_CHILDREN_MIN_KEY = 'grokSearchFilterChildrenMin';
  const PAGE_SIZE_KEY = 'grokSearchPageSize';
  const GRID_SIZE_PCT_KEY = 'grokSearchGridSizePct';
  const SEARCH_BAR_COLLAPSED_KEY = 'grokSearchBarCollapsed';
  const MEDIA_MIN_OPTIONS = [1, 3, 5, 7, 10];

  let allPosts = [];
  let searchBarExpanded = true;
  const knownIds = new Set();
  let currentQuery = '';
  let dateStart = '';
  let dateEnd = '';
  let resultsOnly = true;
  let filterOnlyVideo = false;
  let filterOnlyChildren = false;
  let filterMinVideos = 1;
  let filterMinChildren = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let gridSizePercent = DEFAULT_GRID_SIZE_PCT;
  let currentPage = 0;
  let currentSort = 'newest';
  let matchedPosts = [];
  let loaded = false;
  let db = null;
  let indexing = false;
  let syncInProgress = false;
  let rendering = false;
  let lastIncrementalSyncAt = 0;
  let syncDebounceTimer = null;

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
      posts.forEach(p => store.put(toStorageRecord(p)));
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  function dbClear() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbDeleteMany(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      unique.forEach(id => store.delete(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
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

  function isVideoMediaType(mediaType) {
    const t = String(mediaType || '');
    return t === 'MEDIA_POST_TYPE_VIDEO' || t.includes('VIDEO');
  }

  /** Walk entire childPosts tree (all generations). */
  function walkDescendantPosts(node, visitor) {
    const children = node?.childPosts || [];
    for (const child of children) {
      visitor(child);
      walkDescendantPosts(child, visitor);
    }
  }

  /** Aggregate counts for root/parent over full descendant tree. */
  function extractChildMediaCounts(post) {
    let childPostCount = 0;
    let childImageCount = 0;
    let childVideoCount = 0;
    walkDescendantPosts(post, child => {
      childPostCount++;
      if (isVideoMediaType(child.mediaType)) childVideoCount++;
      else childImageCount++;
    });
    const parentIsVideo = isVideoMediaType(post.mediaType);
    const videoCount = (parentIsVideo ? 1 : 0) + childVideoCount;
    return {
      childPostCount,
      childImageCount,
      childVideoCount,
      videoCount,
    };
  }

  /** Canonical index row — all fields persisted to IndexedDB and export. */
  function toStorageRecord(post) {
    const isChild = Boolean(post.isChild);
    const row = {
      id: String(post.id || ''),
      prompt: String(post.prompt || ''),
      parentPrompt: isChild ? String(post.parentPrompt || '') : null,
      parentId: isChild ? String(post.parentId || '') : null,
      isChild,
      thumbnail: String(post.thumbnail || ''),
      mediaUrl: String(post.mediaUrl || ''),
      createTime: String(post.createTime || ''),
      model: String(post.model || ''),
      mediaType: String(post.mediaType || ''),
      childPostCount: post.childPostCount ?? 0,
      childImageCount: post.childImageCount ?? 0,
      childVideoCount: post.childVideoCount ?? 0,
      videoCount: post.videoCount ?? 0,
    };
    if (post[METADATA_REFRESH_KEY] != null) {
      row[METADATA_REFRESH_KEY] = post[METADATA_REFRESH_KEY];
    }
    return row;
  }

  function normalizePost(post) {
    return toStorageRecord(post);
  }

  function buildParentPromptIndex() {
    const map = new Map();
    for (const p of allPosts) {
      if (!isChildPost(p)) map.set(p.id, String(p.prompt || ''));
    }
    return map;
  }

  function isChildPost(post) {
    return Boolean(post?.isChild);
  }

  function parsePost(post) {
    if (!post.id) return null;
    const prompt = post.prompt || post.originalPrompt || '';
    const counts = extractChildMediaCounts(post);
    return {
      id: String(post.id),
      prompt,
      thumbnail: post.thumbnailImageUrl || post.thumbnail || post.mediaUrl || '',
      mediaUrl: post.mediaUrl || post.hdMediaUrl || '',
      createTime: post.createTime || post.createdAt || post.create_time || '',
      model: post.modelName || post.model || post.modelId || '',
      mediaType: post.mediaType || '',
      isChild: false,
      parentId: null,
      parentPrompt: null,
      ...counts,
    };
  }

  function getParentPrompt(parentRaw, parentParsed) {
    return String(
      parentParsed?.prompt || parentRaw?.prompt || parentRaw?.originalPrompt || ''
    ).trim();
  }

  /** Fulltext prompt search — child rows always include parentPrompt (field or live parent lookup). */
  function getSearchablePromptText(post, parentPromptById) {
    const own = String(post.prompt || '').trim();
    if (!isChildPost(post)) return own.toLowerCase();

    let parent = String(post.parentPrompt || '').trim();
    if (!parent && post.parentId && parentPromptById) {
      parent = String(parentPromptById.get(post.parentId) || '').trim();
    }
    const parts = [...new Set([own, parent].filter(Boolean))];
    return parts.join(' ').toLowerCase();
  }

  function parseChildPost(parentRaw, childRaw, parentParsed) {
    if (!childRaw?.id || !parentParsed?.id) return null;
    const parentPrompt = getParentPrompt(parentRaw, parentParsed);
    const ownPrompt = String(childRaw.prompt || childRaw.originalPrompt || '').trim();
    const prompt = ownPrompt || parentPrompt;
    const isVideo = isVideoMediaType(childRaw.mediaType);
    return normalizePost({
      id: String(childRaw.id),
      parentId: String(parentParsed.id),
      isChild: true,
      prompt,
      parentPrompt,
      thumbnail: childRaw.thumbnailImageUrl || childRaw.thumbnail || childRaw.mediaUrl || '',
      mediaUrl: childRaw.mediaUrl || childRaw.hdMediaUrl || '',
      createTime: childRaw.createTime || childRaw.createdAt || childRaw.create_time
        || parentParsed.createTime || '',
      model: childRaw.modelName || childRaw.model || parentParsed.model || '',
      mediaType: childRaw.mediaType || '',
      childPostCount: 0,
      childImageCount: 0,
      childVideoCount: 0,
      videoCount: isVideo ? 1 : 0,
    });
  }

  function collectChildRecords(parentRaw, parentParsed) {
    const records = [];
    const seen = new Set();
    walkDescendantPosts(parentRaw, child => {
      if (!child?.id || seen.has(child.id)) return;
      seen.add(child.id);
      const parsed = parseChildPost(parentRaw, child, parentParsed);
      if (parsed) records.push(stampMetadataRefreshed(parsed));
    });
    return records;
  }

  function removeChildrenOfParent(parentId, keepIds) {
    const removedIds = [];
    allPosts = allPosts.filter(p => {
      if (p.parentId === parentId && p.isChild && !keepIds.has(p.id)) {
        removedIds.push(p.id);
        knownIds.delete(p.id);
        return false;
      }
      return true;
    });
    return removedIds;
  }

  async function syncChildRecordsForParent(parentRaw, parentParsed, idToIndex) {
    if (!parentParsed?.id) return { added: 0, updated: 0, removed: 0 };
    const childRecords = collectChildRecords(parentRaw, parentParsed);
    const keepIds = new Set(childRecords.map(c => c.id));
    const removedIds = removeChildrenOfParent(parentParsed.id, keepIds);

    const added = [];
    const updated = [];
    for (const child of childRecords) {
      const idx = idToIndex.get(child.id);
      if (idx === undefined) {
        allPosts.push(child);
        knownIds.add(child.id);
        added.push(child);
        idToIndex.set(child.id, allPosts.length - 1);
        continue;
      }
      const cached = allPosts[idx];
      const merged = stampMetadataRefreshed(normalizePost({ ...cached, ...child }));
      if (postMetadataChanged(cached, merged)) {
        allPosts[idx] = merged;
        updated.push(merged);
      }
    }

    if (removedIds.length) await dbDeleteMany(removedIds);
    const toPut = [...added, ...updated];
    if (toPut.length) await dbPutMany(toPut);
    return { added: added.length, updated: updated.length, removed: removedIds.length };
  }

  function isImagineListPage() {
    return location.href.includes('/imagine') && !location.href.includes('/imagine/post/');
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

  function mergePostFromRemote(cached, remote) {
    const parsed = parsePost(remote);
    if (!parsed) return cached;
    return normalizePost({
      ...cached,
      ...parsed,
      isChild: false,
      parentId: null,
      parentPrompt: null,
    });
  }

  async function propagateParentPromptToChildren(parentId, parentPrompt) {
    const pp = String(parentPrompt || '');
    const updated = [];
    for (let i = 0; i < allPosts.length; i++) {
      const p = allPosts[i];
      if (!isChildPost(p) || p.parentId !== parentId) continue;
      if ((p.parentPrompt || '') === pp) continue;
      const row = stampMetadataRefreshed(normalizePost({ ...p, parentPrompt: pp }));
      allPosts[i] = row;
      updated.push(row);
    }
    if (updated.length) await dbPutMany(updated);
    return updated.length;
  }

  function postMetadataChanged(before, after) {
    return before.prompt !== after.prompt
      || before.thumbnail !== after.thumbnail
      || before.mediaUrl !== after.mediaUrl
      || before.createTime !== after.createTime
      || (before.videoCount ?? 0) !== (after.videoCount ?? 0)
      || (before.childPostCount ?? 0) !== (after.childPostCount ?? 0)
      || (before.childImageCount ?? 0) !== (after.childImageCount ?? 0)
      || (before.childVideoCount ?? 0) !== (after.childVideoCount ?? 0)
      || (before.model || '') !== (after.model || '')
      || (before.mediaType || '') !== (after.mediaType || '')
      || Boolean(before.isChild) !== Boolean(after.isChild)
      || (before.parentId || '') !== (after.parentId || '')
      || (before.parentPrompt || '') !== (after.parentPrompt || '');
  }

  function verifyIndexIntegrity() {
    const parentPromptById = buildParentPromptIndex();
    let orphans = 0;
    let missingParent = 0;
    let emptySearchText = 0;
    for (const p of allPosts) {
      if (!isChildPost(p)) continue;
      if (!p.parentId) orphans++;
      else if (!parentPromptById.has(p.parentId)) missingParent++;
      if (!getSearchablePromptText(p, parentPromptById).trim()) emptySearchText++;
    }
    const summary = {
      total: allPosts.length,
      parents: allPosts.filter(r => !isChildPost(r)).length,
      children: allPosts.filter(r => isChildPost(r)).length,
      orphans,
      childMissingParent: missingParent,
      emptySearchText,
    };
    console.log('[GrokSearch] Index integrity:', summary);
    return summary;
  }

  function backfillChildParentPrompts() {
    const parentPromptById = new Map();
    for (const p of allPosts) {
      if (!isChildPost(p)) parentPromptById.set(p.id, p.prompt || '');
    }
    const updated = [];
    for (let i = 0; i < allPosts.length; i++) {
      const p = allPosts[i];
      if (!isChildPost(p) || !p.parentId) continue;
      const nextParentPrompt = parentPromptById.get(p.parentId) || '';
      if ((p.parentPrompt || '') === nextParentPrompt) continue;
      const row = normalizePost({ ...p, parentPrompt: nextParentPrompt });
      allPosts[i] = row;
      updated.push(row);
    }
    return updated;
  }

  function postNeedsDeepRefresh(post) {
    if (isChildPost(post)) return false;
    return (post.childPostCount ?? 0) > 0
      || (post.childImageCount ?? 0) > 0
      || (post.childVideoCount ?? 0) > 0
      || (post.videoCount ?? 0) > 1;
  }

  function stampMetadataRefreshed(post) {
    return { ...post, [METADATA_REFRESH_KEY]: Date.now() };
  }

  function buildPostIdIndex() {
    return new Map(allPosts.map((p, i) => [p.id, i]));
  }

  async function runPool(items, concurrency, fn) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * New posts from liked list + in-place metadata refresh (child counts from childPosts on list payload).
   */
  async function syncLikedFeed(statusEl) {
    let idToIndex = buildPostIdIndex();
    const listUpdatedIds = new Set();
    const newPosts = [];
    const updatedPosts = [];
    let newCount = 0;
    let listUpdatedCount = 0;
    let childSyncCount = 0;
    let cursor = null;
    let pageIndex = 0;

    while (true) {
      const data = await fetchPage(cursor);
      if (!data) break;
      const posts = data.posts || [];
      if (posts.length === 0) break;

      const refreshThisPage = pageIndex < SYNC_LIST_REFRESH_PAGES;
      let pageNew = 0;

      for (const raw of posts) {
        const parsed = parsePost(raw);
        if (!parsed) continue;

        if (!knownIds.has(parsed.id)) {
          const parentRow = stampMetadataRefreshed(parsed);
          newPosts.push(parentRow);
          for (const child of collectChildRecords(raw, parsed)) {
            newPosts.push(child);
          }
          pageNew++;
          continue;
        }

        if (refreshThisPage) {
          const idx = idToIndex.get(parsed.id);
          if (idx !== undefined) {
            const cached = allPosts[idx];
            const merged = stampMetadataRefreshed(normalizePost({ ...cached, ...parsed }));
            if (postMetadataChanged(cached, merged)) {
              allPosts[idx] = merged;
              updatedPosts.push(merged);
              listUpdatedIds.add(parsed.id);
              listUpdatedCount++;
            }
            childSyncCount += await propagateParentPromptToChildren(merged.id, merged.prompt);
            const childStats = await syncChildRecordsForParent(raw, merged, idToIndex);
            childSyncCount += childStats.added + childStats.updated + childStats.removed;
            idToIndex = buildPostIdIndex();
          }
        }
      }

      pageIndex++;
      const needNewPages = pageNew > 0;
      const needRefreshPages = pageIndex < SYNC_LIST_REFRESH_PAGES;
      if (!needNewPages && !needRefreshPages) break;
      if (!data.nextCursor) break;

      cursor = data.nextCursor;
      if (statusEl) {
        statusEl.textContent = `syncing… +${newPosts.length + pageNew} new, ${listUpdatedCount} updated`;
      }
      await sleep(SYNC_LIST_PAGE_DELAY_MS);
    }

    if (newPosts.length > 0) {
      for (const p of newPosts) knownIds.add(p.id);
      allPosts = [...newPosts, ...allPosts];
      sortAllPostsNewestFirst();
      await dbPutMany(newPosts);
      newCount = newPosts.length;
      console.log(`[GrokSearch] +${newCount} new row(s) from liked list (parents + children)`);
      idToIndex = buildPostIdIndex();
    }

    if (updatedPosts.length > 0) {
      await dbPutMany(updatedPosts);
      console.log(`[GrokSearch] List refresh: ${listUpdatedCount} parent(s)`);
    }

    const deepUpdatedCount = await refreshPostsViaGet(statusEl, listUpdatedIds, buildPostIdIndex());
    return {
      newCount,
      updatedCount: listUpdatedCount + deepUpdatedCount + childSyncCount,
      listUpdatedIds,
    };
  }

  /** post/get for recent items with children — parallel, skips rows already updated from list. */
  async function refreshPostsViaGet(statusEl, skipIds, idToIndex) {
    const withChildren = [];
    const rest = [];
    for (const p of allPosts) {
      if (isChildPost(p) || skipIds.has(p.id)) continue;
      if (postNeedsDeepRefresh(p)) withChildren.push(p);
      else rest.push(p);
      if (withChildren.length >= SYNC_DEEP_REFRESH_LIMIT
        && withChildren.length + rest.length >= SYNC_DEEP_REFRESH_LIMIT * 2) break;
    }
    const targets = [...withChildren, ...rest].slice(0, SYNC_DEEP_REFRESH_LIMIT);
    if (!targets.length) return 0;

    const updated = [];
    let childSyncCount = 0;
    let done = 0;

    await runPool(targets, SYNC_DEEP_CONCURRENCY, async cached => {
      const remote = await fetchRemotePost(cached.id);
      done++;
      if (statusEl && done % 6 === 0) {
        statusEl.textContent = `deep refresh… ${done}/${targets.length}`;
      }
      if (!remote) return;
      const merged = stampMetadataRefreshed(mergePostFromRemote(cached, remote));
      const idx = idToIndex.get(cached.id);
      if (idx !== undefined) allPosts[idx] = merged;
      if (postMetadataChanged(cached, merged)) updated.push(merged);
      childSyncCount += await propagateParentPromptToChildren(merged.id, merged.prompt);
      const childStats = await syncChildRecordsForParent(remote, merged, idToIndex);
      childSyncCount += childStats.added + childStats.updated + childStats.removed;
      idToIndex = buildPostIdIndex();
    });

    if (updated.length > 0) await dbPutMany(updated);
    if (updated.length > 0 || childSyncCount > 0) {
      console.log(`[GrokSearch] Deep refresh: ${updated.length} parent(s), ${childSyncCount} child row change(s)`);
    }
    return updated.length + childSyncCount;
  }

  function formatSyncStatusMessage(newCount, refreshedCount) {
    const parts = [];
    if (newCount > 0) parts.push(`+${newCount} new`);
    if (refreshedCount > 0) parts.push(`${refreshedCount} updated`);
    if (!parts.length) return 'up to date';
    return `${parts.join(', ')} (${allPosts.length.toLocaleString()} total)`;
  }

  async function runIncrementalSync(reason, options = {}) {
    const { refreshRecent = true, quiet = false } = options;
    if (!isImagineListPage()) return;
    if (indexing || syncInProgress || !loaded) return;

    const now = Date.now();
    if (reason === 'focus' && now - lastIncrementalSyncAt < SYNC_FOCUS_MIN_INTERVAL_MS) return;

    syncInProgress = true;
    const statusEl = document.getElementById('grok-stamp-status');
    try {
      if (!db) db = await openDB();
      if (!quiet && statusEl) statusEl.textContent = 'syncing…';
      const { newCount, updatedCount: refreshedCount } = refreshRecent
        ? await syncLikedFeed(statusEl)
        : await fetchNewPostsOnly(statusEl);
      lastIncrementalSyncAt = Date.now();
      if (!quiet && statusEl) {
        statusEl.textContent = formatSyncStatusMessage(newCount, refreshedCount);
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
      if (newCount > 0 || refreshedCount > 0) applyFilter();
      console.log(`[GrokSearch] Sync (${reason}): +${newCount} new, ${refreshedCount} metadata updated`);
    } catch (e) {
      console.error(`[GrokSearch] Sync failed (${reason}):`, e);
      if (!quiet && statusEl) statusEl.textContent = 'sync failed';
    } finally {
      syncInProgress = false;
    }
  }

  function scheduleIncrementalSync(reason, options = {}) {
    clearTimeout(syncDebounceTimer);
    const delay = reason === 'navigation' ? 400 : 600;
    syncDebounceTimer = setTimeout(() => runIncrementalSync(reason, options), delay);
  }

  async function reindexDatabase() {
    if (indexing) return;
    const statusEl = document.getElementById('grok-stamp-status');
    const reindexBtn = document.getElementById('grok-reindex-btn');
    indexing = true;
    loaded = false;
    allPosts = [];
    knownIds.clear();
    matchedPosts = [];
    currentPage = 0;
    if (reindexBtn) reindexBtn.disabled = true;
    try {
      if (!db) db = await openDB();
      await dbClear();
      if (statusEl) statusEl.textContent = 'reindexing…';
      const count = await fetchFullIndex(statusEl);
      loaded = true;
      console.log(`[GrokSearch] Reindex done: ${count} posts`);
      if (statusEl) {
        statusEl.textContent = `${count.toLocaleString()} reindexed`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
      }
      applyFilter();
    } catch (e) {
      console.error('[GrokSearch] Reindex failed:', e);
      if (statusEl) statusEl.textContent = 'reindex failed';
    } finally {
      indexing = false;
      if (reindexBtn) reindexBtn.disabled = false;
    }
  }

  async function downloadDatabaseJson() {
    const statusEl = document.getElementById('grok-stamp-status');
    const exportBtn = document.getElementById('grok-export-json-btn');
    if (exportBtn) exportBtn.disabled = true;
    try {
      let posts = allPosts.map(toStorageRecord);
      if (!posts.length) {
        if (!db) db = await openDB();
        posts = (await dbGetAll()).map(toStorageRecord);
      }
      const parentCount = posts.filter(p => !p.isChild).length;
      const childCount = posts.filter(p => p.isChild).length;
      const payload = {
        exportedAt: new Date().toISOString(),
        schemaVersion: INDEX_SCHEMA_VERSION,
        source: DB_NAME,
        count: posts.length,
        counts: {
          total: posts.length,
          parents: parentCount,
          children: childCount,
        },
        recordFields: [
          'id', 'prompt', 'parentPrompt', 'parentId', 'isChild',
          'thumbnail', 'mediaUrl', 'createTime', 'model', 'mediaType',
          'childPostCount', 'childImageCount', 'childVideoCount', 'videoCount',
          METADATA_REFRESH_KEY,
        ],
        posts,
      };
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `grok-search-index-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (statusEl) {
        statusEl.textContent = `exported ${posts.length.toLocaleString()}`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
      console.log(`[GrokSearch] Exported ${posts.length} posts`);
    } catch (e) {
      console.error('[GrokSearch] Export failed:', e);
      if (statusEl) statusEl.textContent = 'export failed';
    } finally {
      if (exportBtn) exportBtn.disabled = false;
    }
  }

  function sortAllPostsNewestFirst() {
    allPosts.sort((a, b) => {
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      return tb - ta;
    });
  }

  /** New IDs only — no metadata refresh (fast path). */
  async function fetchNewPostsOnly(statusEl) {
    let cursor = null;
    const newPosts = [];
    while (true) {
      const data = await fetchPage(cursor);
      if (!data) break;
      const posts = data.posts || [];
      if (posts.length === 0) break;

      let pageNew = 0;
      for (const post of posts) {
        const parsed = parsePost(post);
        if (!parsed || knownIds.has(parsed.id)) continue;
        newPosts.push(stampMetadataRefreshed(parsed));
        for (const child of collectChildRecords(post, parsed)) {
          if (!knownIds.has(child.id)) newPosts.push(child);
        }
        pageNew++;
      }

      if (pageNew === 0) break;
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
      if (statusEl) statusEl.textContent = `checking new… +${newPosts.length}`;
      await sleep(SYNC_LIST_PAGE_DELAY_MS);
    }

    if (newPosts.length > 0) {
      for (const p of newPosts) knownIds.add(p.id);
      allPosts = [...newPosts, ...allPosts];
      sortAllPostsNewestFirst();
      await dbPutMany(newPosts);
    }
    return { newCount: newPosts.length, updatedCount: 0 };
  }

  async function fetchFullIndex(statusEl) {
    const allFetched = [];
    let cursor = null;
    while (true) {
      const data = await fetchPage(cursor);
      if (!data) break;
      const posts = data.posts || [];
      for (const post of posts) {
        const parsed = parsePost(post);
        if (!parsed || knownIds.has(parsed.id)) continue;
        allFetched.push(stampMetadataRefreshed(parsed));
        knownIds.add(parsed.id);
        for (const child of collectChildRecords(post, parsed)) {
          if (knownIds.has(child.id)) continue;
          allFetched.push(child);
          knownIds.add(child.id);
        }
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
      const cached = await dbGetAll();
      if (cached.length > 0) {
        const seen = new Set();
        for (const p of cached) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          knownIds.add(p.id);
          allPosts.push(normalizePost(p));
        }
        sortAllPostsNewestFirst();
        const backfilled = backfillChildParentPrompts();
        if (backfilled.length) await dbPutMany(backfilled);
        loaded = true;
        console.log(`[GrokSearch] ${allPosts.length} posts loaded from IndexedDB`);
        if (statusEl) {
          statusEl.textContent = `${allPosts.length.toLocaleString()} cached`;
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
        }
        if (statusEl) statusEl.textContent = 'syncing…';
        const { newCount, updatedCount: refreshedCount } = await syncLikedFeed(statusEl);
        lastIncrementalSyncAt = Date.now();
        if (statusEl) {
          statusEl.textContent = formatSyncStatusMessage(newCount, refreshedCount);
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
    } catch (e) {
      console.error('[GrokSearch] loadAllPosts failed:', e);
      if (statusEl) statusEl.textContent = 'load failed';
    } finally {
      indexing = false;
      if (loaded) {
        applyFilter();
        verifyIndexIntegrity();
      }
    }
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

  function getNativeSavedRoot() {
    const cards = document.querySelectorAll('[class*="media-post-masonry-card"]');
    if (!cards.length) return getGrokGrid();
    let el = cards[0].parentElement;
    let best = el;
    for (let i = 0; i < 15 && el && el !== document.body; i++) {
      const n = el.querySelectorAll('[class*="media-post-masonry-card"]').length;
      if (n > 0) best = el;
      if (el.tagName === 'MAIN' || el.getAttribute('role') === 'main') return el;
      el = el.parentElement;
    }
    return best || getGrokGrid();
  }

  function shouldUseResultsPanel() {
    return resultsOnly;
  }

  function shouldShowSearchResults() {
    if (!searchBarExpanded) return false;
    return resultsOnly || hasActiveFilter();
  }

  function setNativeGridVisible(visible) {
    const nativeGrid = getGrokGrid();
    if (!nativeGrid) return;
    if (visible) {
      nativeGrid.style.removeProperty('display');
      nativeGrid.style.removeProperty('visibility');
    } else {
      nativeGrid.style.setProperty('display', 'none', 'important');
      nativeGrid.style.setProperty('visibility', 'hidden', 'important');
    }
  }

  function setNativeSavedRootVisible(visible) {
    const root = getNativeSavedRoot();
    if (!root) return;
    if (visible) {
      root.style.removeProperty('display');
      delete root.dataset.grokNativeSavedRoot;
    } else {
      root.dataset.grokNativeSavedRoot = '1';
      root.style.setProperty('display', 'none', 'important');
    }
  }

  function applyNativeVisibility() {
    if (!shouldShowSearchResults()) {
      setNativeSavedRootVisible(true);
      setNativeGridVisible(true);
      return;
    }
    if (resultsOnly) {
      setNativeSavedRootVisible(false);
      setNativeGridVisible(false);
    } else {
      setNativeSavedRootVisible(true);
      setNativeGridVisible(false);
    }
  }

  function updateDisplayMode() {
    document.documentElement.classList.toggle('grok-results-only-mode', resultsOnly);
    document.documentElement.classList.toggle('grok-custom-results-mode', resultsOnly);
    document.documentElement.classList.toggle('grok-filtered-inline-mode', hasActiveFilter() && !resultsOnly);
  }

  function ensureInlineResultsViewport() {
    let vp = document.getElementById('grok-inline-results-viewport');
    if (!vp) {
      vp = document.createElement('div');
      vp.id = 'grok-inline-results-viewport';
      document.body.appendChild(vp);
    }
    return vp;
  }

  function setInlineResultsViewportVisible(visible) {
    const vp = document.getElementById('grok-inline-results-viewport');
    if (vp) vp.style.display = visible ? 'block' : 'none';
  }

  function layoutResultsGridPlacement() {
    let container = document.getElementById('grok-results-grid');
    if (!container) return null;
    if (resultsOnly) {
      const body = ensureResultsPanel().querySelector('.grok-results-panel-body');
      if (container.parentElement !== body) body.appendChild(container);
    } else {
      const vp = ensureInlineResultsViewport();
      if (container.parentElement !== vp) vp.appendChild(container);
    }
    return container;
  }

  function ensureResultsBackdrop() {
    let backdrop = document.getElementById('grok-results-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'grok-results-backdrop';
      document.body.appendChild(backdrop);
    }
    return backdrop;
  }

  function ensureResultsPanel() {
    let panel = document.getElementById('grok-results-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'grok-results-panel';
      panel.innerHTML = `
        <div class="grok-results-panel-header">
          <div class="grok-results-panel-title-wrap">
            <span class="grok-results-panel-title" id="grok-panel-title">Search results</span>
            <span id="grok-panel-range" class="grok-results-panel-range"></span>
          </div>
          <span id="grok-panel-count"></span>
        </div>
        <div class="grok-results-panel-body">
          <div id="grok-results-grid"></div>
        </div>
        <div class="grok-results-panel-footer" id="grok-panel-pager-slot"></div>
      `;
      document.body.appendChild(panel);
    } else if (!document.getElementById('grok-panel-range')) {
      const header = panel.querySelector('.grok-results-panel-header');
      if (header) {
        header.innerHTML = `
          <div class="grok-results-panel-title-wrap">
            <span class="grok-results-panel-title" id="grok-panel-title">Search results</span>
            <span id="grok-panel-range" class="grok-results-panel-range"></span>
          </div>
          <span id="grok-panel-count"></span>
        `;
      }
    }
    return panel;
  }

  function layoutPagerInPanel() {
    const pager = document.getElementById('grok-pager');
    const slot = document.getElementById('grok-panel-pager-slot');
    const wrap = document.getElementById('grok-search-wrap');
    if (!pager) return;
    if (shouldUseResultsPanel() && slot) {
      if (pager.parentElement !== slot) slot.appendChild(pager);
    } else if (wrap && pager.parentElement !== wrap) {
      wrap.appendChild(pager);
    }
  }

  function ensurePageJumpInput() {
    let jump = document.getElementById('grok-page-jump');
    if (jump) return jump;
    const pager = document.getElementById('grok-pager');
    const prev = document.getElementById('grok-page-prev');
    const label = document.getElementById('grok-page-label');
    if (!pager || !prev || !label) return null;
    jump = document.createElement('input');
    jump.type = 'text';
    jump.id = 'grok-page-jump';
    jump.className = 'grok-page-jump';
    jump.inputMode = 'numeric';
    jump.maxLength = 6;
    jump.title = 'Go to page (1–N)';
    jump.setAttribute('aria-label', 'Page number');
    prev.insertAdjacentElement('afterend', jump);
    bindPageJumpListeners(jump);
    return jump;
  }

  function bindPageJumpListeners(pageJumpEl) {
    if (!pageJumpEl || pageJumpEl.dataset.grokJumpBound) return;
    pageJumpEl.dataset.grokJumpBound = '1';

    const stopKey = e => e.stopPropagation();
    pageJumpEl.addEventListener('keydown', e => {
      stopKey(e);
      if (e.key === 'Enter') {
        e.preventDefault();
        applyPageJump();
      }
    }, true);
    pageJumpEl.addEventListener('keyup', stopKey, true);
    pageJumpEl.addEventListener('keypress', stopKey, true);
    pageJumpEl.addEventListener('mousedown', e => e.stopPropagation(), true);
    pageJumpEl.addEventListener('click', e => e.stopPropagation(), true);

    pageJumpEl.addEventListener('change', () => applyPageJump());
    pageJumpEl.addEventListener('blur', () => {
      const totalPages = getTotalPages();
      const result = parsePageJumpInput(pageJumpEl.value, totalPages);
      if (!result.valid) syncPageJumpInput();
    });
    pageJumpEl.addEventListener('input', () => {
      const totalPages = getTotalPages();
      const result = parsePageJumpInput(pageJumpEl.value, totalPages);
      setPageJumpValidity(pageJumpEl.value.trim() === '' || result.valid);
    });
  }

  function restorePagerToToolbar() {
    const pager = document.getElementById('grok-pager');
    const wrap = document.getElementById('grok-search-wrap');
    if (pager && wrap && pager.parentElement !== wrap) wrap.appendChild(pager);
  }

  function setResultsPanelVisible(visible) {
    const panel = document.getElementById('grok-results-panel');
    const backdrop = document.getElementById('grok-results-backdrop');
    const grid = document.getElementById('grok-results-grid');

    if (visible) {
      ensureResultsBackdrop().style.display = 'block';
      ensureResultsPanel().style.display = 'flex';
      layoutPagerInPanel();
    } else {
      if (panel) panel.style.display = 'none';
      if (backdrop) backdrop.style.display = 'none';
      restorePagerToToolbar();
    }
    updateDisplayMode();
  }

  function hideAllSearchResults() {
    setResultsPanelVisible(false);
    setInlineResultsViewportVisible(false);
    const grid = document.getElementById('grok-results-grid');
    if (grid) grid.style.display = 'none';
  }

  function hideCustomResults() {
    hideAllSearchResults();
  }

  function syncResultsView() {
    updateDisplayMode();

    if (!shouldShowSearchResults()) {
      hideAllSearchResults();
      applyNativeVisibility();
      const noResults = document.getElementById('grok-no-results');
      if (noResults) noResults.classList.remove('visible');
      updatePager();
      return;
    }

    if (!loaded) return;

    currentPage = 0;
    const noResults = document.getElementById('grok-no-results');
    if (matchedPosts.length === 0) {
      hideAllSearchResults();
      applyNativeVisibility();
      if (noResults) noResults.classList.add('visible');
    } else {
      if (noResults) noResults.classList.remove('visible');
      showResults();
    }
    updatePager();
  }

  function getStoredResultsOnly() {
    try {
      const v = localStorage.getItem(RESULTS_ONLY_KEY);
      if (v === null || v === '') return true;
      return v === '1';
    } catch {
      return true;
    }
  }

  function syncResultsOnlyCheckbox() {
    const el = document.getElementById('grok-results-only');
    if (el) el.checked = resultsOnly;
  }

  function setResultsOnlyEnabled(enabled) {
    const next = Boolean(enabled);
    resultsOnly = next;
    syncResultsOnlyCheckbox();
    updateResultsOnlyLayout();
    currentPage = 0;
    if (!loaded) {
      hideAllSearchResults();
      applyNativeVisibility();
      return;
    }
    applyFilter();
    scheduleEnforceDisplay();
  }

  function updateResultsOnlyLayout() {
    updateDisplayMode();
  }

  function showResults() {
    if (rendering) return;
    rendering = true;
    setTimeout(() => { rendering = false; }, 50);

    const size = getPageSize();
    const totalPages = Math.max(1, Math.ceil(matchedPosts.length / size));
    currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
    const start = currentPage * size;
    const page = matchedPosts.slice(start, start + size);

    applyNativeVisibility();
    updateDisplayMode();

    let container = document.getElementById('grok-results-grid');
    if (!container) {
      container = document.createElement('div');
      container.id = 'grok-results-grid';
    }
    layoutResultsGridPlacement();

    container.innerHTML = page.map(post => {
      const dateKey = formatPostDateKey(post.createTime);
      const dateStr = formatPostDate(post.createTime);
      const dateActive = dateKey && isFilteredToSingleDay(dateKey) ? ' grok-result-date-active' : '';
      const childCard = isChildPost(post);
      const cardClass = childCard ? ' grok-result-card--child' : '';
      const childMark = childCard
        ? `<span class="grok-result-child-mark" title="Child post">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
              <path d="M6 3v12"/><circle cx="6" cy="18" r="2"/><path d="M18 7v14"/><circle cx="18" cy="5" r="2"/>
            </svg>
           </span>`
        : '';
      return `
      <div class="grok-result-card${cardClass}" data-id="${escapeHtml(post.id)}" data-media="${escapeHtml(post.mediaUrl)}" title="${escapeHtml(post.prompt)}">
        ${childMark}
        ${dateStr ? `<div class="grok-result-date${dateActive}" data-date="${escapeHtml(dateKey)}" title="Filter to ${escapeHtml(dateStr)} (click again to clear)">${escapeHtml(dateStr)}</div>` : ''}
        <img src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.prompt)}" loading="lazy" style="width:100%; display:block; border-radius:14px; aspect-ratio:3/4; object-fit:cover;" />
        <div class="grok-result-prompt">${escapeHtml(post.prompt)}</div>
        ${renderResultBadges(post)}
      </div>`;
    }).join('');

    container.querySelectorAll('.grok-result-date').forEach(dateEl => {
      dateEl.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        applyDateFilterForDay(dateEl.dataset.date);
      });
    });

    container.querySelectorAll('.grok-result-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.grok-result-date')) return;
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

    container.style.display = 'grid';
    applyGridLayoutStyles();

    if (resultsOnly) {
      setResultsPanelVisible(true);
      setInlineResultsViewportVisible(false);
      const panel = document.getElementById('grok-results-panel');
      const body = panel?.querySelector('.grok-results-panel-body');
      if (body) body.scrollTop = 0;
    } else {
      setResultsPanelVisible(false);
      setInlineResultsViewportVisible(true);
      const vp = document.getElementById('grok-inline-results-viewport');
      if (vp) vp.scrollTop = 0;
    }

    updatePanelPageRange(page);
    updatePager();
    enforceDisplayMode();
  }

  function hideResults() {
    hideAllSearchResults();
    applyNativeVisibility();
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

    updateDisplayMode();

    const queryLower = (currentQuery || '').toLowerCase().trim();
    const terms = queryLower ? queryLower.split(/\s+/).filter(Boolean) : [];
    const parentPromptById = terms.length > 0 ? buildParentPromptIndex() : null;

    matchedPosts = allPosts.filter(post => {
      if ((filterOnlyVideo || filterOnlyChildren) && isChildPost(post)) return false;
      if (terms.length > 0) {
        const p = getSearchablePromptText(post, parentPromptById);
        if (!terms.every(t => p.includes(t))) return false;
      }
      if (!matchesDateFilter(post)) return false;
      if (filterOnlyVideo && (post.videoCount ?? 0) < filterMinVideos) return false;
      if (filterOnlyChildren && (post.childPostCount ?? 0) < filterMinChildren) return false;
      return true;
    });

    matchedPosts.sort((a, b) => {
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      return currentSort === 'oldest' ? ta - tb : tb - ta;
    });

    syncResultsView();
  }

  let enforceTimer = null;
  function enforceDisplayMode() {
    if (isPageJumpFocused()) return;
    updateDisplayMode();
    if (!shouldShowSearchResults()) {
      hideAllSearchResults();
      applyNativeVisibility();
      return;
    }
    applyNativeVisibility();
    if (matchedPosts.length === 0) {
      hideAllSearchResults();
      return;
    }
    if (resultsOnly) {
      layoutResultsGridPlacement();
      setResultsPanelVisible(true);
      const grid = document.getElementById('grok-results-grid');
      if (grid) grid.style.display = 'grid';
    } else {
      setResultsPanelVisible(false);
      layoutResultsGridPlacement();
      const grid = document.getElementById('grok-results-grid');
      if (grid) grid.style.display = 'grid';
    }
  }

  function scheduleEnforceDisplay() {
    clearTimeout(enforceTimer);
    enforceTimer = setTimeout(enforceDisplayMode, 200);
  }

  function updatePager() {
    const totalPages = getTotalPages();
    const countEl = document.getElementById('grok-search-count');
    const pagerEl = document.getElementById('grok-pager');
    const pageLabel = document.getElementById('grok-page-label');
    const firstBtn = document.getElementById('grok-page-first');
    const prevBtn = document.getElementById('grok-page-prev');
    const nextBtn = document.getElementById('grok-page-next');
    const lastBtn = document.getElementById('grok-page-last');

    let countText = '';
    const n = matchedPosts.length.toLocaleString();
    const hasText = Boolean(currentQuery.trim());
    const hasDates = hasDateFilter();
    if (hasText || hasDates || filterOnlyVideo || filterOnlyChildren) {
      countText = `${n} match${matchedPosts.length !== 1 ? 'es' : ''}`;
    } else {
      countText = `${n} saved`;
    }
    if (countEl) countEl.textContent = countText;
    const panelCountEl = document.getElementById('grok-panel-count');
    if (panelCountEl) panelCountEl.textContent = countText;

    if (pagerEl) {
      pagerEl.style.display = (shouldShowSearchResults() && totalPages > 1) ? 'flex' : 'none';
    }

    if (pageLabel) pageLabel.textContent = `/ ${totalPages.toLocaleString()}`;
    syncPageJumpInput();
    if (firstBtn) firstBtn.disabled = currentPage === 0;
    if (prevBtn) prevBtn.disabled = currentPage === 0;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages - 1;
    if (lastBtn) lastBtn.disabled = currentPage >= totalPages - 1;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderResultBadges(post) {
    if (isChildPost(post)) {
      const videos = post.videoCount ?? 0;
      if (videos > 0) {
        return `<div class="grok-result-badges">
          <span class="grok-badge grok-badge-video" title="Video">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          </span>
        </div>`;
      }
      return '';
    }
    const videos = post.videoCount ?? 0;
    const childImages = post.childImageCount ?? 0;
    const parts = [];
    if (videos > 0) {
      parts.push(`<span class="grok-badge grok-badge-video" title="${videos} video${videos !== 1 ? 's' : ''} (incl. all descendants)">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <span>${videos}</span>
      </span>`);
    }
    if (childImages > 0) {
      parts.push(`<span class="grok-badge grok-badge-images" title="${childImages} descendant image${childImages !== 1 ? 's' : ''} (all generations)">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="1.5"/><path d="m21 15-5-5L5 19"/>
        </svg>
        <span>${childImages}</span>
      </span>`);
    }
    if (!parts.length) return '';
    return `<div class="grok-result-badges">${parts.join('')}</div>`;
  }

  function formatPostDateKey(createTime) {
    if (!createTime) return '';
    const d = new Date(createTime);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatPostDate(createTime) {
    if (!createTime) return '';
    const d = new Date(createTime);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function isFilteredToSingleDay(dateKey) {
    return Boolean(dateKey && dateStart === dateKey && dateEnd === dateKey);
  }

  function hasSingleDayFilter() {
    return Boolean(dateStart && dateEnd && dateStart === dateEnd);
  }

  function addDaysToDateKey(dateKey, deltaDays) {
    const d = new Date(`${dateKey}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateKey;
    d.setDate(d.getDate() + deltaDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function shiftSingleDayFilter(deltaDays) {
    if (!hasSingleDayFilter()) return;
    const nextKey = addDaysToDateKey(dateStart, deltaDays);
    dateStart = nextKey;
    dateEnd = nextKey;
    const dateStartEl = document.getElementById('grok-date-start');
    const dateEndEl = document.getElementById('grok-date-end');
    if (dateStartEl) dateStartEl.value = dateStart;
    if (dateEndEl) dateEndEl.value = dateEnd;
    currentPage = 0;
    updateClearButton();
    applyFilter();
  }

  function updateDateNavButtons() {
    const prevBtn = document.getElementById('grok-date-prev');
    const nextBtn = document.getElementById('grok-date-next');
    const enabled = hasSingleDayFilter();
    if (prevBtn) prevBtn.disabled = !enabled;
    if (nextBtn) nextBtn.disabled = !enabled;
  }

  function applyDateFilterForDay(dateKey) {
    if (!dateKey) return;
    if (isFilteredToSingleDay(dateKey)) {
      dateStart = '';
      dateEnd = '';
    } else {
      dateStart = dateKey;
      dateEnd = dateKey;
    }
    const dateStartEl = document.getElementById('grok-date-start');
    const dateEndEl = document.getElementById('grok-date-end');
    if (dateStartEl) dateStartEl.value = dateStart;
    if (dateEndEl) dateEndEl.value = dateEnd;
    currentPage = 0;
    updateClearButton();
    updateDateNavButtons();
    applyFilter();
  }

  function formatPostDateTime(createTime) {
    if (!createTime) return 'Unknown date';
    const d = new Date(createTime);
    if (Number.isNaN(d.getTime())) return 'Unknown date';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  function getTotalPages() {
    return Math.max(1, Math.ceil(matchedPosts.length / getPageSize()));
  }

  function getPageSize() {
    return pageSize;
  }

  function clampPageSize(n) {
    return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, Math.round(Number(n)) || DEFAULT_PAGE_SIZE));
  }

  function clampGridSizePercent(n) {
    return Math.min(GRID_SIZE_MAX_PCT, Math.max(GRID_SIZE_MIN_PCT, Math.round(Number(n)) || DEFAULT_GRID_SIZE_PCT));
  }

  function persistDisplaySettings() {
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(pageSize));
      localStorage.setItem(GRID_SIZE_PCT_KEY, String(gridSizePercent));
    } catch { /* ignore */ }
  }

  function applyPageSizeSetting(newSize, rerender) {
    pageSize = clampPageSize(newSize);
    syncDisplayControlLabels();
    persistDisplaySettings();
    if (!rerender) return;
    currentPage = 0;
    if (shouldShowSearchResults() && matchedPosts.length > 0) showResults();
    else updatePager();
  }

  function applyGridSizeSetting(newPct) {
    gridSizePercent = clampGridSizePercent(newPct);
    syncDisplayControlLabels();
    persistDisplaySettings();
    applyGridLayoutStyles();
  }

  function applyDisplayDefaults() {
    pageSize = clampPageSize(DEFAULT_PAGE_SIZE);
    gridSizePercent = clampGridSizePercent(DEFAULT_GRID_SIZE_PCT);
    syncDisplayControlLabels();
    persistDisplaySettings();
    applyGridLayoutStyles();
    currentPage = 0;
    if (shouldShowSearchResults() && matchedPosts.length > 0) showResults();
    else updatePager();
  }

  function applyGridLayoutStyles() {
    const minPx = Math.round(BASE_GRID_MIN_PX * gridSizePercent / 100);
    const gapPx = Math.round(BASE_GRID_GAP_PX * gridSizePercent / 100);
    const grid = document.getElementById('grok-results-grid');
    if (grid) {
      grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${minPx}px, 1fr))`;
      grid.style.gap = `${gapPx}px`;
    }
  }

  function syncDisplayControlLabels() {
    const pageVal = document.getElementById('grok-page-size-val');
    const gridVal = document.getElementById('grok-grid-size-val');
    const pageSlider = document.getElementById('grok-page-size-slider');
    const gridSlider = document.getElementById('grok-grid-size-slider');
    if (pageVal) pageVal.textContent = String(pageSize);
    if (gridVal) gridVal.textContent = String(gridSizePercent);
    if (pageSlider) pageSlider.value = String(pageSize);
    if (gridSlider) gridSlider.value = String(gridSizePercent);
  }

  function updatePanelPageRange(pagePosts) {
    const rangeEl = document.getElementById('grok-panel-range');
    if (!rangeEl) return;
    if (!pagePosts.length) {
      rangeEl.textContent = '';
      return;
    }
    const first = formatPostDateTime(pagePosts[0].createTime);
    const last = formatPostDateTime(pagePosts[pagePosts.length - 1].createTime);
    rangeEl.textContent = first === last ? first : `${first} – ${last}`;
  }

  function parsePageJumpInput(raw, totalPages) {
    const s = String(raw || '').trim();
    if (!s) return { valid: false, page: null };
    if (!/^\d+$/.test(s)) return { valid: false, page: null };
    const n = parseInt(s, 10);
    if (n < 1 || n > totalPages) return { valid: false, page: null };
    return { valid: true, page: n - 1 };
  }

  function setPageJumpValidity(valid) {
    const input = document.getElementById('grok-page-jump');
    if (input) input.classList.toggle('grok-page-jump-invalid', !valid);
  }

  function syncPageJumpInput() {
    const input = document.getElementById('grok-page-jump');
    if (!input) return;
    if (document.activeElement === input) return;
    input.value = String(currentPage + 1);
    setPageJumpValidity(true);
  }

  function isPageJumpFocused() {
    return document.activeElement?.id === 'grok-page-jump';
  }

  function applyPageJump() {
    const input = document.getElementById('grok-page-jump');
    if (!input) return false;
    const totalPages = getTotalPages();
    const result = parsePageJumpInput(input.value, totalPages);
    if (!result.valid) {
      setPageJumpValidity(input.value.trim() !== '');
      return false;
    }
    setPageJumpValidity(true);
    if (result.page !== currentPage) {
      currentPage = result.page;
      showResults();
    } else {
      syncPageJumpInput();
    }
    return true;
  }

  function postCreatedMs(post) {
    if (!post.createTime) return null;
    const t = new Date(post.createTime).getTime();
    return Number.isNaN(t) ? null : t;
  }

  function parseMediaMin(val) {
    const n = parseInt(val, 10);
    return MEDIA_MIN_OPTIONS.includes(n) ? n : 1;
  }

  function buildMediaMinSelectOptions(select) {
    select.innerHTML = '';
    MEDIA_MIN_OPTIONS.forEach(v => {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = String(v);
      select.appendChild(opt);
    });
  }

  function syncMediaMinSelects() {
    const videoMinEl = document.getElementById('grok-filter-video-min');
    const childrenMinEl = document.getElementById('grok-filter-children-min');
    const filterVideoEl = document.getElementById('grok-filter-video');
    const filterChildrenEl = document.getElementById('grok-filter-children');
    if (videoMinEl) {
      videoMinEl.value = String(filterMinVideos);
      videoMinEl.disabled = !filterOnlyVideo;
    }
    if (childrenMinEl) {
      childrenMinEl.value = String(filterMinChildren);
      childrenMinEl.disabled = !filterOnlyChildren;
    }
    if (filterVideoEl) filterVideoEl.checked = filterOnlyVideo;
    if (filterChildrenEl) filterChildrenEl.checked = filterOnlyChildren;
  }

  function hasDateFilter() {
    return Boolean(dateStart || dateEnd);
  }

  function hasActiveFilter() {
    return Boolean(
      currentQuery.trim() || hasDateFilter() || filterOnlyVideo || filterOnlyChildren
    );
  }

  function getDateFilterBounds() {
    let start = dateStart;
    let end = dateEnd;
    if (start && end && start > end) [start, end] = [end, start];

    let startMs = null;
    let endMs = null;
    if (start) {
      const d = new Date(`${start}T00:00:00`);
      if (!Number.isNaN(d.getTime())) startMs = d.getTime();
    }
    if (end) {
      const d = new Date(`${end}T23:59:59.999`);
      if (!Number.isNaN(d.getTime())) endMs = d.getTime();
    }
    return { startMs, endMs };
  }

  function matchesDateFilter(post) {
    if (!hasDateFilter()) return true;
    const { startMs, endMs } = getDateFilterBounds();
    const ms = postCreatedMs(post);
    if (ms === null) return false;
    if (startMs !== null && ms < startMs) return false;
    if (endMs !== null && ms > endMs) return false;
    return true;
  }

  function updateClearButton() {
    const clearBtn = document.getElementById('grok-search-clear');
    if (clearBtn) clearBtn.classList.toggle('visible', hasActiveFilter());
    updateDateNavButtons();
  }

  const DATE_NAV_PREV_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="7,1 3,5 7,9"/></svg>`;
  const DATE_NAV_NEXT_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3,1 7,5 3,9"/></svg>`;

  function createDateNavButton(id, title, svgHtml) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'grok-date-nav-btn icon-only';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.disabled = true;
    btn.innerHTML = svgHtml;
    return btn;
  }

  function ensureDateNavButtons() {
    const filters = getFiltersRow();
    if (!filters) return;

    let prevBtn = document.getElementById('grok-date-prev');
    let nextBtn = document.getElementById('grok-date-next');
    const startEl = document.getElementById('grok-date-start');
    const endEl = document.getElementById('grok-date-end');

    if (!prevBtn) {
      prevBtn = createDateNavButton('grok-date-prev', 'Previous day', DATE_NAV_PREV_SVG);
      if (startEl) filters.insertBefore(prevBtn, startEl);
      else filters.prepend(prevBtn);
    }
    if (!nextBtn) {
      nextBtn = createDateNavButton('grok-date-next', 'Next day', DATE_NAV_NEXT_SVG);
      if (endEl) endEl.insertAdjacentElement('afterend', nextBtn);
      else filters.appendChild(nextBtn);
    }

    if (!prevBtn.dataset.grokDateNavBound) {
      prevBtn.dataset.grokDateNavBound = '1';
      prevBtn.addEventListener('click', () => shiftSingleDayFilter(-1));
    }
    if (!nextBtn.dataset.grokDateNavBound) {
      nextBtn.dataset.grokDateNavBound = '1';
      nextBtn.addEventListener('click', () => shiftSingleDayFilter(1));
    }
    updateDateNavButtons();
  }

  // ─── Styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('grok-search-styles')) return;
    const s = document.createElement('style');
    s.id = 'grok-search-styles';
    s.textContent = `
      #grok-search-wrap {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 99990; display: flex; flex-direction: column; align-items: stretch;
        gap: 8px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        width: min(900px, 92vw);
        transition: transform 0.28s ease, opacity 0.22s ease, visibility 0.28s;
      }
      #grok-search-wrap.collapsed {
        transform: translateX(-50%) translateY(calc(-100% - 24px));
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
      }
      #grok-search-toggle {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 99991;
        width: 44px;
        height: 44px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(15, 15, 20, 0.94);
        color: rgba(255, 255, 255, 0.9);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(12px);
        transition: background 0.15s, border-color 0.15s;
        padding: 0;
      }
      #grok-search-toggle:hover {
        border-color: rgba(139, 92, 246, 0.55);
        background: rgba(139, 92, 246, 0.22);
        color: #fff;
      }
      #grok-search-toggle svg {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }
      #grok-results-only-row {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        gap: 10px 20px;
        padding: 8px 14px;
        background: rgba(15,15,20,0.9);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        backdrop-filter: blur(12px);
        box-shadow: 0 4px 20px rgba(0,0,0,0.35);
      }
      .grok-display-control {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: rgba(255,255,255,0.55);
        white-space: nowrap;
        user-select: none;
      }
      .grok-display-control span.grok-display-val {
        min-width: 2.2em;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: rgba(255,255,255,0.8);
      }
      .grok-display-control input[type="range"] {
        width: 88px;
        margin: 0;
        accent-color: #8b5cf6;
        cursor: pointer;
      }
      .grok-display-default-btn {
        font-size: 10px;
        padding: 2px 7px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.65);
        cursor: pointer;
        font-family: inherit;
        flex-shrink: 0;
        transition: border-color 0.15s, color 0.15s, background 0.15s;
      }
      .grok-display-default-btn:hover {
        border-color: rgba(139,92,246,0.5);
        background: rgba(139,92,246,0.15);
        color: #fff;
      }
      #grok-inline-results-viewport {
        display: none;
        position: fixed;
        top: max(132px, 13vh);
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 99950;
        overflow: auto;
        padding: 12px 20px 24px;
        box-sizing: border-box;
        -webkit-overflow-scrolling: touch;
      }
      #grok-search-bar {
        display: flex;
        flex-direction: column;
        gap: 10px;
        background: rgba(15,15,20,0.93);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        padding: 12px 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        transition: box-shadow 0.2s, border-color 0.2s;
      }
      .grok-bar-top {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
      }
      .grok-bar-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
      }
      .grok-bar-filters {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: nowrap;
        min-width: 0;
      }
      .grok-bar-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .grok-date-input {
        background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px; color: rgba(255,255,255,0.85); font-size: 11px;
        padding: 3px 6px; outline: none; cursor: pointer; flex-shrink: 0;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        transition: border-color 0.15s, color 0.15s;
        color-scheme: dark;
      }
      .grok-date-input:hover { border-color: rgba(139,92,246,0.5); }
      .grok-date-input:focus { border-color: rgba(139,92,246,0.6); color: #fff; }
      .grok-date-sep { color: rgba(255,255,255,0.35); font-size: 11px; flex-shrink: 0; }
      .grok-date-nav-btn {
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; width: 28px; height: 28px; padding: 0;
        border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
        background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.85);
        cursor: pointer; transition: border-color 0.15s, background 0.15s, opacity 0.15s;
      }
      .grok-date-nav-btn:hover:not(:disabled) {
        border-color: rgba(139,92,246,0.55);
        background: rgba(139,92,246,0.22);
        color: #fff;
      }
      .grok-date-nav-btn:disabled {
        opacity: 0.28;
        cursor: default;
        pointer-events: none;
      }
      .grok-date-nav-btn svg { display: block; }
      #grok-search-bar:focus-within {
        border-color: rgba(139,92,246,0.6);
        box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 3px rgba(139,92,246,0.15);
      }
      #grok-search-icon { color: rgba(255,255,255,0.4); flex-shrink: 0; }
      #grok-search-input {
        background: transparent; border: none; outline: none;
        color: #fff; font-size: 14px; flex: 1; min-width: 100px; width: auto;
        caret-color: #8b5cf6;
      }
      #grok-search-input::placeholder { color: rgba(255,255,255,0.28); }
      #grok-search-count {
        font-size: 11px; color: rgba(255,255,255,0.4);
        white-space: nowrap; font-variant-numeric: tabular-nums; flex-shrink: 0;
      }
      #grok-stamp-status { font-size: 10px; color: rgba(255,255,255,0.22); white-space: nowrap; flex-shrink: 0; }
      #grok-search-clear,
      .grok-clear-filters-btn {
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; min-width: 32px; padding: 4px 8px;
      }
      #grok-search-clear:not(.visible) {
        opacity: 0.35; pointer-events: none;
      }
      #grok-search-clear.visible { opacity: 1; pointer-events: auto; }
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
        pointer-events: auto;
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
        font-variant-numeric: tabular-nums; min-width: 40px; text-align: center;
      }
      .grok-page-jump {
        width: 44px;
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 7px;
        color: rgba(255,255,255,0.85);
        font-size: 12px;
        padding: 4px 6px;
        text-align: center;
        outline: none;
        font-variant-numeric: tabular-nums;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        pointer-events: auto;
        user-select: text;
        -webkit-user-select: text;
        position: relative;
        z-index: 1;
      }
      .grok-page-jump:focus {
        border-color: rgba(139,92,246,0.6);
        color: #fff;
      }
      .grok-page-jump-invalid {
        border-color: rgba(239,68,68,0.75) !important;
        color: #fca5a5 !important;
      }
      .grok-result-date {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2;
        padding: 6px 8px;
        font-size: 10px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.95);
        background: linear-gradient(rgba(0,0,0,0.72), transparent);
        border-radius: 14px 14px 0 0;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        pointer-events: auto;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .grok-result-date:hover {
        background: linear-gradient(rgba(139,92,246,0.55), transparent);
        color: #fff;
      }
      .grok-result-date-active {
        background: linear-gradient(rgba(139,92,246,0.75), rgba(139,92,246,0.2));
        color: #fff;
      }
      #grok-results-backdrop {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 99970;
        background: rgba(0, 0, 0, 0.72);
        pointer-events: auto;
      }
      #grok-results-panel {
        display: none;
        position: fixed;
        z-index: 99980;
        flex-direction: column;
        background: #14141c;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.75);
        overflow: hidden;
        box-sizing: border-box;
      }
      html.grok-custom-results-mode #grok-results-panel {
        top: max(120px, 12vh);
        left: 2.5vw;
        right: 2.5vw;
        bottom: 2.5vh;
        width: auto;
        height: auto;
      }
      .grok-results-panel-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: #1a1a24;
        flex-shrink: 0;
      }
      .grok-results-panel-title-wrap {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .grok-results-panel-title {
        font-size: 14px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.92);
      }
      .grok-results-panel-range {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.5);
        line-height: 1.35;
      }
      #grok-panel-count {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.45);
        font-variant-numeric: tabular-nums;
      }
      .grok-results-panel-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 16px 20px;
        -webkit-overflow-scrolling: touch;
      }
      .grok-results-panel-footer {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 10px 16px 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        background: #1a1a24;
        flex-shrink: 0;
      }
      .grok-results-panel-footer #grok-pager {
        display: flex;
        box-shadow: none;
        border: none;
        background: transparent;
        padding: 0;
      }
      #grok-results-grid {
        display: none;
        position: static;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 17px;
        padding: 0;
        width: 100%;
        box-sizing: border-box;
        max-width: none;
        margin: 0;
      }
      html.grok-custom-results-mode [data-grok-native-saved-root="1"],
      html.grok-custom-results-mode [class*="media-post-masonry-card"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      html.grok-filtered-inline-mode #grok-inline-results-viewport #grok-results-grid {
        padding: 0;
        max-width: 1400px;
        margin: 0 auto;
      }
      .grok-result-card {
        position: relative; cursor: pointer; border-radius: 14px;
        overflow: hidden; background: rgba(255,255,255,0.05);
        transition: transform 0.2s, box-shadow 0.2s;
      }
      .grok-result-card--child {
        box-shadow: inset 0 0 0 2px rgba(139, 92, 246, 0.45);
      }
      .grok-result-child-mark {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 4;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 8px;
        background: rgba(88, 28, 135, 0.92);
        border: 1px solid rgba(196, 181, 253, 0.55);
        color: #ede9fe;
        pointer-events: none;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
      }
      .grok-result-child-mark svg { display: block; }
      .grok-result-card:hover { transform: scale(1.03); box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
      .grok-result-card img { width: 100%; display: block; border-radius: 14px; aspect-ratio: 3/4; object-fit: cover; }
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
      .grok-result-badges {
        position: absolute;
        bottom: 8px;
        right: 8px;
        z-index: 3;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 4px;
        pointer-events: none;
      }
      .grok-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 3px 6px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.15);
        font-size: 10px;
        font-weight: 600;
        color: #fff;
        line-height: 1;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .grok-badge-video svg { flex-shrink: 0; }
      .grok-badge-images svg { flex-shrink: 0; }
      .grok-toolbar-btn {
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px;
        color: rgba(255,255,255,0.75);
        font-size: 11px;
        padding: 4px 8px;
        cursor: pointer;
        flex-shrink: 0;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        transition: border-color 0.15s, color 0.15s, background 0.15s;
      }
      .grok-toolbar-btn:hover:not(:disabled) {
        border-color: rgba(139,92,246,0.5);
        color: #fff;
        background: rgba(139,92,246,0.15);
      }
      .grok-toolbar-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }
      #grok-no-results {
        display: none; position: fixed; top: 50%; left: 50%;
        transform: translate(-50%,-50%); z-index: 99998; text-align: center;
        pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        color: rgba(255,255,255,0.3); font-size: 15px;
      }
      #grok-no-results.visible { display: block; }
      #grok-no-results span { display: block; font-size: 36px; margin-bottom: 10px; }
      .grok-filter-check-label {
        display: flex; align-items: center; gap: 5px;
        font-size: 11px; color: rgba(255,255,255,0.55);
        white-space: nowrap; flex-shrink: 0; cursor: pointer;
        user-select: none; transition: color 0.15s;
      }
      .grok-filter-check-label:hover { color: rgba(255,255,255,0.85); }
      .grok-filter-check-label input {
        accent-color: #8b5cf6; cursor: pointer; margin: 0;
      }
      .grok-filter-min-select {
        font-size: 11px; padding: 2px 4px; margin: 0;
        border-radius: 4px; border: 1px solid rgba(255,255,255,0.15);
        background: rgba(0,0,0,0.35); color: rgba(255,255,255,0.85);
        cursor: pointer; flex-shrink: 0;
      }
      .grok-filter-min-select:disabled {
        opacity: 0.35; cursor: default;
      }
    `;
    document.head.appendChild(s);
  }

  // ─── UI ────────────────────────────────────────────────────────────────────
  function getFiltersRow() {
    return document.getElementById('grok-bar-filters');
  }

  function getActionsRow() {
    return document.getElementById('grok-bar-actions');
  }

  function removeLegacyDisplayDefaultButtons() {
    document.getElementById('grok-page-size-default')?.remove();
    document.getElementById('grok-grid-size-default')?.remove();
  }

  function ensureDisplayDefaultButton() {
    removeLegacyDisplayDefaultButtons();
    if (document.getElementById('grok-display-default')) return;
    const row = document.getElementById('grok-results-only-row');
    if (!row) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'grok-display-default';
    btn.className = 'grok-display-default-btn';
    btn.textContent = 'Default';
    btn.title = `Reset to ${DEFAULT_PAGE_SIZE} per page and ${DEFAULT_GRID_SIZE_PCT}% size`;
    row.appendChild(btn);
  }

  function ensureDisplayControls() {
    const row = document.getElementById('grok-results-only-row');
    if (!row) return;

    if (!document.getElementById('grok-page-size-slider')) {
      const perPage = document.createElement('label');
      perPage.className = 'grok-display-control';
      perPage.title = 'Images per page (1–300)';
      perPage.innerHTML = `
        Per page <span class="grok-display-val" id="grok-page-size-val">${DEFAULT_PAGE_SIZE}</span>
        <input type="range" id="grok-page-size-slider" min="${PAGE_SIZE_MIN}" max="${PAGE_SIZE_MAX}" value="${DEFAULT_PAGE_SIZE}" />
      `;
      row.appendChild(perPage);
    }
    if (!document.getElementById('grok-grid-size-slider')) {
      const sizeCtrl = document.createElement('label');
      sizeCtrl.className = 'grok-display-control';
      sizeCtrl.title = 'Thumbnail size (% of default, 10–200)';
      sizeCtrl.innerHTML = `
        Size <span class="grok-display-val" id="grok-grid-size-val">${DEFAULT_GRID_SIZE_PCT}</span>%
        <input type="range" id="grok-grid-size-slider" min="${GRID_SIZE_MIN_PCT}" max="${GRID_SIZE_MAX_PCT}" value="${DEFAULT_GRID_SIZE_PCT}" />
      `;
      row.appendChild(sizeCtrl);
    }

    ensureDisplayDefaultButton();

    bindDisplayControlListeners();
  }

  function bindDisplayControlListeners() {
    const pageSlider = document.getElementById('grok-page-size-slider');
    const gridSlider = document.getElementById('grok-grid-size-slider');
    const defaultBtn = document.getElementById('grok-display-default');
    if (!pageSlider || !gridSlider) return;

    if (!pageSlider.dataset.grokDisplayBound) {
      pageSlider.dataset.grokDisplayBound = '1';
      gridSlider.dataset.grokDisplayBound = '1';

      try {
        pageSize = clampPageSize(localStorage.getItem(PAGE_SIZE_KEY));
        gridSizePercent = clampGridSizePercent(localStorage.getItem(GRID_SIZE_PCT_KEY));
      } catch { /* ignore */ }
      syncDisplayControlLabels();
      applyGridLayoutStyles();

      const onPageSizeChange = () => applyPageSizeSetting(pageSlider.value, true);
      const onGridSizeChange = () => applyGridSizeSetting(gridSlider.value);

      pageSlider.addEventListener('input', onPageSizeChange);
      pageSlider.addEventListener('change', onPageSizeChange);
      gridSlider.addEventListener('input', onGridSizeChange);
      gridSlider.addEventListener('change', onGridSizeChange);
    }

    if (defaultBtn && !defaultBtn.dataset.grokDisplayBound) {
      defaultBtn.dataset.grokDisplayBound = '1';
      defaultBtn.addEventListener('click', applyDisplayDefaults);
    }
  }

  function migrateSearchBarLayout() {
    if (document.getElementById('grok-results-only-row')) return;
    const wrap = document.getElementById('grok-search-wrap');
    const bar = document.getElementById('grok-search-bar');
    if (!wrap || !bar) return;

    const ids = [
      'grok-results-only-label', 'grok-search-icon', 'grok-search-input',
      'grok-stamp-status', 'grok-search-count', 'grok-sort-select',
      'grok-date-prev', 'grok-date-start', 'grok-date-end', 'grok-date-next',
      'grok-filter-video-label',
      'grok-filter-children-label', 'grok-search-clear',
      'grok-export-json-btn', 'grok-reindex-btn',
    ];
    const nodes = {};
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) nodes[id] = el;
    });
    const dateSep = bar.querySelector('.grok-date-sep');

    const resultsRow = document.createElement('div');
    resultsRow.id = 'grok-results-only-row';
    if (nodes['grok-results-only-label']) resultsRow.appendChild(nodes['grok-results-only-label']);

    bar.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'grok-bar-top';
    ['grok-search-icon', 'grok-search-input', 'grok-stamp-status', 'grok-search-count', 'grok-sort-select']
      .forEach(id => { if (nodes[id]) top.appendChild(nodes[id]); });

    const bottom = document.createElement('div');
    bottom.className = 'grok-bar-bottom';
    const filters = document.createElement('div');
    filters.id = 'grok-bar-filters';
    filters.className = 'grok-bar-filters';
    ['grok-date-prev', 'grok-date-start'].forEach(id => { if (nodes[id]) filters.appendChild(nodes[id]); });
    if (dateSep) filters.appendChild(dateSep);
    else {
      const sep = document.createElement('span');
      sep.className = 'grok-date-sep';
      sep.textContent = '–';
      filters.appendChild(sep);
    }
    if (nodes['grok-date-end']) filters.appendChild(nodes['grok-date-end']);
    if (nodes['grok-date-next']) filters.appendChild(nodes['grok-date-next']);
    ['grok-filter-video-label', 'grok-filter-children-label', 'grok-search-clear']
      .forEach(id => { if (nodes[id]) filters.appendChild(nodes[id]); });

    const actions = document.createElement('div');
    actions.id = 'grok-bar-actions';
    actions.className = 'grok-bar-actions';
    ['grok-export-json-btn', 'grok-reindex-btn'].forEach(id => { if (nodes[id]) actions.appendChild(nodes[id]); });

    bottom.appendChild(filters);
    bottom.appendChild(actions);
    bar.appendChild(top);
    bar.appendChild(bottom);

    if (resultsRow.childElementCount > 0) wrap.insertBefore(resultsRow, bar);
    ensureDateNavButtons();
    bindMediaFilterListeners();
  }

  function ensureMediaMinSelect(selectId, labelEl) {
    if (!labelEl || document.getElementById(selectId)) return;
    const sel = document.createElement('select');
    sel.id = selectId;
    sel.className = 'grok-filter-min-select';
    sel.title = 'Minimum count (at least)';
    sel.setAttribute('aria-label', 'Minimum count');
    buildMediaMinSelectOptions(sel);
    labelEl.appendChild(sel);
  }

  function ensureMediaFilterCheckboxes() {
    const filters = getFiltersRow();
    const dateEnd = document.getElementById('grok-date-end');
    if (!filters) return;

    if (!document.getElementById('grok-filter-video')) {
      const videoLabel = document.createElement('label');
      videoLabel.id = 'grok-filter-video-label';
      videoLabel.className = 'grok-filter-check-label';
      videoLabel.title = 'Show only items with at least N videos';
      videoLabel.innerHTML = '<input type="checkbox" id="grok-filter-video" /> Only with video';
      if (dateEnd) dateEnd.insertAdjacentElement('afterend', videoLabel);
      else filters.appendChild(videoLabel);
    }
    if (!document.getElementById('grok-filter-children')) {
      const childLabel = document.createElement('label');
      childLabel.id = 'grok-filter-children-label';
      childLabel.className = 'grok-filter-check-label';
      childLabel.title = 'Show only items with at least N child posts';
      childLabel.innerHTML = '<input type="checkbox" id="grok-filter-children" /> Only with child posts';
      const videoLabel = document.getElementById('grok-filter-video-label');
      (videoLabel || dateEnd || filters).insertAdjacentElement('afterend', childLabel);
    }

    ensureMediaMinSelect('grok-filter-video-min', document.getElementById('grok-filter-video-label'));
    ensureMediaMinSelect('grok-filter-children-min', document.getElementById('grok-filter-children-label'));

    bindMediaFilterListeners();
  }

  function bindMediaFilterListeners() {
    const filterVideoEl = document.getElementById('grok-filter-video');
    const filterChildrenEl = document.getElementById('grok-filter-children');
    const videoMinEl = document.getElementById('grok-filter-video-min');
    const childrenMinEl = document.getElementById('grok-filter-children-min');
    if (!filterVideoEl || !filterChildrenEl || !videoMinEl || !childrenMinEl) return;
    if (filterVideoEl.dataset.grokFilterBound) return;
    filterVideoEl.dataset.grokFilterBound = '1';
    filterChildrenEl.dataset.grokFilterBound = '1';

    try {
      filterOnlyVideo = localStorage.getItem(FILTER_VIDEO_KEY) === '1';
      filterOnlyChildren = localStorage.getItem(FILTER_CHILDREN_KEY) === '1';
      filterMinVideos = parseMediaMin(localStorage.getItem(FILTER_VIDEO_MIN_KEY));
      filterMinChildren = parseMediaMin(localStorage.getItem(FILTER_CHILDREN_MIN_KEY));
    } catch { /* ignore */ }
    syncMediaMinSelects();

    const persistMediaFilters = () => {
      try {
        localStorage.setItem(FILTER_VIDEO_KEY, filterOnlyVideo ? '1' : '0');
        localStorage.setItem(FILTER_CHILDREN_KEY, filterOnlyChildren ? '1' : '0');
        localStorage.setItem(FILTER_VIDEO_MIN_KEY, String(filterMinVideos));
        localStorage.setItem(FILTER_CHILDREN_MIN_KEY, String(filterMinChildren));
      } catch { /* ignore */ }
    };

    const onMediaFilterChange = () => {
      filterOnlyVideo = filterVideoEl.checked;
      filterOnlyChildren = filterChildrenEl.checked;
      filterMinVideos = parseMediaMin(videoMinEl.value);
      filterMinChildren = parseMediaMin(childrenMinEl.value);
      syncMediaMinSelects();
      persistMediaFilters();
      currentPage = 0;
      updateClearButton();
      applyFilter();
    };
    filterVideoEl.addEventListener('change', onMediaFilterChange);
    filterChildrenEl.addEventListener('change', onMediaFilterChange);
    videoMinEl.addEventListener('change', onMediaFilterChange);
    childrenMinEl.addEventListener('change', onMediaFilterChange);
  }

  function ensureExportJsonButton() {
    if (document.getElementById('grok-export-json-btn')) return;
    const actions = getActionsRow();
    if (!actions) return;
    const btn = document.createElement('button');
    btn.id = 'grok-export-json-btn';
    btn.className = 'grok-toolbar-btn';
    btn.type = 'button';
    btn.textContent = 'Export JSON';
    btn.title = 'Download full indexed database as JSON';
    btn.addEventListener('click', () => downloadDatabaseJson());
    actions.prepend(btn);
  }

  function ensureReindexButton() {
    if (document.getElementById('grok-reindex-btn')) return;
    const actions = getActionsRow();
    if (!actions) return;
    const btn = document.createElement('button');
    btn.id = 'grok-reindex-btn';
    btn.className = 'grok-toolbar-btn';
    btn.type = 'button';
    btn.textContent = 'Reindex';
    btn.title = 'Clear cache and reindex from Grok (refreshes child image/video counts)';
    btn.addEventListener('click', () => reindexDatabase());
    actions.appendChild(btn);
  }

  function setSearchBarExpanded(expanded) {
    searchBarExpanded = expanded;
    if (!expanded) {
      try {
        localStorage.setItem(RESULTS_ONLY_KEY, resultsOnly ? '1' : '0');
      } catch { /* ignore */ }
      setResultsOnlyEnabled(false);
      hideAllSearchResults();
      applyNativeVisibility();
    } else {
      setResultsOnlyEnabled(getStoredResultsOnly());
    }
    const wrap = document.getElementById('grok-search-wrap');
    const btn = document.getElementById('grok-search-toggle');
    if (wrap) wrap.classList.toggle('collapsed', !expanded);
    if (btn) {
      btn.title = expanded ? 'Hide search bar' : 'Show search bar';
      btn.setAttribute('aria-expanded', String(expanded));
      btn.innerHTML = expanded
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="6 15 12 9 18 15"/>
           </svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="10" cy="10" r="6"/>
            <line x1="14.5" y1="14.5" x2="20" y2="20"/>
           </svg>`;
    }
    try {
      localStorage.setItem(SEARCH_BAR_COLLAPSED_KEY, expanded ? '0' : '1');
    } catch { /* ignore */ }
  }

  function patchSearchBarCollapseStyles() {
    if (document.getElementById('grok-search-collapse-styles')) return;
    const s = document.createElement('style');
    s.id = 'grok-search-collapse-styles';
    s.textContent = `
      #grok-search-wrap { transition: transform 0.28s ease, opacity 0.22s ease, visibility 0.28s; }
      #grok-search-wrap.collapsed {
        transform: translateX(-50%) translateY(calc(-100% - 24px));
        opacity: 0; visibility: hidden; pointer-events: none;
      }
      #grok-search-toggle {
        position: fixed; right: 16px; bottom: 16px; z-index: 99991;
        width: 44px; height: 44px; border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(15,15,20,0.94); color: rgba(255,255,255,0.9);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 6px 24px rgba(0,0,0,0.45); backdrop-filter: blur(12px); padding: 0;
      }
      #grok-search-toggle:hover {
        border-color: rgba(139,92,246,0.55); background: rgba(139,92,246,0.22); color: #fff;
      }
      #grok-search-toggle svg { width: 20px; height: 20px; }
    `;
    document.head.appendChild(s);
  }

  function readSearchBarExpandedFromStorage() {
    try {
      return localStorage.getItem(SEARCH_BAR_COLLAPSED_KEY) !== '1';
    } catch {
      return true;
    }
  }

  function ensureSearchBarToggle() {
    patchSearchBarCollapseStyles();
    let btn = document.getElementById('grok-search-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'grok-search-toggle';
      btn.setAttribute('aria-label', 'Toggle search bar');
      btn.addEventListener('click', () => setSearchBarExpanded(!searchBarExpanded));
      document.body.appendChild(btn);
    }
    searchBarExpanded = readSearchBarExpandedFromStorage();
    setSearchBarExpanded(searchBarExpanded);
  }

  function buildSearchBar() {
    if (document.getElementById('grok-search-wrap')) {
      migrateSearchBarLayout();
      ensurePageJumpInput();
      ensureExportJsonButton();
      ensureReindexButton();
      ensureMediaFilterCheckboxes();
      ensureDisplayControls();
      ensureDateNavButtons();
      ensureSearchBarToggle();
      return;
    }
    const wrap = document.createElement('div');
    wrap.id = 'grok-search-wrap';
    wrap.innerHTML = `
      <div id="grok-results-only-row">
        <label id="grok-results-only-label" class="grok-filter-check-label" title="Hide Grok saved grid; show only paginated search results">
          <input type="checkbox" id="grok-results-only" checked />
          Results only
        </label>
        <label class="grok-display-control" title="Images per page (1–300)">
          Per page <span class="grok-display-val" id="grok-page-size-val">44</span>
          <input type="range" id="grok-page-size-slider" min="1" max="300" value="44" />
        </label>
        <label class="grok-display-control" title="Thumbnail size (% of default, 10–200)">
          Size <span class="grok-display-val" id="grok-grid-size-val">100</span>%
          <input type="range" id="grok-grid-size-slider" min="10" max="200" value="100" />
        </label>
        <button type="button" id="grok-display-default" class="grok-display-default-btn" title="Reset to 44 per page and 100% size">Default</button>
      </div>
      <div id="grok-search-bar">
        <div class="grok-bar-top">
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
        </div>
        <div class="grok-bar-bottom">
          <div id="grok-bar-filters" class="grok-bar-filters">
            <button type="button" id="grok-date-prev" class="grok-date-nav-btn icon-only" title="Previous day" aria-label="Previous day" disabled>${DATE_NAV_PREV_SVG}</button>
            <input id="grok-date-start" class="grok-date-input" type="date" title="From date" aria-label="From date" />
            <span class="grok-date-sep">–</span>
            <input id="grok-date-end" class="grok-date-input" type="date" title="To date" aria-label="To date" />
            <button type="button" id="grok-date-next" class="grok-date-nav-btn icon-only" title="Next day" aria-label="Next day" disabled>${DATE_NAV_NEXT_SVG}</button>
            <label id="grok-filter-video-label" class="grok-filter-check-label" title="Show only items with at least N videos">
              <input type="checkbox" id="grok-filter-video" />
              Only with video
              <select id="grok-filter-video-min" class="grok-filter-min-select" title="Minimum videos (at least)" aria-label="Minimum videos">
                <option value="1">1</option><option value="3">3</option><option value="5">5</option><option value="7">7</option><option value="10">10</option>
              </select>
            </label>
            <label id="grok-filter-children-label" class="grok-filter-check-label" title="Show only items with at least N child posts">
              <input type="checkbox" id="grok-filter-children" />
              Only with child posts
              <select id="grok-filter-children-min" class="grok-filter-min-select" title="Minimum child posts (at least)" aria-label="Minimum child posts">
                <option value="1">1</option><option value="3">3</option><option value="5">5</option><option value="7">7</option><option value="10">10</option>
              </select>
            </label>
            <button id="grok-search-clear" class="grok-toolbar-btn grok-clear-filters-btn" type="button" title="Clear all filters">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
              </svg>
            </button>
          </div>
          <div id="grok-bar-actions" class="grok-bar-actions">
            <button id="grok-export-json-btn" class="grok-toolbar-btn" type="button" title="Download full indexed database as JSON">Export JSON</button>
            <button id="grok-reindex-btn" class="grok-toolbar-btn" type="button" title="Clear cache and reindex from Grok (refreshes child image/video counts)">Reindex</button>
          </div>
        </div>
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
        <input type="text" id="grok-page-jump" class="grok-page-jump" inputmode="numeric" maxlength="6" title="Go to page (1–N)" aria-label="Page number" />
        <span id="grok-page-label">/ 1</span>
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
    resultsOnly = getStoredResultsOnly();
    syncResultsOnlyCheckbox();
    ensureSearchBarToggle();

    const noResults = document.createElement('div');
    noResults.id = 'grok-no-results';
    noResults.innerHTML = `<span>🔍</span>No images match your search`;
    document.body.appendChild(noResults);

    const input = document.getElementById('grok-search-input');
    const dateStartEl = document.getElementById('grok-date-start');
    const dateEndEl = document.getElementById('grok-date-end');
    const clearBtn = document.getElementById('grok-search-clear');
    const reindexBtn = document.getElementById('grok-reindex-btn');
    const exportJsonBtn = document.getElementById('grok-export-json-btn');
    const sortSel = document.getElementById('grok-sort-select');
    const resultsOnlyEl = document.getElementById('grok-results-only');
    const filterVideoEl = document.getElementById('grok-filter-video');
    const filterChildrenEl = document.getElementById('grok-filter-children');
    const firstBtn = document.getElementById('grok-page-first');
    const pageJumpEl = ensurePageJumpInput();

    try {
      filterOnlyVideo = localStorage.getItem(FILTER_VIDEO_KEY) === '1';
      filterOnlyChildren = localStorage.getItem(FILTER_CHILDREN_KEY) === '1';
      filterMinVideos = parseMediaMin(localStorage.getItem(FILTER_VIDEO_MIN_KEY));
      filterMinChildren = parseMediaMin(localStorage.getItem(FILTER_CHILDREN_MIN_KEY));
      pageSize = clampPageSize(localStorage.getItem(PAGE_SIZE_KEY));
      gridSizePercent = clampGridSizePercent(localStorage.getItem(GRID_SIZE_PCT_KEY));
    } catch { /* ignore */ }
    syncMediaMinSelects();
    bindDisplayControlListeners();
    bindMediaFilterListeners();
    ensureDateNavButtons();
    updateClearButton();
    const prevBtn = document.getElementById('grok-page-prev');
    const nextBtn = document.getElementById('grok-page-next');
    const lastBtn = document.getElementById('grok-page-last');

    const onFilterInput = () => {
      currentPage = 0;
      document.getElementById('grok-no-results').classList.remove('visible');
      applyFilter();
    };

    input.addEventListener('input', () => {
      currentQuery = input.value.trim();
      updateClearButton();
      onFilterInput();
    });

    const onDateChange = () => {
      dateStart = dateStartEl.value;
      dateEnd = dateEndEl.value;
      updateClearButton();
      onFilterInput();
    };
    dateStartEl.addEventListener('change', onDateChange);
    dateEndEl.addEventListener('change', onDateChange);
    dateStartEl.addEventListener('input', onDateChange);
    dateEndEl.addEventListener('input', onDateChange);

    if (reindexBtn) reindexBtn.addEventListener('click', () => reindexDatabase());
    if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => downloadDatabaseJson());

    clearBtn.addEventListener('click', () => {
      input.value = '';
      currentQuery = '';
      dateStartEl.value = '';
      dateEndEl.value = '';
      dateStart = '';
      dateEnd = '';
      filterOnlyVideo = false;
      filterOnlyChildren = false;
      filterMinVideos = 1;
      filterMinChildren = 1;
      syncMediaMinSelects();
      try {
        localStorage.setItem(FILTER_VIDEO_KEY, '0');
        localStorage.setItem(FILTER_CHILDREN_KEY, '0');
        localStorage.setItem(FILTER_VIDEO_MIN_KEY, '1');
        localStorage.setItem(FILTER_CHILDREN_MIN_KEY, '1');
      } catch { /* ignore */ }
      currentPage = 0;
      updateClearButton();
      applyFilter();
      input.focus();
    });

    sortSel.addEventListener('change', () => {
      currentSort = sortSel.value; currentPage = 0;
      applyFilter();
    });

    const onResultsOnlyToggle = () => {
      if (!searchBarExpanded) {
        resultsOnlyEl.checked = false;
        resultsOnly = false;
        return;
      }
      setResultsOnlyEnabled(resultsOnlyEl.checked);
      try {
        localStorage.setItem(RESULTS_ONLY_KEY, resultsOnly ? '1' : '0');
      } catch { /* ignore */ }
    };
    resultsOnlyEl.addEventListener('change', onResultsOnlyToggle);
    resultsOnlyEl.addEventListener('input', onResultsOnlyToggle);

    firstBtn.addEventListener('click', () => { currentPage = 0; showResults(); });
    prevBtn.addEventListener('click', () => { currentPage--; showResults(); });
    nextBtn.addEventListener('click', () => { currentPage++; showResults(); });
    lastBtn.addEventListener('click', () => {
      currentPage = getTotalPages() - 1;
      showResults();
    });

    if (pageJumpEl) bindPageJumpListeners(pageJumpEl);

    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchBarExpanded(true);
        input.focus();
        input.select();
      }
      if (e.key === 'Escape' && document.activeElement === input) input.blur();
      const active = document.activeElement;
      const typingInSearch = active === input;
      const typingInPageJump = active?.id === 'grok-page-jump';
      if (shouldShowSearchResults() && !typingInSearch && !typingInPageJump) {
        if (e.key === 'ArrowRight') { e.preventDefault(); currentPage++; showResults(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); currentPage--; showResults(); }
      }
    });
  }

  let initiated = false;
  function init() {
    if (!isImagineListPage()) return;
    if (initiated) return;
    initiated = true;
    injectStyles();
    buildSearchBar();
    setTimeout(loadAllPosts, 1000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleIncrementalSync('focus');
    }
  });

  let lastUrl = location.href;
  let domEnforceTimer = null;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 800);
      if (isImagineListPage()) scheduleIncrementalSync('navigation');
      return;
    }
    if (!searchBarExpanded) {
      clearTimeout(domEnforceTimer);
      domEnforceTimer = setTimeout(() => {
        hideAllSearchResults();
        applyNativeVisibility();
      }, 350);
      return;
    }
    if (!resultsOnly && !hasActiveFilter()) return;
    clearTimeout(domEnforceTimer);
    domEnforceTimer = setTimeout(scheduleEnforceDisplay, 350);
  }).observe(document.body, { childList: true, subtree: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else if (isImagineListPage()) init();
})();