'use strict';

const { createResultsOnlySandbox, readSource, sliceBetween } = require('../harness');

/**
 * The reader's page belongs to the reader.
 *
 * `syncResultsView()` used to set `currentPage = 0` on every render, which made *anything* that
 * re-rendered drag the reader back to page 1: an incremental sync that found a single new post,
 * a Verify sweep, liking a row, deleting a row. `setResultsOnlyEnabled()` did the same
 * unconditionally, and `setSearchBarExpanded()` calls it on every init — including the re-inits
 * an SPA navigation triggers — so simply moving around grok.com was enough.
 *
 * Going back to page 1 is a response to the user changing *what they are looking at*, so it
 * belongs to those handlers and only those. The invariant here is the negative one: the render
 * path never moves the reader.
 */
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

module.exports = {
  name: 'paging position — only the user moves the page',
  run(t) {
    t.group('toggling Results only');
    let s = createResultsOnlySandbox({ resultsOnly: true, currentPage: 7 });
    s.setResultsOnlyEnabled(true);
    t.equal('re-asserting the mode it is already in leaves the page alone', s.currentPage, 7);
    t.ok('and the mode is unchanged', s.resultsOnly === true);
    t.ok('but the UI is still re-synced', s.log.checkbox === 1 && s.log.layout === 1);

    // This is the SPA case: init() -> setSearchBarExpanded() -> setResultsOnlyEnabled(stored).
    for (let i = 0; i < 5; i++) s.setResultsOnlyEnabled(true);
    t.equal('five re-inits in a row still leave it alone', s.currentPage, 7);

    s.setResultsOnlyEnabled(false);
    t.equal('a real change of mode goes back to page 1', s.currentPage, 0);

    s = createResultsOnlySandbox({ resultsOnly: false, currentPage: 4 });
    s.setResultsOnlyEnabled(false);
    t.equal('the same holds when the mode starts off', s.currentPage, 4);
    s.setResultsOnlyEnabled(true);
    t.equal('and turning it back on resets', s.currentPage, 0);

    t.group('the render path never moves the reader');
    const src = readSource();
    const view = stripComments(sliceBetween(src, '  function syncResultsView() {', '\n  }\n'));
    t.ok('syncResultsView does not assign currentPage', !/currentPage\s*=/.test(view), view);

    const filter = stripComments(sliceBetween(src, '  function applyFilter() {', '\n  }\n'));
    t.ok('and neither does applyFilter', !/currentPage\s*=/.test(filter), filter);

    t.group('the paths that genuinely rebuild everything still reset');
    // Reindex clears the store outright, so the old page number means nothing afterwards.
    const reindex = stripComments(sliceBetween(src, '  async function reindexDatabase(', '\n  }\n'));
    t.ok('reindexDatabase resets the page itself', /currentPage = 0/.test(reindex), reindex);

    // showResults() is what keeps a kept page legal when the match set shrinks under it.
    const show = stripComments(sliceBetween(src, '  function showResults() {', '\n  }\n'));
    t.ok('showResults clamps the page to the last one',
      /currentPage = Math\.max\(0, Math\.min\(currentPage, totalPages - 1\)\)/.test(show), show);
  },
};
