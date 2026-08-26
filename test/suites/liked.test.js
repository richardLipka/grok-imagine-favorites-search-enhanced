'use strict';

const { createIndexSandbox, createLikeSandbox } = require('../harness');

module.exports = {
  name: 'liked state — detection, storage, and request templating',
  async run(t) {
    const m = createIndexSandbox();

    t.group('detecting like state on a payload');
    t.equal('flat isLiked', m.detectLikedState({ id: 'a', isLiked: true }), true);
    t.equal('flat false is preserved', m.detectLikedState({ id: 'a', isLiked: false }), false);
    t.equal('alternative field name', m.detectLikedState({ id: 'a', favorited: true }), true);
    t.equal('nested under viewerState', m.detectLikedState({ id: 'a', viewerState: { liked: true } }), true);
    t.equal('nested under interaction', m.detectLikedState({ id: 'a', interaction: { hasLiked: false } }), false);
    // The shape Grok actually sends, confirmed against a live response.
    t.equal('userInteractionStatus.likeStatus, liked',
      m.detectLikedState({ id: 'a', userInteractionStatus: { likeStatus: true } }), true);
    t.equal('userInteractionStatus.likeStatus, not liked',
      m.detectLikedState({ id: 'a', userInteractionStatus: { likeStatus: false } }), false);
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

    t.group('finding the Liked collection');
    // Liking is collection membership, not a post flag: /rest/media/post/like answers 200 and
    // changes nothing, so the heart has to add to the account's default collection instead.
    t.equal('the default collection wins',
      like.pickLikedCollection([{ id: 'a', name: 'garden' }, { id: 'b', name: 'x', isDefault: true }])?.id, 'b');
    t.equal('the name is a fallback for a localised account',
      like.pickLikedCollection([{ id: 'a', name: 'garden' }, { id: 'c', name: 'Liked' }])?.id, 'c');
    t.equal('matched case-insensitively',
      like.pickLikedCollection([{ id: 'c', name: 'LIKED' }])?.id, 'c');
    t.equal('and nothing matches nothing', like.pickLikedCollection([{ id: 'a', name: 'garden' }]), null);
    t.equal('a non-array is handled', like.pickLikedCollection(undefined), null);

    t.group('resolving it is cached, not re-fetched');
    let lk = createLikeSandbox();
    t.equal('resolved from the API', await lk.resolveLikedCollectionId(), 'liked-1');
    t.equal('and remembered in storage', lk.store.grokSearchLikedCollectionId, 'liked-1');
    const before = lk.log.requests.length;
    await lk.resolveLikedCollectionId();
    t.equal('a second call costs nothing', lk.log.requests.length, before);
    lk = createLikeSandbox({ storage: { grokSearchLikedCollectionId: 'cached-1' } });
    t.equal('a stored id is reused', await lk.resolveLikedCollectionId(), 'cached-1');
    t.equal('with no request at all', lk.log.requests.length, 0);

    t.group('liking adds to the collection, unliking removes');
    lk = createLikeSandbox();
    let r = await lk.sendLikeRequest('abc', true);
    t.equal('the add endpoint is used',
      lk.log.requests.at(-1).url, 'https://grok.com/rest/media/collection/assets/add');
    t.equal('with the collection id', lk.log.requests.at(-1).body.collectionId, 'liked-1');
    t.equal('and the asset in an array', lk.log.requests.at(-1).body.assetIds.join(), 'abc');
    t.ok('it reports success', r.ok && r.changed, r);
    lk = createLikeSandbox();
    await lk.sendLikeRequest('abc', false);
    t.equal('the remove endpoint is used for unlike',
      lk.log.requests.at(-1).url, 'https://grok.com/rest/media/collection/assets/remove');

    t.group('a call that touched nothing is reported as unchanged');
    lk = createLikeSandbox({ mutate: { ok: true, data: { addedCount: 0 } } });
    r = await lk.sendLikeRequest('abc', true);
    t.ok('still a success, since the end state is right', r.ok, r);
    t.equal('but flagged as no change', r.changed, false);
    lk = createLikeSandbox({ mutate: { ok: true, data: { removedCount: 0 } } });
    t.equal('same for unlike', (await lk.sendLikeRequest('abc', false)).changed, false);
    lk = createLikeSandbox({ mutate: { ok: true, data: {} } });
    t.equal('a response with no count is assumed to have worked',
      (await lk.sendLikeRequest('abc', true)).changed, true);

    t.group('failures are surfaced, not swallowed');
    lk = createLikeSandbox({ mutate: { ok: false, status: 500 } });
    r = await lk.sendLikeRequest('abc', true);
    t.ok('a failed mutation is not ok', !r.ok, r);
    t.equal('with the status', r.status, 500);
    lk = createLikeSandbox({ collections: null });
    r = await lk.sendLikeRequest('abc', true);
    t.ok('an unreachable collection list means no like', !r.ok, r);
    lk = createLikeSandbox({ collections: [{ id: 'a', name: 'garden' }] });
    r = await lk.sendLikeRequest('abc', true);
    t.ok('so does an account with no Liked collection', !r.ok, r);
    t.ok('and it says why', lk.log.warnings.some(w => /Liked/.test(w)), lk.log.warnings);

    t.group('a captured template still wins');
    lk = createLikeSandbox({ template: { url: 'https://grok.com/custom', body: {}, idPath: ['postId'] } });
    await lk.sendLikeRequest('abc', true);
    t.ok('the collection endpoints are bypassed', lk.log.requests.at(-1).templated === true, lk.log.requests);

    t.group('missing likedPath');
    const noFlag = { url: 'https://grok.com/like', body: { postId: '' }, idPath: ['postId'], likedPath: null };
    req = like.buildLikeRequest(noFlag, 'q', true);
    t.equal('body still gets the id', req.body.postId, 'q');
    t.ok('no invented flag is added', !('isLiked' in req.body), req.body);
  },
};
