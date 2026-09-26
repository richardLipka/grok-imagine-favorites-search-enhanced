# Tests

```bash
node test/run.js
```

No dependencies, no build, no `package.json`. Add a name fragment to run a subset:

```bash
node test/run.js reconcile
```

Exit code is non-zero if anything fails.

## Why it works this way

`grokSearch.user.js` is a single IIFE with no exports. It cannot be `require()`d, and it cannot run
outside a logged-in `grok.com` page with Tampermonkey — which is exactly why the sync logic
was historically hard to verify and accumulated silent bugs.

So [`harness.js`](harness.js) **slices regions of text out of the real source** and evaluates
them with stubbed collaborators (`dbPutMany`, `fetchPage`, `setLoadStatus`, …). Every assertion
runs production code. Nothing here reimplements logic — a test that passed against a copy of
the algorithm would be worthless.

The sandboxes:

| Sandbox | Region | Covers |
|---------|--------|--------|
| `createIndexSandbox()` | `isRetryableStatus` → `gmRequestOnce`, plus `isVideoMediaType` → `formatSyncStatusMessage`, plus `fetchFullIndex` | Record shape, index mutation, child sync, tree edges, deep-refresh selection, the asset feed, reconciliation, the retry/backoff schedule, and whether a reindex may claim success |
| `createGridSandbox()` | `renderResultCards` | Keyed results-grid reconciliation, against the fake DOM in [`dom.js`](dom.js) |
| `createLikeSandbox()` | `setAtPath` → `sendLikeRequest` | Like/unlike request templating (pure shaping, no network) |
| `createMetadataSandbox()` | `PNG_CRC_TABLE` → `isDownloadableImagePost` | EXIF assembly, PNG text chunks, the WebP RIFF rebuild |
| `createDownloadSandbox()` | `makeAbortError` → `PNG_CRC_TABLE`, plus `isDownloadableImagePost` → `downloadPostMedia` | Media fetch, the GM fallback, per-file retry and abort |
| `createBulkDownloadSandbox()` | `cancelBulkDownload` → `downloadSelectedPosts` | The bulk loop: cancel, the failed queue, resuming into the same folder |
| `createFeedSandbox()` | `setAtPath` → `buildLikeRequest`, plus `readListTemplate` → `isVideoMediaType` | Captured-template replay, response-shape tolerance, source-probe ranking |
| `createNativeVisibilitySandbox()` | `HID_GRID_ATTR` → `updateDisplayMode` | Hiding and restoring Grok's own grid, against the attribute-aware fake DOM |
| `createThumbnailSandbox()` | `isVideoMediaType` → `matchesWithVideoFilter`, plus `getChildrenByParent` → `guessMediaExtension` | Image thumbnail resolution for video results, parent/root/child/conversation fallback |
| `createSearchBarSandbox()` | `getStoredResultsOnly` → `syncResultsOnlyCheckbox`, plus `setSearchBarExpanded` → `patchSearchBarCollapseStyles` | That collapsing the bar never overwrites the *Results only* preference |
| `createResultsOnlySandbox()` | `setResultsOnlyEnabled` → `updateResultsOnlyLayout` | That only a real change of mode sends the reader back to page 1 |
| `createCompactSandbox()` | `buildDisplayEntries` → `getPageSize` | Folding children into the outermost matched ancestor, and paging over cards rather than posts |
| `createCardImageSandbox()` | `imageAltText` → the card skeleton | The alt cap, and that a recycled card gets a new `<img>` rather than a re-pointed one |
| `createDeleteSandbox()` | `deleteRemotePost` → `downloadSelectedPosts` | Consent, and that a row only leaves the index once the **library** confirms the delete |

`createMetadataSandbox()` takes a **stubbed `piexif`** — the real library is a jsDelivr `@require`
and cannot be installed here. So the JPEG path is only checked for *how* it calls piexif, while the
PNG and WebP container work, which is entirely hand-rolled, is verified byte for byte against an
independent CRC32 and RIFF/PNG parser written in the suite.

## Adding a suite

Drop a `*.test.js` into `suites/` exporting `{ name, run(t) }`. `run` may be async.

```js
const { createIndexSandbox } = require('../harness');

module.exports = {
  name: 'what this covers',
  run(t) {
    const m = createIndexSandbox();
    t.group('optional heading');
    t.ok('a claim that reads as a sentence', condition, detailShownOnFailure);
    t.equal('another claim', actual, expected);
  },
};
```

If a sandbox needs a function the region does not export, add it to the `epilogue` list in
`harness.js`.

## When the source moves

The slices are anchored on function declarations. Rename or reorder one and the harness throws
`harness: start marker not found …`, and the runner points at `test/harness.js`. That is
deliberate — a loud, specific failure beats tests that quietly stop covering anything.

## The bug this suite keeps finding

Four releases in a row turned out to be the same shape: **an operation that stops early and
reports success.** A rate-limited walk giving up at the first 429 and calling the index complete;
a delete trusting the endpoint's 200 rather than the library; `fetchFullIndex()` reporting only
half its walks. None of them threw, none of them looked wrong in a screenshot, and the suite only
caught them once it was asserting on *outcomes* rather than on calls being made.

So when adding coverage for anything that walks a feed or writes to Grok, assert the end state,
not the request. And run the mutation — the existing 429 test passed happily against the broken
code because it only ever used two retries.

## What is not covered

Anything that needs a browser: DOM injection into the live Grok SPA, IndexedDB itself, the real
`GM_xmlhttpRequest`, the File System Access API, the real `piexifjs`, and CSS. Those still need a
manual pass in Tampermonkey — see the editing loop in [`../CLAUDE.md`](../CLAUDE.md).

## Proving the suite can fail

A green suite is only worth something if it goes red on a real regression. After adding a suite,
break the thing it covers and check that the *right* assertions fail. Mutations used against the
current suites, each caught:

| Mutation | Fails |
|----------|-------|
| `pngCrc32` shifts by 1 instead of 8 | 2 in `metadata` |
| `parseChildPost` sets `parentId` to the root again | 6 in `grandchildren` |
| Cancel drops the remaining queue | 4 in `download` |
| WebP re-tag appends instead of replacing | 2 in `metadata` |
| Child pruning disabled | 9 across `child-sync` and `grandchildren` |
| Un-hiding re-derives the element instead of using its marker | 5 in `native-visibility` |
| The source probe ranks on newest `createTime` again | 3 in `feed` |
| A captured list template is ignored | 6 in `feed` |
| The asset sync stops after one all-known page | 2 in `assets` |
| Reconcile ignores the asset feed | 3 in `assets` |
| An asset storage key is not URL-encoded | 1 in `assets` |
| 429 goes back to the 800ms exponential backoff | 5 in `assets` |
| A truncated legacy walk is not reported | 2 in `assets` |
| A delete trusts the endpoint instead of the library | 8 in `delete` |
| The focus ring loses its box-shadow half | 1 in `accessibility` |
| The lightbox stops trapping Tab | 1 in `accessibility` |
| The prune button loses its accessible name | 1 in `accessibility` |
| `syncResultsView()` resets the page again | 4 in `paging-position` |
| A recycled card re-points its `<img>` instead of replacing it | 5 in `card-image` |
| Compact folds into the *nearest* matched ancestor | 3 in `compact-groups` |
