'use strict';

/**
 * The userscript is one big IIFE with no exports — it cannot be require()d, and it cannot run
 * outside a logged-in grok.com page. So the harness slices the pure-logic regions out of the
 * source, evaluates them with stubbed collaborators, and hands the functions back.
 *
 * Nothing here duplicates production logic: every assertion runs the real code from
 * grokSearch.js. If a region marker stops matching, the slice throws with the marker name
 * rather than failing somewhere confusing later.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', 'grokSearch.js');

function readSource() {
  return fs.readFileSync(SOURCE_PATH, 'utf8');
}

/** Text from `startMarker` up to the next occurrence of `endMarker`. */
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`harness: start marker not found in grokSearch.js: ${JSON.stringify(startMarker)}`);
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
    const LIKED_BOOLEAN_FIELDS = ['isLiked','liked','hasLiked','isFavorite','isFavorited','favorited','likedByUser','isLikedByUser','userLiked','viewerHasLiked'];
    const LIKED_CONTAINER_FIELDS = ['viewerState','viewer','interaction','interactions','userState','state'];

    let allPosts = [];
    const postById = new Map();
    const knownIds = new Set();
    const selectedPostIds = new Set();

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
      get indexRevision() { return indexRevision; },
      toStorageRecord, normalizePost, addPostRow, updatePostRow, rebuildPostIndex,
      createIndexWriter, collectChildRecords, syncChildRecordsForParent,
      propagateParentPromptToChildren, backfillChildParentPrompts,
      parsePost, parseChildPost, getSearchablePromptText, postMetadataChanged,
      postNeedsDeepRefresh, postHasKnownChildren, stampMetadataRefreshed, detectLikedState,
      pickDeepRefreshTargets, removeRowsById, reconcileLikedIndex, verifyIndexIntegrity,
      getRootIdOf, removeDescendantsOfRoot, buildPromptById, computeSearchText,
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

/** The like/unlike request templating helpers (no network, pure shaping). */
function createLikeSandbox() {
  const region = sliceBetween(readSource(), '  /** Writes `value` at a dotted/array path', '  function sendLikeRequest');
  return new Function(`${region}
return { setAtPath, buildLikeRequest };`)();
}

/** The keyed results-grid reconciler, driven against the fake DOM in ./dom.js. */
function createGridSandbox({ createElement, onRender }) {
  const src = readSource();
  // The end marker has to be looked for past renderResultCards' own declaration, otherwise the
  // slice stops at the function it is meant to capture.
  const decl = '  function renderResultCards(';
  const declAt = src.indexOf(decl);
  if (declAt < 0) throw new Error('harness: renderResultCards not found in grokSearch.js');
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
  createDownloadSandbox, createBulkDownloadSandbox,
};
