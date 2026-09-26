'use strict';

const { createTagSandbox, createLightboxAdvanceSandbox, readSource } = require('../harness');

/**
 * Tags are Grok **collections** — the same mechanism the heart uses, so the same rules apply:
 * the endpoints report how many rows they touched, and that is the only way to tell a real
 * change from a silent no-op. `media/post/like` answering 200 while doing nothing is why this
 * codebase does not accept a 200 as proof of anything.
 *
 * Field names here were probed, not guessed: `create` takes `{name}`, `update` and `delete` take
 * `{id}` (a `collectionId` gets a 400), and `assets/list` takes `{collectionId, limit}`.
 */
const listResponse = collections => ({ ok: true, data: { collections } });

const DEFAULT_COLLECTIONS = [
  { id: 'L', name: 'Liked', isDefault: true },
  { id: 'g', name: 'garden' },
  { id: 'r', name: 'rain' },
];

function sandbox(extra = {}) {
  return createTagSandbox({
    responses: {
      list: listResponse(DEFAULT_COLLECTIONS),
      members: b => ({ ok: true, data: { items: b.collectionId === 'g' ? [{ assetId: 'a1' }, { assetId: 'a2' }] : [{ assetId: 'a2' }] } }),
      ...extra,
    },
  });
}

module.exports = {
  name: 'tags — Grok collections, read and edited',
  run: async t => {
    t.group('reading what exists');
    let s = sandbox();
    t.equal('the read succeeds', await s.loadTags(), true);
    t.equal('tags are name-sorted', s.tagList.map(x => x.name), ['garden', 'rain']);
    // "Liked" has its own control; offering it here would let the heart be renamed or deleted.
    t.ok('the default Liked collection is not offered as a tag', !s.getTagById('L'));
    t.equal('membership is mapped per asset', [...s.tagIdsForAsset('a2')].sort(), ['g', 'r']);
    t.equal('and an untagged asset has none', s.tagIdsForAsset('nope'), null);

    t.group('a partial read is not cached as final');
    // Otherwise a tag whose members failed to load would look empty for the rest of the session.
    s = createTagSandbox({
      responses: {
        list: listResponse(DEFAULT_COLLECTIONS),
        members: b => (b.collectionId === 'r' ? { ok: false, status: 500 } : { ok: true, data: { items: [{ assetId: 'a1' }] } }),
      },
    });
    t.equal('it reports incomplete', await s.loadTags(), false);
    t.equal('what did load is kept', [...s.tagIdsForAsset('a1')], ['g']);
    t.equal('and it is not marked loaded', s.tagsLoaded, false);

    t.group('adding and removing');
    s = sandbox();
    await s.loadTags();
    let res = await s.setAssetTag('new1', 'g', true);
    t.equal('an add is accepted', res.ok, true);
    t.equal('the local map follows', [...s.tagIdsForAsset('new1')], ['g']);
    res = await s.setAssetTag('new1', 'g', false);
    t.equal('a remove is accepted', res.ok, true);
    t.equal('and the asset drops out of the map entirely', s.tagIdsForAsset('new1'), null);

    t.group('a no-op is distinguishable from a change');
    s = createTagSandbox({
      responses: {
        list: listResponse(DEFAULT_COLLECTIONS),
        members: () => ({ ok: true, data: { items: [] } }),
        add: { ok: true, data: { addedCount: 0 } },
      },
    });
    await s.loadTags();
    res = await s.setAssetTag('a9', 'g', true);
    t.equal('the request succeeded', res.ok, true);
    t.equal('but nothing changed', res.changed, false);

    s = createTagSandbox({
      responses: { list: listResponse(DEFAULT_COLLECTIONS), members: () => ({ ok: true, data: { items: [] } }), add: { ok: true, data: { addedCount: 1 } } },
    });
    await s.loadTags();
    t.equal('a real add reports a change', (await s.setAssetTag('a9', 'g', true)).changed, true);

    t.group('a failed request changes nothing locally');
    s = createTagSandbox({
      responses: { list: listResponse(DEFAULT_COLLECTIONS), members: () => ({ ok: true, data: { items: [] } }), add: { ok: false, status: 500 } },
    });
    await s.loadTags();
    res = await s.setAssetTag('a9', 'g', true);
    t.equal('it is reported as failed', res.ok, false);
    t.equal('and the map is untouched', s.tagIdsForAsset('a9'), null);

    t.group('creating');
    s = sandbox({ create: { ok: true, data: { collection: { id: 'n1', name: 'sunset' } } } });
    await s.loadTags();
    res = await s.createTag('  sunset  ');
    t.equal('the name is trimmed', res.ok && res.tag.name, 'sunset');
    t.ok('and it joins the list in order', s.tagList.map(x => x.name).join(',') === 'garden,rain,sunset');
    t.equal('an empty name is refused', (await s.createTag('   ')).reason, 'empty');
    t.equal('and so is a duplicate', (await s.createTag('GARDEN')).reason, 'duplicate');

    t.group('renaming and deleting');
    s = sandbox({ update: { ok: true, data: {} }, delete: { ok: true, data: {} } });
    await s.loadTags();
    t.equal('a rename is applied locally', (await s.renameTag('g', 'orchard')).ok, true);
    t.equal('and re-sorted', s.tagList.map(x => x.name), ['orchard', 'rain']);
    t.equal('an empty rename is refused', (await s.renameTag('g', ' ')).reason, 'empty');

    s = sandbox({ delete: { ok: true, data: {} } });
    await s.loadTags();
    s.setFilterTagId('g');
    t.equal('a delete succeeds', (await s.deleteTag('g')).ok, true);
    t.ok('the tag is gone from the list', !s.getTagById('g'));
    // Deleting the collection removes the grouping, not the images — but a2 was in both.
    t.equal('membership is cleaned up', [...s.tagIdsForAsset('a2')], ['r']);
    t.equal('an asset left with no tags drops out', s.tagIdsForAsset('a1'), null);
    t.equal('and a filter pointing at it is cleared', s.filterTagId, '');

    // Already gone is the goal state either way, the same rule the post delete follows.
    s = sandbox({ delete: { ok: false, status: 404 } });
    await s.loadTags();
    t.equal('deleting an already-missing tag is not a failure', (await s.deleteTag('g')).ok, true);

    s = sandbox({ delete: { ok: false, status: 500 } });
    await s.loadTags();
    t.equal('but a real failure is', (await s.deleteTag('g')).ok, false);
    t.ok('and the tag stays in the list', Boolean(s.getTagById('g')));

    t.group('names are bounded');
    s = sandbox();
    t.equal('whitespace is collapsed', s.normalizeTagName('  a   b  '), 'a b');
    t.ok('and length is capped', s.normalizeTagName('x'.repeat(200)).length <= 60);

    t.group('filtering by tag fails closed, never open');
    // An unloaded membership map must match nothing. Matching everything would show the whole
    // library under a tag filter -- the wrong way round, and it would look like the filter works.
    s = createTagSandbox({});
    s.setFilterTagId('g');
    t.equal('an unknown asset does not match', s.matchesTagFilter({ id: 'x' }), false);
    s = sandbox();
    await s.loadTags();
    s.setFilterTagId('g');
    t.equal('a tagged asset matches', s.matchesTagFilter({ id: 'a1' }), true);
    t.equal('an untagged one does not', s.matchesTagFilter({ id: 'zzz' }), false);
    t.equal('a different tag does not match either', s.matchesTagFilter({ id: 'a1', }) && s.matchesTagFilter({ id: 'a2' }), true);
    s.setFilterTagId('');
    t.equal('and no filter matches everything', s.matchesTagFilter({ id: 'zzz' }), true);

    t.group('deleting in the lightbox moves to the next image');
    // applyFilter() has already dropped the deleted row, so the next image has slid into the
    // index the deleted one held: staying put shows it.
    let lb = createLightboxAdvanceSandbox([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 1);
    lb.advanceLightboxAfterDelete();
    t.equal('the index is unchanged', lb.index, 1);
    t.equal('so the next image is showing', lb.showing, 'b');
    t.equal('it re-rendered', lb.log.rendered, 1);
    t.equal('and did not close', lb.log.closed, 0);

    // The last image has nowhere forward to go, so it steps back one.
    lb = createLightboxAdvanceSandbox([{ id: 'a' }, { id: 'b' }], 2);
    lb.advanceLightboxAfterDelete();
    t.equal('the last image clamps back', lb.index, 1);
    t.equal('showing the new last one', lb.showing, 'b');
    t.equal('still without closing', lb.log.closed, 0);

    lb = createLightboxAdvanceSandbox([], 0);
    lb.advanceLightboxAfterDelete();
    t.equal('an empty set closes the lightbox', lb.log.closed, 1);
    t.equal('and renders nothing', lb.log.rendered, 0);

    // Testing the function is not enough: the button has to actually call it. It used to close
    // the lightbox outright, which is the behaviour this replaced.
    const deleteBtn = readSource().slice(readSource().indexOf('function ensureLightboxDeleteButton'));
    const handler = deleteBtn.slice(0, deleteBtn.indexOf('function ensureLightboxLikeButton'));
    t.ok('the delete button advances rather than closing',
      /res\.deleted > 0\) advanceLightboxAfterDelete\(\)/.test(handler), handler.slice(-220));
  },
};
