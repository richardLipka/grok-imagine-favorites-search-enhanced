'use strict';

const { createIndexSandbox } = require('../harness');

const parent = (id, kids = []) => ({
  id, prompt: 'p ' + id, createTime: '2026-06-01T00:00:00Z',
  mediaType: 'MEDIA_POST_TYPE_IMAGE', childPosts: kids,
});
const kid = id => ({ id, prompt: '', createTime: '2026-06-01T01:00:00Z', mediaType: 'MEDIA_POST_TYPE_IMAGE', childPosts: [] });

module.exports = {
  name: 'child sync — shadowing, prune guard, deep-refresh selection',
  run(t) {
    t.group('a liked post that also appears as another post child');
    let m = createIndexSandbox();
    m.addPostRow(m.normalizePost({ id: 'X', prompt: 'x own prompt', createTime: '2026-06-03T00:00:00Z' }));
    m.addPostRow(m.normalizePost(m.parsePost(parent('P'))));

    const raw = parent('P', [kid('X'), kid('y1')]);
    const parsed = m.normalizePost(m.parsePost(raw));
    const collected = m.collectChildRecords(raw, parsed);
    t.ok('the liked post is not collected as a child row', !collected.some(r => r.id === 'X'), collected.map(r => r.id));
    t.ok('genuine children still collected', collected.some(r => r.id === 'y1'), collected.map(r => r.id));

    m.syncChildRecordsForParent(raw, parsed, m.createIndexWriter());
    const x = m.postById.get('X');
    t.ok('it keeps its parent identity', x && x.isChild === false, x);
    t.equal('it keeps its own prompt in the search blob', x._search, 'x own prompt');

    t.group('self-reference');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost(m.parsePost(parent('S'))));
    const selfRaw = parent('S', [kid('S')]);
    t.equal('a post listed as its own child is skipped',
      m.collectChildRecords(selfRaw, m.normalizePost(m.parsePost(selfRaw))).length, 0);

    t.group('malformed payload must not prune');
    m = createIndexSandbox();
    m.addPostRow(m.normalizePost(m.parsePost(parent('P9'))));
    m.addPostRow(m.normalizePost({ id: 'k1', isChild: true, parentId: 'P9', parentPrompt: 'p P9', createTime: '2026-06-01T01:00:00Z' }));
    m.addPostRow(m.normalizePost({ id: 'k2', isChild: true, parentId: 'P9', parentPrompt: 'p P9', createTime: '2026-06-01T01:00:00Z' }));

    const bad = m.syncChildRecordsForParent({ error: 'unexpected shape' }, m.postById.get('P9'), m.createIndexWriter());
    t.ok('nothing touched', bad.removed === 0 && bad.added === 0 && bad.updated === 0, bad);
    t.equal('children survive', m.allPosts.filter(p => p.parentId === 'P9').length, 2);

    const mismatched = m.syncChildRecordsForParent(parent('OTHER'), m.postById.get('P9'), m.createIndexWriter());
    t.equal('a payload for a different post is refused', mismatched.removed, 0);
    t.equal('children still survive', m.allPosts.filter(p => p.parentId === 'P9').length, 2);

    t.group('a genuine empty tree does prune');
    const good = m.syncChildRecordsForParent({ ...parent('P9'), childPosts: [] }, m.postById.get('P9'), m.createIndexWriter());
    t.equal('both children removed', good.removed, 2);
    t.equal('index reflects it', m.allPosts.filter(p => p.parentId === 'P9').length, 0);

    t.group('deep-refresh eligibility');
    m = createIndexSandbox();
    const fresh = m.stampMetadataRefreshed(m.normalizePost({ id: 'f', prompt: 'f' }));
    const stale = m.normalizePost({ id: 's', prompt: 's', metadataRefreshedAt: Date.now() - 11 * 60 * 1000 });
    const never = m.normalizePost({ id: 'n', prompt: 'n' });
    t.ok('recently refreshed is skipped', m.postNeedsDeepRefresh(fresh) === false);
    t.ok('stale is eligible', m.postNeedsDeepRefresh(stale) === true);
    t.ok('never refreshed is eligible', m.postNeedsDeepRefresh(never) === true);
    t.ok('child rows are never targets', m.postNeedsDeepRefresh({ isChild: true }) === false);
    t.ok('a childless parent is still eligible — first-child discovery',
      m.postNeedsDeepRefresh(never) === true && m.postHasKnownChildren(never) === false);

    t.group('deep-refresh batch selection');
    const build = (withKids, childless) => {
      const s = createIndexSandbox();
      for (let i = 0; i < withKids; i++) {
        s.addPostRow(s.normalizePost({ id: 'w' + i, prompt: 'w', childPostCount: 3 }));
      }
      for (let i = 0; i < childless; i++) {
        s.addPostRow(s.normalizePost({ id: 'c' + i, prompt: 'c' }));
      }
      return s;
    };

    let batch = build(100, 20).pickDeepRefreshTargets();
    t.equal('batch is capped at the limit', batch.length, 24);
    t.equal('childless slots are reserved', batch.filter(p => p.id.startsWith('c')).length, 8);
    t.equal('the rest goes to posts with children', batch.filter(p => p.id.startsWith('w')).length, 16);
    t.equal('newest with-children first', batch[0].id, 'w0');

    batch = build(100, 0).pickDeepRefreshTargets();
    t.ok('no childless candidates means a full budget for parents',
      batch.length === 24 && batch.every(p => p.id.startsWith('w')), batch.length);

    batch = build(0, 20).pickDeepRefreshTargets();
    t.equal('only childless candidates are all taken', batch.length, 20);

    const quiet = build(30, 30);
    for (const p of quiet.allPosts) p.metadataRefreshedAt = Date.now();
    t.equal('a TTL-fresh index issues no requests', quiet.pickDeepRefreshTargets().length, 0);

    t.equal('an empty index yields an empty batch', createIndexSandbox().pickDeepRefreshTargets().length, 0);
    batch = build(100, 20).pickDeepRefreshTargets();
    t.equal('no duplicates in the batch', new Set(batch.map(p => p.id)).size, batch.length);
  },
};
