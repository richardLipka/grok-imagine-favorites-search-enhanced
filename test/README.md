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

`grokSearch.js` is a single IIFE with no exports. It cannot be `require()`d, and it cannot run
outside a logged-in `grok.com` page with Tampermonkey — which is exactly why the sync logic
was historically hard to verify and accumulated silent bugs.

So [`harness.js`](harness.js) **slices regions of text out of the real source** and evaluates
them with stubbed collaborators (`dbPutMany`, `fetchPage`, `setLoadStatus`, …). Every assertion
runs production code. Nothing here reimplements logic — a test that passed against a copy of
the algorithm would be worthless.

Two sandboxes:

| Sandbox | Region | Covers |
|---------|--------|--------|
| `createIndexSandbox()` | `isVideoMediaType` → `formatSyncStatusMessage` | Record shape, index mutation, child sync, deep-refresh selection, reconciliation |
| `createGridSandbox()` | `renderResultCards` | Keyed results-grid reconciliation, against the fake DOM in [`dom.js`](dom.js) |

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

## What is not covered

Anything that needs a browser: DOM injection into the live Grok SPA, IndexedDB itself,
`GM_xmlhttpRequest`, the File System Access API, EXIF writing, and CSS. Those still need a
manual pass in Tampermonkey — see the editing loop in [`../CLAUDE.md`](../CLAUDE.md).
