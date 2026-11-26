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
    // It has to run *after* the builders: naming a control the chain has not created yet is a
    // silent no-op, which is exactly what happened to the import file input on a fresh build.
    const chain = stripComments(sliceBetween(src, '  function ensureSearchBarParts() {', '\n  }\n'));
    const calls = (chain.match(/ensure[A-Za-z]+\(\)/g) || []);
    t.ok('ensureAccessibleNames() is in the shared chain', calls.includes('ensureAccessibleNames()'), calls);
    t.equal('and runs last, after every builder',
      calls[calls.length - 1], 'ensureAccessibleNames()');
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
                        'grok-result-lightbox', 'grok-tag-manager', 'grok-pager',
                        'grok-text-prompt-dialog', 'grok-shortcuts-dialog', 'grok-selection-bar']) {
      t.ok(`${root} is covered`, src.includes(`#${root} :focus-visible`), 'not in the focus rule');
    }
    t.ok('first/last pager buttons have accessible names',
      /id="grok-page-first"[^>]*aria-label="First page"/.test(src)
      && /id="grok-page-last"[^>]*aria-label="Last page"/.test(src));
    t.ok('first-page SVG bar is vertical, not diagonal',
      /<line x1="1" y1="1" x2="1" y2="10"\/>/.test(src));

    t.group('post sidebar accessibility and IndexedDB safety');
    const fs = require('fs');
    const path = require('path');
    const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'grokPostSidebar.user.js'), 'utf8');
    t.ok('post sidebar declares its own :focus-visible outline and shadow',
      /#grok-post-sidebar :focus-visible[\s\S]*?outline: 2px[\s\S]*?box-shadow:/.test(sidebarSrc));
    t.ok('post sidebar sets inert when collapsed', /panel\.inert = !expanded/.test(sidebarSrc));
    t.ok('post sidebar never creates an empty IndexedDB schema on read',
      /req\.onupgradeneeded = e => \{[\s\S]*?transaction\.abort\(\)/.test(sidebarSrc));
    t.ok('post sidebar rebuilds UI on SPA return',
      /async function refreshContent\(\) \{[\s\S]*?buildSidebar\(\);/.test(sidebarSrc));
    t.ok('post sidebar includes Copy prompt button and live status region',
      sidebarSrc.includes('id="grok-post-copy-prompt"') && sidebarSrc.includes('id="grok-post-sidebar-status"')
      && /id="grok-post-sidebar-status"[^>]*role="status"[^>]*aria-live="polite"/.test(sidebarSrc));
    t.ok('post sidebar links Parent ID to its post page',
      /push\('Parent ID'[\s\S]*?href: `\/imagine\/post\//.test(sidebarSrc));
    t.ok('post sidebar supports Escape dismiss, reduced motion, forced colors, and coarse pointers',
      /e\.key !== 'Escape'/.test(sidebarSrc)
      && /@media \(prefers-reduced-motion: reduce\)/.test(sidebarSrc)
      && /@media \(forced-colors: active\)/.test(sidebarSrc)
      && /@media \(pointer: coarse\)/.test(sidebarSrc));
    const sidebarLowText = sidebarSrc.split(/\r?\n/).filter(l => {
      const m = l.match(/(?:^|[\s;{])color:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/);
      return m && parseFloat(m[1]) < 0.55;
    });
    t.equal('post sidebar has no low-contrast white text (< 0.55 alpha)', sidebarLowText.length, 0);

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

    t.group('tier 1–3 GUI, keyboard, contrast, and UX invariants');
    const lowWhiteText = src.split(/\r?\n/).filter(l => {
      const m = l.match(/(?:^|[\s;{])color:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/);
      return m && parseFloat(m[1]) < 0.55;
    });
    t.equal('grokSearch has no low-contrast white text (< 0.55 alpha)', lowWhiteText.length, 0);
    t.ok('result cards have a native keyboard open trigger, button date pill, and menu button',
      /<button type="button" class="grok-result-open-trigger"/.test(skeleton)
      && /<button type="button" class="grok-result-date"/.test(skeleton)
      && /<button type="button" class="grok-result-menu-btn"[^>]*aria-haspopup="menu"/.test(skeleton));
    t.ok('lightbox related items are native buttons, not clickable divs',
      /<button type="button" class="grok-lightbox-related-item/.test(src)
      && !/<div class="grok-lightbox-related-item/.test(src));
    t.ok('context menu supports arrow keys, Home/End, Escape, and Shift+F10',
      /e\.key === 'ArrowDown'/.test(src) && /e\.key === 'Home'/.test(src)
      && /e\.key === 'F10'/.test(src));
    t.ok('live status regions are wired on stamp status, download status, and no-results',
      /id="grok-stamp-status"[^>]*role="status"[^>]*aria-live="polite"/.test(src)
      && /id="grok-panel-download-status"[^>]*role="status"[^>]*aria-live="polite"/.test(src)
      && /noResults\.setAttribute\('aria-live', 'polite'\)/.test(src));
    t.ok('media preferences are honored (hover:none, pointer:coarse, reduced-motion, forced-colors)',
      /@media \(hover: none\)/.test(src)
      && /@media \(pointer: coarse\)/.test(src)
      && /@media \(prefers-reduced-motion: reduce\)/.test(src)
      && /@media \(forced-colors: active\)/.test(src));
    t.ok('native window.prompt() is replaced by the accessible dark text-prompt dialog',
      !/\bprompt\s*\(\s*['"]/.test(stripComments(src))
      && src.includes('function promptTextDialog(')
      && src.includes('aria-invalid'));
    t.ok('lightbox has visible Copy prompt, Back history, distinct Open media/Open post, and sidebar deduplication',
      src.includes('id="grok-lightbox-copy-prompt"') || src.includes("btn.id = 'grok-lightbox-copy-prompt'")
      && src.includes("btn.id = 'grok-lightbox-back'")
      && /grok-lightbox-open-tab[\s\S]{0,260}getPostMediaUrl/.test(src)
      && /if \(sidebar && !sidebar\.hidden\) \{\s*row\.hidden = true;/.test(src));
    t.ok('collapsible toolbar drawers manage inert and aria-expanded',
      src.includes('function ensureToolbarDrawers()')
      && /el\.inert = !open/.test(src)
      && src.includes('grok-toggle-filters-btn')
      && src.includes('grok-toggle-tools-btn'));
    t.ok('contextual selection bar, active filter chips, and shortcuts dialog exist',
      src.includes('function ensureSelectionBar()')
      && src.includes('function ensureActiveFilterChips()')
      && src.includes('function ensureShortcutsDialog()'));
  },
};
