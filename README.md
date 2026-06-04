# Grok Imagine Favorites Search (Enhanced Fork)

Tampermonkey userscripts that add **full-text search**, **filters**, and **offline indexing** to your liked media on [Grok Imagine](https://grok.com/imagine), plus an optional **post detail sidebar**.

This repository is an **enhanced fork** of the original *Grok Imagine Favorites Search + Saved Item Pass-Through* idea (author **AnnaLynn**), extended with incremental sync, child-post indexing, collapsible UI, and related improvements by **Richard Lipka**.

## Fork lineage

| Source | Notes |
|--------|--------|
| [AnnaLynn — Grok Imagine Favorites Search](https://greasyfork.org/en/scripts/570473-grok-imagine-favorites-search-saved-item-pass-through) | Original userscript concept (Greasy Fork) |
| [IronSniper1 — Grok-imagine-favorite-image-search](https://github.com/ironsniper1/Grok-imagine-favorite-image-search) | Early GitHub fork in the same family |
| **This repo** | `grokSearch.js` v1.35 + `grokPostSidebar.js` v1.3 |

## What is included

| File | Runs on | Purpose |
|------|---------|---------|
| **`grokSearch.js`** | `https://grok.com/imagine*` (not post detail URLs) | Search bar, IndexedDB index, results grid/panel, sync |
| **`grokPostSidebar.js`** | `https://grok.com/imagine/post/*` | Collapsible sidebar: metadata + prompt on post pages |

Both scripts share the same IndexedDB database: **`GrokSearchIndex`**.

---

## Requirements

- A Chromium-based browser, Firefox, or Edge
- [Tampermonkey](https://www.tampermonkey.net/) (v4+)
- A Grok account with **liked** Imagine posts
- Logged in at `grok.com`

### Tampermonkey (Chrome / Edge)

1. Open `chrome://extensions` → Tampermonkey → **Details**
2. Enable **Allow User Scripts** (required for `@grant GM_xmlhttpRequest`)
3. Optional: **Allow in Incognito** if you use private windows

---

## Installation

### Option A — Install from this repo (recommended)

1. Install Tampermonkey (see above).
2. Open **`grokSearch.js`** on GitHub → **Raw** → copy all contents.  
   Tampermonkey → **Create new script** → paste → **Save**.
3. Repeat for **`grokPostSidebar.js`** if you want the post sidebar.
4. Hard-refresh `https://grok.com/imagine` (Ctrl+Shift+R).

Replace `YOUR_USER` / `YOUR_REPO` with your GitHub path once published:

- Search: `https://github.com/YOUR_USER/YOUR_REPO/raw/master/grokSearch.js`
- Sidebar: `https://github.com/YOUR_USER/YOUR_REPO/raw/master/grokPostSidebar.js`

### Option B — Clone and copy locally

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git
```

Copy each `.js` file into Tampermonkey as in option A.

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
| Text field | **AND** search on prompt (parents); child rows also match **parent prompt** (`parentPrompt`) |
| **From / To** dates | Filter by post date (child cards use **their own** date) |
| **‹ / ›** (beside dates) | Previous / next day — **only** when a **single day** is selected (same From and To) |
| **Results only** | Hide Grok’s native grid; show paginated results panel (when bar is visible) |
| **Only with video** | Parents only; min video count (includes all descendant videos on root) |
| **Only with child posts** | Parents only; min descendant count (full tree, not just first generation) |
| **Per page / Size** | Pagination size (1–300) and thumbnail scale (10–200%) |
| **Default** | Reset to 44 per page, 100% size |
| **Clear** | Clears text, dates, and media filters |
| **Export JSON** | Download full index (schema v3, parents + children) |
| **Reindex** | Clear DB and rebuild from API (use after upgrades or bad cache) |

### Collapsed search bar

- Click the **bottom-right** button to hide the bar (only the toggle stays).
- **Results only** turns off while hidden; native Grok grid shows.
- **Ctrl/Cmd+F** expands the bar and focuses search.

### Results

- **Parent** cards: video / descendant image badges (counts include **all generations** in `childPosts` tree).
- **Child** cards: purple **child** icon (top-right), own date; click opens that child’s post.
- Click a **date** on a card to filter to that day (click again to clear).
- **← / →** keys page results when the search box is not focused.

### Keyboard

| Key | Action |
|-----|--------|
| Ctrl/Cmd+F | Show search bar + focus input |
| Esc | Blur search input |
| ← / → | Previous / next results page |

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
| Tab focus | Incremental sync (rate-limited) |
| Return from post page | Sync after navigation |
| **Reindex** button | Full rebuild (only when you need everything refreshed) |

Child posts are stored as **separate rows** (`isChild: true`, `parentId`, `parentPrompt` for search).

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
| Child filters still show child cards | Update to v1.35+ (video/child filters = parents only) |
| Greasy Fork + this script | Use **one** search script to avoid conflicts |

---

## Privacy

Scripts run **only in your browser**. API calls go to **`grok.com`** (your session cookies). IndexedDB stays local. No third-party analytics in these files.

---

## Disclaimer

Unofficial tool, not affiliated with xAI / Grok. Internal APIs may change and break the script.

---

## License

MIT — see [LICENSE](LICENSE). Please keep attribution links to this repo and the original authors when redistributing.