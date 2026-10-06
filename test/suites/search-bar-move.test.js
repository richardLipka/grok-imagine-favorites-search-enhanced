'use strict';

const { createSearchBarMoveSandbox, readSource, sliceBetween } = require('../harness');

/**
 * The bar is fixed to the top centre at z-index 99990, min(900px, 92vw) wide, and the results
 * panel starts 120px down. Its own content is four rows plus a pager, so it is taller than that
 * gap: it sits on top of the middle of the panel's first row of cards, including their select
 * boxes, which cannot be clicked at all while it is there. Collapsing the bar takes the search
 * with it, so there was no way to reach those cards.
 *
 * Two mechanisms fix it, and each is half a fix on its own. These tests pin both, plus the thing
 * that makes a movable element a trap: ending up somewhere it cannot be grabbed back from.
 */
module.exports = {
  name: 'search bar position — moved out of the way, and still reachable',
  run: async t => {
    t.group('an unmoved bar is left exactly as the stylesheet puts it');
    let s = createSearchBarMoveSandbox({});
    t.equal('nothing stored', s.readStoredSearchBarPos(), null);
    s.applySearchBarPosition(null);
    t.equal('no class', s.moved, false);
    t.equal('and no inline position', s.left, undefined);

    t.group('a drop is written down, and read back');
    s = createSearchBarMoveSandbox({});
    s.applySearchBarPosition({ left: 40, top: 500 }, true);
    t.equal('positioned outright', [s.left, s.top], ['40px', '500px']);
    // The class is what drops the centring transform; without it the bar would sit half its own
    // width away from where it was dropped.
    t.equal('and marked as moved', s.moved, true);
    t.equal('stored as left,top', s.store.grokSearchBarPos, '40,500');
    t.equal('and read back as numbers',
      createSearchBarMoveSandbox({ store: { grokSearchBarPos: '40,500' } }).readStoredSearchBarPos(),
      { left: 40, top: 500 });

    t.group('a dragged bar is not persisted until it is dropped');
    s = createSearchBarMoveSandbox({});
    s.applySearchBarPosition({ left: 100, top: 100 });
    t.equal('the move shows', s.left, '100px');
    t.equal('but nothing is stored', s.store.grokSearchBarPos, undefined);

    t.group('the reset puts it back and forgets where it was');
    s = createSearchBarMoveSandbox({ store: { grokSearchBarPos: '40,500' } });
    s.applySearchBarPosition(s.readStoredSearchBarPos(), false);
    s.resetSearchBarPosition();
    t.equal('the class goes', s.moved, false);
    t.equal('the inline position goes', s.left, undefined);
    t.equal('and the stored one is cleared, not left to come back', s.store.grokSearchBarPos, '');

    t.group('it cannot be put somewhere it cannot be grabbed back from');
    s = createSearchBarMoveSandbox({});
    t.equal('not off the right edge',
      s.clampSearchBarPos({ left: 5000, top: 100 }, 900, 240, 1920, 1000).left, 1012);
    t.equal('not off the left edge',
      s.clampSearchBarPos({ left: -500, top: 100 }, 900, 240, 1920, 1000).left, 8);
    t.equal('not above the top', s.clampSearchBarPos({ left: 10, top: -900 }, 900, 240, 1920, 1000).top, 8);
    // Vertically a sliver is enough, because the grip is at the bar's top edge.
    t.equal('and only a sliver need stay at the bottom',
      s.clampSearchBarPos({ left: 10, top: 5000 }, 900, 240, 1920, 1000).top, 952);

    t.group('and the clamp is what the drop actually goes through');
    // Testing the clamp in isolation proves nothing if the thing that positions the bar does not
    // call it: a drag that ends past the edge has to land inside, not merely be clampable.
    s = createSearchBarMoveSandbox({});
    s.applySearchBarPosition({ left: 5000, top: 5000 }, true);
    t.equal('a drop beyond the edge lands inside it', [s.left, s.top], ['1012px', '952px']);
    t.equal('and what is stored is the clamped position, not the raw one',
      s.store.grokSearchBarPos, '1012,952');

    t.group('a window smaller than the bar still leaves it on screen');
    // The stored position outlives the window it was chosen in. Restoring it into a narrower
    // window must not put the grip past the edge, where nothing can reach it and no reset is
    // visible.
    const narrow = s.clampSearchBarPos({ left: 900, top: 20 }, 900, 240, 600, 400);
    t.equal('clamped to the pad, not to a negative offset', narrow.left, 8);
    t.ok('and still inside the window', narrow.top < 400);

    t.group('garbage in storage is ignored rather than applied');
    t.equal('not a pair',
      createSearchBarMoveSandbox({ store: { grokSearchBarPos: '40' } }).readStoredSearchBarPos(), null);
    t.equal('not numbers',
      createSearchBarMoveSandbox({ store: { grokSearchBarPos: 'a,b' } }).readStoredSearchBarPos(), null);
    t.equal('empty', createSearchBarMoveSandbox({ store: { grokSearchBarPos: '' } }).readStoredSearchBarPos(), null);

    t.group('the panel gives up the strip the bar occupies');
    s = createSearchBarMoveSandbox({ rect: { top: 16, height: 240 } });
    s.updateResultsPanelOffset();
    t.equal('starting just below the bar', s.panelTop, '264px');
    s.setRect({ top: 16, height: 90 });
    s.updateResultsPanelOffset();
    // Never *less* than the stylesheet's own 120px: a short bar must not pull the panel up over
    // Grok's header.
    t.equal('but never above its own floor', s.panelTop, '120px');

    t.group('and takes it back as soon as the bar is not in the way');
    s = createSearchBarMoveSandbox({ rect: { top: 16, height: 240 } });
    s.updateResultsPanelOffset();
    t.ok('reserved while parked at the top', s.panelTop);
    s.setCollapsed(true);
    s.updateResultsPanelOffset();
    t.equal('a collapsed bar reserves nothing', s.panelTop, undefined);
    s.setCollapsed(false);
    // A bar dragged low is the user putting it somewhere deliberate; shrinking the panel to
    // avoid it there would be the opposite of getting out of the way.
    s.setRect({ top: 600, height: 240 });
    s.updateResultsPanelOffset();
    t.equal('and a bar dragged down the page reserves nothing either', s.panelTop, undefined);

    t.group('a bar dragged off the top edge reserves nothing');
    s = createSearchBarMoveSandbox({ rect: { top: -300, height: 240 } });
    s.updateResultsPanelOffset();
    t.equal('its bottom is above the viewport', s.panelTop, undefined);

    t.group('the panel can never be pushed off the screen');
    // An absurdly tall bar -- every filter row wrapped twice on a narrow window -- must not take
    // the whole viewport with it.
    s = createSearchBarMoveSandbox({ rect: { top: 8, height: 900 }, viewH: 1000 });
    s.updateResultsPanelOffset();
    t.equal('capped at 45% of the viewport', s.panelTop, '450px');

    t.group('nothing is reserved when there is no bar');
    s = createSearchBarMoveSandbox({ noWrap: true });
    s.updateResultsPanelOffset();
    t.equal('and no variable is left set', s.panelTop, undefined);

    t.group('moving is instant, and only collapsing animates');
    // Both stylesheets transition `transform`, and every position change crosses it: the centred
    // translateX(-50%) becomes none and back again. Transitioned, a drag lags the pointer -- and a
    // reset whose transition gets no frame stays at the *start* of it, which measured as the bar
    // sitting at left:50% with no translate, half of it off the right edge.
    const apply = sliceBetween(readSource(),
      '  function applySearchBarPosition(pos, persist = false) {', '\n  function resetSearchBarPosition');
    t.ok('the move is applied with the transition suppressed',
      /withoutBarTransition\(wrap, \(\) => \{[\s\S]*?classList\.add\('grok-bar-moved'\)/.test(apply), apply);
    t.ok('and so is the reset',
      /withoutBarTransition\(wrap, \(\) => \{[\s\S]*?classList\.remove\('grok-bar-moved'\)/.test(apply), apply);
    const without = sliceBetween(readSource(),
      '  function withoutBarTransition(wrap, apply) {', '\n  function applySearchBarPosition');
    t.ok('the recalc is forced before the override is lifted',
      without.indexOf('void wrap.offsetHeight') < without.indexOf("removeProperty('transition')"), without);
    t.ok('and the override is lifted, not left behind',
      /removeProperty\('transition'\)/.test(without), without);

    t.group('the pieces are wired into the page');
    const src = readSource();
    t.ok('the grip is in the chain that survives a bar rebuild',
      /ensureSearchBarGrip\(\);/.test(sliceBetween(src,
        '  function ensureSearchBarParts() {', '\n  function buildSearchBar')));
    const expand = sliceBetween(src, '  function setSearchBarExpanded(', '\n  function patchSearchBarCollapseStyles');
    t.ok('collapsing recomputes the reservation', /updateResultsPanelOffset\(\)/.test(expand), expand);
    const grip = sliceBetween(src, '  function ensureSearchBarGrip() {', '\n  function ensureSearchBarToggle');
    t.ok('the stored position is applied on load', /applySearchBarPosition\(readStoredSearchBarPos\(\)\)/.test(grip), grip);
    t.ok('a resized window re-clamps it', /addEventListener\('resize'/.test(grip), grip);
    t.ok('and the bar is re-measured when its own height changes',
      /ResizeObserver/.test(grip), grip);
    const drag = sliceBetween(src, '  function bindSearchBarDrag(grip, wrap) {', '\n  function ensureSearchBarGrip');
    t.ok('the bar is pinned before the first move, so it cannot jump',
      drag.indexOf('applySearchBarPosition({ left: rect.left, top: rect.top })')
        < drag.indexOf('addEventListener(\'pointermove\''), drag);
    t.ok('the move listeners are removed on release',
      /removeEventListener\('pointermove', onMove\)/.test(drag), drag);
    t.ok('a cancelled pointer ends the drag like a release',
      /pointercancel/.test(drag), drag);
    t.ok('the position is written once, on release',
      /applySearchBarPosition\(\{ left: rect\.left, top: rect\.top \}, true\)/.test(drag), drag);
    t.ok('and it can be moved and reset from the keyboard',
      /ArrowLeft/.test(drag) && /'Escape'/.test(drag), drag);

    t.group('the stylesheets agree about a moved bar');
    // Both copies define the collapse transform. A moved bar collapsing under the rule that
    // still centres it would slide sideways as it goes.
    const movedRules = src.match(/#grok-search-wrap\.grok-bar-moved \{/g) || [];
    t.equal('the moved rule is in both', movedRules.length, 2);
    const collapsedMoved = src.match(/#grok-search-wrap\.grok-bar-moved\.collapsed \{/g) || [];
    t.equal('and so is the moved-and-collapsed one', collapsedMoved.length, 2);
    t.ok('the panel reads its top from the variable',
      /top: var\(--grok-panel-top, max\(120px, 12vh\)\)/.test(src));
  },
};
