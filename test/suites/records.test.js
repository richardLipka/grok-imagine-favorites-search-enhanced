'use strict';

const { createIndexSandbox } = require('../harness');

module.exports = {
  name: 'records — canonical shape and derived caches',
  run(t) {
    const m = createIndexSandbox();

    t.group('storage record');
    const row = m.normalizePost({ id: 'a', prompt: 'Red Fox', createTime: '2026-06-01T10:00:00Z' });
    t.equal('createTime is cached as ms', row._ms, Date.parse('2026-06-01T10:00:00Z'));
    t.equal('search blob is lowercased', row._search, 'red fox');

    const stored = m.toStorageRecord(row);
    t.ok('runtime fields never reach storage', !('_ms' in stored) && !('_search' in stored), Object.keys(stored));
    t.ok('storage record keeps the canonical fields',
      ['id', 'prompt', 'parentPrompt', 'parentId', 'isChild', 'thumbnail', 'mediaUrl',
        'createTime', 'model', 'mediaType', 'childPostCount', 'childImageCount',
        'childVideoCount', 'videoCount'].every(k => k in stored),
      Object.keys(stored));

    t.group('missing / malformed values');
    const blank = m.normalizePost({ id: 'b' });
    t.equal('absent createTime becomes 0', blank._ms, 0);
    t.equal('absent prompt becomes an empty blob', blank._search, '');
    const bogus = m.normalizePost({ id: 'c', createTime: 'not-a-date' });
    t.equal('unparseable createTime becomes 0', bogus._ms, 0);

    t.group('child search text');
    const child = m.normalizePost({
      id: 'c1', isChild: true, parentId: 'a', prompt: 'Zoom In', parentPrompt: 'Red Fox',
    });
    t.equal('child blob joins own and parent prompt', child._search, 'zoom in red fox');
    t.equal('cache is used directly', m.getSearchablePromptText(child, null), 'zoom in red fox');

    const dedup = m.normalizePost({
      id: 'c2', isChild: true, parentId: 'a', prompt: 'Red Fox', parentPrompt: 'Red Fox',
    });
    t.equal('identical own/parent prompt is not duplicated', dedup._search, 'red fox');

    const noParent = m.normalizePost({ id: 'c3', isChild: true, parentId: 'zz', prompt: '' });
    t.equal('empty child falls back to a live parent lookup',
      m.getSearchablePromptText(noParent, new Map([['zz', 'Fallback Prompt']])),
      'fallback prompt');

    t.group('parsing');
    const parsed = m.parsePost({
      id: 'p', prompt: 'hello', mediaType: 'MEDIA_POST_TYPE_IMAGE',
      childPosts: [{ id: 'k1', mediaType: 'MEDIA_POST_TYPE_VIDEO', childPosts: [{ id: 'k2', mediaType: 'MEDIA_POST_TYPE_IMAGE' }] }],
    });
    t.equal('descendant counts span all generations', parsed.childPostCount, 2);
    t.equal('descendant videos counted', parsed.childVideoCount, 1);
    t.equal('descendant images counted', parsed.childImageCount, 1);
    t.ok('parsePost returns null without an id', m.parsePost({ prompt: 'x' }) === null);
  },
};
