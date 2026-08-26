'use strict';

const { readSource, sliceBetween } = require('../harness');

/**
 * A structural check rather than a behavioural one.
 *
 * The search bar is built two ways: from a template on a fresh page, or by upgrading a bar an
 * older script version left in the DOM. Controls that are not in the template exist only if an
 * `ensure*` function injects them — and for several releases the two paths ran *different* lists,
 * so **Import JSON** and **Verify** appeared only for users who happened to have an older bar to
 * migrate. A clean install had no way to run a reconciliation sweep at all, and nothing failed
 * loudly: the buttons were simply absent.
 *
 * The invariant is therefore not "this particular button exists" but **the two paths inject the
 * same set of controls**. That needs no list to maintain, and it catches the next one too.
 */
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\/[^\n'"`]*$/gm, '');

function readPaths() {
  const src = readSource();
  const chain = sliceBetween(src, '  function ensureSearchBarParts() {', '\n  }\n');
  const build = stripComments(sliceBetween(src, '  function buildSearchBar() {', '\n  function '));

  const split = build.indexOf('const wrap = document.createElement');
  if (split < 0) throw new Error('search-bar-parts: could not find the fresh-build branch');

  const callsIn = text => new Set((text.match(/ensure[A-Za-z0-9_]*\(\)/g) || []));
  const chainCalls = callsIn(stripComments(chain));

  /** Calls made on a path, with the shared chain inlined. */
  const expand = text => {
    const calls = callsIn(text);
    if (calls.has('ensureSearchBarParts()')) {
      calls.delete('ensureSearchBarParts()');
      for (const c of chainCalls) calls.add(c);
    }
    return calls;
  };

  return {
    chain,
    chainCalls,
    build,
    migration: expand(build.slice(0, split)),
    fresh: expand(build.slice(split)),
  };
}

module.exports = {
  name: 'search bar — both build paths inject the same controls',
  run(t) {
    const { chain, chainCalls, build, migration, fresh } = readPaths();

    t.group('the shared chain');
    t.ok('ensureSearchBarParts() is defined', chain.length > 0);
    t.ok('and does real work', chainCalls.size >= 10, [...chainCalls]);
    t.ok('it only wires controls up — no branch can skip one', !/\bif\s*\(/.test(chain), chain);
    t.equal('both build paths call it',
      (stripComments(build).match(/ensureSearchBarParts\(\)/g) || []).length, 2);

    t.group('the two paths agree');
    const onlyMigration = [...migration].filter(c => !fresh.has(c)).sort();
    const onlyFresh = [...fresh].filter(c => !migration.has(c)).sort();
    t.ok('nothing is injected only when upgrading an older bar', onlyMigration.length === 0, onlyMigration);
    t.ok('nothing is injected only on a fresh build', onlyFresh.length === 0, onlyFresh);

    t.group('the lightbox has the same shape of hazard');
    // ensureLightboxDownloadButton() returns early when its own button exists, and Download is in
    // the lightbox template -- so anything chained off it never ran. Like and Delete were invisible
    // for several releases because of exactly that.
    const src = readSource();
    const lightbox = stripComments(
      sliceBetween(src, '  function ensureLightboxButtons(', '\n  }'));
    for (const fn of ['ensureLightboxDownloadButton', 'ensureLightboxLikeButton',
                      'ensureLightboxDeleteButton']) {
      t.ok(`${fn} is called from ensureLightboxButtons`, lightbox.includes(`${fn}(lb)`), lightbox);
    }
    const dl = stripComments(sliceBetween(src,
      '  function ensureLightboxDownloadButton(', '\n  function '));
    t.ok('and the download builder no longer creates anything else',
      !/ensureLightboxLikeButton|ensureLightboxDeleteButton/.test(dl), dl);

    // ensureResultLightbox() also has two paths -- reuse an existing lightbox, or build one
    // from a template that carries Download alone. Both have to run the chain, exactly like
    // buildSearchBar(). This is the third place the same hazard turned up.
    const ensureLb = stripComments(sliceBetween(src,
      '  function ensureResultLightbox() {', '\n  function '));
    t.equal('both lightbox paths run the chain',
      (ensureLb.match(/ensureLightboxButtons\(/g) || []).length, 2);

    t.group('the running version is discoverable from the page');
    t.ok('init publishes it on <html>',
      /dataset\.grokSearchVersion = SCRIPT_VERSION/.test(readSource()), 'version marker missing');
    const header = readSource().match(/@version\s+(\S+)/)[1];
    const constant = readSource().match(/const SCRIPT_VERSION = '([^']+)'/)[1];
    t.equal('and it matches the @version header', constant, header);

    t.group('the controls this actually broke are in the chain');
    for (const [fn, label] of [
      ['ensureImportJsonButton', 'Import JSON'],
      ['ensureVerifyButton', 'Verify'],
      ['ensureReindexButton', 'Reindex'],
      ['ensureExportJsonButton', 'Export JSON'],
      ['ensureLikedFilterCheckbox', 'Liked only'],
      ['ensureModelFilterSelect', 'Model filter'],
      ['ensureDownloadSelectedButtons', 'Download selected / Cancel / Retry'],
      ['ensureMediaFilterCheckboxes', 'video / child filters'],
      ['ensureDisplayControls', 'per-page and size sliders'],
      ['ensureDateNavButtons', 'day stepper'],
    ]) {
      t.ok(`${label} is reached from both paths`, chainCalls.has(`${fn}()`), [...chainCalls]);
    }
  },
};
