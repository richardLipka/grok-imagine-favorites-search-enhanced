# Changelog

All notable changes to this enhanced fork are documented here.  
Versions match the `@version` in each userscript header.

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