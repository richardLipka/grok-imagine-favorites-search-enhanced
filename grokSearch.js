// ==UserScript==
// @name         Grok Imagine Favorites Search + Saved Item Pass-Through
// @namespace    http://tampermonkey.net/
// @version      1.55
// @description  Search, filter, and paginate saved Grok media; lightbox, bulk folder download, EXIF prompt tags.
// @author       AnnaLynn (original), Richard Lipka (enhanced fork)
// @homepage     https://github.com/YOUR_USER/YOUR_REPO
// @supportURL   https://github.com/YOUR_USER/YOUR_REPO/issues
// @match        https://grok.com/imagine*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      grok.com
// @connect      *
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js
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
  const FILTER_HIDE_CHILDS_KEY = 'grokSearchFilterHideChilds';
  const PAGE_SIZE_KEY = 'grokSearchPageSize';
  const GRID_SIZE_PCT_KEY = 'grokSearchGridSizePct';
  const SEARCH_BAR_COLLAPSED_KEY = 'grokSearchBarCollapsed';
  const MEDIA_MIN_OPTIONS = [1, 3, 5, 7, 10];
  /** Wait after last keystroke before filtering (ms); capped at 1s. */
  const SEARCH_DEBOUNCE_MS = 400;
  const SEARCH_DEBOUNCE_MAX_MS = 1000;

  let allPosts = [];
  let searchBarExpanded = true;
  const knownIds = new Set();
  let currentQuery = '';
  let dateStart = '';
  let dateEnd = '';
  let resultsOnly = true;
  let filterOnlyVideo = false;
  let filterOnlyChildren = false;
  let filterHideChilds = false;
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
  let renderResultsPending = false;
  let lastIncrementalSyncAt = 0;
  let syncDebounceTimer = null;
  let searchFilterDebounceTimer = null;
  let lightboxIndex = -1;
  let contextMenuPostId = null;
  const selectedPostIds = new Set();
  let bulkDownloadInProgress = false;

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
        setLoadStatus(`syncing… +${newPosts.length + pageNew} new, ${listUpdatedCount} updated`);
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
        setLoadStatus(`deep refresh… ${done}/${targets.length}`);
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
    showLoadingIndicator('Reindexing saved posts…');
    try {
      if (!db) db = await openDB();
      await dbClear();
      setLoadStatus('reindexing…');
      const count = await fetchFullIndex(statusEl);
      loaded = true;
      console.log(`[GrokSearch] Reindex done: ${count} posts`);
      if (statusEl) {
        setLoadStatus(`${count.toLocaleString()} reindexed`);
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
      }
      applyFilter();
    } catch (e) {
      console.error('[GrokSearch] Reindex failed:', e);
      setLoadStatus('reindex failed');
    } finally {
      indexing = false;
      hideLoadingIndicator();
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

  function getActiveResultsFilters() {
    return {
      query: currentQuery,
      dateStart,
      dateEnd,
      filterOnlyVideo,
      filterOnlyChildren,
      filterHideChilds,
      filterMinVideos,
      filterMinChildren,
      sort: currentSort,
      resultsOnly,
    };
  }

  function downloadResultsJson() {
    const statusEl = document.getElementById('grok-stamp-status');
    const buttons = document.querySelectorAll('.grok-download-results-btn');
    buttons.forEach(btn => { btn.disabled = true; });
    try {
      const posts = matchedPosts.map(toStorageRecord);
      const parentCount = posts.filter(p => !p.isChild).length;
      const childCount = posts.filter(p => p.isChild).length;
      const payload = {
        exportedAt: new Date().toISOString(),
        schemaVersion: INDEX_SCHEMA_VERSION,
        source: 'grok-search-results',
        count: posts.length,
        counts: {
          total: posts.length,
          parents: parentCount,
          children: childCount,
        },
        filters: getActiveResultsFilters(),
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
      a.download = `grok-search-results-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (statusEl) {
        statusEl.textContent = `downloaded ${posts.length.toLocaleString()}`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
      console.log(`[GrokSearch] Downloaded ${posts.length} result row(s)`);
    } catch (e) {
      console.error('[GrokSearch] Results download failed:', e);
      if (statusEl) statusEl.textContent = 'download failed';
    } finally {
      syncDownloadResultsButtons();
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
      if (statusEl) setLoadStatus(`indexing… ${allFetched.length.toLocaleString()}`);
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
      if (statusEl) setLoadStatus(`saving… ${Math.min(i + chunkSize, allFetched.length)}/${allFetched.length}`);
    }
    return allFetched.length;
  }

  const DEFAULT_LOADING_MESSAGE = 'Loading saved posts…';

  function isAwaitingInitialDisplay() {
    return !loaded;
  }

  function shouldUseResultsPanelLoading() {
    return shouldShowSearchResults() && resultsOnly;
  }

  function ensureLoadingIndicator() {
    let el = document.getElementById('grok-loading-indicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'grok-loading-indicator';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.innerHTML = `
        <div class="grok-loading-spinner" aria-hidden="true"></div>
        <div class="grok-loading-message" id="grok-loading-message">${DEFAULT_LOADING_MESSAGE}</div>
      `;
      document.body.appendChild(el);
    }
    return el;
  }

  function isLoadingOverlayVisible() {
    return Boolean(
      document.getElementById('grok-loading-indicator')?.classList.contains('visible')
      || document.querySelector('.grok-panel-loading')
    );
  }

  function hideCenteredLoadingIndicator() {
    document.getElementById('grok-loading-indicator')?.classList.remove('visible');
  }

  function hideResultsPanelLoading() {
    document.querySelectorAll('.grok-panel-loading').forEach(el => el.remove());
    const grid = document.getElementById('grok-results-grid');
    if (grid && loaded && matchedPosts.length > 0) grid.style.display = 'grid';
  }

  function showResultsPanelLoading(message = DEFAULT_LOADING_MESSAGE) {
    updateDisplayMode();
    applyNativeVisibility();
    const backdrop = ensureResultsBackdrop();
    const panel = ensureResultsPanel();
    backdrop.style.display = 'block';
    panel.style.display = 'flex';
    layoutPagerInPanel();

    const body = panel.querySelector('.grok-results-panel-body');
    if (body) {
      let loading = body.querySelector('.grok-panel-loading');
      if (!loading) {
        loading = document.createElement('div');
        loading.className = 'grok-panel-loading';
        loading.setAttribute('role', 'status');
        loading.setAttribute('aria-live', 'polite');
        loading.innerHTML = `
          <div class="grok-loading-spinner" aria-hidden="true"></div>
          <div class="grok-loading-message" id="grok-panel-loading-message"></div>
        `;
        body.appendChild(loading);
      }
      const msg = loading.querySelector('.grok-loading-message')
        || loading.querySelector('#grok-panel-loading-message');
      if (msg) msg.textContent = message;
      const grid = document.getElementById('grok-results-grid');
      if (grid) grid.style.display = 'none';
    }

    const title = document.getElementById('grok-panel-title');
    if (title) title.textContent = 'Loading…';
    const range = document.getElementById('grok-panel-range');
    if (range) range.textContent = '';
    const count = document.getElementById('grok-panel-count');
    if (count) count.textContent = '';
    updatePager();
  }

  function showLoadingIndicator(message = DEFAULT_LOADING_MESSAGE) {
    document.getElementById('grok-no-results')?.classList.remove('visible');
    if (shouldUseResultsPanelLoading()) {
      hideCenteredLoadingIndicator();
      showResultsPanelLoading(message);
    } else {
      hideResultsPanelLoading();
      const el = ensureLoadingIndicator();
      const msg = document.getElementById('grok-loading-message');
      if (msg) msg.textContent = message;
      el.classList.add('visible');
      if (shouldShowSearchResults()) applyNativeVisibility();
    }
  }

  function hideLoadingIndicator() {
    hideCenteredLoadingIndicator();
    hideResultsPanelLoading();
    const title = document.getElementById('grok-panel-title');
    if (title) title.textContent = 'Search results';
  }

  function setLoadStatus(text) {
    if (!text) return;
    const statusEl = document.getElementById('grok-stamp-status');
    if (statusEl) statusEl.textContent = text;
    if (!isLoadingOverlayVisible()) return;
    const msg = document.getElementById('grok-panel-loading-message')
      || document.getElementById('grok-loading-message');
    if (msg) msg.textContent = text;
  }

  function syncInitialResultsView() {
    if (!shouldShowSearchResults()) return;
    if (isAwaitingInitialDisplay()) {
      showLoadingIndicator(DEFAULT_LOADING_MESSAGE);
      return;
    }
    applyFilter();
  }

  async function loadAllPosts() {
    if (indexing || loaded) return;
    indexing = true;
    const statusEl = document.getElementById('grok-stamp-status');
    showLoadingIndicator(DEFAULT_LOADING_MESSAGE);
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
        applyFilter();
        if (statusEl) {
          setLoadStatus(`${allPosts.length.toLocaleString()} cached`);
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
        }
        setLoadStatus('syncing…');
        const { newCount, updatedCount: refreshedCount } = await syncLikedFeed(statusEl);
        lastIncrementalSyncAt = Date.now();
        if (statusEl) {
          setLoadStatus(formatSyncStatusMessage(newCount, refreshedCount));
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
        }
      } else {
        setLoadStatus('first-time indexing…');
        const count = await fetchFullIndex(statusEl);
        loaded = true;
        console.log(`[GrokSearch] Full index done: ${count} posts`);
        if (statusEl) {
          setLoadStatus(`${count.toLocaleString()} indexed`);
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
        }
      }
    } catch (e) {
      console.error('[GrokSearch] loadAllPosts failed:', e);
      setLoadStatus('load failed');
    } finally {
      indexing = false;
      if (loaded) {
        applyFilter();
        requestAnimationFrame(() => {
          applyFilter();
          scheduleEnforceDisplay();
        });
        verifyIndexIntegrity();
      } else {
        hideLoadingIndicator();
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

  function layoutResultsGridPlacement(container) {
    if (!container) container = document.getElementById('grok-results-grid');
    if (!container) return null;
    if (resultsOnly) {
      const body = ensureResultsPanel().querySelector('.grok-results-panel-body');
      if (!body) return null;
      body.querySelector('.grok-panel-loading')?.remove();
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
            <span id="grok-panel-download-status" class="grok-panel-download-status"></span>
          </div>
          <div id="grok-panel-count-wrap" class="grok-results-count-wrap">
            <span id="grok-panel-count"></span>
            <button type="button" class="grok-download-results-btn grok-toolbar-btn" title="Download current search results as JSON">Download data</button>
            <button type="button" class="grok-download-selected-btn grok-toolbar-btn" title="Download selected images to a folder">Download selected</button>
            <button type="button" class="grok-check-all-btn grok-toolbar-btn" title="Select all results in current search">Check all</button>
            <button type="button" class="grok-clear-selection-btn grok-toolbar-btn" title="Clear image selection">Clear selection</button>
          </div>
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
            <span id="grok-panel-download-status" class="grok-panel-download-status"></span>
          </div>
          <div id="grok-panel-count-wrap" class="grok-results-count-wrap">
            <span id="grok-panel-count"></span>
            <button type="button" class="grok-download-results-btn grok-toolbar-btn" title="Download current search results as JSON">Download data</button>
            <button type="button" class="grok-download-selected-btn grok-toolbar-btn" title="Download selected images to a folder">Download selected</button>
            <button type="button" class="grok-check-all-btn grok-toolbar-btn" title="Select all results in current search">Check all</button>
            <button type="button" class="grok-clear-selection-btn grok-toolbar-btn" title="Clear image selection">Clear selection</button>
          </div>
        `;
      }
    }
    ensurePanelDownloadStatus();
    ensureDownloadResultsButtons();
    ensureDownloadSelectedButtons();
    return panel;
  }

  function ensurePanelDownloadStatus() {
    const titleWrap = document.querySelector('.grok-results-panel-title-wrap');
    if (!titleWrap || document.getElementById('grok-panel-download-status')) return;
    const status = document.createElement('span');
    status.id = 'grok-panel-download-status';
    status.className = 'grok-panel-download-status';
    titleWrap.appendChild(status);
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
    if (isAwaitingInitialDisplay() && shouldUseResultsPanelLoading()) return;
    hideLoadingIndicator();
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

    if (!loaded) {
      showLoadingIndicator(DEFAULT_LOADING_MESSAGE);
      return;
    }

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
      applyNativeVisibility();
      showLoadingIndicator(DEFAULT_LOADING_MESSAGE);
      return;
    }
    applyFilter();
    scheduleEnforceDisplay();
  }

  function updateResultsOnlyLayout() {
    updateDisplayMode();
  }

  function getPostById(id) {
    if (!id) return null;
    return matchedPosts.find(p => p.id === id) || allPosts.find(p => p.id === id) || null;
  }

  function getPostDetailUrl(id) {
    return id ? `https://grok.com/imagine/post/${id}` : '';
  }

  function getPostMediaUrl(post) {
    return post?.mediaUrl || post?.thumbnail || '';
  }

  function guessMediaExtension(url, mediaType) {
    if (isVideoMediaType(mediaType)) return 'mp4';
    const m = String(url || '').match(/\.([a-z0-9]{3,4})(?:\?|$)/i);
    return m ? m[1].toLowerCase() : 'jpg';
  }

  async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  let downloadStatusClearTimer = null;

  function getPageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined') return unsafeWindow;
    } catch { /* ignore */ }
    return window;
  }

  function setDownloadStatus(text, persist = false) {
    const els = [
      document.getElementById('grok-stamp-status'),
      document.getElementById('grok-panel-download-status'),
    ].filter(Boolean);
    els.forEach(el => { el.textContent = text; });
    clearTimeout(downloadStatusClearTimer);
    if (!text) return;
    if (!persist) {
      downloadStatusClearTimer = setTimeout(() => {
        els.forEach(el => { if (el.textContent === text) el.textContent = ''; });
      }, 4000);
    }
  }

  function flashStampStatus(text) {
    setDownloadStatus(text);
  }

  function getPostDownloadFilename(post) {
    const url = getPostMediaUrl(post);
    if (!url || !post?.id) return '';
    const ext = guessMediaExtension(url, post.mediaType);
    return `grok-${post.id}.${ext}`;
  }

  function fetchPostMediaBlobGm(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 120000,
        onload(res) {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(`HTTP ${res.status}`));
            return;
          }
          const type = String(res.responseHeaders || '').match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim()
            || 'application/octet-stream';
          resolve(new Blob([res.response], { type }));
        },
        onerror() {
          reject(new Error('network error'));
        },
        ontimeout() {
          reject(new Error('timeout'));
        },
      });
    });
  }

  async function fetchPostMediaBlob(post) {
    const url = getPostMediaUrl(post);
    if (!url) throw new Error('no url');
    try {
      const res = await getPageWindow().fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (fetchErr) {
      console.warn('[GrokSearch] fetch failed, using GM_xmlhttpRequest:', fetchErr);
      return fetchPostMediaBlobGm(url);
    }
  }

  const PNG_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function pngCrc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 1);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function arrayBufferToBinaryString(buffer) {
    const bytes = new Uint8Array(buffer);
    const parts = [];
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return parts.join('');
  }

  function binaryStringToArrayBuffer(binary) {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes.buffer;
  }

  function isJpegBytes(u8) {
    return u8.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF;
  }

  function isPngBytes(u8) {
    return u8.length >= 8
      && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47;
  }

  function truncateMetadataText(text, maxLen = 2000) {
    const s = String(text || '').trim();
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen - 1)}…`;
  }

  function embedPromptInJpeg(buffer, prompt) {
    if (typeof piexif === 'undefined') return buffer;
    const text = truncateMetadataText(prompt);
    if (!text) return buffer;
    try {
      const binary = arrayBufferToBinaryString(buffer);
      const zeroth = {};
      const exif = {};
      zeroth[piexif.ImageIFD.ImageDescription] = text;
      exif[piexif.ExifIFD.UserComment] = `ASCII\0\0\0${text}`;
      const exifObj = {
        '0th': zeroth,
        Exif: exif,
        GPS: {},
        Interop: {},
        '1st': {},
        thumbnail: null,
      };
      const exifBytes = piexif.dump(exifObj);
      const newBinary = piexif.insert(exifBytes, binary);
      return binaryStringToArrayBuffer(newBinary);
    } catch (err) {
      console.warn('[GrokSearch] JPEG EXIF embed failed:', err);
      return buffer;
    }
  }

  function buildPngTextChunk(keyword, text) {
    const enc = new TextEncoder();
    const keyBytes = enc.encode(keyword);
    const textBytes = enc.encode(text);
    const data = new Uint8Array(keyBytes.length + 1 + textBytes.length);
    data.set(keyBytes, 0);
    data[keyBytes.length] = 0;
    data.set(textBytes, keyBytes.length + 1);
    const type = enc.encode('tEXt');
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length, false);
    chunk.set(type, 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, pngCrc32(chunk.subarray(4, 8 + data.length)), false);
    return chunk;
  }

  function embedPromptInPng(buffer, prompt) {
    const text = truncateMetadataText(prompt);
    if (!text) return buffer;
    const u8 = new Uint8Array(buffer);
    if (u8.length < 33) return buffer;
    try {
      const chunk = buildPngTextChunk('Description', text);
      const out = new Uint8Array(u8.length + chunk.length);
      out.set(u8.subarray(0, 33), 0);
      out.set(chunk, 33);
      out.set(u8.subarray(33), 33 + chunk.length);
      return out.buffer;
    } catch (err) {
      console.warn('[GrokSearch] PNG metadata embed failed:', err);
      return buffer;
    }
  }

  async function embedPromptInImageBlob(blob, prompt) {
    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);
    let out = buf;
    if (isJpegBytes(u8)) out = embedPromptInJpeg(buf, prompt);
    else if (isPngBytes(u8)) out = embedPromptInPng(buf, prompt);
    if (out === buf) return blob;
    return new Blob([out], { type: blob.type || 'application/octet-stream' });
  }

  function isDownloadableImagePost(post) {
    if (isVideoMediaType(post.mediaType)) return false;
    const url = getPostMediaUrl(post);
    return !/\.mp4(\?|$)/i.test(url);
  }

  async function prepareDownloadBlob(post) {
    const blob = await fetchPostMediaBlob(post);
    if (!isDownloadableImagePost(post)) return blob;
    try {
      return await embedPromptInImageBlob(blob, post.prompt);
    } catch (err) {
      console.warn('[GrokSearch] metadata embed failed:', err);
      return blob;
    }
  }

  function downloadPostMedia(post) {
    const filename = getPostDownloadFilename(post);
    if (!filename) return;
    prepareDownloadBlob(post)
      .then(blob => {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
        flashStampStatus('downloaded');
      })
      .catch(() => flashStampStatus('download failed'));
  }

  function pruneSelection() {
    const validIds = new Set(matchedPosts.map(p => p.id));
    for (const id of selectedPostIds) {
      if (!validIds.has(id)) selectedPostIds.delete(id);
    }
  }

  function syncSelectionOnGrid() {
    document.querySelectorAll('.grok-result-select-input').forEach(input => {
      const id = input.dataset.id;
      const checked = selectedPostIds.has(id);
      input.checked = checked;
      input.closest('.grok-result-card')?.classList.toggle('grok-result-card--selected', checked);
    });
  }

  function selectAllMatchedPosts() {
    matchedPosts.forEach(p => selectedPostIds.add(p.id));
    syncSelectionOnGrid();
    syncDownloadSelectedButtons();
  }

  function clearSelection() {
    selectedPostIds.clear();
    syncSelectionOnGrid();
    syncDownloadSelectedButtons();
  }

  function getSelectedPostsInOrder() {
    return matchedPosts.filter(p => selectedPostIds.has(p.id));
  }

  async function pickDownloadFolder() {
    const pageWin = getPageWindow();
    if (typeof pageWin.showDirectoryPicker !== 'function') {
      throw new Error('unsupported');
    }
    return pageWin.showDirectoryPicker({ mode: 'readwrite' });
  }

  async function ensureDirWritePermission(dirHandle) {
    const opts = { mode: 'readwrite' };
    if (typeof dirHandle.queryPermission === 'function') {
      let perm = await dirHandle.queryPermission(opts);
      if (perm !== 'granted' && typeof dirHandle.requestPermission === 'function') {
        perm = await dirHandle.requestPermission(opts);
      }
      if (perm !== 'granted') throw new Error('permission denied');
    }
  }

  async function saveBlobToFolder(dirHandle, filename, blob) {
    if (!filename) throw new Error('no filename');
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      const data = blob instanceof Blob ? await blob.arrayBuffer() : blob;
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async function downloadSelectedPosts() {
    if (bulkDownloadInProgress) return;
    const posts = getSelectedPostsInOrder();
    if (posts.length === 0) {
      setDownloadStatus('no selection');
      return;
    }
    let dirHandle;
    try {
      dirHandle = await pickDownloadFolder();
      await ensureDirWritePermission(dirHandle);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error('[GrokSearch] folder picker failed:', err);
      setDownloadStatus(
        err?.message === 'unsupported'
          ? 'folder picker unavailable (Chrome/Edge)'
          : 'folder access denied'
      );
      return;
    }

    bulkDownloadInProgress = true;
    syncDownloadSelectedButtons();
    let ok = 0;
    let fail = 0;
    const total = posts.length;
    try {
      setDownloadStatus(`downloading 0/${total}…`, true);
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const filename = getPostDownloadFilename(post);
        if (!filename) {
          fail++;
          continue;
        }
        setDownloadStatus(`downloading ${i + 1}/${total}…`, true);
        try {
          const blob = await prepareDownloadBlob(post);
          await saveBlobToFolder(dirHandle, filename, blob);
          ok++;
        } catch (err) {
          console.error('[GrokSearch] save failed:', post.id, err);
          fail++;
        }
      }
      setDownloadStatus(
        fail === 0
          ? `saved ${ok} file${ok === 1 ? '' : 's'}`
          : `saved ${ok}, failed ${fail}`
      );
    } catch (err) {
      console.error('[GrokSearch] bulk download failed:', err);
      setDownloadStatus('download failed');
    } finally {
      bulkDownloadInProgress = false;
      syncDownloadSelectedButtons();
    }
  }

  function ensureResultContextMenu() {
    let menu = document.getElementById('grok-result-context-menu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'grok-result-context-menu';
    menu.className = 'grok-result-context-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    document.body.appendChild(menu);
    return menu;
  }

  function hideResultContextMenu() {
    const menu = document.getElementById('grok-result-context-menu');
    if (menu) menu.hidden = true;
    contextMenuPostId = null;
  }

  function positionFloatingMenu(menu, x, y) {
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.hidden = false;
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (rect.right > window.innerWidth - pad) left = Math.max(pad, x - rect.width);
    if (rect.bottom > window.innerHeight - pad) top = Math.max(pad, y - rect.height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function buildContextMenuItems(post) {
    const items = [
      { action: 'open', label: 'Open' },
      { action: 'open-tab', label: 'Open on new tab' },
      { action: 'copy-prompt', label: 'Copy prompt' },
      { action: 'copy-url', label: 'Copy URL' },
      { action: 'download', label: 'Download image' },
    ];
    const dateKey = formatPostDateKey(post.createTime);
    if (dateKey) {
      items.push({ action: 'filter-date', label: 'Filter to post\'s date' });
    }
    if (isChildPost(post) && post.parentId) {
      items.push({ action: 'open-parent', label: 'Open parent post' });
    }
    return items;
  }

  function showResultContextMenu(clientX, clientY, post) {
    const menu = ensureResultContextMenu();
    contextMenuPostId = post.id;
    menu.innerHTML = buildContextMenuItems(post).map(item => `
      <button type="button" class="grok-result-context-item" role="menuitem" data-action="${escapeHtml(item.action)}">
        ${escapeHtml(item.label)}
      </button>
    `).join('');
    menu.querySelectorAll('.grok-result-context-item').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.dataset.action;
        const target = getPostById(contextMenuPostId);
        hideResultContextMenu();
        if (target) runContextMenuAction(action, target);
      });
    });
    positionFloatingMenu(menu, clientX, clientY);
  }

  async function runContextMenuAction(action, post) {
    switch (action) {
      case 'open':
        openResultLightbox(post);
        break;
      case 'open-tab':
        if (post.id) window.open(getPostDetailUrl(post.id), '_blank');
        else window.open(getPostMediaUrl(post), '_blank');
        break;
      case 'copy-prompt':
        if (await copyText(post.prompt)) flashStampStatus('prompt copied');
        break;
      case 'copy-url':
        if (await copyText(getPostMediaUrl(post))) flashStampStatus('URL copied');
        break;
      case 'download':
        downloadPostMedia(post);
        break;
      case 'filter-date': {
        const dateKey = formatPostDateKey(post.createTime);
        if (dateKey) applyDateFilterForDay(dateKey);
        break;
      }
      case 'open-parent':
        if (post.parentId) window.open(getPostDetailUrl(post.parentId), '_blank');
        break;
      default:
        break;
    }
  }

  function ensureResultLightbox() {
    let lb = document.getElementById('grok-result-lightbox');
    if (lb) return lb;
    lb = document.createElement('div');
    lb.id = 'grok-result-lightbox';
    lb.className = 'grok-result-lightbox';
    lb.hidden = true;
    lb.innerHTML = `
      <div class="grok-lightbox-backdrop" data-grok-lightbox-close></div>
      <div class="grok-lightbox-panel" role="dialog" aria-modal="true" aria-label="Image preview">
        <button type="button" class="grok-lightbox-close" data-grok-lightbox-close title="Close" aria-label="Close">×</button>
        <button type="button" class="grok-lightbox-nav grok-lightbox-prev" id="grok-lightbox-prev" title="Previous" aria-label="Previous">‹</button>
        <button type="button" class="grok-lightbox-nav grok-lightbox-next" id="grok-lightbox-next" title="Next" aria-label="Next">›</button>
        <div class="grok-lightbox-stage" id="grok-lightbox-stage"></div>
        <div class="grok-lightbox-footer">
          <div class="grok-lightbox-meta">
            <div class="grok-lightbox-prompt" id="grok-lightbox-prompt"></div>
            <div class="grok-lightbox-sub" id="grok-lightbox-sub"></div>
          </div>
          <div class="grok-lightbox-actions">
            <button type="button" class="grok-toolbar-btn" id="grok-lightbox-open-tab">Open on new tab</button>
            <button type="button" class="grok-toolbar-btn" id="grok-lightbox-open-post">Open post</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(lb);

    lb.querySelectorAll('[data-grok-lightbox-close]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        closeResultLightbox();
      });
    });
    document.getElementById('grok-lightbox-prev')?.addEventListener('click', e => {
      e.preventDefault();
      stepResultLightbox(-1);
    });
    document.getElementById('grok-lightbox-next')?.addEventListener('click', e => {
      e.preventDefault();
      stepResultLightbox(1);
    });
    document.getElementById('grok-lightbox-open-tab')?.addEventListener('click', e => {
      e.preventDefault();
      const post = matchedPosts[lightboxIndex];
      if (!post) return;
      if (post.id) window.open(getPostDetailUrl(post.id), '_blank');
      else window.open(getPostMediaUrl(post), '_blank');
    });
    document.getElementById('grok-lightbox-open-post')?.addEventListener('click', e => {
      e.preventDefault();
      const post = matchedPosts[lightboxIndex];
      if (post?.id) window.open(getPostDetailUrl(post.id), '_blank');
    });

    return lb;
  }

  function renderResultLightbox() {
    const lb = ensureResultLightbox();
    const post = matchedPosts[lightboxIndex];
    const stage = document.getElementById('grok-lightbox-stage');
    const promptEl = document.getElementById('grok-lightbox-prompt');
    const subEl = document.getElementById('grok-lightbox-sub');
    const prevBtn = document.getElementById('grok-lightbox-prev');
    const nextBtn = document.getElementById('grok-lightbox-next');
    if (!post || !stage || !promptEl || !subEl) return;

    const mediaUrl = getPostMediaUrl(post);
    const isVideo = isVideoMediaType(post.mediaType) || /\.mp4(\?|$)/i.test(mediaUrl);
    stage.innerHTML = isVideo
      ? `<video class="grok-lightbox-media" src="${escapeHtml(mediaUrl)}" controls autoplay playsinline></video>`
      : `<img class="grok-lightbox-media" src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(post.prompt)}" />`;

    promptEl.textContent = post.prompt || '(no prompt)';
    const bits = [];
    bits.push(`${lightboxIndex + 1} / ${matchedPosts.length.toLocaleString()}`);
    const dateStr = formatPostDate(post.createTime);
    if (dateStr) bits.push(dateStr);
    if (isChildPost(post)) bits.push('Child post');
    subEl.textContent = bits.join(' · ');

    if (prevBtn) prevBtn.disabled = lightboxIndex <= 0;
    if (nextBtn) nextBtn.disabled = lightboxIndex >= matchedPosts.length - 1;
    lb.hidden = false;
    document.documentElement.classList.add('grok-lightbox-open');
  }

  function openResultLightbox(post) {
    const idx = matchedPosts.findIndex(p => p.id === post.id);
    if (idx < 0) return;
    hideResultContextMenu();
    lightboxIndex = idx;
    renderResultLightbox();
  }

  function closeResultLightbox() {
    const lb = document.getElementById('grok-result-lightbox');
    if (lb) {
      lb.hidden = true;
      const video = lb.querySelector('video');
      if (video) video.pause();
    }
    document.documentElement.classList.remove('grok-lightbox-open');
    lightboxIndex = -1;
  }

  function stepResultLightbox(delta) {
    if (lightboxIndex < 0 || !matchedPosts.length) return;
    const next = Math.max(0, Math.min(matchedPosts.length - 1, lightboxIndex + delta));
    if (next === lightboxIndex) return;
    lightboxIndex = next;
    renderResultLightbox();
  }

  function bindGlobalResultUiListeners() {
    if (document.body.dataset.grokResultUiBound) return;
    document.body.dataset.grokResultUiBound = '1';

    document.addEventListener('click', e => {
      if (!e.target.closest('#grok-result-context-menu')) hideResultContextMenu();
    });
    document.addEventListener('scroll', hideResultContextMenu, true);
    window.addEventListener('resize', hideResultContextMenu);

    document.addEventListener('keydown', e => {
      const lbOpen = lightboxIndex >= 0 && !document.getElementById('grok-result-lightbox')?.hidden;
      if (lbOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeResultLightbox();
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          stepResultLightbox(-1);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          stepResultLightbox(1);
          return;
        }
      }
      if (e.key === 'Escape') hideResultContextMenu();
    }, true);
  }

  function flushSearchFilter() {
    clearTimeout(searchFilterDebounceTimer);
    searchFilterDebounceTimer = null;
    applyFilter();
  }

  function scheduleSearchFilter() {
    clearTimeout(searchFilterDebounceTimer);
    const delay = Math.min(SEARCH_DEBOUNCE_MS, SEARCH_DEBOUNCE_MAX_MS);
    searchFilterDebounceTimer = setTimeout(() => {
      searchFilterDebounceTimer = null;
      applyFilter();
    }, delay);
  }

  function ensureSearchInputListener() {
    const input = document.getElementById('grok-search-input');
    if (!input || input.dataset.grokSearchInputBound) return;
    input.dataset.grokSearchInputBound = '1';
    input.addEventListener('input', () => {
      currentQuery = input.value;
      updateClearButton();
      currentPage = 0;
      document.getElementById('grok-no-results')?.classList.remove('visible');
      scheduleSearchFilter();
    });
    input.addEventListener('blur', () => {
      if (searchFilterDebounceTimer) flushSearchFilter();
    });
  }

  function bindResultsGridInteractions(container) {
    if (!container || container.dataset.grokInteractionsBound) return;
    container.dataset.grokInteractionsBound = '1';
    bindGlobalResultUiListeners();

    container.addEventListener('contextmenu', e => {
      if (e.target.closest('.grok-result-date')) return;
      const card = e.target.closest('.grok-result-card');
      if (!card || !container.contains(card)) return;
      e.preventDefault();
      e.stopPropagation();
      const post = getPostById(card.dataset.id);
      if (!post) return;
      showResultContextMenu(e.clientX, e.clientY, post);
    });

    container.addEventListener('change', e => {
      const input = e.target.closest('.grok-result-select-input');
      if (!input || !container.contains(input)) return;
      const id = input.dataset.id;
      if (!id) return;
      if (input.checked) selectedPostIds.add(id);
      else selectedPostIds.delete(id);
      const card = input.closest('.grok-result-card');
      if (card) card.classList.toggle('grok-result-card--selected', input.checked);
      syncDownloadSelectedButtons();
    });

    container.addEventListener('click', e => {
      if (e.target.closest('.grok-result-select')) {
        e.stopPropagation();
        return;
      }
      if (e.target.closest('.grok-result-date')) {
        e.preventDefault();
        e.stopPropagation();
        applyDateFilterForDay(e.target.closest('.grok-result-date').dataset.date);
        return;
      }
      const card = e.target.closest('.grok-result-card');
      if (!card || !container.contains(card)) return;
      e.preventDefault();
      e.stopPropagation();
      const post = getPostById(card.dataset.id);
      if (post) {
        openResultLightbox(post);
      } else if (card.dataset.media) {
        window.open(card.dataset.media, '_blank');
      }
    });
  }

  function showResults() {
    if (rendering) {
      renderResultsPending = true;
      return;
    }
    rendering = true;
    renderResultsPending = false;

    hideLoadingIndicator();

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
    if (!layoutResultsGridPlacement(container)) {
      rendering = false;
      if (renderResultsPending) {
        renderResultsPending = false;
        showResults();
      }
      console.warn('[GrokSearch] Could not place results grid');
      return;
    }

    container.innerHTML = page.map(post => {
      const dateKey = formatPostDateKey(post.createTime);
      const dateStr = formatPostDate(post.createTime);
      const dateActive = dateKey && isFilteredToSingleDay(dateKey) ? ' grok-result-date-active' : '';
      const childCard = isChildPost(post);
      const selected = selectedPostIds.has(post.id);
      const cardClass = childCard ? ' grok-result-card--child' : '';
      const selectedClass = selected ? ' grok-result-card--selected' : '';
      const childMark = childCard
        ? `<span class="grok-result-child-mark" title="Child post">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
              <path d="M6 3v12"/><circle cx="6" cy="18" r="2"/><path d="M18 7v14"/><circle cx="18" cy="5" r="2"/>
            </svg>
           </span>`
        : '';
      return `
      <div class="grok-result-card${cardClass}${selectedClass}" data-id="${escapeHtml(post.id)}" data-media="${escapeHtml(post.mediaUrl)}" title="${escapeHtml(post.prompt)}">
        <label class="grok-result-select" title="Select for download">
          <input type="checkbox" class="grok-result-select-input" data-id="${escapeHtml(post.id)}"${selected ? ' checked' : ''} />
        </label>
        ${childMark}
        ${dateStr ? `<div class="grok-result-date${dateActive}" data-date="${escapeHtml(dateKey)}" title="Filter to ${escapeHtml(dateStr)} (click again to clear)">${escapeHtml(dateStr)}</div>` : ''}
        <img src="${escapeHtml(post.thumbnail)}" alt="${escapeHtml(post.prompt)}" loading="lazy" style="width:100%; display:block; border-radius:14px; aspect-ratio:3/4; object-fit:cover;" />
        <div class="grok-result-prompt">${escapeHtml(post.prompt)}</div>
        ${renderResultBadges(post)}
      </div>`;
    }).join('');

    bindResultsGridInteractions(container);

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

    rendering = false;
    if (renderResultsPending) {
      renderResultsPending = false;
      showResults();
    }
  }

  function hideResults() {
    hideAllSearchResults();
    applyNativeVisibility();
    updatePager();
  }

  function applyFilter() {
    if (!loaded) {
      showLoadingIndicator(DEFAULT_LOADING_MESSAGE);
      return;
    }

    const inputEl = document.getElementById('grok-search-input');
    if (inputEl) currentQuery = inputEl.value;

    updateDisplayMode();

    const queryLower = (currentQuery || '').toLowerCase().trim();
    const terms = queryLower ? queryLower.split(/\s+/).filter(Boolean) : [];
    const parentPromptById = terms.length > 0 ? buildParentPromptIndex() : null;

    matchedPosts = allPosts.filter(post => {
      if (filterHideChilds && isChildPost(post)) return false;
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

    pruneSelection();
    syncResultsView();
    syncDownloadSelectedButtons();
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
    if (isAwaitingInitialDisplay()) {
      showLoadingIndicator(DEFAULT_LOADING_MESSAGE);
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
    if (hasText || hasDates || filterOnlyVideo || filterOnlyChildren || filterHideChilds) {
      countText = `${n} match${matchedPosts.length !== 1 ? 'es' : ''}`;
    } else {
      countText = `${n} saved`;
    }
    if (countEl) countEl.textContent = countText;
    const panelCountEl = document.getElementById('grok-panel-count');
    if (panelCountEl) panelCountEl.textContent = countText;
    syncDownloadResultsButtons();

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
    const filterHideChildsEl = document.getElementById('grok-filter-hide-childs');
    if (filterHideChildsEl) filterHideChildsEl.checked = filterHideChilds;
  }

  function hasDateFilter() {
    return Boolean(dateStart || dateEnd);
  }

  function hasActiveFilter() {
    return Boolean(
      currentQuery.trim() || hasDateFilter() || filterOnlyVideo || filterOnlyChildren || filterHideChilds
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
        display: flex;
        align-items: center;
        font-size: 11px; color: rgba(255,255,255,0.4);
        white-space: nowrap; font-variant-numeric: tabular-nums; flex-shrink: 0;
        line-height: 1;
      }
      .grok-results-count-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        line-height: 1;
      }
      #grok-search-count-wrap {
        display: inline-flex;
      }
      .grok-download-results-btn,
      .grok-download-selected-btn,
      .grok-check-all-btn,
      .grok-clear-selection-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        padding: 3px 7px;
        line-height: 1;
        white-space: nowrap;
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
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2;
        padding: 5px 10px;
        font-size: 10px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.95);
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        pointer-events: auto;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .grok-result-date:hover {
        background: rgba(139, 92, 246, 0.65);
        border-color: rgba(196, 181, 253, 0.45);
        color: #fff;
      }
      .grok-result-date-active {
        background: rgba(139, 92, 246, 0.82);
        border-color: rgba(196, 181, 253, 0.55);
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
      .grok-panel-download-status {
        font-size: 11px;
        color: rgba(139, 92, 246, 0.95);
        line-height: 1.35;
        min-height: 1.35em;
      }
      .grok-panel-download-status:empty { display: none; }
      #grok-panel-count {
        display: flex;
        align-items: center;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.45);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        line-height: 1;
      }
      #grok-panel-count-wrap {
        align-items: center;
        align-self: center;
        flex-shrink: 0;
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
      .grok-result-select {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 5;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.06);
        cursor: pointer;
        opacity: 0.28;
        transition: background 0.15s, border-color 0.15s, opacity 0.15s;
      }
      .grok-result-card:hover .grok-result-select {
        opacity: 0.7;
        background: rgba(0, 0, 0, 0.45);
        border-color: rgba(255, 255, 255, 0.14);
      }
      .grok-result-select:hover {
        opacity: 1;
        background: rgba(0, 0, 0, 0.72);
        border-color: rgba(139, 92, 246, 0.45);
      }
      .grok-result-select:has(.grok-result-select-input:checked),
      .grok-result-card--selected .grok-result-select {
        opacity: 1;
        background: rgba(0, 0, 0, 0.72);
        border-color: rgba(139, 92, 246, 0.55);
      }
      .grok-result-select-input {
        width: 16px;
        height: 16px;
        margin: 0;
        cursor: pointer;
        accent-color: #8b5cf6;
        opacity: 0.45;
      }
      .grok-result-card:hover .grok-result-select-input,
      .grok-result-select:hover .grok-result-select-input,
      .grok-result-select:has(.grok-result-select-input:checked) .grok-result-select-input {
        opacity: 1;
      }
      .grok-result-card--selected {
        box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.75);
      }
      .grok-result-card--child.grok-result-card--selected {
        box-shadow: inset 0 0 0 2px rgba(139, 92, 246, 0.45), 0 0 0 2px rgba(139, 92, 246, 0.75);
      }
      .grok-result-card:hover { transform: scale(1.03); box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
      .grok-result-card--selected:hover {
        box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.75), 0 8px 32px rgba(0,0,0,0.5);
      }
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
      .grok-result-context-menu {
        position: fixed;
        z-index: 100002;
        min-width: 190px;
        padding: 6px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(18, 18, 26, 0.98);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(12px);
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .grok-result-context-menu[hidden] { display: none !important; }
      .grok-result-context-item {
        display: block;
        width: 100%;
        text-align: left;
        border: none;
        background: transparent;
        color: rgba(255, 255, 255, 0.88);
        font-size: 12px;
        line-height: 1.3;
        padding: 8px 10px;
        border-radius: 7px;
        cursor: pointer;
      }
      .grok-result-context-item:hover {
        background: rgba(139, 92, 246, 0.22);
        color: #fff;
      }
      .grok-result-lightbox {
        position: fixed;
        inset: 0;
        z-index: 100003;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        box-sizing: border-box;
      }
      .grok-result-lightbox[hidden] { display: none !important; }
      .grok-lightbox-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.88);
      }
      .grok-lightbox-panel {
        position: relative;
        z-index: 1;
        width: min(1100px, 96vw);
        max-height: 92vh;
        display: flex;
        flex-direction: column;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: #14141c;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.65);
        overflow: hidden;
      }
      .grok-lightbox-close {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 3;
        width: 34px;
        height: 34px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.55);
        color: #fff;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
      }
      .grok-lightbox-nav {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        z-index: 3;
        width: 40px;
        height: 56px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.55);
        color: #fff;
        font-size: 28px;
        line-height: 1;
        cursor: pointer;
      }
      .grok-lightbox-nav:disabled {
        opacity: 0.25;
        cursor: default;
      }
      .grok-lightbox-prev { left: 10px; }
      .grok-lightbox-next { right: 10px; }
      .grok-lightbox-stage {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 240px;
        max-height: calc(92vh - 150px);
        background: #0b0b10;
        padding: 16px;
      }
      .grok-lightbox-media {
        max-width: 100%;
        max-height: calc(92vh - 180px);
        object-fit: contain;
        border-radius: 10px;
      }
      .grok-lightbox-footer {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        background: #1a1a24;
      }
      .grok-lightbox-meta { min-width: 0; flex: 1; }
      .grok-lightbox-prompt {
        font-size: 13px;
        line-height: 1.45;
        color: rgba(255, 255, 255, 0.92);
        word-break: break-word;
      }
      .grok-lightbox-sub {
        margin-top: 4px;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
      }
      .grok-lightbox-actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
      }
      html.grok-lightbox-open { overflow: hidden; }
      #grok-no-results {
        display: none; position: fixed; top: 50%; left: 50%;
        transform: translate(-50%,-50%); z-index: 99998; text-align: center;
        pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        color: rgba(255,255,255,0.3); font-size: 15px;
      }
      #grok-no-results.visible { display: block; }
      #grok-no-results span { display: block; font-size: 36px; margin-bottom: 10px; }
      #grok-loading-indicator {
        display: none;
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 99998;
        flex-direction: column;
        align-items: center;
        gap: 14px;
        text-align: center;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        color: rgba(255, 255, 255, 0.55);
        font-size: 14px;
      }
      #grok-loading-indicator.visible { display: flex; }
      .grok-loading-spinner {
        width: 36px;
        height: 36px;
        border: 3px solid rgba(255, 255, 255, 0.12);
        border-top-color: #8b5cf6;
        border-radius: 50%;
        animation: grok-spin 0.85s linear infinite;
      }
      @keyframes grok-spin { to { transform: rotate(360deg); } }
      .grok-loading-message {
        max-width: 300px;
        line-height: 1.45;
        color: rgba(255, 255, 255, 0.72);
      }
      .grok-panel-loading {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        min-height: min(50vh, 420px);
        padding: 48px 24px;
        text-align: center;
      }
      .grok-panel-loading .grok-loading-spinner {
        width: 44px;
        height: 44px;
        border-width: 4px;
      }
      .grok-panel-loading .grok-loading-message {
        font-size: 15px;
        color: rgba(255, 255, 255, 0.82);
      }
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
      'grok-filter-children-label', 'grok-filter-hide-childs-label', 'grok-search-clear',
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
    ['grok-filter-video-label', 'grok-filter-children-label', 'grok-filter-hide-childs-label', 'grok-search-clear']
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
      videoLabel.innerHTML = '<input type="checkbox" id="grok-filter-video" /> Video';
      if (dateEnd) dateEnd.insertAdjacentElement('afterend', videoLabel);
      else filters.appendChild(videoLabel);
    }
    if (!document.getElementById('grok-filter-children')) {
      const childLabel = document.createElement('label');
      childLabel.id = 'grok-filter-children-label';
      childLabel.className = 'grok-filter-check-label';
      childLabel.title = 'Show only items with at least N child posts';
      childLabel.innerHTML = '<input type="checkbox" id="grok-filter-children" /> With child';
      const videoLabel = document.getElementById('grok-filter-video-label');
      (videoLabel || dateEnd || filters).insertAdjacentElement('afterend', childLabel);
    }
    ensureHideChildsCheckbox();

    ensureMediaMinSelect('grok-filter-video-min', document.getElementById('grok-filter-video-label'));
    ensureMediaMinSelect('grok-filter-children-min', document.getElementById('grok-filter-children-label'));

    bindMediaFilterListeners();
  }

  function loadHideChildsFilterFromStorage() {
    try {
      const stored = localStorage.getItem(FILTER_HIDE_CHILDS_KEY);
      if (stored !== null && stored !== '') {
        filterHideChilds = stored === '1';
        return;
      }
      const legacyShow = localStorage.getItem('grokSearchFilterShowChilds');
      if (legacyShow !== null && legacyShow !== '') {
        filterHideChilds = legacyShow !== '1';
      }
    } catch { /* ignore */ }
  }

  function ensureHideChildsCheckbox() {
    document.getElementById('grok-filter-show-childs-label')?.remove();
    const filters = getFiltersRow();
    const dateEnd = document.getElementById('grok-date-end');
    if (!filters || document.getElementById('grok-filter-hide-childs')) return;

    const hideChildsLabel = document.createElement('label');
    hideChildsLabel.id = 'grok-filter-hide-childs-label';
    hideChildsLabel.className = 'grok-filter-check-label';
    hideChildsLabel.title = 'Hide child posts from results (parents only)';
    hideChildsLabel.innerHTML = '<input type="checkbox" id="grok-filter-hide-childs" /> Hide childs';
    const childFilterLabel = document.getElementById('grok-filter-children-label');
    (childFilterLabel || dateEnd || filters).insertAdjacentElement('afterend', hideChildsLabel);
  }

  function bindMediaFilterListeners() {
    ensureHideChildsCheckbox();
    const filterVideoEl = document.getElementById('grok-filter-video');
    const filterChildrenEl = document.getElementById('grok-filter-children');
    const filterHideChildsEl = document.getElementById('grok-filter-hide-childs');
    const videoMinEl = document.getElementById('grok-filter-video-min');
    const childrenMinEl = document.getElementById('grok-filter-children-min');
    if (!filterVideoEl || !filterChildrenEl || !filterHideChildsEl || !videoMinEl || !childrenMinEl) return;

    const persistMediaFilters = () => {
      try {
        localStorage.setItem(FILTER_VIDEO_KEY, filterOnlyVideo ? '1' : '0');
        localStorage.setItem(FILTER_CHILDREN_KEY, filterOnlyChildren ? '1' : '0');
        localStorage.setItem(FILTER_HIDE_CHILDS_KEY, filterHideChilds ? '1' : '0');
        localStorage.setItem(FILTER_VIDEO_MIN_KEY, String(filterMinVideos));
        localStorage.setItem(FILTER_CHILDREN_MIN_KEY, String(filterMinChildren));
      } catch { /* ignore */ }
    };

    const onMediaFilterChange = () => {
      filterOnlyVideo = filterVideoEl.checked;
      filterOnlyChildren = filterChildrenEl.checked;
      filterHideChilds = filterHideChildsEl.checked;
      filterMinVideos = parseMediaMin(videoMinEl.value);
      filterMinChildren = parseMediaMin(childrenMinEl.value);
      syncMediaMinSelects();
      persistMediaFilters();
      currentPage = 0;
      updateClearButton();
      applyFilter();
    };

    if (!filterVideoEl.dataset.grokFilterBound) {
      filterVideoEl.dataset.grokFilterBound = '1';
      filterChildrenEl.dataset.grokFilterBound = '1';
      try {
        filterOnlyVideo = localStorage.getItem(FILTER_VIDEO_KEY) === '1';
        filterOnlyChildren = localStorage.getItem(FILTER_CHILDREN_KEY) === '1';
        filterMinVideos = parseMediaMin(localStorage.getItem(FILTER_VIDEO_MIN_KEY));
        filterMinChildren = parseMediaMin(localStorage.getItem(FILTER_CHILDREN_MIN_KEY));
      } catch { /* ignore */ }
      filterVideoEl.addEventListener('change', onMediaFilterChange);
      filterChildrenEl.addEventListener('change', onMediaFilterChange);
      videoMinEl.addEventListener('change', onMediaFilterChange);
      childrenMinEl.addEventListener('change', onMediaFilterChange);
    }

    loadHideChildsFilterFromStorage();
    syncMediaMinSelects();

    if (!filterHideChildsEl.dataset.grokFilterBound) {
      filterHideChildsEl.dataset.grokFilterBound = '1';
      filterHideChildsEl.addEventListener('change', onMediaFilterChange);
      filterHideChildsEl.addEventListener('input', onMediaFilterChange);
    }
  }

  function stripSearchBarActionButtons() {
    const wrap = document.getElementById('grok-search-count-wrap');
    if (!wrap) return;
    wrap.querySelectorAll(
      '.grok-download-results-btn, .grok-check-all-btn, .grok-clear-selection-btn'
    ).forEach(el => el.remove());
  }

  function ensureDownloadResultsButtons() {
    const toolbarCount = document.getElementById('grok-search-count');
    if (toolbarCount && !document.getElementById('grok-search-count-wrap')) {
      const wrap = document.createElement('span');
      wrap.id = 'grok-search-count-wrap';
      wrap.className = 'grok-results-count-wrap';
      toolbarCount.parentElement?.insertBefore(wrap, toolbarCount);
      wrap.appendChild(toolbarCount);
    }
    stripSearchBarActionButtons();

    const panelCount = document.getElementById('grok-panel-count');
    if (panelCount && !document.getElementById('grok-panel-count-wrap')) {
      const wrap = document.createElement('div');
      wrap.id = 'grok-panel-count-wrap';
      wrap.className = 'grok-results-count-wrap';
      panelCount.parentElement?.insertBefore(wrap, panelCount);
      wrap.appendChild(panelCount);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'grok-download-results-btn grok-toolbar-btn';
      btn.title = 'Download current search results as JSON';
      btn.textContent = 'Download data';
      wrap.appendChild(btn);
    }

    document.querySelectorAll('.grok-download-results-btn').forEach(btn => {
      if (btn.dataset.grokDownloadResultsBound) return;
      btn.dataset.grokDownloadResultsBound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        downloadResultsJson();
      });
    });
    syncDownloadResultsButtons();
  }

  function syncDownloadResultsButtons() {
    const disabled = matchedPosts.length === 0;
    document.querySelectorAll('.grok-download-results-btn').forEach(btn => {
      btn.disabled = disabled;
    });
  }

  function appendSelectionToolbarButton(wrap, className, text, title) {
    if (!wrap || wrap.querySelector(`.${className}`)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${className} grok-toolbar-btn`;
    btn.title = title;
    btn.textContent = text;
    wrap.appendChild(btn);
  }

  function ensureDownloadSelectedButtons() {
    stripSearchBarActionButtons();
    const toolbarWrap = document.getElementById('grok-search-count-wrap');
    appendSelectionToolbarButton(
      toolbarWrap,
      'grok-download-selected-btn',
      'Download selected',
      'Download selected images to a folder'
    );

    const panelWrap = document.getElementById('grok-panel-count-wrap');
    appendSelectionToolbarButton(
      panelWrap,
      'grok-download-selected-btn',
      'Download selected',
      'Download selected images to a folder'
    );
    appendSelectionToolbarButton(
      panelWrap,
      'grok-check-all-btn',
      'Check all',
      'Select all results in current search'
    );
    appendSelectionToolbarButton(
      panelWrap,
      'grok-clear-selection-btn',
      'Clear selection',
      'Clear image selection'
    );

    document.querySelectorAll('.grok-download-selected-btn').forEach(btn => {
      if (btn.dataset.grokDownloadSelectedBound) return;
      btn.dataset.grokDownloadSelectedBound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        downloadSelectedPosts();
      });
    });
    document.querySelectorAll('.grok-check-all-btn').forEach(btn => {
      if (btn.dataset.grokCheckAllBound) return;
      btn.dataset.grokCheckAllBound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        selectAllMatchedPosts();
      });
    });
    document.querySelectorAll('.grok-clear-selection-btn').forEach(btn => {
      if (btn.dataset.grokClearSelectionBound) return;
      btn.dataset.grokClearSelectionBound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
      });
    });
    syncDownloadSelectedButtons();
  }

  function syncDownloadSelectedButtons() {
    const count = selectedPostIds.size;
    const total = matchedPosts.length;
    const busy = bulkDownloadInProgress;
    document.querySelectorAll('.grok-download-selected-btn').forEach(btn => {
      btn.disabled = count === 0 || busy;
      btn.textContent = count > 0 ? `Download selected (${count})` : 'Download selected';
      btn.title = count > 0
        ? `Download ${count} selected image${count === 1 ? '' : 's'} to a folder`
        : 'Download selected images to a folder';
    });
    document.querySelectorAll('.grok-check-all-btn').forEach(btn => {
      btn.disabled = busy || total === 0 || count === total;
    });
    document.querySelectorAll('.grok-clear-selection-btn').forEach(btn => {
      btn.disabled = busy || count === 0;
    });
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
      ensureDownloadResultsButtons();
      ensureDownloadSelectedButtons();
      ensureLoadingIndicator();
      ensureSearchInputListener();
      syncInitialResultsView();
      if (!loaded && !indexing) loadAllPosts();
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
          <span id="grok-search-count-wrap" class="grok-results-count-wrap">
            <span id="grok-search-count"></span>
            <button type="button" class="grok-download-selected-btn grok-toolbar-btn" title="Download selected images to a folder">Download selected</button>
          </span>
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
              Video
              <select id="grok-filter-video-min" class="grok-filter-min-select" title="Minimum videos (at least)" aria-label="Minimum videos">
                <option value="1">1</option><option value="3">3</option><option value="5">5</option><option value="7">7</option><option value="10">10</option>
              </select>
            </label>
            <label id="grok-filter-children-label" class="grok-filter-check-label" title="Show only items with at least N child posts">
              <input type="checkbox" id="grok-filter-children" />
              With child
              <select id="grok-filter-children-min" class="grok-filter-min-select" title="Minimum child posts (at least)" aria-label="Minimum child posts">
                <option value="1">1</option><option value="3">3</option><option value="5">5</option><option value="7">7</option><option value="10">10</option>
              </select>
            </label>
            <label id="grok-filter-hide-childs-label" class="grok-filter-check-label" title="Hide child posts from results (parents only)">
              <input type="checkbox" id="grok-filter-hide-childs" />
              Hide childs
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
    ensureLoadingIndicator();
    ensureDownloadResultsButtons();
    ensureDownloadSelectedButtons();
    syncInitialResultsView();

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
      loadHideChildsFilterFromStorage();
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

    ensureSearchInputListener();

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
      clearTimeout(searchFilterDebounceTimer);
      searchFilterDebounceTimer = null;
      input.value = '';
      currentQuery = '';
      dateStartEl.value = '';
      dateEndEl.value = '';
      dateStart = '';
      dateEnd = '';
      filterOnlyVideo = false;
      filterOnlyChildren = false;
      filterHideChilds = false;
      filterMinVideos = 1;
      filterMinChildren = 1;
      syncMediaMinSelects();
      try {
        localStorage.setItem(FILTER_VIDEO_KEY, '0');
        localStorage.setItem(FILTER_CHILDREN_KEY, '0');
        localStorage.setItem(FILTER_HIDE_CHILDS_KEY, '0');
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
    if (initiated && document.getElementById('grok-search-wrap')) {
      syncInitialResultsView();
      if (!loaded && !indexing) loadAllPosts();
      return;
    }
    if (initiated) return;
    initiated = true;
    injectStyles();
    buildSearchBar();
    loadAllPosts();
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
      setTimeout(() => {
        init();
        if (isImagineListPage()) scheduleIncrementalSync('navigation');
      }, 800);
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