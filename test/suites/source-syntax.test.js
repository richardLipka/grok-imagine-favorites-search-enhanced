'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Both scripts must at least *parse*.
 *
 * The rest of the suite slices regions out of the source and evaluates those, so a syntax error
 * anywhere else goes unnoticed until the file is pasted into Tampermonkey and the page is silently
 * dead. The specific way this happens here: `injectStyles()` holds ~900 lines of CSS in one
 * template literal, so a stray backtick in a CSS comment ends the string and turns the remainder
 * of the file into garbage. `new Function` parses without running, which is exactly what is wanted
 * — none of the browser globals these scripts need exist under Node.
 */
const ROOT = path.join(__dirname, '..', '..');

module.exports = {
  name: 'source syntax — both userscripts parse',
  run(t) {
    for (const file of ['grokSearch.user.js', 'grokPostSidebar.user.js']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      let error = null;
      try {
        new Function(source);   // eslint-disable-line no-new-func
      } catch (err) {
        error = err.message;
      }
      t.ok(`${file} parses`, error === null, error);
    }

    t.group('the stylesheet is a plain template literal');
    const source = fs.readFileSync(path.join(ROOT, 'grokSearch.user.js'), 'utf8');
    const start = source.indexOf("s.id = 'grok-search-styles';");
    t.ok('injectStyles() is still where the harness expects it', start > 0);
    const open = source.indexOf('s.textContent = `', start) + 's.textContent = `'.length;
    const css = source.slice(open, source.indexOf('`;', open));
    t.ok('it holds real CSS', css.length > 10000, css.length);
    // No interpolation is deliberate: every tunable value is applied as an inline style at
    // runtime instead, which is what lets the stylesheet be lifted out and rendered standalone.
    t.ok('with no interpolation', !css.includes('${'), css.match(/\$\{[^}]*\}/g));
  },
};
