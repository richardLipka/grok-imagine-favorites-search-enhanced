'use strict';

const { createIndexSandbox, createLikeSandbox } = require('../harness');

module.exports = {
  name: 'liked state — detection, storage, and request templating',
  run(t) {
    const m = createIndexSandbox();

    t.group('detecting like state on a payload');
    t.equal('flat isLiked', m.detectLikedState({ id: 'a', isLiked: true }), true);
    t.equal('flat false is preserved', m.detectLikedState({ id: 'a', isLiked: false }), false);
    t.equal('alternative field name', m.detectLikedState({ id: 'a', favorited: true }), true);
    t.equal('nested under viewerState', m.detectLikedState({ id: 'a', viewerState: { liked: true } }), true);
    t.equal('nested under interaction', m.detectLikedState({ id: 'a', interaction: { hasLiked: false } }), false);
    t.equal('absent means unknown, not false', m.detectLikedState({ id: 'a' }), null);
    t.equal('non-boolean is ignored', m.detectLikedState({ id: 'a', isLiked: 'yes' }), null);
    t.equal('null payload', m.detectLikedState(null), null);

    t.group('storage record');
    const liked = m.normalizePost(m.parsePost({ id: 'p1', prompt: 'x', isLiked: true }));
    const unliked = m.normalizePost(m.parsePost({ id: 'p2', prompt: 'x', isLiked: false }));
    const unknown = m.normalizePost(m.parsePost({ id: 'p3', prompt: 'x' }));
    t.equal('liked persists', m.toStorageRecord(liked).isLiked, true);
    t.equal('unliked persists', m.toStorageRecord(unliked).isLiked, false);
    t.equal('unknown persists as null', m.toStorageRecord(unknown).isLiked, null);

    t.group('like state counts as a metadata change');
    t.ok('false -> true is a change', m.postMetadataChanged(unliked, liked) === true);
    t.ok('null -> false is a change', m.postMetadataChanged(unknown, unliked) === true);
    t.ok('same state is not a change',
      m.postMetadataChanged(liked, m.normalizePost(m.parsePost({ id: 'p1', prompt: 'x', isLiked: true }))) === false);

    t.group('child rows carry their own like state');
    const parent = { id: 'P', prompt: 'p', isLiked: false, childPosts: [{ id: 'c1', isLiked: true, mediaType: 'MEDIA_POST_TYPE_IMAGE' }] };
    const parsed = m.normalizePost(m.parsePost(parent));
    const kids = m.collectChildRecords(parent, parsed);
    t.equal('child keeps its own flag', kids[0]?.isLiked, true);
    t.equal('parent keeps its own flag', parsed.isLiked, false);

    t.group('request templating');
    const like = createLikeSandbox();
    const tpl = { url: 'https://grok.com/rest/media/post/like', method: 'POST', body: { postId: '', isLiked: false }, idPath: ['postId'], likedPath: ['isLiked'] };
    let req = like.buildLikeRequest(tpl, 'abc-123', true);
    t.equal('id substituted', req.body.postId, 'abc-123');
    t.equal('liked flag set', req.body.isLiked, true);
    t.equal('method carried', req.method, 'POST');
    req = like.buildLikeRequest(tpl, 'abc-123', false);
    t.equal('unlike flips the flag', req.body.isLiked, false);

    t.ok('the template is not mutated between calls', tpl.body.postId === '' && tpl.body.isLiked === false, tpl.body);

    const nested = { url: 'https://grok.com/x', body: { input: { media: { id: '' }, liked: false } }, idPath: ['input', 'media', 'id'], likedPath: ['input', 'liked'] };
    req = like.buildLikeRequest(nested, 'zzz', true);
    t.equal('nested id path', req.body.input.media.id, 'zzz');
    t.equal('nested liked path', req.body.input.liked, true);

    const urlTpl = { url: 'https://grok.com/rest/media/post/{id}/like', body: {}, idPath: ['postId'] };
    t.equal('id placeholder in the URL',
      like.buildLikeRequest(urlTpl, 'a b/c', true).url,
      'https://grok.com/rest/media/post/a%20b%2Fc/like');

    const twoUrl = { url: 'https://grok.com/like', unlikeUrl: 'https://grok.com/unlike', body: {}, idPath: ['postId'] };
    t.equal('separate unlike endpoint used', like.buildLikeRequest(twoUrl, 'x', false).url, 'https://grok.com/unlike');
    t.equal('like endpoint used for liking', like.buildLikeRequest(twoUrl, 'x', true).url, 'https://grok.com/like');

    t.group('missing likedPath');
    const noFlag = { url: 'https://grok.com/like', body: { postId: '' }, idPath: ['postId'], likedPath: null };
    req = like.buildLikeRequest(noFlag, 'q', true);
    t.equal('body still gets the id', req.body.postId, 'q');
    t.ok('no invented flag is added', !('isLiked' in req.body), req.body);
  },
};
