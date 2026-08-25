'use strict';

const { createIndexSandbox } = require('../harness');

const parent = (id, prompt = 'p ' + id) => ({
  id, prompt, createTime: '2026-06-01T00:00:00Z', mediaType: 'MEDIA_POST_TYPE_IMAGE',
});
const childRow = (id, parentId, parentPrompt) => ({
  id, isChild: true, parentId, parentPrompt, prompt: '', createTime: '2026-06-01T01:00:00Z',
});

module.exports = {
  name: 'index mutation — id-keyed updates, never array positions',
  async run(t) {
    const m = createIndexSandbox();

    // Index laid out as [P1, c1, c2, c3, P2]. P2 sits *after* the children on purpose:
    // the old index-keyed code corrupted exactly this slot when a child was removed.
    m.addPostRow(m.normalizePost(parent('P1', 'parent one')));
    for (const id of ['c1', 'c2', 'c3']) {
      m.addPostRow(m.normalizePost(childRow(id, 'P1', 'parent one')));
    }
    m.addPostRow(m.normalizePost(parent('P2', 'parent two')));

    t.group('child sync: one removed, one added');
    const writer = m.createIndexWriter();
    const kid = id => ({ id, prompt: '', mediaType: 'MEDIA_POST_TYPE_IMAGE', createTime: '2026-06-01T01:00:00Z', childPosts: [] });
    const raw = { ...parent('P1', 'parent one'), childPosts: [kid('c1'), kid('c3'), kid('c4')] };
    const parsed = m.normalizePost(m.parsePost(raw));
    const stats = m.syncChildRecordsForParent(raw, parsed, writer);

    t.ok('c2 removed', stats.removed === 1 && !m.postById.has('c2'), stats);
    t.ok('c4 added', stats.added === 1 && m.postById.has('c4'), stats);
    t.ok('the unrelated row after the removal is intact',
      m.postById.get('P2')?.prompt === 'parent two' && !m.postById.get('P2').isChild,
      m.postById.get('P2'));
    t.ok('every array row is reachable by id',
      m.allPosts.every(p => m.postById.get(p.id) === p),
      m.allPosts.map(p => p.id));
    t.ok('no duplicate ids',
      new Set(m.allPosts.map(p => p.id)).size === m.allPosts.length,
      m.allPosts.map(p => p.id));
    t.ok('knownIds tracks the removal', !m.knownIds.has('c2') && m.knownIds.has('c4'));

    t.group('write batching');
    const before = { ...m.dbCalls };
    await writer.flush();
    t.equal('one put transaction for the whole pass', m.dbCalls.put - before.put, 1);
    t.equal('one delete transaction for the whole pass', m.dbCalls.del - before.del, 1);

    t.group('in-place update');
    const p1 = m.postById.get('P1');
    const merged = m.normalizePost({ ...p1, prompt: 'parent one renamed' });
    const returned = m.updatePostRow(merged);
    t.ok('the existing object is mutated, not replaced', returned === p1);
    t.equal('field applied', p1.prompt, 'parent one renamed');
    t.equal('derived cache refreshed', p1._search, 'parent one renamed');
    t.ok('the array still holds the same object', m.allPosts.includes(p1));
    t.ok('unknown id returns null', m.updatePostRow(m.normalizePost(parent('nope'))) === null);

    t.group('stale keys are dropped on update');
    const stamped = m.updatePostRow(m.stampMetadataRefreshed(m.normalizePost({ ...p1 })));
    t.ok('stamp applied', typeof stamped.metadataRefreshedAt === 'number');
    m.updatePostRow(m.normalizePost({ ...p1, metadataRefreshedAt: undefined }));
    t.ok('key absent from the new shape is deleted', !('metadataRefreshedAt' in p1), Object.keys(p1));

    t.group('parent prompt propagation');
    const w2 = m.createIndexWriter();
    const moved = m.propagateParentPromptToChildren('P1', 'parent one renamed', w2);
    const kids = m.allPosts.filter(p => p.parentId === 'P1');
    t.equal('every child updated', moved, kids.length);
    t.ok('parentPrompt applied', kids.every(k => k.parentPrompt === 'parent one renamed'));
    t.ok('child search blobs rebuilt', kids.every(k => k._search.includes('parent one renamed')));
    t.equal('running it again is a no-op', m.propagateParentPromptToChildren('P1', 'parent one renamed', w2), 0);

    t.group('index revision');
    const rev = m.indexRevision;
    m.addPostRow(m.normalizePost(parent('P9')));
    t.ok('adding a row bumps the revision', m.indexRevision > rev, { before: rev, after: m.indexRevision });
  },
};
