'use strict';

const { createCompactSandbox } = require('../harness');

/**
 * Compact mode folds a matched child into its parent's card instead of giving it a cell.
 *
 * The invariant that matters most is negative: `matchedPosts` is not touched. Selection,
 * download, delete and the lightbox all index into that flat list, so a grouping bug that
 * reordered or dropped rows there would break four features at once, silently.
 */

/** A parent with `n` children, ids `p`, `p-c0`, `p-c1`… */
function family(parentId, n, extra = {}) {
  const parent = { id: parentId, isChild: false, ...extra };
  const kids = [];
  for (let i = 0; i < n; i++) {
    kids.push({ id: `${parentId}-c${i}`, isChild: true, parentId, rootId: parentId });
  }
  return [parent, ...kids];
}

const idsOf = entries => entries.map(e => e.post.id);
const kidsOf = entries => entries.map(e => e.children.map(c => c.id));

module.exports = {
  name: 'compact groups — children fold into the parent card',
  run(t) {
    t.group('off by default: one entry per post');
    let s = createCompactSandbox({ posts: family('p', 3) });
    let entries = s.getDisplayEntries();
    t.equal('every post gets its own cell', idsOf(entries), ['p', 'p-c0', 'p-c1', 'p-c2']);
    t.ok('and nothing is folded', kidsOf(entries).every(k => k.length === 0), kidsOf(entries));

    t.group('on: children collapse into the parent');
    s = createCompactSandbox({ posts: family('p', 3), compact: true });
    entries = s.getDisplayEntries();
    t.equal('one entry for the family', idsOf(entries), ['p']);
    t.equal('carrying all three children', kidsOf(entries), [['p-c0', 'p-c1', 'p-c2']]);
    t.equal('and matchedPosts is untouched', s.matchedPosts.map(p => p.id),
      ['p', 'p-c0', 'p-c1', 'p-c2']);

    t.group('children keep the sort order they arrived in');
    // Newest-first puts children ahead of their parent; the fold must not reorder them.
    const reversed = [
      { id: 'p-c2', isChild: true, parentId: 'p', rootId: 'p' },
      { id: 'p-c0', isChild: true, parentId: 'p', rootId: 'p' },
      { id: 'p', isChild: false },
    ];
    s = createCompactSandbox({ posts: reversed, compact: true });
    entries = s.getDisplayEntries();
    t.equal('the parent still owns the entry', idsOf(entries), ['p']);
    t.equal('children stay in match order', kidsOf(entries), [['p-c2', 'p-c0']]);

    t.group('several families');
    s = createCompactSandbox({
      posts: [...family('a', 2), ...family('b', 1), { id: 'c', isChild: false }],
      compact: true,
    });
    entries = s.getDisplayEntries();
    t.equal('one entry each, in match order', idsOf(entries), ['a', 'b', 'c']);
    t.equal('each with its own children', kidsOf(entries), [['a-c0', 'a-c1'], ['b-c0'], []]);

    t.group('grandchildren fold into the nearest matched ancestor');
    // With a prompt filter on, a grandchild can match while its own parent does not. Folding it
    // into the grandparent keeps it on screen; folding it into an unrendered parent would lose it.
    const deep = [
      { id: 'root', isChild: false },
      { id: 'mid', isChild: true, parentId: 'root', rootId: 'root' },
      { id: 'leaf', isChild: true, parentId: 'mid', rootId: 'root' },
    ];
    s = createCompactSandbox({ posts: deep, compact: true });
    t.equal('a full chain collapses to one card', idsOf(s.getDisplayEntries()), ['root']);
    t.equal('with both generations folded in', kidsOf(s.getDisplayEntries()), [['mid', 'leaf']]);

    // The middle generation is still in the index — it just did not match the filter.
    s = createCompactSandbox({ posts: [deep[0], deep[2]], index: deep, compact: true });
    t.equal('an unmatched middle is skipped, not stranded',
      kidsOf(s.getDisplayEntries()), [['leaf']]);

    t.group('a child with no matched ancestor stands alone');
    s = createCompactSandbox({ posts: [family('p', 1)[1]], compact: true });
    t.equal('it keeps its own cell', idsOf(s.getDisplayEntries()), ['p-c0']);

    // The row is in the index but filtered out of the match set — same outcome, different reason.
    s = createCompactSandbox({
      posts: [{ id: 'orphan', isChild: true, parentId: 'missing', rootId: 'missing' }],
      compact: true,
    });
    t.equal('and so does one whose parent is not indexed at all',
      idsOf(s.getDisplayEntries()), ['orphan']);

    t.group('a cycle cannot hang the fold');
    s = createCompactSandbox({
      posts: [
        { id: 'x', isChild: true, parentId: 'y' },
        { id: 'y', isChild: true, parentId: 'x' },
      ],
      compact: true,
    });
    entries = s.getDisplayEntries();
    // Each is the other's owner, so neither is top level and neither can be folded — the fallback
    // has to be a cell of its own. Folding regardless would drop both rows off the grid.
    t.equal('every post is placed exactly once',
      [...idsOf(entries), ...kidsOf(entries).flat()].sort(), ['x', 'y']);
    t.equal('and both get their own cell', idsOf(entries), ['x', 'y']);

    t.group('paging counts cards, not posts');
    s = createCompactSandbox({ posts: family('p', 9), compact: false });
    s.setPageSize(5);
    t.equal('flat: ten posts over five per page', s.getTotalPages(), 2);
    t.equal('and the count is the post count', s.getDisplayCount(), 10);
    s.setCompact(true);
    t.equal('compact: one group fits on one page', s.getTotalPages(), 1);
    t.equal('and the count is the group count', s.getDisplayCount(), 1);

    t.group('a page is a window over the cards');
    // With compact off this wraps only the page, never the whole match set — the entry list would
    // otherwise be an object per indexed post rebuilt on every keystroke.
    s = createCompactSandbox({ posts: family('p', 9), compact: false });
    t.equal('flat: the second window of four', idsOf(s.getDisplayPage(4, 4)),
      ['p-c3', 'p-c4', 'p-c5', 'p-c6']);
    t.equal('and the entries wrap the real rows', s.getDisplayPage(0, 1)[0].post,
      s.matchedPosts[0]);
    t.ok('with no children attached', s.getDisplayPage(0, 4).every(e => e.children.length === 0));
    t.equal('a window past the end is empty', s.getDisplayPage(50, 4), []);
    s.setCompact(true);
    t.equal('compact: the single group is the whole first page',
      idsOf(s.getDisplayPage(0, 4)), ['p']);

    t.group('the cache notices both kinds of change');
    s = createCompactSandbox({ posts: family('p', 2), compact: true });
    const first = s.getDisplayEntries();
    t.ok('a repeat call reuses the same array', s.getDisplayEntries() === first);
    s.setCompact(false);
    t.equal('flipping the switch rebuilds', idsOf(s.getDisplayEntries()), ['p', 'p-c0', 'p-c1']);
    s.setMatched([{ id: 'z', isChild: false }]);
    t.equal('and so does a new match set', idsOf(s.getDisplayEntries()), ['z']);

    // applyFilter() assigns a fresh array, but delete paths have historically mutated in place.
    // The identity check alone would miss that, which is why the length is in the signature too.
    s = createCompactSandbox({ posts: family('p', 3), compact: false });
    s.getDisplayEntries();
    s.mutateMatchedInPlace(list => list.splice(1, 1));
    t.equal('an in-place removal is not served from the cache',
      idsOf(s.getDisplayEntries()), ['p', 'p-c1', 'p-c2']);
  },
};
