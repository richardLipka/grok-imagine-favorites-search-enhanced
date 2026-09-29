'use strict';

const { createIndexSandbox, createCardImageSandbox, readSource, sliceBetween } = require('../harness');
const { FakeCard, FakeImage } = require('../dom');

/**
 * Two thirds of a real library was unsearchable, and almost every video in it was labelled
 * "Media deleted" while playing perfectly when opened. Both had one cause.
 *
 * `/rest/assets` — the feed the library paginates and this script's primary source — does not
 * return `mediaGenInput`. `GET /rest/assets/{id}` does. Measured on a live account: of 23,529
 * indexed rows, 15,776 carried no prompt text of any kind and exactly 2 were linked to a parent.
 * A prompt search over that index is a search over a third of it, and a video whose parent still
 * is unknown has no poster, so the card renders the `.mp4` in an `<img>`, the load fails, and the
 * failure is read as a deletion.
 *
 * So the backfill is not a nicety: without it a feed-built index is missing the only text search
 * has and the only edge the tree has. These tests pin the three things it must not get wrong —
 * it must not invent a parent, it must not ask twice, and it must not drop what it already had.
 */
const IMAGE = (id, prompt, extra = {}) => ({
  assetId: id,
  mimeType: 'image/jpeg',
  key: `users/u/${id}/image.jpg`,
  createTime: '2026-01-01T00:00:00Z',
  mediaGenInput: { textToImage: { prompt, modelName: 'imagine-image-gen' } },
  ...extra,
});

const VIDEO = (id, parentId, prompt = '') => ({
  assetId: id,
  mimeType: 'video/mp4',
  key: `users/u/${id}/generated_video.mp4`,
  createTime: '2026-01-02T00:00:00Z',
  mediaGenInput: {
    imageToVideo: { prompt, inputAssets: [parentId], modelName: 'imagine-video-gen' },
  },
});

/** An asset exactly as the *list* endpoint hands it over: no mediaGenInput, no summary. */
const feedRow = asset => {
  const { mediaGenInput, ...rest } = asset;
  return { ...rest, summary: rest.summary || '' };
};

async function indexedFrom(assets) {
  const s = createIndexSandbox();
  s.setAssetPages([{ assets: assets.map(feedRow) }]);
  await s.syncAssetsFeed(null, { stopWhenKnown: false });
  return s;
}

module.exports = {
  name: 'prompt backfill — the prompts and parents the asset feed does not carry',
  run: async t => {
    t.group('what the feed alone produces');
    const parent = IMAGE('p1', 'a wild cherry orchard in early summer');
    const clip = VIDEO('v1', 'p1', '');
    let s = await indexedFrom([parent, clip]);
    t.equal('every asset is indexed', s.allPosts.length, 2);
    t.ok('but no prompt survives the list endpoint',
      s.allPosts.every(p => !String(p.prompt || '').trim()), s.allPosts.map(p => p.prompt));
    t.ok('and nothing is a child of anything', s.allPosts.every(p => !p.parentId));
    // This is the state the bug report describes: the rows exist, search cannot reach them.
    t.ok('so a prompt search matches nothing',
      s.allPosts.every(p => !s.getSearchablePromptText(p, s.buildPromptById()).includes('cherry')));

    t.group('the detail pass recovers both');
    s.setAssetDetails({ p1: parent, v1: clip });
    let res = await s.backfillAssetDetails({});
    t.equal('every row was asked', res.checked, 2);
    t.equal('the prompt is recovered', res.prompts, 1);
    t.equal('and the parent link with it', res.parents, 1);
    t.equal('nothing failed', res.failed, 0);
    const video = s.postById.get('v1');
    t.equal('the clip is now a child', video.isChild, true);
    t.equal('of the still it was generated from', video.parentId, 'p1');
    t.equal('the model comes back too', video.model, 'imagine-video-gen');

    t.group('and that is what makes the video searchable');
    // The clip has no prompt of its own — imageToVideo often carries none. It is findable only
    // through the still, which is exactly why the parent link matters as much as the prompt.
    t.equal('the parent prompt is denormalised onto it', video.parentPrompt,
      'a wild cherry orchard in early summer');
    t.ok('so the clip matches a search for the still it came from',
      s.getSearchablePromptText(video, s.buildPromptById()).includes('cherry'),
      s.getSearchablePromptText(video, s.buildPromptById()));
    t.ok('and the parent counts its child again',
      (s.postById.get('p1').childPostCount ?? 0) === 1, s.postById.get('p1').childPostCount);
    t.equal('as a video', s.postById.get('p1').childVideoCount, 1);
    t.ok('the grid was told to redraw', s.uiCalls.filter >= 1, s.uiCalls.filter);
    t.ok('with its cached page entries dropped', s.uiCalls.displayInvalidated >= 1);

    t.group('answers are written as they arrive, not only at the end');
    // The pass covers the whole index and runs for minutes. Buffering every row until it
    // finishes means a reload two thirds of the way through throws all of it away.
    t.ok('there is an intermediate flush', readSource().includes('done % BACKFILL_FLUSH_EVERY === 0'),
      'the backfill only writes once, at the end');

    t.group('a row is asked once, not once per pass');
    // 74% of detail requests carry a prompt; the rest genuinely have none. Re-asking those every
    // pass would mean thousands of requests that can never return anything.
    const before = res.checked;
    res = await s.backfillAssetDetails({});
    t.equal('a second pass has nothing to do', res.checked, 0);
    t.ok('including the rows that answered with no prompt at all', before === 2);
    t.equal('and it says so rather than reporting work',
      s.uiCalls.flash[s.uiCalls.flash.length - 1], 'prompts already complete');
    res = await s.backfillAssetDetails({ force: true });
    t.equal('force re-asks everything', res.checked, 2);

    t.group('an asset with no generation context at all');
    s = await indexedFrom([IMAGE('u1', 'x')]);
    s.setAssetDetails({ u1: { assetId: 'u1', mimeType: 'image/jpeg', summary: '' } });
    res = await s.backfillAssetDetails({});
    t.equal('it is asked', res.checked, 1);
    t.equal('and yields nothing', res.prompts, 0);
    // Stamped anyway: "this asset has no prompt" is a final answer, and not recording it is how
    // a backfill re-reads the same dead rows for ever.
    t.equal('but is not asked again', (await s.backfillAssetDetails({})).checked, 0);

    t.group('a parent that is not in the index is not linked');
    // A dangling parentId would make the row a child of nothing: hidden by the child filter,
    // absent from every tree, and searchable only by a prompt it does not have.
    s = await indexedFrom([VIDEO('v9', 'missing-parent', 'a lone clip')]);
    s.setAssetDetails({ v9: VIDEO('v9', 'missing-parent', 'a lone clip') });
    res = await s.backfillAssetDetails({});
    t.equal('no link is invented', res.parents, 0);
    t.equal('the row stays top-level', s.postById.get('v9').isChild, false);
    t.equal('while its own prompt is still recovered', s.postById.get('v9').prompt, 'a lone clip');

    t.group('pacing finds the rate instead of assuming one');
    // The bucket here is large and refills slowly, which is the worst shape to hardcode against:
    // the first 300 requests went through at 41/s with no limit, and the sustained rate after it
    // drained measured about 5. Any fixed delay is wrong by roughly eight times in one direction
    // or the other, so the delay is discovered.
    s = createIndexSandbox();
    s.resetDetailPacing();
    t.equal('it starts out of the way', s.getDetailDelayMs(), 0);
    s.noteDetailRateLimit();
    const first = s.getDetailDelayMs();
    t.ok('a rate limit introduces one', first > 0, first);
    s.noteDetailRateLimit();
    t.equal('and the next one doubles it', s.getDetailDelayMs(), first * 2);
    for (let i = 0; i < 12; i++) s.noteDetailRateLimit();
    t.ok('but it is capped', s.getDetailDelayMs() <= 2000, s.getDetailDelayMs());
    const capped = s.getDetailDelayMs();
    for (let i = 0; i < 119; i++) s.noteDetailSuccess();
    t.equal('a short clean run does not move it', s.getDetailDelayMs(), capped);
    s.noteDetailSuccess();
    t.ok('a long one decays it', s.getDetailDelayMs() < capped, s.getDetailDelayMs());
    s.resetDetailPacing();
    t.equal('and a new pass starts clean', s.getDetailDelayMs(), 0);
    // A pass that inherited the previous pass's backoff would crawl for no reason.
    t.ok('which backfillAssetDetails does', readSource().includes('resetDetailPacing();'),
      'the pass does not reset its pacing');

    t.group('a rate-limited request is not retried on a second transport');
    // Sending it to GM as well doubles the load on the bucket that just rejected it -- and that
    // is what turned the first live run into six workers each waiting five seconds in parallel.
    s = createIndexSandbox();
    s.setStored('grokSearchRateLimitWaitMs', '1000');
    await s.syncAssetsFeed(null, { stopWhenKnown: false });
    s.setAssetPages([{ assets: [feedRow(IMAGE('r1', 'x'))] }]);
    await s.syncAssetsFeed(null, { stopWhenKnown: false });
    let calls = 0;
    s.setPageFetch(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429 };
      return { ok: true, status: 200, json: async () => ({ asset: IMAGE('r1', 'recovered') }) };
    });
    s.setAssetDetails({ r1: IMAGE('r1', 'from gm') });
    res = await s.backfillAssetDetails({});
    t.equal('the page transport was asked twice', calls, 2);
    t.equal('and the manager not at all', s.gmDetailCalls.length, 0);
    t.equal('the retry is what answered', s.postById.get('r1').prompt, 'recovered');
    t.equal('so nothing is counted as a failure', res.failed, 0);
    t.ok('and the pass slowed itself down', s.getDetailDelayMs() > 0, s.getDetailDelayMs());

    t.group('a rate limit from either transport reaches the pacer');
    // gmGetJson() retries a 429 eight times inside itself and tells nobody, so six workers each
    // burned that budget privately while the shared pause never learned there was a reason to
    // slow down. The fallback is a single shot, and its answer comes back here.
    s = createIndexSandbox();
    s.setStored('grokSearchRateLimitWaitMs', '1000');
    s.setAssetPages([{ assets: [feedRow(IMAGE('t1', 'x'))] }]);
    await s.syncAssetsFeed(null, { stopWhenKnown: false });
    // No page fetch installed, so the attempt goes through the manager.
    s.setAssetDetails({ t1: IMAGE('t1', 'eventually') });
    res = await s.backfillAssetDetails({});
    t.equal('the row is read', res.prompts, 1);
    t.ok('and the manager was used exactly once per attempt',
      s.gmDetailCalls.length === 1, s.gmDetailCalls.length);
    t.ok('the fallback is single-shot, not a private retry loop',
      /gmRequestOnce\(url, null, null, 'GET'\)/.test(readSource()), 'gmGetJson still used here');
    t.ok('and its 429 feeds the shared pacer',
      /if \(gm\.status === 429\) \{ noteDetailRateLimit\(\); continue; \}/.test(readSource()),
      'a manager 429 does not slow the pass down');

    t.group('an asset that is gone is an answer, not a failure');
    // 404 means deleted. Counting it as a failure leaves the row unstamped, so every later pass
    // asks again -- for ever, for a row that can never answer.
    s = await indexedFrom([IMAGE('g1', 'gone')]);
    s.setAssetDetails({});
    res = await s.backfillAssetDetails({});
    t.equal('it is not counted as a failure', res.failed, 0);
    t.equal('and it is not asked again', (await s.backfillAssetDetails({})).checked, 0);

    t.group('a failed request leaves the row alone');
    s = await indexedFrom([IMAGE('f1', 'something')]);
    s.setAssetDetails({ f1: { fail: true, status: 500 } });
    res = await s.backfillAssetDetails({});
    t.equal('it is counted as failed', res.failed, 1);
    t.equal('nothing was recovered', res.prompts, 0);
    // The crucial half: an unstamped row is retried next time. Stamping on failure would turn a
    // transient 500 into a row that is permanently unsearchable.
    t.equal('and the row is asked again next pass', s.rowsNeedingDetail(false).length, 1);

    t.group('an existing prompt is never overwritten');
    s = await indexedFrom([IMAGE('k1', 'from the feed', { summary: 'from the feed' })]);
    t.equal('the feed did supply this one', s.postById.get('k1').prompt, 'from the feed');
    s.setAssetDetails({ k1: IMAGE('k1', 'from the detail endpoint') });
    // It is still asked, because it has no parent link yet -- but the prompt it already has wins.
    await s.backfillAssetDetails({});
    t.equal('the stored prompt survives', s.postById.get('k1').prompt, 'from the feed');

    t.group('the stamp is persisted, or the work is repeated every session');
    s = await indexedFrom([IMAGE('s1', 'p')]);
    s.setAssetDetails({ s1: IMAGE('s1', 'p') });
    await s.backfillAssetDetails({});
    const stored = s.toStorageRecord(s.postById.get('s1'));
    t.ok('the storage record carries it', Boolean(stored.promptProbedAt), Object.keys(stored));
    t.ok('and the runtime fields still do not',
      !('_search' in stored) && !('_ms' in stored), Object.keys(stored));

    t.group('it will not run before the index is loaded');
    s = await indexedFrom([IMAGE('l1', 'p')]);
    s.setLoaded(false);
    t.equal('an unloaded index is refused', await s.backfillAssetDetails({}), null);

    t.group('child counts are raised, never lowered');
    // A legacy row's childPostCount came from the API and can exceed the number of child rows
    // that were ever fetched. Recomputing it downwards would throw that away.
    s = createIndexSandbox();
    const root = s.addPostRow(s.normalizePost({ id: 'r', prompt: 'r', childPostCount: 7 }));
    s.addPostRow(s.normalizePost({ id: 'c', prompt: 'c', parentId: 'r', isChild: true }));
    s.recomputeChildCounts(null);
    t.equal('the larger legacy count stands', root.childPostCount, 7);
    const root2 = s.addPostRow(s.normalizePost({ id: 'r2', prompt: 'r2' }));
    s.addPostRow(s.normalizePost({ id: 'c2', prompt: 'c2', parentId: 'r2', isChild: true, mediaType: 'MEDIA_POST_TYPE_VIDEO' }));
    s.recomputeChildCounts(null);
    t.equal('a parent that had none gains the real one', root2.childPostCount, 1);
    t.equal('counted by kind', root2.childVideoCount, 1);
    t.equal('and not double-counted as an image', root2.childImageCount, 0);

    t.group('a reindex is not finished until the detail pass has run');
    // Otherwise a rebuild produces 23,000 rows of untitled thumbnails and reports success.
    const reindex = sliceBetween(readSource(), '  async function reindexDatabase() {', '\n  /**');
    t.ok('reindexDatabase awaits it', /await backfillAssetDetails\(/.test(reindex), reindex.slice(-400));
    t.ok('before it reports a finished index',
      reindex.indexOf('backfillAssetDetails') < reindex.indexOf('Reindex done'), 'ordering');
    t.ok('and an existing index can run it without a rebuild',
      readSource().includes("btn.id = 'grok-fix-prompts-btn'"), 'no manual entry point');

    t.group('a video is not a broken image');
    // 927 of 7,529 videos in a real index had no image anywhere to fall back to, so the card
    // was handed the .mp4 itself. An <img> cannot decode that, fires `error`, and the card
    // called it deleted -- while the same file played fine in the lightbox one click away.
    const created = [];
    const { syncCardImage } = createCardImageSandbox({
      createElement: () => { const i = new FakeImage(); created.push(i); return i; },
    });
    let card = new FakeCard();
    let post = { id: 'v', _mediaUnavailable: false };
    let img = syncCardImage(card, 'https://assets.grok.com/u/v/generated_video.mp4', 'a clip', post);
    t.ok('the mp4 is never handed to the <img>', !img.getAttribute('src'), img.getAttribute('src'));
    t.equal('the card is not marked broken', card.classList.contains('grok-result-card--broken'), false);
    t.equal('the post is not marked unavailable', post._mediaUnavailable, false);
    t.equal('it is marked as a video with no poster',
      card.classList.contains('grok-result-card--noposter'), true);

    // And the error handler cannot undo that: the element still fires `error` for a missing src
    // in some browsers, and the listener is what used to set the flag.
    img.onerror?.();
    t.equal('a later error event changes nothing', post._mediaUnavailable, false);
    t.equal('nor the class', card.classList.contains('grok-result-card--broken'), false);

    t.group('a genuinely missing image is still reported');
    card = new FakeCard();
    post = { id: 'i', _mediaUnavailable: false };
    img = syncCardImage(card, 'https://assets.grok.com/u/i/image.jpg', 'a picture', post);
    t.equal('it gets its src', img.getAttribute('src'), 'https://assets.grok.com/u/i/image.jpg');
    t.equal('and is not pre-emptively flagged', post._mediaUnavailable, false);
    img.onerror();
    t.equal('but a real load failure flags it', post._mediaUnavailable, true);
    t.equal('and shows the overlay', card.classList.contains('grok-result-card--broken'), true);
    img.onload();
    t.equal('a later success clears it', post._mediaUnavailable, false);

    t.group('a row with no media at all is still broken');
    card = new FakeCard();
    post = { id: 'n', _mediaUnavailable: false };
    syncCardImage(card, '', 'nothing', post);
    t.equal('an empty thumbnail is a broken card', post._mediaUnavailable, true);
    t.equal('not a posterless video', card.classList.contains('grok-result-card--noposter'), false);

    t.group('the prune sweep probes, it does not inherit the verdict');
    const prune = sliceBetween(readSource(), '  async function runPruneMissingMedia(', '\n  /**');
    t.ok('no row is pruned on the strength of the <img> flag alone',
      !/if \(post\._mediaUnavailable\) \{\s*missing\.push/.test(prune), prune);
    t.ok('every candidate gets a real HTTP probe',
      /const exists = await checkMediaUrlExists\(url\)/.test(prune), prune);
    // getPostThumbnailUrl() falls back to a parent's or sibling's image, so probing it judges a
    // deleted video by a picture that still exists -- and an intact one by a picture that does not.
    t.ok('and the probe targets the post’s own media, not an inherited thumbnail',
      !/getPostThumbnailUrl\(post\)/.test(prune), prune);
    t.ok('a successful probe clears a stale flag',
      /post\._mediaUnavailable = false/.test(prune), prune);

    t.group('a rebuild shows its progress, not stale thumbnails');
    // The grid is not cleared when the index is, so the previous page sat behind the overlay,
    // still fetching thumbnails for rows the rebuild had already dropped.
    const loading = sliceBetween(readSource(),
      '  function showLoadingIndicator(', '\n  function hideLoadingIndicator(');
    t.equal('both loading paths hide the grid',
      (loading.match(/grid\.style\.display = 'none'/g) || []).length
        + (sliceBetween(readSource(), '  function showResultsPanelLoading(', '\n  function showLoadingIndicator(')
          .match(/grid\.style\.display = 'none'/g) || []).length, 2);
    const walk = sliceBetween(readSource(), '  async function syncAssetsFeed(', '\n  // ─── Prompt');
    t.ok('and the message says how many images have been found',
      /indexing library: \$\{added\.toLocaleString\(\)\} images \(page \$\{pages\}\)/.test(walk), walk);
  },
};
