'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GROUP_ORDER,
  STATUS_LABELS,
  mergeReviewEntries,
  groupReviewItems,
  firstLine,
  describe,
} = require('../src/extension/review-model');

function report(overrides = {}) {
  return {
    sourcePath: '/ws/src/app.tsx',
    file: 'src/app.tsx',
    id: 'sc_a',
    line: 4,
    previousLine: 4,
    status: 'review',
    reason: 'test reason',
    text: 'Wait for restoration.',
    ...overrides,
  };
}

function liveEntry(sourcePath, results) {
  return {
    sourcePath,
    file: sourcePath.replace('/ws/', ''),
    results,
  };
}

function liveResult(noteId, status, line, noteLine) {
  return {
    note: { id: noteId, line: noteLine, text: `note ${noteId}` },
    line,
    status,
    reason: `reason ${noteId}`,
  };
}

// --- A: groupReviewItems ---

test('A1: empty input yields the three groups in fixed order, empty flag set', () => {
  const { groups, empty } = groupReviewItems([]);
  assert.equal(empty, true);
  assert.deepEqual(groups.map(g => g.status), GROUP_ORDER);
  for (const group of groups) {
    assert.deepEqual(group.entries, []);
  }
});

test('A3/A4/A5: each status lands in its own group', () => {
  const { groups, empty } = groupReviewItems([
    report({ status: 'review', line: 4 }),
    report({ id: 'sc_b', status: 'detached', line: null, previousLine: 7 }),
    report({ id: 'sc_c', status: 'ambiguous', line: null, previousLine: 9 }),
  ]);
  assert.equal(empty, false);
  const byStatus = new Map(groups.map(g => [g.status, g.entries]));
  assert.equal(byStatus.get('review').length, 1);
  assert.equal(byStatus.get('detached').length, 1);
  assert.equal(byStatus.get('ambiguous').length, 1);
});

test('A6: mixed input groups correctly with counts', () => {
  const items = [
    report({ status: 'review', line: 1 }),
    report({ id: 'sc_b', status: 'review', line: 2 }),
    report({ id: 'sc_c', status: 'detached', line: null, previousLine: 3 }),
  ];
  const { groups } = groupReviewItems(items);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[1].entries.length, 1);
  assert.equal(groups[2].entries.length, 0);
});

test('A7: leaves sorted by file (ci), then line, then id', () => {
  const { groups } = groupReviewItems([
    report({ file: 'b.ts', line: 10, id: 'sc_1' }),
    report({ file: 'A.ts', line: 2, id: 'sc_2' }),
    report({ file: 'a.ts', line: 2, id: 'sc_1' }),
  ]);
  const order = groups[0].entries.map(e => `${e.file}:${e.line}:${e.id}`);
  assert.deepEqual(order, ['a.ts:2:sc_1', 'A.ts:2:sc_2', 'b.ts:10:sc_1']);
});

test('A8: review group never holds null lines; detached/ambiguous never hold real lines', () => {
  const { groups } = groupReviewItems([
    report({ status: 'review', line: 4 }),
    report({ id: 'sc_b', status: 'detached', line: null, previousLine: 7 }),
    report({ id: 'sc_c', status: 'ambiguous', line: null, previousLine: 9 }),
  ]);
  for (const item of groups[0].entries) {
    assert.notEqual(item.line, null);
  }
  for (const group of groups.slice(1)) {
    for (const item of group.entries) {
      assert.equal(item.line, null);
    }
  }
});

test('A9: previousLine is preserved verbatim on detached/ambiguous', () => {
  const { groups } = groupReviewItems([
    report({ id: 'sc_b', status: 'detached', line: null, previousLine: 23 }),
    report({ id: 'sc_c', status: 'ambiguous', line: null, previousLine: 41 }),
  ]);
  assert.equal(groups[1].entries[0].previousLine, 23);
  assert.equal(groups[2].entries[0].previousLine, 41);
});

// --- B: mergeReviewEntries ---

test('B1: live editor state overrides the check report for the same file', () => {
  const reports = [report({ id: 'sc_disk', line: 4, text: 'disk text' })];
  const live = [liveEntry('/ws/src/app.tsx', [
    liveResult('sc_live', 'review', 5, 5),
  ])];
  const entries = mergeReviewEntries(reports, live);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'sc_live');
  assert.equal(entries[0].line, 5);
  assert.equal(entries[0].text, 'note sc_live');
});

test('B2: reports for non-open files pass through unchanged', () => {
  const reports = [report({ file: 'src/other.ts', sourcePath: '/ws/src/other.ts', id: 'sc_x' })];
  const entries = mergeReviewEntries(reports, []);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], reports[0]);
});

test('B3: attached/moved/error reports are filtered out', () => {
  const reports = [
    report({ status: 'attached' }),
    report({ id: 'sc_b', status: 'moved' }),
    report({ id: 'sc_c', status: 'error', line: null, previousLine: 1, reason: 'bad' }),
    report({ id: 'sc_d', status: 'review', line: 2 }),
  ];
  const entries = mergeReviewEntries(reports, []);
  assert.deepEqual(entries.map(e => e.status), ['review']);
});

test('B4: live entry for a file with no committed sidecar is dropped', () => {
  const reports = [];
  const live = [liveEntry('/ws/src/ghost.ts', [liveResult('sc_g', 'review', 1, 1)])];
  const sidecarFiles = new Set(['/ws/src/app.tsx']);
  assert.deepEqual(mergeReviewEntries(reports, live, sidecarFiles), []);
});

test('B7: live attention on a file with a committed sidecar is kept', () => {
  const reports = [];
  const live = [liveEntry('/ws/src/app.tsx', [liveResult('sc_g', 'review', 1, 1)])];
  const sidecarFiles = new Set(['/ws/src/app.tsx']);
  const entries = mergeReviewEntries(reports, live, sidecarFiles);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'sc_g');
});

test('B5: detached/ambiguous keep line null and previousLine set', () => {
  const reports = [
    report({ id: 'sc_d', status: 'detached', line: null, previousLine: 7 }),
    report({ id: 'sc_e', status: 'ambiguous', line: null, previousLine: 9 }),
  ];
  const entries = mergeReviewEntries(reports, []);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.line, null);
    assert.ok(entry.previousLine > 0);
  }
});

test('B6: a file with one live attention note yields exactly one leaf (no double count)', () => {
  const reports = [report({ id: 'sc_disk', line: 4 })];
  const live = [liveEntry('/ws/src/app.tsx', [
    liveResult('sc_disk', 'review', 4, 4),
  ])];
  const entries = mergeReviewEntries(reports, live);
  assert.equal(entries.length, 1);
});

// --- firstLine / describe ---

test('firstLine truncates to 100 chars with an ellipsis and takes only line one', () => {
  assert.equal(firstLine('one line\nsecond line'), 'one line');
  assert.equal(firstLine('x'.repeat(120)), `${'x'.repeat(100)}…`);
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(undefined), '');
});

test('describe formats review as file:line and others as "was line N"', () => {
  assert.equal(describe(report({ file: 'a.ts', line: 4, status: 'review' })), 'a.ts:4');
  assert.equal(describe(report({ file: 'a.ts', line: null, previousLine: 7, status: 'detached' })), 'a.ts · was line 7');
});

test('labels and group order constants are stable', () => {
  assert.deepEqual(STATUS_LABELS, { review: 'Needs review', detached: 'Detached', ambiguous: 'Ambiguous' });
  assert.deepEqual(GROUP_ORDER, ['review', 'detached', 'ambiguous']);
});
