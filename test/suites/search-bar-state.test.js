'use strict';

const { createSearchBarSandbox, readSource, sliceBetween } = require('../harness');

module.exports = {
  name: 'search bar state — the Results only preference survives a collapse',
  run(t) {
    t.group('the stored default');
    t.equal('nothing stored means on', createSearchBarSandbox({}).getStoredResultsOnly(), true);
    t.equal('an empty string means on', createSearchBarSandbox({ grokSearchResultsOnly: '' }).getStoredResultsOnly(), true);
    t.equal("'1' means on", createSearchBarSandbox({ grokSearchResultsOnly: '1' }).getStoredResultsOnly(), true);
    t.equal("'0' means off", createSearchBarSandbox({ grokSearchResultsOnly: '0' }).getStoredResultsOnly(), false);

    t.group('collapsing turns it off at runtime but leaves the preference alone');
    let m = createSearchBarSandbox({ grokSearchResultsOnly: '1' });
    m.setSearchBarExpanded(false);
    t.equal('the runtime flag is forced off', m.resultsOnly, false);
    t.equal('the stored preference is untouched', m.store.grokSearchResultsOnly, '1');
    t.equal('and the collapse itself is remembered', m.store.grokSearchBarCollapsed, '1');
    t.ok('the native page is handed back', m.log.nativeApplies > 0, m.log);

    // The regression. ensureSearchBarToggle() calls setSearchBarExpanded() on every init, and an
    // SPA navigation re-inits. The old code wrote `resultsOnly` to storage before clearing it, so
    // the second pass -- with the flag already forced off -- overwrote the real preference with
    // '0'. Expanding then restored that '0' and the script rendered nothing until a filter was
    // typed.
    t.group('a re-init while collapsed must not overwrite it');
    m.setSearchBarExpanded(false);
    m.setSearchBarExpanded(false);
    m.setSearchBarExpanded(false);
    t.equal('still the preference the user chose', m.store.grokSearchResultsOnly, '1');
    t.equal('and still off at runtime', m.resultsOnly, false);

    t.group('expanding restores it');
    m.setSearchBarExpanded(true);
    t.equal('back on', m.resultsOnly, true);
    t.equal('the collapse flag clears', m.store.grokSearchBarCollapsed, '0');

    t.group('a genuine "off" preference is honoured, not overridden');
    m = createSearchBarSandbox({ grokSearchResultsOnly: '0' });
    m.setSearchBarExpanded(true);
    t.equal('expanding leaves it off', m.resultsOnly, false);
    m.setSearchBarExpanded(false);
    m.setSearchBarExpanded(true);
    t.equal('and a collapse cycle keeps it off', m.resultsOnly, false);
    t.equal('with storage still saying so', m.store.grokSearchResultsOnly, '0');

    t.group('a full collapse/expand cycle round-trips either way');
    for (const stored of ['0', '1']) {
      const s = createSearchBarSandbox({ grokSearchResultsOnly: stored });
      const before = s.getStoredResultsOnly();
      for (let i = 0; i < 5; i++) { s.setSearchBarExpanded(false); s.setSearchBarExpanded(true); }
      t.equal(`stored '${stored}' survives five cycles`, s.resultsOnly, before);
      t.equal(`and storage still reads '${stored}'`, s.store.grokSearchResultsOnly, stored);
    }

    t.group('setSearchBarExpanded never writes the preference itself');
    const region = sliceBetween(readSource(),
      '  function setSearchBarExpanded(', '  function patchSearchBarCollapseStyles');
    t.ok('only the collapse flag is persisted here',
      !region.includes('RESULTS_ONLY_KEY'), region.slice(0, 400));
    t.ok('the collapsed flag still is', region.includes('SEARCH_BAR_COLLAPSED_KEY'));

    t.group('the inline results viewport paints its own background');
    // It is position: fixed above Grok's own page, so without one the results and the page
    // underneath interleave.
    const css = sliceBetween(readSource(), '      #grok-inline-results-viewport {', '      }');
    t.ok('it is fixed', /position:\s*fixed/.test(css), css);
    t.ok('and has a background', /background:\s*\S/.test(css), css);
  },
};
