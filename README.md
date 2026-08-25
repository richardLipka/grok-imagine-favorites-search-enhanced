# Grok Imagine Favorites Search (Enhanced Fork)

Tampermonkey userscripts that add **full-text search**, **filters**, **downloads**, and **offline indexing** to your liked media on [Grok Imagine](https://grok.com/imagine), plus an optional **post detail sidebar**.

This repository is an **enhanced fork** of the original *Grok Imagine Favorites Search + Saved Item Pass-Through* idea (author **AnnaLynn**), extended with incremental sync, child-post indexing, lightbox preview, bulk downloads, and related improvements by **Richard Lipka**.

**Repository:** [github.com/richardLipka/grok-imagine-favorites-search-enhanced](https://github.com/richardLipka/grok-imagine-favorites-search-enhanced)  
**Current versions:** `grokSearch.js` **v1.62** · `grokPostSidebar.js` **v1.3.0**  
See **[CHANGELOG.md](CHANGELOG.md)** for release history.

## Fork lineage

| Source | Notes |
|--------|--------|
| [AnnaLynn — Grok Imagine Favorites Search](https://greasyfork.org/en/scripts/570473-grok-imagine-favorites-search-saved-item-pass-through) | Original userscript concept (Greasy Fork) |
| [IronSniper1 — Grok-imagine-favorite-image-search](https://github.com/ironsniper1/Grok-imagine-favorite-image-search) | **Upstream GitHub fork** this project is based on |
| **This repo** | Enhanced fork: `grokSearch.js` v1.62 + `grokPostSidebar.js` v1.3.0 |

## What is included

| File | Runs on | Purpose |
|------|---------|---------|
| **`grokSearch.js`** | `https://grok.com/imagine*` (not post detail URLs) | Search bar, IndexedDB index, results grid/panel, sync, downloads |
| **`grokPostSidebar.js`** | `https://grok.com/imagine/post/*` | Collapsible sidebar: metadata + prompt on post pages |

Both scripts share the same IndexedDB database: **`GrokSearchIndex`**.

---

## Requirements

- **Chrome or Edge** recommended (bulk **Download selected** uses the folder picker API)
- Firefox works for search/sync; folder bulk-download may be unavailable
- [Tampermonkey](https://www.tampermonkey.net/) (v4+)
- A Grok account with **liked** Imagine posts
- Logged in at `grok.com`
- Network access to **jsDelivr** on first run (loads `piexifjs` for EXIF tagging)

### Tampermonkey (Chrome / Edge)

1. Open `chrome://extensions` → Tampermonkey → **Details**
2. Enable **Allow User Scripts** (required for `@grant GM_xmlhttpRequest` and `unsafeWindow`)
3. Optional: **Allow in Incognito** if you use private windows

---

## Installation

### Option A — Install from this repo (recommended)

1. Install Tampermonkey (see above).
2. Open **`grokSearch.js`** on GitHub → **Raw** → copy all contents.  
   Tampermonkey → **Create new script** → paste → **Save**.
3. Repeat for **`grokPostSidebar.js`** if you want the post sidebar.
4. Hard-refresh `https://grok.com/imagine` (Ctrl+Shift+R).

**Install from GitHub (raw scripts):**

- Search: `https://github.com/richardLipka/grok-imagine-favorites-search-enhanced/raw/main/grokSearch.js`
- Sidebar: `https://github.com/richardLipka/grok-imagine-favorites-search-enhanced/raw/main/grokPostSidebar.js`

### Option B — Clone and copy locally

```bash
git clone https://github.com/richardLipka/grok-imagine-favorites-search-enhanced.git
```

Copy each `.js` file into Tampermonkey as in option A.

---

## Publishing / fork relationship

This project is maintained as a **GitHub fork** of [ironsniper1/Grok-imagine-favorite-image-search](https://github.com/ironsniper1/Grok-imagine-favorite-image-search).

**One-time setup (maintainer):**

1. On GitHub, open the upstream repo and click **Fork** (creates a fork under your account).
2. In the fork’s **Settings → General**, rename the repository to `grok-imagine-favorites-search-enhanced` if desired (fork parent link is kept).
3. From this folder:

```bash
git remote add upstream https://github.com/ironsniper1/Grok-imagine-favorite-image-search.git
git remote add origin https://github.com/richardLipka/grok-imagine-favorites-search-enhanced.git
git push -u origin master:main   # first publish only; later: git push
```

4. On GitHub, set the default branch to `main` if prompted.

To pull upstream README/license changes later: `git fetch upstream` then merge or cherry-pick as needed (histories may differ).

---

## First run

1. Go to **https://grok.com/imagine** (saved / liked view).
2. A floating search bar appears at the top; a **toggle** sits at the bottom-right.
3. **First visit** (empty index): status shows `first-time indexing…` then `N indexed`. This walks the liked API and fills IndexedDB.
4. **Later visits**: `cached` → `syncing…` → `up to date` or `+N new, M updated` (incremental sync, no full reindex).

Indexing time depends on library size. Leave the tab open until the status finishes.

---

## Using search (`grokSearch.js`)

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
| **Per page / Size** | Pagination size (1–300) and thumbnail scale (10–200%) |
| **Default** | Reset to 44 per page, 100% size |
| **Sort** | Newest or oldest |
| **Clear** | Clears text, dates, and media filters |
| **Download selected** | In the match-count area — save checked images to a folder (Chrome/Edge) |
| **Export JSON** | Download full index (schema v3, parents + children) |
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

- Click the **bottom-right** button to hide the bar (only the toggle stays).
- **Results only** turns off while hidden; native Grok grid shows.
- **Ctrl/Cmd+F** expands the bar and focuses search.

### Results

- **Left-click** a card → **lightbox** over current matched results (←/→ inside lightbox, **Download** in footer, Esc to close).
- **Right-click** a card → context menu: Open, open in new tab, copy prompt/URL, download image/video, download all child posts (parents with children), filter to date, open parent (child rows).
- **Checkbox** (top-left, subtle until hover/selected) → select for **Download selected**.
- **Date badge** (top center) → filter to that day (click again to clear).
- **Parent** cards: video / descendant image badges (counts include **all generations** in `childPosts` tree).
- **Child** cards: purple **child** icon (top-right), own date badge.
- **← / →** keys page results when the search box is not focused and the lightbox is closed.

### Downloads and metadata

| Action | Behavior |
|--------|----------|
| Context menu → **Download image** / **Download video** | Single file via browser download |
| Context menu → **Download all** | All child/descendant posts to a folder (parents with children only) |
| Lightbox → **Download** | Same single-file download for the current image or video |
| **Download selected** | Pick a folder once; files saved as `grok-{id}.{ext}` one by one; progress in toolbar and panel |
| **> 5 selected** | Custom confirm dialog: *“This will take some time. You selected N images.”* |
| Image downloads | Prompt embedded in **JPEG EXIF** (`ImageDescription`, `UserComment`) and **PNG** `Description` text chunk |
| Videos | Downloaded without EXIF changes |

Long prompts are trimmed (~2000 chars). WebP is not tagged yet. If tagging fails, the file still downloads.

### Keyboard

| Key | Action |
|-----|--------|
| Ctrl/Cmd+F | Show search bar + focus input |
| Esc | Close lightbox, bulk-download confirm, or context menu; blur search input when focused |
| ← / → | Lightbox prev/next when open; otherwise previous/next results page |

---

## Post sidebar (`grokPostSidebar.js`)

On `https://grok.com/imagine/post/{uuid}`:

- Shows **prompt**, post ID, date, model, type, child/video counts.
- Uses IndexedDB when available, else Grok **post/get** API.
- Collapsible like the search bar (bottom-right toggle).

Install together with `grokSearch.js` so the index is shared.

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
early — the next sync picks up where it left off.

---

## IndexedDB

- **Database:** `GrokSearchIndex` / store `posts`
- **Schema version (export):** 3  
- **Typical fields:** `id`, `prompt`, `parentPrompt`, `parentId`, `isChild`, `thumbnail`, `mediaUrl`, `createTime`, `model`, `mediaType`, counts, optional `metadataRefreshedAt`

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
| Script errors / no API | Enable **Allow User Scripts** in Tampermonkey |
| Stale counts or missing children | Wait for sync or click **Reindex** once |
| **Download selected** does nothing / no folder picker | Use Chrome or Edge; must click the button (user gesture) |
| No **Check all** / **Download data** | Turn on **Results only** or use the results panel header |
| EXIF not in downloaded file | JPEG/PNG only; check file type; see browser console for `[GrokSearch]` warnings |
| `piexif` / CDN blocked | Allow `cdn.jsdelivr.net` or reinstall script so `@require` can load |
| Video/child filters still show child cards | **With video** / **With child** are parents-only; **Video only** includes child video rows; use **Hide childs** to drop child rows |
| Greasy Fork + this script | Use **one** search script to avoid conflicts |

---

## Privacy

Scripts run **only in your browser**. API calls go to **`grok.com`** (your session cookies). IndexedDB stays local. On first run, Tampermonkey may fetch **`piexifjs`** from **jsDelivr** (`cdn.jsdelivr.net`) for EXIF embedding. No other third-party analytics in these files.

---

## Disclaimer

Unofficial tool, not affiliated with xAI / Grok. Internal APIs may change and break the script.

---

## License

MIT — see [LICENSE](LICENSE). Please keep attribution links to this repo and the original authors when redistributing.