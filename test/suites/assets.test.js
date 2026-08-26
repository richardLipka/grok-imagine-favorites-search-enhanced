'use strict';

const { createIndexSandbox } = require('../harness');

/** A row shaped like a real /rest/assets entry. */
const asset = (id, over = {}) => ({
  assetId: id,
  mimeType: 'image/jpeg',
  key: `users/u-1/generated/${id}/image.jpg`,
  createTime: '2026-08-26T07:05:59.377Z',
  sourceConversationId: 'conv-1',
  width: 1152,
  height: 1728,
  isDeleted: false,
  mediaGenInput: { textToImage: { prompt: 'a red fox', modelName: 'imagine-image-gen' } },
  ...over,
});

module.exports = {
  name: 'asset feed — parsing, ordered sync, and reconcile safety',
  async run(t) {
    const m = createIndexSandbox();

    t.group('media URL comes from the storage key, with no extra request');
    t.equal('CDN host plus key',
      m.assetMediaUrl(asset('a')), 'https://assets.grok.com/users/u-1/generated/a/image.jpg');
    t.equal('each path segment is encoded',
      m.assetMediaUrl({ key: 'users/u 1/gen/a b.jpg' }),
      'https://assets.grok.com/users/u%201/gen/a%20b.jpg');
    t.equal('no key means no url', m.assetMediaUrl({}), '');

    t.group('the generation input is a oneof, so the branch is found by shape');
    t.equal('text to image', m.assetGenInput(asset('a'))?.prompt, 'a red fox');
    t.equal('an unfamiliar branch still resolves',
      m.assetGenInput({ mediaGenInput: { somethingNew: { prompt: 'p', modelName: 'm' } } })?.prompt, 'p');
    t.equal('a branch with neither prompt nor model is skipped',
      m.assetGenInput({ mediaGenInput: { junk: { foo: 1 }, textToImage: { prompt: 'real' } } })?.prompt, 'real');
    t.equal('no gen input at all', m.assetGenInput({}), null);

    t.group('media type from the MIME type');
    t.equal('image', m.assetMediaType(asset('a')), 'MEDIA_POST_TYPE_IMAGE');
    t.equal('video', m.assetMediaType(asset('a', { mimeType: 'video/mp4' })), 'MEDIA_POST_TYPE_VIDEO');
    t.equal('unknown stays empty rather than guessing', m.assetMediaType({ mimeType: 'application/pdf' }), '');

    t.group('parsing an asset into an index row');
    const row = m.parseAsset(asset('a'));
    t.equal('id', row.id, 'a');
    t.equal('prompt comes from the generation input', row.prompt, 'a red fox');
    t.equal('model too', row.model, 'imagine-image-gen');
    t.equal('create time', row.createTime, '2026-08-26T07:05:59.377Z');
    t.equal('the conversation is kept for grouping', row.conversationId, 'conv-1');
    t.equal('thumbnail falls back to the full media', row.thumbnail, row.mediaUrl);
    t.equal('assets carry no like state, so it stays unknown', row.isLiked, null);
    t.equal('an asset is never a child row', row.isChild, false);
    t.equal('a video counts as one', m.parseAsset(asset('v', { mimeType: 'video/mp4' })).videoCount, 1);
    t.equal('an image does not', row.videoCount, 0);

    t.group('rows that must not be indexed');
    t.equal('a deleted asset', m.parseAsset(asset('a', { isDeleted: true })), null);
    t.equal('one with no id', m.parseAsset(asset('')), null);
    t.equal('a promptless asset falls back to its summary',
      m.parseAsset(asset('a', { mediaGenInput: null, summary: 'from summary' })).prompt, 'from summary');

    t.group('rows the feed carries but an image index should not');
    // Grok copies its stock character assets into every account. They have no mediaGenInput, so
    // they render as blank cards the user never made; the voice files are not images at all.
    const stock = over => asset('s', { auxKeys: { imagine_official_asset: 'true',
      duplicated_from_asset_id: 'orig-1' }, mediaGenInput: null, ...over });
    t.ok('a stock picture is refused', !m.isIndexableAsset(stock({ name: 'Lena-Picture.png' })));
    t.ok('a stock voice file is refused',
      !m.isIndexableAsset(stock({ name: 'Michael-Voice.mp3', mimeType: 'audio/mpeg' })));
    t.ok('audio is refused whoever owns it',
      !m.isIndexableAsset(asset('a', { mimeType: 'audio/mpeg' })));
    t.ok('so is anything with no MIME type at all', !m.isIndexableAsset(asset('a', { mimeType: '' })));
    t.equal('and parseAsset returns null for them', m.parseAsset(stock({})), null);

    t.group('but ordinary rows are kept');
    t.ok('a generated image', m.isIndexableAsset(asset('a')));
    t.ok('a generated video', m.isIndexableAsset(asset('a', { mimeType: 'video/mp4' })));
    // The flag is a string; only the literal 'true' means stock. Presence alone must not exclude.
    t.ok("auxKeys saying 'false' is not a stock asset",
      m.isIndexableAsset(asset('a', { auxKeys: { imagine_official_asset: 'false' } })));
    t.ok('nor is an unrelated auxKey',
      m.isIndexableAsset(asset('a', { auxKeys: { r_rated: 'true', thumbhash: 'zzz' } })));
    // The user's own uploads have no mediaGenInput either, and they are genuinely theirs.
    t.ok('an own upload with no generation input is kept',
      m.isIndexableAsset(asset('a', { mediaGenInput: null, fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE' })));
    t.ok('a deleted asset is still refused', !m.isIndexableAsset(asset('a', { isDeleted: true })));

    t.group('stock assets are skipped by the sync, not merely unrendered');
    let f = createIndexSandbox();
    f.setAssetPages([{ assets: [asset('good'), stock({ assetId: 'stock1' }),
      asset('audio1', { mimeType: 'audio/mpeg' })] }]);
    await f.syncAssetsFeed(null, { stopWhenKnown: false });
    t.equal('only the real one is indexed', f.allPosts.map(p => p.id).join(','), 'good');

    t.group('and Verify can clear ones already in the index');
    f = createIndexSandbox();
    f.addPostRow(f.normalizePost({ id: 'stock1', prompt: '', createTime: '2026-08-26T00:00:00Z' }));
    f.addPostRow(f.normalizePost({ id: 'good', prompt: 'keep me', createTime: '2026-08-26T00:00:00Z' }));
    f.setFeedPages([{ posts: [] }]);
    f.setAssetPages([{ assets: [asset('good'), stock({ assetId: 'stock1' })] }]);
    const swept = await f.reconcileLikedIndex(null);
    t.equal('the stock row is removed', swept.removed, 1);
    t.ok('and the real one stays', f.postById.has('good') && !f.postById.has('stock1'),
      [...f.postById.keys()]);

    t.group('the request URL');
    const url = new URL(m.buildAssetsUrl(null));
    t.equal('ordered by create time', url.searchParams.get('orderBy'), 'ORDER_BY_CREATE_TIME');
    t.equal('the imagine workspace', url.searchParams.get('workspaceKind'), 'WORKSPACE_KIND_IMAGINE_ALL');
    t.equal('page size is the server cap', url.searchParams.get('pageSize'), '60');
    t.ok('page one carries no token', !url.searchParams.has('pageToken'), url.search);
    t.equal('later pages do',
      new URL(m.buildAssetsUrl('tok')).searchParams.get('pageToken'), 'tok');

    // ── the sync loop ────────────────────────────────────────────────────────────────────
    t.group('a first run indexes everything it walks');
    let s = createIndexSandbox();
    s.setAssetPages([
      { assets: [asset('a1'), asset('a2')] },
      { assets: [asset('a3')] },
    ]);
    let res = await s.syncAssetsFeed(null);
    t.equal('every asset is added', res.added, 3);
    t.equal('nothing was already known', res.updated, 0);
    t.ok('and they are in the index', ['a1', 'a2', 'a3'].every(id => s.postById.has(id)), [...s.postById.keys()]);
    t.ok('the write was buffered, not one call per row', s.dbCalls.put <= 2, s.dbCalls);

    t.group('an ordered feed lets the sync stop early');
    s = createIndexSandbox();
    const known = Array.from({ length: 10 }, (_, i) => asset('k' + i));
    s.setAssetPages([
      { assets: [asset('new1')] },
      { assets: known.slice(0, 3) },
      { assets: known.slice(3, 6) },
      { assets: known.slice(6, 9) },
      { assets: [asset('deep')] },
    ]);
    for (const a of known) s.addPostRow(s.normalizePost(s.parseAsset(a)));
    res = await s.syncAssetsFeed(null);
    t.equal('it stops after three all-known pages', res.pages, 4);
    t.equal('picking up the new row before that', res.added, 1);
    t.ok('and never reaches the page behind them', !s.postById.has('deep'), [...s.postById.keys()]);

    t.group('one stale page mid-run is not enough to stop');
    s = createIndexSandbox();
    s.addPostRow(s.normalizePost(s.parseAsset(asset('k'))));
    s.setAssetPages([
      { assets: [asset('k')] },
      { assets: [asset('k')] },
      { assets: [asset('later')] },
    ]);
    res = await s.syncAssetsFeed(null);
    t.ok('the run continues and finds it', s.postById.has('later'), [...s.postById.keys()]);

    t.group('a full reindex walks past known rows to the end');
    s = createIndexSandbox();
    s.addPostRow(s.normalizePost(s.parseAsset(asset('k'))));
    s.setAssetPages([
      { assets: [asset('k')] }, { assets: [asset('k')] }, { assets: [asset('k')] },
      { assets: [asset('k')] }, { assets: [asset('deep')] },
    ]);
    res = await s.syncAssetsFeed(null, { stopWhenKnown: false });
    t.equal('all pages walked', res.pages, 5);
    t.ok('including the far one', s.postById.has('deep'), [...s.postById.keys()]);

    t.group('a failed page is reported, never treated as the end of the feed');
    s = createIndexSandbox();
    s.setAssetPages([{ assets: [asset('a1')] }, { fail: true }, { assets: [asset('a2')] }]);
    res = await s.syncAssetsFeed(null, { stopWhenKnown: false });
    t.equal('the failure is surfaced', res.failed, true);
    t.equal('what was read is still kept', res.added, 1);

    t.group('merging onto a row the old feed created');
    s = createIndexSandbox();
    s.addPostRow(s.normalizePost({
      id: 'a1', prompt: 'old prompt', isChild: true, parentId: 'P', rootId: 'P',
      parentPrompt: 'parent text', childPostCount: 2, isLiked: true,
      createTime: '2026-08-26T07:05:59.377Z',
    }));
    s.setAssetPages([{ assets: [asset('a1')] }]);
    await s.syncAssetsFeed(null);
    const merged = s.postById.get('a1');
    t.equal('the child link survives', merged.parentId, 'P');
    t.equal('so does the denormalized parent prompt', merged.parentPrompt, 'parent text');
    t.equal('and the child count', merged.childPostCount, 2);
    t.equal('like state is not blanked by an asset that has none', merged.isLiked, true);
    t.equal('but the media url is refreshed', merged.mediaUrl, 'https://assets.grok.com/users/u-1/generated/a1/image.jpg');
    t.equal('and the prompt is taken from the asset', merged.prompt, 'a red fox');

    // ── reconcile safety ─────────────────────────────────────────────────────────────────
    t.group('reconcile counts asset-feed rows as present');
    const r = createIndexSandbox();
    // Two rows the legacy feed knows, one that only the asset feed can see.
    r.addPostRow(r.normalizePost({ id: 'legacy1', prompt: 'x', createTime: '2026-01-01T00:00:00Z' }));
    r.addPostRow(r.normalizePost({ id: 'legacy2', prompt: 'y', createTime: '2026-01-01T00:00:00Z' }));
    r.addPostRow(r.normalizePost({ id: 'assetOnly', prompt: 'z', createTime: '2026-08-26T00:00:00Z' }));
    r.setFeedPages([{ posts: [
      { id: 'legacy1', prompt: 'x', createTime: '2026-01-01T00:00:00Z' },
      { id: 'legacy2', prompt: 'y', createTime: '2026-01-01T00:00:00Z' },
    ] }]);
    r.setAssetPages([{ assets: [{ assetId: 'assetOnly', mimeType: 'image/jpeg' }] }]);
    let out = await r.reconcileLikedIndex(null);
    t.equal('nothing is deleted', out.removed, 0);
    t.ok('the asset-only row survives', r.postById.has('assetOnly'), [...r.postById.keys()]);

    t.group('and still deletes what is genuinely gone');
    r.addPostRow(r.normalizePost({ id: 'unliked', prompt: 'q', createTime: '2026-01-01T00:00:00Z' }));
    out = await r.reconcileLikedIndex(null);
    t.equal('the row absent from both feeds is removed', out.removed, 1);
    t.ok('and only that one', !r.postById.has('unliked') && r.postById.has('assetOnly'),
      [...r.postById.keys()]);

    t.group('a failed asset walk blocks deletion entirely');
    const r2 = createIndexSandbox();
    r2.addPostRow(r2.normalizePost({ id: 'keep', prompt: 'x', createTime: '2026-01-01T00:00:00Z' }));
    r2.setFeedPages([{ posts: [] }]);
    r2.setAssetPages([{ fail: true }]);
    out = await r2.reconcileLikedIndex(null);
    t.equal('nothing removed', out.removed, 0);
    t.ok('the row is still there', r2.postById.has('keep'), [...r2.postById.keys()]);
  },
};
