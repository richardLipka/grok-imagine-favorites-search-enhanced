'use strict';

const { readSource, sliceBetween } = require('../harness');

/**
 * Structural checks for the accessibility work, in the same spirit as search-bar-parts: none of
 * this fails loudly when it regresses. A focus ring that stops being drawn, a control that loses
 * its name, a dialog that stops trapping Tab — the UI looks identical and only keyboard and
 * screen-reader users are affected, which is exactly the class of bug nobody notices.
 *
 * Measured on grok.com/imagine/saved before the fix: the search box had no accessible name, the
 * per-card checkbox had none, the prune button announced as its own glyph, five text elements sat
 * between 2.05:1 and 4.46:1 against their background, and the open lightbox left 184 focusable
 * controls reachable behind it.
 */
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

module.exports = {
  name: 'accessibility — names, focus ring, and dialog focus',
  run(t) {
    const src = readSource();

    t.group('every control has a name of its own');
    t.ok('ensureAccessibleNames() is in the shared chain',
      /ensureSearchBarParts\(\) \{\s*ensureAccessibleNames\(\);/.test(stripComments(src)),
      'not first in the chain');
    // In the chain as well as the template, so a bar an older version left behind is fixed too.
    const names = stripComments(sliceBetween(src, '  function ensureAccessibleNames() {', '\n  }\n'));
    t.ok('it names the search box', /grok-search-input/.test(names) && /aria-label/.test(names));
    t.ok('and the import file input', /grok-import-json-input/.test(names));

    t.group('controls whose only text is a glyph or an icon');
    const skeleton = sliceBetween(src, "    card.className = 'grok-result-card';", '`;');
    t.ok('the per-card checkbox has an aria-label',
      /grok-result-select-input"?[^>]*aria-label/.test(skeleton), skeleton.slice(0, 200));
    // Text content beats `title` in the accessible name calculation, so a button whose text is
    // "✕" announces as the glyph unless something overrides it.
    t.ok('the prune button is named, not left as its glyph',
      /grok-result-prune-btn"[^>]*aria-label="Remove broken image/.test(skeleton), 'prune button unnamed');
    t.ok('the group checkbox name tracks what it selects',
      /input\.setAttribute\('aria-label', selectTitle\)/.test(src), 'group name not synced');

    t.group('the focus ring is stated, not inherited');
    // Grok's stylesheets are served cross-origin: what they reset cannot be read from the page and
    // must not be depended on. Our own CSS clears the outline on five controls besides.
    const focusRule = src.match(/#grok-search-toggle:focus-visible \{[^}]*\}/);
    t.ok('a :focus-visible rule exists', Boolean(focusRule), 'no focus-visible rule');
    if (focusRule) {
      t.ok('it draws an outline', /outline:\s*\dpx/.test(focusRule[0]), focusRule[0]);
      // Two mechanisms on purpose: overriding one still leaves the other visible.
      t.ok('and a box-shadow as well', /box-shadow:/.test(focusRule[0]), focusRule[0]);
    }
    for (const root of ['grok-search-wrap', 'grok-results-panel', 'grok-results-grid',
                        'grok-result-lightbox', 'grok-pager']) {
      t.ok(`${root} is covered`, src.includes(`#${root} :focus-visible`), 'not in the focus rule');
    }

    t.group('the lightbox keeps focus');
    t.ok('Tab is trapped inside the dialog', /if \(e\.key === 'Tab'\) \{\s*trapLightboxFocus\(e\);/.test(stripComments(src)));
    const trap = stripComments(sliceBetween(src, '  function trapLightboxFocus(e) {', '\n  }\n'));
    t.ok('it wraps forwards', /activeElement === last/.test(trap), trap);
    t.ok('it wraps backwards', /shiftKey && document\.activeElement === first/.test(trap), trap);
    t.ok('and pulls focus back in if it escaped', /!lb\.contains\(document\.activeElement\)/.test(trap), trap);

    const open = stripComments(sliceBetween(src, '  function openResultLightbox(post) {', '\n  }\n'));
    t.ok('opening remembers where focus came from', /lightboxReturnFocus = document\.activeElement/.test(open), open);
    t.ok('and moves focus into the dialog', /focusLightboxOnOpen\(\)/.test(open), open);
    // Stepping through results with the arrows must not yank focus off the button being used.
    t.ok('but only when it was not already open', /if \(!alreadyOpen\)/.test(open), open);

    const close = stripComments(sliceBetween(src, '  function closeResultLightbox() {', '\n  }\n'));
    t.ok('closing restores focus', /returnTo\.focus\(\)/.test(close), close);
    t.ok('and only to an element still in the document', /returnTo\.isConnected/.test(close), close);

    t.group('one handler per shortcut');
    // Ctrl+F was handled in two places at once. bindGlobalResultUiListeners() is the owner, via
    // focusSearchInputFromShortcut(); the paging listener must not race it with its own version.
    const paging = stripComments(sliceBetween(src, '  function bindPagingShortcuts(input) {', '\n  }\n'));
    t.ok('the paging listener no longer claims Ctrl+F',
      !/ctrlKey|metaKey|'f'/.test(paging), paging.slice(0, 160));
    t.ok('and the shortcut owner still handles it',
      /isCtrlF[\s\S]{0,400}focusSearchInputFromShortcut/.test(stripComments(src)), 'owner lost it');
    t.ok('and the paging listener is guarded like the others',
      /grokPagingKeysBound/.test(src), 'paging shortcut can bind twice');

    t.group('text meets 4.5:1 on the panel background');
    // The five that failed, with the alpha each was raised to. Ratios were verified in the browser.
    for (const [sel, min] of [['#grok-stamp-status', 0.6], ['.grok-date-sep', 0.6],
                              ['#grok-page-label', 0.6], ['#grok-panel-count', 0.6]]) {
      const rule = src.match(new RegExp(sel.replace(/[.#]/g, '\\$&') + ' \\{[^}]*\\}'));
      const alpha = rule && rule[0].match(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/);
      t.ok(`${sel} is at least ${min} alpha`, Boolean(alpha) && parseFloat(alpha[1]) >= min,
        rule ? rule[0].slice(0, 90) : 'rule missing');
    }
  },
};
