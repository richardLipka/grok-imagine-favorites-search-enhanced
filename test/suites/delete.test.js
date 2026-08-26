'use strict';

const { createDeleteSandbox, createLikeSandbox, readSource } = require('../harness');

const post = id => ({ id, prompt: 'p' });

module.exports = {
  name: 'delete — consent, and never removing a row the server kept',
  async run(t) {
    t.group('nothing happens without consent');
    let m = createDeleteSandbox({ selected: [post('a'), post('b')], confirm: false });
    let res = await m.deleteSelectedPosts();
    t.equal('nothing deleted', res.deleted, 0);
    t.equal('no request was sent', m.log.requests.length, 0);
    t.equal('and nothing left the index', m.log.removed.length, 0);
    t.equal('but the user was asked', m.log.confirms.length, 1);

    t.group('the confirmation says exactly what will happen');
    m = createDeleteSandbox({ selected: [post('a'), post('b'), post('c')], confirm: false });
    await m.deleteSelectedPosts();
    const c = m.log.confirms[0];
    t.ok('the count is in the title', c.title.includes('3'), c.title);
    t.ok('the message says it is permanent', /permanent/i.test(c.message), c.message);
    t.ok('and that it cannot be undone', /cannot be undone/i.test(c.message), c.message);
    t.ok('the button names the count too', c.okLabel.includes('3'), c.okLabel);

    t.group('singular and plural read correctly');
    m = createDeleteSandbox({ selected: [post('a')], confirm: false });
    await m.deleteSelectedPosts();
    t.ok('one item', /1 item\b/.test(m.log.confirms[0].title), m.log.confirms[0].title);
    m = createDeleteSandbox({ selected: [post('a'), post('b')], confirm: false });
    await m.deleteSelectedPosts();
    t.ok('two items', /2 items/.test(m.log.confirms[0].title), m.log.confirms[0].title);

    t.group('an empty selection never even asks');
    m = createDeleteSandbox({ selected: [] });
    res = await m.deleteSelectedPosts();
    t.equal('nothing deleted', res.deleted, 0);
    t.equal('no dialog', m.log.confirms.length, 0);
    t.ok('and it says so', m.log.statuses.includes('nothing selected'), m.log.statuses);

    t.group('a confirmed delete goes through');
    m = createDeleteSandbox({ selected: [post('a'), post('b')] });
    res = await m.deleteSelectedPosts();
    t.equal('both deleted', res.deleted, 2);
    t.equal('one request each', m.log.requests.length, 2);
    t.equal('to the delete endpoint',
      m.log.requests[0].url, 'https://grok.com/rest/media/post/delete');
    t.equal('carrying the id', m.log.requests[0].id, 'a');
    t.equal('both rows leave the index', m.log.removed.join(','), 'a,b');
    t.ok('the write is flushed', m.log.flushes > 0, m.log.flushes);
    t.ok('and the view refreshed', m.log.filters > 0, m.log.filters);

    // The important one. A row that the server refused to delete still exists in the library,
    // so hiding it locally would be a lie about what the account contains.
    t.group('a row the server kept stays in the index');
    m = createDeleteSandbox({
      selected: [post('ok1'), post('nope'), post('ok2')],
      responses: { nope: { ok: false, status: 500 } },
    });
    res = await m.deleteSelectedPosts();
    t.equal('two succeeded', res.deleted, 2);
    t.equal('one failed', res.failed, 1);
    t.equal('only the successful ones are removed', m.log.removed.join(','), 'ok1,ok2');
    t.ok('the failure is reported', /failed 1/.test(m.log.statuses.at(-1)), m.log.statuses.at(-1));

    t.group('every failure means nothing is removed at all');
    m = createDeleteSandbox({
      selected: [post('x'), post('y')],
      responses: { x: { ok: false, status: 403 }, y: { ok: false, status: 500 } },
    });
    res = await m.deleteSelectedPosts();
    t.equal('nothing deleted', res.deleted, 0);
    t.equal('index untouched', m.log.removed.length, 0);
    t.equal('no flush was needed', m.log.flushes, 0);

    t.group('an item that was already gone counts as done');
    m = createDeleteSandbox({ selected: [post('gone')], responses: { gone: { ok: false, status: 404 } } });
    res = await m.deleteSelectedPosts();
    t.equal('treated as deleted', res.deleted, 1);
    t.equal('and removed from the index', m.log.removed.join(','), 'gone');
    t.equal('a 404 alone is success', await m.deleteRemotePost('gone'), true);

    t.group('other failures are not');
    m = createDeleteSandbox({ responses: { z: { ok: false, status: 500 } } });
    t.equal('a 500 is a failure', await m.deleteRemotePost('z'), false);
    m = createDeleteSandbox({ responses: { z: { ok: false, status: 403 } } });
    t.equal('so is a 403', await m.deleteRemotePost('z'), false);

    t.group('deleting a single item uses the same consent path');
    m = createDeleteSandbox({ confirm: false });
    res = await m.deleteSinglePost(post('one'));
    t.equal('declining stops it', res.deleted, 0);
    t.equal('and it still asked', m.log.confirms.length, 1);
    m = createDeleteSandbox({});
    res = await m.deleteSinglePost(post('one'));
    t.equal('confirming deletes it', res.deleted, 1);

    t.group('rows with no id are ignored rather than sent');
    m = createDeleteSandbox({ selected: [{ id: '' }, post('real'), { }] });
    res = await m.deleteSelectedPosts();
    t.equal('only the real one is requested', m.log.requests.length, 1);
    t.equal('and the count reflects that', m.log.confirms[0].title.includes('1 item'), true);

    // ── liking ───────────────────────────────────────────────────────────────────────────
    t.group('like and unlike hit their own endpoints');
    const src = readSource();
    t.ok('the delete endpoint is declared',
      src.includes("const POST_DELETE = 'https://grok.com/rest/media/post/delete';"));
    // Liking is collection membership. /rest/media/post/like answers 200 and does nothing, so
    // using it would look like it worked while changing nothing at all.
    t.ok('liking adds to a collection',
      src.includes("const COLLECTION_ADD = 'https://grok.com/rest/media/collection/assets/add';"));
    t.ok('unliking removes from it',
      src.includes("const COLLECTION_REMOVE = 'https://grok.com/rest/media/collection/assets/remove';"));
    t.ok('the dead post/like endpoint is not used',
      !src.includes("rest/media/post/like'") && !src.includes("rest/media/post/unlike'"),
      'the no-op like endpoint is still referenced');
    t.ok('liking no longer requires a captured template',
      /function hasLikeSupport\(\)\s*\{\s*return true;/.test(src.replace(/\n\s*/g, ' ')),
      'hasLikeSupport should be unconditional');
    t.ok('and the setup nag is gone',
      !src.includes('liking not set up'), 'stale capture-like.js message still present');

    t.group('a captured template still overrides the built-in endpoints');
    const like = createLikeSandbox();
    const tpl = { url: 'https://grok.com/custom/like', body: { postId: '' }, idPath: ['postId'] };
    t.equal('templating still works', like.buildLikeRequest(tpl, 'abc', true).body.postId, 'abc');
  },
};
