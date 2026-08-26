'use strict';

/**
 * Zero-dependency test runner:  node test/run.js  [name-filter]
 *
 * Suites live in ./suites/*.test.js and export { name, run(t) }. They exercise the real code
 * from grokSearch.user.js — see harness.js for how the userscript's IIFE is sliced apart.
 */

const fs = require('fs');
const path = require('path');
const { createAsserter } = require('./assert');

const SUITE_DIR = path.join(__dirname, 'suites');
const filter = process.argv[2] || '';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

async function main() {
  const files = fs.readdirSync(SUITE_DIR).filter(f => f.endsWith('.test.js')).sort();
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of files) {
    const suite = require(path.join(SUITE_DIR, file));
    if (filter && !suite.name.includes(filter) && !file.includes(filter)) continue;

    const t = createAsserter(suite.name);
    let crashed = null;
    try {
      await suite.run(t);
    } catch (err) {
      crashed = err;
    }

    console.log(`\n${BOLD}${suite.name}${OFF} ${DIM}(${file})${OFF}`);
    let group = null;
    for (const r of t.results) {
      if (r.group !== group) {
        group = r.group;
        if (group) console.log(`  ${DIM}${group}${OFF}`);
      }
      if (r.passed) {
        passed++;
        console.log(`    ${GREEN}ok${OFF}   ${r.name}`);
      } else {
        failed++;
        failures.push(`${suite.name} › ${r.name}`);
        console.log(`    ${RED}FAIL${OFF} ${r.name}`);
        if (r.detail !== undefined) {
          console.log(`         ${DIM}${JSON.stringify(r.detail)}${OFF}`);
        }
      }
    }

    if (crashed) {
      failed++;
      failures.push(`${suite.name} › threw ${crashed.message}`);
      console.log(`    ${RED}THREW${OFF} ${crashed.message}`);
      if (!/^harness:/.test(crashed.message)) console.log(crashed.stack);
      else console.log(`         ${DIM}grokSearch.user.js moved — update the markers in test/harness.js${OFF}`);
    }
  }

  console.log(`\n${BOLD}${passed} passed, ${failed} failed${OFF}`);
  if (failures.length) {
    console.log(`${RED}${failures.map(f => '  - ' + f).join('\n')}${OFF}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
