'use strict';

const { createIndexSandbox } = require('../harness');

const parent = (id, kids = []) => ({
  id, prompt: 'p ' + id, createTime: '2026-06-01T00:00:00Z',
  mediaType: 'MEDIA_POST_TYPE_IMAGE', childPosts: kids,
});
const kid = id => ({ id, prompt: '', createTime: '2026-06-01T01:00:00Z', mediaType: 'MEDIA_POST_TYPE_IMAGE', childPosts: [] });

/** Sandbox pre-seeded with the given parent ids already indexed. */
function seeded(ids) {
  const m = createIndexSandbox();
  for (const id of ids) m.addPostRow(m.normalizePost(m.parsePost(parent(id))));
  return m;
}

module.exports = {
  name: 'reconcile — the only path that deletes parent rows',
  async run(t) {
    t.group('finds posts liked long after they were created');
    let m = seeded(['a']);
    m.setFeedPages([{ posts: [parent('a'), parent('zz')] }]);
    let r = await m.reconcileLikedIndex(null);
    t.ok('walk completed', r.ok === true, r);
    t.ok('the late like is added', r.added === 1 && m.postById.has('zz'), r);
    t.ok('existing rows kept', m.postById.has('a'));

    t.group('removes unliked posts');
    m = seeded(['a', 'gone']);
    m.addPostRow(m.normalizePost({ id: 'a-k', isChild: true, parentId: 'a', parentPrompt: 'p a', createTime: '2026-06-01T01:00:00Z' }));
    m.selectedPostIds.add('gone');
    m.setFeedPages([{ posts: [parent('a', [kid('a-k')])] }]);
    r = await m.reconcileLikedIndex(null);
    t.ok('the unliked parent is removed', !m.postById.has('gone'), [...m.postById.keys()]);
    t.ok('still-liked rows survive', m.postById.has('a') && m.postById.has('a-k'), [...m.postById.keys()]);
    t.ok('knownIds cleaned up', !m.knownIds.has('gone'));
    t.ok('selection cleaned up', !m.selectedPostIds.has('gone'));
    t.equal('removal reported', r.removed, 1);

    t.group('a post that is also another post child counts as present');
    m = seeded(['X', 'P']);
    m.setFeedPages([{ posts: [parent('P', [kid('X')]), parent('X')] }]);
    r = await m.reconcileLikedIndex(null);
    t.ok('it is not deleted as an orphan', m.postById.has('X'), [...m.postById.keys()]);
    t.ok('it keeps its parent identity', m.postById.get('X').isChild === false);

    t.group('an incomplete walk deletes nothing');
    m = seeded(['a', 'b', 'c']);
    m.setFeedPages([{ posts: [parent('a')] }, { fail: true }]);
    r = await m.reconcileLikedIndex(null);
    t.ok('failure reported', r.ok === false && r.reason === 'network', r);
    t.equal('index untouched', m.allPosts.length, 3);
    t.equal('no delete transaction issued', m.dbCalls.del, 0);

    t.group('mass-deletion guard');
    m = seeded(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    m.setFeedPages([{ posts: [parent('p0'), parent('p1')] }]); // feed claims 8 of 10 vanished
    r = await m.reconcileLikedIndex(null);
    t.ok('an implausible wipe is refused', r.removed === 0 && r.refusedDelete === 8, r);
    t.equal('every row survives', m.allPosts.length, 10);
    t.ok('the run is not recorded as successful', m.storage.grokSearchLastReconcileAt === undefined, m.storage);

    t.group('a plausible deletion proceeds');
    m = seeded(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    m.setFeedPages([{ posts: [0, 1, 2, 3, 4, 5, 6, 7].map(i => parent('p' + i)) }]); // 20% gone
    r = await m.reconcileLikedIndex(null);
    t.ok('genuine unlikes are removed', r.removed === 2 && m.allPosts.length === 8, r);
    t.ok('the run timestamp is recorded', typeof m.storage.grokSearchLastReconcileAt === 'string', m.storage);

    t.group('paging');
    m = seeded([]);
    m.setFeedPages([
      { posts: [parent('a'), parent('b')] },
      { posts: [parent('c')] },
    ]);
    r = await m.reconcileLikedIndex(null);
    t.equal('all pages walked', r.added, 3);
    t.equal('order is newest-first afterwards', m.allPosts.length, 3);

    t.group('no-op sweep');
    m = seeded(['a', 'b']);
    m.setFeedPages([{ posts: [parent('a'), parent('b')] }]);
    r = await m.reconcileLikedIndex(null);
    t.ok('nothing added or removed', r.added === 0 && r.removed === 0, r);
    t.ok('and no writes at all', m.dbCalls.put === 0 && m.dbCalls.del === 0, m.dbCalls);

    t.group('an empty feed is treated as an implausible wipe, not a purge');
    m = seeded(['a', 'b', 'c']);
    m.setFeedPages([]);
    r = await m.reconcileLikedIndex(null);
    t.equal('nothing deleted', m.allPosts.length, 3);
  },
};
