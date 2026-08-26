# Changelog

All notable changes to this enhanced fork are documented here.  
Versions match the `@version` in each userscript header.

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

## [1.68.4] — 2026-08-26

### Added
- The running version is published as `data-grok-search-version` on `<html>`. Check what is
  actually installed with `document.documentElement.dataset.grokSearchVersion` in the console —
  without it, a stale Tampermonkey install is hard to tell apart from a fix that did not work,
  which cost real time chasing the lightbox buttons.

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

## Unreleased

Nothing here changes the installed userscripts — no version bump.

### Repository
- The repository left GitHub's fork network and is now standalone. The README's fork-setup
  instructions described adding an `upstream` remote and were long obsolete; they are replaced by
  a short **Repository** section.
- **Credit is unaffected and stays.** Leaving the fork network is a hosting change; it says nothing
  about where the idea came from. The old "Fork lineage" table is now **Credits and origins**,
  still naming AnnaLynn's original and the `ironsniper1` fork this was started from.

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