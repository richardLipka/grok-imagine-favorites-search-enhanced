'use strict';

const { createCompactSandbox, readSource, sliceBetween } = require('../harness');

const idsOf = entries => entries.map(e => e.post.id);
const kidsOf = entries => entries.map(e => e.children.map(c => c.id));

function createHelpers() {
  const src = readSource();
  const csvCode = sliceBetween(src, '  function csvEscape(val) {', '  function triggerBlobDownload(');
  const dateCode = sliceBetween(src, '  function getLocalDateKey(d = new Date()) {', '  function applyDatePreset(');

  const fn = new Function(`${csvCode}
${dateCode}
return { csvEscape, getLocalDateKey, getDatePresetBounds };`);
  return fn();
}

module.exports = {
  name: 'power features — keyboard, batch grouping, date presets, and subset exports',
  run(t) {
    const { csvEscape, getLocalDateKey, getDatePresetBounds } = createHelpers();

    t.group('batch generation grouping — collapses items with identical conversationId');
    const batchPosts = [
      { id: 'b1-item1', conversationId: 'conv-123', isChild: false },
      { id: 'b1-item2', conversationId: 'conv-123', isChild: false },
      { id: 'b1-item3', conversationId: 'conv-123', isChild: false },
      { id: 'lone-1', conversationId: 'conv-456', isChild: false },
      { id: 'no-conv', isChild: false },
    ];

    let s = createCompactSandbox({ posts: batchPosts, batch: false });
    let entries = s.getDisplayEntries();
    t.equal('batch off keeps all items separate', idsOf(entries), ['b1-item1', 'b1-item2', 'b1-item3', 'lone-1', 'no-conv']);
    t.equal('total count matches matchedPosts length', s.getDisplayCount(), 5);

    s.setBatch(true);
    entries = s.getDisplayEntries();
    t.equal('batch on groups items sharing conversationId into the first leader', idsOf(entries), ['b1-item1', 'lone-1', 'no-conv']);
    t.equal('batch leader carries siblings in children list', kidsOf(entries), [
      ['b1-item2', 'b1-item3'],
      [],
      [],
    ]);
    t.equal('display count reflects folded groups', s.getDisplayCount(), 3);
    t.equal('original matchedPosts is unchanged', s.matchedPosts.map(p => p.id), ['b1-item1', 'b1-item2', 'b1-item3', 'lone-1', 'no-conv']);

    s.setBatch(false);
    t.equal('toggling batch off restores individual cells', idsOf(s.getDisplayEntries()), ['b1-item1', 'b1-item2', 'b1-item3', 'lone-1', 'no-conv']);

    t.group('compound grouping — compact and batch together');
    const compoundPosts = [
      { id: 'rootA', conversationId: 'conv-xyz', isChild: false },
      { id: 'childA1', conversationId: 'conv-xyz', isChild: true, parentId: 'rootA', rootId: 'rootA' },
      { id: 'rootB', conversationId: 'conv-xyz', isChild: false },
    ];

    s = createCompactSandbox({ posts: compoundPosts, compact: true, batch: true });
    entries = s.getDisplayEntries();
    t.equal('compact folds childA1 into rootA, then batch folds rootB into rootA', idsOf(entries), ['rootA']);
    t.equal('folded entry contains all related and sibling posts without duplicates', kidsOf(entries), [['childA1', 'rootB']]);

    t.group('date presets — bounds calculations');
    const today = new Date();
    const todayStr = getLocalDateKey(today);
    const boundsToday = getDatePresetBounds('today');
    t.equal('today preset start is today', boundsToday.start, todayStr);
    t.equal('today preset end is today', boundsToday.end, todayStr);

    const boundsYesterday = getDatePresetBounds('yesterday');
    const yDate = new Date(today);
    yDate.setDate(yDate.getDate() - 1);
    const yStr = getLocalDateKey(yDate);
    t.equal('yesterday preset start is yesterday', boundsYesterday.start, yStr);
    t.equal('yesterday preset end is yesterday', boundsYesterday.end, yStr);

    const bounds7 = getDatePresetBounds('last7');
    const d7 = new Date(today);
    d7.setDate(d7.getDate() - 6);
    t.equal('last7 start is 6 days ago', bounds7.start, getLocalDateKey(d7));
    t.equal('last7 end is today', bounds7.end, todayStr);

    const boundsMonth = getDatePresetBounds('thisMonth');
    const mStart = new Date(today.getFullYear(), today.getMonth(), 1);
    t.equal('thisMonth start is the first day of current month', boundsMonth.start, getLocalDateKey(mStart));
    t.equal('thisMonth end is today', boundsMonth.end, todayStr);

    t.equal('unknown preset returns null', getDatePresetBounds('unknown'), null);

    t.group('csv escaping — RFC 4180 rules');
    t.equal('plain text requires no quotes', csvEscape('hello world'), 'hello world');
    t.equal('text with comma is wrapped in double quotes', csvEscape('apple, banana'), '"apple, banana"');
    t.equal('quotes are escaped by doubling them', csvEscape('a "great" idea'), '"a ""great"" idea"');
    t.equal('newlines are wrapped in quotes', csvEscape('line1\nline2'), '"line1\nline2"');
    t.equal('carriage returns are wrapped in quotes', csvEscape('line1\r\nline2'), '"line1\r\nline2"');
    t.equal('null is empty string', csvEscape(null), '');
    t.equal('undefined is empty string', csvEscape(undefined), '');
    t.equal('number is stringified', csvEscape(42), '42');
  },
};
