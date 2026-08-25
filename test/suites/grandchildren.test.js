'use strict';

const { createIndexSandbox } = require('../harness');

const node = (id, prompt, kids = []) => ({
  id,
  prompt,
  createTime: '2026-06-01T00:00:00Z',
  mediaType: 'MEDIA_POST_TYPE_IMAGE',
  childPosts: kids,
});

/** Root "R" → child "C" → grandchild "G" → great-grandchild "GG". */
function deepTree() {
  return node('R', 'a red fox', [
    node('C', 'zoom in', [
      node('G', 'add snow', [
        node('GG', '', []),
      ]),
    ]),
    node('C2', '', []),
  ]);
}

module.exports = {
  name: 'grandchildren — real tree edges, root ownership, prune scope',
  run(t) {
    let m = createIndexSandbox();
    const raw = deepTree();
    const parsed = m.normalizePost(m.parsePost(raw));
    const rows = m.collectChildRecords(raw, parsed);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));

    t.group('every generation is flattened into a row');
    t.equal('all four descendants are collected', rows.map(r => r.id).sort().join(','), 'C,C2,G,GG');

    t.group('parentId is the immediate parent, not the root');
    t.equal('a direct child points at the root', byId.C.parentId, 'R');
    t.equal('a grandchild points at its child', byId.G.parentId, 'C');
    t.equal('a great-grandchild points at the grandchild', byId.GG.parentId, 'G');

    t.group('rootId is the post that owns the whole tree');
    t.equal('direct child', byId.C.rootId, 'R');
    t.equal('grandchild', byId.G.rootId, 'R');
    t.equal('great-grandchild', byId.GG.rootId, 'R');
    t.equal('for a direct child the two agree', byId.C.parentId, byId.C.rootId);

    t.group('denormalized prompts follow the same edges');
    t.equal('a direct child carries the root prompt as its parent prompt', byId.C.parentPrompt, 'a red fox');
    t.equal('a grandchild carries its own parent prompt', byId.G.parentPrompt, 'zoom in');
    t.equal('and still carries the root prompt separately', byId.G.rootPrompt, 'a red fox');
    t.equal('rootPrompt is not stored for a direct child', byId.C.rootPrompt, '');

    t.group('search still reaches the whole tree from the original wording');
    t.ok('the root prompt matches a grandchild', byId.G._search.includes('a red fox'), byId.G._search);
    t.ok('so does its own parent prompt', byId.G._search.includes('zoom in'), byId.G._search);
    t.ok('and its own', byId.G._search.includes('add snow'), byId.G._search);
    t.ok('a promptless great-grandchild inherits text to search on',
      byId.GG._search.length > 0, byId.GG._search);

    t.group('a mid-tree row reports its own descendants');
    t.equal('the child counts its subtree', byId.C.childPostCount, 2);
    t.equal('the grandchild counts one', byId.G.childPostCount, 1);
    t.equal('a leaf counts none', byId.GG.childPostCount, 0);
    t.equal('the root still counts every generation', parsed.childPostCount, 4);

    t.group('storage keeps the new fields');
    const stored = m.toStorageRecord(byId.G);
    t.equal('rootId persists', stored.rootId, 'R');
    t.equal('rootPrompt persists', stored.rootPrompt, 'a red fox');
    t.ok('runtime fields still do not', !('_ms' in stored) && !('_search' in stored), Object.keys(stored));
    const parentStored = m.toStorageRecord(parsed);
    t.equal('a top-level row has no rootId', parentStored.rootId, null);
    t.equal('nor a rootPrompt', parentStored.rootPrompt, null);

    t.group('the prune is scoped to the owning root, not to the immediate parent');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost(m.parsePost(raw)));
    m.syncChildRecordsForParent(raw, m.postById.get('R'), m.createIndexWriter());
    t.equal('all four rows are in the index',
      m.allPosts.filter(p => p.isChild).length, 4);

    // The root now reports only one direct child and no deeper tree at all.
    const trimmed = node('R', 'a red fox', [node('C2', '', [])]);
    const res = m.syncChildRecordsForParent(trimmed, m.postById.get('R'), m.createIndexWriter());
    t.equal('the whole orphaned branch is removed, not just the direct child', res.removed, 3);
    t.equal('only the surviving child is left', m.allPosts.filter(p => p.isChild).map(p => p.id).join(','), 'C2');
    t.ok('and the removed ids are forgotten', !m.knownIds.has('G') && !m.knownIds.has('GG'), [...m.knownIds]);

    t.group('legacy rows, written before rootId existed, are still owned by their root');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost(m.parsePost(node('R', 'a red fox'))));
    // Pre-v5 shape: every descendant was parented straight onto the root.
    m.addPostRow(m.normalizePost({ id: 'old1', isChild: true, parentId: 'R', parentPrompt: 'a red fox' }));
    t.equal('rootId is derived from parentId on load', m.postById.get('old1').rootId, 'R');
    t.equal('getRootIdOf agrees', m.getRootIdOf(m.postById.get('old1')), 'R');
    const wiped = m.syncChildRecordsForParent(node('R', 'a red fox'), m.postById.get('R'), m.createIndexWriter());
    t.equal('so an empty tree still prunes them', wiped.removed, 1);

    t.group('a post that exists in its own right is skipped but not walked past');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost({ id: 'C', prompt: 'C stands alone', createTime: '2026-06-02T00:00:00Z' }));
    m.addPostRow(m.normalizePost(m.parsePost(raw)));
    const collected = m.collectChildRecords(raw, m.postById.get('R'));
    const ids = collected.map(r => r.id).sort().join(',');
    t.ok('the standalone post is not rewritten as a child', !ids.includes('C,'), ids);
    t.ok('but its descendants are still collected', ids.includes('G') && ids.includes('GG'), ids);
    t.equal('and they hang off it, not off the root',
      collected.find(r => r.id === 'G').parentId, 'C');
    t.equal('while still belonging to the root',
      collected.find(r => r.id === 'G').rootId, 'R');

    t.group('backfill repairs both denormalized prompts');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost(m.parsePost(node('R', 'new root wording'))));
    m.addPostRow(m.normalizePost({ id: 'C', isChild: true, parentId: 'R', rootId: 'R', prompt: 'zoom in' }));
    m.addPostRow(m.normalizePost({ id: 'G', isChild: true, parentId: 'C', rootId: 'R', prompt: 'add snow' }));
    const fixed = m.backfillChildParentPrompts();
    t.equal('both rows are repaired', fixed.length, 2);
    t.equal('the child picks up the root prompt', m.postById.get('C').parentPrompt, 'new root wording');
    t.equal('the grandchild picks up its parent prompt', m.postById.get('G').parentPrompt, 'zoom in');
    t.equal('and the root prompt', m.postById.get('G').rootPrompt, 'new root wording');
    t.ok('the search blob is rebuilt with both',
      m.postById.get('G')._search.includes('new root wording')
        && m.postById.get('G')._search.includes('zoom in'),
      m.postById.get('G')._search);

    t.group('an orphan keeps the text it already has');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost({ id: 'o', isChild: true, parentId: 'gone', parentPrompt: 'remembered' }));
    m.backfillChildParentPrompts();
    t.equal('a missing parent does not blank the prompt', m.postById.get('o').parentPrompt, 'remembered');

    t.group('a prompt change propagates to every generation');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost(m.parsePost(node('R', 'old wording'))));
    m.addPostRow(m.normalizePost({ id: 'C', isChild: true, parentId: 'R', rootId: 'R', parentPrompt: 'old wording', prompt: 'zoom' }));
    m.addPostRow(m.normalizePost({ id: 'G', isChild: true, parentId: 'C', rootId: 'R', parentPrompt: 'zoom', rootPrompt: 'old wording', prompt: 'snow' }));
    const touched = m.propagateParentPromptToChildren('R', 'new wording', m.createIndexWriter());
    t.equal('both descendants are touched', touched, 2);
    t.equal('the direct child updates parentPrompt', m.postById.get('C').parentPrompt, 'new wording');
    t.equal('the grandchild updates rootPrompt', m.postById.get('G').rootPrompt, 'new wording');
    t.equal('and keeps its own parent prompt', m.postById.get('G').parentPrompt, 'zoom');

    t.group('integrity report distinguishes the generations');
    const summary = m.verifyIndexIntegrity();
    t.equal('two child rows', summary.children, 2);
    t.equal('one of them is a grandchild', summary.grandchildren, 1);
    t.equal('no orphans', summary.orphans, 0);
    t.equal('no missing parents', summary.childMissingParent, 0);
    t.equal('no missing roots', summary.childMissingRoot, 0);
  },
};
