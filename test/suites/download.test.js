'use strict';

const { createDownloadSandbox, createBulkDownloadSandbox } = require('../harness');

const post = (id, extra = {}) => ({
  id,
  mediaUrl: `https://assets.grok.com/${id}.webp`,
  mediaType: 'MEDIA_POST_TYPE_IMAGE',
  prompt: 'p',
  ...extra,
});

const posts = (...ids) => ids.map(id => post(id));

module.exports = {
  name: 'downloads — retry, cancel, and resuming what is left',
  async run(t) {
    t.group('a transient failure is retried');
    let m = createDownloadSandbox({
      fetchResults: [{ throw: 'boom' }, { throw: 'boom' }, { ok: true }],
      gmResults: [{ error: true }, { error: true }],
    });
    const blob = await m.prepareDownloadBlobWithRetry(post('a'));
    t.ok('a blob comes back', blob instanceof Blob, blob);
    t.equal('three attempts were made', m.log.fetches.length, 3);
    t.equal('with a backoff between them', m.log.sleeps, 2);

    t.group('and gives up after the attempt budget');
    m = createDownloadSandbox({
      fetchResults: [{ throw: 'boom' }, { throw: 'boom' }, { throw: 'boom' }, { throw: 'boom' }],
      gmResults: [{ error: true }, { error: true }, { error: true }, { error: true }],
    });
    let threw = null;
    try { await m.prepareDownloadBlobWithRetry(post('a')); } catch (e) { threw = e; }
    t.ok('the error is surfaced', threw instanceof Error, threw);
    t.equal('after exactly three attempts', m.log.fetches.length, 3);
    t.ok('and it is not reported as an abort', !m.isAbortError(threw), threw?.name);

    t.group('GM_xmlhttpRequest is the fallback when page fetch fails');
    m = createDownloadSandbox({ fetchResults: [{ throw: 'cors' }], gmResults: [{ status: 200 }] });
    const viaGm = await m.prepareDownloadBlob(post('a'));
    t.equal('the page fetch was tried first', m.log.fetches.length, 1);
    t.equal('then GM_xmlhttpRequest', m.log.gm.length, 1);
    t.ok('and it produced the blob', viaGm instanceof Blob, viaGm);
    t.equal('no retry was needed', m.log.sleeps, 0);

    t.group('an HTTP error still counts as a failure');
    m = createDownloadSandbox({
      maxAttempts: 1,
      fetchResults: [{ status: 404 }],
      gmResults: [{ status: 404 }],
    });
    threw = null;
    try { await m.prepareDownloadBlobWithRetry(post('a')); } catch (e) { threw = e; }
    t.ok('it throws rather than saving an error page', threw instanceof Error, threw);

    t.group('an abort stops immediately and is never retried');
    const ac = new AbortController();
    m = createDownloadSandbox({ fetchResults: [{ abort: true }, { ok: true }, { ok: true }] });
    threw = null;
    try { await m.prepareDownloadBlobWithRetry(post('a'), ac.signal); } catch (e) { threw = e; }
    t.ok('an AbortError comes back', m.isAbortError(threw), threw?.name);
    t.equal('only one attempt was made', m.log.fetches.length, 1);
    t.equal('and nothing waited on a backoff', m.log.sleeps, 0);

    t.group('an already-aborted signal never reaches the network');
    const dead = new AbortController();
    dead.abort();
    m = createDownloadSandbox();
    threw = null;
    try { await m.prepareDownloadBlobWithRetry(post('a'), dead.signal); } catch (e) { threw = e; }
    t.ok('it refuses up front', m.isAbortError(threw), threw?.name);
    t.equal('no request was issued', m.log.fetches.length + m.log.gm.length, 0);

    t.group('cancelling reaches a GM request already in flight');
    const live = new AbortController();
    m = createDownloadSandbox({ gmResults: [{ hang: true }] });
    const pending = m.fetchPostMediaBlobGm('https://assets.grok.com/a.webp', live.signal)
      .then(() => null, e => e);
    live.abort();
    const abortErr = await pending;
    t.ok('the request is aborted', m.log.aborted === 1, m.log.aborted);
    t.ok('and the promise rejects as an abort', m.isAbortError(abortErr), abortErr?.name);

    t.group('videos skip the metadata step');
    m = createDownloadSandbox();
    await m.prepareDownloadBlob(post('v', { mediaType: 'MEDIA_POST_TYPE_VIDEO' }));
    t.equal('no tagging attempted', m.log.embeds, 0);
    await m.prepareDownloadBlob(post('i'));
    t.equal('but an image is tagged', m.log.embeds, 1);
    t.ok('and an .mp4 url is treated as video whatever the type says',
      !m.isDownloadableImagePost(post('x', { mediaUrl: 'https://a/b.mp4' })));

    // ── the bulk loop ────────────────────────────────────────────────────────────────────
    t.group('a clean run');
    let b = createBulkDownloadSandbox();
    await b.downloadPostsToFolder(posts('a', 'b', 'c'));
    t.equal('every file is written', b.log.saved.join(','), 'a.jpg,b.jpg,c.jpg');
    t.equal('nothing is left over', b.failed.length, 0);
    t.equal('the folder handle is released', b.dirHandle, null);
    t.ok('the final status reports the count',
      b.log.statuses.at(-1) === 'saved 3 files', b.log.statuses.at(-1));
    t.equal('the folder was asked for once', b.log.picks, 1);
    t.equal('and write permission checked', b.log.permissionChecks, 1);
    t.ok('the run is no longer busy', !b.busy);

    t.group('failures are collected for a retry');
    b = createBulkDownloadSandbox({ fetchFails: ['b'], saveFails: ['c.jpg'] });
    await b.downloadPostsToFolder(posts('a', 'b', 'c', 'd'));
    t.equal('the good files are written', b.log.saved.join(','), 'a.jpg,d.jpg');
    t.equal('both kinds of failure are remembered',
      b.failed.map(p => p.id).join(','), 'b,c');
    t.ok('the folder is kept so the retry does not re-prompt', b.dirHandle !== null, b.dirHandle);
    t.ok('the status names the failures',
      b.log.statuses.at(-1) === 'saved 2, failed 2', b.log.statuses.at(-1));

    t.group('a post with no usable media url fails rather than being skipped silently');
    b = createBulkDownloadSandbox();
    await b.downloadPostsToFolder([post('a'), post('bad', { noFilename: true })]);
    t.equal('it lands in the failed list', b.failed.map(p => p.id).join(','), 'bad');

    t.group('retrying reuses the folder');
    const flaky = { fetchFails: ['b'] };
    b = createBulkDownloadSandbox(flaky);
    await b.downloadPostsToFolder(posts('a', 'b', 'c'));
    t.equal('one failure recorded', b.failed.length, 1);
    flaky.fetchFails = [];      // the network comes back
    await b.retryFailedDownloads();
    t.equal('the folder picker was not shown again', b.log.picks, 1);
    t.equal('but permission was re-checked', b.log.permissionChecks, 2);
    t.equal('the retry succeeded this time', b.log.saved.join(','), 'a.jpg,c.jpg,b.jpg');
    t.equal('and the failed list is now empty', b.failed.length, 0);

    t.group('a retry that fails again keeps the file queued');
    b = createBulkDownloadSandbox({ fetchFails: ['b'] });
    await b.downloadPostsToFolder(posts('a', 'b'));
    await b.retryFailedDownloads();
    t.equal('it is still pending', b.failed.map(p => p.id).join(','), 'b');
    t.ok('and the folder is still held', b.dirHandle !== null);

    t.group('cancelling stops the run and queues everything left');
    // Cancel lands while the third file is in flight, and fires only once so the resume runs
    // to completion.
    const once = { fired: false, beforeEach(p) {
      if (p.id === 'c' && !once.fired) { once.fired = true; cancelled.cancelBulkDownload(); }
    } };
    const cancelled = createBulkDownloadSandbox(once);
    await cancelled.downloadPostsToFolder(posts('a', 'b', 'c', 'd', 'e'));
    t.equal('the files before the cancel are kept', cancelled.log.saved.join(','), 'a.jpg,b.jpg');
    t.equal('the aborted file and the rest are queued',
      cancelled.failed.map(p => p.id).join(','), 'c,d,e');
    t.ok('the status says it was cancelled',
      String(cancelled.log.statuses.at(-1)).startsWith('cancelled — saved 2 files, 3 left'),
      cancelled.log.statuses.at(-1));
    t.ok('the run is not left marked busy', !cancelled.busy);
    t.ok('the folder is held for the resume', cancelled.dirHandle !== null);

    t.group('and resuming picks up exactly where it stopped');
    await cancelled.retryFailedDownloads();
    t.equal('the remaining files are written',
      cancelled.log.saved.join(','), 'a.jpg,b.jpg,c.jpg,d.jpg,e.jpg');
    t.equal('with no second folder prompt', cancelled.log.picks, 1);
    t.equal('and nothing left over', cancelled.failed.length, 0);

    t.group('cancel is inert when nothing is running');
    b = createBulkDownloadSandbox();
    b.cancelBulkDownload();
    t.equal('no status is shown', b.log.statuses.length, 0);
    await b.downloadPostsToFolder(posts('a'));
    t.equal('and the next run is unaffected', b.log.saved.join(','), 'a.jpg');

    t.group('nothing runs without a folder');
    b = createBulkDownloadSandbox({ pickerError: Object.assign(new Error('unsupported'), { message: 'unsupported' }) });
    await b.downloadPostsToFolder(posts('a', 'b'));
    t.equal('no files written', b.log.saved.length, 0);
    t.ok('and the reason is explained',
      b.log.statuses.at(-1) === 'folder picker unavailable (Chrome/Edge)', b.log.statuses.at(-1));

    t.group('dismissing the picker is not an error');
    b = createBulkDownloadSandbox({ pickerError: Object.assign(new Error('x'), { name: 'AbortError' }) });
    await b.downloadPostsToFolder(posts('a'));
    t.equal('nothing is said at all', b.log.statuses.length, 0);

    t.group('the confirm dialog');
    b = createBulkDownloadSandbox();
    await b.downloadPostsToFolder(posts('a', 'b', 'c'));
    t.equal('a small batch is not confirmed', b.log.confirms, 0);
    b = createBulkDownloadSandbox();
    await b.downloadPostsToFolder(posts('a', 'b', 'c', 'd', 'e', 'f'));
    t.equal('a large one is', b.log.confirms, 1);
    b = createBulkDownloadSandbox({ confirm: false });
    await b.downloadPostsToFolder(posts('a', 'b', 'c', 'd', 'e', 'f'));
    t.equal('declining stops it before the folder picker', b.log.picks, 0);

    t.group('a retry never re-asks for confirmation');
    b = createBulkDownloadSandbox({ fetchFails: ['a', 'b', 'c', 'd', 'e', 'f'] });
    await b.downloadPostsToFolder(posts('a', 'b', 'c', 'd', 'e', 'f'));
    t.equal('the first run confirmed once', b.log.confirms, 1);
    await b.retryFailedDownloads();
    t.equal('the resume did not ask again', b.log.confirms, 1);

    t.group('a second run cannot start while one is in flight');
    let overlap = createBulkDownloadSandbox({
      async beforeEach(p) {
        if (p.id === 'a') await overlap.downloadPostsToFolder(posts('x', 'y'));
      },
    });
    await overlap.downloadPostsToFolder(posts('a', 'b'));
    t.equal('the nested call is refused', overlap.log.saved.join(','), 'a.jpg,b.jpg');
    t.equal('and it never reached the picker', overlap.log.picks, 1);

    t.group('clearing the queue');
    b = createBulkDownloadSandbox({ fetchFails: ['a'] });
    await b.downloadPostsToFolder(posts('a'));
    t.equal('there is something queued', b.failed.length, 1);
    b.clearFailedDownloads();
    t.equal('and it can be dismissed', b.failed.length, 0);
    t.equal('releasing the folder handle with it', b.dirHandle, null);
  },
};
