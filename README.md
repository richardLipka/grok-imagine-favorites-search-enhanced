# Grok Imagine Favorites Search (Enhanced)

Tampermonkey userscripts that add **full-text search**, **filters**, **downloads**, and **offline indexing** to your media library on [Grok Imagine](https://grok.com/imagine), plus an optional **post detail sidebar**.

A standalone project by **Richard Lipka**, grown from [IronSniper1's](https://github.com/ironsniper1/Grok-imagine-favorite-image-search) base script and extended with incremental sync, child-post indexing, lightbox preview, bulk downloads, deletion, and much else — see [Credits and origins](#credits-and-origins).

**Repository:** [github.com/richardLipka/grok-imagine-favorites-search-enhanced](https://github.com/richardLipka/grok-imagine-favorites-search-enhanced)  
**Current versions:** `grokSearch.user.js` **v1.69.5** · `grokPostSidebar.user.js` **v1.3.2**  
See **[CHANGELOG.md](CHANGELOG.md)** for release history.

## Credits and origins

This is now a **standalone repository**, but it began as a fork and the earlier work deserves the
credit.

| Source | Created | Contribution |
|--------|---------|--------------|
| [IronSniper1 — Grok-imagine-favorite-image-search](https://github.com/ironsniper1/Grok-imagine-favorite-image-search) | 2026-03-07 | **The base this repository was forked from.** |
| [Strapples — Grok Imagine Favorites Search (Greasy Fork)](https://greasyfork.org/en/scripts/570473-grok-imagine-favorites-search-saved-item-pass-through) · [GrokImagineSearchandOrganize](https://github.com/Strapples/GrokImagineSearchandOrganize) | 2026-03-20 | A parallel userscript, also forked from IronSniper1. Its author asks that people link back to their GitHub, so it is linked here. |
| **This repo** | — | Everything since: `grokSearch.user.js` v1.69.5 + `grokPostSidebar.user.js` v1.3.2 |

Earlier versions of this README described the Greasy Fork script as the original and IronSniper1 as
downstream of it. That was the wrong way round: IronSniper1 came first, and the Greasy Fork script
says plainly that it was *"Forked from IronSniper1 — big thanks for making a usable base code for
this piece"*. The table above reflects what each source actually states.

Leaving GitHub's fork network is a hosting change only. It does not change where the code came
from, and this section is not to be removed.

## What is included

| File | Runs on | Purpose |
|------|---------|---------|
| **`grokSearch.user.js`** | `https://grok.com/imagine*` (not post detail URLs) | Search bar, IndexedDB index, results grid/panel, sync, downloads |
| **`grokPostSidebar.user.js`** | `https://grok.com/imagine/post/*` | Collapsible sidebar: metadata + prompt on post pages |

Both scripts share the same IndexedDB database: **`GrokSearchIndex`**.

> **Since v1.64.0 the index covers your whole library, not just likes.** Grok no longer requires a
> like for media to stay in history, so the script resolves the widest media source it can reach and
> indexes everything. Likes become a **filter** (*Liked only*) rather than a precondition, and you
> can like or unlike straight from the results grid, the lightbox, and the right-click menu.
>
> **Upgrading from an older version: click Reindex once.** An index built before v1.64.0 contains
> liked posts only and has no like state; the script detects this and says so.

---

## Requirements

- **Chrome or Edge** recommended (bulk **Download selected** uses the folder picker API)
- Firefox works for search/sync; folder bulk-download may be unavailable
- [Tampermonkey](https://www.tampermonkey.net/) (v4+)
- A Grok account with Imagine posts
- Logged in at `grok.com`
- Network access to **jsDelivr** on first run (loads `piexifjs` for EXIF tagging)

### Tampermonkey (Chrome / Edge)

1. Open `chrome://extensions` → Tampermonkey → **Details**
2. Enable **Allow User Scripts** (required for `@grant GM_xmlhttpRequest` and `unsafeWindow`)
3. Optional: **Allow in Incognito** if you use private windows

---

## Installation

### Option A — Install from this repo (recommended)

Open either link with Tampermonkey installed and it will offer to install the script directly:

- Search: **[install `grokSearch.user.js`](https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokSearch.user.js)**
- Sidebar: **[install `grokPostSidebar.user.js`](https://raw.githubusercontent.com/richardLipka/grok-imagine-favorites-search-enhanced/main/grokPostSidebar.user.js)**

Then hard-refresh `https://grok.com/imagine` (Ctrl+Shift+R).

Installed this way both scripts carry `@updateURL` / `@downloadURL`, so **Tampermonkey checks for
updates on its own**. Dashboard → **Utilities** → *Check for userscript updates* forces a check.

> **A script pasted in by hand never auto-updates**, whatever its `@version` says — Tampermonkey
> has no URL to poll. Releases up to v1.66.0 also shipped without those headers, so an install from
> before v1.66.1 is frozen wherever it landed. If your search bar is missing controls this README
> describes, that is why: install once from the links above (Tampermonkey replaces the existing
> script rather than adding a second copy) and future releases arrive on their own. To check what
> you are running, look at the version column in the Tampermonkey dashboard.

### Option B — Clone and copy locally

```bash
git clone https://github.com/richardLipka/grok-imagine-favorites-search-enhanced.git
```

Tampermonkey → **Create new script** → paste the file contents → **Save**. A script
installed this way will **not** auto-update — use option A unless you are editing the code.

---

## Repository

Standalone, with a single remote:

```bash
git remote -v   # origin  https://github.com/richardLipka/grok-imagine-favorites-search-enhanced.git
```

The default branch is `main`. Releases are annotated tags (`git tag -a vX.Y.Z`); there are no
GitHub Releases, so the tag *is* the release. There is no `upstream` remote and nothing to merge
from one — the code has diverged completely from where it started.

---

## First run

1. Go to **https://grok.com/imagine** (saved / liked view).
2. A floating search bar appears at the top; a **toggle** sits at the bottom-right.
3. **First visit** (empty index): status shows `first-time indexing…` then `N indexed`. This walks the liked API and fills IndexedDB.
4. **Later visits**: `cached` → `syncing…` → `up to date` or `+N new, M updated` (incremental sync, no full reindex).

Indexing time depends on library size. Leave the tab open until the status finishes.

---

## Using search (`grokSearch.user.js`)

### Search bar

| Control | Action |
|---------|--------|
| Text field | **AND** search on prompt (parents); child rows also match **parent prompt** (`parentPrompt`). Filters **400 ms** after you stop typing. |
| **From / To** dates | Filter by post date (child cards use **their own** date) |
| **‹ / ›** (beside dates) | Previous / next day — **only** when a **single day** is selected (same From and To) |
| **Results only** | Hide Grok’s native grid; show paginated results panel (when bar is visible) |
| **Video only** | Show only video posts (parent or child video rows; hides images) |
| **With video** | Parents only — image posts that have at least one video in child/descendant results |
| **With child** | Parents only; min descendant count (full tree, not just first generation) |
| **Hide childs** | Hide child post rows from results (show parents only) |
| **Liked only** | Show only posts you have liked (posts whose like state is unknown are excluded) |
| **Model** | Filter by generation model; the list is built from the models present in your index (hidden when none are recorded) |
| **Per page / Size** | Pagination size (1–300) and thumbnail scale (10–200%) |
| **Compact** | Fold child results into their parent’s card as a thumbnail strip, one card per family (see [Compact groups](#compact-groups)) |
| **Button** | Which corner the show/hide button sits in — top right (default), bottom right, top left, bottom left |
| **Default** | Reset to 44 per page, 100% size, **Compact** off, button in the top-right corner |
| **Sort** | Newest or oldest (remembered between sessions) |
| **Clear** | Clears text, dates, model, liked, and media filters |
| **Download selected** | In the match-count area — save checked images to a folder (Chrome/Edge) |
| **Import JSON** | Merge a previously exported index file back in (adds and updates; never deletes) |
| **Export JSON** | Download full index (schema v5, parents + children) |
| **Verify** | Reconcile the index against the feed — removes posts that are gone and repairs anything a truncated sync missed |
| **Reindex** | Clear DB and rebuild from API (use after upgrades or bad cache) |

### Results panel header

Shown when **Results only** is on (default). These controls are **not** in the search bar:

| Control | Action |
|---------|--------|
| **Download data** | Export **current matched results** as JSON (active filters + row metadata) |
| **Download selected** | Same as toolbar — folder bulk download with progress under “Search results” |
| **Check all** | Select every item in the current filter/match set (all pages) |
| **Clear selection** | Uncheck all selected items |

> Selections **persist across filter changes** — searching or changing dates after checking
> items no longer clears them. **Download selected** saves everything currently checked, not
> just the items matching the active filter; use **Clear selection** to start over.

> **Inline mode** (`Results only` off): the panel is hidden, so **Download data**, **Check all**, and **Clear selection** are unavailable. Use **Download selected** from the search bar or turn **Results only** back on.

### Collapsed search bar

- Click the **show/hide** button to hide the bar (only that button stays). It sits in the
  **top right** by default, below Grok’s own header controls so it does not cover them, and
  **Button** in the display row moves it to any corner. On viewports narrower than 1040px the
  top corners fall back to the bottom, because the search bar itself reaches the right edge there.
- **Results only** turns off while hidden; native Grok grid shows.
- **Ctrl/Cmd+F** expands the bar and focuses search.

### Results

- **Left-click** a card → **lightbox** over current matched results (←/→ inside lightbox, **Download** in footer, Esc to close).
- **Right-click** a card → context menu: Open, open in new tab, copy prompt/URL, download image/video, download all descendants, filter to date, open parent (child rows), open original (variations of a variation).
- **Checkbox** (top-left, subtle until hover/selected) → select for **Download selected**.
- **Date badge** (top center) → filter to that day (click again to clear).
- **Parent** cards: video / descendant image badges (counts include **all generations** in `childPosts` tree).
- **Child** cards: purple **child** icon (bottom-left), own date badge. A variation that has variations of its own shows its **own** counts, so **Download all** works from it too.
- **Video thumbnails**: video results automatically resolve to their parental image, root image, child image, or generation batch sibling image (`conversationId`) so video cards and strips are never blank.
- **← / →** keys page results when the search box is not focused and the lightbox is closed.

<a id="compact-groups"></a>

#### Compact groups

**Compact** (display row, off by default) gives each *family* one card instead of each post one
cell. A matched child is folded into the outermost matched ancestor above it and drawn as a thumbnail
in a strip under the parent image; anything past the first eight becomes a **+N** chip pinned to
the right of the strip.

- **Click a thumbnail** in the strip to open that child, not the parent. Right-click acts on the
  child too.
- **The parent’s checkbox selects the whole group**, because the folded children have no
  checkbox of their own — without that they could not be downloaded or deleted while compact.
- **Per page counts cards, not images**, so the match count reads e.g. `1,240 matches in 380
  groups` and there are fewer pages.
- Children with no matched ancestor (their parent is filtered out, or is not in the index) keep a
  cell of their own — nothing disappears.
- **Hide childs** and **Compact** are independent: *Hide childs* removes children from the
  results, *Compact* keeps them but folds them in.

#### Parent details

Open any post with descendants and the lightbox footer lists them under the prompt: *N child
results* followed by a thumbnail for each. Each thumbnail is a real link to that post’s page, so
ctrl-click or middle-click opens it in a new tab; a plain click moves the lightbox to that child
when it is in the current result set, and opens its page otherwise.

### Downloads and metadata

| Action | Behavior |
|--------|----------|
| Context menu → **Download image** / **Download video** | Single file via browser download |
| Context menu → **Download all** | Every descendant of the post to a folder — works from a variation too, not just the original |
| Lightbox → **Download** | Same single-file download for the current image or video |
| **Download selected** | Pick a folder once; files saved as `grok-{id}.{ext}` one by one; progress in toolbar and panel |
| **> 5 selected** | Custom confirm dialog naming the count, and noting that you can cancel and resume |
| **Cancel** | Appears while a bulk download runs. Stops it and aborts the file in flight |
| **Retry N files** | Appears after a run that did not finish. Downloads only what is left, into the **same folder** — no second folder prompt |
| Videos | Downloaded without metadata changes |

Each file is attempted up to **three times** with a growing delay before it counts as failed, so a
single flaky response does not cost you the image. Cancelling is not a failure: everything still
queued — including the file that was interrupted — goes into **Retry**, so a large export can be
stopped and resumed.

#### What is written into the file

Downloaded images carry everything the index knows about the post, so an exported folder stays
searchable after it leaves the browser.

| Format | Where it goes |
|--------|---------------|
| **JPEG** | EXIF — `ImageDescription`, `UserComment` (full JSON), `Software`, `Artist`, `Make`, `Model`, `DateTime` / `DateTimeOriginal` / `DateTimeDigitized`, `ImageUniqueID`, and the Windows `XPTitle` / `XPComment` / `XPKeywords` / `XPSubject` / `XPAuthor` tags Explorer shows |
| **PNG** | Text chunks — `Title`, `Description`, `Author`, `Software`, `Source`, `Creation Time`, `Comment` (full JSON), plus `prompt` and `parameters` for AI image tools. UTF-8 prompts use `iTXt`, the rest `tEXt` |
| **WebP** | An `EXIF` chunk with the same tags as JPEG, plus an `XMP ` packet (`dc:description`, `dc:title`, `dc:creator`, `dc:subject`, `xmp:CreateDate`). A plain WebP is rewritten into the extended container so it has somewhere to put them |
| **MP4 / video** | Untouched |

The JSON blob in `UserComment` / `Comment` holds the whole record: post id, prompt, parent and
original prompts, `parentId` / `rootId`, creation time, model, media type, like state, child
counts, media URL, and the post's permalink.

Long prompts are trimmed (~4000 chars, so the tags fit inside a JPEG's 64 KB EXIF segment). Re-tagging an already-tagged WebP
replaces its metadata rather than appending to it. If tagging fails for any reason the file still
downloads, untagged.

### Keyboard

| Key | Action |
|-----|--------|
| Ctrl/Cmd+F | Show search bar + focus input |
| Esc | Close lightbox, bulk-download confirm, or context menu; blur search input when focused |
| ← / → | Lightbox prev/next when open; otherwise previous/next results page |

---

## Post sidebar (`grokPostSidebar.user.js`)

On `https://grok.com/imagine/post/{uuid}`:

- Shows **prompt**, post ID, date, model, type, child/video counts.
- Uses IndexedDB when available, else Grok **post/get** API.
- Collapsible like the search bar (bottom-right toggle).

Install together with `grokSearch.user.js` so the index is shared.

---

## How sync works (no reindex needed for daily use)

| Event | Behavior |
|-------|----------|
| Page load | Load cache → fetch new likes → refresh recent metadata |
| Tab focus | Incremental sync (rate-limited, 60 s) |
| Return from post page | Sync after navigation (rate-limited, 15 s) |
| **Reindex** button | Full rebuild (only when you need everything refreshed) |

Child posts are stored as **separate rows** (`isChild: true`, `parentId`, `parentPrompt` for search).

New **child posts** (variations and videos generated from a post you already have) are picked up
two ways: from the `childPosts` tree on the first few liked-list pages, and from a rotating deep
refresh that re-reads recent posts via the post API. Each post is deep-refreshed at most once
every 10 minutes, so a sync right after a quiet one issues no extra requests. If a status ever
reads `sync incomplete — check connection`, the walk hit a network or auth error and stopped
early — the next sync picks up where it left off. Rate-limited responses are retried with
backoff (`rate limited — retrying…`).

### Verify (index reconciliation)

Incremental sync only looks at the first few pages of the liked feed and never deletes, so posts you
**unlike** would otherwise stay in the index forever. **Verify** closes that gap — it walks the whole
feed collecting ids only, then makes the index match. It also repairs anything a sync that stopped
early left behind.

| | |
|--|--|
| Cost | One list request per 40 posts. No `post/get`, no metadata re-parsing. |
| When | Automatically at most once every 24 hours, or on demand via the **Verify** button. |
| Safety | Deletions apply only if the walk finishes; a sweep that would delete more than half the index is refused and logged instead. |

Use **Reindex** only when you want everything rebuilt from scratch; **Verify** is the cheap
routine option.

### Liking from the script

Every result card shows a **heart** on hover (always visible when the post is liked); the lightbox
has a **Like** button and the right-click menu a **Like/Unlike** entry. Clicking updates the card
immediately and reverts if the request fails.

**Liking needs a one-time setup.** Rather than guess at an undocumented endpoint, the script replays
the exact request Grok's own UI sends — so you have to record it once:

1. Open `https://grok.com/imagine` and open DevTools → Console.
2. Paste [`tools/capture-like.js`](tools/capture-like.js) and press Enter.
3. Click **Grok's own** like button on any image (not the script's heart).
4. It prints `✓ Captured` and stops. Reload the page.

The capture only observes — it sends nothing itself. Until it has run, the like controls are
disabled and say so. To undo: `localStorage.removeItem('grokSearchLikeRequest')`.

### Which media source is used

Grok's list endpoint takes a `source` filter, and the value covering your whole library is
undocumented and has changed over time. On first run (and on every **Reindex**) the script probes the
candidates with a 5-item query each and keeps whichever returns the most recent media, caching the
result for a week. The choice is logged to the console as `Using media source: …`.

If it picks badly, force a re-probe with **Reindex**, or pin one by hand:

```javascript
localStorage.setItem('grokSearchMediaSource', 'MEDIA_POST_SOURCE_LIKED'); // or '(none)' for no filter
```

### Where the index comes from

Since v1.67.0 the script reads **`/rest/assets`**, which is what Grok's own library view
paginates. It is ordered newest-first, reaches the current day, and carries the prompt and model
inline — so a sync costs one request per 60 images and nothing per image.

The older `/rest/media/post/list` endpoint is still walked afterwards, because it is the only
place child/variation trees are exposed. On its own it is not enough: it is unordered, and nothing
generated since roughly June 2026 appears in it at all. If you were missing recent images before
v1.67.0, that is why.

### Capturing the library request (rarely needed now)

`grokSearch.user.js` walks the same feed API Grok's own page uses, and asks it for the widest
`filter.source` it can find. That enum is undocumented, so the script probes for it — and if the
deployment only accepts likes-only values, **images you never liked cannot be reached at all**,
however the probe ranks them. You will see this in the console and the status bar:

```
[GrokSearch] No media source reached anything beyond your likes...
```

The fix is to stop guessing and record what Grok's own view actually sends:

1. Open `https://grok.com/imagine` and open DevTools (F12) → **Console**.
2. Paste the contents of [`tools/capture-list.js`](tools/capture-list.js) and press Enter.
3. **Scroll your library** so it loads more images. The tool keeps whichever request returned the
   most posts and prints what it stored.
4. Reload the page and click **Reindex**.

From then on the script replays that exact request instead of guessing, and the console says
`Replaying the library request captured by tools/capture-list.js`.

The tool only observes — it sends nothing itself, and stops on its own after two minutes (or call
`__grokFinishListCapture()` to stop sooner). To undo:

```javascript
localStorage.removeItem('grokSearchListRequest');
```

### Backing up the index

**Export JSON** writes the whole index to a file and **Import JSON** merges one back in — rows
in the file win for the ids it contains, and nothing is deleted. Use it as a backup, or to move
an index to another browser or machine. The script also asks the browser for **persistent
storage** so a large index is not evicted under storage pressure.

---

## IndexedDB

- **Database:** `GrokSearchIndex` / store `posts`
- **Schema version (export):** 5
- **Typical fields:** `id`, `prompt`, `parentPrompt`, `parentId`, `rootId`, `rootPrompt`, `isChild`, `thumbnail`, `mediaUrl`, `createTime`, `model`, `mediaType`, `isLiked`, counts, optional `metadataRefreshedAt`

`parentId` is the post a variation came from directly; `rootId` is the original at the top of the
tree. For a first-generation variation the two are the same. `rootPrompt` is only stored when it
differs from `parentPrompt`, so searching the original wording still finds variations several
generations deep.

Clear index (browser console on Imagine):

```javascript
indexedDB.deleteDatabase('GrokSearchIndex');
```

Then refresh and let the script re-index.

Check count:

```javascript
const req = indexedDB.open('GrokSearchIndex');
req.onsuccess = e => {
  const tx = e.target.result.transaction('posts', 'readonly');
  const store = tx.objectStore('posts');
  store.count().onsuccess = ev => console.log(ev.target.result, 'rows');
};
```

---

## Troubleshooting

| Issue | Try |
|-------|-----|
| No search bar | Tampermonkey on? On `/imagine` not `/imagine/post/...`? Hard refresh |
| Buttons this README describes are missing (**Verify**, **Import JSON**, **Liked only**, **Cancel**…) | You are running an older version. A hand-pasted script never auto-updates — reinstall from the links in [Installation](#option-a--install-from-this-repo-recommended), then check the version column in the Tampermonkey dashboard |
| Script errors / no API | Enable **Allow User Scripts** in Tampermonkey |
| Stale counts or missing children | Wait for sync, then click **Verify**; **Reindex** only if that does not help |
| Unliked posts still in results | Click **Verify** — incremental sync never removes rows |
| Like buttons disabled | Liking needs a one-time capture — run [`tools/capture-like.js`](tools/capture-like.js) once |
| Only liked posts are indexed | First click **Reindex**. If the console then says *No media source reached anything beyond your likes*, no enum works for your account — run [`tools/capture-list.js`](tools/capture-list.js), see [Capturing the library request](#capturing-the-library-request) |
| Status bar says *likes only — see tools/capture-list.js* | Exactly the above: the feed the script can reach contains only your likes |
| New images never appear, even after **Reindex** | Same cause. Check the console for the `Source probe` table — it lists every candidate and how many posts each returned beyond your likes |
| Grok's own page is blank after hiding the search bar | Fixed in v1.66.0; update the script. As a workaround, reload the page |
| **Liked only** hides posts you did like | Their like state is unknown (`null`) because the feed did not report it; **Reindex** refreshes it |
| Recent posts missing, even after **Reindex** | Check the **Model** dropdown reads *All models* — it is a saved preference, so **Reindex** does not clear it and posts made with any other model stay hidden. **Clear** resets it. Then run [`tools/diagnose.js`](tools/diagnose.js) in the console if they are still missing |
| A post you just liked is missing | If it is an older post it is not near the top of the feed; click **Verify** |
| **Verify** says *aborted — unexpected feed response* | It refused to delete more than half the index; check the console and retry later |
| **Import JSON** fails | The file must be an index export (an object with a `posts` array, or a bare array of rows) |
| **Download selected** does nothing / no folder picker | Use Chrome or Edge; must click the button (user gesture) |
| A bulk download is taking too long | Click **Cancel**, then **Retry N files** later — it resumes into the same folder without re-prompting |
| Some files failed | Click **Retry N files**. Each file already got three attempts, so a repeat failure usually means the media URL expired — run **Verify**, then retry |
| **Retry** button disappeared | It only survives while the page is open; the queue is not persisted. Re-select and download again |
| No **Check all** / **Download data** | Turn on **Results only** or use the results panel header |
| No metadata in a downloaded file | JPEG, PNG and WebP only — videos are never tagged. Check the browser console for `[GrokSearch]` warnings |
| A tool reads the prompt from JPEG but not PNG | Some readers only look at `tEXt`; a prompt with characters outside Latin-1 is written as `iTXt` instead. `exiftool` reads both |
| `piexif` / CDN blocked | Allow `cdn.jsdelivr.net` or reinstall script so `@require` can load |
| Video/child filters still show child cards | **With video** / **With child** are parents-only; **Video only** includes child video rows; use **Hide childs** to drop child rows |
| Greasy Fork + this script | Use **one** search script to avoid conflicts |

---

## Development

```bash
node test/run.js
```

No dependencies and no build step — the `.js` files are what ships. The suite runs the real sync,
index, rendering, download and image-metadata logic from `grokSearch.user.js` against stubs; see
[test/README.md](test/README.md). Anything needing a browser (IndexedDB, the folder picker, the
live SPA, CSS) still has to be checked by pasting the script into Tampermonkey.

---

## Privacy

Scripts run **only in your browser**. API calls go to **`grok.com`** (your session cookies). IndexedDB stays local. On first run, Tampermonkey may fetch **`piexifjs`** from **jsDelivr** (`cdn.jsdelivr.net`) for EXIF embedding. No other third-party analytics in these files.

---

## Disclaimer

Unofficial tool, not affiliated with xAI / Grok. Internal APIs may change and break the script.

---

## License

**GNU General Public License v3.0** — see [LICENSE](LICENSE).

```
Copyright (C) 2026 Richard Lipka
Copyright (C) 2026 IronSniper1
```

This project was forked from
[ironsniper1/Grok-imagine-favorite-image-search](https://github.com/ironsniper1/Grok-imagine-favorite-image-search),
whose `LICENSE` file is GPL-3.0. Its README separately says "MIT"; where the two disagree, this
project follows the **stricter** of the two rather than assuming the more convenient reading.

In practice that means: you may use, modify and redistribute this freely, but a modified version
you distribute must also be GPL-3.0 and ship its source.

`piexifjs`, loaded at runtime via `@require`, is MIT-licensed and is not part of this repository.
