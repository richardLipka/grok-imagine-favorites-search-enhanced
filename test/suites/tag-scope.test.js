'use strict';

const { createTagSandbox, readSource, sliceBetween } = require('../harness');

/**
 * Grok's collections are per-asset. Tag a child and only that child is tagged, which is why a
 * set tagged once shows up under the tag by one image and not by the other eleven — and why the
 * iOS app, which appears to read a set as tagged if any member is, looks like it propagates.
 *
 * Both readings are defensible and only the user knows which they meant, so the scope is a
 * choice. These tests pin the three things that choice must not get wrong: the single scope must
 * stay exactly what it was, the set scope must reach the whole generation from any member of it,
 * and neither may spend a request on a row that already agrees.
 */
const SET = [
  { id: 'root', parentId: null, rootId: null },
  { id: 'kidA', parentId: 'root', rootId: 'root' },
  { id: 'kidB', parentId: 'root', rootId: 'root' },
  { id: 'grandkid', parentId: 'kidA', rootId: 'root' },
  { id: 'other', parentId: null, rootId: null },
];

const TAGS = [
  { id: 'L', name: 'Liked', isDefault: true },
  { id: 'g', name: 'garden' },
  { id: 'r', name: 'rain' },
];

function sandbox(membership = {}, posts = SET) {
  const s = createTagSandbox({
    posts,
    responses: {
      list: { ok: true, data: { collections: TAGS } },
      members: () => ({ ok: true, data: { items: [] } }),
    },
  });
  s.setTagList(TAGS.filter(x => !x.isDefault).map(x => ({ id: x.id, name: x.name })));
  s.setMembership(membership);
  return s;
}

module.exports = {
  name: 'tag scope — one image, or the whole generation',
  run: async t => {
    t.group('the default is the behaviour that existed before the choice did');
    let s = sandbox();
    t.equal('nothing stored means the single scope', s.getTagScope(), 'single');
    s.setTagScope('set');
    t.equal('the choice is stored', s.getTagScope(), 'set');
    s.setTagScope('nonsense');
    t.equal('and an unreadable value falls back, never to the wider scope', s.getTagScope(), 'single');

    t.group('a set is found from any member, not just its root');
    s = sandbox();
    t.equal('from the root', s.getGenerationSetIds(SET[0]).sort(),
      ['grandkid', 'kidA', 'kidB', 'root']);
    // This is the case the whole feature exists for: the user tags the variation they liked,
    // which is a child, and expects the set to follow.
    t.equal('from a child', s.getGenerationSetIds(SET[1]).sort(),
      ['grandkid', 'kidA', 'kidB', 'root']);
    t.equal('from a grandchild', s.getGenerationSetIds(SET[3]).sort(),
      ['grandkid', 'kidA', 'kidB', 'root']);
    t.equal('a post with no family is its own set', s.getGenerationSetIds(SET[4]), ['other']);
    t.equal('and an id with nothing behind it is no set at all', s.getGenerationSetIds(''), []);

    t.group('a child whose root is not indexed is still tagged itself');
    // Otherwise an orphaned row would be tagged entirely by proxy and never actually carry it.
    s = sandbox({}, [{ id: 'orphan', parentId: 'gone', rootId: 'gone' }]);
    t.ok('its own id is in the set', s.getGenerationSetIds({ id: 'orphan', rootId: 'gone' }).includes('orphan'));

    t.group('the set reads as tagged when any member is');
    s = sandbox({ kidB: ['g'] });
    t.equal('the row itself still answers for itself', [...s.tagIdsForAsset('root') || []], []);
    t.equal('but the set carries it', [...s.tagIdsForSet(SET[0])], ['g']);
    t.equal('read from the other side too', [...s.tagIdsForSet(SET[3])], ['g']);
    t.equal('and a set with none has none', [...s.tagIdsForSet({ id: 'other' })], []);

    t.group('the single scope touches exactly one row');
    s = sandbox();
    let res = await s.applyTagToPost(SET[1], 'g', true, { scope: 'single' });
    t.equal('one request', s.log.requests.filter(r => r.label === 'tag add').length, 1);
    t.equal('and it was for the row that was clicked',
      s.log.requests.find(r => r.label === 'tag add').body.assetIds, ['kidA']);
    t.equal('reported as one', res.applied, 1);
    t.equal('the siblings are untouched', s.tagIdsForAsset('root'), null);

    t.group('the set scope reaches every member');
    s = sandbox();
    res = await s.applyTagToPost(SET[1], 'g', true, { scope: 'set' });
    t.equal('four rows, four requests', res.applied, 4);
    t.equal('each one of the set',
      s.log.requests.filter(r => r.label === 'tag add')
        .map(r => r.body.assetIds[0]).sort(),
      ['grandkid', 'kidA', 'kidB', 'root']);
    t.equal('and the row outside the set is not among them',
      s.log.requests.some(r => r.body.assetIds && r.body.assetIds[0] === 'other'), false);

    t.group('rows that already agree are not asked');
    // A set of twenty where nineteen already carry the tag has to cost one request, not twenty:
    // this runs on a tag click, with the user watching.
    s = sandbox({ root: ['g'], kidA: ['g'], kidB: ['g'] });
    res = await s.applyTagToPost(SET[0], 'g', true, { scope: 'set' });
    t.equal('only the one that was missing it', res.applied, 1);
    t.equal('and it was the right one',
      s.log.requests.find(r => r.label === 'tag add').body.assetIds, ['grandkid']);

    t.group('nothing to do is a success, not a failure');
    s = sandbox({ root: ['g'], kidA: ['g'], kidB: ['g'], grandkid: ['g'] });
    res = await s.applyTagToPost(SET[0], 'g', true, { scope: 'set' });
    t.equal('no requests', s.log.requests.filter(r => r.label === 'tag add').length, 0);
    t.equal('reported ok', res.ok, true);
    t.equal('with nothing changed', res.changed, false);

    t.group('removal is the same walk in reverse');
    s = sandbox({ root: ['g'], grandkid: ['g'] });
    res = await s.applyTagToPost(SET[3], 'g', false, { scope: 'set' });
    t.equal('only the rows that had it', res.applied, 2);
    t.equal('and they were removals',
      s.log.requests.filter(r => r.label === 'tag remove').length, 2);

    t.group('a partial failure is reported as one');
    // "tagged" over a run that reached three rows of four is the kind of quiet half-success that
    // gets noticed a week later, when the tag filter is missing images.
    s = createTagSandbox({
      posts: SET,
      responses: {
        list: { ok: true, data: { collections: TAGS } },
        members: () => ({ ok: true, data: { items: [] } }),
        add: b => (b.assetIds[0] === 'kidB' ? { ok: false, status: 500 } : { ok: true, data: { addedCount: 1 } }),
      },
    });
    s.setTagList([{ id: 'g', name: 'garden' }]);
    s.setMembership({});
    res = await s.applyTagToPost(SET[0], 'g', true, { scope: 'set' });
    t.equal('three landed', res.applied, 3);
    t.equal('one did not', res.failed, 1);
    t.equal('so it is not ok', res.ok, false);
    t.equal('and something did change', res.changed, true);

    t.group('a tag click with nothing to click on');
    s = sandbox();
    t.equal('no post', (await s.applyTagToPost(null, 'g', true)).ok, false);
    t.equal('no tag', (await s.applyTagToPost(SET[0], '', true)).ok, false);
    t.equal('and neither sent a request', s.log.requests.length, 0);

    t.group('folders for the catalogue come from the set, whatever the scope');
    // The read side is deliberately always the set: a library tagged one image at a time still
    // files the way it reads on screen, so switching the scope on does not reshuffle a download.
    s = sandbox({ kidB: ['g'] });
    s.setTagScope('single');
    t.equal('a member of a tagged set files under that tag',
      s.tagFolderNamesForPost(SET[0]), ['garden']);
    t.equal('a set with two tags files under both',
      sandbox({ kidB: ['g'], root: ['r'] }).tagFolderNamesForPost(SET[3]), ['garden', 'rain']);
    t.equal('and an untagged one has somewhere to go',
      s.tagFolderNamesForPost({ id: 'other' }), ['_untagged']);
    t.equal('folder order follows the tag list, not membership order',
      sandbox({ root: ['r', 'g'] }).tagFolderNamesForPost(SET[0]), ['garden', 'rain']);

    t.group('what the user is told');
    const describe = sliceBetween(readSource(),
      '  function describeTagResult(res, member) {', '\n  function renderLightboxTagRow');
    t.ok('a partial run names both numbers', /res\.failed.*failed/s.test(describe), describe);
    t.ok('a set-wide run says how many it reached',
      /TAG_SCOPE_SET && res\.size > 1/.test(describe), describe);
    t.ok('and nothing-to-do is not reported as success-with-a-count',
      /if \(!res\.applied\) return member \? 'already tagged'/.test(describe), describe);

    t.group('every hand assignment goes through the scope');
    const src = readSource();
    // setAssetTag is the single-row primitive; the two places a user assigns a tag by hand must
    // call applyTagToPost instead, or the choice silently applies to only one of them.
    const lightbox = sliceBetween(src, '  function ensureLightboxTagRow(lb) {', '\n  /**');
    t.ok('the lightbox add goes through it', /applyTagToPost\(post, tagId, true\)/.test(lightbox), lightbox);
    t.ok('and so does the chip removal', /applyTagToPost\(post, tagId, false\)/.test(lightbox), lightbox);
    t.ok('the manager’s apply-to-selection too',
      /applyTagToPost\(p, tagId, true\)/.test(src));
    t.ok('and the checkbox is offered in both places',
      /grok-lightbox-tag-scope-check/.test(src) && /grok-tag-scope-check/.test(src));
  },
};
