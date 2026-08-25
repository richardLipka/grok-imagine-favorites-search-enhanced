'use strict';

const { createFeedSandbox } = require('../harness');

const post = (id, createTime = '2026-01-01T00:00:00Z') => ({ id, createTime });

const TEMPLATE = {
  url: 'https://grok.com/rest/media/library/list',
  method: 'POST',
  body: { pageSize: 24, filter: { kind: 'ALL' }, sort: 'RECENT' },
  cursorPath: ['pageToken'],
  limitPath: ['pageSize'],
};

module.exports = {
  name: 'feed request — captured template, response shapes, source probe',
  async run(t) {
    t.group('the default body, with no template captured');
    let m = createFeedSandbox();
    m.setMediaSource('MEDIA_POST_SOURCE_LIKED');
    let body = m.buildListBody(null);
    t.equal('the source filter is sent', body.filter.source, 'MEDIA_POST_SOURCE_LIKED');
    t.equal('with the page size', body.limit, 40);
    t.ok('and no cursor on the first page', !('cursor' in body), body);
    t.equal('a cursor is added for later pages', m.buildListBody('abc').cursor, 'abc');
    t.ok('a null source sends no filter key at all',
      !('source' in m.buildListBody(null, null).filter), m.buildListBody(null, null));

    t.group('a captured template replaces the guess entirely');
    m = createFeedSandbox({ storage: { grokSearchListRequest: JSON.stringify(TEMPLATE) } });
    t.ok('it is detected', m.hasCapturedListRequest());
    body = m.buildListBody(null);
    t.equal('the captured filter is used verbatim', body.filter.kind, 'ALL');
    t.equal('and every other captured field survives', body.sort, 'RECENT');
    t.ok('the guessed source is not injected', !('source' in body.filter), body.filter);
    t.equal('the limit is written at the captured path', body.pageSize, 40);
    t.ok('page one carries no cursor key', !('pageToken' in body), body);
    t.equal('later pages write it at the captured path', m.buildListBody('t0k3n').pageToken, 't0k3n');

    t.group('the template is never mutated between pages');
    m.buildListBody('one');
    m.buildListBody('two');
    const reread = m.readListTemplate();
    t.ok('no cursor leaked into the stored body', !('pageToken' in reread.body), reread.body);
    t.equal('and the stored page size is untouched', reread.body.pageSize, 24);

    t.group('a nested cursor path');
    m = createFeedSandbox({
      storage: {
        grokSearchListRequest: JSON.stringify({
          url: 'https://grok.com/x',
          body: { page: { size: 20 } },
          cursorPath: ['page', 'token'],
          limitPath: ['page', 'size'],
        }),
      },
    });
    t.equal('the cursor is written deep', m.buildListBody('c').page.token, 'c');
    t.equal('so is the limit', m.buildListBody('c').page.size, 40);
    t.ok('and page one leaves the branch clean',
      !('token' in m.buildListBody(null).page), m.buildListBody(null).page);

    t.group('a malformed template is ignored rather than half-used');
    for (const bad of ['not json', '{}', '{"url":"x"}', 'null', '[]']) {
      const s = createFeedSandbox({ storage: { grokSearchListRequest: bad } });
      t.ok(`refused: ${bad.slice(0, 14)}`, !s.hasCapturedListRequest(), s.readListTemplate());
    }

    t.group('reading a page out of a response');
    m = createFeedSandbox();
    t.equal('the documented shape', m.extractListPage({ posts: [post('a')], nextCursor: 'n' }).posts.length, 1);
    t.equal('and its cursor', m.extractListPage({ posts: [], nextCursor: 'n' }).nextCursor, 'n');
    t.equal('an alternative array key', m.extractListPage({ items: [post('a'), post('b')] }).posts.length, 2);
    t.equal('an alternative cursor key', m.extractListPage({ posts: [], pageToken: 'p' }).nextCursor, 'p');
    t.equal('one level of nesting', m.extractListPage({ result: { mediaPosts: [post('a')] } }).posts.length, 1);
    t.equal('a nested cursor', m.extractListPage({ result: { posts: [], endCursor: 'e' } }).nextCursor, 'e');
    t.equal('an empty response is a page of nothing', m.extractListPage({}).posts.length, 0);
    t.equal('and reports no cursor', m.extractListPage({}).nextCursor, null);
    t.equal('a non-object is handled', m.extractListPage(null).posts.length, 0);
    t.equal('an empty cursor string is not a cursor',
      m.extractListPage({ posts: [], nextCursor: '' }).nextCursor, null);

    t.group('fetchPage routes through the template when there is one');
    m = createFeedSandbox({
      storage: { grokSearchListRequest: JSON.stringify(TEMPLATE) },
      respond: () => ({ ok: true, data: { items: [post('z')], pageToken: 'next' } }),
    });
    let page = await m.fetchPage(null);
    t.equal('the captured URL is called', m.log.requests[0].url, TEMPLATE.url);
    t.ok('the page comes back', page.ok && page.posts.length === 1, page);
    t.equal('and its cursor is understood', page.nextCursor, 'next');

    m = createFeedSandbox({ respond: () => ({ ok: true, data: { posts: [post('z')] } }) });
    await m.fetchPage(null);
    t.equal('without a template the known endpoint is used',
      m.log.requests[0].url, 'https://grok.com/rest/media/post/list');

    t.group('a failed request is never mistaken for an empty feed');
    m = createFeedSandbox({ respond: () => ({ ok: false, status: 401 }) });
    page = await m.fetchPage(null);
    t.ok('it reports failure', page.ok === false, page);
    t.equal('with the status', page.status, 401);

    // ── the probe ────────────────────────────────────────────────────────────────────────
    t.group('the probe picks a source that reaches beyond your likes');
    m = createFeedSandbox({
      responses: {
        MEDIA_POST_SOURCE_LIKED: [post('a'), post('b')],
        '(none)': [post('a'), post('b')],
        MEDIA_POST_SOURCE_ALL: [post('a'), post('b'), post('c'), post('d')],
      },
    });
    t.equal('the broader source wins', await m.probeMediaSource(), 'MEDIA_POST_SOURCE_ALL');

    t.group('a newer createTime does not outrank actually having more posts');
    // This is the bug the old probe had: the feed is ordered by interaction time, so a
    // likes-only source can easily show the newest post and still be the narrowest.
    m = createFeedSandbox({
      responses: {
        MEDIA_POST_SOURCE_LIKED: [post('a', '2026-08-25T00:00:00Z')],
        '(none)': [post('a', '2026-08-25T00:00:00Z')],
        MEDIA_POST_SOURCE_ALL: [post('a', '2026-08-25T00:00:00Z'), post('x', '2020-01-01T00:00:00Z')],
      },
    });
    t.equal('the source with the extra post wins despite its older newest date',
      await m.probeMediaSource(), 'MEDIA_POST_SOURCE_ALL');

    t.group('when nothing beats likes, it says likes');
    m = createFeedSandbox({
      responses: {
        MEDIA_POST_SOURCE_LIKED: [post('a'), post('b')],
        '(none)': [post('a'), post('b')],
        MEDIA_POST_SOURCE_ALL: [post('a')],
      },
    });
    t.equal('a source echoing the liked ids does not win',
      await m.probeMediaSource(), 'MEDIA_POST_SOURCE_LIKED');

    t.group('and when every candidate is rejected');
    m = createFeedSandbox({ responses: { MEDIA_POST_SOURCE_LIKED: [post('a')] } });
    t.equal('it falls back to the one value known to exist',
      await m.probeMediaSource(), 'MEDIA_POST_SOURCE_LIKED');

    t.group('an account with no likes at all still gets a source');
    m = createFeedSandbox({
      responses: { MEDIA_POST_SOURCE_LIKED: [], '(none)': [post('a'), post('b')] },
    });
    t.equal('the widest candidate that returned anything', await m.probeMediaSource(), null);

    t.group('resolveMediaSource');
    m = createFeedSandbox({ storage: { grokSearchListRequest: JSON.stringify(TEMPLATE) } });
    t.equal('a captured template short-circuits the probe', await m.resolveMediaSource(), null);
    t.equal('and costs no requests', m.log.requests.length, 0);

    m = createFeedSandbox({
      storage: {
        grokSearchMediaSource: 'MEDIA_POST_SOURCE_ALL',
        grokSearchMediaSourceProbedAt: String(Date.now()),
      },
    });
    t.equal('a fresh cached source is reused', await m.resolveMediaSource(), 'MEDIA_POST_SOURCE_ALL');
    t.equal('with no probing', m.log.requests.length, 0);

    m = createFeedSandbox({
      storage: {
        grokSearchMediaSource: 'MEDIA_POST_SOURCE_ALL',
        grokSearchMediaSourceProbedAt: String(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
      responses: { MEDIA_POST_SOURCE_LIKED: [post('a')] },
    });
    await m.resolveMediaSource();
    t.ok('a stale one is re-probed', m.log.requests.length > 0, m.log.requests.length);
    t.ok('and the new answer is cached with a timestamp',
      m.store.grokSearchMediaSource === 'MEDIA_POST_SOURCE_LIKED'
        && Number(m.store.grokSearchMediaSourceProbedAt) > Date.now() - 60000,
      m.store);

    m = createFeedSandbox({
      storage: {
        grokSearchMediaSource: 'MEDIA_POST_SOURCE_ALL',
        grokSearchMediaSourceProbedAt: String(Date.now()),
      },
      responses: { MEDIA_POST_SOURCE_LIKED: [post('a')] },
    });
    await m.resolveMediaSource({ force: true });
    t.ok('Reindex forces a re-probe even when the cache is fresh',
      m.log.requests.length > 0, m.log.requests.length);
    t.equal('a "no filter" answer round-trips through storage as (none)',
      createFeedSandbox({ storage: { grokSearchMediaSource: '(none)', grokSearchMediaSourceProbedAt: String(Date.now()) } })
        .readListTemplate(), null);

    t.group('saying so when the index can only hold likes');
    m = createFeedSandbox({ responses: { MEDIA_POST_SOURCE_LIKED: [post('a')] } });
    await m.resolveMediaSource();
    m.warnIfLikesOnly();
    t.ok('the user is told, and told what to do about it',
      m.log.warnings.some(w => w.includes('capture-list.js')), m.log.warnings);
    t.ok('and the status bar says it too',
      m.log.statuses.some(s => String(s).startsWith('likes only')), m.log.statuses);

    m = createFeedSandbox({
      responses: {
        MEDIA_POST_SOURCE_LIKED: [post('a')],
        MEDIA_POST_SOURCE_ALL: [post('a'), post('b')],
      },
    });
    await m.resolveMediaSource();
    m.warnIfLikesOnly();
    t.equal('a working broad source produces no warning', m.log.warnings.length, 0);

    m = createFeedSandbox({ storage: { grokSearchListRequest: JSON.stringify(TEMPLATE) } });
    await m.resolveMediaSource();
    m.warnIfLikesOnly();
    t.equal('nor does a captured template', m.log.warnings.length, 0);
  },
};
