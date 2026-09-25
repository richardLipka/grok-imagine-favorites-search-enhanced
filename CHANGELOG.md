# Changelog

All notable changes to this enhanced fork are documented here.  
Versions match the `@version` in each userscript header.

## [1.76.1] — 2026-09-25

### Fixed

- **Reindex stopped at about 1,980 images, and Verify could not repair it.** v1.75.2 identified
  the rate limit but treated it as server overload; it is a **token bucket**, and the remedy was
  an order of magnitude too impatient.

  Measured by walking `/rest/assets` directly against a real library: the bucket trips roughly
  **every 31 pages** — at pages 32, 63, 96, 126, 164, 194, 226, 271 and 302 of one run — and a
  single pause of about **five seconds** clears it, after which the walk continues at full speed.
  Pacing barely matters: 120ms between pages tripped it at page 28, 400ms at page 32.

  The old schedule was three attempts at 0.8s, 1.6s and 3.2s. All three were spent inside one
  window, so the walk gave up at the **first** limit — 33 pages of 60 items, which is exactly the
  1,980 images people saw. **Verify** walks the same feed, so it died at the same page; because it
  correctly refuses to delete on an incomplete walk, it could neither finish nor repair anything.

  429 now has its own schedule — five seconds, growing, with a budget of eight attempts — while
  ordinary flaky responses keep the impatient exponential backoff. Grok sends no `Retry-After`
  and no `X-RateLimit-*` headers on these endpoints (checked), so the delay comes from
  measurement; `Retry-After` is still honoured first should that ever change. With this, the same
  walk passed 19,500 images and kept going.

  Progress now names the wait (`rate limited — waiting 5s (attempt 1/8)…`) so a long pause does
  not look like a hang.
- **`Retry-After` was never actually read.** The header regex had a doubled escape, so it matched
  a literal backslash and never a real header. It had no effect in practice — Grok does not send
  the header — but it meant the one piece of server guidance the code claimed to honour was dead.

---

## [1.76.0] — 2026-09-25

### Changed

- **Reorganized Main GUI Panel into Four Clean Structured Lines:**
  - **Line 1 (Search & Counts):** Search input bar with SVG icon, Models filter dropdown, Newest/Oldest sort dropdown, and result counter plus background sync / reindexing status indicator (`#grok-search-count-wrap`).
  - **Line 2 (Date Controls & Clear Filter):** Previous day button (`<`), Start date picker, date range separator (`–`), End date picker, Next day button (`>`), quick-range date preset chips (*Today*, *Yesterday*, *Last 7 Days*, *This Month*), and dedicated **Clear filter** button (`#grok-search-clear`) with clear icon and text label.
  - **Line 3 (Media & Content Checkboxes):** All filter toggles: *Video only*, *With video*, *With child* (paired with minimum child count combo box), *Hide childs*, *Liked only*, and *Uploaded only*.
  - **Line 4 (Action & Maintenance Buttons):** All primary action buttons grouped together, moving **Download selected** (and its active *Cancel* and *Retry failed* companion buttons) to line 4 alongside *Import JSON*, *Export JSON*, *Export results*, *Reindex*, *Verify*, and *Prune missing*.
- **DOM Migration & Backwards Compatibility:**
  - Enhanced `migrateSearchBarLayout()` to reconstruct existing DOM nodes from previous versions cleanly into the 4 structured lines on script updates or SPA navigations without losing control state or bound listeners.
- **Tests:**
  - Added structural assertions in `test/suites/search-bar-parts.test.js` verifying that the 4-line layout template cleanly contains all designated elements in their respective rows.

## [1.75.2] — 2026-09-25

### Fixed

- **Reindexing prematurely stopping after ~2,000 images.**
  - `gmGetJson` lacked exponential backoff retry. Rapid pagination through `/rest/assets` (60 items/page at 40ms intervals) hit Grok's rate limits after ~33 pages (1,980–2,040 images). `gmGetJson` now retries up to 3 times on HTTP 429, 5xx, or network timeouts, respecting the `Retry-After` header when sent.
  - Paced the delay between pages during full reindexing (`Math.max(SYNC_LIST_PAGE_DELAY_MS, 100)`) to 100ms, preventing burst rate-limiting while maintaining fast library walks.
  - In `fetchFullIndex()`, the legacy list pass previously skipped any post whose ID was already known (`knownIds.has(parsed.id)`). Because the asset feed ran first, this skipped all parents and dropped all of their child trees (`childPosts`). The legacy pass now enriches existing parent rows with child counts and like status, and always collects child records regardless of parent existence.
  - Surfaced walk failures: if an asset walk encounters an unrecoverable failure or rate limit exhaustion, `fetchFullIndex()` reports it as incomplete rather than silently declaring success.

### Changed

- **Clear Progress Reporting During Reindexing and Verification:**
  - **Reindexing progress:** Replaced generic counters with informative stage indicators:
    - Asset feed: `indexing library: N images (page P)…`
    - Legacy trees: `checking legacy trees: +N items (M total)…`
    - Rate limits: `rate limited — retrying in Xs…`
    - Saving: `saving… N/M`
    - Button text reflects state (`Reindexing…` while running).
  - **Verification progress:** Step-by-step progress tracking for both feeds:
    - Legacy feed: `verifying (legacy feed)… N remote found (page P)`
    - Asset feed: `verifying (asset feed)… N remote found (page P)`
    - Comparison: `verifying… checking N local images`
    - Removal: `verifying… removing N missing images`
    - Button text reflects state (`Verifying…` while running).

---

## [1.75.1] — 2026-09-25

### Fixed

- **`ensureAccessibleNames()` ran before the controls it names existed.** It was first in the
  `ensureSearchBarParts()` chain, so on a fresh build it labelled only what had already been
  created — the import file input is built further down and never got its label. Caught by
  checking the installed build rather than the source. It now runs last, and the test asserts the
  ordering rather than mere membership. (No visible effect: that input is `display: none` and so
  is not in the accessibility tree. It shipped as its own version because the fix changed the
  file after 1.75.0 was already tagged, and two different files must not claim one version.)

---

## [1.75.0] — 2026-09-25

### Fixed

- **Accessibility pass over the whole injected UI**, audited against WCAG 2.1/2.2 AA on a live
  library and fixed:
  - **Focus indicator (2.4.7).** Keyboard focus was invisible. Grok's stylesheets are served
    cross-origin so what they reset cannot be read from the page, and our own CSS clears the
    outline on five controls — two of them (**Sort**, and the button-corner picker) with nothing
    in its place. Every injected control now states its own ring, as an outline *and* a
    box-shadow, so overriding one still leaves the other.
  - **Accessible names (4.1.2).** The search box had a placeholder but no name; the per-card
    selection checkbox had none; the broken-image prune button announced as its own glyph
    "✕", because text content beats `title`. All named now, and the group checkbox says how
    many items it selects. The names are applied from the end of the shared `ensure*` chain, so a
    toolbar left behind by an older version gets them too and every control exists by then.
  - **Lightbox focus (2.4.3).** It had the right ARIA — `role="dialog"`, `aria-modal="true"`,
    a label — but `aria-modal` does nothing about the Tab key: **184 controls behind the backdrop
    stayed reachable**, focus never entered the dialog, and closing it dropped you at the top of
    the document. Tab now wraps inside the dialog, focus moves to **Close** on open, and returns
    to the card that opened it on close.
  - **Contrast (1.4.3).** Five text elements sat below 4.5:1 — the sync status worst at
    **2.05:1**, then the date separator at 3.20, the match count at 3.76, and the page label and
    panel count at 4.46. All raised to between 6.7:1 and 7.4:1, measured against the real panel
    background.
  - **Target size (2.2 AA, 2.5.8).** Filter checkbox labels are the click target and were 17px
    tall; they and the toolbar buttons now clear 24px. Checked from 380px to 900px wide — no
    overflow and no overlap at any width.
- **A latent duplicate of the paging shortcut.** `buildSearchBar()` registered its `keydown`
  listener on `document` from the fresh-build path, unguarded. SPA re-inits take the early-return
  migration path so nothing stacked in practice — verified, one arrow press moved exactly one
  page — but React removing `#grok-search-wrap` would have rebuilt it and left the previous
  listener bound to `document` holding a dead input, paging twice per keypress. It is now guarded
  by a `document.body.dataset` flag like every other document-level listener here.

### Changed

- **Ctrl+F had two handlers racing on the same keypress.** `bindGlobalResultUiListeners()` owns
  the shortcuts; the paging listener no longer carries its own copy, which did less
  (`focusSearchInputFromShortcut()` also closes an open lightbox and selects the text).
- Filter labels, display controls and toolbar buttons are a few pixels taller, which is the one
  change here you will actually see.

---

## [1.74.0] — 2026-09-24

### Added & Enhanced (Power Features)

- **Lightbox Power Keyboard Shortcuts:**
  - `C`: Instant copy prompt to clipboard with status toast.
  - `L`: Instant toggle Like / Unlike state with button sync.
  - `D`: Download active media file directly.
  - `Delete` / `Backspace`: Open single-post delete / prune confirmation dialog.
  - `/` or `Ctrl+F` / `Cmd+F`: Global focus and text selection of search input from anywhere (safely ignored when focus is within inputs, textareas, or selects).
  - Added shortcut hint badges to action tooltips for faster discovery.

- **Date Range Quick Presets:**
  - Added quick-filter chips next to the date navigation stepper: **Today**, **Yesterday**, **Last 7 Days**, **This Month**.
  - Clicking any chip automatically computes date boundaries, populates `dateStart`/`dateEnd`, updates the day navigation buttons, and triggers the filter immediately.
  - Clicking an active preset toggles and clears the date filter.
  - Dynamically synchronizes chip active states when dates are manually typed, shifted via day stepper, or cleared.

- **Export Filtered Results & Selected Subsets (JSON & CSV):**
  - Added **Export results** / **Export selected (N)** button (`#grok-export-results-btn`) in the actions toolbar next to `Export JSON`.
  - Opens format picker dialog allowing users to choose between **JSON** and **CSV**.
  - **CSV Export:** Fully RFC-4180 compliant escaping with UTF-8 BOM, including `id,prompt,model,date,mediaType,mediaUrl,thumbnail,isChild,parentId,rootId,isLiked,isUploaded,conversationId`.
  - **JSON Export:** Schema v5 structure containing full record fields, active filter snapshot, and detailed total/parent/child counts.

- **Stacking / Grouping by Batch Generation:**
  - Added **Batch groups** toggle (`#grok-batch-groups`) in the display controls row.
  - Groups generations sharing the same batch conversation (`conversationId`) into a single primary card with small preview thumbnails (`.grok-result-kids`).
  - Seamlessly interoperates with **Compact** mode: parent-child hierarchies fold first, followed by batch siblings under the primary card, with complete child thumbnail deduplication.
  - Preserves flat selection, download, deletion, and lightbox navigation indexing without modifying the underlying match set.

---

## [1.73.0] — 2026-09-24

### Performance & Optimizations

- **`buildPromptById` Memoization:** Cached `buildPromptById()` against `indexRevision`, eliminating full-index Map allocations and garbage collection spikes on every search input keystroke.
- **Search Filter Short-Circuiting:** Reordered `applyFilter()` predicates so fast boolean, model, liked, and date bounds checks execute before expensive prompt substring searches (`terms.every(...)`).
- **Batch Sibling Indexing (`getPostsByConversation`):** Added memoized `getPostsByConversation()` indexing, replacing linear O(N) scans across `allPosts` with instant O(1) Map lookups for batch generation siblings.
- **`getRelatedPosts` Early Termination:** Added threshold guards (`limit && related.length >= limit`) to child, sibling, batch, and prompt relationship discovery loops, stopping immediately once the requested limit is reached.
- **CORS-Free Media Probing:** Updated `checkMediaUrlExists()` to prioritize `GM_xmlhttpRequest` HEAD requests directly, avoiding browser console CORS warnings on cross-origin CDN media.

### Fixed

- **Lightbox Prompt Subtitle Persistence:** Fixed subtitle recreation in `renderResultLightbox` when prompts are resolved asynchronously, ensuring the `'Uploaded image'` badge indicator remains visible.
- **Child Upload Parsing:** Added `isUploaded` propagation in `parseChildPost()` so uploaded child/variation posts preserve their upload classification.
- **Upload Metadata Diffing:** Added `isUploaded` comparison to `postMetadataChanged()` so newly discovered uploaded states trigger persistence in IndexedDB.
- **Pruning Accurate Count:** Fixed `removeRowsById()` to return the exact number of deleted rows removed from memory rather than the length of the input ID set.

### Grok Post Sidebar (v1.5.0)

- Added upload detection via `isUploadedPost()` to `grokPostSidebar.user.js`.
- Displays `Source: User upload` in the sidebar metadata table on post detail pages.

---

## [1.72.0] — 2026-09-24

### Added & Changed (Deleted / Missing Media Handling & Upload Tagging/Filter)

- **Deleted & Missing Media Handling (All 3 Steps):**
  - **Step 1 (Graceful Missing Detection):** Added `error` listeners on card thumbnails and lightbox media. When an image has been deleted on Grok servers (HTTP 404/410), cards automatically show a styled missing placeholder (`.grok-result-broken-overlay`) reading "Media deleted", mark the card with `.grok-result-card--broken`, and prevent broken image layout artifacts.
  - **Step 2 (Instant Quick Removal):** Broken cards show a quick-action prune button (`.grok-result-prune-btn`) to remove the phantom record directly from the local IndexedDB database. In the lightbox details view, missing media displays an error banner with a "Remove from index" button and a "Copy prompt" button to save the prompt before deleting.
  - **Step 3 (Bulk "Prune Missing" Utility):** Added a `Prune missing` button to the main actions toolbar (`#grok-prune-missing-btn`). Probes indexed media via lightweight `HEAD` requests with bounded concurrency (`runPool`). If 404/410 deleted items are detected, prompts the user with an in-page confirmation dialog (`confirmDangerousAction`) before safely purging the dead records and refreshing the index and results grid.

- **Uploaded Images Detection, Tagging & Filter:**
  - **Upload Detection:** Added `isUploadedPost(post)` recognizing uploaded media from `fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE'`, `/upload/` CDN path patterns, and `isUploaded` flags. Persisted `isUploaded` across storage records, asset feed parsing, and parent/child normalization.
  - **Uploaded Badge & Tags:**
    - Cards in the results grid display a green **Upload** badge (`.grok-badge-uploaded`) with an upload icon.
    - Lightbox details header displays an `'Uploaded image'` subtitle indicator.
    - Lightbox Related Posts sidebar renders an `Upload` badge (`.grok-lightbox-badge--uploaded`) on related items that were user-uploaded.
  - **GUI "Uploaded only" Filter:** Added an `Uploaded only` checkbox (`#grok-filter-uploaded-only`) to the search filters row in the main GUI, allowing users to instantly filter the library to only uploaded assets. Remembers state in `localStorage` (`grokSearchFilterUploadedOnly`) and clears with the Clear button.

---

## [1.71.0] — 2026-09-21

### Added & Changed (Related Posts Sidebar & JSON Prompt Guarantee)

- **JSON Export & Storage Prompt Guarantee:**
  - `toStorageRecord(post)` now guarantees prompt completeness: if `post.prompt` is missing or blank, it falls back to `parentPrompt` or `rootPrompt`.
  - `toStorageRecord(post)` infers `isChild = true` whenever `parentId` is present.
  - `downloadDatabaseJson()` and `downloadResultsJson()` run `backfillChildParentPrompts()` and `propagateBatchPrompts()` right before serialization so every exported row has its inherited and batch prompts resolved.
- **Related Posts Sidebar in Lightbox Details:**
  - Added `getRelatedPosts(post, limit)` to identify related items across multiple relationship dimensions: immediate **Parent**, ancestor **Root**, descendant **Children**, **Sibling** branches, **Batch** generation siblings (same `conversationId`), and **Same prompt** matches.
  - Added a dedicated left sidebar (`#grok-lightbox-sidebar`) inside the lightbox details view displaying related thumbnails with color-coded relationship badges, video play indicators, timestamps, and prompt tooltips.
  - Clicking any related image immediately switches the active lightbox details, prompt, metadata, child links, and related sidebar to the selected item.
  - `openResultLightbox(post)` now supports selecting any post, even if filtered out of the current results grid.
  - Added responsive layout: on narrow viewports/mobile, the related bar stacks horizontally. If no related posts exist for a post, the sidebar is cleanly hidden and the media stage takes the full width.

---

## [1.70.0] — 2026-09-21

### Added & Fixed (Grok V2 Prompt Recovery & Display)

- **Prompt recovery for recent Grok Imagine generations:**
  - Grok's backend migrated from legacy `mediaPost` records to a V2 architecture where media posts and asset feeds omit direct prompt text or strip `mediaGenInput`.
  - Added support for all generation modes in `assetGenInput`: `textToImage`, `imageToImage`, `textToVideo`, `imageToVideo`, `referenceToVideo`, and `videoExtension`.
  - Added parent asset/post tracking via `getAssetParentId`, extracting links from `inputAssets`, `hydratedContext.parentPostId`, `hydratedContext.parentAssetId`, `gen.parentPostId`, and `auxKeys.parent_post_id`.
  - Added parent prompt inheritance: image variations, edits, and videos with blank prompts inherit their parent's prompt (`parentPrompt`) and root prompt (`rootPrompt`).
  - Added sibling batch prompt propagation: images generated in multi-image batches within the same conversation now propagate prompt and model metadata across siblings.
  - Added `getJsonWithRetry` and `fetchRemoteAsset(id)` using `GET https://grok.com/rest/assets/{id}` with exponential backoff on 429/5xx.
  - Updated `fetchRemotePost(id)` to fall back to `GET /rest/assets/{id}` and recursively resolve parent posts up to 3 levels when prompts are missing.
- **UI Prompt Display & Lightbox Enhancements:**
  - **Results Grid:** Card hover titles and prompt labels display the prompt or parent prompt, with an `'Inherited from parent prompt'` tooltip for inherited prompts.
  - **Lightbox:** Displays the effective prompt, adds `'Inherited from parent post'` title and a `'Parent prompt'` metadata badge, and automatically triggers background resolution via `resolveAndApplyPostPrompt(post)` when viewing an item with a missing prompt.
  - **Context Menu:** `Copy prompt` copies the effective or parent prompt, flashing `'parent prompt copied'` when an inherited prompt is copied.
- **Grok Post Sidebar (v1.4.0):**
  - Updated `grokPostSidebar.user.js` with `GET /rest/assets/{id}` fallback and recursive parent prompt inheritance.
  - Added **Parent ID** metadata row with quick copy button.
  - Rendered inherited prompts with a distinct purple `Inherited from parent post` badge.

---

## [1.69.5] — 2026-08-28

### Fixed

- **Duplicated and bleeding native images under search results, pagination, and zoom changes.**
  - `getGrokGrid()` and `getNativeSavedRoot()` now locate the common ancestor containing all native cards across all masonry columns, preventing sibling columns from remaining visible behind the custom UI.
  - `setNativeGridVisible(false)` now explicitly marks and hides all native masonry cards and post links (`[class*="media-post-masonry-card"]`, `main a[href^="/imagine/post/"]:not(.grok-lightbox-kid)`) with `data-grok-hid-grid="1"`, guaranteeing that no trailing or leftover native items bleed through at the bottom when results are short, zoom size is reduced, or paging to another page.
  - Added CSS containment rules for `html.grok-custom-results-mode` and `html.grok-filtered-inline-mode` to comprehensively keep all native items hidden while preserving Grok's header and prompt input.

---

## [1.69.4] — 2026-08-28

### Fixed

- **Missing thumbnail images for video results in search results and card lists.**
  - Video posts and assets often have `.mp4` URLs in `thumbnail` or `mediaUrl`, which an HTML `<img>` element cannot display as an image.
  - Video result cards, compact child strips, and lightbox child rows now resolve thumbnails via `getPostThumbnailUrl(post)`:
    1. If a video post has a dedicated image thumbnail / poster (non-video URL), it is used directly.
    2. Otherwise, falls back to the parent post's image (`parentId`).
    3. If parent is also a video, falls back to the root post's image (`rootId`).
    4. If the post has child images, falls back to the first child image.
    5. If the post is an asset generated in a batch, falls back to sibling images sharing the same `conversationId`.
    6. Falls back to original media URL if no image ancestor/descendant is available.

---

## [1.69.3] — 2026-08-28

### Fixed

- **Grok top header, bottom generation bar, and collapse toggle disappeared.**
  - `getNativeSavedRoot()` was walking up DOM ancestors until it hit `<main>`, marking `<main>` with `display: none !important`. Because Grok Imagine’s modern SPA houses the top navigation header and bottom generation controls inside `<main>`, hiding it hid the entire Grok application shell. `getNativeSavedRoot()` now stops before `<main>`, `<header>`, `<nav>`, and input containers, isolating the hide to the native image grid only.
  - The collapse toggle (`#grok-search-toggle`) now has an elevated z-index (`100005`) and is re-asserted in `init()` and the SPA `MutationObserver` if React hydration or SPA navigation detaches it.

---

## [1.69.2] — 2026-08-27

### Fixed

- **One post whose media fails to load could wreck a whole grid row.** A broken `<img>` is not
  replaced content: the browser lays out its `alt` text instead and grows the box to fit, ignoring
  the element’s own `aspect-ratio`. Because the card’s alt was the *entire* prompt, and prompts
  here reach a few thousand characters, a card holding a 2,524-character prompt whose thumbnail
  404s measured **1,746px tall instead of 246px**.

  Two changes, either of which would fix that case and which together cover the rest:
  `.grok-result-card > img` is now `contain: size`, so the 3/4 box holds whether the media loads,
  fails, or is still on its way; and `alt` carries a 140-character summary rather than the whole
  prompt. A whole prompt in `alt` was wrong anyway — a screen reader reads every word of it. The
  full text is still on the card as a `title`, in the hover overlay, and in the lightbox.
- **A very long prompt pushed the image out of the lightbox.** The lightbox prompt had no bound,
  so a few thousand characters grew the footer until little was left for the media. It now caps at
  22vh and scrolls.

---

## [1.69.1] — 2026-08-26

### Fixed

- **The results jumped back to page 1 on their own.** `syncResultsView()` reset `currentPage` on
  every render, so anything that re-rendered dragged the reader to the front: an incremental sync
  that found one new post, a **Verify** sweep, liking a row, deleting a row. `setResultsOnlyEnabled()`
  did the same unconditionally, and `setSearchBarExpanded()` calls it on every init — including the
  re-inits an SPA navigation triggers — so moving around grok.com was enough on its own.

  Going back to page 1 answers the user changing *what they are looking at*, so it now happens only
  in the handlers that do that. Every one of them already reset the page itself: the search box, the
  date inputs and day stepper, the media/liked/model filters, sort, **Clear**, the page-size and
  compact switches, and **Reindex**, which clears the index outright. Toggling *Results only* still
  resets, but only when the mode actually changes. Nothing needs a floor: `showResults()` clamps the
  page to the last one, so a match set that shrinks under you lands on the end of the results rather
  than out of bounds.

---

## [1.69.0] — 2026-08-26

### Added

- **Compact groups** (display row, off by default): one card per family instead of one per post.
  Matched children fold into the outermost matched ancestor above them and appear as a strip under
  the parent image, with a **+N** chip for the rest. Clicking a thumbnail opens that child;
  the parent’s checkbox selects the whole group, since the folded children have no checkbox of
  their own. Pages now count cards, and the match count says how many groups they came to.
- **Child links in the lightbox**: opening a post that has descendants lists them under the
  prompt. Each is a real link to the post page — ctrl/middle-click opens a tab — while a plain
  click moves the lightbox to that child when it is in the current results.
- **Button** setting in the display row: the show/hide button can sit in any of the four corners.

### Changed

- The show/hide button now starts in the **top-right** corner instead of the bottom-right, offset
  below Grok’s own header row so it covers none of its controls (measured: Grok’s Select button
  ends at x2323 and its search button occupies x2331–2371 at y13–53, so a plain `top: 16px`
  would have landed on the search control). Below 1040px the top corners fall back to the bottom,
  where the search bar no longer reaches.
- Result cards no longer stretch to the tallest card in their grid row. They always did, but it
  only became visible once compact cards made row heights differ — a plain card would have grown
  to match, leaving its prompt overlay floating below its image.

### Fixed

- **Paging left the previous page showing at the bottom of the grid.** The grid reuses card
  elements across pages, and pointing a reused `<img>` at a new `src` is not enough: the browser
  keeps painting the old picture until the new one has loaded, and with `loading="lazy"` that load
  can be deferred indefinitely — the element is already in the layout, so it never leaves and
  re-enters the viewport to re-trigger it. Rows in view reloaded; rows at or below the fold kept
  the page before, permanently. A card being recycled for a *different* post now gets a new image
  element, which can only paint blank or correct, and loads eagerly because paging is an explicit
  request to see that page. The first paint of a fresh card is still lazy.
  Measured on a live library: after paging, 1 of 44 thumbnails had loaded; with the fix, 44 of 44.

---

## [1.68.5] — 2026-08-26

`grokPostSidebar.user.js` goes to 1.3.2 for the same change. No behaviour change; the version bump
exists so Tampermonkey ships the new licence headers.

### Changed
- **Relicensed to GPL-3.0.** This project was forked from
  [ironsniper1/Grok-imagine-favorite-image-search](https://github.com/ironsniper1/Grok-imagine-favorite-image-search),
  which declares **two different licences**: its `LICENSE` file is the full GPL-3.0 text (what
  GitHub reports), while its README says "MIT — do whatever you want with it". Where they
  disagree this project follows the **stricter** of the two rather than the more convenient one.
  `LICENSE` is now the verbatim GNU GPLv3, both userscripts carry `@license GPL-3.0-only` plus the
  standard notice, and the copyright credits IronSniper1 alongside Richard Lipka.
- **Corrected the lineage.** The README described the Greasy Fork script as the original with
  IronSniper1 downstream of it. That was backwards: IronSniper1's repo was created 2026-03-07, the
  Greasy Fork script on 2026-03-20, and that script states it was *"Forked from IronSniper1"*. The
  Credits table now reflects what each source actually says, and links back to Strapples' GitHub as
  their script asks.
- The `@author` header said "AnnaLynn (original), Richard Lipka (enhanced fork)"; it now reads
  "Richard Lipka, based on IronSniper1".

---

## [1.68.4] — 2026-08-26

### Added
- The running version is published as `data-grok-search-version` on `<html>`. Check what is
  actually installed with `document.documentElement.dataset.grokSearchVersion` in the console —
  without it, a stale Tampermonkey install is hard to tell apart from a fix that did not work,
  which cost real time chasing the lightbox buttons.

---

## [1.68.3] — 2026-08-26

### Fixed
- **Lightbox Like and Delete still did not appear** after v1.68.2, because
  `ensureResultLightbox()` has *two* paths as well — reuse an existing lightbox, or build one from
  a template that carries Download alone — and only the reuse path ran the chain. On a fresh page
  load the template path is the one taken, so the buttons were never injected. Both paths now run
  `ensureLightboxButtons()`.

  Third occurrence of one hazard, so it is now written down as an invariant in `CLAUDE.md` and
  asserted structurally for both builders.

---

## [1.68.2] — 2026-08-26

### Fixed
- **The lightbox never showed Like or Delete.** They were chained off
  `ensureLightboxDownloadButton()`, which returns early when its own button already exists — and
  Download is part of the lightbox template, so it always did. Neither button was ever injected;
  the Like button had been invisible this way since v1.64.0. All three now hang off one
  `ensureLightboxButtons()`, each responsible only for itself.

  This is the same hazard as the search-bar one fixed in v1.66.1: **an `ensure*` that guards on
  one element must never be the thing that creates another.** The `search-bar-parts` suite now
  covers the lightbox too.

---

## [1.68.1] — 2026-08-26

### Fixed
- **Liking really works now.** v1.68.0 called `/rest/media/post/like`, which answers `200` and
  **does nothing** — caught by liking a post through it and re-reading the post, which came back
  unliked. Grok moved likes into collections: every account has a default collection named
  "Liked", and the heart adds to or removes from it via
  `/rest/media/collection/assets/{add,remove}` with `{ collectionId, assetIds }`. The collection
  id is resolved once from `collection/list` (by `isDefault`, falling back to the name) and
  cached.

  Both endpoints report `addedCount` / `removedCount`, so a call that changed nothing is
  distinguishable from one that did — the exact failure mode that made the previous attempt look
  like it had worked.

### Tooling
- 26 more assertions across the `liked` and `delete` suites, 573 total. Three mutations, including
  one that reports a no-op as a real change and one that picks the wrong collection.

---

## [1.68.0] — 2026-08-26

### Added
- **Delete**, in three places: **Delete selected** in the results panel, a **Delete** button in the
  lightbox, and *Delete…* in the right-click menu. All three go through one confirmation that
  names the exact count and says the action is permanent, with **Cancel focused** so a stray Enter
  cannot confirm it.

  A row only leaves the index once the server has accepted the delete. If a delete fails the row
  stays, because hiding media that still exists would misrepresent what the account holds. An
  item that was *already* gone (404) counts as done; a 403 or 500 does not.
- **Like button in the lightbox** alongside Delete, and the heart moved to the **top-right** of
  each card. The child/variation marker moves to the bottom-left to make room.

### Fixed
- **Liking works out of the box.** It required `tools/capture-like.js` to have been run first, and
  without a stored template the buttons just said so — which is why liking appeared broken. The
  real endpoints are now built in. A captured template still overrides them if a deployment
  differs.

### On how the endpoints were found
- `POST /rest/media/post/like`, `/unlike` and `/delete` all take `{ id }`. That was established by
  probing each with a UUID that cannot exist: the wrong field name still reports the field as
  missing, while the right one gets past validation and answers 404. So the shapes are known
  rather than guessed, and **nothing real was touched to learn them**.

### Tooling
- New `delete` suite: 43 assertions on consent and on never removing a row the server kept. 547
  total. Three mutations — proceeding without consent, removing rows regardless of the response,
  and counting a 403 as success — confirm it fails when any of those safety properties break.

---

## [1.67.2] — 2026-08-26

### Fixed
- **Grok's stock character assets were being indexed.** `Lena-Picture.png`, `Michael-Voice.mp3`
  and friends are copied into every account (`auxKeys.duplicated_from_asset_id` points at the
  original) and carry no `mediaGenInput`, so they appeared as blank cards nobody had made — and
  one of them is an `audio/mpeg` file rendered into an `<img>`, which can only ever be empty.
  `parseAsset()` now skips any asset flagged `imagine_official_asset: "true"` or whose MIME type
  is not `image/*` or `video/*`, and the reconciliation walk applies the same rule so **Verify**
  clears out the ones already indexed.

  Checked against 900 live assets: 8 matched, every one a stock `*-Voice.mp3` / `*-Picture.png`,
  and no ordinary generated image was caught. Deliberately **not** used as signals: a missing
  `mediaGenInput`, which would also drop the user's own uploads, and the `.../content` URL shape,
  which 4,231 perfectly good rows in a real index also use.

### Tooling
- 14 more assertions in the `assets` suite, 504 total. Three mutations confirm it, including one
  that keys the stock check on the flag being *present* rather than being `"true"` — the values
  are strings, and `"false"` is common.

---

## [1.67.1] — 2026-08-26

Two display faults, both long-standing rather than new, and both reported together because they
have the same trigger: *Results only* being off.

### Fixed
- **Collapsing the search bar destroyed the *Results only* preference.** `setSearchBarExpanded()`
  forces the flag off while collapsed, and it used to save the flag to storage first. But
  `ensureSearchBarToggle()` runs on every init, including the re-inits an SPA navigation triggers
  — so the first collapse stored the real preference and the *next* init, with the flag already
  forced off, overwrote it with `'0'`. Expanding restored that `'0'`, and from then on the script
  rendered **nothing until a filter was typed**. Only the checkbox handler writes the key now,
  because only a click is a preference.
- **The inline results viewport had no background.** It is `position: fixed` above Grok's own
  page, so with *Results only* off the results and the page underneath interleaved. It now paints
  its own surface, matching the results panel.

### Tooling
- New `search-bar-state` suite: 23 assertions, including a five-cycle collapse/expand round trip
  in both directions. 490 total. Two mutations — restoring the write-back, and removing the
  background — confirm it fails when either regresses.

---

## [1.67.0] — 2026-08-26

Newly generated images are indexed again. Diagnosed by driving a real logged-in browser rather
than reasoning about the code.

**Grok moved Imagine's library off the API this script was built on.** `/rest/media/post/list`
still answers, but it is unordered (two identical calls return different samples), it returns no
child trees, and nothing created since roughly June 2026 appears in it at all. The current UI
paginates `/rest/assets` instead, and that is what the script now walks.

### Added
- **`/rest/assets` is the primary feed.** `GET /rest/assets?pageSize=60&orderBy=ORDER_BY_CREATE_TIME&workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`
  is genuinely ordered newest-first and reaches the current day. Each row already carries the
  prompt and model in `mediaGenInput`, and the media URL is the asset's storage `key` under
  `assets.grok.com`, so indexing costs **one request per 60 items and nothing per item** — where
  the old path needed a `post/get` per parent.
  `assetId` is the same id space as a media post id, so these rows merge with existing ones
  instead of duplicating them.
- Because the feed is ordered, the routine sync stops once `ASSETS_SYNC_STALE_PAGES` (3)
  consecutive pages contain nothing new. A full reindex walks it to the end.
- `conversationId` on every row. Siblings of one generation share it — an average of 4.8 assets
  per generation, up to 41 — which is the grouping the asset feed offers in place of a
  parent/child tree.

### Changed
- The old list pass still runs, for the child trees it has and the asset feed does not. Rows it
  created keep their child links, denormalized prompts and like state when the asset feed
  refreshes them.
- **Reconciliation now walks both feeds** before deleting anything, and refuses to delete at all
  if the asset walk fails. Without that it would have considered every asset-feed row missing —
  the list walk cannot see recent media — and tried to delete it.

### Note on the source probe
- `filter.source` on the old endpoint is **ignored**, not honoured: `sort: "BANANA"` behaves
  exactly like `sort: "CREATE_TIME_DESC"`, and every invented `MEDIA_POST_SOURCE_*` returns 200.
  The v1.66.0 probe was therefore comparing twelve identical requests, and its "beyond likes"
  ranking picked `(none)` — unordered and childless — over `MEDIA_SOURCE_LIKED`. It no longer
  matters which it picks, because the asset feed is what reaches current media.

### Tooling
- New `assets` suite: 52 assertions covering parsing, the ordered early stop, merge-onto-existing,
  and the reconcile safety property. 467 total. Three mutations — stopping after one stale page,
  reconcile ignoring the asset feed, and an unencoded storage key — confirm it fails when broken.

---

## [1.66.2] — 2026-08-26

### Fixed
- ***Liked only* matched nothing.** `detectLikedState()` sniffs a list of candidate field names,
  and the one Grok actually sends — `userInteractionStatus.likeStatus` — was not on it. Every post
  therefore detected as `null` (unknown), which the filter deliberately excludes, so the result was
  always empty. Confirmed against a live API response rather than guessed.

### Known issue
- **Media created since roughly June 2026 is not reachable through `/rest/media/post/list` at all**,
  so it cannot be indexed yet. See the note under Unreleased.

---

## [1.66.1] — 2026-08-26

Found by driving a real browser: the installed script was three releases behind, and two reasons
why were sitting in the repo.

`grokPostSidebar.js` goes to **1.3.1** for the same header fix.

### Fixed
- **Neither userscript declared `@updateURL` / `@downloadURL`**, so Tampermonkey never checked for
  updates. Every release needed a manual copy-paste, and an install could sit frozen for months
  while the repo moved on — which is exactly what had happened. Both headers now point at the raw
  files on `main`, and the README install steps use links Tampermonkey can install from.
  *This only helps installs made from v1.66.1 onward; a script already pasted in by hand has to be
  reinstalled once from those links.*
- **A freshly built search bar was missing Import JSON and Verify.** `buildSearchBar()` has two
  paths — upgrade a bar an older version left in the DOM, or build one from the template — and they
  ran different lists of `ensure*` calls. Neither button is in the template, so on a clean install
  they never appeared and there was no way to run a reconciliation sweep at all. Both paths now run
  a single `ensureSearchBarParts()`.

### Changed
- **Both scripts are renamed to `grokSearch.user.js` / `grokPostSidebar.user.js`.** Tampermonkey
  only offers to install a URL whose filename ends in `.user.js`, so without it the install links
  above just show source. Existing bookmarks to the old raw paths will 404 — use the links in the
  README.

### Tooling
- New `search-bar-parts` suite (16 assertions, 413 total). It asserts the two build paths inject
  the *same set* of controls rather than checking for particular buttons, so it catches the next
  one too. Confirmed to fail against the bug it was written for.

---

## [1.66.0] — 2026-08-26

Two reported bugs: images that were never liked still were not being indexed, and collapsing the
search bar left the Grok page blank until a reload.

### Fixed
- **Collapsing the search bar left the page blank.** Un-hiding Grok's own grid re-derived the
  element by searching for `[class*="media-post-masonry-card"]` — but React drops those cards while
  their container is `display: none`, so the lookup found nothing, the un-hide was skipped, and the
  inline `display: none !important` survived until a reload. Hidden elements now carry a marker and
  are restored through it, so the restore cannot depend on finding them again. `updateDisplayMode()`
  also drops every mode class while the bar is collapsed — `grok-custom-results-mode` alone keeps
  the native grid hidden through CSS.
- **The source probe kept choosing a likes-only source.** It ranked candidates by the newest
  `createTime` in their first few items, which cannot work: the feed is ordered by *interaction*
  time, so every candidate shows the same recently touched posts at its head and reports the same
  newest date. It now samples 50 items, takes the liked feed as a baseline, and scores each
  candidate on how many ids it returns that the liked feed does not — an actual test of "is this
  broader than my likes".

### Added
- **`tools/capture-list.js`.** If no source enum reaches past your likes, guessing cannot fix it.
  This records the request Grok's own library view sends and stores it as a template, which
  `fetchPage()` then replays instead of guessing — the same "capture the real request, never invent
  one" rule the like button follows. Response parsing became tolerant of different key names for
  the post array and the cursor, since a captured request may hit a different endpoint.
- **The script now says when the index can only hold likes**, in the console and in the status bar,
  and names the tool to fix it. Silence is what made this so hard to see: everything looked
  healthy, the feed simply did not contain the posts.

### Tooling
- 75 new assertions across two suites: `feed` (template replay, response shapes, probe ranking) and
  `native-visibility` (hide/restore against an attribute-aware fake DOM). 397 total. Three
  mutations — restoring the old un-hide, the old probe ranking, and ignoring the template — confirm
  each suite fails when the behaviour it covers is broken.

---

## [1.65.0] — 2026-08-25

Bulk downloads can now be stopped and resumed, downloaded images carry the whole index record
rather than just the prompt, and a variation of a variation is finally indexed as one.

No reindex is required. `rootId` is derived from the existing `parentId` when the index loads, and
real tree edges are rewritten as each post is deep-refreshed.

### Added
- **Cancel** during a bulk download. It stops the run and aborts the request already in flight, so
  it takes effect immediately rather than after the current file.
- **Retry N files** after a run that did not finish. It downloads only what is left, into the
  **same folder** — no second folder prompt. Everything still queued when Cancel landed goes into
  the retry, including the file that was interrupted, so a large export can be stopped and resumed.
- **Per-file retry.** Each file is attempted up to three times with a growing delay before it counts
  as failed. A single flaky response no longer costs the image.
- **WebP metadata.** A plain WebP is rewritten into the extended (VP8X) container so it has
  somewhere to hold metadata, then given an `EXIF` chunk and an `XMP ` packet. Re-tagging an
  already-tagged file replaces its metadata rather than appending a second copy.
- **Full metadata in every downloaded image**, not just the prompt: `Software`, `Artist`, `Make`,
  `Model`, the creation timestamps, `ImageUniqueID`, the Windows `XP*` tags that Explorer shows,
  and a JSON blob in `UserComment` holding the entire record — ids, both ancestor prompts, model,
  like state, child counts, media URL and the post permalink. PNG gains `Title`, `Author`,
  `Software`, `Source`, `Creation Time`, `Comment`, plus the `prompt` and `parameters` keys AI
  image tools read; prompts outside Latin-1 are written as `iTXt` instead of `tEXt`.
- **Open original post** in the context menu, for a variation whose parent is itself a variation.

### Changed
- **Grandchildren keep their real parent (schema v5).** Every descendant used to be parented
  straight onto the top-level post, so a variation of a variation claimed the original as its
  parent. `parentId` is now the immediate parent and a new `rootId` names the post that owns the
  tree. A mid-tree row also reports its own descendant counts, which is what makes **Download all**
  and the variation badge work from it.
- `rootPrompt` is stored on deeper descendants (only when it differs from `parentPrompt`, so a
  first-generation variation costs nothing) and joins the search text, so searching the original
  wording still finds variations several generations down.
- Child pruning is scoped to the owning root rather than the immediate parent, so an orphaned
  branch is removed as a whole.
- The bulk-download confirm dialog mentions that the run can be cancelled and resumed.
- The count row in both bars wraps instead of overflowing, since Cancel and Retry join it mid-run.

### Fixed
- **PNG text chunks had a wrong CRC.** The table-driven CRC32 shifted by 1 instead of 8, so every
  `tEXt` chunk the script has ever written carried a bad checksum. Browsers ignore a bad CRC on an
  ancillary chunk, which is why it went unnoticed, but strict readers drop the chunk — meaning the
  prompt was silently unreadable in some tools. Found by the new test suite.
- `backfillChildParentPrompts()` built its lookup from top-level posts only, so a grandchild's
  parent prompt was unresolvable. It now indexes every row, and an orphan keeps the text it already
  carries instead of having it blanked.
- `getAllDescendantPosts()` guards against a cycle in the parent graph.

### Tooling
- 198 new assertions across three suites: image metadata (`metadata`), tree edges
  (`grandchildren`), and downloads (`download`). 322 total. Five mutations were used to confirm
  each suite fails when the behaviour it covers is broken.

---

## [1.64.0] — 2026-08-25

Grok no longer requires a like for media to stay in history, so the index now covers the whole
library and likes become a filter rather than a precondition.

**Upgrading: click Reindex once.** An index built before this release contains liked posts only and
carries no like state. The script detects the older schema and says so.

### Added
- **Whole-library indexing.** The list source is no longer hardcoded to `MEDIA_POST_SOURCE_LIKED`.
  On first run and on every **Reindex** the script probes the candidate sources with a 5-item query
  each, keeps whichever returns the most recent media, and caches that for a week. Pin one by hand
  with `localStorage.setItem('grokSearchMediaSource', …)` if needed.
- **Liked only** filter, and `isLiked` on every indexed row (schema v4). A post whose like state the
  feed does not report is stored as `null` — unknown, never silently "not liked" — and is excluded
  from *Liked only* rather than guessed at.
- **Like / unlike from every view**: a heart on each result card (visible on hover, always visible
  when liked), a **Like** button in the lightbox, and a **Like/Unlike** entry in the right-click
  menu. The toggle is optimistic and reverts if the request fails.
- `tools/capture-like.js` — records the like request Grok's own UI sends and stores it as a
  template, so the script replays a real request instead of an invented endpoint. Liking stays
  disabled, and says so, until this has been run once.

### Changed
- Index schema is **v4** (adds `isLiked`); the JSON export includes it.
- **Clear** also resets the liked filter.

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