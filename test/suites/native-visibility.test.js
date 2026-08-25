'use strict';

const { createNativeVisibilitySandbox } = require('../harness');
const { FakeNode, fakeDocument } = require('../dom');

function setup({ sameNode = false } = {}) {
  const grid = new FakeNode('grid');
  const root = sameNode ? grid : new FakeNode('root');
  const nodes = sameNode ? [grid] : [grid, root];
  const m = createNativeVisibilitySandbox({ document: fakeDocument(nodes), grid, root });
  return { m, grid, root };
}

module.exports = {
  name: 'native visibility — hiding Grok\'s own grid, and getting it back',
  run(t) {
    t.group('hiding');
    let { m, grid, root } = setup();
    m.setNativeGridVisible(false);
    m.setNativeSavedRootVisible(false);
    t.ok('the grid is out of the layout', !grid.visible, [...grid.styleProps]);
    t.ok('so is the saved root', !root.visible, [...root.styleProps]);
    t.ok('each carries its own marker',
      grid.hasAttribute(m.HID_GRID_ATTR) && root.hasAttribute(m.HID_ROOT_ATTR),
      [grid.getAttribute(m.HID_GRID_ATTR), root.getAttribute(m.HID_ROOT_ATTR)]);
    t.equal('and the root is tagged for the CSS rule too', root.dataset.grokNativeSavedRoot, '1');

    t.group('showing again');
    m.setNativeGridVisible(true);
    m.setNativeSavedRootVisible(true);
    t.ok('the grid is back', grid.visible, [...grid.styleProps]);
    t.ok('the root is back', root.visible, [...root.styleProps]);
    t.ok('no markers are left behind',
      !grid.hasAttribute(m.HID_GRID_ATTR) && !root.hasAttribute(m.HID_ROOT_ATTR));
    t.equal('nor the CSS hook', root.dataset.grokNativeSavedRoot, undefined);

    // The regression. React drops the masonry cards while their container has no layout box,
    // so the "walk up from a card" lookups return null — and the old code, which re-derived the
    // element in order to un-hide it, silently did nothing and left the page blank.
    t.group('showing works after React has thrown the cards away');
    ({ m, grid, root } = setup());
    m.setNativeGridVisible(false);
    m.setNativeSavedRootVisible(false);
    m.lookups.grid = null;
    m.lookups.root = null;
    m.setNativeGridVisible(true);
    m.setNativeSavedRootVisible(true);
    t.ok('the grid is visible again anyway', grid.visible, [...grid.styleProps]);
    t.ok('and so is the root', root.visible, [...root.styleProps]);

    t.group('showing works when the lookup now finds a different element');
    ({ m, grid, root } = setup());
    m.setNativeGridVisible(false);
    m.setNativeSavedRootVisible(false);
    const impostor = new FakeNode('rerendered');
    m.lookups.grid = impostor;
    m.lookups.root = impostor;
    m.setNativeGridVisible(true);
    m.setNativeSavedRootVisible(true);
    t.ok('the element that was actually hidden is the one restored', grid.visible && root.visible,
      [[...grid.styleProps], [...root.styleProps]]);

    t.group('when the grid and the saved root are the same element');
    ({ m, grid } = setup({ sameNode: true }));
    m.setNativeGridVisible(false);
    m.setNativeSavedRootVisible(false);
    t.ok('it carries both markers',
      grid.hasAttribute(m.HID_GRID_ATTR) && grid.hasAttribute(m.HID_ROOT_ATTR));
    m.setNativeGridVisible(true);
    t.ok('clearing one marker does not reveal it early', !grid.visible, [...grid.styleProps]);
    m.setNativeSavedRootVisible(true);
    t.ok('clearing the last one does', grid.visible, [...grid.styleProps]);

    t.group('hiding is idempotent');
    ({ m, grid, root } = setup());
    m.setNativeGridVisible(false);
    m.setNativeGridVisible(false);
    m.setNativeGridVisible(true);
    t.ok('a double hide still takes exactly one show', grid.visible, [...grid.styleProps]);

    t.group('a missing element is not an error');
    ({ m } = setup());
    m.lookups.grid = null;
    m.lookups.root = null;
    m.setNativeGridVisible(false);
    m.setNativeSavedRootVisible(false);
    t.ok('nothing threw', true);

    t.group('applyNativeVisibility drives the three display modes');
    ({ m, grid, root } = setup());
    m.setState({ showResults: true, resultsOnly: true });
    m.applyNativeVisibility();
    t.ok('results-only hides both', !grid.visible && !root.visible);

    m.setState({ showResults: true, resultsOnly: false });
    m.applyNativeVisibility();
    t.ok('inline mode keeps the page but hides the native grid', root.visible && !grid.visible,
      [root.visible, grid.visible]);

    m.setState({ showResults: false });
    m.applyNativeVisibility();
    t.ok('and no results at all means Grok is left alone', grid.visible && root.visible,
      [grid.visible, root.visible]);

    t.group('collapsing the bar restores the page even after a re-render');
    ({ m, grid, root } = setup());
    m.setState({ showResults: true, resultsOnly: true });
    m.applyNativeVisibility();
    m.lookups.grid = null;                      // cards unmounted while hidden
    m.lookups.root = null;
    m.setState({ showResults: false });
    m.applyNativeVisibility();
    t.ok('Grok is visible again without a reload', grid.visible && root.visible,
      [[...grid.styleProps], [...root.styleProps]]);
  },
};
