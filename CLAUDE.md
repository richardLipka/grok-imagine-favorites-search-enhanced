# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Two standalone **Tampermonkey userscripts** that enhance xAI's **Grok Imagine** image/video generator
(`https://grok.com/imagine`). Grok's own "saved / liked" view has no search, so these scripts build a
local **IndexedDB index** of the user's liked posts and layer a full search/filter/download UI on top of
the live SPA.

| File | `@match` | Role |
|------|----------|------|
| `grokSearch.user.js` (v1.67.0, ~6.3k lines) | `https://grok.com/imagine*` (bails out on `/imagine/post/`) | Search bar, index + sync, results grid/panel, lightbox, context menu, bulk download, image metadata tagging |
| `grokPostSidebar.user.js` (v1.3.1, ~530 lines) | `https://grok.com/imagine/post/*` | Read-only collapsible sidebar with prompt + metadata on post detail pages |

Both share IndexedDB `GrokSearchIndex` / store `posts`. `grokSearch.user.js` owns the schema (it is the only
writer and the only script with `onupgradeneeded`); the sidebar is a read-only consumer that falls back
to the Grok API when the store is missing.

This is an **enhanced fork** of AnnaLynn's original Greasy Fork script, via
`ironsniper1/Grok-imagine-favorite-image-search`. `README.md` documents the fork lineage and every
user-facing control in detail — read it before changing UI behavior.

## Development workflow

There is **no build, no package manager, and no linter**. The `.js` files are shipped verbatim and
pasted into Tampermonkey. Do not introduce a bundler, modules, or a `node_modules` dependency without
being asked — the userscript must stay a single self-contained file.

There **is** a dependency-free test suite:

```bash
node test/run.js
```

Run it after touching sync, index, or render logic — it is the only verification available without a
browser. It slices regions out of `grokSearch.user.js` and runs the real functions against stubs, so a
rename or reorder of an anchor function makes it throw `harness: start marker not found`; fix the
markers in `test/harness.js` rather than deleting the suite. See [test/README.md](test/README.md).

Editing loop:

1. Edit the `.js` file in this repo.
2. Paste the full file into the Tampermonkey editor (Chrome/Edge; "Allow User Scripts" must be enabled in
   `chrome://extensions`) and save.
3. Hard-refresh `https://grok.com/imagine` (Ctrl+Shift+R).
4. Verify in DevTools console — all logging is prefixed `[GrokSearch]` / `[GrokPostSidebar]`.

Reset the index while testing, from the page console on `grok.com/imagine`:

```javascript
indexedDB.deleteDatabase('GrokSearchIndex');
```

Everything the suite cannot reach needs this manual pass: DOM injection into the live SPA, IndexedDB,
`GM_xmlhttpRequest`, the folder picker, the real `piexifjs`, and CSS. All of it requires a logged-in
`grok.com` session.

### Release convention

A behavior change bumps the version in **four** places, kept in lockstep:

- the `// @version` line in the script header,
- the `SCRIPT_VERSION` const (it is stamped into downloaded image metadata),
- the "Current versions" line and the fork-lineage row in `README.md`,
- a new `## [x.y.z] — YYYY-MM-DD` section in `CHANGELOG.md` with `### Added` / `### Changed` / `### Fixed`.

Changes that do not alter what users install (tests, docs, tooling) do **not** bump the version or get
a tag — they go under `## Unreleased` in the changelog.

Commit subjects are imperative with the version in parentheses, e.g.
`Add context menu and lightbox downloads (v1.61)`. Releases are annotated tags named `vX.Y.Z`
(`git tag -a v1.63.0`); the repo does not use GitHub Releases. Branch is `main`; `origin` is the
GitHub fork.

## Architecture of `grokSearch.user.js`

One IIFE, no modules; all state lives in module-scope `let`s near the top (`allPosts`, `matchedPosts`,
`currentPage`, `filter*`, `resultsOnly`, …) and all tunables are `const`s in the same block. Sections
are ordered: constants → IndexedDB → API/fetch → post parsing → sync → export → loading UI → display
mode → downloads/EXIF → lightbox/context menu → filter+render → `injectStyles()` (~850 lines of CSS in
one template literal) → search-bar builders → `init()`.

### Data layer

Two undocumented Grok REST endpoints, called with `GM_xmlhttpRequest` + `withCredentials` so the user's
session cookies authenticate the request:

- `POST /rest/media/post/list` — media feed, cursor-paginated, 40/page, includes a nested
  `childPosts` tree. **Ordered by interaction time, not creation time** (a single page has been
  observed spanning 190 days of `createTime`), so a post that resurfaces today appears at the head
  regardless of age and the incremental sync reaches it.
  The `filter.source` enum decides how much of the library is visible. It is undocumented and has
  changed (Grok used to require a like for media to persist), so `resolveMediaSource()` probes
  `MEDIA_SOURCE_CANDIDATES` and caches the winner for `MEDIA_SOURCE_REPROBE_MS`. **Reindex forces a
  re-probe.** Never hardcode a source back into `fetchPage`.

  **Rank candidates on what they return, not on how recent it is.** The probe originally sorted by
  the newest `createTime` in each candidate's first few items and consistently picked a likes-only
  source, because the feed is ordered by *interaction* time: every candidate shows the same handful
  of recently touched posts at its head and reports the same newest date. It now samples
  `PROBE_SAMPLE_SIZE` items, treats the liked feed as a baseline, and scores each candidate on how
  many ids it returns that the liked feed does not.

  **When no enum works, capture instead of guessing.** `tools/capture-list.js` records the request
  Grok's own library view sends; `readListTemplate()` returns it and `buildListBody()`/`fetchPage()`
  replay it verbatim, cursor and limit written at the captured paths. That path bypasses the probe
  entirely. Because a captured request may hit a different endpoint, `extractListPage()` looks the
  post array and the cursor up by candidate key name plus one level of nesting rather than assuming
  `posts`/`nextCursor`. Same rule as the like button: capture the real request, never invent one.
- `POST /rest/media/post/get` — single post with the full child tree (used for deep refresh).
- `GET /rest/assets?pageSize=60&orderBy=ORDER_BY_CREATE_TIME&workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`
  — **the primary feed since v1.67.0**, and what Grok's own library view paginates. Unlike
  `post/list` it is genuinely ordered newest-first and reaches the current day, so the sync's
  "stop once nothing is new" shortcut is sound here and only here. Every row carries the prompt and
  model in `mediaGenInput` (a oneof — resolve it by shape, not by branch name), and the media URL
  is the asset's storage `key` under `assets.grok.com`, so there is **no per-item request**.
  `assetId` is the same id space as a media post id, which is why asset rows merge with list rows
  rather than duplicating them. `workspaceKind` is validated, unlike `filter.source`.

**`filter.source`, `sort` and `collectionId` on `post/list` are ignored, not honoured.**
`sort: "BANANA"` behaves exactly like `sort: "CREATE_TIME_DESC"`, and every invented
`MEDIA_POST_SOURCE_*` returns 200 with a plausible payload. Any probe that ranks those candidates
is comparing identical requests. Verify a parameter is real before building on it — send a
deliberate nonsense value and check it is rejected.

Both go through `postJsonWithRetry()`, which retries `429`/`5xx` with exponential backoff and honours
`Retry-After`. It always resolves: `ok: false` means the request failed, and callers must never treat
that as an empty result — conflating the two is what made a mid-walk `401` report "up to date".

These are internal APIs and may change without notice, so the UI always degrades to the cached index
rather than throwing.

### Index model (schema v5)

The nested `childPosts` tree is **flattened**, but the edges are real: every descendant becomes its
own row with `isChild: true`, `parentId` (the **immediate** parent) and `rootId` (the top-level post
that owns the tree). For a direct child the two are equal. Rows carry aggregate counts
(`childPostCount`, `childImageCount`, `childVideoCount`, `videoCount`) computed over **all
generations** via `walkDescendantPosts()` — including child rows, which is what makes *Download all*
and the variation badge work from a mid-tree row.

Two rules follow from the split, and both exist to fix real bugs:

- **Pruning is scoped to `rootId`, never to `parentId`.** `syncChildRecordsForParent()` refreshes a
  whole tree at once, so `removeDescendantsOfRoot()` has to see every generation. Keying the prune
  on the immediate parent would strand grandchildren whose branch was deleted. Legacy rows written
  before v5 have no `rootId`; `getRootIdOf()` falls back to `parentId`, which is exactly right for
  them because back then every descendant was parented straight onto the root.
- **Anything resolving a child's parent must index *every* row, not just top-level ones.** A
  grandchild's parent is itself a child row. `buildPromptById()` and `backfillChildParentPrompts()`
  both got this wrong before v5, which left grandchildren with an unresolvable parent prompt.

Prompts are denormalized twice: `parentPrompt` (the immediate parent's) and `rootPrompt` (the
original's, stored **only when it differs**, so a first-generation child costs nothing). Both join
`_search`, so searching the original wording finds descendants several generations deep. A prompt
edit therefore has to propagate to two fields — see `propagateParentPromptToChildren()`.

`toStorageRecord()` is the single canonical row shape — it defines what is persisted *and* what is
exported. Add a field there, not ad hoc at call sites, and bump `INDEX_SCHEMA_VERSION` when the shape
changes. `normalizePost()` wraps it and attaches two cached derived fields (`_ms`, `_search`) that the
filter and sort read on every pass; because `toStorageRecord()` whitelists, they never reach IndexedDB
or the export. Anything placed into `allPosts` must go through `normalizePost()` or those caches go
stale.

`isLiked` is tri-state: `true`, `false`, or **`null` for unknown**. `detectLikedState()` sniffs a
list of candidate field names because the payload shape is not contractual; when it finds nothing it
returns `null`. Treat unknown as unknown — *Liked only* excludes it rather than assuming `false`,
and nothing should coerce it with `!!`.

### Liking

`setPostLiked()` never invents a request. It replays a template captured from Grok's own UI by
`tools/capture-like.js` and stored under `LIKE_REQUEST_KEY`: `{ url, method, body, idPath,
likedPath, unlikeUrl? }`, where the paths say where to write the post id and the boolean. With no
template stored, the like controls are disabled and say so. If you ever feel tempted to hardcode an
endpoint here, don't — a wrong guess fires writes at the user's account.

`buildLikeRequest()` deep-clones the template body, so repeated calls cannot accumulate state; it is
covered by `test/suites/liked.test.js`.

### Index mutation rules

`allPosts` is paired with `postById` (id → the live row object). **Rows are updated in place, keyed by
id — never by array position.** `updatePostRow()` mutates the existing object so every array slot and
every reference held by `matchedPosts` or the lightbox stays valid; `addPostRow()` appends and
registers. Only `removeDescendantsOfRoot()` changes the array's shape, and it calls
`rebuildPostIndex()` itself.

This is not stylistic. The previous design passed an `id → array index` map through the sync, and a
child removal mid-pass shifted every later index, so concurrent deep-refresh workers wrote posts into
unrelated slots. If you add a sync path, mutate by id and keep it synchronous, or apply results
serially after fetching — never hold an array index across an `await`.

Sync writes go through `createIndexWriter()`, which buffers puts/deletes and flushes once per pass.

### Sync strategy

Full reindex is the exception, not the rule:

| Trigger | Path | Behavior |
|---------|------|----------|
| Page load | `loadAllPosts()` → `syncLikedFeed()` | Load cache, fetch new likes, refresh recent metadata |
| Tab visible / SPA navigation | `scheduleIncrementalSync(reason)` → `runIncrementalSync()` | Debounced, then rate-limited per reason by `syncMinIntervalMs()` |
| **Reindex** button | `reindexDatabase()` | `dbClear()` + `fetchFullIndex()` — full rebuild |

`syncLikedFeed()` walks the first `SYNC_LIST_REFRESH_PAGES` list pages for cheap metadata and child
trees, then `refreshPostsViaGet()` fetches a bounded batch in parallel (`runPool`,
`SYNC_DEEP_CONCURRENCY`) and applies the results serially.

Two invariants govern which posts land in that batch, and both exist to fix real bugs:

- `METADATA_REFRESH_KEY` means *last deep (post/get) refresh*, and `postNeedsDeepRefresh()` gates on it
  with `SYNC_DEEP_REFRESH_TTL_MS`. The list pass deliberately does **not** stamp it — the list payload
  may carry a shallower child tree. Stamping there would starve deep refresh permanently.
- `pickDeepRefreshTargets()` reserves `SYNC_DEEP_CHILDLESS_SLOTS` for parents with no children yet.
  Posts with children dominate the head of the feed, so without the reservation a post's *first*
  variation is never discovered outside the list-refresh window.

`syncChildRecordsForParent()` treats a payload's `childPosts` as authoritative and prunes anything
missing from it — so it first checks that the payload's id matches the post being refreshed. Keep that
guard: a malformed response would otherwise delete every child the post has.

The `indexing`, `syncInProgress`, `reconcileInProgress`, and `loaded` guards prevent overlapping runs —
respect them when adding sync entry points. A trigger arriving mid-sync is stored in
`pendingSyncReason` and re-run rather than dropped.

### Reconciliation (`reconcileLikedIndex`)

Incremental sync is additive: it never deletes, and it stops after a few pages. **Unliked posts** are
therefore structurally outside its reach — nothing else removes a parent row. The reconcile sweep
walks the entire feed for ids only, then makes the index match. It runs at most once per
`RECONCILE_INTERVAL_MS` (timestamp in `localStorage`), or on demand from the **Verify** button.

(An earlier version of this file claimed reconciliation was also needed for *posts liked long after
they were created*. That was wrong: the feed is ordered by like time, so those arrive at the head and
the incremental sync catches them. Removing unlikes, and repairing anything a truncated sync missed,
is the real job.)

It is the only destructive path in the codebase, so three rules hold it together:

- **Ids come straight from the payload**, via `walkDescendantPosts`, *not* from
  `collectChildRecords()` — that helper deliberately skips posts that already exist as parents, and
  those ids must still count as present or the sweep would delete them.
- **Deletions apply only when the walk completed.** A network failure, a repeated cursor, or the page
  cap leaves `complete = false` and nothing is removed; a partial id set is indistinguishable from a
  mass unlike.
- **`RECONCILE_MAX_DELETE_RATIO` caps a single sweep.** If the feed claims more than half the index is
  gone, that is treated as a bad response and logged, not obeyed.

`removeRowsById()` is the only function that deletes parent rows; it also clears `knownIds` and
`selectedPostIds` and rebuilds the id map.

### Render pipeline

`allPosts` → `applyFilter()` (text AND-terms over `getSearchablePromptText()`, then date, video and
child filters, then sort) → `matchedPosts` → `syncResultsView()` → `showResults()` renders one page into
`#grok-results-grid`. Search input is debounced `SEARCH_DEBOUNCE_MS` (400 ms). Any state change should
route through `applyFilter()` rather than mutating `matchedPosts` directly.

This runs over the whole index on every keystroke, so keep per-post work out of it: read the cached
`_search` / `_ms` fields rather than re-deriving them, and hoist anything filter-wide (as
`applyFilter()` does with the date bounds) above the `filter()` callback.

Selection (`selectedPostIds`) is independent of the match set — `pruneSelection()` drops only ids that
left the index entirely, so a filter change never clears what the user checked. Anything comparing a
selection count against a match count has to count the *intersection* (see
`syncDownloadSelectedButtons`), not `selectedPostIds.size`.

`renderResultCards()` reconciles the grid against the page **by post id**, reusing card elements and
patching only the fields that differ — notably assigning `img.src` only when it changed, so paging no
longer makes the browser re-decode every thumbnail. Consequences for anyone editing card markup:

- The skeleton is built once in `createResultCardElement()`; optional parts (child mark, date badge,
  badges) always exist and are toggled with `[hidden]`. The card CSS sets `display: flex` on some of
  them, so `.grok-result-card [hidden] { display: none !important; }` is what makes the attribute
  work — don't drop it.
- Cards persist across renders, so anything stateful must be set explicitly on every pass in
  `renderResultCard()`. Nothing may rely on a fresh element.

`syncModelFilterOptions()` rescans the index for distinct models, so it is gated on `indexRevision` —
bumped by `addPostRow`/`rebuildPostIndex` — rather than running on every filter pass.

Three display modes are toggled as classes on `<html>` by `updateDisplayMode()`:
`grok-results-only-mode` / `grok-custom-results-mode` (panel over a hidden native grid),
`grok-filtered-inline-mode` (results injected inline), and neither (native Grok grid untouched).

### Coexisting with the Grok SPA

This is the fragile part of the codebase and the usual source of bugs:

- **The native grid is located by heuristic**, not a stable selector: `getGrokGrid()` /
  `getNativeSavedRoot()` find `[class*="media-post-masonry-card"]` and walk up a bounded number of
  parents. A Grok class-name change breaks hiding — keep those walks defensive and null-safe.
- **Never re-derive an element in order to un-hide it.** Those heuristics return `null` once React
  drops the masonry cards, which it does while their container is `display: none` — so the un-hide
  silently did nothing and left the page blank until a reload. `hideNativeElement()` stamps
  `HID_GRID_ATTR` / `HID_ROOT_ATTR`, and `showNativeHidden()` restores by querying that marker. The
  two can resolve to the same node, so the inline styles are only cleared once the last marker is
  gone. Anything else that hides part of Grok's UI must follow the same shape.
- **No display-mode class may survive a collapsed search bar.** `grok-custom-results-mode` hides the
  native grid through CSS on its own, so `updateDisplayMode()` gates all three classes on
  `searchBarExpanded`; clearing the inline styles is not enough by itself.
- **A `MutationObserver` on `document.body`** detects SPA URL changes (re-`init()` + sync) and re-asserts
  visibility/results after React re-renders, debounced ~350 ms via `scheduleEnforceDisplay()`. Because
  React can rewrite the DOM at any time, injected UI must be re-assertable.
- **All DOM builders are idempotent** — `ensureX()` creates-or-returns, `migrateX()` upgrades a search
  bar built by an older script version that is still in the DOM. `buildSearchBar()` detects an existing
  `#grok-search-wrap` and runs the whole `ensure*`/`migrate*` chain instead of rebuilding. New UI added
  to the `buildSearchBar()` HTML template also needs an `ensure*` function, or users upgrading in place
  will not get it.
- **Everything injected is namespaced `grok-*`** (ids and classes) and styled only from `injectStyles()`.
- **The toolbar's filter and action groups must stay `flex-wrap: wrap` with a shrinkable
  `min-width: 0`.** Their children are all `flex-shrink: 0`, so a `nowrap` group whose box gets
  squeezed overflows and paints over its neighbour rather than reflowing — that is how v1.63.0 put
  the model dropdown on top of **Export JSON**. Adding another control to either group means
  re-checking the layout.

To inspect toolbar layout without grok.com, render the real CSS and markup standalone: extract the
`injectStyles()` template and the `buildSearchBar()` `wrap.innerHTML` template, add the controls the
`ensure*()` functions inject at runtime, and open the result in a browser. Measuring
`getBoundingClientRect()` for overlap and overflow is more reliable than eyeballing a screenshot.

### Downloads

Media is fetched by page `fetch` first and falls back to `GM_xmlhttpRequest` (CORS). Bulk
"Download selected" uses the **File System Access API** (`showDirectoryPicker` via `unsafeWindow`),
so it is Chrome/Edge-only and must run inside a real user gesture. Files are written sequentially as
`grok-{id}.{ext}`; above `BULK_DOWNLOAD_CONFIRM_ABOVE` (5) items a custom in-page confirm dialog is
shown instead of native `confirm()`.

Cancel and retry are threaded through the whole path and have three invariants:

- **An abort is not a failure.** `prepareDownloadBlobWithRetry()` retries `DOWNLOAD_MAX_ATTEMPTS`
  times with backoff, but rethrows an `AbortError` immediately. Anything that catches download
  errors must check `isAbortError()` before counting a failure.
- **Cancel reaches the request in flight.** The page `fetch` gets the `AbortController` signal;
  `GM_xmlhttpRequest` has no signal support, so the handle it returns is aborted from an `abort`
  listener. Older managers return nothing there — hence the optional chaining, and hence Cancel
  degrading to "stops after this file" rather than failing.
- **Whatever was still queued when Cancel landed goes into `lastFailedDownloads`**, including the
  interrupted file, and `lastDownloadDirHandle` is kept so **Retry** resumes into the same folder
  without a second picker prompt. The queue is in-memory only; a reload loses it.

### Image metadata

`piexifjs` is pulled in via `@require` from jsDelivr — the only third-party dependency and the only
non-`grok.com` network access. `embedMetadataInImageBlob()` dispatches on magic bytes to a JPEG,
PNG, or WebP writer; anything else (video included) passes through as the *same blob object*, which
is what callers test for. Tagging failures must never block the download — every writer returns the
original buffer on error.

`buildPostMetadata()` is the single place that turns a row into tag values, so a new indexed field
is added there rather than at each writer. Things worth knowing before editing this area:

- **piexif tag ids differ between builds.** `buildExifDicts()` skips any tag whose id is
  `undefined` instead of writing under the key `"undefined"`, which would poison the whole dump.
  `dumpExifSegment()` falls back to a prompt-only dictionary if the full set is rejected.
- **EXIF string fields are byte-oriented**, so `toAsciiText()` folds accents and drops the rest. The
  untouched text still travels in the UCS-2 `XP*` tags and in the ASCII-escaped JSON blob.
- **WebP is a RIFF container.** A plain file (`VP8 ` / `VP8L` only) has nowhere to put metadata, so
  it is rewritten into the extended format: a synthesized `VP8X` header carrying the canvas size
  read out of the bitstream and a flag byte, then the original image chunks in order, then `EXIF`
  and `XMP `. Existing `EXIF`/`XMP ` chunks are **replaced, not appended** — a second copy is
  invalid and re-tagging has to be idempotent. Chunk order is fixed by the spec, sizes are
  little-endian, and every chunk is padded to an even length.
- The WebP `EXIF` chunk holds **bare TIFF**. piexif returns a JPEG APP1 segment, so
  `buildTiffExifBytes()` strips the marker, its length, and the `Exif\0\0` identifier.
- **PNG `tEXt` is Latin-1 only.** Text that does not fit goes into a UTF-8 `iTXt` chunk instead.
  `pngCrc32()` must shift by 8 per byte, not 1 — it shifted by 1 until v1.65.0 and silently wrote a
  bad checksum into every text chunk the script produced.

### Durability and persisted state

Every toggle, slider, sort order, and collapse state is a `localStorage` key declared as a `*_KEY`
const at the top (`grokSearchResultsOnly`, `grokSearchFilterVideoOnly`, `grokSearchPageSize`, …).
Renaming a filter means adding a migration that reads the old key — see `FILTER_VIDEO_KEY`
(deprecated) migrating into `FILTER_WITH_VIDEO_KEY` in `loadVideoFiltersFromStorage()`. All
`localStorage` access goes through `readStoredString`/`writeStoredString` or a `try`/`catch`.

The index itself is durable in two ways: `requestPersistentStorage()` asks the browser once not to
evict IndexedDB, and `importDatabaseJson()` merges an exported file back in (rows in the file win for
the ids it contains; nothing is deleted). Import runs rows through `normalizePost()` like any other
write path, so the derived caches stay correct.

## `grokPostSidebar.user.js`

Same single-IIFE shape, `grok-post-sidebar-*` namespace, its own `injectStyles()`. Extracts the post
UUID with `POST_ID_RE`, reads the shared index first and the `post/get` API second, then
`mergePostData()` merges them (`fromIndex` / `fromApi` drive the "data source" line). SPA navigation is
caught by wrapping `history.pushState`/`replaceState` (guarded by `window.__grokPostSidebarHistoryHook`),
plus `popstate` and a 1.5 s polling fallback; a `refreshSeq` counter discards responses for a post the
user already navigated away from.

Helpers duplicated from `grokSearch.user.js` (`isVideoMediaType`, `extractChildMediaCounts`, `escapeHtml`,
`openDB`) are intentional copies — the scripts install independently and cannot share code. Change both
when the semantics change.
