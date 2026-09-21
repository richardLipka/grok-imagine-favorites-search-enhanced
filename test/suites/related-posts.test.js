'use strict';

const { createThumbnailSandbox } = require('../harness');

module.exports = {
  name: 'related posts — hierarchy, batch, and prompt relations',
  run(t) {
    const parent = {
      id: 'p1',
      prompt: 'Cyberpunk neon city street in rain',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/p1.jpg',
      mediaUrl: 'https://assets.grok.com/p1.jpg',
      createTime: '2026-06-01T10:00:00Z',
      conversationId: 'conv-100',
    };

    const root = {
      id: 'r1',
      prompt: 'Ancient Japanese temple in misty mountains',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/r1.jpg',
      mediaUrl: 'https://assets.grok.com/r1.jpg',
      createTime: '2026-05-20T10:00:00Z',
    };

    const intermediateParent = {
      id: 'ip1',
      parentId: 'r1',
      rootId: 'r1',
      prompt: 'Temple courtyard with cherry blossoms',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/ip1.jpg',
      mediaUrl: 'https://assets.grok.com/ip1.jpg',
      createTime: '2026-05-21T10:00:00Z',
    };

    const grandchild = {
      id: 'gc1',
      parentId: 'ip1',
      rootId: 'r1',
      prompt: 'Close up of fallen sakura petals on stone steps',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/gc1.jpg',
      mediaUrl: 'https://assets.grok.com/gc1.jpg',
      createTime: '2026-05-22T10:00:00Z',
    };

    const child1 = {
      id: 'c1',
      parentId: 'p1',
      rootId: 'p1',
      prompt: 'Cyberpunk neon city street in rain, cinematic zoom',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/c1.jpg',
      mediaUrl: 'https://assets.grok.com/c1.jpg',
      createTime: '2026-06-01T10:05:00Z',
      conversationId: 'conv-100',
    };

    const child2 = {
      id: 'c2',
      parentId: 'p1',
      rootId: 'p1',
      prompt: 'Cyberpunk neon city street in rain, drone view',
      mediaType: 'MEDIA_POST_TYPE_VIDEO',
      thumbnail: '',
      mediaUrl: 'https://assets.grok.com/c2.mp4',
      createTime: '2026-06-01T10:10:00Z',
      conversationId: 'conv-100',
    };

    const batchSibling = {
      id: 'b1',
      prompt: 'Different angle of neon alley',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/b1.jpg',
      mediaUrl: 'https://assets.grok.com/b1.jpg',
      createTime: '2026-06-01T10:02:00Z',
      conversationId: 'conv-100',
    };

    const promptTwin = {
      id: 'pt1',
      prompt: 'Cyberpunk neon city street in rain',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/pt1.jpg',
      mediaUrl: 'https://assets.grok.com/pt1.jpg',
      createTime: '2026-06-15T12:00:00Z',
      conversationId: 'conv-999',
    };

    const unrelated = {
      id: 'u1',
      prompt: 'Cute orange fluffy kitten sleeping on blanket',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
      thumbnail: 'https://assets.grok.com/u1.jpg',
      mediaUrl: 'https://assets.grok.com/u1.jpg',
      createTime: '2026-06-02T10:00:00Z',
    };

    const posts = [parent, root, intermediateParent, grandchild, child1, child2, batchSibling, promptTwin, unrelated];
    const m = createThumbnailSandbox({ posts });

    t.group('parent and child relationships');
    const forParent = m.getRelatedPosts(parent);
    const parentRelMap = new Map(forParent.map(r => [r.post.id, r]));

    t.ok('parent identifies child1 as Child', parentRelMap.get('c1')?.label === 'Child');
    t.ok('parent identifies child2 as Child', parentRelMap.get('c2')?.label === 'Child');
    t.ok('parent identifies batchSibling as Batch', parentRelMap.get('b1')?.label === 'Batch');
    t.ok('parent identifies promptTwin as Same prompt', parentRelMap.get('pt1')?.label === 'Same prompt');
    t.ok('unrelated post is not in related list', !parentRelMap.has('u1'));
    t.ok('parent does not include itself', !parentRelMap.has('p1'));

    t.group('child perspectives');
    const forChild1 = m.getRelatedPosts(child1);
    const child1RelMap = new Map(forChild1.map(r => [r.post.id, r]));

    t.equal('child identifies immediate parent as Parent', child1RelMap.get('p1')?.label, 'Parent');
    t.equal('child identifies child2 as Sibling', child1RelMap.get('c2')?.label, 'Sibling');
    t.equal('child identifies batchSibling as Batch', child1RelMap.get('b1')?.label, 'Batch');
    t.ok('child does not include itself', !child1RelMap.has('c1'));

    t.group('deep tree hierarchy (root and grandchild)');
    const forGrandchild = m.getRelatedPosts(grandchild);
    const gcRelMap = new Map(forGrandchild.map(r => [r.post.id, r]));

    t.equal('grandchild identifies immediate parent', gcRelMap.get('ip1')?.label, 'Parent');
    t.equal('grandchild identifies root ancestor', gcRelMap.get('r1')?.label, 'Root');

    t.group('deduplication and limits');
    t.ok('child2 only appears once in related list', forChild1.filter(r => r.post.id === 'c2').length === 1);
    const limited = m.getRelatedPosts(parent, 2);
    t.equal('respects limit parameter', limited.length, 2);
  },
};
