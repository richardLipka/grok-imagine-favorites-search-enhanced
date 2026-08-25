# Changelog

All notable changes to this enhanced fork are documented here.  
Versions match the `@version` in each userscript header.

## Unreleased

Nothing here changes the installed userscripts — no version bump.

### Corrected
- The v1.63.0 notes said **Verify** was needed to find *posts liked long after they were created*.
  That was based on a wrong assumption about feed ordering. Field data shows the liked feed is
  ordered by **like time**, not creation time (one page spanned 190 days of `createTime`), so a
  freshly liked old post arrives at the head of the feed and the incremental sync already catches it.
  Verify's real job is removing unliked posts and repairing truncated syncs. Docs updated.

### Tooling
- Added a dependency-free test suite: `node test/run.js` (96 assertions across records, index
  mutation, child sync, reconciliation, and results-grid reuse). The suite slices regions out of
  `grokSearch.js` and runs the real functions against stubs, so it covers production code rather
  than a copy of it — see [test/README.md](test/README.md).

---

## [1.63.2] — 2026-08-25

### Fixed
- A **model filter** naming a model that is not in the index stayed active instead of being
  cleared, silently matching nothing. The reset only ran when the dropdown's option list changed,
  so it was skipped on the common path.

### Added
- `tools/diagnose.js` — a read-only console script that reports what the index holds per day, what
  the liked-feed API actually returns, which filter preferences are stored, and whether more than
  one search script is running. For working out whether missing posts are a fetch problem, an
  indexing problem, or a filter hiding them.
- `tools/probe-sources.js` — probes which `MEDIA_POST_SOURCE_*` values the list endpoint accepts, to
  find out whether media you generated but never liked is reachable at all.

### Note
- If posts are missing after a **Reindex**, check the **Model** dropdown first. It is a saved
  preference, so **Reindex** does not clear it, and every post made with a different model stays
  hidden. **Clear** resets it.

---

## [1.63.1] — 2026-08-25

### Fixed
- **Toolbar controls overlapped each other.** The bottom row was `flex-wrap: nowrap` while every
  control inside it is `flex-shrink: 0`, so once v1.63.0 added the model dropdown and the
  Import/Verify buttons the filter group's box shrank to ~416 px while its contents still needed
  ~829 px — the overflow painted straight over the action buttons, putting *All models* on top of
  **Export JSON**. Both groups now wrap, so the bar grows a line instead of overlapping. Verified
  clear of overlap and overflow from 320 px to 1280 px.

---

## [1.63.0] — 2026-08-25

### Added
- **Verify** button — walks the entire liked feed collecting ids only (no `post/get`, no
  metadata re-parse) and reconciles the index against it. This is the only thing that
  **removes posts you have unliked**, and the only thing that finds **posts liked long after
  they were created**, which the incremental sync never reaches because it stops after a few
  pages. Runs automatically at most once every 24 hours; the button forces it.
  - Deletions are applied only when the walk completes — a partial id set would look exactly
    like a mass unlike.
  - The sweep refuses to delete more than half the index at once and logs a warning instead,
    so a feed shape change cannot wipe the library.
- **Import JSON** — merges a previously exported index file back into the local database.
  Rows in the file win for the ids it contains; nothing is deleted. Makes **Export JSON** an
  actual backup and lets an index move between browsers or machines.
- **Persistent storage request** — IndexedDB is evictable by default, so a large index could
  be discarded under storage pressure and cost a full API rebuild. The script now asks the
  browser once to treat it as durable.
- **Model filter** — a dropdown listing the generation models present in your index. The
  `model` field was already stored on every row but was never shown or filterable in the
  search UI. The model also now appears in the lightbox metadata line.
- **Retry with backoff** on `429` and `5xx` for both API endpoints, honouring `Retry-After`,
  with a `rate limited — retrying…` status. Previously a rate-limited response just ended the
  sync.

### Changed
- **Sort order is now remembered** between sessions, like every other display setting.
- The results grid **reuses card elements instead of rebuilding `innerHTML`**. Paging,
  filtering, and sorting no longer destroy and recreate every `<img>`, so thumbnails are not
  re-decoded on each change. Cards are matched by post id and patched in place.

---

## [1.62.1] — 2026-08-25

### Fixed
- **Check all** could be greyed out while none of the visible results were selected. Now that
  selections outlive the active filter, the button compares how many of the *current* matches
  are selected instead of the overall selection count, which could equal the match count by
  coincidence.

---

## [1.62] — 2026-08-25

Sync correctness and performance pass. No new UI.

### Fixed
- **New variations of older posts are now indexed.** Deep refresh only ever revisited posts
  that *already* had children, so a post's **first** child was undiscoverable unless the post
  sat in the first 4 pages of the liked feed. Childless parents are now candidates too, with
  reserved slots in each refresh batch.
- **Index corruption during sync.** Parallel deep-refresh workers wrote rows into `allPosts`
  by array position using an index map that a concurrent child removal had already
  invalidated, overwriting unrelated posts. Rows are now updated in place, keyed by id, and
  post/get results are applied serially after fetching.
- **A liked post that also appears as another post's child no longer loses its identity.**
  Because IndexedDB is keyed on id, writing the child form overwrote the parent row and
  flipped it to `isChild` — hiding it behind **Hide childs**. Such posts are no longer
  collected as child rows.
- **Network errors no longer report "up to date".** A failed liked-list page was
  indistinguishable from the end of the feed; the walk now reports `sync incomplete — check
  connection` instead of silently truncating.
- **Sync triggers are no longer dropped.** A trigger arriving mid-sync (typically returning
  from a post page right after generating an image) is remembered and re-run.
- A malformed `post/get` payload could prune every child of a post. Child lists are only
  treated as authoritative when the payload's id matches the post being refreshed.
- **Reindex** could loop forever on a repeating cursor; the walk is now bounded and paced.
- Selecting images then typing in the search box no longer clears the selection — selections
  now persist across filter changes and only drop when a post leaves the index.

### Changed
- `metadataRefreshedAt` is now actually used: it gates deep refresh with a 10-minute TTL, so
  repeated syncs rotate through the recent window instead of re-fetching the same 24 posts
  every time. A quiet sync now issues no `post/get` requests at all.
- Syncs triggered by SPA navigation are rate-limited (15 s), matching the existing focus limit.
- Index writes during a sync are batched into one transaction pair instead of two per post.
- Removed the unreachable `fetchNewPostsOnly()` fast path, which also skipped new children.

### Performance
- Post lookups, filtering, and sorting use a persistent id map and per-row cached
  `createTime`/search text instead of rebuilding maps and re-parsing dates on every pass.
  Derived fields are stripped by `toStorageRecord()`, so IndexedDB and the JSON export are
  unchanged.
- The date filter computed its bounds once per post; it now computes them once per pass.

---

## [1.61] — 2026-06-10

### Added
- Lightbox **Download** button for the current image or video.

## [1.60] — 2026-06-10

### Added
- Context menu **Download all** — saves all child/descendant posts to a folder (disabled when a post has no children).

### Changed
- Context menu download label is **Download image** or **Download video** based on media type.

---

## [1.59] — 2026-06-10

### Changed
- Replaced the single **Video** checkbox (with min count) with two filters:
  - **Video only** — show only video posts (not images).
  - **With video** — show image parents that have video in child/descendant results.
- Legacy **Video** filter preference migrates to **With video**.

### Fixed
- Lightbox arrow keys no longer page search results while the lightbox is open.

---

## [1.57] — 2026-06-09

### Added
- Custom confirmation dialog before bulk download when more than **5** images are selected (styled like the search bar; message notes it may take time and shows selection count).

### Changed
- Replaces the native browser `confirm()` for large bulk downloads.

---

## [1.55] — 2026-06-09

### Added
- **Check all** and **Clear selection** buttons in the results panel header.

### Changed
- **Download data**, **Check all**, and **Clear selection** removed from the search bar; they appear only in the **results panel** header.
- **Download selected** remains in both the search bar (match count area) and the results panel.

---

## [1.53] — 2026-06-09

### Added
- Per-card selection checkboxes (top-left) for bulk download.
- **Download selected** — pick a folder (Chrome/Edge File System Access API) and save files sequentially as `grok-{id}.{ext}`.
- Download progress in the toolbar status area and results panel header.
- Prompt embedded in downloaded **JPEG** EXIF (`ImageDescription`, `UserComment`) and **PNG** `Description` text chunk via `piexifjs`.
- `@grant unsafeWindow` for reliable folder writes in Tampermonkey.

### Changed
- Subtle unchecked selection checkbox styling; purple outline when selected.
- Date badge moved to **top center** of result cards.

---

## [1.47] — 2026-06-09

### Changed
- Left-click on a result card opens the **lightbox** (instead of a new tab).
- Text search reads live input again; pending re-render when the grid is busy.
- **400 ms** debounce on text search (flush on blur; dates and clear still apply immediately).

---

## [1.44] — 2026-06-09

### Added
- Right-click **context menu** on result cards: Open, open in new tab, copy prompt/URL, download image, filter to date, open parent.
- **Lightbox** gallery over current matched results with prev/next and keyboard navigation.

---

## [1.43] — 2026-06-09

### Added
- **Hide childs** filter (hide child post rows from results).
- **Download data** — export current matched results as JSON (filters + metadata).
- Renamed filters: **Video**, **With child**.

### Fixed
- Results count and download button alignment in toolbar and panel.

---

## [1.38] — 2026-06-09

### Fixed
- Loading indicator on startup in results-only mode when the native grid is hidden.
- Empty results grid placement after initial index load.

---

## [1.35] — 2026-06-09

### Changed
- **Video** and **With child** filters apply to parent posts only (child rows hidden while those filters are active).

---

## [1.34] — 2026-06-09

### Changed
- Video and child image badges on parent cards count **all descendant generations** in the `childPosts` tree.

---

## [1.33] — 2026-06-09

### Added
- Previous / next day buttons when a **single day** is selected in the date filter.

---

## [1.32] — 2026-06-09

### Added
- Canonical index record shape and export **schema v3**.
- Full database JSON export includes parents and children with documented `recordFields`.

### Fixed
- Child row full-text search via `parentPrompt` and live parent lookup.

---

## [1.31] — 2026-06-09

### Added
- `parentPrompt` stored on child rows for search.

---

## [1.30] — 2026-06-09

### Added
- Child posts stored as **separate IndexedDB rows** (`isChild`, `parentId`).
- Child cards in results with purple child mark.

---

## [1.29] — 2026-06-09

### Changed
- Faster sync: list-API metadata refresh plus parallel deep `post/get` for items with children.

---

## [1.28] — 2026-06-09

### Added
- Sync on tab focus and when returning from a post page.
- Refresh of recent post metadata (child/video counts).

---

## [1.27] — 2026-06-09

### Fixed
- Incremental new-post sync after cache load.

---

## [1.26] — 2026-06-09

### Changed
- **Results only** toggle works while the search bar is visible.

---

## [1.25] — 2026-06-09

### Fixed
- Search bar collapse hides the results panel correctly.

---

## Earlier / repo

- **README**, **LICENSE**, and GitHub publish docs added.
- **`grokPostSidebar.js` v1.3** — collapsible post detail sidebar sharing `GrokSearchIndex`.

---

## `grokPostSidebar.js`

| Version | Notes |
|---------|--------|
| **1.3.0** | Collapsible sidebar on `/imagine/post/{id}`: prompt, metadata, IndexedDB + API fallback |