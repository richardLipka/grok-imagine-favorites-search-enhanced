'use strict';

/** Assertion collector. Suites call t.ok(...); the runner reads t.results. */
function createAsserter(suiteName) {
  const results = [];
  let group = '';

  return {
    suiteName,
    results,
    /** Optional heading to group the next assertions under. */
    group(name) {
      group = name;
    },
    ok(name, condition, detail) {
      results.push({
        group,
        name,
        passed: Boolean(condition),
        detail: condition ? undefined : detail,
      });
    },
    equal(name, actual, expected) {
      const passed = Object.is(actual, expected)
        || JSON.stringify(actual) === JSON.stringify(expected);
      results.push({
        group,
        name,
        passed,
        detail: passed ? undefined : { actual, expected },
      });
    },
  };
}

module.exports = { createAsserter };
