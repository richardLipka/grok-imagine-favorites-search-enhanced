// ==UserScript==
// @name         Grok Imagine Favorites Search + Saved Item Pass-Through
// @namespace    http://tampermonkey.net/
// @version      1.69.5
// @description  Search, filter, and paginate saved Grok media; lightbox, resumable bulk download, full EXIF/XMP tagging (JPEG, PNG, WebP).
// @author       Richard Lipka, based on IronSniper1
// @homepage     https://github.com/richardLipka/grok-imagine-favorites-search-enhanced
// @supportURL   https://github.com/richardLipka/grok-imagine-favorites-search-enhanced/issues
// @license      GPL-3.0-only
// @updateURL    https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokSearch.user.js
// @downloadURL  https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokSearch.user.js
// @match        https://grok.com/imagine*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      grok.com
// @connect      *
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js
// ==/UserScript==

// Grok Imagine Favorites Search — search, index and manage your Grok Imagine library
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
  /** Corners the show/hide button can sit in, and the one it starts in. */
  const TOGGLE_POSITIONS = ['tr', 'br', 'tl', 'bl'];
  const DEFAULT_TOGGLE_POS = 'tr';
  const DEFAULT_COMPACT_GROUPS = false;
  /** Child thumbnails a compact card shows before folding the rest into a +N chip. */
  const COMPACT_CHILD_LIMIT = 8;
  /** Child links the lightbox lists before folding the rest into a +N chip. */
  const LIGHTBOX_CHILD_LIMIT = 24;
  const ENDPOINT = 'https://grok.com/rest/media/post/list';
  /**
   * The asset feed the current Grok UI builds its library from. Unlike media/post/list it is
   * genuinely ordered newest-first, it reaches today, and every row already carries the prompt
   * and model -- so indexing costs one request per 60 items and nothing per item.
   */
  const ASSETS_ENDPOINT = 'https://grok.com/rest/assets';
  const ASSETS_WORKSPACE = 'WORKSPACE_KIND_IMAGINE_ALL';
  /** The server caps a page at 60 however much is asked for. */
  const ASSETS_PAGE_SIZE = 60;
  /** Media is served straight off this host under the asset's storage key; no signing needed. */
  const ASSET_CDN_BASE = 'https://assets.grok.com/';
  /**
   * The feed is ordered, so a sync can stop once it stops seeing anything new. It takes this
   * many consecutive all-known pages to call it, rather than one, because a deleted asset or a
   * clock skew can produce a single stale-looking page mid-run.
   */
  const ASSETS_SYNC_STALE_PAGES = 3;
  const ASSETS_MAX_PAGES = 2000;
  const POST_GET = 'https://grok.com/rest/media/post/get';
  /**
   * `/rest/media/post/delete` takes `{ id }`. Confirmed by probing with a UUID that cannot exist:
   * a wrong field name still reports the field missing, the right one gets past validation and
   * answers 404 -- so the shape is known rather than guessed, and nothing real was touched.
   */
  const POST_DELETE = 'https://grok.com/rest/media/post/delete';

  /**
   * Liking is **collection membership**, not a post flag.
   *
   * `/rest/media/post/like` still exists and still answers 200, but it does nothing at all --
   * verified by liking a post through it and re-reading the post, which came back unliked. Grok
   * moved likes into collections: every account has a default collection named "Liked", and the
   * heart adds to or removes from it. Both endpoints report how many rows they touched
   * (`addedCount` / `removedCount`), which is what makes a silent no-op detectable.
   */
  const COLLECTION_LIST = 'https://grok.com/rest/media/collection/list';
  const COLLECTION_ADD = 'https://grok.com/rest/media/collection/assets/add';
  const COLLECTION_REMOVE = 'https://grok.com/rest/media/collection/assets/remove';
  const LIKED_COLLECTION_KEY = 'grokSearchLikedCollectionId';
  /** Liked-list pages to walk for metadata (40 posts/page; includes childPosts). */
  const SYNC_LIST_REFRESH_PAGES = 4;
  const SYNC_LIST_PAGE_DELAY_MS = 40;
  /** Parallel post/get for items with children (full child tree from API). */
  const SYNC_DEEP_REFRESH_LIMIT = 24;
  const SYNC_DEEP_CONCURRENCY = 5;
  /**
   * Slots inside SYNC_DEEP_REFRESH_LIMIT reserved for recent parents that have no
   * children yet. Without this, posts with children always fill the budget and a
   * post's *first* child is never discovered outside the list-refresh window.
   */
  const SYNC_DEEP_CHILDLESS_SLOTS = 8;
  /** Skip deep refresh for posts refreshed more recently than this. */
  const SYNC_DEEP_REFRESH_TTL_MS = 10 * 60 * 1000;
  const SYNC_FOCUS_MIN_INTERVAL_MS = 60 * 1000;
  const SYNC_NAV_MIN_INTERVAL_MS = 15 * 1000;
  /** Hard stops for the full-reindex walk (defensive against a repeating cursor). */
  const FULL_INDEX_MAX_PAGES = 2000;
  /**
   * Reconciliation walks the whole liked feed for ids only — no post/get, no metadata
   * re-parse. It is the only thing that removes unliked posts and the only thing that finds
   * posts liked long after they were created (the incremental sync stops after a few pages).
   */
  const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const RECONCILE_LAST_RUN_KEY = 'grokSearchLastReconcileAt';
  /**
   * Refuse to delete more than this share of the index in one sweep. A feed shape change or a
   * half-authenticated response should not be able to wipe the library.
   */
  const RECONCILE_MAX_DELETE_RATIO = 0.5;
  /** Retry budget for rate-limited / temporarily unavailable API responses. */
  const HTTP_RETRY_STATUSES = [429, 500, 502, 503, 504];
  const HTTP_MAX_RETRIES = 3;
  const HTTP_RETRY_BASE_MS = 800;
  const METADATA_REFRESH_KEY = 'metadataRefreshedAt';
  const INDEX_SCHEMA_VERSION = 5;
  /** Keep in step with the @version header — it is stamped into downloaded image metadata. */
  const SCRIPT_VERSION = '1.69.5';
  /**
   * Grok stopped requiring a like for media to stay in history, so the index covers the whole
   * library rather than only likes. The enum value for "everything" is not documented, so the
   * working source is resolved once by probing and then cached; MEDIA_SOURCE_LIKED remains the
   * fallback because it is the one value known to exist.
   */
  const MEDIA_SOURCE_LIKED = 'MEDIA_POST_SOURCE_LIKED';
  const MEDIA_SOURCE_KEY = 'grokSearchMediaSource';
  const MEDIA_SOURCE_PROBED_KEY = 'grokSearchMediaSourceProbedAt';
  const MEDIA_SOURCE_REPROBE_MS = 7 * 24 * 60 * 60 * 1000;
  /** Probe page size. Big enough that "returns ids the liked feed does not" is a real signal. */
  const PROBE_SAMPLE_SIZE = 50;
  /** `null` means "send no source filter at all", which some deployments treat as everything. */
  const MEDIA_SOURCE_CANDIDATES = [
    null,
    'MEDIA_POST_SOURCE_ALL',
    'MEDIA_POST_SOURCE_HISTORY',
    'MEDIA_POST_SOURCE_OWN',
    'MEDIA_POST_SOURCE_SELF',
    'MEDIA_POST_SOURCE_MINE',
    'MEDIA_POST_SOURCE_USER',
    'MEDIA_POST_SOURCE_CREATED',
    'MEDIA_POST_SOURCE_GENERATED',
    'MEDIA_POST_SOURCE_PROFILE',
    'MEDIA_POST_SOURCE_UNSPECIFIED',
    MEDIA_SOURCE_LIKED,
  ];
  /**
   * Payload fields that have been seen to carry the viewer's like state.
   *
   * `likeStatus` inside `userInteractionStatus` is the one Grok actually sends -- confirmed
   * against a live response. Until it was on this list every post detected as `null` (unknown),
   * which *Liked only* excludes, so the filter matched nothing at all. The rest are kept as
   * fallbacks because the payload shape is not contractual and has changed before.
   */
  const LIKED_BOOLEAN_FIELDS = [
    'likeStatus',
    'isLiked', 'liked', 'hasLiked', 'isFavorite', 'isFavorited', 'favorited',
    'likedByUser', 'isLikedByUser', 'userLiked', 'viewerHasLiked',
  ];
  const LIKED_CONTAINER_FIELDS = [
    'userInteractionStatus',
    'viewerState', 'viewer', 'interaction', 'interactions', 'userState', 'state',
  ];
  /** Request template for like/unlike, captured from Grok's own UI by tools/capture-like.js. */
  const LIKE_REQUEST_KEY = 'grokSearchLikeRequest';
  /** Template recorded by tools/capture-list.js; when present it replaces the guessed source. */
  const LIST_REQUEST_KEY = 'grokSearchListRequest';
  const FILTER_LIKED_KEY = 'grokSearchFilterLiked';
  const INDEX_VERSION_KEY = 'grokSearchIndexSchemaVersion';
  const DB_NAME = 'GrokSearchIndex';
  const DB_VERSION = 1;
  const STORE_NAME = 'posts';
  const RESULTS_ONLY_KEY = 'grokSearchResultsOnly';
  const FILTER_VIDEO_ONLY_KEY = 'grokSearchFilterVideoOnly';
  const FILTER_WITH_VIDEO_KEY = 'grokSearchFilterWithVideo';
  /** @deprecated legacy — migrated to FILTER_WITH_VIDEO_KEY */
  const FILTER_VIDEO_KEY = 'grokSearchFilterVideo';
  const FILTER_CHILDREN_KEY = 'grokSearchFilterChildren';
  const FILTER_CHILDREN_MIN_KEY = 'grokSearchFilterChildrenMin';
  const FILTER_HIDE_CHILDS_KEY = 'grokSearchFilterHideChilds';
  const FILTER_MODEL_KEY = 'grokSearchFilterModel';
  const SORT_KEY = 'grokSearchSort';
  const PAGE_SIZE_KEY = 'grokSearchPageSize';
  const GRID_SIZE_PCT_KEY = 'grokSearchGridSizePct';
  const COMPACT_GROUPS_KEY = 'grokSearchCompactGroups';
  const TOGGLE_POS_KEY = 'grokSearchTogglePos';
  const SEARCH_BAR_COLLAPSED_KEY = 'grokSearchBarCollapsed';
  const MEDIA_MIN_OPTIONS = [1, 3, 5, 7, 10];
  /** Wait after last keystroke before filtering (ms); capped at 1s. */
  const SEARCH_DEBOUNCE_MS = 400;
  const SEARCH_DEBOUNCE_MAX_MS = 1000;
  /** Ask before bulk download when selection exceeds this count. */
  const BULK_DOWNLOAD_CONFIRM_ABOVE = 5;
  /** Per-file attempts during a bulk download, so one flaky response does not lose the file. */
  const DOWNLOAD_MAX_ATTEMPTS = 3;
  const DOWNLOAD_RETRY_BASE_MS = 600;
  /** Per-prompt cap for embedded image metadata; see buildPostMetadata() for why it is not larger. */
  const METADATA_PROMPT_MAX = 4000;
  /** Per-image cap for alt text; see imageAltText() for why a whole prompt cannot go in there. */
  const IMAGE_ALT_MAX = 140;

  let allPosts = [];
  /** id → the live row object inside allPosts. Rows are updated in place, never by array index. */
  const postById = new Map();
  let searchBarExpanded = true;
  const knownIds = new Set();
  let currentQuery = '';
  let dateStart = '';
  let dateEnd = '';
  let resultsOnly = true;
  let filterVideoOnly = false;
  let filterWithVideo = false;
  let filterOnlyChildren = false;
  let filterHideChilds = false;
  let filterMinChildren = 1;
  let filterModel = '';
  let filterLikedOnly = false;
  /** Resolved liked-feed source; null means "send no source filter". */
  let mediaSource = MEDIA_SOURCE_LIKED;
  let mediaSourceResolved = false;
  let pageSize = DEFAULT_PAGE_SIZE;
  let gridSizePercent = DEFAULT_GRID_SIZE_PCT;
  let compactGroups = DEFAULT_COMPACT_GROUPS;
  let togglePosition = DEFAULT_TOGGLE_POS;
  /** What the grid pages over: one entry per card, `{ post, children }`. See getDisplayEntries(). */
  let displayEntries = [];
  let displayEntriesSource = null;
  let displayEntriesSignature = '';
  /** parentId -> immediate children; see getChildrenByParent(). */
  let childrenByParent = new Map();
  let childrenByParentSource = null;
  let childrenByParentLength = -1;
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
  /** Reason of a sync trigger that arrived while another sync was running. */
  let pendingSyncReason = null;
  let searchFilterDebounceTimer = null;
  let lightboxIndex = -1;
  let contextMenuPostId = null;
  const selectedPostIds = new Set();
  let bulkDownloadInProgress = false;
  /** Set by the Cancel button; the download loop checks it between files. */
  let bulkDownloadCancelled = false;
  /** Aborts the in-flight media request so Cancel takes effect mid-file, not after it. */
  let bulkDownloadAbort = null;
  /** Posts that failed in the last bulk run, plus the folder they were headed for. */
  let lastFailedDownloads = [];
  let lastDownloadDirHandle = null;
  let reconcileInProgress = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function readStoredString(key, fallback = '') {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch { return fallback; }
  }

  function writeStoredString(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }

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
  function isRetryableStatus(status) {
    return HTTP_RETRY_STATUSES.includes(status) || status === 0;
  }

  /** Exponential backoff, honouring Retry-After when the server sends one. */
  function retryDelayMs(attempt, headers) {
    const after = /retry-after:\s*(\d+)/i.exec(String(headers || ''))?.[1];
    if (after) return Math.min(Number(after) * 1000, 30000);
    return HTTP_RETRY_BASE_MS * 2 ** attempt;
  }

  function gmRequestOnce(url, body, headers) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        data: JSON.stringify(body),
        withCredentials: true,
        onload: res => resolve({ status: res.status, text: res.responseText, headers: res.responseHeaders }),
        onerror: () => resolve({ status: 0, text: '', headers: '' }),
      });
    });
  }

  /**
   * POST with backoff on 429/5xx. Always resolves: `ok:false` means the request failed and
   * callers must not confuse that with an empty result — a 401/429 mid-walk used to look
   * exactly like the end of the feed.
   */
  async function postJsonWithRetry(url, body, label, headers) {
    for (let attempt = 0; ; attempt++) {
      const res = await gmRequestOnce(url, body, headers);
      if (res.status >= 200 && res.status < 300) {
        try {
          return { ok: true, data: JSON.parse(res.text) };
        } catch {
          console.warn(`[GrokSearch] ${label} response was not JSON`);
          return { ok: false, status: res.status };
        }
      }
      if (!isRetryableStatus(res.status) || attempt >= HTTP_MAX_RETRIES) {
        console.warn(`[GrokSearch] ${label} HTTP ${res.status}`);
        return { ok: false, status: res.status };
      }
      const wait = retryDelayMs(attempt, res.headers);
      console.warn(`[GrokSearch] ${label} HTTP ${res.status} — retrying in ${wait}ms`);
      setLoadStatus(`rate limited — retrying…`);
      await sleep(wait);
    }
  }

  // ─── Feed request ─────────────────────────────────────────────────────────
  /**
   * The feed request has two forms.
   *
   * By default the script calls the known list endpoint and guesses `filter.source`, because the
   * enum covering the whole library is undocumented. Guessing is unreliable: if every candidate
   * the deployment accepts is likes-only, media you never liked is unreachable however the probe
   * ranks them.
   *
   * So when tools/capture-list.js has recorded the request Grok's own library view sends, that
   * template is replayed instead. Same rule the like button follows — capture the real request,
   * never invent one. The template is the authoritative answer to what the library returns.
   *
   * Template shape: { url, method, body, cursorPath, limitPath?, headers? }
   */
  function readListTemplate() {
    try {
      const raw = localStorage.getItem(LIST_REQUEST_KEY);
      if (!raw) return null;
      const tpl = JSON.parse(raw);
      return tpl && tpl.url && tpl.body && typeof tpl.body === 'object' ? tpl : null;
    } catch { return null; }
  }

  function hasCapturedListRequest() {
    return Boolean(readListTemplate());
  }

  /** Removes the value at a dotted/array path, leaving the containing objects in place. */
  function deleteAtPath(obj, path) {
    if (!path || !path.length) return obj;
    let node = obj;
    for (let i = 0; i < path.length - 1; i++) {
      node = node?.[path[i]];
      if (!node || typeof node !== 'object') return obj;
    }
    delete node[path[path.length - 1]];
    return obj;
  }

  function buildListBody(cursor, source = mediaSource, limit = 40) {
    const tpl = readListTemplate();
    if (tpl) {
      const body = JSON.parse(JSON.stringify(tpl.body));
      const cursorPath = tpl.cursorPath?.length ? tpl.cursorPath : ['cursor'];
      if (tpl.limitPath?.length) setAtPath(body, tpl.limitPath, limit);
      // The first page must carry no cursor key at all: an empty string is not the same thing
      // as "start from the beginning" to every backend.
      if (cursor) setAtPath(body, cursorPath, String(cursor));
      else deleteAtPath(body, cursorPath);
      return body;
    }
    const filter = { safeForWork: false };
    if (source) filter.source = source;
    const body = { limit, filter };
    if (cursor) body.cursor = String(cursor);
    return body;
  }

  const LIST_POSTS_KEYS = ['posts', 'mediaPosts', 'items', 'results', 'media', 'data'];
  const LIST_CURSOR_KEYS = ['nextCursor', 'cursor', 'nextPageToken', 'pageToken', 'next', 'endCursor'];

  /**
   * Pulls one page out of a list response. A captured request may hit a different endpoint than
   * the one hardcoded here and there is no contract on the key names, so both the post array and
   * the cursor are looked up by candidate name, then one level of nesting down.
   */
  function extractListPage(data) {
    if (!data || typeof data !== 'object') return { posts: [], nextCursor: null };

    const findPosts = obj => {
      for (const key of LIST_POSTS_KEYS) {
        if (Array.isArray(obj[key])) return obj[key];
      }
      return null;
    };
    const findCursor = obj => {
      for (const key of LIST_CURSOR_KEYS) {
        const v = obj[key];
        if (typeof v === 'string' && v) return v;
      }
      return null;
    };

    let posts = findPosts(data);
    let nextCursor = findCursor(data);
    if (!posts || !nextCursor) {
      for (const v of Object.values(data)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        if (!posts) posts = findPosts(v);
        if (!nextCursor) nextCursor = findCursor(v);
      }
    }
    return { posts: posts || [], nextCursor: nextCursor || null };
  }

  async function fetchPage(cursor) {
    const tpl = readListTemplate();
    const res = await postJsonWithRetry(tpl?.url || ENDPOINT, buildListBody(cursor), 'list', tpl?.headers);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, ...extractListPage(res.data) };
  }

  function newestCreateTimeOf(posts) {
    let newest = '';
    for (const p of posts) {
      const d = p?.createTime || p?.createdAt || p?.create_time || '';
      if (d > newest) newest = d;
    }
    return newest;
  }

  function idsOf(posts) {
    const out = new Set();
    for (const p of posts) if (p?.id) out.add(String(p.id));
    return out;
  }

  /**
   * Finds which source returns more than the liked feed does.
   *
   * Ranking candidates by their newest `createTime` does not work, and that is why the earlier
   * probe kept settling on a likes-only source: the feed is ordered by *interaction* time, so
   * every candidate shows the same handful of recently touched posts at its head and they all
   * report the same newest date. What actually separates a broader source from likes-only is
   * whether it returns ids the liked feed does not, so the liked feed is sampled first as a
   * baseline and every candidate is scored against it. Read-only.
   */
  async function probeMediaSource() {
    const sample = async candidate => {
      const res = await postJsonWithRetry(ENDPOINT, buildListBody(null, candidate, PROBE_SAMPLE_SIZE), 'probe');
      if (!res.ok) return null;
      const { posts } = extractListPage(res.data);
      return posts.length ? posts : null;
    };

    const likedIds = idsOf(await sample(MEDIA_SOURCE_LIKED) || []);
    const results = [];
    for (const candidate of MEDIA_SOURCE_CANDIDATES) {
      if (candidate === MEDIA_SOURCE_LIKED) continue;
      await sleep(80);
      const posts = await sample(candidate);
      if (!posts) continue;
      const ids = idsOf(posts);
      let beyondLikes = 0;
      for (const id of ids) if (!likedIds.has(id)) beyondLikes++;
      results.push({ source: candidate, count: ids.size, beyondLikes, newest: newestCreateTimeOf(posts) });
    }

    console.log(`[GrokSearch] Source probe (liked baseline: ${likedIds.size} posts):`);
    for (const r of results) {
      console.log(`  ${r.source || '(no source filter)'} → ${r.count} posts, `
        + `${r.beyondLikes} beyond likes, newest ${r.newest || '?'}`);
    }

    results.sort((a, b) => (b.beyondLikes - a.beyondLikes)
      || (b.count - a.count)
      || (b.newest || '').localeCompare(a.newest || ''));
    const best = results[0];
    if (best && best.beyondLikes > 0) return best.source;
    if (!likedIds.size && best) return best.source;
    return MEDIA_SOURCE_LIKED;
  }

  async function resolveMediaSource({ force = false } = {}) {
    // A captured request carries its own filter, so there is nothing left to guess at.
    if (hasCapturedListRequest()) {
      mediaSource = null;
      if (!mediaSourceResolved || force) {
        console.log('[GrokSearch] Replaying the library request captured by tools/capture-list.js');
      }
      mediaSourceResolved = true;
      return mediaSource;
    }
    if (mediaSourceResolved && !force) return mediaSource;
    const stored = readStoredString(MEDIA_SOURCE_KEY, '');
    const probedAt = Number(readStoredString(MEDIA_SOURCE_PROBED_KEY, '0')) || 0;
    const fresh = Date.now() - probedAt < MEDIA_SOURCE_REPROBE_MS;
    if (!force && stored && fresh) {
      mediaSource = stored === '(none)' ? null : stored;
      mediaSourceResolved = true;
      return mediaSource;
    }
    setLoadStatus('checking library source…');
    mediaSource = await probeMediaSource();
    mediaSourceResolved = true;
    writeStoredString(MEDIA_SOURCE_KEY, mediaSource === null ? '(none)' : mediaSource);
    writeStoredString(MEDIA_SOURCE_PROBED_KEY, String(Date.now()));
    console.log(`[GrokSearch] Using media source: ${mediaSource || '(no source filter)'}`);
    return mediaSource;
  }

  /**
   * Says so, once, when the index can only ever contain likes. Silence here is what made the
   * missing-images problem so hard to see: everything looked healthy, the feed simply did not
   * contain the posts.
   */
  function warnIfLikesOnly() {
    if (hasCapturedListRequest() || mediaSource !== MEDIA_SOURCE_LIKED) return;
    console.warn('[GrokSearch] No media source reached anything beyond your likes, so the index '
      + 'covers liked posts only. If images you never liked are missing, record the request '
      + "Grok's own library view sends by pasting tools/capture-list.js into this console, then "
      + 'click Reindex. See "Capturing the library request" in the README.');
    setLoadStatus('likes only — see tools/capture-list.js');
    const statusEl = document.getElementById('grok-stamp-status');
    setTimeout(() => {
      if (statusEl && statusEl.textContent.startsWith('likes only')) statusEl.textContent = '';
    }, 12000);
  }

  function isVideoMediaType(mediaType) {
    const t = String(mediaType || '');
    return t === 'MEDIA_POST_TYPE_VIDEO' || t.includes('VIDEO');
  }

  function isVideoUrl(url) {
    return /\.(mp4|webm|mov|mkv)(\?|$)/i.test(String(url || ''));
  }

  function isLikelyImageUrl(url) {
    const s = String(url || '').trim();
    if (!s) return false;
    return !isVideoUrl(s);
  }

  function isVideoPost(post) {
    return isVideoMediaType(post?.mediaType) || isVideoUrl(post?.mediaUrl) || isVideoUrl(post?.thumbnail);
  }

  function matchesWithVideoFilter(post) {
    return !isChildPost(post)
      && !isVideoPost(post)
      && (post.childVideoCount ?? 0) > 0;
  }

  function matchesVideoFilters(post) {
    if (!filterVideoOnly && !filterWithVideo) return true;
    const videoOnly = filterVideoOnly && isVideoPost(post);
    const withVideo = filterWithVideo && matchesWithVideoFilter(post);
    if (filterVideoOnly && filterWithVideo) return videoOnly || withVideo;
    if (filterVideoOnly) return videoOnly;
    return withVideo;
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

  /**
   * Canonical index row — all fields persisted to IndexedDB and export.
   *
   * `parentId` is the *immediate* parent; `rootId` is the top-level post that owns the whole
   * tree. For a direct child the two are equal, and legacy rows written before grandchildren
   * had true edges default `rootId` to `parentId` — which is exactly right for them, because
   * back then every descendant was parented straight onto the root.
   *
   * `rootPrompt` is only stored when it differs from `parentPrompt`, so the common case
   * (a direct child) pays nothing for it.
   */
  function toStorageRecord(post) {
    const isChild = Boolean(post.isChild);
    const parentId = isChild ? String(post.parentId || '') : null;
    const rootId = isChild ? String(post.rootId || post.parentId || '') : null;
    const parentPrompt = isChild ? String(post.parentPrompt || '') : null;
    const rootPrompt = isChild && rootId && rootId !== parentId
      ? String(post.rootPrompt || '')
      : '';
    const row = {
      id: String(post.id || ''),
      prompt: String(post.prompt || ''),
      parentPrompt,
      parentId,
      rootId,
      rootPrompt: isChild ? rootPrompt : null,
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
      isLiked: typeof post.isLiked === 'boolean' ? post.isLiked : null,
      // Which generation an asset came from. Siblings of a multi-image generation share it,
      // which is the grouping the asset feed offers in place of a parent/child tree.
      conversationId: String(post.conversationId || ''),
    };
    if (post[METADATA_REFRESH_KEY] != null) {
      row[METADATA_REFRESH_KEY] = post[METADATA_REFRESH_KEY];
    }
    return row;
  }

  /**
   * Derived fields cached on the in-memory row. They are recomputed on every write and
   * dropped by toStorageRecord(), so they never reach IndexedDB or the JSON export.
   */
  const RUNTIME_MS = '_ms';
  const RUNTIME_SEARCH = '_search';

  function computeCreatedMs(createTime) {
    if (!createTime) return 0;
    const t = new Date(createTime).getTime();
    return Number.isNaN(t) ? 0 : t;
  }

  /**
   * Lowercased haystack for the text filter: own prompt, plus the immediate parent's prompt and
   * — for a grandchild, whose parent is itself a child — the original root prompt. Searching for
   * the wording of a generation has to find everything descended from it, however deep.
   */
  function computeSearchText(row) {
    const own = String(row.prompt || '').trim();
    if (!row.isChild) return own.toLowerCase();
    const parent = String(row.parentPrompt || '').trim();
    const root = String(row.rootPrompt || '').trim();
    const parts = [...new Set([own, parent, root].filter(Boolean))];
    return parts.join(' ').toLowerCase();
  }

  /** Canonical row + cached derived fields. Everything placed into allPosts goes through this. */
  function normalizePost(post) {
    const row = toStorageRecord(post);
    row[RUNTIME_MS] = computeCreatedMs(row.createTime);
    row[RUNTIME_SEARCH] = computeSearchText(row);
    return row;
  }

  // ─── allPosts / postById maintenance ────────────────────────────────────────
  /** Bumped whenever rows are added or removed, so index-derived UI can skip rescans. */
  let indexRevision = 0;

  /** Full rebuild of the id map. Only needed after allPosts is replaced or filtered. */
  function rebuildPostIndex() {
    postById.clear();
    for (const p of allPosts) postById.set(p.id, p);
    indexRevision++;
  }

  function addPostRow(row) {
    allPosts.push(row);
    postById.set(row.id, row);
    knownIds.add(row.id);
    indexRevision++;
    return row;
  }

  /**
   * Update an existing row in place, keyed by id. Mutating the live object keeps every
   * array position and every reference held by matchedPosts/lightbox valid, which is why
   * no caller needs an array index.
   */
  function updatePostRow(next) {
    const current = postById.get(next.id);
    if (!current) return null;
    // Rows are updated in place, so a re-parent changes neither the identity nor the length of
    // `allPosts` -- the two things getChildrenByParent() watches. Nothing re-parents a post today;
    // this is here so that if anything ever does, the child index does not quietly go stale.
    if (current.isChild !== next.isChild
        || String(current.parentId || '') !== String(next.parentId || '')) {
      childrenByParentSource = null;
    }
    for (const key of Object.keys(current)) {
      if (!(key in next)) delete current[key];
    }
    Object.assign(current, next);
    return current;
  }

  /**
   * id → prompt for *every* row, not just top-level ones. A grandchild's parent is itself a
   * child row, so restricting this to parents used to make its parent prompt unresolvable.
   */
  function buildPromptById() {
    const map = new Map();
    for (const p of allPosts) map.set(p.id, String(p.prompt || ''));
    return map;
  }

  function isChildPost(post) {
    return Boolean(post?.isChild);
  }

  /**
   * Reads the viewer's like state off a raw payload. Returns null when the payload carries no
   * recognisable flag, so an unknown state is never mistaken for "not liked".
   */
  function detectLikedState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    for (const field of LIKED_BOOLEAN_FIELDS) {
      if (typeof raw[field] === 'boolean') return raw[field];
    }
    for (const container of LIKED_CONTAINER_FIELDS) {
      const nested = raw[container];
      if (!nested || typeof nested !== 'object') continue;
      for (const field of LIKED_BOOLEAN_FIELDS) {
        if (typeof nested[field] === 'boolean') return nested[field];
      }
    }
    return null;
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
      isLiked: detectLikedState(post),
      ...counts,
    };
  }

  function getParentPrompt(parentRaw, parentParsed) {
    return String(
      parentParsed?.prompt || parentRaw?.prompt || parentRaw?.originalPrompt || ''
    ).trim();
  }

  /**
   * Fulltext prompt search — child rows always include parentPrompt (cached field, or a
   * live parent lookup for rows whose parentPrompt has not been backfilled yet).
   */
  function getSearchablePromptText(post, promptById) {
    const cached = post[RUNTIME_SEARCH];
    if (typeof cached === 'string' && (cached || !isChildPost(post))) return cached;

    const own = String(post.prompt || '').trim();
    if (!isChildPost(post)) return own.toLowerCase();

    let parent = String(post.parentPrompt || '').trim();
    if (!parent && post.parentId && promptById) {
      parent = String(promptById.get(post.parentId) || '').trim();
    }
    let root = String(post.rootPrompt || '').trim();
    if (!root && post.rootId && post.rootId !== post.parentId && promptById) {
      root = String(promptById.get(post.rootId) || '').trim();
    }
    const parts = [...new Set([own, parent, root].filter(Boolean))];
    return parts.join(' ').toLowerCase();
  }

  /**
   * `parentRaw`/`parentParsed` are the child's *immediate* parent — which for a grandchild is
   * itself a child row. `root` names the top-level post that owns the tree; it defaults to the
   * immediate parent, so the common one-generation call is unchanged.
   */
  function parseChildPost(parentRaw, childRaw, parentParsed, root) {
    if (!childRaw?.id || !parentParsed?.id) return null;
    const parentPrompt = getParentPrompt(parentRaw, parentParsed);
    const rootId = String(root?.id || parentParsed.id);
    const rootPrompt = String(root?.prompt ?? parentPrompt).trim();
    const ownPrompt = String(childRaw.prompt || childRaw.originalPrompt || '').trim();
    const prompt = ownPrompt || parentPrompt || rootPrompt;
    // A child can have children of its own; those counts are what makes "Download all" and the
    // variation badge work from a mid-tree row rather than only from the root.
    // extractChildMediaCounts() already folds in whether this node is itself a video.
    const counts = extractChildMediaCounts(childRaw);
    return normalizePost({
      id: String(childRaw.id),
      parentId: String(parentParsed.id),
      rootId,
      isChild: true,
      prompt,
      parentPrompt,
      rootPrompt,
      thumbnail: childRaw.thumbnailImageUrl || childRaw.thumbnail || childRaw.mediaUrl || '',
      mediaUrl: childRaw.mediaUrl || childRaw.hdMediaUrl || '',
      createTime: childRaw.createTime || childRaw.createdAt || childRaw.create_time
        || parentParsed.createTime || '',
      model: childRaw.modelName || childRaw.model || parentParsed.model || '',
      mediaType: childRaw.mediaType || '',
      isLiked: detectLikedState(childRaw),
      childPostCount: counts.childPostCount,
      childImageCount: counts.childImageCount,
      childVideoCount: counts.childVideoCount,
      videoCount: counts.videoCount,
    });
  }

  /**
   * A post can be liked in its own right *and* appear in another post's childPosts tree.
   * IndexedDB is keyed on id, so writing the child form of such a post would overwrite the
   * parent row and flip it to isChild — hide it behind "Hide childs" and lose its counts.
   * Rows that already exist as a parent are therefore never re-collected as children.
   */
  function shadowsExistingParent(childId, parentId) {
    if (childId === parentId) return true;
    const existing = postById.get(childId);
    return Boolean(existing && !existing.isChild);
  }

  /**
   * Flattens a post's whole descendant tree into rows, keeping the real edges: a grandchild's
   * `parentId` is the child it came from, while `rootId` stays the top-level post. Every row in
   * the tree is still owned by that root, which is what the prune in
   * `syncChildRecordsForParent()` keys on.
   */
  function collectChildRecords(rootRaw, rootParsed) {
    const records = [];
    const seen = new Set();
    const rootId = String(rootParsed?.id || '');
    const root = { id: rootId, prompt: getParentPrompt(rootRaw, rootParsed) };

    const visit = (parentRaw, parentParsed) => {
      for (const child of parentRaw?.childPosts || []) {
        const childId = String(child?.id || '');
        if (!childId || seen.has(childId)) continue;
        seen.add(childId);
        let childParsed;
        if (shadowsExistingParent(childId, rootId)) {
          // Indexed in its own right, so it must not be rewritten as a child row — but its own
          // descendants still belong to this tree, so the walk continues through it.
          childParsed = { id: childId, prompt: String(child.prompt || child.originalPrompt || '') };
        } else {
          childParsed = parseChildPost(parentRaw, child, parentParsed, root);
          if (childParsed) records.push(stampMetadataRefreshed(childParsed));
        }
        visit(child, childParsed || parentParsed);
      }
    };
    visit(rootRaw, rootParsed);
    return records;
  }

  /** Owning root of a child row; legacy rows predate `rootId` and were parented onto the root. */
  function getRootIdOf(post) {
    return String(post?.rootId || post?.parentId || '');
  }

  function removeDescendantsOfRoot(rootId, keepIds) {
    const removedIds = [];
    allPosts = allPosts.filter(p => {
      if (p.isChild && getRootIdOf(p) === rootId && !keepIds.has(p.id)) {
        removedIds.push(p.id);
        knownIds.delete(p.id);
        return false;
      }
      return true;
    });
    if (removedIds.length) rebuildPostIndex();
    return removedIds;
  }

  /**
   * Buffers index writes for one sync run, so a pass over N parents costs a couple of
   * IndexedDB transactions instead of two per parent. Buffered rows are the live objects
   * from allPosts, so a later in-place update is picked up by flush().
   */
  function createIndexWriter() {
    const puts = new Map();
    const deletes = new Set();
    return {
      put(row) {
        if (!row?.id) return;
        deletes.delete(row.id);
        puts.set(row.id, row);
      },
      del(id) {
        if (!id) return;
        puts.delete(id);
        deletes.add(id);
      },
      async flush() {
        const rows = [...puts.values()];
        const ids = [...deletes];
        puts.clear();
        deletes.clear();
        if (ids.length) await dbDeleteMany(ids);
        if (rows.length) await dbPutMany(rows);
        return rows.length + ids.length;
      },
    };
  }

  /** Synchronous by design: it mutates the index and buffers writes, so it cannot interleave. */
  function syncChildRecordsForParent(parentRaw, parentParsed, writer) {
    if (!parentParsed?.id) return { added: 0, updated: 0, removed: 0 };
    // The payload must be recognisable as this post before its child list is treated as
    // authoritative — otherwise a malformed response prunes every child the parent has.
    if (String(parentRaw?.id || '') !== parentParsed.id) {
      console.warn(`[GrokSearch] Skipped child sync for ${parentParsed.id}: unexpected payload`);
      return { added: 0, updated: 0, removed: 0 };
    }
    const childRecords = collectChildRecords(parentRaw, parentParsed);
    const keepIds = new Set(childRecords.map(c => c.id));
    const removedIds = removeDescendantsOfRoot(parentParsed.id, keepIds);
    for (const id of removedIds) writer.del(id);

    let added = 0;
    let updated = 0;
    for (const child of childRecords) {
      const cached = postById.get(child.id);
      if (!cached) {
        writer.put(addPostRow(child));
        added++;
        continue;
      }
      const merged = stampMetadataRefreshed(normalizePost({ ...cached, ...child }));
      if (!postMetadataChanged(cached, merged)) continue;
      writer.put(updatePostRow(merged) || addPostRow(merged));
      updated++;
    }
    return { added, updated, removed: removedIds.length };
  }

  // ─── Like / unlike ─────────────────────────────────────────────────────────
  /**
   * Liking is done by replaying the exact request Grok's own UI sends, captured once by
   * tools/capture-like.js and stored as a template. Nothing is guessed: if no template has been
   * captured the buttons say so instead of firing an invented endpoint at the account.
   *
   * Template shape:
   *   { url, method, body, idPath: ["postId"], likedPath: ["isLiked"] | null,
   *     unlikeUrl?, headers? }
   */
  function readLikeTemplate() {
    try {
      const raw = localStorage.getItem(LIKE_REQUEST_KEY);
      if (!raw) return null;
      const tpl = JSON.parse(raw);
      return tpl && tpl.url ? tpl : null;
    } catch { return null; }
  }

  /** Always available now that the endpoints are known; kept as a hook for future gating. */
  function hasLikeSupport() {
    return true;
  }

  /** Writes `value` at a dotted/array path inside a cloned body. */
  function setAtPath(obj, path, value) {
    if (!path || !path.length) return obj;
    let node = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
      node = node[key];
    }
    node[path[path.length - 1]] = value;
    return obj;
  }

  function buildLikeRequest(tpl, postId, liked) {
    const body = tpl.body ? JSON.parse(JSON.stringify(tpl.body)) : {};
    setAtPath(body, tpl.idPath || ['postId'], postId);
    if (tpl.likedPath) setAtPath(body, tpl.likedPath, liked);
    const url = (!liked && tpl.unlikeUrl) ? tpl.unlikeUrl : tpl.url;
    return { url: url.replace('{id}', encodeURIComponent(postId)), body, method: tpl.method || 'POST' };
  }

  function sendTemplatedLikeRequest(tpl, postId, liked) {
    const req = buildLikeRequest(tpl, postId, liked);
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: req.method,
        url: req.url,
        headers: { 'Content-Type': 'application/json', ...(tpl.headers || {}) },
        data: req.method === 'GET' ? undefined : JSON.stringify(req.body),
        withCredentials: true,
        onload: res => resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, text: res.responseText }),
        onerror: () => resolve({ ok: false, status: 0 }),
      });
    });
  }

  let likedCollectionId = null;

  /** The default collection is the Liked one; the name is a fallback for a localised account. */
  function pickLikedCollection(collections) {
    const list = Array.isArray(collections) ? collections : [];
    return list.find(c => c?.isDefault === true)
      || list.find(c => String(c?.name || '').toLowerCase() === 'liked')
      || null;
  }

  async function resolveLikedCollectionId({ force = false } = {}) {
    if (likedCollectionId && !force) return likedCollectionId;
    const cached = readStoredString(LIKED_COLLECTION_KEY, '');
    if (cached && !force) {
      likedCollectionId = cached;
      return likedCollectionId;
    }
    const res = await postJsonWithRetry(COLLECTION_LIST, { limit: 100 }, 'collections');
    if (!res.ok) return null;
    const found = pickLikedCollection(res.data?.collections);
    if (!found?.id) {
      console.warn('[GrokSearch] No default "Liked" collection found; liking is unavailable.');
      return null;
    }
    likedCollectionId = String(found.id);
    writeStoredString(LIKED_COLLECTION_KEY, likedCollectionId);
    return likedCollectionId;
  }

  /**
   * Adds to or removes from the Liked collection, unless a captured template overrides it.
   * `changed` is false when the server accepted the call but touched no rows -- already liked, or
   * already not. That is still the desired end state, so it counts as success, but it is reported
   * separately so a genuine no-op is never mistaken for a change.
   */
  async function sendLikeRequest(postId, liked) {
    const tpl = readLikeTemplate();
    if (tpl) return sendTemplatedLikeRequest(tpl, postId, liked);
    const collectionId = await resolveLikedCollectionId();
    if (!collectionId) return { ok: false, status: 0 };
    const res = await postJsonWithRetry(
      liked ? COLLECTION_ADD : COLLECTION_REMOVE,
      { collectionId, assetIds: [postId] },
      liked ? 'like' : 'unlike'
    );
    if (!res.ok) return { ok: false, status: res.status ?? 0 };
    const touched = Number(liked ? res.data?.addedCount : res.data?.removedCount);
    return { ok: true, status: 200, changed: Number.isFinite(touched) ? touched > 0 : true };
  }

  /** Optimistic toggle: flips the row, reverts if the request fails. */
  async function setPostLiked(post, liked) {
    if (!post?.id) return false;
    const previous = post.isLiked ?? null;
    const writer = createIndexWriter();
    writer.put(updatePostRow(normalizePost({ ...post, isLiked: liked })) || post);
    applyFilter();

    const res = await sendLikeRequest(post.id, liked);
    if (!res.ok) {
      writer.put(updatePostRow(normalizePost({ ...post, isLiked: previous })) || post);
      applyFilter();
      flashStampStatus(`like failed (${res.status || 'network'})`);
      console.warn('[GrokSearch] Like request failed', res.status, res.text?.slice(0, 200));
      return false;
    }
    await writer.flush();
    if (res.changed === false) {
      console.log(`[GrokSearch] ${post.id} was already ${liked ? 'liked' : 'unliked'}`);
    }
    flashStampStatus(liked ? 'liked' : 'unliked');
    return true;
  }

  async function togglePostLiked(post) {
    return setPostLiked(post, !(post?.isLiked === true));
  }

  function isImagineListPage() {
    return location.href.includes('/imagine') && !location.href.includes('/imagine/post/');
  }

  async function fetchRemotePost(id) {
    const res = await postJsonWithRetry(POST_GET, { id }, 'post/get');
    if (!res.ok) return null;
    const data = res.data;
    return data?.post ?? data?.mediaPost ?? data?.item ?? data;
  }

  function mergePostFromRemote(cached, remote) {
    const parsed = parsePost(remote);
    if (!parsed) return cached;
    return normalizePost({
      ...cached,
      ...parsed,
      isChild: false,
      parentId: null,
      rootId: null,
      parentPrompt: null,
      rootPrompt: null,
    });
  }

  /**
   * Only worth running when the parent prompt actually changed — callers must check first.
   * A post's prompt is denormalized onto two fields: `parentPrompt` on its direct children and
   * `rootPrompt` on every deeper descendant, so both have to be repaired here.
   */
  function propagateParentPromptToChildren(parentId, parentPrompt, writer) {
    const pp = String(parentPrompt || '');
    let count = 0;
    for (const p of allPosts) {
      if (!isChildPost(p)) continue;
      const isDirect = p.parentId === parentId;
      const isRoot = getRootIdOf(p) === parentId && p.parentId !== parentId;
      if (!isDirect && !isRoot) continue;
      const nextParentPrompt = isDirect ? pp : (p.parentPrompt || '');
      const nextRootPrompt = isRoot ? pp : (p.rootPrompt || '');
      if (nextParentPrompt === (p.parentPrompt || '') && nextRootPrompt === (p.rootPrompt || '')) continue;
      const row = stampMetadataRefreshed(normalizePost({
        ...p,
        parentPrompt: nextParentPrompt,
        rootPrompt: nextRootPrompt,
      }));
      writer.put(updatePostRow(row) || p);
      count++;
    }
    return count;
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
      || (before.parentPrompt || '') !== (after.parentPrompt || '')
      || (before.rootId || '') !== (after.rootId || '')
      || (before.rootPrompt || '') !== (after.rootPrompt || '')
      || (before.conversationId || '') !== (after.conversationId || '')
      || (before.isLiked ?? null) !== (after.isLiked ?? null);
  }

  function verifyIndexIntegrity() {
    const promptById = buildPromptById();
    let orphans = 0;
    let missingParent = 0;
    let missingRoot = 0;
    let emptySearchText = 0;
    let grandchildren = 0;
    for (const p of allPosts) {
      if (!isChildPost(p)) continue;
      if (!p.parentId) orphans++;
      else if (!promptById.has(p.parentId)) missingParent++;
      const rootId = getRootIdOf(p);
      if (rootId && rootId !== p.parentId) {
        grandchildren++;
        if (!promptById.has(rootId)) missingRoot++;
      }
      if (!getSearchablePromptText(p, promptById).trim()) emptySearchText++;
    }
    const children = allPosts.reduce((n, r) => n + (isChildPost(r) ? 1 : 0), 0);
    const summary = {
      total: allPosts.length,
      parents: allPosts.length - children,
      children,
      grandchildren,
      orphans,
      childMissingParent: missingParent,
      childMissingRoot: missingRoot,
      emptySearchText,
    };
    console.log('[GrokSearch] Index integrity:', summary);
    return summary;
  }

  /**
   * Repairs the denormalized prompts on child rows against the current index. The map covers
   * every row, not just top-level ones, because a grandchild's parent is a child row.
   */
  function backfillChildParentPrompts() {
    const promptById = buildPromptById();
    const updated = [];
    for (const p of allPosts) {
      if (!isChildPost(p) || !p.parentId) continue;
      const rootId = getRootIdOf(p);
      const hasRoot = Boolean(rootId) && rootId !== p.parentId;
      // An orphan keeps whatever text it already carries — dropping it would make the row
      // unsearchable, and a missing parent usually means a truncated sync, not a real deletion.
      const nextParentPrompt = promptById.has(p.parentId)
        ? (promptById.get(p.parentId) || '')
        : (p.parentPrompt || '');
      const nextRootPrompt = !hasRoot ? '' : (promptById.has(rootId)
        ? (promptById.get(rootId) || '')
        : (p.rootPrompt || ''));
      if ((p.parentPrompt || '') === nextParentPrompt && (p.rootPrompt || '') === nextRootPrompt) continue;
      const row = normalizePost({
        ...p,
        parentPrompt: nextParentPrompt,
        rootPrompt: nextRootPrompt,
      });
      updated.push(updatePostRow(row) || p);
    }
    return updated;
  }

  /** True for parents whose child tree is worth re-fetching via post/get. */
  function postHasKnownChildren(post) {
    return (post.childPostCount ?? 0) > 0
      || (post.childImageCount ?? 0) > 0
      || (post.childVideoCount ?? 0) > 0
      || (post.videoCount ?? 0) > 1;
  }

  function metadataAgeMs(post) {
    const at = post?.[METADATA_REFRESH_KEY];
    return typeof at === 'number' ? Date.now() - at : Infinity;
  }

  /**
   * Deep-refresh candidacy. Childless parents qualify too — that is the only way a post's
   * *first* child is ever discovered outside the list-refresh window; SYNC_DEEP_CHILDLESS_SLOTS
   * reserves budget for them. Recently refreshed rows are skipped so repeated syncs stop
   * re-fetching the same top-of-feed posts.
   */
  function postNeedsDeepRefresh(post) {
    if (isChildPost(post)) return false;
    return metadataAgeMs(post) >= SYNC_DEEP_REFRESH_TTL_MS;
  }

  function stampMetadataRefreshed(post) {
    return { ...post, [METADATA_REFRESH_KEY]: Date.now() };
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
    const writer = createIndexWriter();
    const newPosts = [];
    let newCount = 0;
    let listUpdatedCount = 0;
    let childSyncCount = 0;
    let cursor = null;
    let pageIndex = 0;
    let failed = false;

    while (true) {
      const page = await fetchPage(cursor);
      if (!page.ok) { failed = true; break; }
      const posts = page.posts;
      if (posts.length === 0) break;

      const refreshThisPage = pageIndex < SYNC_LIST_REFRESH_PAGES;
      let pageNew = 0;

      for (const raw of posts) {
        const parsed = parsePost(raw);
        if (!parsed) continue;

        if (!knownIds.has(parsed.id)) {
          // Register the parent before collecting children so a child that is also a
          // liked post in its own right is not re-collected as a child row.
          newPosts.push(addPostRow(stampMetadataRefreshed(normalizePost(parsed))));
          for (const child of collectChildRecords(raw, parsed)) {
            if (knownIds.has(child.id)) continue;
            newPosts.push(addPostRow(child));
          }
          pageNew++;
          continue;
        }

        if (refreshThisPage) {
          const cached = postById.get(parsed.id);
          if (cached) {
            const previousPrompt = cached.prompt;
            // Deliberately not stamped: METADATA_REFRESH_KEY tracks the last *deep*
            // (post/get) refresh, and the list payload may carry a shallower child tree.
            const merged = normalizePost({ ...cached, ...parsed });
            const changed = postMetadataChanged(cached, merged);
            const row = changed ? (updatePostRow(merged) || cached) : cached;
            if (changed) {
              writer.put(row);
              listUpdatedCount++;
            }
            if (row.prompt !== previousPrompt) {
              childSyncCount += propagateParentPromptToChildren(row.id, row.prompt, writer);
            }
            const childStats = syncChildRecordsForParent(raw, row, writer);
            childSyncCount += childStats.added + childStats.updated + childStats.removed;
          }
        }
      }

      pageIndex++;
      const needNewPages = pageNew > 0;
      const needRefreshPages = pageIndex < SYNC_LIST_REFRESH_PAGES;
      if (!needNewPages && !needRefreshPages) break;
      if (!page.nextCursor) break;

      cursor = page.nextCursor;
      if (statusEl) {
        setLoadStatus(`syncing… +${newPosts.length} new, ${listUpdatedCount} updated`);
      }
      await sleep(SYNC_LIST_PAGE_DELAY_MS);
    }

    if (newPosts.length > 0) {
      sortAllPostsNewestFirst();
      for (const p of newPosts) writer.put(p);
      newCount = newPosts.length;
      console.log(`[GrokSearch] +${newCount} new row(s) from liked list (parents + children)`);
    }

    await writer.flush();
    if (listUpdatedCount > 0) {
      console.log(`[GrokSearch] List refresh: ${listUpdatedCount} parent(s)`);
    }

    const deepUpdatedCount = await refreshPostsViaGet(statusEl);

    // The asset feed is the only path that reaches recently generated media, so it runs on every
    // sync. It is ordered, so it stops on its own after a few all-known pages.
    const assets = await syncAssetsFeed(statusEl);

    return {
      newCount: newCount + assets.added,
      updatedCount: listUpdatedCount + deepUpdatedCount + childSyncCount + assets.updated,
      failed: failed || assets.failed,
    };
  }

  /** post/get for recent items with children — parallel, skips rows already updated from list. */
  /**
   * Picks the deep-refresh batch from the newest parents, reserving SYNC_DEEP_CHILDLESS_SLOTS
   * for parents that have no children yet so a first variation can be discovered.
   */
  function pickDeepRefreshTargets() {
    const withChildren = [];
    const childless = [];
    const scanLimit = SYNC_DEEP_REFRESH_LIMIT * 8;
    let scanned = 0;
    for (const p of allPosts) {
      if (isChildPost(p)) continue;
      if (++scanned > scanLimit) break;
      if (!postNeedsDeepRefresh(p)) continue;
      if (postHasKnownChildren(p)) withChildren.push(p);
      else childless.push(p);
      // Both buckets must fill before stopping — posts with children dominate the head of
      // the feed, so an early break would leave the reserved childless slots empty.
      if (withChildren.length >= SYNC_DEEP_REFRESH_LIMIT
        && childless.length >= SYNC_DEEP_CHILDLESS_SLOTS) break;
    }
    const reserved = Math.min(SYNC_DEEP_CHILDLESS_SLOTS, childless.length);
    const chosenParents = withChildren.slice(0, SYNC_DEEP_REFRESH_LIMIT - reserved);
    const chosenChildless = childless.slice(0, SYNC_DEEP_REFRESH_LIMIT - chosenParents.length);
    return [...chosenParents, ...chosenChildless];
  }

  /**
   * post/get for recent parents — parallel fetch, serial apply. The TTL gate makes the
   * batch rotate through the recent window instead of re-fetching the same top-24 on
   * every single sync the way it used to.
   */
  async function refreshPostsViaGet(statusEl) {
    const targets = pickDeepRefreshTargets();
    if (!targets.length) return 0;

    const writer = createIndexWriter();
    const fetched = [];
    let updatedCount = 0;
    let childSyncCount = 0;
    let done = 0;

    // Fetch in parallel, then apply serially: applying inside the pool would let one
    // worker's index mutation land between another worker's read and write.
    await runPool(targets, SYNC_DEEP_CONCURRENCY, async cached => {
      const remote = await fetchRemotePost(cached.id);
      done++;
      if (statusEl && done % 6 === 0) {
        setLoadStatus(`deep refresh… ${done}/${targets.length}`);
      }
      if (remote) fetched.push({ id: cached.id, remote });
    });

    for (const { id, remote } of fetched) {
      const cached = postById.get(id);
      if (!cached) continue;
      const previousPrompt = cached.prompt;
      const merged = stampMetadataRefreshed(mergePostFromRemote(cached, remote));
      const changed = postMetadataChanged(cached, merged);
      const row = updatePostRow(merged) || cached;
      writer.put(row);
      if (changed) updatedCount++;
      if (row.prompt !== previousPrompt) {
        childSyncCount += propagateParentPromptToChildren(row.id, row.prompt, writer);
      }
      const childStats = syncChildRecordsForParent(remote, row, writer);
      childSyncCount += childStats.added + childStats.updated + childStats.removed;
    }

    await writer.flush();
    if (updatedCount > 0 || childSyncCount > 0) {
      console.log(`[GrokSearch] Deep refresh: ${updatedCount} parent(s), ${childSyncCount} child row change(s)`);
    }
    return updatedCount + childSyncCount;
  }

  /** Remove rows from memory and queue their deletion. Only reconciliation deletes parents. */
  function removeRowsById(ids, writer) {
    const doomed = new Set(ids);
    if (!doomed.size) return 0;
    allPosts = allPosts.filter(p => !doomed.has(p.id));
    for (const id of doomed) {
      knownIds.delete(id);
      selectedPostIds.delete(id);
      writer.del(id);
    }
    rebuildPostIndex();
    return doomed.size;
  }

  /**
   * Walks the entire liked feed collecting ids, then makes the index match it: rows that are
   * no longer liked are deleted, and posts liked long after they were created (which the
   * incremental sync never reaches, because it stops after a few pages) are added.
   *
   * Deliberately cheap: no post/get calls, and existing rows are left untouched — the regular
   * sync owns metadata. Deletions are only applied when the walk completes, because a partial
   * id set would look exactly like a mass unlike.
   */
  async function reconcileLikedIndex(statusEl) {
    const remoteIds = new Set();
    const writer = createIndexWriter();
    const added = [];
    const seenCursors = new Set();
    let cursor = null;
    let pageIndex = 0;
    let complete = false;

    while (true) {
      const page = await fetchPage(cursor);
      if (!page.ok) return { ok: false, reason: 'network', added: 0, removed: 0 };
      const posts = page.posts;

      for (const raw of posts) {
        const parsed = parsePost(raw);
        if (!parsed) continue;
        // Collect ids straight from the payload: collectChildRecords() intentionally skips
        // posts that already exist as parents, and those ids must still count as present.
        remoteIds.add(parsed.id);
        walkDescendantPosts(raw, c => { if (c?.id) remoteIds.add(String(c.id)); });

        if (!knownIds.has(parsed.id)) {
          added.push(addPostRow(stampMetadataRefreshed(normalizePost(parsed))));
        }
        for (const child of collectChildRecords(raw, postById.get(parsed.id) || parsed)) {
          if (!knownIds.has(child.id)) added.push(addPostRow(child));
        }
      }

      if (statusEl) setLoadStatus(`verifying… ${remoteIds.size.toLocaleString()}`);
      cursor = page.nextCursor;
      if (!cursor || posts.length === 0) { complete = true; break; }
      if (seenCursors.has(cursor)) {
        console.warn('[GrokSearch] Reconcile stopped: repeated cursor');
        break;
      }
      seenCursors.add(cursor);
      if (++pageIndex >= FULL_INDEX_MAX_PAGES) {
        console.warn(`[GrokSearch] Reconcile stopped at ${FULL_INDEX_MAX_PAGES} pages`);
        break;
      }
      await sleep(SYNC_LIST_PAGE_DELAY_MS);
    }

    // The index is fed by two sources now, so presence has to be judged against both. Without
    // this the sweep would consider every row that came from the asset feed missing and try to
    // delete it -- the media/post/list walk cannot see recently generated media at all.
    if (complete) {
      let assetToken = null;
      let assetPages = 0;
      const seenAssetTokens = new Set();
      while (assetPages < ASSETS_MAX_PAGES) {
        const page = await fetchAssetPage(assetToken);
        if (!page.ok) {
          console.warn('[GrokSearch] Reconcile: asset walk failed, refusing to delete anything');
          complete = false;
          break;
        }
        for (const a of page.assets) {
          // Same predicate the sync uses. Counting a stock asset as "present" here would make
          // Verify keep the very rows parseAsset() now refuses to add.
          if (a?.assetId && isIndexableAsset(a)) remoteIds.add(String(a.assetId));
        }
        assetPages++;
        if (statusEl) setLoadStatus(`verifying… ${remoteIds.size.toLocaleString()}`);
        if (!page.nextPageToken || seenAssetTokens.has(page.nextPageToken)) break;
        seenAssetTokens.add(page.nextPageToken);
        assetToken = page.nextPageToken;
        await sleep(SYNC_LIST_PAGE_DELAY_MS);
      }
      if (assetPages >= ASSETS_MAX_PAGES) {
        console.warn('[GrokSearch] Reconcile: asset walk hit the page cap, refusing to delete');
        complete = false;
      }
    }

    let removed = 0;
    let refusedDelete = 0;
    if (complete) {
      const stale = allPosts.filter(p => !remoteIds.has(p.id)).map(p => p.id);
      const ratio = allPosts.length ? stale.length / allPosts.length : 0;
      if (stale.length && ratio > RECONCILE_MAX_DELETE_RATIO) {
        refusedDelete = stale.length;
        console.warn(
          `[GrokSearch] Reconcile refused to delete ${stale.length} of ${allPosts.length} rows `
          + `(${Math.round(ratio * 100)}%) — treating as a bad feed response, not mass unliking`
        );
      } else {
        removed = removeRowsById(stale, writer);
      }
    }

    for (const row of added) writer.put(row);
    if (added.length) sortAllPostsNewestFirst();
    await writer.flush();

    if (complete && !refusedDelete) writeStoredString(RECONCILE_LAST_RUN_KEY, String(Date.now()));
    console.log(`[GrokSearch] Reconcile: +${added.length} added, -${removed} removed, `
      + `${remoteIds.size} liked rows remote, complete=${complete}`);
    return { ok: complete, reason: refusedDelete ? 'refused' : '', added: added.length, removed, refusedDelete };
  }

  function formatReconcileMessage(result) {
    if (!result.ok && result.reason === 'network') return 'verify failed — check connection';
    if (result.reason === 'refused') return 'verify aborted — unexpected feed response';
    if (!result.ok) return 'verify incomplete';
    const parts = [];
    if (result.added > 0) parts.push(`+${result.added} added`);
    if (result.removed > 0) parts.push(`-${result.removed} removed`);
    return parts.length ? `verified (${parts.join(', ')})` : 'verified — index matches';
  }

  async function runReconcile({ manual = false } = {}) {
    if (indexing || syncInProgress || reconcileInProgress || !loaded) return null;
    reconcileInProgress = true;
    const statusEl = document.getElementById('grok-stamp-status');
    const btn = document.getElementById('grok-verify-btn');
    if (btn) btn.disabled = true;
    try {
      if (!db) db = await openDB();
      if (manual) setLoadStatus('verifying index…');
      const result = await reconcileLikedIndex(statusEl);
      if (result.added > 0 || result.removed > 0) applyFilter();
      if (manual || result.added > 0 || result.removed > 0 || !result.ok) {
        setLoadStatus(formatReconcileMessage(result));
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
      }
      return result;
    } catch (e) {
      console.error('[GrokSearch] Reconcile failed:', e);
      setLoadStatus('verify failed');
      return null;
    } finally {
      reconcileInProgress = false;
      if (btn) btn.disabled = false;
    }
  }

  /**
   * An index built before schema 4 only ever contained liked posts and has no like state, so it
   * cannot answer "show me everything" or "liked only". Nudge once rather than silently
   * presenting a partial library as complete.
   *
   * Schema 5 (true grandchild edges) needs no nudge: `rootId` is derived on load and the real
   * edges are rewritten the next time each parent is deep-refreshed, so a v4 index self-heals.
   */
  function checkIndexSchemaFreshness() {
    const stored = Number(readStoredString(INDEX_VERSION_KEY, '0')) || 0;
    if (stored >= INDEX_SCHEMA_VERSION) return;
    if (!allPosts.length || stored >= 4) {
      writeStoredString(INDEX_VERSION_KEY, String(INDEX_SCHEMA_VERSION));
      return;
    }
    console.warn(`[GrokSearch] Index was built with schema v${stored || '<4'}; it covers liked posts only `
      + 'and has no like state. Click Reindex to pick up your whole library.');
    setLoadStatus('older index — click Reindex for your full library');
    const statusEl = document.getElementById('grok-stamp-status');
    setTimeout(() => { if (statusEl && statusEl.textContent.startsWith('older index')) statusEl.textContent = ''; }, 12000);
  }

  /** Background sweep, at most once per RECONCILE_INTERVAL_MS. */
  async function maybeRunScheduledReconcile() {
    const last = Number(readStoredString(RECONCILE_LAST_RUN_KEY, '0')) || 0;
    if (Date.now() - last < RECONCILE_INTERVAL_MS) return;
    console.log('[GrokSearch] Running scheduled index reconciliation');
    await runReconcile({ manual: false });
  }

  // ─── Asset feed ─────────────────────────────────────────────────────────────
  /**
   * Grok moved Imagine's library off media/post/list. That endpoint still answers, but it is
   * unordered (two identical calls return different samples), it returns no child trees, and
   * nothing created since roughly June 2026 appears in it at all -- which is why newly generated
   * images stopped being indexed.
   *
   * /rest/assets is what the current UI actually paginates. It is ordered by create time,
   * descending, and each row carries everything a index row needs, so there is no per-item
   * request: the prompt and model come from `mediaGenInput`, and the media URL is the asset's
   * storage `key` under the CDN host.
   *
   * `assetId` is the same id space as a media post id, so rows from here merge with rows the old
   * feed produced instead of duplicating them.
   */
  function gmGetJson(url, label) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        withCredentials: true,
        onload: res => {
          if (res.status < 200 || res.status >= 300) {
            console.warn(`[GrokSearch] ${label} HTTP ${res.status}`);
            resolve({ ok: false, status: res.status });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(res.responseText) });
          } catch {
            console.warn(`[GrokSearch] ${label} response was not JSON`);
            resolve({ ok: false, status: res.status });
          }
        },
        onerror: () => resolve({ ok: false, status: 0 }),
        ontimeout: () => resolve({ ok: false, status: 0 }),
      });
    });
  }

  function buildAssetsUrl(pageToken) {
    const qs = new URLSearchParams({
      pageSize: String(ASSETS_PAGE_SIZE),
      orderBy: 'ORDER_BY_CREATE_TIME',
      workspaceKind: ASSETS_WORKSPACE,
    });
    if (pageToken) qs.set('pageToken', String(pageToken));
    return `${ASSETS_ENDPOINT}?${qs.toString()}`;
  }

  async function fetchAssetPage(pageToken) {
    const res = await gmGetJson(buildAssetsUrl(pageToken), 'assets');
    if (!res.ok) return { ok: false, status: res.status };
    return {
      ok: true,
      assets: Array.isArray(res.data?.assets) ? res.data.assets : [],
      nextPageToken: res.data?.nextPageToken || null,
    };
  }

  /** The storage key is a path; each segment is encoded so spaces or unicode cannot break it. */
  function assetMediaUrl(asset) {
    const key = String(asset?.key || '');
    if (!key) return '';
    return ASSET_CDN_BASE + key.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * `mediaGenInput` is a oneof: textToImage, imageToVideo, textToVideo, … Rather than listing
   * them, take the first branch that carries a prompt, so a new generation mode still indexes.
   */
  function assetGenInput(asset) {
    const gen = asset?.mediaGenInput;
    if (!gen || typeof gen !== 'object') return null;
    for (const value of Object.values(gen)) {
      if (value && typeof value === 'object' && (value.prompt || value.modelName)) return value;
    }
    return null;
  }

  function assetMediaType(asset) {
    const mime = String(asset?.mimeType || '');
    if (mime.startsWith('video/')) return 'MEDIA_POST_TYPE_VIDEO';
    if (mime.startsWith('image/')) return 'MEDIA_POST_TYPE_IMAGE';
    return '';
  }

  /**
   * The asset feed carries more than the user's own generated media, and two kinds of row do not
   * belong in a searchable image index:
   *
   * - **Grok's stock character assets** (`Lena-Picture.png`, `Michael-Voice.mp3`, …). They are
   *   copied into every account -- `auxKeys.duplicated_from_asset_id` points at the original --
   *   and carry no `mediaGenInput`, so they show up as blank cards the user never made.
   * - **Anything that is not an image or a video.** The voice files are `audio/mpeg`; rendering
   *   one in an `<img>` gives an empty card with no way to tell why.
   *
   * Checked against 900 live assets: 8 matched, every one a stock `*-Voice.mp3` / `*-Picture.png`,
   * and no ordinary generated image was caught. Deliberately *not* filtered on: a missing
   * `mediaGenInput` alone, which would also drop the user's own uploads
   * (`IMAGINE_SELF_UPLOAD_FILE_SOURCE`), and the `.../content` URL shape, which 4,231 perfectly
   * good rows in a real index also use.
   */
  function isIndexableAsset(asset) {
    if (!asset || asset.isDeleted) return false;
    if (String(asset.auxKeys?.imagine_official_asset) === 'true') return false;
    return /^(image|video)\//.test(String(asset.mimeType || ''));
  }

  /** Assets carry no like state; `null` means unknown, which is what the Liked filter expects. */
  function parseAsset(asset) {
    const id = String(asset?.assetId || '');
    if (!id || !isIndexableAsset(asset)) return null;
    const gen = assetGenInput(asset);
    const url = assetMediaUrl(asset);
    return {
      id,
      prompt: String(gen?.prompt || asset?.summary || ''),
      thumbnail: url,
      mediaUrl: url,
      createTime: String(asset?.createTime || ''),
      model: String(gen?.modelName || ''),
      mediaType: assetMediaType(asset),
      isChild: false,
      parentId: null,
      rootId: null,
      parentPrompt: null,
      rootPrompt: null,
      conversationId: String(asset?.sourceConversationId || ''),
      isLiked: detectLikedState(asset),
      childPostCount: 0,
      childImageCount: 0,
      childVideoCount: 0,
      videoCount: assetMediaType(asset) === 'MEDIA_POST_TYPE_VIDEO' ? 1 : 0,
    };
  }

  /**
   * Walks the asset feed newest-first and merges what it finds.
   *
   * `stopWhenKnown` is what makes the routine sync cheap: because the feed really is ordered,
   * once ASSETS_SYNC_STALE_PAGES consecutive pages contain nothing new, everything older is
   * already indexed. A full reindex passes false and walks to the end.
   */
  async function syncAssetsFeed(statusEl, { stopWhenKnown = true, label = 'syncing' } = {}) {
    const writer = createIndexWriter();
    const fresh = [];
    let pageToken = null;
    let pages = 0;
    let added = 0;
    let updated = 0;
    let stalePages = 0;
    let failed = false;
    const seenTokens = new Set();

    while (pages < ASSETS_MAX_PAGES) {
      const page = await fetchAssetPage(pageToken);
      if (!page.ok) { failed = true; break; }
      if (!page.assets.length) break;

      let pageNew = 0;
      for (const raw of page.assets) {
        const parsed = parseAsset(raw);
        if (!parsed) continue;
        const cached = postById.get(parsed.id);
        if (!cached) {
          fresh.push(addPostRow(stampMetadataRefreshed(normalizePost(parsed))));
          pageNew++;
          added++;
          continue;
        }
        // An existing row may have come from the old feed, which carried child links and like
        // state the asset feed does not. Keep those rather than blanking them.
        const merged = normalizePost({
          ...cached,
          ...parsed,
          isChild: cached.isChild,
          parentId: cached.parentId,
          rootId: cached.rootId,
          parentPrompt: cached.parentPrompt,
          rootPrompt: cached.rootPrompt,
          childPostCount: cached.childPostCount,
          childImageCount: cached.childImageCount,
          childVideoCount: cached.childVideoCount,
          videoCount: cached.videoCount ?? parsed.videoCount,
          prompt: parsed.prompt || cached.prompt,
          isLiked: parsed.isLiked ?? cached.isLiked ?? null,
        });
        if (postMetadataChanged(cached, merged)) {
          writer.put(updatePostRow(merged) || cached);
          updated++;
        }
      }

      pages++;
      stalePages = pageNew > 0 ? 0 : stalePages + 1;
      if (statusEl) setLoadStatus(`${label}… +${added} new, ${updated} updated`);
      if (stopWhenKnown && stalePages >= ASSETS_SYNC_STALE_PAGES) break;
      if (!page.nextPageToken) break;
      if (seenTokens.has(page.nextPageToken)) {
        console.warn('[GrokSearch] Asset walk stopped: repeated page token');
        break;
      }
      seenTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
      await sleep(SYNC_LIST_PAGE_DELAY_MS);
    }

    if (fresh.length) {
      sortAllPostsNewestFirst();
      for (const row of fresh) writer.put(row);
    }
    await writer.flush();
    if (added || updated) {
      console.log(`[GrokSearch] Asset feed: +${added} new, ${updated} updated over ${pages} page(s)`);
    }
    return { added, updated, pages, failed };
  }

  function formatSyncStatusMessage(newCount, refreshedCount) {
    const parts = [];
    if (newCount > 0) parts.push(`+${newCount} new`);
    if (refreshedCount > 0) parts.push(`${refreshedCount} updated`);
    if (!parts.length) return 'up to date';
    return `${parts.join(', ')} (${allPosts.length.toLocaleString()} total)`;
  }

  function syncMinIntervalMs(reason) {
    if (reason === 'focus') return SYNC_FOCUS_MIN_INTERVAL_MS;
    if (reason === 'navigation') return SYNC_NAV_MIN_INTERVAL_MS;
    return 0;
  }

  async function runIncrementalSync(reason, options = {}) {
    const { quiet = false } = options;
    if (!isImagineListPage()) return;
    if (indexing || !loaded) return;
    // A trigger that arrives mid-sync is remembered, not dropped: returning from a post
    // page right after generating an image is exactly when one tends to land.
    if (syncInProgress) {
      pendingSyncReason = reason;
      return;
    }
    if (Date.now() - lastIncrementalSyncAt < syncMinIntervalMs(reason)) return;

    syncInProgress = true;
    const statusEl = document.getElementById('grok-stamp-status');
    try {
      if (!db) db = await openDB();
      if (!quiet && statusEl) statusEl.textContent = 'syncing…';
      const { newCount, updatedCount: refreshedCount, failed } = await syncLikedFeed(statusEl);
      lastIncrementalSyncAt = Date.now();
      if (!quiet && statusEl) {
        statusEl.textContent = failed
          ? 'sync incomplete — check connection'
          : formatSyncStatusMessage(newCount, refreshedCount);
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, failed ? 5000 : 3000);
      }
      if (newCount > 0 || refreshedCount > 0) applyFilter();
      console.log(`[GrokSearch] Sync (${reason}): +${newCount} new, ${refreshedCount} metadata updated${failed ? ' (incomplete)' : ''}`);
    } catch (e) {
      console.error(`[GrokSearch] Sync failed (${reason}):`, e);
      if (!quiet && statusEl) statusEl.textContent = 'sync failed';
    } finally {
      syncInProgress = false;
      if (pendingSyncReason) {
        const next = pendingSyncReason;
        pendingSyncReason = null;
        scheduleIncrementalSync(next, options);
      }
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
    postById.clear();
    indexRevision++;
    knownIds.clear();
    selectedPostIds.clear();
    matchedPosts = [];
    currentPage = 0;
    if (reindexBtn) reindexBtn.disabled = true;
    showLoadingIndicator('Reindexing saved posts…');
    try {
      if (!db) db = await openDB();
      // Reindex is the moment to re-detect the source: Grok has changed it before.
      await resolveMediaSource({ force: true });
      await dbClear();
      setLoadStatus('reindexing…');
      const count = await fetchFullIndex(statusEl);
      loaded = true;
      writeStoredString(INDEX_VERSION_KEY, String(INDEX_SCHEMA_VERSION));
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

  /**
   * IndexedDB is evictable by default, so a large index can vanish under storage pressure and
   * cost a full API rebuild. Asking once makes the browser treat it as durable storage.
   */
  async function requestPersistentStorage() {
    try {
      if (!navigator.storage?.persist) return;
      if (await navigator.storage.persisted()) return;
      const granted = await navigator.storage.persist();
      console.log(`[GrokSearch] Persistent storage ${granted ? 'granted' : 'not granted'}`);
    } catch (e) {
      console.warn('[GrokSearch] Persistent storage request failed:', e);
    }
  }

  /**
   * Merges an exported index back in: rows in the file win for ids it contains, everything
   * else is left alone. Nothing is deleted — use Verify for that.
   */
  async function importDatabaseJson(file) {
    const statusEl = document.getElementById('grok-stamp-status');
    const btn = document.getElementById('grok-import-json-btn');
    if (btn) btn.disabled = true;
    try {
      setLoadStatus('reading import…');
      const payload = JSON.parse(await file.text());
      const rows = Array.isArray(payload) ? payload : payload?.posts;
      if (!Array.isArray(rows)) throw new Error('no posts array in file');

      const version = Number(payload?.schemaVersion ?? INDEX_SCHEMA_VERSION);
      if (version > INDEX_SCHEMA_VERSION) {
        console.warn(`[GrokSearch] Import schema v${version} is newer than v${INDEX_SCHEMA_VERSION}; unknown fields are dropped`);
      }

      if (!db) db = await openDB();
      const writer = createIndexWriter();
      let addedCount = 0;
      let updatedCount = 0;
      let skipped = 0;

      for (const raw of rows) {
        if (!raw?.id) { skipped++; continue; }
        const row = normalizePost(raw);
        const cached = postById.get(row.id);
        if (!cached) {
          writer.put(addPostRow(row));
          addedCount++;
          continue;
        }
        if (!postMetadataChanged(cached, row)) continue;
        writer.put(updatePostRow(row) || cached);
        updatedCount++;
      }

      if (addedCount) sortAllPostsNewestFirst();
      await writer.flush();
      backfillChildParentPrompts();
      applyFilter();

      const summary = `imported +${addedCount} new, ${updatedCount} updated`
        + (skipped ? `, ${skipped} skipped` : '');
      setLoadStatus(summary);
      console.log(`[GrokSearch] Import: ${summary} (${rows.length} rows in file)`);
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
    } catch (e) {
      console.error('[GrokSearch] Import failed:', e);
      setLoadStatus('import failed — not a valid index export');
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
    } finally {
      if (btn) btn.disabled = false;
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
          'id', 'prompt', 'parentPrompt', 'parentId', 'rootId', 'rootPrompt', 'isChild',
          'thumbnail', 'mediaUrl', 'createTime', 'model', 'mediaType',
          'childPostCount', 'childImageCount', 'childVideoCount', 'videoCount', 'isLiked',
          'conversationId',
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
      filterVideoOnly,
      filterWithVideo,
      filterOnlyChildren,
      filterHideChilds,
      filterMinChildren,
      filterModel,
      filterLikedOnly,
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
          'id', 'prompt', 'parentPrompt', 'parentId', 'rootId', 'rootPrompt', 'isChild',
          'thumbnail', 'mediaUrl', 'createTime', 'model', 'mediaType',
          'childPostCount', 'childImageCount', 'childVideoCount', 'videoCount', 'isLiked',
          'conversationId',
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

  function byCreatedDesc(a, b) {
    return (b[RUNTIME_MS] ?? 0) - (a[RUNTIME_MS] ?? 0);
  }

  function sortAllPostsNewestFirst() {
    allPosts.sort(byCreatedDesc);
  }

  async function fetchFullIndex(statusEl) {
    // The asset feed carries everything Grok currently exposes, in order, so it goes first and
    // is walked to the end. The legacy list pass then follows for the child trees it still has
    // and the asset feed does not.
    setLoadStatus('indexing library…');
    const assets = await syncAssetsFeed(statusEl, { stopWhenKnown: false, label: 'indexing' });

    const allFetched = [];
    let cursor = null;
    let pageIndex = 0;
    const seenCursors = new Set();
    while (true) {
      const page = await fetchPage(cursor);
      if (!page.ok) break;
      const posts = page.posts;
      for (const post of posts) {
        const parsed = parsePost(post);
        if (!parsed || knownIds.has(parsed.id)) continue;
        allFetched.push(addPostRow(stampMetadataRefreshed(normalizePost(parsed))));
        for (const child of collectChildRecords(post, parsed)) {
          if (knownIds.has(child.id)) continue;
          allFetched.push(addPostRow(child));
        }
      }
      if (statusEl) setLoadStatus(`indexing… ${allFetched.length.toLocaleString()}`);
      cursor = page.nextCursor;
      if (!cursor || posts.length === 0) break;
      // A cursor that repeats (or a feed that never terminates) would otherwise loop forever.
      if (seenCursors.has(cursor)) {
        console.warn('[GrokSearch] Full index stopped: repeated cursor');
        break;
      }
      seenCursors.add(cursor);
      if (++pageIndex >= FULL_INDEX_MAX_PAGES) {
        console.warn(`[GrokSearch] Full index stopped at ${FULL_INDEX_MAX_PAGES} pages`);
        break;
      }
      await sleep(SYNC_LIST_PAGE_DELAY_MS);
    }
    sortAllPostsNewestFirst();
    const chunkSize = 500;
    for (let i = 0; i < allFetched.length; i += chunkSize) {
      await dbPutMany(allFetched.slice(i, i + chunkSize));
      if (statusEl) setLoadStatus(`saving… ${Math.min(i + chunkSize, allFetched.length)}/${allFetched.length}`);
    }
    return allFetched.length + assets.added;
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
      await resolveMediaSource();
      const cached = await dbGetAll();
      if (cached.length > 0) {
        for (const p of cached) {
          if (knownIds.has(p.id)) continue;
          addPostRow(normalizePost(p));
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
        const { newCount, updatedCount: refreshedCount, failed } = await syncLikedFeed(statusEl);
        lastIncrementalSyncAt = Date.now();
        if (statusEl) {
          setLoadStatus(failed
            ? 'sync incomplete — check connection'
            : formatSyncStatusMessage(newCount, refreshedCount));
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, failed ? 5000 : 3000);
        }
      } else {
        setLoadStatus('first-time indexing…');
        const count = await fetchFullIndex(statusEl);
        loaded = true;
        writeStoredString(INDEX_VERSION_KEY, String(INDEX_SCHEMA_VERSION));
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
        // Second pass on the next frame: the first showResults() can bail when the results
        // grid has nowhere to mount yet, and enforceDisplayMode() alone does not re-render.
        requestAnimationFrame(() => {
          applyFilter();
          scheduleEnforceDisplay();
        });
        verifyIndexIntegrity();
      } else {
        hideLoadingIndicator();
      }
    }
    // Outside the try/finally so `indexing` is already false and the guard lets it run.
    if (loaded) {
      checkIndexSchemaFreshness();
      warnIfLikesOnly();
      maybeRunScheduledReconcile();
    }
  }

  // ─── Results ───────────────────────────────────────────────────────────────
  function getGrokGrid() {
    const cards = document.querySelectorAll('[class*="media-post-masonry-card"], main a[href^="/imagine/post/"]:not(.grok-lightbox-kid)');
    if (!cards.length) return null;
    const total = cards.length;
    let el = cards[0].parentElement;
    while (el && el !== document.body && el.tagName !== 'MAIN') {
      if (el.querySelectorAll('[class*="media-post-masonry-card"], a[href^="/imagine/post/"]:not(.grok-lightbox-kid)').length === total) {
        return el;
      }
      el = el.parentElement;
    }
    return cards[0].parentElement;
  }

  function getNativeSavedRoot() {
    const cards = document.querySelectorAll('[class*="media-post-masonry-card"], main a[href^="/imagine/post/"]:not(.grok-lightbox-kid)');
    if (!cards.length) return getGrokGrid();
    const totalCards = cards.length;
    let el = cards[0].parentElement;
    let best = null;
    for (let i = 0; i < 15 && el && el !== document.body; i++) {
      if (el.tagName === 'MAIN' || el.getAttribute('role') === 'main' || el.tagName === 'HEADER' || el.tagName === 'NAV') break;
      if (el.querySelector && el.querySelector('nav, header, textarea, input[type="text"], [role="navigation"], [role="banner"]')) break;
      const count = el.querySelectorAll('[class*="media-post-masonry-card"], a[href^="/imagine/post/"]:not(.grok-lightbox-kid)').length;
      if (count > 0) {
        best = el;
        if (count === totalCards) break;
      }
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

  const HID_GRID_ATTR = 'data-grok-hid-grid';
  const HID_ROOT_ATTR = 'data-grok-hid-root';

  /**
   * Hiding is recorded on the element, and un-hiding finds it back through that marker rather
   * than re-deriving it.
   *
   * This is not defensive style, it is a fix: getGrokGrid() and getNativeSavedRoot() both
   * locate the container by searching for `[class*="media-post-masonry-card"]`, and React drops
   * those cards while their container is `display: none`. Once that happened the lookup
   * returned null, the un-hide was skipped, and the inline `display: none !important` survived
   * until a reload -- a blank Grok page behind a collapsed search bar.
   */
  function showNativeHidden(attr) {
    document.querySelectorAll(`[${attr}]`).forEach(el => {
      el.removeAttribute(attr);
      if (attr === HID_ROOT_ATTR) delete el.dataset.grokNativeSavedRoot;
      // The grid and the saved root can resolve to the same node; only the last marker to go
      // may clear the inline styles.
      if (el.hasAttribute(HID_GRID_ATTR) || el.hasAttribute(HID_ROOT_ATTR)) return;
      el.style.removeProperty('display');
      el.style.removeProperty('visibility');
    });
  }

  function hideNativeElement(el, attr) {
    if (!el) return;
    el.setAttribute(attr, '1');
    if (attr === HID_ROOT_ATTR) el.dataset.grokNativeSavedRoot = '1';
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
  }

  function setNativeGridVisible(visible) {
    if (visible) {
      showNativeHidden(HID_GRID_ATTR);
    } else {
      const grid = getGrokGrid();
      if (grid) hideNativeElement(grid, HID_GRID_ATTR);
      const nativeCards = document.querySelectorAll(
        '[class*="media-post-masonry-card"], main a[href^="/imagine/post/"]:not(.grok-lightbox-kid)'
      );
      nativeCards.forEach(card => {
        if (!card.closest('#grok-results-panel') && !card.closest('#grok-inline-results-viewport') && !card.closest('#grok-result-lightbox')) {
          hideNativeElement(card, HID_GRID_ATTR);
        }
      });
    }
  }

  function setNativeSavedRootVisible(visible) {
    if (visible) showNativeHidden(HID_ROOT_ATTR);
    else hideNativeElement(getNativeSavedRoot(), HID_ROOT_ATTR);
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
    // A collapsed search bar means "get out of the way", so no mode class may survive it --
    // `grok-custom-results-mode` alone keeps the native grid hidden through CSS, whatever the
    // inline styles say.
    const active = searchBarExpanded;
    document.documentElement.classList.toggle('grok-results-only-mode', active && resultsOnly);
    document.documentElement.classList.toggle('grok-custom-results-mode', active && resultsOnly);
    document.documentElement.classList.toggle(
      'grok-filtered-inline-mode',
      active && hasActiveFilter() && !resultsOnly
    );
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

  /**
   * Renders whatever `applyFilter()` just matched.
   *
   * It deliberately does **not** reset `currentPage`. Going back to page 1 is a response to the
   * user changing what they are looking at, so it belongs to the handlers that do that -- and
   * every one of them already does it (the search box, the date inputs and day stepper, the
   * media/liked/model filters, sort, Clear, the page-size and compact switches, and Reindex,
   * which clears the index outright).
   *
   * Resetting here instead meant *anything* that re-rendered dragged the reader back to page 1:
   * an incremental sync that found one new post, a Verify sweep, liking a row, deleting a row.
   * Nothing needs a floor here either -- showResults() clamps `currentPage` to the last page, so
   * a match set that shrinks lands on the end of the results rather than out of bounds.
   */
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
    // Only a genuine change of mode is a reason to go back to page 1. setSearchBarExpanded()
    // calls this on every init, including the re-inits an SPA navigation triggers, and an
    // unconditional reset there dropped the reader to page 1 while they were reading.
    const changed = next !== resultsOnly;
    resultsOnly = next;
    syncResultsOnlyCheckbox();
    updateResultsOnlyLayout();
    if (changed) currentPage = 0;
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
    return postById.get(id) || null;
  }

  function postHasChildPosts(post) {
    return (post?.childPostCount ?? 0) > 0;
  }

  /**
   * parentId -> its immediate children, over the whole index.
   *
   * Cached against the identity and length of `allPosts`, the same shape of check the display
   * entries use: `removeDescendantsOfRoot()` replaces the array and `addPostRow()` pushes, so
   * between them every structural change moves one or the other.
   */
  function getChildrenByParent() {
    if (childrenByParentSource === allPosts && childrenByParentLength === allPosts.length) {
      return childrenByParent;
    }
    const byParent = new Map();
    for (const p of allPosts) {
      if (!p.isChild || !p.parentId) continue;
      const parentId = String(p.parentId);
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(p);
    }
    childrenByParent = byParent;
    childrenByParentSource = allPosts;
    childrenByParentLength = allPosts.length;
    return byParent;
  }

  function getAllDescendantPosts(rootId) {
    const id = String(rootId || '');
    if (!id) return [];
    // Walked on every lightbox render now, not just on Download all, so the index is not
    // rebuilt from scratch per call.
    const byParent = getChildrenByParent();
    const out = [];
    const seen = new Set([id]);
    const walk = parentId => {
      for (const child of byParent.get(parentId) || []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        walk(child.id);
      }
    };
    walk(id);
    out.sort((a, b) => -byCreatedDesc(a, b));
    return out;
  }

  function getPostDetailUrl(id) {
    return id ? `https://grok.com/imagine/post/${id}` : '';
  }

  function getPostMediaUrl(post) {
    return post?.mediaUrl || post?.thumbnail || '';
  }

  let imagesByConversation = new Map();
  let imagesByConversationSource = null;
  let imagesByConversationLength = -1;

  function getImagesByConversation() {
    if (imagesByConversationSource === allPosts && imagesByConversationLength === allPosts.length) {
      return imagesByConversation;
    }
    const byConv = new Map();
    for (const p of allPosts) {
      if (!p.conversationId || isVideoPost(p)) continue;
      const thumb = isLikelyImageUrl(p.thumbnail) ? p.thumbnail : (isLikelyImageUrl(p.mediaUrl) ? p.mediaUrl : '');
      if (!thumb) continue;
      const convId = String(p.conversationId);
      if (!byConv.has(convId)) byConv.set(convId, thumb);
    }
    imagesByConversation = byConv;
    imagesByConversationSource = allPosts;
    imagesByConversationLength = allPosts.length;
    return byConv;
  }

  /**
   * Resolves an image thumbnail URL for a post/asset.
   *
   * For video posts, `thumbnail` or `mediaUrl` may be an .mp4 file that an <img> element
   * cannot render. In that case, we fall back to:
   * 1. The parent post's image (if post is a variation or animation of a parent)
   * 2. The root post's image (for deeper tree descendants)
   * 3. The first image child of this post (if post is a parent video)
   * 4. Sibling image from the same conversation / generation batch (conversationId)
   * 5. Non-video mediaUrl or original thumbnail
   */
  function getPostThumbnailUrl(post) {
    if (!post) return '';

    // Non-video post with a valid image thumbnail
    if (!isVideoPost(post) && isLikelyImageUrl(post.thumbnail)) {
      return post.thumbnail;
    }

    // Video post with a dedicated image thumbnail
    if (isLikelyImageUrl(post.thumbnail)) {
      return post.thumbnail;
    }

    // 1. Direct parent post image
    if (post.parentId) {
      const parent = postById.get(post.parentId);
      if (parent) {
        if (isLikelyImageUrl(parent.thumbnail)) return parent.thumbnail;
        if (isLikelyImageUrl(parent.mediaUrl)) return parent.mediaUrl;
      }
    }

    // 2. Root post image
    if (post.rootId && post.rootId !== post.parentId) {
      const root = postById.get(post.rootId);
      if (root) {
        if (isLikelyImageUrl(root.thumbnail)) return root.thumbnail;
        if (isLikelyImageUrl(root.mediaUrl)) return root.mediaUrl;
      }
    }

    // 3. Child posts / descendants
    const byParent = getChildrenByParent();
    const children = byParent.get(post.id) || [];
    for (const child of children) {
      if (isLikelyImageUrl(child.thumbnail)) return child.thumbnail;
      if (isLikelyImageUrl(child.mediaUrl)) return child.mediaUrl;
    }

    // 4. Same conversation / batch generation sibling
    if (post.conversationId) {
      const convThumb = getImagesByConversation().get(String(post.conversationId));
      if (convThumb) return convThumb;
    }

    // 5. Fallback
    if (isLikelyImageUrl(post.mediaUrl)) return post.mediaUrl;
    return post.thumbnail || '';
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

  function makeAbortError() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
  }

  function isAbortError(err) {
    return err?.name === 'AbortError';
  }

  function fetchPostMediaBlobGm(url, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(makeAbortError());
        return;
      }
      // The listener has to be detached once the request settles: a bulk run shares one signal
      // across every file, so leaving them attached would pile up thousands of them.
      let onAbort = null;
      const done = fn => (...args) => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        onAbort = null;
        fn(...args);
      };
      const settleOk = done(resolve);
      const settleErr = done(reject);

      const handle = GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 120000,
        onload(res) {
          if (res.status < 200 || res.status >= 300) {
            settleErr(new Error(`HTTP ${res.status}`));
            return;
          }
          const type = String(res.responseHeaders || '').match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim()
            || 'application/octet-stream';
          settleOk(new Blob([res.response], { type }));
        },
        onerror() {
          settleErr(new Error('network error'));
        },
        ontimeout() {
          settleErr(new Error('timeout'));
        },
        onabort() {
          settleErr(makeAbortError());
        },
      });

      // GM_xmlhttpRequest has no signal support, so Cancel has to reach it through the handle
      // the call returns. Older managers return nothing — then the request simply runs out.
      if (signal) {
        onAbort = () => {
          onAbort = null;
          try { handle?.abort?.(); } catch { /* already finished */ }
          reject(makeAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async function fetchPostMediaBlob(post, signal) {
    const url = getPostMediaUrl(post);
    if (!url) throw new Error('no url');
    if (signal?.aborted) throw makeAbortError();
    try {
      const res = await getPageWindow().fetch(url, { credentials: 'include', signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (fetchErr) {
      if (isAbortError(fetchErr) || signal?.aborted) throw fetchErr;
      console.warn('[GrokSearch] fetch failed, using GM_xmlhttpRequest:', fetchErr);
      return fetchPostMediaBlobGm(url, signal);
    }
  }

  // ─── Embedded image metadata ────────────────────────────────────────────────
  // Everything the index knows about a post is written into the downloaded file, so an
  // exported folder stays searchable after it leaves the browser: EXIF for JPEG and WebP,
  // tEXt/iTXt for PNG, plus an XMP packet for WebP. Tagging is best-effort by design — a
  // failure here must never cost the user the file itself.

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
      // `>>> 8` consumes the byte the table lookup just handled. This read `>>> 1` until
      // v1.65.0, which produced a wrong checksum on every text chunk the script wrote —
      // browsers ignore a bad CRC on an ancillary chunk, but strict readers drop it.
      crc = PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
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

  function binaryStringToBytes(binary) {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes;
  }

  function isJpegBytes(u8) {
    return u8.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF;
  }

  function isPngBytes(u8) {
    return u8.length >= 8
      && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47;
  }

  /** RIFF container with a WEBP form type. */
  function isWebpBytes(u8) {
    return u8.length >= 12
      && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46
      && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50;
  }

  function truncateMetadataText(text, maxLen = 2000) {
    const s = String(text || '').trim();
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen - 1)}…`;
  }

  /**
   * EXIF string fields are byte-oriented, so anything above U+00FF would be written as a
   * mangled low byte. Accents are folded to their base letters and the rest is dropped; the
   * untouched text still travels in XPComment (UCS-2) and in the JSON blob.
   */
  function toAsciiText(text) {
    let s = String(text || '');
    try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch { /* older engines */ }
    return s.replace(/[^\x20-\x7e\n\r\t]/g, '').trim();
  }

  /** JSON with every non-ASCII character escaped, so it survives an ASCII-tagged EXIF field. */
  function toAsciiJson(value) {
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    );
  }

  /** EXIF wants "YYYY:MM:DD HH:MM:SS"; the index stores ISO-8601 UTC. */
  function formatExifDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} `
      + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  /** The PNG `Creation Time` keyword takes an RFC 1123 date. */
  function formatPngCreationTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toUTCString();
  }

  /** Null-terminated UTF-16LE bytes, the encoding the Windows XP* EXIF tags use. */
  function ucs2Bytes(text) {
    const s = String(text || '');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out.push(c & 0xff, (c >> 8) & 0xff);
    }
    out.push(0, 0);
    return out;
  }

  function getScriptVersion() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info?.script?.version) return String(GM_info.script.version);
    } catch { /* not running under a manager */ }
    return SCRIPT_VERSION;
  }

  /**
   * Everything the index holds about one post, in the shapes the writers need. `fields` is the
   * full record (empty values dropped) and becomes the JSON blob; the rest are the short strings
   * that map onto named EXIF/PNG tags.
   */
  function buildPostMetadata(post) {
    const p = post || {};
    // A JPEG APP1 segment caps out at 64 KB and the same text is written several times over
    // (description, UCS-2 XPComment, JSON blob), so the per-prompt cap has to leave room.
    const prompt = truncateMetadataText(p.prompt, METADATA_PROMPT_MAX);
    const parentPrompt = truncateMetadataText(p.parentPrompt, METADATA_PROMPT_MAX);
    const rootPrompt = truncateMetadataText(p.rootPrompt, METADATA_PROMPT_MAX);
    const model = String(p.model || '').trim();
    const createTime = String(p.createTime || '').trim();
    const id = String(p.id || '');
    const isChild = Boolean(p.isChild);
    const isVideo = isVideoMediaType(p.mediaType);

    const fields = {
      id,
      prompt,
      parentPrompt: isChild ? parentPrompt : '',
      rootPrompt: isChild ? rootPrompt : '',
      parentId: isChild ? String(p.parentId || '') : '',
      rootId: isChild ? String(p.rootId || p.parentId || '') : '',
      isChild,
      createTime,
      model,
      mediaType: String(p.mediaType || ''),
      isLiked: typeof p.isLiked === 'boolean' ? p.isLiked : null,
      childPostCount: p.childPostCount ?? 0,
      childImageCount: p.childImageCount ?? 0,
      childVideoCount: p.childVideoCount ?? 0,
      videoCount: p.videoCount ?? 0,
      mediaUrl: String(p.mediaUrl || ''),
      postUrl: getPostDetailUrl(id),
      source: 'Grok Imagine',
      generator: 'xAI Grok Imagine',
      taggedBy: `grokSearch.user.js v${getScriptVersion()}`,
      taggedAt: new Date().toISOString(),
    };
    for (const key of Object.keys(fields)) {
      const v = fields[key];
      if (v === '' || v === null || v === undefined) delete fields[key];
    }

    const keywords = [
      'Grok Imagine',
      model,
      isVideo ? 'video' : 'image',
      isChild ? 'variation' : 'original',
      p.isLiked === true ? 'liked' : '',
    ].filter(Boolean).join('; ');

    const title = truncateMetadataText(prompt || parentPrompt || rootPrompt || id, 120);
    const software = model ? `Grok Imagine (${model})` : 'Grok Imagine';

    return {
      id,
      prompt,
      parentPrompt,
      rootPrompt,
      model,
      createTime,
      keywords,
      title,
      software,
      postUrl: fields.postUrl || '',
      exifDate: formatExifDateTime(createTime),
      pngDate: formatPngCreationTime(createTime),
      json: toAsciiJson(fields),
      fields,
    };
  }

  // ─── JPEG / raw EXIF ────────────────────────────────────────────────────────

  function buildExifDicts(meta) {
    const I = piexif.ImageIFD || {};
    const E = piexif.ExifIFD || {};
    const zeroth = {};
    const exif = {};
    // Tag ids differ between piexif builds, so a tag the bundled version does not know is
    // skipped rather than written under `undefined`, which would break the whole dump.
    const put = (dict, tag, value) => {
      if (tag == null || value == null || value === '') return;
      if (Array.isArray(value) && value.length <= 2) return;
      dict[tag] = value;
    };

    put(zeroth, I.ImageDescription, toAsciiText(meta.prompt));
    put(zeroth, I.Software, toAsciiText(meta.software));
    put(zeroth, I.Artist, 'Grok Imagine');
    put(zeroth, I.Make, 'xAI');
    put(zeroth, I.Model, toAsciiText(meta.model));
    put(zeroth, I.DateTime, meta.exifDate);
    put(zeroth, I.XPTitle, ucs2Bytes(meta.title));
    put(zeroth, I.XPComment, ucs2Bytes(meta.prompt));
    put(zeroth, I.XPKeywords, ucs2Bytes(meta.keywords));
    put(zeroth, I.XPSubject, ucs2Bytes(meta.parentPrompt || meta.rootPrompt));
    put(zeroth, I.XPAuthor, ucs2Bytes('Grok Imagine'));

    put(exif, E.DateTimeOriginal, meta.exifDate);
    put(exif, E.DateTimeDigitized, meta.exifDate);
    put(exif, E.ImageUniqueID, meta.id);
    put(exif, E.UserComment, `ASCII\0\0\0${meta.json}`);

    return { '0th': zeroth, Exif: exif, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  }

  /** Minimal fallback used when the full tag set is rejected — the prompt is the part that matters. */
  function buildMinimalExifDicts(meta) {
    const I = piexif.ImageIFD || {};
    const E = piexif.ExifIFD || {};
    const zeroth = {};
    const exif = {};
    if (I.ImageDescription != null && meta.prompt) zeroth[I.ImageDescription] = toAsciiText(meta.prompt);
    if (E.UserComment != null) exif[E.UserComment] = `ASCII\0\0\0${meta.json}`;
    return { '0th': zeroth, Exif: exif, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  }

  /** The APP1 segment as a binary string, or null when EXIF cannot be produced. */
  function dumpExifSegment(meta) {
    if (typeof piexif === 'undefined') return null;
    try {
      return piexif.dump(buildExifDicts(meta));
    } catch (err) {
      console.warn('[GrokSearch] full EXIF dump failed, falling back to prompt only:', err);
    }
    try {
      return piexif.dump(buildMinimalExifDicts(meta));
    } catch (err) {
      console.warn('[GrokSearch] EXIF dump failed:', err);
      return null;
    }
  }

  /**
   * The bare TIFF block, which is what a WebP `EXIF` chunk holds — piexif hands back a JPEG
   * APP1 segment, so the marker, its length, and the "Exif\0\0" identifier come off the front.
   */
  function buildTiffExifBytes(meta) {
    const segment = dumpExifSegment(meta);
    if (!segment) return null;
    let s = segment;
    if (s.charCodeAt(0) === 0xFF && s.charCodeAt(1) === 0xE1) s = s.slice(4);
    if (s.slice(0, 6) === 'Exif\0\0') s = s.slice(6);
    return s.length ? binaryStringToBytes(s) : null;
  }

  function embedMetadataInJpeg(buffer, meta) {
    const segment = dumpExifSegment(meta);
    if (!segment) return buffer;
    try {
      const binary = arrayBufferToBinaryString(buffer);
      return binaryStringToArrayBuffer(piexif.insert(segment, binary));
    } catch (err) {
      console.warn('[GrokSearch] JPEG EXIF embed failed:', err);
      return buffer;
    }
  }

  // ─── PNG text chunks ────────────────────────────────────────────────────────

  function buildPngChunk(type, data) {
    const enc = new TextEncoder();
    const typeBytes = enc.encode(type);
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length, false);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, pngCrc32(chunk.subarray(4, 8 + data.length)), false);
    return chunk;
  }

  /** Latin-1 `tEXt`. Only valid when every character fits in a byte. */
  function buildPngTextChunk(keyword, text) {
    const keyBytes = [];
    for (const ch of String(keyword)) keyBytes.push(ch.charCodeAt(0) & 0xff);
    const textBytes = [];
    for (let i = 0; i < text.length; i++) textBytes.push(text.charCodeAt(i) & 0xff);
    const data = new Uint8Array(keyBytes.length + 1 + textBytes.length);
    data.set(keyBytes, 0);
    data[keyBytes.length] = 0;
    data.set(textBytes, keyBytes.length + 1);
    return buildPngChunk('tEXt', data);
  }

  /** UTF-8 `iTXt`, uncompressed, no language tag — for text `tEXt` cannot represent. */
  function buildPngITxtChunk(keyword, text) {
    const enc = new TextEncoder();
    const keyBytes = enc.encode(keyword);
    const textBytes = enc.encode(text);
    const data = new Uint8Array(keyBytes.length + 1 + 2 + 1 + 1 + textBytes.length);
    let off = 0;
    data.set(keyBytes, off); off += keyBytes.length;
    data[off++] = 0;   // keyword terminator
    data[off++] = 0;   // compression flag: uncompressed
    data[off++] = 0;   // compression method
    data[off++] = 0;   // empty language tag
    data[off++] = 0;   // empty translated keyword
    data.set(textBytes, off);
    return buildPngChunk('iTXt', data);
  }

  /** tEXt carries Latin-1 plus line breaks; anything else has to go in an iTXt chunk. */
  function isLatin1Text(text) {
    return /^[\x20-\x7e\xa0-\xff\n]*$/.test(text);
  }

  function pngMetadataChunks(meta) {
    const entries = [
      ['Title', meta.title],
      ['Description', meta.prompt],
      ['Author', 'Grok Imagine'],
      ['Software', meta.software],
      ['Source', meta.postUrl],
      ['Creation Time', meta.pngDate],
      ['prompt', meta.prompt],
      ['parameters', meta.model ? `${meta.prompt}\nModel: ${meta.model}` : meta.prompt],
      ['Comment', meta.json],
    ];
    const chunks = [];
    for (const [keyword, raw] of entries) {
      const text = String(raw || '');
      if (!text) continue;
      chunks.push(isLatin1Text(text)
        ? buildPngTextChunk(keyword, text)
        : buildPngITxtChunk(keyword, text));
    }
    return chunks;
  }

  /** Byte offset just past IHDR, where ancillary chunks may be inserted. */
  function pngHeaderEnd(u8) {
    if (u8.length < 16) return -1;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const length = view.getUint32(8, false);
    const type = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (type !== 'IHDR') return -1;
    const end = 8 + 8 + length + 4;
    return end <= u8.length ? end : -1;
  }

  function embedMetadataInPng(buffer, meta) {
    const u8 = new Uint8Array(buffer);
    const insertAt = pngHeaderEnd(u8);
    if (insertAt < 0) return buffer;
    try {
      const chunks = pngMetadataChunks(meta);
      if (!chunks.length) return buffer;
      const extra = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(u8.length + extra);
      out.set(u8.subarray(0, insertAt), 0);
      let off = insertAt;
      for (const chunk of chunks) { out.set(chunk, off); off += chunk.length; }
      out.set(u8.subarray(insertAt), off);
      return out.buffer;
    } catch (err) {
      console.warn('[GrokSearch] PNG metadata embed failed:', err);
      return buffer;
    }
  }

  // ─── WebP (RIFF) ────────────────────────────────────────────────────────────
  // A plain WebP is RIFF/WEBP + one VP8 or VP8L chunk and has nowhere to put metadata. The
  // extended format adds a leading VP8X chunk whose flag byte advertises the optional chunks,
  // so tagging one means synthesizing that header — which needs the canvas size read out of
  // the bitstream — and appending EXIF and XMP after the image data.

  const WEBP_FLAG_ALPHA = 0x10;
  const WEBP_FLAG_EXIF = 0x08;
  const WEBP_FLAG_XMP = 0x04;

  function readRiffChunks(u8) {
    const chunks = [];
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 12;
    while (off + 8 <= u8.length) {
      const fourcc = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
      const size = view.getUint32(off + 4, true);
      const start = off + 8;
      if (size > u8.length - start) break;   // truncated file: keep what parsed cleanly
      chunks.push({ fourcc, data: u8.subarray(start, start + size) });
      off = start + size + (size % 2);       // chunks are padded to an even length
    }
    return chunks;
  }

  function buildRiffChunk(fourcc, data) {
    const pad = data.length % 2;
    const out = new Uint8Array(8 + data.length + pad);
    for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i) & 0xff;
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  }

  /** Canvas size from VP8X, or from the VP8 / VP8L bitstream header of a simple file. */
  function readWebpCanvasSize(chunks) {
    for (const c of chunks) {
      const d = c.data;
      if (c.fourcc === 'VP8X' && d.length >= 10) {
        return {
          width: (d[4] | (d[5] << 8) | (d[6] << 16)) + 1,
          height: (d[7] | (d[8] << 8) | (d[9] << 16)) + 1,
        };
      }
      if (c.fourcc === 'VP8 ' && d.length >= 10 && d[3] === 0x9D && d[4] === 0x01 && d[5] === 0x2A) {
        return {
          width: (d[6] | (d[7] << 8)) & 0x3fff,
          height: (d[8] | (d[9] << 8)) & 0x3fff,
        };
      }
      if (c.fourcc === 'VP8L' && d.length >= 5 && d[0] === 0x2F) {
        const bits = (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0;
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
        };
      }
    }
    return null;
  }

  function webpHasAlpha(chunks) {
    for (const c of chunks) {
      if (c.fourcc === 'ALPH') return true;
      if (c.fourcc === 'VP8L' && c.data.length >= 5 && c.data[0] === 0x2F) {
        const bits = (c.data[1] | (c.data[2] << 8) | (c.data[3] << 16) | (c.data[4] << 24)) >>> 0;
        if ((bits >>> 28) & 1) return true;
      }
    }
    return false;
  }

  function buildXmpPacket(meta) {
    const esc = s => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    const keywords = meta.keywords
      ? meta.keywords.split(';').map(k => k.trim()).filter(Boolean)
      : [];
    const bag = keywords.map(k => `<rdf:li>${esc(k)}</rdf:li>`).join('');
    const created = meta.createTime ? `\n      <xmp:CreateDate>${esc(meta.createTime)}</xmp:CreateDate>` : '';
    const identifier = meta.id ? `\n      <dc:identifier>${esc(meta.id)}</dc:identifier>` : '';
    const source = meta.postUrl ? `\n      <dc:source>${esc(meta.postUrl)}</dc:source>` : '';
    return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.title)}</rdf:li></rdf:Alt></dc:title>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(meta.prompt)}</rdf:li></rdf:Alt></dc:description>
      <dc:creator><rdf:Seq><rdf:li>Grok Imagine</rdf:li></rdf:Seq></dc:creator>
      <dc:subject><rdf:Bag>${bag}</rdf:Bag></dc:subject>${identifier}${source}${created}
      <xmp:CreatorTool>${esc(meta.software)}</xmp:CreatorTool>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  }

  function embedMetadataInWebp(buffer, meta) {
    const u8 = new Uint8Array(buffer);
    if (!isWebpBytes(u8)) return buffer;
    try {
      const chunks = readRiffChunks(u8);
      if (!chunks.length) return buffer;
      const size = readWebpCanvasSize(chunks);
      if (!size || !size.width || !size.height) return buffer;

      const exifBytes = buildTiffExifBytes(meta);
      const xmpBytes = new TextEncoder().encode(buildXmpPacket(meta));
      if (!exifBytes && !xmpBytes.length) return buffer;

      // Replacing rather than appending: a second EXIF chunk is invalid, and re-tagging a file
      // that already carries our metadata has to be idempotent.
      const kept = chunks.filter(c => c.fourcc !== 'EXIF' && c.fourcc !== 'XMP ' && c.fourcc !== 'VP8X');
      const existingVp8x = chunks.find(c => c.fourcc === 'VP8X');

      let flags = existingVp8x && existingVp8x.data.length >= 1 ? existingVp8x.data[0] : 0;
      if (!existingVp8x && webpHasAlpha(kept)) flags |= WEBP_FLAG_ALPHA;
      if (exifBytes) flags |= WEBP_FLAG_EXIF;
      if (xmpBytes.length) flags |= WEBP_FLAG_XMP;

      const vp8x = new Uint8Array(10);
      vp8x[0] = flags;
      const w = size.width - 1;
      const h = size.height - 1;
      vp8x[4] = w & 0xff; vp8x[5] = (w >> 8) & 0xff; vp8x[6] = (w >> 16) & 0xff;
      vp8x[7] = h & 0xff; vp8x[8] = (h >> 8) & 0xff; vp8x[9] = (h >> 16) & 0xff;

      // Chunk order is fixed by the container spec: VP8X first, image data in its original
      // order, then the metadata chunks.
      const body = [buildRiffChunk('VP8X', vp8x)];
      for (const c of kept) body.push(buildRiffChunk(c.fourcc, c.data));
      if (exifBytes) body.push(buildRiffChunk('EXIF', exifBytes));
      if (xmpBytes.length) body.push(buildRiffChunk('XMP ', xmpBytes));

      const riffSize = 4 + body.reduce((n, b) => n + b.length, 0);
      const out = new Uint8Array(8 + riffSize);
      out.set([0x52, 0x49, 0x46, 0x46], 0);                       // 'RIFF'
      new DataView(out.buffer).setUint32(4, riffSize, true);
      out.set([0x57, 0x45, 0x42, 0x50], 8);                       // 'WEBP'
      let off = 12;
      for (const b of body) { out.set(b, off); off += b.length; }
      return out.buffer;
    } catch (err) {
      console.warn('[GrokSearch] WebP metadata embed failed:', err);
      return buffer;
    }
  }

  // ─── Dispatch ───────────────────────────────────────────────────────────────

  async function embedMetadataInImageBlob(blob, post) {
    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const meta = buildPostMetadata(post);
    let out = buf;
    if (isJpegBytes(u8)) out = embedMetadataInJpeg(buf, meta);
    else if (isPngBytes(u8)) out = embedMetadataInPng(buf, meta);
    else if (isWebpBytes(u8)) out = embedMetadataInWebp(buf, meta);
    if (out === buf) return blob;
    return new Blob([out], { type: blob.type || 'application/octet-stream' });
  }

  function isDownloadableImagePost(post) {
    if (isVideoMediaType(post.mediaType)) return false;
    const url = getPostMediaUrl(post);
    return !/\.mp4(\?|$)/i.test(url);
  }

  async function prepareDownloadBlob(post, signal) {
    const blob = await fetchPostMediaBlob(post, signal);
    if (!isDownloadableImagePost(post)) return blob;
    try {
      return await embedMetadataInImageBlob(blob, post);
    } catch (err) {
      console.warn('[GrokSearch] metadata embed failed:', err);
      return blob;
    }
  }

  /**
   * A bulk run is long enough that a single flaky response would otherwise cost a file for good,
   * so each one gets a few attempts with backoff. Aborts are not retried — Cancel means stop.
   */
  async function prepareDownloadBlobWithRetry(post, signal) {
    let lastErr = null;
    for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw makeAbortError();
      try {
        return await prepareDownloadBlob(post, signal);
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw err;
        lastErr = err;
        if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
          await sleep(DOWNLOAD_RETRY_BASE_MS * (2 ** (attempt - 1)));
        }
      }
    }
    throw lastErr || new Error('download failed');
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

  /**
   * Drops only ids that left the index entirely. Pruning against the *match set* used to
   * clear the selection as soon as the user typed another character.
   */
  function pruneSelection() {
    for (const id of selectedPostIds) {
      if (!postById.has(id)) selectedPostIds.delete(id);
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

  /** Every selected row, in the current sort order — selections survive a filter change. */
  function getSelectedPostsInOrder() {
    const posts = [];
    for (const id of selectedPostIds) {
      const post = postById.get(id);
      if (post) posts.push(post);
    }
    posts.sort(byCreatedDesc);
    return currentSort === 'oldest' ? posts.reverse() : posts;
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

  let bulkDownloadConfirmResolver = null;

  function closeBulkDownloadConfirm(result) {
    const dlg = document.getElementById('grok-bulk-download-confirm');
    if (dlg) dlg.hidden = true;
    if (bulkDownloadConfirmResolver) {
      const resolve = bulkDownloadConfirmResolver;
      bulkDownloadConfirmResolver = null;
      resolve(result);
    }
  }

  function ensureBulkDownloadConfirmDialog() {
    if (document.getElementById('grok-bulk-download-confirm')) return;
    const root = document.createElement('div');
    root.id = 'grok-bulk-download-confirm';
    root.className = 'grok-bulk-download-confirm';
    root.hidden = true;
    root.innerHTML = `
      <div class="grok-bulk-download-confirm-backdrop" data-grok-bulk-confirm-cancel></div>
      <div class="grok-bulk-download-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="grok-bulk-download-confirm-title">
        <div class="grok-bulk-download-confirm-title" id="grok-bulk-download-confirm-title">Download selected images</div>
        <p class="grok-bulk-download-confirm-message" id="grok-bulk-download-confirm-message"></p>
        <div class="grok-bulk-download-confirm-actions">
          <button type="button" class="grok-toolbar-btn grok-bulk-download-confirm-cancel">Cancel</button>
          <button type="button" class="grok-toolbar-btn grok-bulk-download-confirm-ok">Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('[data-grok-bulk-confirm-cancel]')?.addEventListener('click', () => {
      closeBulkDownloadConfirm(false);
    });
    root.querySelector('.grok-bulk-download-confirm-cancel')?.addEventListener('click', () => {
      closeBulkDownloadConfirm(false);
    });
    root.querySelector('.grok-bulk-download-confirm-ok')?.addEventListener('click', () => {
      closeBulkDownloadConfirm(true);
    });
    document.addEventListener('keydown', e => {
      const dlg = document.getElementById('grok-bulk-download-confirm');
      if (!dlg || dlg.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeBulkDownloadConfirm(false);
      }
    });
  }

  function confirmBulkDownload(count) {
    ensureBulkDownloadConfirmDialog();
    return new Promise(resolve => {
      bulkDownloadConfirmResolver = resolve;
      const dlg = document.getElementById('grok-bulk-download-confirm');
      const msg = document.getElementById('grok-bulk-download-confirm-message');
      const titleEl = document.getElementById('grok-bulk-download-confirm-title');
      const okBtn = dlg?.querySelector('.grok-bulk-download-confirm-ok');
      // The dialog is shared with the delete confirm, so its wording and styling are reset.
      if (titleEl) titleEl.textContent = 'Download selected images';
      if (okBtn) { okBtn.textContent = 'Continue'; okBtn.classList.remove('grok-confirm-danger'); }
      const noun = count === 1 ? 'image' : 'images';
      if (msg) {
        msg.textContent = `This will take some time. You selected ${count} ${noun}. `
          + 'You can cancel while it runs and retry whatever is left.';
      }
      if (dlg) {
        dlg.hidden = false;
        dlg.querySelector('.grok-bulk-download-confirm-ok')?.focus();
      }
    });
  }

  /** Stops the run between files, and aborts the request already in flight. */
  function cancelBulkDownload() {
    if (!bulkDownloadInProgress) return;
    bulkDownloadCancelled = true;
    setDownloadStatus('cancelling…', true);
    try { bulkDownloadAbort?.abort(); } catch { /* already settled */ }
    syncDownloadSelectedButtons();
  }

  function clearFailedDownloads() {
    lastFailedDownloads = [];
    lastDownloadDirHandle = null;
    syncDownloadSelectedButtons();
  }

  /**
   * `dirHandle` is passed on retry so the user is not asked for the folder a second time. The
   * handle stays valid for the lifetime of the page, and the permission is re-checked anyway.
   */
  /**
   * Same dialog shell as the bulk-download confirm, worded for an irreversible action. Returns
   * false unless the user actively confirms -- Escape, the backdrop and Cancel all mean no.
   */
  function confirmDangerousAction({ title, message, okLabel }) {
    ensureBulkDownloadConfirmDialog();
    return new Promise(resolve => {
      bulkDownloadConfirmResolver = resolve;
      const dlg = document.getElementById('grok-bulk-download-confirm');
      const titleEl = document.getElementById('grok-bulk-download-confirm-title');
      const msgEl = document.getElementById('grok-bulk-download-confirm-message');
      const okBtn = dlg?.querySelector('.grok-bulk-download-confirm-ok');
      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.textContent = message;
      if (okBtn) {
        okBtn.textContent = okLabel || 'Continue';
        okBtn.classList.add('grok-confirm-danger');
      }
      if (dlg) {
        dlg.hidden = false;
        // Focus Cancel, not the destructive button, so a stray Enter cannot confirm.
        dlg.querySelector('.grok-bulk-download-confirm-cancel')?.focus();
      }
    });
  }

  async function downloadPostsToFolder(posts, { dirHandle: existingHandle = null } = {}) {
    if (bulkDownloadInProgress) return;
    if (posts.length === 0) return;
    if (!existingHandle && posts.length > BULK_DOWNLOAD_CONFIRM_ABOVE) {
      const confirmed = await confirmBulkDownload(posts.length);
      if (!confirmed) return;
    }
    let dirHandle = existingHandle;
    try {
      if (!dirHandle) dirHandle = await pickDownloadFolder();
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
    bulkDownloadCancelled = false;
    bulkDownloadAbort = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = bulkDownloadAbort?.signal;
    lastFailedDownloads = [];
    lastDownloadDirHandle = null;
    syncDownloadSelectedButtons();

    let ok = 0;
    const failed = [];
    const total = posts.length;
    try {
      setDownloadStatus(`downloading 0/${total}…`, true);
      for (let i = 0; i < posts.length; i++) {
        if (bulkDownloadCancelled) break;
        const post = posts[i];
        const filename = getPostDownloadFilename(post);
        if (!filename) {
          failed.push(post);
          continue;
        }
        setDownloadStatus(`downloading ${i + 1}/${total}…`, true);
        try {
          const blob = await prepareDownloadBlobWithRetry(post, signal);
          await saveBlobToFolder(dirHandle, filename, blob);
          ok++;
        } catch (err) {
          if (isAbortError(err) || bulkDownloadCancelled) {
            // Cancelled mid-file: it did not fail, it never got its turn.
            break;
          }
          console.error('[GrokSearch] save failed:', post.id, err);
          failed.push(post);
        }
      }
      // Everything still queued when Cancel landed counts as unfinished — including the file
      // whose request was aborted — so Retry picks up exactly where the run stopped.
      if (bulkDownloadCancelled) {
        for (let i = ok + failed.length; i < posts.length; i++) failed.push(posts[i]);
      }
      lastFailedDownloads = failed;
      lastDownloadDirHandle = failed.length ? dirHandle : null;
      const savedText = `saved ${ok} file${ok === 1 ? '' : 's'}`;
      if (bulkDownloadCancelled) {
        setDownloadStatus(`cancelled — ${savedText}, ${failed.length} left`);
      } else {
        setDownloadStatus(failed.length === 0 ? savedText : `saved ${ok}, failed ${failed.length}`);
      }
    } catch (err) {
      console.error('[GrokSearch] bulk download failed:', err);
      setDownloadStatus('download failed');
    } finally {
      bulkDownloadInProgress = false;
      bulkDownloadCancelled = false;
      bulkDownloadAbort = null;
      syncDownloadSelectedButtons();
    }
  }

  async function retryFailedDownloads() {
    const posts = lastFailedDownloads.slice();
    const dirHandle = lastDownloadDirHandle;
    if (posts.length === 0) return;
    await downloadPostsToFolder(posts, { dirHandle });
  }

  // ─── Delete ─────────────────────────────────────────────────────────────────
  /**
   * Deleting is permanent and happens on Grok's side, so every path into it goes through a
   * confirmation naming the exact count, and nothing is removed from the index until the server
   * has actually accepted the delete. A failure leaves the row alone rather than hiding media
   * that still exists.
   */
  async function deleteRemotePost(id) {
    const res = await postJsonWithRetry(POST_DELETE, { id }, 'delete');
    // A post that is already gone is not a failure; the goal state is reached either way.
    return res.ok || res.status === 404;
  }

  let deleteInProgress = false;

  async function deletePosts(posts, { confirmLabel = 'delete' } = {}) {
    if (deleteInProgress) return { deleted: 0, failed: 0 };
    const targets = posts.filter(p => p?.id);
    if (!targets.length) {
      setDownloadStatus('nothing selected');
      return { deleted: 0, failed: 0 };
    }
    const noun = targets.length === 1 ? 'item' : 'items';
    const ok = await confirmDangerousAction({
      title: `Delete ${targets.length} ${noun}`,
      message: `This permanently deletes ${targets.length} ${noun} from your Grok library. `
        + 'It cannot be undone, and downloading them first is the only way to keep a copy.',
      okLabel: `Delete ${targets.length} ${noun}`,
    });
    if (!ok) return { deleted: 0, failed: 0 };

    deleteInProgress = true;
    syncDownloadSelectedButtons();
    const writer = createIndexWriter();
    const goneIds = [];
    let failed = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        setDownloadStatus(`deleting ${i + 1}/${targets.length}…`, true);
        if (await deleteRemotePost(targets[i].id)) goneIds.push(targets[i].id);
        else failed++;
      }
      if (goneIds.length) {
        removeRowsById(goneIds, writer);
        await writer.flush();
        applyFilter();
      }
      setDownloadStatus(failed === 0
        ? `deleted ${goneIds.length}`
        : `deleted ${goneIds.length}, failed ${failed}`);
    } catch (err) {
      console.error('[GrokSearch] delete failed:', err);
      setDownloadStatus('delete failed');
    } finally {
      deleteInProgress = false;
      syncDownloadSelectedButtons();
    }
    console.log(`[GrokSearch] Deleted ${goneIds.length} of ${targets.length} (${confirmLabel})`);
    return { deleted: goneIds.length, failed };
  }

  async function deleteSelectedPosts() {
    return deletePosts(getSelectedPostsInOrder(), { confirmLabel: 'selection' });
  }

  async function deleteSinglePost(post) {
    return deletePosts([post], { confirmLabel: 'single' });
  }

  async function downloadSelectedPosts() {
    const posts = getSelectedPostsInOrder();
    if (posts.length === 0) {
      setDownloadStatus('no selection');
      return;
    }
    await downloadPostsToFolder(posts);
  }

  async function downloadAllChildPosts(post) {
    const posts = getAllDescendantPosts(post.id);
    if (posts.length === 0) {
      flashStampStatus('no child posts');
      return;
    }
    await downloadPostsToFolder(posts);
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
    const downloadLabel = isVideoPost(post) ? 'Download video' : 'Download image';
    const items = [
      { action: 'open', label: 'Open' },
      { action: 'open-tab', label: 'Open on new tab' },
      { action: 'copy-prompt', label: 'Copy prompt' },
      { action: 'copy-url', label: 'Copy URL' },
      { action: 'download', label: downloadLabel },
      { action: 'download-all', label: 'Download all', disabled: !postHasChildPosts(post) },
      {
        action: 'toggle-like',
        label: post.isLiked === true ? 'Unlike' : 'Like',
        disabled: !hasLikeSupport(),
      },
      { action: 'delete', label: 'Delete\u2026' },
    ];
    const dateKey = formatPostDateKey(post.createTime);
    if (dateKey) {
      items.push({ action: 'filter-date', label: 'Filter to post\'s date' });
    }
    if (isChildPost(post) && post.parentId) {
      items.push({ action: 'open-parent', label: 'Open parent post' });
      // Only a grandchild has somewhere else to go — for a direct child the root *is* the parent.
      if (getRootIdOf(post) !== post.parentId) {
        items.push({ action: 'open-root', label: 'Open original post' });
      }
    }
    return items;
  }

  function showResultContextMenu(clientX, clientY, post) {
    const menu = ensureResultContextMenu();
    contextMenuPostId = post.id;
    menu.innerHTML = buildContextMenuItems(post).map(item => `
      <button type="button" class="grok-result-context-item${item.disabled ? ' grok-result-context-item--disabled' : ''}" role="menuitem" data-action="${escapeHtml(item.action)}"${item.disabled ? ' disabled' : ''}>
        ${escapeHtml(item.label)}
      </button>
    `).join('');
    menu.querySelectorAll('.grok-result-context-item').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
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
      case 'download-all':
        await downloadAllChildPosts(post);
        break;
      case 'toggle-like':
        await togglePostLiked(post);
        break;
      case 'delete':
        await deleteSinglePost(post);
        break;
      case 'filter-date': {
        const dateKey = formatPostDateKey(post.createTime);
        if (dateKey) applyDateFilterForDay(dateKey);
        break;
      }
      case 'open-parent':
        if (post.parentId) window.open(getPostDetailUrl(post.parentId), '_blank');
        break;
      case 'open-root': {
        const rootId = getRootIdOf(post);
        if (rootId) window.open(getPostDetailUrl(rootId), '_blank');
        break;
      }
      default:
        break;
    }
  }

  function bindLightboxDownloadButton() {
    const btn = document.getElementById('grok-lightbox-download');
    if (!btn || btn.dataset.grokLightboxBound) return;
    btn.dataset.grokLightboxBound = '1';
    btn.addEventListener('click', e => {
      e.preventDefault();
      const post = matchedPosts[lightboxIndex];
      if (post) downloadPostMedia(post);
    });
  }

  function ensureLightboxDownloadButton(lb) {
    const actions = lb?.querySelector('.grok-lightbox-actions');
    if (!actions || document.getElementById('grok-lightbox-download')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grok-toolbar-btn';
    btn.id = 'grok-lightbox-download';
    btn.textContent = 'Download';
    btn.title = 'Download current image or video';
    actions.appendChild(btn);
    bindLightboxDownloadButton();
  }

  /**
   * Every lightbox control, each responsible only for itself.
   *
   * These used to be chained off ensureLightboxDownloadButton(), which returns early when its own
   * button is already there -- and Download is in the lightbox template, so it always was. Like
   * and Delete were therefore never injected at all. An `ensure*` that guards on one element must
   * never be the thing that creates another.
   */
  function ensureLightboxButtons(lb) {
    ensureLightboxDownloadButton(lb);
    ensureLightboxLikeButton(lb);
    ensureLightboxDeleteButton(lb);
    ensureLightboxChildRow(lb);
  }

  /**
   * The row of links to a parent's children, under the prompt.
   *
   * Each is a real <a> to the post page, so ctrl-click and middle-click do what the browser
   * always does with a link. A plain left click is intercepted only when the child is somewhere
   * in the current result set — then it moves the lightbox instead of leaving the page.
   */
  function ensureLightboxChildRow(lb) {
    const meta = lb?.querySelector('.grok-lightbox-meta');
    if (!meta || document.getElementById('grok-lightbox-kids')) return;
    const row = document.createElement('div');
    row.id = 'grok-lightbox-kids';
    row.className = 'grok-lightbox-kids';
    row.hidden = true;
    meta.appendChild(row);
    row.addEventListener('click', e => {
      const link = e.target.closest('.grok-lightbox-kid');
      if (!link) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const idx = matchedPosts.findIndex(p => p.id === link.dataset.id);
      if (idx < 0) return;                     // filtered out — let the link open the post page
      e.preventDefault();
      lightboxIndex = idx;
      renderResultLightbox();
    });
  }

  function renderLightboxChildRow(post) {
    const row = document.getElementById('grok-lightbox-kids');
    if (!row) return;
    const kids = post ? getAllDescendantPosts(post.id) : [];
    if (!kids.length) {
      if (row.dataset.sig !== '') {
        row.dataset.sig = '';
        row.innerHTML = '';
      }
      row.hidden = true;
      return;
    }
    const shown = kids.slice(0, LIGHTBOX_CHILD_LIMIT);
    const rest = kids.length - shown.length;
    const label = `<span class="grok-lightbox-kids-label">${kids.length} child result${kids.length !== 1 ? 's' : ''}</span>`;
    const links = shown.map(c => `
      <a class="grok-lightbox-kid" href="${escapeHtml(getPostDetailUrl(c.id))}" data-id="${escapeHtml(c.id)}"
         target="_blank" rel="noopener" title="${escapeHtml(c.prompt || '')}">
        <img loading="lazy" src="${escapeHtml(getPostThumbnailUrl(c))}" alt="" />
      </a>`).join('');
    const more = rest > 0
      ? `<span class="grok-lightbox-kid-more" title="${rest} more not shown">+${rest}</span>`
      : '';
    const html = label + links + more;
    if (row.dataset.sig !== html) {
      row.dataset.sig = html;
      row.innerHTML = html;
    }
    row.hidden = false;
  }

  function ensureLightboxDeleteButton(lb) {
    const actions = lb?.querySelector('.grok-lightbox-actions');
    if (!actions || document.getElementById('grok-lightbox-delete')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grok-toolbar-btn grok-lightbox-delete-btn';
    btn.id = 'grok-lightbox-delete';
    btn.textContent = 'Delete';
    btn.title = 'Permanently delete this item from your Grok library';
    actions.appendChild(btn);
    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const post = matchedPosts[lightboxIndex];
      if (!post) return;
      btn.disabled = true;
      const res = await deleteSinglePost(post);
      btn.disabled = false;
      // The row is gone from matchedPosts, so staying open would show the next item under the
      // old index. Closing is the honest outcome.
      if (res.deleted > 0) closeResultLightbox();
    });
  }

  function ensureLightboxLikeButton(lb) {
    const actions = lb?.querySelector('.grok-lightbox-actions');
    if (!actions || document.getElementById('grok-lightbox-like')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grok-toolbar-btn grok-lightbox-like-btn';
    btn.id = 'grok-lightbox-like';
    btn.textContent = 'Like';
    actions.insertBefore(btn, actions.firstChild);
    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const post = matchedPosts[lightboxIndex];
      if (!post) return;
      btn.disabled = true;
      await togglePostLiked(post);
      btn.disabled = false;
      syncLightboxLikeButton();
    });
  }

  function syncLightboxLikeButton() {
    const btn = document.getElementById('grok-lightbox-like');
    if (!btn) return;
    const post = matchedPosts[lightboxIndex];
    if (!post) { btn.hidden = true; return; }
    const liked = post.isLiked === true;
    btn.hidden = false;
    btn.disabled = !hasLikeSupport();
    btn.classList.toggle('is-liked', liked);
    btn.textContent = liked ? '♥ Liked' : '♡ Like';
    btn.title = hasLikeSupport()
      ? (liked ? 'Unlike this post' : 'Like this post')
      : 'Liking is not set up yet — run tools/capture-like.js once';
  }

  function ensureResultLightbox() {
    let lb = document.getElementById('grok-result-lightbox');
    if (lb) {
      ensureLightboxButtons(lb);
      return lb;
    }
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
            <button type="button" class="grok-toolbar-btn" id="grok-lightbox-download" title="Download current image or video">Download</button>
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
    bindLightboxDownloadButton();

    // The template carries Download only, so the injected controls are added here too --
    // the 'already exists' path above is not the only way into this function.
    ensureLightboxButtons(lb);
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
      : `<img class="grok-lightbox-media" src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(imageAltText(post.prompt))}" />`;

    promptEl.textContent = post.prompt || '(no prompt)';
    const bits = [];
    bits.push(`${lightboxIndex + 1} / ${matchedPosts.length.toLocaleString()}`);
    const dateStr = formatPostDate(post.createTime);
    if (dateStr) bits.push(dateStr);
    if (post.model) bits.push(post.model);
    if (isChildPost(post)) bits.push('Child post');
    subEl.textContent = bits.join(' · ');

    renderLightboxChildRow(post);
    syncLightboxLikeButton();
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

  function isResultLightboxOpen() {
    return lightboxIndex >= 0 && !document.getElementById('grok-result-lightbox')?.hidden;
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
      if (isResultLightboxOpen()) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeResultLightbox();
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          stepResultLightbox(e.key === 'ArrowRight' ? 1 : -1);
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
      const kid = e.target.closest('.grok-result-kid');
      const post = getPostById(kid ? kid.dataset.id : card.dataset.id);
      if (!post) return;
      showResultContextMenu(e.clientX, e.clientY, post);
    });

    container.addEventListener('change', e => {
      const input = e.target.closest('.grok-result-select-input');
      if (!input || !container.contains(input)) return;
      const id = input.dataset.id;
      if (!id) return;
      const card = input.closest('.grok-result-card');
      const ids = String(card?.dataset.group || id).split(' ').filter(Boolean);
      if (input.checked) ids.forEach(x => selectedPostIds.add(x));
      else ids.forEach(x => selectedPostIds.delete(x));
      if (card) card.classList.toggle('grok-result-card--selected', input.checked);
      syncDownloadSelectedButtons();
    });

    container.addEventListener('click', e => {
      if (e.target.closest('.grok-result-select')) {
        e.stopPropagation();
        return;
      }
      const kid = e.target.closest('.grok-result-kid');
      if (kid) {
        e.preventDefault();
        e.stopPropagation();
        const kidPost = getPostById(kid.dataset.id);
        if (kidPost) openResultLightbox(kidPost);
        return;
      }
      const likeBtn = e.target.closest('.grok-result-like');
      if (likeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const post = getPostById(likeBtn.closest('.grok-result-card')?.dataset.id);
        if (post) togglePostLiked(post);
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
    const totalPages = Math.max(1, Math.ceil(getDisplayCount() / size));
    currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
    const page = getDisplayPage(currentPage * size, size);

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

    renderResultCards(container, page);

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
    syncModelFilterOptions();

    const queryLower = (currentQuery || '').toLowerCase().trim();
    const terms = queryLower ? queryLower.split(/\s+/).filter(Boolean) : [];
    const parentPromptById = terms.length > 0 ? buildPromptById() : null;
    // Hoisted: these were recomputed per post, which meant two Date objects per row per pass.
    const dateBounds = hasDateFilter() ? getDateFilterBounds() : null;

    matchedPosts = allPosts.filter(post => {
      if (filterHideChilds && isChildPost(post)) return false;
      if (filterOnlyChildren && isChildPost(post)) return false;
      if (terms.length > 0) {
        const p = getSearchablePromptText(post, parentPromptById);
        if (!terms.every(t => p.includes(t))) return false;
      }
      if (dateBounds && !matchesDateBounds(post, dateBounds)) return false;
      if (!matchesModelFilter(post)) return false;
      if (!matchesLikedFilter(post)) return false;
      if (!matchesVideoFilters(post)) return false;
      if (filterOnlyChildren && (post.childPostCount ?? 0) < filterMinChildren) return false;
      return true;
    });

    matchedPosts.sort(currentSort === 'oldest'
      ? (a, b) => -byCreatedDesc(a, b)
      : byCreatedDesc);
    invalidateDisplayEntries();

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
    if (hasText || hasDates || filterVideoOnly || filterWithVideo || filterOnlyChildren || filterHideChilds) {
      countText = `${n} match${matchedPosts.length !== 1 ? 'es' : ''}`;
    } else {
      countText = `${n} saved`;
    }
    const groups = getDisplayCount();
    if (compactGroups && groups !== matchedPosts.length) {
      countText += ` in ${groups.toLocaleString()} group${groups !== 1 ? 's' : ''}`;
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

  function renderResultBadgesInner(post) {
    if (isChildPost(post)) {
      const videos = post.videoCount ?? 0;
      if (videos > 0) {
        return `
          <span class="grok-badge grok-badge-video" title="Video">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          </span>`;
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
    return parts.join('');
  }

  const HEART_SVG = `
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d="M12 21s-7.5-4.7-9.4-9A5.3 5.3 0 0 1 12 6.3 5.3 5.3 0 0 1 21.4 12c-1.9 4.3-9.4 9-9.4 9z"/>
    </svg>`;

  const CHILD_MARK_SVG = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
      <path d="M6 3v12"/><circle cx="6" cy="18" r="2"/><path d="M18 7v14"/><circle cx="18" cy="5" r="2"/>
    </svg>`;

  /**
   * The folded children of a compact card. Each thumbnail is its own button so a click can open
   * that child rather than its parent; the +N chip is inert, so clicking it falls through to the
   * card and opens the parent, whose lightbox lists every child.
   */
  function renderChildStripInner(children) {
    if (!children.length) return '';
    const shown = children.slice(0, COMPACT_CHILD_LIMIT);
    const rest = children.length - shown.length;
    const thumbs = shown.map(c => `
      <button type="button" class="grok-result-kid" data-id="${escapeHtml(c.id)}"
              title="${escapeHtml(c.prompt || '')}" aria-label="Open child result">
        <img loading="lazy" src="${escapeHtml(getPostThumbnailUrl(c))}" alt="" />
      </button>`).join('');
    const more = rest > 0
      ? `<span class="grok-result-kid-more" title="${rest} more — open the parent to see them all">+${rest}</span>`
      : '';
    return thumbs + more;
  }

  /**
   * A prompt shortened to something usable as alt text.
   *
   * Prompts here run to thousands of characters, and a whole one in `alt` is wrong twice over. A
   * screen reader reads every word of it; and when the image fails to load the browser *renders*
   * the alt text, at which point the <img> stops being replaced content, sizes itself to that text
   * and ignores its own `aspect-ratio`. One unloadable thumbnail with a 2,524-character prompt
   * measured 1,746px tall instead of 246px and wrecked the row it was in.
   *
   * The full prompt is still on the card as a `title`, in the prompt overlay, and in the lightbox,
   * so nothing is lost by keeping this short.
   */
  function imageAltText(prompt) {
    const text = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'Grok Imagine result';
    if (text.length <= IMAGE_ALT_MAX) return text;
    return `${text.slice(0, IMAGE_ALT_MAX - 1).trimEnd()}\u2026`;
  }

  /**
   * Points a card's thumbnail at `thumb`, returning the image element in use.
   *
   * When a card is **recycled for a different post** the <img> is replaced rather than
   * re-pointed. Assigning `src` leaves the previous post's picture painted until the new one has
   * loaded, and with `loading="lazy"` that wait can be unbounded: the element is already in the
   * layout and never leaves and re-enters the viewport, so nothing re-triggers the deferred load.
   * The rows nearest the fold therefore kept showing the page before -- the bottom of page 2 was
   * still page 1.
   *
   * A fresh element fixes both halves. It paints nothing rather than the wrong picture, so the
   * worst case is a cell that is visibly still loading instead of one that quietly lies; and its
   * loading state is evaluated when it is inserted, so it cannot inherit a stuck one. The
   * replacement loads eagerly because paging is an explicit request to see *that* page, while the
   * first paint of a fresh card stays lazy -- that is the case lazy loading is actually for.
   *
   * `:scope > img` matters: the compact strip's thumbnails are `<img>` elements inside this card
   * too, and a bare `querySelector('img')` only avoids them by DOM order.
   */
  function syncCardImage(card, thumb, prompt) {
    const img = card.querySelector(':scope > img');
    if (!img) return null;

    const alt = imageAltText(prompt);
    const previous = img.getAttribute('src') || '';
    if (previous === thumb) {
      if (img.alt !== alt) img.alt = alt;
      return img;
    }
    if (!previous) {
      if (thumb) img.setAttribute('src', thumb);
      img.alt = alt;
      return img;
    }

    const fresh = document.createElement('img');
    fresh.loading = 'eager';
    // Copied rather than restated, so the replacement cannot drift from the skeleton's box.
    fresh.style.cssText = img.style.cssText;
    fresh.className = img.className;
    fresh.alt = alt;
    if (thumb) fresh.setAttribute('src', thumb);
    img.replaceWith(fresh);
    return fresh;
  }

  /** Skeleton built once per card; renderResultCard() patches the parts that vary. */
  function createResultCardElement() {
    const card = document.createElement('div');
    card.className = 'grok-result-card';
    card.innerHTML = `
      <label class="grok-result-select" title="Select for download">
        <input type="checkbox" class="grok-result-select-input" />
      </label>
      <span class="grok-result-child-mark" title="Child post" hidden>${CHILD_MARK_SVG}</span>
      <button type="button" class="grok-result-like" aria-pressed="false">${HEART_SVG}</button>
      <div class="grok-result-date" hidden></div>
      <img loading="lazy" style="width:100%; display:block; border-radius:14px; aspect-ratio:3/4; object-fit:cover;" />
      <div class="grok-result-prompt"></div>
      <div class="grok-result-badges" hidden></div>
      <div class="grok-result-kids" hidden></div>`;
    return card;
  }

  /**
   * Patches an existing card in place. Assigning `img.src` only when it differs is the whole
   * point: rebuilding the grid with innerHTML made the browser re-decode every thumbnail on
   * each page change, filter change, and sort.
   */
  function renderResultCard(card, entry) {
    const post = entry.post;
    const children = entry.children || [];
    const childCard = isChildPost(post);
    const selected = selectedPostIds.has(post.id);
    const dateKey = formatPostDateKey(post.createTime);
    const dateStr = formatPostDate(post.createTime);
    const mediaUrl = post.mediaUrl || '';
    const prompt = post.prompt || '';

    if (card.dataset.id !== post.id) card.dataset.id = post.id;
    if (card.dataset.media !== mediaUrl) card.dataset.media = mediaUrl;
    if (card.title !== prompt) card.title = prompt;
    card.classList.toggle('grok-result-card--child', childCard);
    card.classList.toggle('grok-result-card--group', children.length > 0);
    card.classList.toggle('grok-result-card--selected', selected);

    // Folded children have no checkbox of their own, so the parent's covers the whole group --
    // otherwise compact mode would make them impossible to select for download or delete.
    const groupIds = children.length
      ? [post.id, ...children.map(c => c.id)].join(' ')
      : post.id;
    if (card.dataset.group !== groupIds) card.dataset.group = groupIds;

    const input = card.querySelector('.grok-result-select-input');
    if (input) {
      if (input.dataset.id !== post.id) input.dataset.id = post.id;
      if (input.checked !== selected) input.checked = selected;
    }

    const selectLabel = card.querySelector('.grok-result-select');
    if (selectLabel) {
      const selectTitle = children.length
        ? `Select this group (${children.length + 1} items) for download`
        : 'Select for download';
      if (selectLabel.title !== selectTitle) selectLabel.title = selectTitle;
    }

    const mark = card.querySelector('.grok-result-child-mark');
    if (mark) mark.hidden = !childCard;

    const like = card.querySelector('.grok-result-like');
    if (like) {
      const liked = post.isLiked === true;
      const unknown = post.isLiked == null;
      like.classList.toggle('is-liked', liked);
      like.classList.toggle('is-unknown', unknown);
      if (like.getAttribute('aria-pressed') !== String(liked)) like.setAttribute('aria-pressed', String(liked));
      const title = liked ? 'Unlike' : (unknown ? 'Like (current state unknown)' : 'Like');
      if (like.title !== title) like.title = title;
    }

    const dateEl = card.querySelector('.grok-result-date');
    if (dateEl) {
      dateEl.hidden = !dateStr;
      if (dateStr) {
        if (dateEl.textContent !== dateStr) dateEl.textContent = dateStr;
        if (dateEl.dataset.date !== dateKey) dateEl.dataset.date = dateKey;
        dateEl.title = `Filter to ${dateStr} (click again to clear)`;
        dateEl.classList.toggle('grok-result-date-active', Boolean(dateKey) && isFilteredToSingleDay(dateKey));
      }
    }

    syncCardImage(card, getPostThumbnailUrl(post), prompt);

    const promptEl = card.querySelector('.grok-result-prompt');
    if (promptEl && promptEl.textContent !== prompt) promptEl.textContent = prompt;

    const badges = card.querySelector('.grok-result-badges');
    if (badges) {
      const html = renderResultBadgesInner(post);
      if (badges.dataset.sig !== html) {
        badges.dataset.sig = html;
        badges.innerHTML = html;
      }
      badges.hidden = !html;
    }

    const kids = card.querySelector('.grok-result-kids');
    if (kids) {
      const html = renderChildStripInner(children);
      if (kids.dataset.sig !== html) {
        kids.dataset.sig = html;
        kids.innerHTML = html;
      }
      kids.hidden = !html;
    }
  }

  /**
   * Reconciles the grid against `page` — a list of `{ post, children }` entries — reusing cards
   * by the entry's own post id and dropping the leftovers.
   */
  function renderResultCards(container, page) {
    const byId = new Map();
    const leftovers = new Set(container.children);
    for (const el of container.children) {
      const id = el.dataset?.id;
      if (id && !byId.has(id)) byId.set(id, el);
    }

    let cursor = container.firstElementChild;
    for (const entry of page) {
      let card = byId.get(entry.post.id);
      if (card) byId.delete(entry.post.id);
      else card = createResultCardElement();
      leftovers.delete(card);
      if (card === cursor) cursor = cursor.nextElementSibling;
      else container.insertBefore(card, cursor);
      renderResultCard(card, entry);
    }

    for (const el of leftovers) el.remove();
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

  /**
   * One grid card per *family* when compact mode is on: a matched child is folded into the
   * nearest matched ancestor instead of taking a cell of its own. Children stay in
   * `matchedPosts`, so the lightbox, selection, download and delete paths are untouched --
   * only what the grid pages over changes.
   *
   * The nearest matched *ancestor*, not the immediate parent: with "Hide childs" off and a
   * prompt filter on, a grandchild can match while its own parent does not, and folding it into
   * the grandparent keeps it visible instead of stranding it in a group nobody rendered.
   */
  function buildDisplayEntries() {
    if (!compactGroups) return matchedPosts.map(post => ({ post, children: [] }));

    const entryById = new Map();
    for (const post of matchedPosts) entryById.set(post.id, { post, children: [] });

    /**
     * The *outermost* matched ancestor, not the nearest one. Walking only as far as the first
     * match folds a grandchild into a parent that is itself folded somewhere else, and that
     * inner entry is never rendered — the row would vanish from the grid.
     */
    const ownerIdOf = post => {
      let cursor = post;
      let ownerId = null;
      const seen = new Set([post.id]);
      while (isChildPost(cursor) && cursor.parentId) {
        const parentId = String(cursor.parentId);
        if (seen.has(parentId)) break;         // a cycle in the tree
        seen.add(parentId);
        if (entryById.has(parentId)) ownerId = parentId;
        const parent = getPostById(parentId);
        if (!parent) break;                    // chain leaves the index; keep what was found
        cursor = parent;
      }
      return ownerId;
    };

    const ownerById = new Map();
    for (const post of matchedPosts) ownerById.set(post.id, ownerIdOf(post));

    const out = [];
    for (const post of matchedPosts) {
      // Fold only into a card that is itself rendered. If the owner turns out to be folded too —
      // which a cycle makes true of everyone — give the row its own cell rather than posting it
      // into an entry nobody draws.
      const ownerId = ownerById.get(post.id);
      if (ownerId && !ownerById.get(ownerId)) entryById.get(ownerId).children.push(post);
      else out.push(entryById.get(post.id));
    }
    return out;
  }

  /**
   * Cached until `matchedPosts` is replaced or the compact switch moves. The identity check is
   * the safety net: applyFilter() invalidates explicitly, but every other path that rebuilds the
   * match set does so by assigning a fresh array, and that is enough to be noticed here.
   */
  function getDisplayEntries() {
    const signature = `${compactGroups ? 1 : 0}:${matchedPosts.length}`;
    if (displayEntriesSource !== matchedPosts || displayEntriesSignature !== signature) {
      displayEntriesSource = matchedPosts;
      displayEntriesSignature = signature;
      displayEntries = buildDisplayEntries();
    }
    return displayEntries;
  }

  function invalidateDisplayEntries() {
    displayEntriesSource = null;
  }

  /**
   * How many cards the grid has, and one page of them.
   *
   * With compact off these deliberately never touch getDisplayEntries(): the entry list would be
   * a 1:1 wrapper around the whole match set, and building it would mean allocating an object per
   * indexed post on every keystroke. Only the page actually rendered gets wrapped.
   */
  function getDisplayCount() {
    return compactGroups ? getDisplayEntries().length : matchedPosts.length;
  }

  function getDisplayPage(start, size) {
    if (!compactGroups) {
      return matchedPosts.slice(start, start + size).map(post => ({ post, children: [] }));
    }
    return getDisplayEntries().slice(start, start + size);
  }

  function getTotalPages() {
    return Math.max(1, Math.ceil(getDisplayCount() / getPageSize()));
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
      localStorage.setItem(COMPACT_GROUPS_KEY, compactGroups ? '1' : '0');
      localStorage.setItem(TOGGLE_POS_KEY, togglePosition);
    } catch { /* ignore */ }
  }

  function clampTogglePosition(value) {
    const pos = String(value || '').trim();
    return TOGGLE_POSITIONS.includes(pos) ? pos : DEFAULT_TOGGLE_POS;
  }

  function readStoredTogglePosition() {
    try {
      return clampTogglePosition(localStorage.getItem(TOGGLE_POS_KEY));
    } catch {
      return DEFAULT_TOGGLE_POS;
    }
  }

  function readStoredCompactGroups() {
    try {
      const stored = localStorage.getItem(COMPACT_GROUPS_KEY);
      return stored === null || stored === '' ? DEFAULT_COMPACT_GROUPS : stored === '1';
    } catch {
      return DEFAULT_COMPACT_GROUPS;
    }
  }

  /** Corners are classes, not inline styles, so both copies of the stylesheet agree on them. */
  function applyTogglePosition(pos, persist) {
    togglePosition = clampTogglePosition(pos);
    const btn = document.getElementById('grok-search-toggle');
    if (btn) {
      for (const p of TOGGLE_POSITIONS) btn.classList.toggle(`grok-toggle-${p}`, p === togglePosition);
    }
    const select = document.getElementById('grok-toggle-pos-select');
    if (select && select.value !== togglePosition) select.value = togglePosition;
    if (persist) {
      try {
        localStorage.setItem(TOGGLE_POS_KEY, togglePosition);
      } catch { /* ignore */ }
    }
  }

  function applyCompactGroupsSetting(on) {
    compactGroups = Boolean(on);
    invalidateDisplayEntries();
    syncDisplayControlLabels();
    persistDisplaySettings();
    currentPage = 0;
    if (shouldShowSearchResults() && matchedPosts.length > 0) showResults();
    else updatePager();
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
    compactGroups = DEFAULT_COMPACT_GROUPS;
    invalidateDisplayEntries();
    applyTogglePosition(DEFAULT_TOGGLE_POS, false);
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
    const compactEl = document.getElementById('grok-compact-groups');
    if (compactEl && compactEl.checked !== compactGroups) compactEl.checked = compactGroups;
    const posEl = document.getElementById('grok-toggle-pos-select');
    if (posEl && posEl.value !== togglePosition) posEl.value = togglePosition;
  }

  function updatePanelPageRange(pageEntries) {
    const rangeEl = document.getElementById('grok-panel-range');
    if (!rangeEl) return;
    if (!pageEntries.length) {
      rangeEl.textContent = '';
      return;
    }
    const first = formatPostDateTime(pageEntries[0].post.createTime);
    const last = formatPostDateTime(pageEntries[pageEntries.length - 1].post.createTime);
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
    const cached = post[RUNTIME_MS];
    if (typeof cached === 'number') return cached || null;
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
    const childrenMinEl = document.getElementById('grok-filter-children-min');
    const filterVideoOnlyEl = document.getElementById('grok-filter-video-only');
    const filterWithVideoEl = document.getElementById('grok-filter-with-video');
    const filterChildrenEl = document.getElementById('grok-filter-children');
    if (childrenMinEl) {
      childrenMinEl.value = String(filterMinChildren);
      childrenMinEl.disabled = !filterOnlyChildren;
    }
    if (filterVideoOnlyEl) filterVideoOnlyEl.checked = filterVideoOnly;
    if (filterWithVideoEl) filterWithVideoEl.checked = filterWithVideo;
    if (filterChildrenEl) filterChildrenEl.checked = filterOnlyChildren;
    const filterHideChildsEl = document.getElementById('grok-filter-hide-childs');
    if (filterHideChildsEl) filterHideChildsEl.checked = filterHideChilds;
  }

  function hasDateFilter() {
    return Boolean(dateStart || dateEnd);
  }

  function hasActiveFilter() {
    return Boolean(
      currentQuery.trim() || hasDateFilter() || filterVideoOnly || filterWithVideo
      || filterOnlyChildren || filterHideChilds || filterModel || filterLikedOnly
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

  function matchesDateBounds(post, { startMs, endMs }) {
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
        top: 70px;
        right: 16px;
        z-index: 100005;
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
      /* The corner is a class so the preference survives both copies of this stylesheet.
         Every rule resets the opposite pair, or a stale offset keeps the old corner alive.

         The top corners clear Grok's own header rather than starting at 16px: measured on
         grok.com/imagine/saved, its Select button ends at x2323 and its search button occupies
         x2331-2371 at y13-53, so a 44px button at top:16px lands exactly on top of the search
         control. 70px puts it under the whole header row and over nothing but the grid. */
      #grok-search-toggle.grok-toggle-tr { top: 70px; right: 16px; bottom: auto; left: auto; }
      #grok-search-toggle.grok-toggle-br { top: auto; right: 16px; bottom: 16px; left: auto; }
      #grok-search-toggle.grok-toggle-tl { top: 70px; right: auto; bottom: auto; left: 16px; }
      #grok-search-toggle.grok-toggle-bl { top: auto; right: auto; bottom: 16px; left: 16px; }
      /* The bar is min(900px, 92vw) and centred, so below ~1040px its right edge reaches the
         button and a top corner would sit on the toolbar. Drop to the bottom there. */
      @media (max-width: 1040px) {
        #grok-search-toggle.grok-toggle-tr,
        #grok-search-toggle.grok-toggle-tl { top: auto; bottom: 16px; }
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
      .grok-display-select {
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 7px;
        color: rgba(255,255,255,0.8);
        font-size: 11px;
        padding: 2px 5px;
        outline: none;
        cursor: pointer;
        font-family: inherit;
      }
      .grok-display-select:hover { border-color: rgba(139,92,246,0.5); color: #fff; }
      .grok-display-select option { background: #1a1a2e; color: #fff; }
      .grok-display-control input[type="checkbox"] {
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
      /* Fixed and above the page, so it needs its own surface. Without a background the
         results floated transparently over Grok's own content and the two interleaved. */
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
        background: #14141c;
        border-top: 1px solid rgba(255, 255, 255, 0.14);
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
      /* Filters and actions both wrap: their children are flex-shrink:0, so a nowrap row
         overflows its own box and paints over the neighbouring group instead of reflowing. */
      .grok-bar-bottom {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px 12px;
        width: 100%;
        flex-wrap: wrap;
      }
      .grok-bar-filters {
        display: flex;
        align-items: center;
        gap: 6px 8px;
        flex-wrap: wrap;
        flex: 1 1 auto;
        min-width: 0;
      }
      .grok-bar-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
        /* Must be shrinkable, or on a narrow bar the group keeps its max-content width and
           the last buttons hang outside the panel instead of wrapping. */
        min-width: 0;
        margin-left: auto;
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
      /* Cancel and Retry join this row mid-download, so it has to reflow rather than overflow
         and paint over whatever sits next to it. */
      .grok-results-count-wrap {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px 8px;
        min-width: 0;
        line-height: 1;
      }
      #grok-search-count-wrap {
        display: inline-flex;
      }
      .grok-download-results-btn,
      .grok-download-selected-btn,
      .grok-check-all-btn,
      .grok-clear-selection-btn,
      .grok-cancel-download-btn,
      .grok-retry-download-btn,
      .grok-delete-selected-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        padding: 3px 7px;
        line-height: 1;
        white-space: nowrap;
      }
      /* These rules set display, so the hidden attribute needs to outrank them. */
      .grok-results-count-wrap [hidden] { display: none !important; }
      .grok-cancel-download-btn:not(:disabled) {
        border-color: rgba(248,113,113,0.45);
        color: rgba(252,165,165,0.95);
      }
      .grok-cancel-download-btn:hover:not(:disabled) {
        border-color: rgba(248,113,113,0.8);
        background: rgba(248,113,113,0.15);
        color: #fff;
      }
      .grok-retry-download-btn:not(:disabled) {
        border-color: rgba(251,191,36,0.45);
        color: rgba(253,224,71,0.95);
      }
      .grok-retry-download-btn:hover:not(:disabled) {
        border-color: rgba(251,191,36,0.8);
        background: rgba(251,191,36,0.15);
        color: #fff;
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
      /* Card parts are built once and reused across pages, so optional parts are toggled
         with [hidden] — which needs to beat the display:flex rules below. */
      .grok-result-card [hidden] { display: none !important; }
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
        /* Cards must keep their own height. A compact card is 39px taller than a plain one, and
           the grid's default stretch grew every card in the row to match -- leaving the prompt
           overlay of the plain ones floating below their image over empty card background. */
        align-items: start;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 17px;
        padding: 0;
        width: 100%;
        box-sizing: border-box;
        max-width: none;
        margin: 0;
      }
      html.grok-custom-results-mode [data-grok-native-saved-root="1"],
      html.grok-custom-results-mode [data-grok-hid-grid="1"],
      html.grok-custom-results-mode [data-grok-hid-root="1"],
      html.grok-custom-results-mode [class*="media-post-masonry-card"],
      html.grok-custom-results-mode main a[href^="/imagine/post/"]:not(.grok-lightbox-kid) {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      html.grok-filtered-inline-mode [class*="media-post-masonry-card"],
      html.grok-filtered-inline-mode main a[href^="/imagine/post/"]:not(.grok-lightbox-kid),
      html.grok-filtered-inline-mode [data-grok-hid-grid="1"] {
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
      /* The heart owns the top-right corner, so the child marker moves to the bottom-left. */
      .grok-result-child-mark {
        position: absolute;
        bottom: 8px;
        left: 8px;
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
      /* A compact card is image + strip, so the overlays that hug the bottom of the image have
         to clear the strip rather than sit on top of it. */
      .grok-result-kids {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 4px 5px;
        overflow-x: auto;
        scrollbar-width: none;
        background: rgba(12, 12, 18, 0.92);
        border-top: 1px solid rgba(139, 92, 246, 0.28);
      }
      .grok-result-kids::-webkit-scrollbar { display: none; }
      .grok-result-kid {
        flex: 0 0 auto;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.06);
        cursor: pointer;
        transition: border-color 0.15s, transform 0.15s;
      }
      .grok-result-kid:hover {
        border-color: rgba(196, 181, 253, 0.75);
        transform: scale(1.12);
      }
      .grok-result-kid img {
        width: 100%;
        height: 100%;
        display: block;
        border-radius: 0;
        aspect-ratio: auto;
        object-fit: cover;
      }
      .grok-result-kid-more {
        flex: 0 0 auto;
        padding: 0 6px;
        font-size: 10px;
        font-weight: 600;
        line-height: 30px;
        color: rgba(196, 181, 253, 0.9);
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        /* Eight thumbnails never fit a 180px card, so the strip scrolls and an ordinary trailing
           chip would sit permanently off-screen. Sticky pins it to the visible right edge. */
        position: sticky;
        right: 0;
        background: rgba(12, 12, 18, 0.92);
        pointer-events: none;
      }
      .grok-result-card--group .grok-result-prompt { bottom: 39px; border-radius: 0; }
      .grok-result-card--group .grok-result-badges { bottom: 47px; }
      .grok-result-card--group .grok-result-child-mark { bottom: 47px; }
      .grok-result-card--selected:hover {
        box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.75), 0 8px 32px rgba(0,0,0,0.5);
      }
      .grok-result-card img { width: 100%; display: block; border-radius: 14px; aspect-ratio: 3/4; object-fit: cover; }
      /* A broken image is not replaced content: the browser lays out its alt text instead and
         grows the box to fit it, ignoring aspect-ratio. "contain: size" makes the element size as
         if it had no contents, so the 3/4 box holds whether the media loads, fails, or is still
         on its way -- and the alt cap in imageAltText() is then a second line of defence rather
         than the only one. Scoped to the direct child so the compact strip's thumbnails, which
         size against their own fixed button, are untouched. */
      .grok-result-card > img { contain: size; }
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
      .grok-bulk-download-confirm {
        position: fixed;
        inset: 0;
        z-index: 100010;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .grok-bulk-download-confirm[hidden] { display: none !important; }
      .grok-bulk-download-confirm-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      .grok-bulk-download-confirm-panel {
        position: relative;
        z-index: 1;
        width: min(400px, 92vw);
        background: rgba(15, 15, 20, 0.93);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        padding: 16px 18px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
      }
      .grok-bulk-download-confirm-title {
        font-size: 14px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.92);
        margin-bottom: 8px;
      }
      .grok-bulk-download-confirm-message {
        font-size: 13px;
        line-height: 1.45;
        color: rgba(255, 255, 255, 0.72);
        margin: 0 0 16px;
      }
      .grok-bulk-download-confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .grok-bulk-download-confirm-ok {
        border-color: rgba(139, 92, 246, 0.45);
        background: rgba(139, 92, 246, 0.2);
        color: #fff;
      }
      .grok-bulk-download-confirm-ok:hover:not(:disabled) {
        border-color: rgba(139, 92, 246, 0.65);
        background: rgba(139, 92, 246, 0.32);
      }
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
      .grok-result-context-item:hover:not(:disabled) {
        background: rgba(139, 92, 246, 0.22);
        color: #fff;
      }
      .grok-result-context-item:disabled,
      .grok-result-context-item--disabled {
        opacity: 0.35;
        cursor: default;
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
        /* Prompts reach a few thousand characters. Unbounded, one of those grows the footer far
           enough to squeeze the image out of the panel, so the prompt scrolls instead. */
        max-height: 22vh;
        overflow-y: auto;
        overscroll-behavior: contain;
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
      .grok-lightbox-kids {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 9px;
      }
      .grok-lightbox-kids-label {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
        margin-right: 3px;
      }
      .grok-lightbox-kid {
        width: 38px;
        height: 38px;
        display: block;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 7px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.06);
        transition: border-color 0.15s, transform 0.15s;
      }
      .grok-lightbox-kid:hover {
        border-color: rgba(196, 181, 253, 0.8);
        transform: scale(1.08);
      }
      .grok-lightbox-kid img { width: 100%; height: 100%; display: block; object-fit: cover; }
      .grok-lightbox-kid-more {
        font-size: 11px;
        font-weight: 600;
        color: rgba(196, 181, 253, 0.9);
        padding: 0 4px;
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
      .grok-result-like {
        position: absolute; top: 8px; right: 8px; z-index: 5;
        display: flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0;
        border: none; border-radius: 50%;
        background: rgba(0,0,0,0.45); cursor: pointer;
        color: rgba(255,255,255,0.75);
        opacity: 0; transition: opacity 0.15s, color 0.15s, background 0.15s, transform 0.12s;
      }
      .grok-result-card:hover .grok-result-like,
      .grok-result-like:focus-visible { opacity: 1; }
      .grok-result-like svg { fill: none; stroke: currentColor; stroke-width: 2; }
      .grok-result-like:hover { background: rgba(0,0,0,0.7); color: #ff6b8a; transform: scale(1.08); }
      .grok-result-like.is-liked { opacity: 1; color: #ff4d6d; }
      .grok-result-like.is-liked svg { fill: currentColor; stroke: currentColor; }
      .grok-result-like.is-unknown { color: rgba(255,255,255,0.45); }
      .grok-lightbox-like-btn.is-liked { color: #ff4d6d; border-color: rgba(255,77,109,0.5); }
      .grok-delete-selected-btn:not(:disabled),
      .grok-lightbox-delete-btn:not(:disabled) {
        border-color: rgba(248,113,113,0.45);
        color: rgba(252,165,165,0.95);
      }
      .grok-delete-selected-btn:hover:not(:disabled),
      .grok-lightbox-delete-btn:hover:not(:disabled) {
        border-color: rgba(248,113,113,0.85);
        background: rgba(248,113,113,0.18);
        color: #fff;
      }
      .grok-toolbar-btn.grok-confirm-danger {
        border-color: rgba(248,113,113,0.65);
        background: rgba(248,113,113,0.18);
        color: #ffd9d9;
      }
      .grok-toolbar-btn.grok-confirm-danger:hover:not(:disabled) {
        border-color: rgba(248,113,113,0.95);
        background: rgba(248,113,113,0.3);
        color: #fff;
      }
      .grok-filter-model-select {
        font-size: 11px; padding: 2px 6px; margin: 0;
        max-width: 160px;
        border-radius: 4px; border: 1px solid rgba(255,255,255,0.15);
        background: rgba(0,0,0,0.35); color: rgba(255,255,255,0.85);
        cursor: pointer; flex-shrink: 0;
      }
      .grok-filter-model-select[hidden] { display: none; }
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
    btn.title = `Reset to ${DEFAULT_PAGE_SIZE} per page, ${DEFAULT_GRID_SIZE_PCT}% size, `
      + 'compact off and the button in the top-right corner';
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

    if (!document.getElementById('grok-compact-groups')) {
      const compact = document.createElement('label');
      compact.id = 'grok-compact-groups-label';
      compact.className = 'grok-display-control';
      compact.title = 'Fold child results into their parent card instead of giving each one its own cell';
      compact.innerHTML = '<input type="checkbox" id="grok-compact-groups" /> Compact';
      row.appendChild(compact);
    }
    if (!document.getElementById('grok-toggle-pos-select')) {
      const posCtrl = document.createElement('label');
      posCtrl.id = 'grok-toggle-pos-label';
      posCtrl.className = 'grok-display-control';
      posCtrl.title = 'Corner the show/hide button sits in';
      posCtrl.innerHTML = `
        Button
        <select id="grok-toggle-pos-select" class="grok-display-select">
          <option value="tr">Top right</option>
          <option value="br">Bottom right</option>
          <option value="tl">Top left</option>
          <option value="bl">Bottom left</option>
        </select>`;
      row.appendChild(posCtrl);
    }

    ensureDisplayDefaultButton();

    bindDisplayControlListeners();
  }

  function bindDisplayControlListeners() {
    const pageSlider = document.getElementById('grok-page-size-slider');
    const gridSlider = document.getElementById('grok-grid-size-slider');
    const defaultBtn = document.getElementById('grok-display-default');

    if (pageSlider && gridSlider && !pageSlider.dataset.grokDisplayBound) {
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

    // Each control guards on its own binding flag. Hanging them off the sliders' flag is the
    // mistake that left Import JSON and Verify missing for a whole release.
    const compactEl = document.getElementById('grok-compact-groups');
    if (compactEl && !compactEl.dataset.grokDisplayBound) {
      compactEl.dataset.grokDisplayBound = '1';
      compactGroups = readStoredCompactGroups();
      compactEl.checked = compactGroups;
      invalidateDisplayEntries();
      compactEl.addEventListener('change', () => applyCompactGroupsSetting(compactEl.checked));
    }

    const posEl = document.getElementById('grok-toggle-pos-select');
    if (posEl && !posEl.dataset.grokDisplayBound) {
      posEl.dataset.grokDisplayBound = '1';
      posEl.value = togglePosition;
      posEl.addEventListener('change', () => applyTogglePosition(posEl.value, true));
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
      'grok-filter-video-only-label',
      'grok-filter-with-video-label',
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
    ['grok-filter-video-only-label', 'grok-filter-with-video-label', 'grok-filter-children-label', 'grok-filter-hide-childs-label', 'grok-search-clear']
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

  /** Distinct model names present in the index, for the model filter dropdown. */
  function collectIndexModels() {
    const models = new Set();
    for (const p of allPosts) {
      const m = String(p.model || '').trim();
      if (m) models.add(m);
    }
    return [...models].sort((a, b) => a.localeCompare(b));
  }

  function ensureLikedFilterCheckbox() {
    if (document.getElementById('grok-filter-liked-label')) return;
    const filters = getFiltersRow();
    if (!filters) return;
    const label = document.createElement('label');
    label.id = 'grok-filter-liked-label';
    label.className = 'grok-filter-check-label';
    label.title = 'Show only posts you have liked';
    label.innerHTML = '<input type="checkbox" id="grok-filter-liked" /> Liked only';
    const hideChilds = document.getElementById('grok-filter-hide-childs-label');
    if (hideChilds) hideChilds.insertAdjacentElement('afterend', label);
    else filters.appendChild(label);

    const input = label.querySelector('input');
    input.checked = filterLikedOnly;
    input.addEventListener('change', () => {
      filterLikedOnly = input.checked;
      writeStoredString(FILTER_LIKED_KEY, filterLikedOnly ? '1' : '0');
      currentPage = 0;
      updateClearButton();
      applyFilter();
    });
  }

  function ensureModelFilterSelect() {
    if (document.getElementById('grok-filter-model')) return;
    const filters = getFiltersRow();
    if (!filters) return;
    const sel = document.createElement('select');
    sel.id = 'grok-filter-model';
    sel.className = 'grok-filter-model-select';
    sel.title = 'Filter by generation model';
    sel.setAttribute('aria-label', 'Filter by model');
    sel.addEventListener('change', () => {
      filterModel = sel.value;
      writeStoredString(FILTER_MODEL_KEY, filterModel);
      currentPage = 0;
      updateClearButton();
      applyFilter();
    });
    const hideChilds = document.getElementById('grok-filter-hide-childs-label');
    if (hideChilds) hideChilds.insertAdjacentElement('afterend', sel);
    else filters.appendChild(sel);
    syncModelFilterOptions();
  }

  /** Rebuilds the option list from the index, preserving the stored selection. */
  let modelOptionsRevision = -1;

  function syncModelFilterOptions() {
    const sel = document.getElementById('grok-filter-model');
    if (!sel) return;
    if (sel.dataset.grokModels !== undefined && modelOptionsRevision === indexRevision) return;
    modelOptionsRevision = indexRevision;
    const models = collectIndexModels();
    const wanted = filterModel;
    const signature = models.join('|');
    // A stored model that is not in the index matches nothing, which looks exactly like
    // "my newest posts are missing" if they were generated with a newer model. Clear it
    // before either exit path, not just when the option list is rebuilt.
    if (wanted && !models.includes(wanted)) {
      console.warn(`[GrokSearch] Model filter "${wanted}" is not present in the index — clearing it`);
      filterModel = '';
      writeStoredString(FILTER_MODEL_KEY, '');
    }
    if (sel.dataset.grokModels === signature) {
      if (sel.value !== filterModel) sel.value = filterModel;
      return;
    }
    sel.dataset.grokModels = signature;
    sel.innerHTML = `<option value="">All models</option>`
      + models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    sel.value = filterModel;
    sel.hidden = models.length === 0;
  }

  function loadModelFilterFromStorage() {
    filterModel = readStoredString(FILTER_MODEL_KEY, '');
  }

  /** Unknown like state (null) never counts as liked, so it is not silently included. */
  function matchesLikedFilter(post) {
    if (!filterLikedOnly) return true;
    return post.isLiked === true;
  }

  function loadLikedFilterFromStorage() {
    filterLikedOnly = readStoredString(FILTER_LIKED_KEY, '0') === '1';
  }

  function matchesModelFilter(post) {
    if (!filterModel) return true;
    return String(post.model || '') === filterModel;
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

  function migrateLegacyVideoFilterUi() {
    document.getElementById('grok-filter-video-min')?.remove();
    document.getElementById('grok-filter-video-label')?.remove();
  }

  function loadVideoFiltersFromStorage() {
    try {
      const videoOnlyStored = localStorage.getItem(FILTER_VIDEO_ONLY_KEY);
      const withVideoStored = localStorage.getItem(FILTER_WITH_VIDEO_KEY);
      if (videoOnlyStored !== null && videoOnlyStored !== '') {
        filterVideoOnly = videoOnlyStored === '1';
      }
      if (withVideoStored !== null && withVideoStored !== '') {
        filterWithVideo = withVideoStored === '1';
      } else if (localStorage.getItem(FILTER_VIDEO_KEY) === '1') {
        filterWithVideo = true;
      }
    } catch { /* ignore */ }
  }

  function ensureMediaFilterCheckboxes() {
    const filters = getFiltersRow();
    const dateEnd = document.getElementById('grok-date-end');
    if (!filters) return;

    migrateLegacyVideoFilterUi();

    if (!document.getElementById('grok-filter-video-only')) {
      const videoOnlyLabel = document.createElement('label');
      videoOnlyLabel.id = 'grok-filter-video-only-label';
      videoOnlyLabel.className = 'grok-filter-check-label';
      videoOnlyLabel.title = 'Show only video posts (hide images)';
      videoOnlyLabel.innerHTML = '<input type="checkbox" id="grok-filter-video-only" /> Video only';
      if (dateEnd) dateEnd.insertAdjacentElement('afterend', videoOnlyLabel);
      else filters.appendChild(videoOnlyLabel);
    }
    if (!document.getElementById('grok-filter-with-video')) {
      const withVideoLabel = document.createElement('label');
      withVideoLabel.id = 'grok-filter-with-video-label';
      withVideoLabel.className = 'grok-filter-check-label';
      withVideoLabel.title = 'Show image posts that have video in child results';
      withVideoLabel.innerHTML = '<input type="checkbox" id="grok-filter-with-video" /> With video';
      const videoOnlyLabel = document.getElementById('grok-filter-video-only-label');
      (videoOnlyLabel || dateEnd || filters).insertAdjacentElement('afterend', withVideoLabel);
    }
    if (!document.getElementById('grok-filter-children')) {
      const childLabel = document.createElement('label');
      childLabel.id = 'grok-filter-children-label';
      childLabel.className = 'grok-filter-check-label';
      childLabel.title = 'Show only items with at least N child posts';
      childLabel.innerHTML = '<input type="checkbox" id="grok-filter-children" /> With child';
      const withVideoLabel = document.getElementById('grok-filter-with-video-label');
      (withVideoLabel || dateEnd || filters).insertAdjacentElement('afterend', childLabel);
    }
    ensureHideChildsCheckbox();

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
    const filterVideoOnlyEl = document.getElementById('grok-filter-video-only');
    const filterWithVideoEl = document.getElementById('grok-filter-with-video');
    const filterChildrenEl = document.getElementById('grok-filter-children');
    const filterHideChildsEl = document.getElementById('grok-filter-hide-childs');
    const childrenMinEl = document.getElementById('grok-filter-children-min');
    if (!filterVideoOnlyEl || !filterWithVideoEl || !filterChildrenEl || !filterHideChildsEl || !childrenMinEl) return;

    const persistMediaFilters = () => {
      try {
        localStorage.setItem(FILTER_VIDEO_ONLY_KEY, filterVideoOnly ? '1' : '0');
        localStorage.setItem(FILTER_WITH_VIDEO_KEY, filterWithVideo ? '1' : '0');
        localStorage.setItem(FILTER_CHILDREN_KEY, filterOnlyChildren ? '1' : '0');
        localStorage.setItem(FILTER_HIDE_CHILDS_KEY, filterHideChilds ? '1' : '0');
        localStorage.setItem(FILTER_CHILDREN_MIN_KEY, String(filterMinChildren));
      } catch { /* ignore */ }
    };

    const onMediaFilterChange = () => {
      filterVideoOnly = filterVideoOnlyEl.checked;
      filterWithVideo = filterWithVideoEl.checked;
      filterOnlyChildren = filterChildrenEl.checked;
      filterHideChilds = filterHideChildsEl.checked;
      filterMinChildren = parseMediaMin(childrenMinEl.value);
      syncMediaMinSelects();
      persistMediaFilters();
      currentPage = 0;
      updateClearButton();
      applyFilter();
    };

    if (!filterVideoOnlyEl.dataset.grokFilterBound) {
      filterVideoOnlyEl.dataset.grokFilterBound = '1';
      filterWithVideoEl.dataset.grokFilterBound = '1';
      filterChildrenEl.dataset.grokFilterBound = '1';
      loadVideoFiltersFromStorage();
      try {
        filterOnlyChildren = localStorage.getItem(FILTER_CHILDREN_KEY) === '1';
        filterMinChildren = parseMediaMin(localStorage.getItem(FILTER_CHILDREN_MIN_KEY));
      } catch { /* ignore */ }
      filterVideoOnlyEl.addEventListener('change', onMediaFilterChange);
      filterWithVideoEl.addEventListener('change', onMediaFilterChange);
      filterChildrenEl.addEventListener('change', onMediaFilterChange);
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

    appendSelectionToolbarButton(
      panelWrap,
      'grok-delete-selected-btn',
      'Delete selected',
      'Permanently delete the selected items from your Grok library'
    );

    // Cancel and Retry live next to Download selected in both bars; they are hidden unless a
    // run is active or the last run left something behind.
    for (const wrap of [toolbarWrap, panelWrap]) {
      appendSelectionToolbarButton(
        wrap,
        'grok-cancel-download-btn',
        'Cancel',
        'Stop the download after the current file'
      );
      appendSelectionToolbarButton(
        wrap,
        'grok-retry-download-btn',
        'Retry failed',
        'Download the files the last run did not finish'
      );
    }

    document.querySelectorAll('.grok-delete-selected-btn').forEach(btn => {
      if (btn.dataset.grokDeleteSelectedBound) return;
      btn.dataset.grokDeleteSelectedBound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        deleteSelectedPosts();
      });
    });
    document.querySelectorAll('.grok-cancel-download-btn').forEach(btn => {
      if (btn.dataset.grokCancelDownloadBound) return;
      btn.dataset.grokCancelDownloadBound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        cancelBulkDownload();
      });
    });
    document.querySelectorAll('.grok-retry-download-btn').forEach(btn => {
      if (btn.dataset.grokRetryDownloadBound) return;
      btn.dataset.grokRetryDownloadBound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        retryFailedDownloads();
      });
    });

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
    // Selections outlive the active filter, so "Check all" has to look at how many of the
    // *current* matches are selected — the overall count can equal `total` by coincidence.
    let matchedSelected = 0;
    if (count > 0) {
      for (const p of matchedPosts) if (selectedPostIds.has(p.id)) matchedSelected++;
    }
    const busy = bulkDownloadInProgress;
    document.querySelectorAll('.grok-download-selected-btn').forEach(btn => {
      btn.disabled = count === 0 || busy;
      btn.textContent = count > 0 ? `Download selected (${count})` : 'Download selected';
      btn.title = count > 0
        ? `Download ${count} selected image${count === 1 ? '' : 's'} to a folder`
        : 'Download selected images to a folder';
    });
    document.querySelectorAll('.grok-check-all-btn').forEach(btn => {
      btn.disabled = busy || total === 0 || matchedSelected === total;
    });
    document.querySelectorAll('.grok-clear-selection-btn').forEach(btn => {
      btn.disabled = busy || count === 0;
    });
    document.querySelectorAll('.grok-delete-selected-btn').forEach(btn => {
      btn.disabled = count === 0 || busy || deleteInProgress;
      btn.textContent = count > 0 ? `Delete selected (${count})` : 'Delete selected';
    });
    document.querySelectorAll('.grok-cancel-download-btn').forEach(btn => {
      btn.hidden = !busy;
      btn.disabled = !busy || bulkDownloadCancelled;
      btn.textContent = bulkDownloadCancelled ? 'Cancelling…' : 'Cancel';
    });
    const pending = lastFailedDownloads.length;
    document.querySelectorAll('.grok-retry-download-btn').forEach(btn => {
      btn.hidden = pending === 0;
      btn.disabled = busy || pending === 0;
      btn.textContent = `Retry ${pending} file${pending === 1 ? '' : 's'}`;
      btn.title = `Download the ${pending} file${pending === 1 ? '' : 's'} the last run did not finish`;
    });
  }

  function ensureImportJsonButton() {
    if (document.getElementById('grok-import-json-btn')) return;
    const actions = getActionsRow();
    if (!actions) return;
    const input = document.createElement('input');
    input.id = 'grok-import-json-input';
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) importDatabaseJson(file);
    });

    const btn = document.createElement('button');
    btn.id = 'grok-import-json-btn';
    btn.className = 'grok-toolbar-btn';
    btn.type = 'button';
    btn.textContent = 'Import JSON';
    btn.title = 'Merge a previously exported index file into the local database';
    btn.addEventListener('click', () => input.click());

    actions.prepend(input);
    actions.prepend(btn);
  }

  function ensureVerifyButton() {
    if (document.getElementById('grok-verify-btn')) return;
    const actions = getActionsRow();
    if (!actions) return;
    const btn = document.createElement('button');
    btn.id = 'grok-verify-btn';
    btn.className = 'grok-toolbar-btn';
    btn.type = 'button';
    btn.textContent = 'Verify';
    btn.title = 'Walk the whole liked feed and reconcile the index: '
      + 'removes posts you have unliked and adds posts liked after they were created';
    btn.addEventListener('click', () => runReconcile({ manual: true }));
    actions.appendChild(btn);
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

  /**
   * Collapsing forces `resultsOnly` off at runtime so Grok's own page is left alone, and
   * expanding restores the user's choice from storage.
   *
   * The forced value must never be written back. It used to be: this function saved
   * `resultsOnly` before clearing it, and `ensureSearchBarToggle()` calls it on every init --
   * including the re-inits an SPA navigation triggers. So the first collapse stored the real
   * preference, and the next init, with `resultsOnly` already forced to false, overwrote it
   * with '0'. Expanding then restored that '0' and *Results only* stayed off for good, which
   * left the script rendering nothing until a filter was typed.
   *
   * Only the checkbox handler writes RESULTS_ONLY_KEY, because only a click is a preference.
   */
  function setSearchBarExpanded(expanded) {
    searchBarExpanded = expanded;
    if (!expanded) {
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
        position: fixed; top: 70px; right: 16px; z-index: 100005;
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
      /* The corner is a class so the preference survives both copies of this stylesheet.
         Every rule resets the opposite pair, or a stale offset keeps the old corner alive.

         The top corners clear Grok's own header rather than starting at 16px: measured on
         grok.com/imagine/saved, its Select button ends at x2323 and its search button occupies
         x2331-2371 at y13-53, so a 44px button at top:16px lands exactly on top of the search
         control. 70px puts it under the whole header row and over nothing but the grid. */
      #grok-search-toggle.grok-toggle-tr { top: 70px; right: 16px; bottom: auto; left: auto; }
      #grok-search-toggle.grok-toggle-br { top: auto; right: 16px; bottom: 16px; left: auto; }
      #grok-search-toggle.grok-toggle-tl { top: 70px; right: auto; bottom: auto; left: 16px; }
      #grok-search-toggle.grok-toggle-bl { top: auto; right: auto; bottom: 16px; left: 16px; }
      /* The bar is min(900px, 92vw) and centred, so below ~1040px its right edge reaches the
         button and a top corner would sit on the toolbar. Drop to the bottom there. */
      @media (max-width: 1040px) {
        #grok-search-toggle.grok-toggle-tr,
        #grok-search-toggle.grok-toggle-tl { top: auto; bottom: 16px; }
      }
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
    // Outside the guard on purpose: an SPA re-init finds the button already there, and the
    // corner class still has to be on it.
    togglePosition = readStoredTogglePosition();
    applyTogglePosition(togglePosition, false);
    searchBarExpanded = readSearchBarExpandedFromStorage();
    setSearchBarExpanded(searchBarExpanded);
  }

  /**
   * Every control that is injected rather than written into the `buildSearchBar()` template.
   *
   * Both build paths must run this. They used to have separate lists, and the fresh-build path
   * was missing `ensureImportJsonButton()` and `ensureVerifyButton()` -- neither of which is in
   * the template -- so **Import JSON** and **Verify** only ever appeared for users whose browser
   * still had an older bar in the DOM to migrate. A clean install silently had no way to run a
   * reconciliation sweep at all.
   *
   * Adding a control to the template is therefore not enough on its own; add its `ensure*` here.
   * Each one is create-or-return, so calling them on both paths is free.
   */
  function ensureSearchBarParts() {
    ensurePageJumpInput();
    ensureImportJsonButton();
    ensureExportJsonButton();
    ensureVerifyButton();
    ensureReindexButton();
    ensureMediaFilterCheckboxes();
    ensureLikedFilterCheckbox();
    ensureModelFilterSelect();
    ensureDisplayControls();
    ensureDateNavButtons();
    ensureSearchBarToggle();
    ensureDownloadResultsButtons();
    ensureDownloadSelectedButtons();
    ensureLoadingIndicator();
    ensureSearchInputListener();
  }

  function buildSearchBar() {
    if (document.getElementById('grok-search-wrap')) {
      migrateSearchBarLayout();
      ensureSearchBarParts();
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
            <label id="grok-filter-video-only-label" class="grok-filter-check-label" title="Show only video posts (hide images)">
              <input type="checkbox" id="grok-filter-video-only" />
              Video only
            </label>
            <label id="grok-filter-with-video-label" class="grok-filter-check-label" title="Show image posts that have video in child results">
              <input type="checkbox" id="grok-filter-with-video" />
              With video
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
    const filterChildrenEl = document.getElementById('grok-filter-children');
    const firstBtn = document.getElementById('grok-page-first');
    const pageJumpEl = ensurePageJumpInput();

    try {
      loadVideoFiltersFromStorage();
      filterOnlyChildren = localStorage.getItem(FILTER_CHILDREN_KEY) === '1';
      loadHideChildsFilterFromStorage();
      loadModelFilterFromStorage();
      loadLikedFilterFromStorage();
      currentSort = localStorage.getItem(SORT_KEY) === 'oldest' ? 'oldest' : 'newest';
      filterMinChildren = parseMediaMin(localStorage.getItem(FILTER_CHILDREN_MIN_KEY));
      pageSize = clampPageSize(localStorage.getItem(PAGE_SIZE_KEY));
      gridSizePercent = clampGridSizePercent(localStorage.getItem(GRID_SIZE_PCT_KEY));
    } catch { /* ignore */ }
    syncMediaMinSelects();
    // The same chain the migration path runs -- see ensureSearchBarParts().
    ensureSearchBarParts();
    if (sortSel) sortSel.value = currentSort;
    bindDisplayControlListeners();
    bindMediaFilterListeners();
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
      filterVideoOnly = false;
      filterWithVideo = false;
      filterOnlyChildren = false;
      filterHideChilds = false;
      filterMinChildren = 1;
      filterModel = '';
      filterLikedOnly = false;
      const likedEl = document.getElementById('grok-filter-liked');
      if (likedEl) likedEl.checked = false;
      syncMediaMinSelects();
      const modelSel = document.getElementById('grok-filter-model');
      if (modelSel) modelSel.value = '';
      try {
        localStorage.setItem(FILTER_VIDEO_ONLY_KEY, '0');
        localStorage.setItem(FILTER_WITH_VIDEO_KEY, '0');
        localStorage.setItem(FILTER_CHILDREN_KEY, '0');
        localStorage.setItem(FILTER_HIDE_CHILDS_KEY, '0');
        localStorage.setItem(FILTER_CHILDREN_MIN_KEY, '1');
        localStorage.setItem(FILTER_MODEL_KEY, '');
        localStorage.setItem(FILTER_LIKED_KEY, '0');
      } catch { /* ignore */ }
      currentPage = 0;
      updateClearButton();
      applyFilter();
      input.focus();
    });

    sortSel.addEventListener('change', () => {
      currentSort = sortSel.value; currentPage = 0;
      writeStoredString(SORT_KEY, currentSort);
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
      const bulkConfirmOpen = (() => {
        const dlg = document.getElementById('grok-bulk-download-confirm');
        return Boolean(dlg && !dlg.hidden);
      })();
      if (
        shouldShowSearchResults()
        && !typingInSearch
        && !typingInPageJump
        && !isResultLightboxOpen()
        && !bulkConfirmOpen
      ) {
        if (e.key === 'ArrowRight') { e.preventDefault(); currentPage++; showResults(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); currentPage--; showResults(); }
      }
    });
  }

  let initiated = false;
  function init() {
    if (!isImagineListPage()) return;
    // Published so the running version can be read from the page. Without it, telling a stale
    // Tampermonkey install apart from a bug that survived a fix means guessing from CSS.
    try { document.documentElement.dataset.grokSearchVersion = SCRIPT_VERSION; } catch { /* ignore */ }
    if (initiated && document.getElementById('grok-search-wrap')) {
      ensureSearchBarToggle();
      syncInitialResultsView();
      if (!loaded && !indexing) loadAllPosts();
      return;
    }
    if (initiated) {
      if (!document.getElementById('grok-search-wrap')) {
        buildSearchBar();
      } else {
        ensureSearchBarToggle();
      }
      return;
    }
    initiated = true;
    injectStyles();
    requestPersistentStorage();
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
    if (isImagineListPage()) {
      if (!document.getElementById('grok-search-wrap')) {
        buildSearchBar();
      } else if (!document.getElementById('grok-search-toggle')) {
        ensureSearchBarToggle();
      }
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