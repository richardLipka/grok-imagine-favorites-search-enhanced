'use strict';

const { createGridSandbox } = require('../harness');
const { FakeElement, containerWith, idsOf } = require('../dom');

module.exports = {
  name: 'results grid — keyed reuse instead of innerHTML rebuilds',
  run(t) {
    const created = [];
    const patched = [];
    const renderResultCards = createGridSandbox({
      createElement: () => {
        const el = new FakeElement();
        created.push(el);
        return el;
      },
      onRender: (card, entry) => {
        card.dataset.id = entry.post.id;
        patched.push(entry.post.id);
      },
    });
    // The grid pages over `{ post, children }` entries, not bare posts -- compact mode folds a
    // child into its parent's entry, and the reconciler still keys on the entry's own post id.
    const page = ids => ids.map(id => ({ post: { id }, children: [] }));

    t.group('ordering');
    let c = containerWith([]);
    renderResultCards(c, page(['a', 'b', 'c']));
    t.equal('an empty grid is filled in order', idsOf(c), ['a', 'b', 'c']);

    c = containerWith(['a', 'b', 'c']);
    renderResultCards(c, page(['c', 'b', 'a']));
    t.equal('a full reversal reorders correctly', idsOf(c), ['c', 'b', 'a']);

    c = containerWith(['a', 'b', 'c', 'd']);
    renderResultCards(c, page(['d', 'b']));
    t.equal('a subset reorders and drops the rest', idsOf(c), ['d', 'b']);

    c = containerWith(['a', 'b', 'c']);
    renderResultCards(c, page(['x', 'b', 'y']));
    t.equal('new and reused cards interleave', idsOf(c), ['x', 'b', 'y']);

    c = containerWith(['b']);
    renderResultCards(c, page(['a', 'b', 'c', 'd']));
    t.equal('a growing page keeps order', idsOf(c), ['a', 'b', 'c', 'd']);

    c = containerWith(['a', 'b', 'c']);
    renderResultCards(c, page([]));
    t.equal('an empty page clears the grid', idsOf(c), []);

    t.group('node reuse');
    c = containerWith(['a', 'b', 'c']);
    const original = c.kids.slice();
    created.length = 0;
    renderResultCards(c, page(['a', 'b', 'c']));
    t.ok('an unchanged page allocates nothing', created.length === 0, created.length);
    t.ok('every node is the same object', c.kids.every((k, i) => k === original[i]));

    c = containerWith(['a', 'b', 'c', 'd']);
    const keepB = c.kids[1];
    renderResultCards(c, page(['d', 'b']));
    t.ok('a reused node survives reordering', c.kids[1] === keepB);

    c = containerWith(['a', 'b']);
    created.length = 0;
    renderResultCards(c, page(['a', 'b', 'z']));
    t.equal('only the genuinely new card is created', created.length, 1);

    t.group('cleanup and patching');
    c = containerWith(['a', 'b']);
    c.insertBefore(new FakeElement(), null); // stray node with no data-id
    renderResultCards(c, page(['a']));
    t.ok('stray non-card elements are removed', idsOf(c).join() === 'a' && c.kids.length === 1, idsOf(c));

    c = containerWith(['a', 'b', 'c']);
    patched.length = 0;
    renderResultCards(c, page(['b', 'a']));
    t.equal('every rendered post is patched, reused or not', patched, ['b', 'a']);

    c = containerWith(['a', 'b']);
    const dropped = c.kids[1];
    renderResultCards(c, page(['a']));
    t.ok('a dropped card is detached from the container', dropped.parent === null);
  },
};
