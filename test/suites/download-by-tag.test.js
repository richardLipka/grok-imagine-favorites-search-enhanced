'use strict';

const { createBulkDownloadSandbox, readSource, sliceBetween } = require('../harness');

/**
 * The second download option: the whole catalogue, filed into one folder per tag.
 *
 * The interesting constraint is that a set can carry two tags and there is no single right
 * folder for it, so the same image is written into both. That makes the file count exceed the
 * image count, which is correct and has to be said out loud rather than looking like a bug — and
 * it makes "fetch once, write many" the only acceptable shape, because a catalogue is tens of
 * thousands of images and refetching for a second copy would double the run for nothing.
 */
const POSTS = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i }));

module.exports = {
  name: 'download by tag — the catalogue filed into folders',
  run: async t => {
    t.group('without a grouping function nothing about the old path changes');
    let s = createBulkDownloadSandbox({});
    await s.downloadPostsToFolder(POSTS(3));
    t.equal('files are written into the chosen folder itself',
      s.log.writes, ['picked/p0.jpg', 'picked/p1.jpg', 'picked/p2.jpg']);
    t.equal('no subfolder is created', s.log.dirCalls.length, 0);
    t.equal('and the status reads as it always did',
      s.log.statuses[s.log.statuses.length - 1], 'saved 3 files');

    t.group('each image lands in the folder its tags name');
    s = createBulkDownloadSandbox({});
    await s.downloadPostsToFolder(POSTS(2), { folderNamesFor: p => [p.id === 'p0' ? 'garden' : 'rain'] });
    t.equal('one folder each', s.log.writes, ['garden/p0.jpg', 'rain/p1.jpg']);
    t.equal('created on demand', s.log.dirCalls.map(c => c.child), ['garden', 'rain']);
    t.ok('and created, not merely opened', s.log.dirCalls.every(c => c.create));

    t.group('a set with two tags is written into both');
    s = createBulkDownloadSandbox({});
    await s.downloadPostsToFolder([{ id: 'p0' }], { folderNamesFor: () => ['garden', 'rain'] });
    t.equal('twice', s.log.writes, ['garden/p0.jpg', 'rain/p0.jpg']);
    t.equal('from one fetch', s.log.saved.length, 2);
    t.ok('and the count distinguishes images from files',
      /saved 1 image as 2 files in 2 folders/.test(s.log.statuses[s.log.statuses.length - 1]),
      s.log.statuses[s.log.statuses.length - 1]);

    t.group('folder handles are not asked for again');
    // getDirectoryHandle is a filesystem round trip. 20,000 images across a dozen tags would
    // otherwise ask for the same dozen folders 20,000 times.
    s = createBulkDownloadSandbox({});
    await s.downloadPostsToFolder(POSTS(5), { folderNamesFor: () => ['garden'] });
    t.equal('five files', s.log.writes.length, 5);
    t.equal('one folder lookup', s.log.dirCalls.length, 1);

    t.group('an empty list of names is not an empty filename');
    // A grouping function that returns nothing must still save the file somewhere, not skip it.
    s = createBulkDownloadSandbox({});
    await s.downloadPostsToFolder([{ id: 'p0' }], { folderNamesFor: () => [] });
    t.equal('it goes to the root of the chosen folder', s.log.writes, ['picked/p0.jpg']);

    t.group('a confirm already given is not asked twice');
    // The catalogue run states its own plan -- how many folders, how many duplicate copies --
    // and the generic "you selected N images" prompt after it would be noise.
    s = createBulkDownloadSandbox({});
    await s.downloadPostsToFolder(POSTS(50), { folderNamesFor: () => ['g'], confirmed: true });
    t.equal('no second dialog', s.log.confirms, 0);
    s = createBulkDownloadSandbox({});
    await s.downloadPostsToFolder(POSTS(50));
    t.equal('but an unconfirmed run above the threshold still asks', s.log.confirms, 1);

    t.group('a folder name is not a tag name');
    s = createBulkDownloadSandbox({});
    t.equal('path separators cannot escape the chosen folder',
      s.sanitizeFolderName('cats/dogs'), 'cats-dogs');
    t.equal('nor can a parent reference', s.sanitizeFolderName('../etc'), 'etc');
    t.equal('Windows-reserved characters go',
      s.sanitizeFolderName('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h');
    // Windows strips a trailing dot or space silently, which would make two tags collide in a
    // way that only shows up as files landing in the wrong folder.
    t.equal('a trailing dot is dropped here rather than by the filesystem',
      s.sanitizeFolderName('holiday.'), 'holiday');
    t.equal('and a trailing space too', s.sanitizeFolderName('holiday '), 'holiday');
    t.equal('a name that sanitizes to nothing still has one',
      s.sanitizeFolderName('///'), 'untitled');
    t.equal('and so does an empty one', s.sanitizeFolderName(''), 'untitled');
    t.equal('a long name is cut, not rejected',
      s.sanitizeFolderName('x'.repeat(200)).length, 64);

    t.group('two tags that differ only in a forbidden character share a folder');
    // Documented, not fixed: "a/b" and "a:b" both become "a-b", so their images mix. Disambiguating
    // would mean folder names that no longer match the tags, which is the worse trade for a case
    // that needs two tags differing only in a character a filesystem will not accept.
    t.equal('both reduce to the same name',
      [s.sanitizeFolderName('a/b'), s.sanitizeFolderName('a:b')], ['a-b', 'a-b']);

    t.group('a failure in one folder does not take the whole run with it');
    s = createBulkDownloadSandbox({ saveFails: ['p1.jpg'] });
    await s.downloadPostsToFolder(POSTS(3), { folderNamesFor: () => ['garden'] });
    t.equal('the others are saved', s.log.writes, ['garden/p0.jpg', 'garden/p2.jpg']);
    t.equal('and the one that failed is retryable', s.failed.map(p => p.id), ['p1']);

    t.group('what the catalogue run reads before it starts');
    const run = sliceBetween(readSource(),
      '  async function downloadCatalogueByTag() {', '\n  async function downloadAllChildPosts');
    // Tags are the folder layout. A stale membership map files thousands of images under
    // `_untagged`, which looks exactly like the tags having been lost.
    t.ok('tags are re-read, not taken from cache', /loadTags\(\{ force: true \}\)/.test(run), run);
    t.ok('and an incomplete read downloads nothing at all',
      /if \(!complete\) \{[\s\S]*?return;/.test(run), run);
    t.ok('it takes the whole index, not the current filter', /allPosts\.filter/.test(run), run);
    t.ok('rows with no media are left out', /getPostDownloadFilename\(p\)/.test(run), run);
    t.ok('the plan is counted before the picker opens',
      run.indexOf('folders.add') < run.indexOf('confirmBulkDownload'), run);
    t.ok('and it files by set, not by row', /tagFolderNamesForPost/.test(run), run);

    t.group('the button exists and cannot start a second run');
    const src = readSource();
    t.ok('it is built like the other toolbar buttons',
      /function ensureDownloadByTagButton\(\) \{/.test(src));
    t.ok('and is in the chain that survives a bar rebuild',
      /ensureDownloadByTagButton\(\);/.test(sliceBetween(src,
        '  function ensureSearchBarParts() {', '\n  function buildSearchBar')));
    const sync = sliceBetween(src, '  function syncDownloadSelectedButtons() {', '\n  function ');
    t.ok('it is disabled while a download is running', /byTag\.disabled = busy/.test(sync), sync);
    t.ok('and disabled when there is nothing indexed', /indexed === 0/.test(sync), sync);
  },
};
