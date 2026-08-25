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
      postNeedsDeepRefresh, postHasKnownChildren, stampMetadataRefreshed,
      pickDeepRefreshTargets, removeRowsById, reconcileLikedIndex, verifyIndexIntegrity,
    };
  `;

  return new Function(`${prelude}\n${region}\n${epilogue}`)();
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

module.exports = { SOURCE_PATH, readSource, sliceBetween, createIndexSandbox, createGridSandbox };
