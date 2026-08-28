'use strict';

/**
 * The userscript is one big IIFE with no exports — it cannot be require()d, and it cannot run
 * outside a logged-in grok.com page. So the harness slices the pure-logic regions out of the
 * source, evaluates them with stubbed collaborators, and hands the functions back.
 *
 * Nothing here duplicates production logic: every assertion runs the real code from
 * grokSearch.user.js. If a region marker stops matching, the slice throws with the marker name
 * rather than failing somewhere confusing later.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', 'grokSearch.user.js');

function readSource() {
  return fs.readFileSync(SOURCE_PATH, 'utf8').replace(/\r\n/g, '\n');
}

/** Text from `startMarker` up to the next occurrence of `endMarker`. */
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`harness: start marker not found in grokSearch.user.js: ${JSON.stringify(startMarker)}`);
  }
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`harness: end marker not found after start: ${JSON.stringify(endMarker)}`);
  }
  return src.slice(start, end);
}

/**
 * Record parsing, index maintenance, child sync, deep-refresh selection, and reconciliation.
 * Ends before formatSyncStatusMessage, which is where the UI-coupled code begins.
 */
function createIndexSandbox() {
  const region = sliceBetween(readSource(), '  function isVideoMediaType', '  function formatSyncStatusMessage');

  const prelude = `
    const METADATA_REFRESH_KEY = 'metadataRefreshedAt';
    const SYNC_DEEP_REFRESH_TTL_MS = 10 * 60 * 1000;
    const SYNC_DEEP_REFRESH_LIMIT = 24;
    const SYNC_DEEP_CHILDLESS_SLOTS = 8;
    const SYNC_DEEP_CONCURRENCY = 5;
    const SYNC_LIST_REFRESH_PAGES = 4;
    const SYNC_LIST_PAGE_DELAY_MS = 0;
    const FULL_INDEX_MAX_PAGES = 2000;
    const RECONCILE_MAX_DELETE_RATIO = 0.5;
    const RECONCILE_LAST_RUN_KEY = 'grokSearchLastReconcileAt';
    const ASSETS_MAX_PAGES = 2000;
    const ASSETS_ENDPOINT = 'https://grok.com/rest/assets';
    const ASSETS_WORKSPACE = 'WORKSPACE_KIND_IMAGINE_ALL';
    const ASSETS_PAGE_SIZE = 60;
    const ASSET_CDN_BASE = 'https://assets.grok.com/';
    const ASSETS_SYNC_STALE_PAGES = 3;
    const LIKED_BOOLEAN_FIELDS = ['likeStatus','isLiked','liked','hasLiked','isFavorite','isFavorited','favorited','likedByUser','isLikedByUser','userLiked','viewerHasLiked'];
    const LIKED_CONTAINER_FIELDS = ['userInteractionStatus','viewerState','viewer','interaction','interactions','userState','state'];

    let allPosts = [];
    const postById = new Map();
    const knownIds = new Set();
    const selectedPostIds = new Set();
    // updatePostRow() clears this when a row is re-parented; without it declared here the
    // assignment would silently create a global instead of being caught.
    let childrenByParentSource = null;

    // ── stubs for collaborators defined outside the sliced region ──
    const dbCalls = { put: 0, del: 0, putRows: 0, delRows: 0 };
    const storage = {};
    let feedPages = [];

    const sleep = () => Promise.resolve();
    function setLoadStatus() {}
    function writeStoredString(key, value) { storage[key] = value; }
    function readStoredString(key, fallback = '') {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : fallback;
    }
    function byCreatedDesc(a, b) { return (b._ms ?? 0) - (a._ms ?? 0); }
    function sortAllPostsNewestFirst() { allPosts.sort(byCreatedDesc); }

    // toStorageRecord() is applied so the tests fail if a runtime-only field ever leaks.
    async function dbPutMany(rows) {
      dbCalls.put++; dbCalls.putRows += rows.length;
      for (const r of rows) toStorageRecord(r);
    }
    async function dbDeleteMany(ids) { dbCalls.del++; dbCalls.delRows += ids.length; }

    /**
     * Canned asset-feed pages: [{ assets: [...] } | { fail: true }, ...]. Stubbed at the
     * transport, so the real fetchAssetPage() and its URL building are what run.
     */
    let assetPages = [];
    function GM_xmlhttpRequest(opts) {
      const token = new URL(opts.url).searchParams.get('pageToken');
      const i = token ? Number(token) : 0;
      const page = assetPages[i];
      queueMicrotask(() => {
        if (page && page.fail) { opts.onload({ status: 500, responseText: '' }); return; }
        opts.onload({ status: 200, responseText: JSON.stringify({
          assets: page ? page.assets : [],
          nextPageToken: page && i + 1 < assetPages.length ? String(i + 1) : null,
        }) });
      });
      return { abort() {} };
    }

    /** Canned liked-feed pages: [{ posts: [...] } | { fail: true }, ...] */
    async function fetchPage(cursor) {
      const i = cursor ? Number(cursor) : 0;
      const page = feedPages[i];
      if (!page) return { ok: true, posts: [], nextCursor: null };
      if (page.fail) return { ok: false, status: 429 };
      return { ok: true, posts: page.posts, nextCursor: i + 1 < feedPages.length ? String(i + 1) : null };
    }
  `;

  const epilogue = `
    return {
      get allPosts() { return allPosts; },
      postById, knownIds, selectedPostIds, dbCalls, storage,
      setFeedPages(pages) { feedPages = pages; },
      setAssetPages(pages) { assetPages = pages; },
      get indexRevision() { return indexRevision; },
      toStorageRecord, normalizePost, addPostRow, updatePostRow, rebuildPostIndex,
      createIndexWriter, collectChildRecords, syncChildRecordsForParent,
      propagateParentPromptToChildren, backfillChildParentPrompts,
      parsePost, parseChildPost, getSearchablePromptText, postMetadataChanged,
      postNeedsDeepRefresh, postHasKnownChildren, stampMetadataRefreshed, detectLikedState,
      pickDeepRefreshTargets, removeRowsById, reconcileLikedIndex, verifyIndexIntegrity,
      getRootIdOf, removeDescendantsOfRoot, buildPromptById, computeSearchText,
      buildAssetsUrl, fetchAssetPage, assetMediaUrl, assetGenInput, assetMediaType,
      parseAsset, syncAssetsFeed, isIndexableAsset,
    };
  `;

  return new Function(`${prelude}\n${region}\n${epilogue}`)();
}

/**
 * The image-metadata writers: EXIF assembly, PNG text chunks, and the WebP RIFF rebuild.
 * `piexif` is a stub — the real library is a jsDelivr `@require` and is not installable here —
 * so the JPEG path is only checked for *how* it calls piexif, while the PNG and WebP container
 * work, which is all hand-rolled, is verified byte for byte.
 */
function createMetadataSandbox({ piexif } = {}) {
  const region = sliceBetween(readSource(), '  const PNG_CRC_TABLE', '  function isDownloadableImagePost');

  const prelude = `
    const SCRIPT_VERSION = '0.0.0-test';
    const METADATA_PROMPT_MAX = 4000;
    const VIDEO_TYPES = ['MEDIA_POST_TYPE_VIDEO'];
    function isVideoMediaType(t) { return VIDEO_TYPES.includes(String(t || '')); }
    function getPostDetailUrl(id) { return id ? 'https://grok.com/imagine/post/' + id : ''; }
  `;

  const epilogue = `
    return {
      pngCrc32, isJpegBytes, isPngBytes, isWebpBytes,
      truncateMetadataText, toAsciiText, toAsciiJson,
      formatExifDateTime, formatPngCreationTime, ucs2Bytes,
      buildPostMetadata, buildExifDicts, dumpExifSegment, buildTiffExifBytes,
      embedMetadataInJpeg,
      buildPngChunk, buildPngTextChunk, buildPngITxtChunk, isLatin1Text,
      pngMetadataChunks, pngHeaderEnd, embedMetadataInPng,
      readRiffChunks, buildRiffChunk, readWebpCanvasSize, webpHasAlpha,
      buildXmpPacket, embedMetadataInWebp, embedMetadataInImageBlob,
    };
  `;

  return new Function('piexif', `${prelude}\n${region}\n${epilogue}`)(piexif);
}

/**
 * Media fetching and the per-file retry, with the network stubbed. `control` drives the
 * stubs: `fetchResults` / `gmResults` are consumed one per attempt, so a test can say
 * "fail twice, then succeed" and assert on how many attempts actually happened.
 */
function createDownloadSandbox(control = {}) {
  const src = readSource();
  const region = sliceBetween(src, '  function makeAbortError', '  const PNG_CRC_TABLE')
    + sliceBetween(src, '  function isDownloadableImagePost', '  function downloadPostMedia');

  const prelude = `
    const DOWNLOAD_MAX_ATTEMPTS = control.maxAttempts ?? 3;
    const DOWNLOAD_RETRY_BASE_MS = 0;
    const log = { fetches: [], gm: [], sleeps: 0, embeds: 0, aborted: 0 };

    const sleep = () => { log.sleeps++; return Promise.resolve(); };
    function isVideoMediaType(t) { return String(t || '').includes('VIDEO'); }
    function getPostMediaUrl(post) { return post?.mediaUrl || ''; }
    async function embedMetadataInImageBlob(blob) { log.embeds++; return blob; }

    const nextResult = list => (list && list.length ? list.shift() : { ok: true });

    function getPageWindow() {
      return {
        fetch(url, init) {
          log.fetches.push(url);
          const r = nextResult(control.fetchResults);
          if (init?.signal?.aborted) return Promise.reject(makeAbortError());
          if (r.abort) return Promise.reject(makeAbortError());
          if (r.throw) return Promise.reject(new Error(r.throw));
          if (r.status && r.status >= 400) return Promise.resolve({ ok: false, status: r.status });
          return Promise.resolve({ ok: true, blob: async () => new Blob(['image']) });
        },
      };
    }

    function GM_xmlhttpRequest(opts) {
      log.gm.push(opts.url);
      const r = nextResult(control.gmResults);
      const handle = { abort() { log.aborted++; opts.onabort?.(); } };
      queueMicrotask(() => {
        if (r.hang) return;
        if (r.error) opts.onerror?.();
        else if (r.timeout) opts.ontimeout?.();
        else opts.onload?.({ status: r.status ?? 200, response: new ArrayBuffer(4), responseHeaders: 'content-type: image/webp' });
      });
      return handle;
    }
  `;

  const epilogue = `
    return {
      log, makeAbortError, isAbortError, fetchPostMediaBlob, fetchPostMediaBlobGm,
      isDownloadableImagePost, prepareDownloadBlob, prepareDownloadBlobWithRetry,
    };
  `;

  return new Function('control', `${prelude}\n${region}\n${epilogue}`)(control);
}

/**
 * The bulk-download loop itself — cancel, per-run bookkeeping, and retry — with the folder
 * picker, the File System Access writes, and the per-file fetch all stubbed.
 */
function createBulkDownloadSandbox(control = {}) {
  const region = sliceBetween(readSource(), '  function cancelBulkDownload', '  async function downloadSelectedPosts');

  const prelude = `
    const BULK_DOWNLOAD_CONFIRM_ABOVE = 5;
    let bulkDownloadInProgress = false;
    let bulkDownloadCancelled = false;
    let bulkDownloadAbort = null;
    let lastFailedDownloads = [];
    let lastDownloadDirHandle = null;

    const log = { statuses: [], saved: [], confirms: 0, picks: 0, syncs: 0, permissionChecks: 0 };
    const failNames = new Set(control.saveFails || []);

    function setDownloadStatus(text) { log.statuses.push(text); }
    function syncDownloadSelectedButtons() { log.syncs++; }
    function getPostDownloadFilename(p) { return p.noFilename ? '' : p.id + '.jpg'; }
    async function confirmBulkDownload() { log.confirms++; return control.confirm !== false; }
    async function pickDownloadFolder() {
      log.picks++;
      if (control.pickerError) throw control.pickerError;
      return { handle: 'picked' };
    }
    async function ensureDirWritePermission() { log.permissionChecks++; }
    async function saveBlobToFolder(dir, filename) {
      if (failNames.has(filename)) throw new Error('save failed');
      log.saved.push(filename);
    }
    async function prepareDownloadBlobWithRetry(post, signal) {
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      await control.beforeEach?.(post);
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if ((control.fetchFails || []).includes(post.id)) throw new Error('fetch failed');
      return new Blob(['image']);
    }
    function isAbortError(err) { return err?.name === 'AbortError'; }
  `;

  const epilogue = `
    return {
      log,
      cancelBulkDownload, clearFailedDownloads, downloadPostsToFolder, retryFailedDownloads,
      get failed() { return lastFailedDownloads; },
      get dirHandle() { return lastDownloadDirHandle; },
      get busy() { return bulkDownloadInProgress; },
    };
  `;

  return new Function('control', `${prelude}\n${region}\n${epilogue}`)(control);
}

/**
 * The feed request layer: the captured-template path, response extraction, and the source probe.
 * `control.responses` maps a source name (or '(none)') to the posts that candidate returns, so a
 * test can describe a deployment where, say, only the liked source works.
 */
function createFeedSandbox(control = {}) {
  const src = readSource();
  const region = sliceBetween(src, '  /** Writes `value` at a dotted/array path', '  function buildLikeRequest')
    + sliceBetween(src, '  function readListTemplate', '  function isVideoMediaType');

  const prelude = `
    const LIST_REQUEST_KEY = 'grokSearchListRequest';
    const ENDPOINT = 'https://grok.com/rest/media/post/list';
    const MEDIA_SOURCE_LIKED = 'MEDIA_POST_SOURCE_LIKED';
    const MEDIA_SOURCE_KEY = 'grokSearchMediaSource';
    const MEDIA_SOURCE_PROBED_KEY = 'grokSearchMediaSourceProbedAt';
    const MEDIA_SOURCE_REPROBE_MS = 7 * 24 * 60 * 60 * 1000;
    const PROBE_SAMPLE_SIZE = 50;
    const MEDIA_SOURCE_CANDIDATES = control.candidates || [
      null, 'MEDIA_POST_SOURCE_ALL', 'MEDIA_POST_SOURCE_HISTORY', MEDIA_SOURCE_LIKED,
    ];

    let mediaSource = MEDIA_SOURCE_LIKED;
    let mediaSourceResolved = false;

    const store = Object.assign({}, control.storage);
    const log = { requests: [], statuses: [], warnings: [] };

    const localStorage = {
      getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    };
    const readStoredString = (k, fallback = '') => (localStorage.getItem(k) ?? fallback);
    const writeStoredString = (k, v) => localStorage.setItem(k, v);
    const sleep = () => Promise.resolve();
    const setLoadStatus = t => { log.statuses.push(t); };
    const document = { getElementById: () => null };
    const console = {
      log: () => {},
      warn: m => { log.warnings.push(String(m)); },
      error: () => {},
    };

    /** Answers from control.responses, keyed by the source the body actually carries. */
    async function postJsonWithRetry(url, body, label, headers) {
      log.requests.push({ url, body, label, headers });
      if (control.respond) return control.respond({ url, body, label });
      const source = body?.filter?.source ?? null;
      const key = source === null ? '(none)' : source;
      const posts = (control.responses || {})[key];
      if (posts === undefined) return { ok: false, status: 400 };
      return { ok: true, data: { posts, nextCursor: null } };
    }
  `;

  const epilogue = `
    return {
      log, store,
      get mediaSource() { return mediaSource; },
      setMediaSource(v) { mediaSource = v; mediaSourceResolved = true; },
      readListTemplate, hasCapturedListRequest, deleteAtPath, setAtPath,
      buildListBody, extractListPage, fetchPage,
      newestCreateTimeOf, idsOf, probeMediaSource, resolveMediaSource, warnIfLikesOnly,
    };
  `;

  return new Function('control', `${prelude}\n${region}\n${epilogue}`)(control);
}

/**
 * Hiding and restoring Grok's own grid, against the attribute-aware fake DOM. The point of the
 * sandbox is that the "find the element" stubs can be made to return null after hiding, which is
 * what React does to the masonry cards and what used to leave the page blank until a reload.
 */
function createNativeVisibilitySandbox({ document, grid = null, root = null }) {
  const region = sliceBetween(readSource(), "  const HID_GRID_ATTR", '  function updateDisplayMode');

  const prelude = `
    let resultsOnly = true;
    let showResults = true;
    const lookups = { grid, root };
    function getGrokGrid() { return lookups.grid; }
    function getNativeSavedRoot() { return lookups.root; }
    function shouldShowSearchResults() { return showResults; }
  `;

  const epilogue = `
    return {
      lookups,
      setState(next) {
        if ('resultsOnly' in next) resultsOnly = next.resultsOnly;
        if ('showResults' in next) showResults = next.showResults;
      },
      setNativeGridVisible, setNativeSavedRootVisible, applyNativeVisibility,
      HID_GRID_ATTR, HID_ROOT_ATTR,
    };
  `;

  return new Function('document', 'grid', 'root', `${prelude}\n${region}\n${epilogue}`)(document, grid, root);
}

/**
 * Collapsing and expanding the search bar, which owns the *Results only* preference. The DOM is
 * stubbed away entirely; what matters here is which writes reach storage.
 */
function createSearchBarSandbox(storage = {}) {
  const src = readSource();
  const region = sliceBetween(src, '  function getStoredResultsOnly', '  function syncResultsOnlyCheckbox')
    + sliceBetween(src, '  function setSearchBarExpanded(', '  function patchSearchBarCollapseStyles');

  const prelude = `
    const RESULTS_ONLY_KEY = 'grokSearchResultsOnly';
    const SEARCH_BAR_COLLAPSED_KEY = 'grokSearchBarCollapsed';
    const store = Object.assign({}, storage);
    const log = { forced: [], hides: 0, nativeApplies: 0 };

    let resultsOnly = true;
    let searchBarExpanded = true;

    const localStorage = {
      getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
    function setResultsOnlyEnabled(v) { resultsOnly = Boolean(v); log.forced.push(resultsOnly); }
    function hideAllSearchResults() { log.hides++; }
    function applyNativeVisibility() { log.nativeApplies++; }
    const document = { getElementById: () => null };
  `;

  const epilogue = `
    return {
      store, log, setSearchBarExpanded, getStoredResultsOnly,
      get resultsOnly() { return resultsOnly; },
      get searchBarExpanded() { return searchBarExpanded; },
      setResultsOnly(v) { resultsOnly = Boolean(v); },
    };
  `;

  return new Function('storage', `${prelude}
${region}
${epilogue}`)(storage);
}

/**
 * Deleting, which is the only feature that destroys the user's media. The network and the
 * confirmation are stubbed; what is under test is the orchestration -- that nothing is removed
 * from the index unless the server accepted it, and that nothing happens at all without consent.
 */
function createDeleteSandbox(control = {}) {
  const region = sliceBetween(readSource(),
    '  async function deleteRemotePost', '  async function downloadSelectedPosts');

  const prelude = `
    const POST_DELETE = 'https://grok.com/rest/media/post/delete';
    const log = { requests: [], statuses: [], removed: [], confirms: [], flushes: 0, filters: 0 };

    async function postJsonWithRetry(url, body, label) {
      log.requests.push({ url, id: body && body.id, label });
      const r = (control.responses || {})[body && body.id];
      return r || { ok: true };
    }
    async function confirmDangerousAction(opts) {
      log.confirms.push(opts);
      return control.confirm !== false;
    }
    function setDownloadStatus(t) { log.statuses.push(t); }
    function syncDownloadSelectedButtons() {}
    function applyFilter() { log.filters++; }
    function createIndexWriter() {
      return { put() {}, del() {}, async flush() { log.flushes++; return 0; } };
    }
    function removeRowsById(ids) { log.removed.push(...ids); return ids.length; }
    function getSelectedPostsInOrder() { return control.selected || []; }
  `;

  const epilogue = `
    return { log, deleteRemotePost, deletePosts, deleteSelectedPosts, deleteSinglePost,
             get busy() { return deleteInProgress; } };
  `;

  return new Function('control', `${prelude}
${region}
${epilogue}`)(control);
}

/** The like/unlike request templating helpers (no network, pure shaping). */
function createLikeSandbox(control = {}) {
  const src = readSource();
  const region = sliceBetween(src, '  /** Writes `value` at a dotted/array path', '  function sendTemplatedLikeRequest')
    + sliceBetween(src, '  let likedCollectionId = null;', '  /** Optimistic toggle');

  const prelude = `
    const COLLECTION_LIST = 'https://grok.com/rest/media/collection/list';
    const COLLECTION_ADD = 'https://grok.com/rest/media/collection/assets/add';
    const COLLECTION_REMOVE = 'https://grok.com/rest/media/collection/assets/remove';
    const LIKED_COLLECTION_KEY = 'grokSearchLikedCollectionId';
    const store = Object.assign({}, control.storage);
    const log = { requests: [], warnings: [] };

    const readStoredString = (k, d = '') => (k in store ? store[k] : d);
    const writeStoredString = (k, v) => { store[k] = String(v); };
    function readLikeTemplate() { return control.template || null; }
    function sendTemplatedLikeRequest(tpl, id, liked) {
      log.requests.push({ templated: true, url: tpl.url, id, liked });
      return Promise.resolve({ ok: true, status: 200 });
    }
    async function postJsonWithRetry(url, body, label) {
      log.requests.push({ url, body, label });
      if (url === COLLECTION_LIST) {
        return control.collections === null
          ? { ok: false, status: 500 }
          : { ok: true, data: { collections: control.collections
              || [{ id: 'liked-1', name: 'Liked', isDefault: true }] } };
      }
      return control.mutate || { ok: true, data: { addedCount: 1, removedCount: 1 } };
    }
    const console = { log() {}, warn: m => log.warnings.push(String(m)), error() {} };
  `;

  const epilogue = `
    return { setAtPath, buildLikeRequest, pickLikedCollection,
             resolveLikedCollectionId, sendLikeRequest, log, store };
  `;

  return new Function('control', `${prelude}
${region}
${epilogue}`)(control);
}

/** The keyed results-grid reconciler, driven against the fake DOM in ./dom.js. */
/**
 * Compact grouping: what the grid pages over once children are folded into their parents.
 *
 * The whole point of the feature is that `matchedPosts` is left alone -- selection, download,
 * delete and the lightbox all still see the flat list -- so the tests here check the *entries*
 * and never assume a post moved.
 */
function createCompactSandbox({ posts = [], compact = false, index = null } = {}) {
  const region = sliceBetween(readSource(),
    '  function buildDisplayEntries() {', '  function getPageSize()');

  const prelude = `
    let matchedPosts = posts.slice();
    let compactGroups = Boolean(compact);
    let displayEntries = [];
    let displayEntriesSource = null;
    let displayEntriesSignature = '';
    let pageSize = 10;
    const byId = new Map((index || posts).map(p => [p.id, p]));

    function isChildPost(post) { return Boolean(post && post.isChild); }
    function getPostById(id) { return byId.get(id) || null; }
    function getPageSize() { return pageSize; }
  `;

  const epilogue = `
    return {
      buildDisplayEntries, getDisplayEntries, invalidateDisplayEntries, getTotalPages,
      getDisplayCount, getDisplayPage,
      get matchedPosts() { return matchedPosts; },
      setCompact(v) { compactGroups = Boolean(v); invalidateDisplayEntries(); },
      setPageSize(v) { pageSize = v; },
      setMatched(list) { matchedPosts = list.slice(); invalidateDisplayEntries(); },
      mutateMatchedInPlace(fn) { fn(matchedPosts); },
    };
  `;

  return new Function('posts', 'compact', 'index', `${prelude}
${region}
${epilogue}`)(posts, compact, index);
}

/**
 * The thumbnail swap. Its whole reason for existing is a defect that only shows up on the
 * *second* render of a card, so the tests drive it the way paging does: same element, new post.
 */
function createCardImageSandbox({ createElement }) {
  // Sliced from imageAltText() so the alt cap is the real one, not a stub: the two are a
  // single defence against a broken image sizing itself to its prompt.
  const region = sliceBetween(readSource(),
    '  function imageAltText(', '  /** Skeleton built once per card');
  const prelude = `
    const IMAGE_ALT_MAX = 140;
    const document = { createElement: name => createElement(name) };
  `;
  return new Function('createElement', `${prelude}
${region}
return { syncCardImage, imageAltText };`)(createElement);
}

/**
 * Which page the reader is on. The rule under test is that only a change of *mode* moves it --
 * an SPA re-init calls setResultsOnlyEnabled() with the value it already has.
 */
function createResultsOnlySandbox({ resultsOnly = true, currentPage = 0, loaded = true } = {}) {
  const region = sliceBetween(readSource(),
    '  function setResultsOnlyEnabled(', '  function updateResultsOnlyLayout(');

  const prelude = `
    const log = { checkbox: 0, layout: 0, filters: 0, enforce: 0, native: 0, loading: 0 };
    function syncResultsOnlyCheckbox() { log.checkbox++; }
    function updateResultsOnlyLayout() { log.layout++; }
    function applyNativeVisibility() { log.native++; }
    function showLoadingIndicator() { log.loading++; }
    function applyFilter() { log.filters++; }
    function scheduleEnforceDisplay() { log.enforce++; }
  `;

  const epilogue = `
    return {
      log, setResultsOnlyEnabled,
      get resultsOnly() { return resultsOnly; },
      get currentPage() { return currentPage; },
      setCurrentPage(n) { currentPage = n; },
    };
  `;

  return new Function('resultsOnly', 'currentPage', 'loaded', `${prelude}
${region}
${epilogue}`)(resultsOnly, currentPage, loaded);
}

function createGridSandbox({ createElement, onRender }) {
  const src = readSource();
  // The end marker has to be looked for past renderResultCards' own declaration, otherwise the
  // slice stops at the function it is meant to capture.
  const decl = '  function renderResultCards(';
  const declAt = src.indexOf(decl);
  if (declAt < 0) throw new Error('harness: renderResultCards not found in grokSearch.user.js');
  const region = sliceBetween(src.slice(declAt), decl, '\n  function ');

  const factory = new Function(
    'createResultCardElement',
    'renderResultCard',
    `${region}\nreturn renderResultCards;`
  );
  return factory(createElement, onRender);
}

module.exports = {
  SOURCE_PATH, readSource, sliceBetween,
  createIndexSandbox, createGridSandbox, createLikeSandbox, createMetadataSandbox,
  createCompactSandbox, createCardImageSandbox, createResultsOnlySandbox,
  createDownloadSandbox, createBulkDownloadSandbox,
  createFeedSandbox, createNativeVisibilitySandbox, createSearchBarSandbox,
  createDeleteSandbox,
};
