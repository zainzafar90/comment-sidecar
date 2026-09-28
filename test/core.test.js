'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { serialize, parse } = require('../src/core/format');
const { createNote } = require('../src/core/note');
const { sourceHash } = require('../src/core/text');
const { resolveNotes, rebaseNotes, settleNotes } = require('../src/core/anchors');
const { render } = require('../src/core/render');
const { trackEdits, applyChanges } = require('../src/core/edits');

const SOURCE = ['function App() {', '  const ready = session.ready;', '  if (!ready) return null;', '  return render();', '}', ''].join('\n');
const note = () => createNote(SOURCE, 3, 'Wait for restoration, not merely a user value.');

test('round-trip preserves line, text, anchor, revision and ID', () => {
  const item = note();
  const raw = serialize('app.tsx', [item]);
  assert.match(raw, /\+\/\/ Wait for restoration/);
  assert.deepEqual(parse(raw), { name: 'app.tsx', notes: [item] });
});

test('multiline comments and diff-looking text remain data', () => {
  const item = createNote(SOURCE, 3, 'first\n@@ fake hunk\n+ source?\n```\n--- nope');
  assert.deepEqual(parse(serialize('app.tsx', [item])).notes, [item]);
});

test('supports CRLF source and CRLF sidecar without changing source', () => {
  const source = SOURCE.replaceAll('\n', '\r\n');
  const item = createNote(source, 3, 'αβ 日本語 🧪');
  assert.equal(sourceHash(source), sourceHash(SOURCE));
  const raw = serialize('app.tsx', [item]).replaceAll('\n', '\r\n');
  assert.deepEqual(parse(raw).notes, [item]);
  assert.equal(resolveNotes(source, [item])[0].line, 3);
});

test('empty source and final empty line are addressable', () => {
  const empty = createNote('', 1, 'Empty-file context.');
  assert.equal(resolveNotes('', [empty])[0].line, 1);
  const last = createNote(SOURCE, 6, 'End-of-file context.');
  assert.equal(parse(serialize('a.ts', [last])).notes[0].line, 6);
});

test('multiple independent notes may annotate the same source line', () => {
  const notes = [note(), createNote(SOURCE, 3, 'Another reason.')];
  assert.equal(parse(serialize('a.ts', notes)).notes.length, 2);
  const result = render(SOURCE, resolveNotes(SOURCE, notes), { start: 3, end: 3 });
  assert.equal((result.match(/^3 \|/gm) || []).length, 1);
  assert.equal((result.match(/^  @3/gm) || []).length, 2);
});

test('rejects source additions and deletions', () => {
  const raw = serialize('a.ts', [note()]);
  assert.throws(() => parse(raw.replace('+// Wait', '+const Wait')), /code additions/);
  assert.throws(() => parse(raw.replace('+// Wait', '-  if (!ready) return null;\n+// Wait')), /code additions/);
});

test('rejects malformed coordinates, duplicate IDs and invalid metadata', () => {
  const item = note();
  const raw = serialize('a.ts', [item]);
  assert.throws(() => parse(raw.replace('@@ 3 @@', '@@ 2 @@')), /anchor line/);
  assert.throws(() => parse(raw.replace('after=2', 'after=3')), /fingerprint/);
  assert.throws(() => serialize('a.ts', [item, item]), /duplicate/);
  assert.throws(() => parse(raw.replace('state=attached', 'state=whatever')), /header/);
  assert.throws(() => serialize('../a\nb.ts', [item]), /filename/);
  assert.throws(() => createNote(SOURCE, 0, 'x'), /Line/);
  assert.throws(() => createNote(SOURCE, 1, ' '), /Comment/);
});

test('rejects oversized sidecars and comments', () => {
  assert.throws(() => parse('x'.repeat(2097153)), /2 MiB/);
  assert.throws(() => createNote(SOURCE, 3, 'a'.repeat(16001)), /Comment/);
});

test('unchanged source attaches to original line', () => {
  const result = resolveNotes(SOURCE, [note()])[0];
  assert.equal(result.line, 3);
  assert.equal(result.status, 'attached');
});

test('external insertion above intact context relocates comment', () => {
  const result = resolveNotes(`import x from 'x';\n\n${SOURCE}`, [note()])[0];
  assert.equal(result.line, 5);
  assert.equal(result.status, 'moved');
});

test('external move of an intact unique context block relocates comment', () => {
  const extra = 'const outside = 1;\n';
  const original = SOURCE + extra;
  const item = createNote(original, 3, 'Wait.');
  const result = resolveNotes(extra + SOURCE, [item])[0];
  assert.equal(result.line, 4);
  assert.equal(result.status, 'moved');
});

test('unique target with changed neighbors is provisional, not certain', () => {
  const changed = SOURCE.replace('  const ready = session.ready;', '  const ready = readSession();');
  const result = resolveNotes(changed, [note()])[0];
  assert.equal(result.line, 3);
  assert.equal(result.status, 'review');
});

test('duplicate full context never chooses by proximity', () => {
  const result = resolveNotes(SOURCE + SOURCE, [note()])[0];
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.line, null);
});

test('duplicate target without matching context remains ambiguous', () => {
  const changed = 'a\n  if (!ready) return null;\nb\n  if (!ready) return null;\nc';
  assert.equal(resolveNotes(changed, [note()])[0].status, 'ambiguous');
});

test('rewritten or deleted external targets detach', () => {
  const changed = SOURCE.replace('  if (!ready) return null;', '  if (ready === false) return null;');
  assert.equal(resolveNotes(changed, [note()])[0].status, 'detached');
});

test('review status survives rebasing and reloading', () => {
  const changed = SOURCE.replace('session.ready', 'readiness');
  const results = resolveNotes(changed, [note()]);
  const rebased = rebaseNotes(changed, results);
  assert.equal(resolveNotes(changed, rebased)[0].status, 'review');
});

test('live insertion above a line moves it without introducing a review', () => {
  const changes = [{ rangeOffset: SOURCE.indexOf('  if'), rangeLength: 0, text: '  doSomething();\n' }];
  const changed = applyChanges(SOURCE, changes);
  const result = trackEdits(SOURCE, changed, resolveNotes(SOURCE, [note()]), changes)[0];
  assert.equal(result.line, 4);
  assert.equal(result.status, 'moved');
});

test('live prefix editing marks the same source line for review', () => {
  const changes = [{ rangeOffset: SOURCE.indexOf('  if'), rangeLength: 0, text: ' ' }];
  const result = trackEdits(SOURCE, applyChanges(SOURCE, changes), resolveNotes(SOURCE, [note()]), changes)[0];
  assert.equal(result.line, 3);
  assert.equal(result.status, 'review');
});

test('live replacement within annotated line stays provisional', () => {
  const changes = [{ rangeOffset: SOURCE.indexOf('!ready'), rangeLength: 6, text: 'loading' }];
  const result = trackEdits(SOURCE, applyChanges(SOURCE, changes), resolveNotes(SOURCE, [note()]), changes)[0];
  assert.equal(result.line, 3);
  assert.equal(result.status, 'review');
});

test('live deletion detaches persistently', () => {
  const start = SOURCE.indexOf('  if');
  const changes = [{ rangeOffset: start, rangeLength: SOURCE.indexOf('\n', start) - start + 1, text: '' }];
  const changed = applyChanges(SOURCE, changes);
  const result = trackEdits(SOURCE, changed, resolveNotes(SOURCE, [note()]), changes)[0];
  assert.equal(result.line, null);
  assert.equal(result.note.state, 'detached');
  const raw = serialize('a.ts', rebaseNotes(changed, [result]));
  assert.equal(resolveNotes(SOURCE, parse(raw).notes)[0].line, null);
});

test('splitting an annotated line detaches instead of choosing a fragment', () => {
  const changes = [{ rangeOffset: SOURCE.indexOf('return null'), rangeLength: 0, text: '\n' }];
  const result = trackEdits(SOURCE, applyChanges(SOURCE, changes), resolveNotes(SOURCE, [note()]), changes)[0];
  assert.equal(result.line, null);
});

test('multi-cursor edits use original offsets', () => {
  const changes = [
    { rangeOffset: 0, rangeLength: 0, text: '\n' },
    { rangeOffset: SOURCE.indexOf('  if'), rangeLength: 0, text: '\n\n' },
  ];
  const result = trackEdits(SOURCE, applyChanges(SOURCE, changes), resolveNotes(SOURCE, [note()]), changes)[0];
  assert.equal(result.line, 6);
});

test('UTF-16 offsets including emoji are handled', () => {
  const original = 'const emoji = "🧪";\n' + SOURCE;
  const item = createNote(original, 4, 'note');
  const changes = [{ rangeOffset: 0, rangeLength: 0, text: '/* 🧪 */\n' }];
  const result = trackEdits(original, applyChanges(original, changes), resolveNotes(original, [item]), changes)[0];
  assert.equal(result.line, 5);
});

test('rejects mismatched editor event snapshots', () => {
  assert.throws(() => trackEdits(SOURCE, 'unrelated', resolveNotes(SOURCE, [note()]), []), /match/);
});

function span(line) {
  const start = SOURCE.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
  return [start, start + SOURCE.split('\n')[line - 1].length];
}

function track(results, changes, source = SOURCE) {
  return trackEdits(source, applyChanges(source, changes), results, changes);
}

test('Move Line Down and Move Line Up keep the comments on both swapped lines', () => {
  const notes = [note(), createNote(SOURCE, 4, 'Render last.'), createNote(SOURCE, 2, 'Read once.')];
  const initial = resolveNotes(SOURCE, notes);
  const lines = SOURCE.split('\n');

  const down = track(initial, [
    { rangeOffset: span(3)[1], rangeLength: span(4)[1] - span(3)[1], text: '' },
    { rangeOffset: span(3)[0], rangeLength: 0, text: `${lines[3]}\n` },
  ]);
  assert.deepEqual(down.map(result => [result.line, result.status]), [[4, 'moved'], [3, 'moved'], [2, 'attached']]);

  const up = track(initial, [
    { rangeOffset: span(3)[1], rangeLength: 0, text: `\n${lines[1]}` },
    { rangeOffset: span(2)[0], rangeLength: span(3)[0] - span(2)[0], text: '' },
  ]);
  assert.deepEqual(up.map(result => [result.line, result.status]), [[2, 'moved'], [4, 'attached'], [3, 'moved']]);
});

test('Move Line Down on an empty line, sent as a deletion and an insertion at the same offset', () => {
  const source = 'first\n\nsecond\nthird\n';
  const changes = [
    { rangeOffset: 6, rangeLength: '\nsecond'.length, text: '' },
    { rangeOffset: 6, rangeLength: 0, text: 'second\n' },
  ];
  assert.equal(applyChanges(source, changes), 'first\nsecond\n\nthird\n');
  const result = track(resolveNotes(source, [createNote(source, 3, 'Second.')]), changes, source)[0];
  assert.deepEqual([result.line, result.status], [2, 'moved']);
});

test('a comment on a cut line comes back when the line is pasted in a later change', () => {
  const line = SOURCE.split('\n')[2];
  const cut = track(resolveNotes(SOURCE, [note()]), [{ rangeOffset: span(3)[0], rangeLength: line.length + 1, text: '' }]);
  assert.equal(cut[0].status, 'detached');

  const without = SOURCE.replace(`${line}\n`, '');
  const pasted = track(cut, [{ rangeOffset: 0, rangeLength: 0, text: `${line}\n` }], without);
  assert.deepEqual([pasted[0].line, pasted[0].status, pasted[0].note.state], [1, 'moved', 'attached']);
});

test('a whole line replaced in place, as VS Code does when the file changes on disk, asks for review', () => {
  const changes = [{ rangeOffset: span(3)[0], rangeLength: span(4)[0] - span(3)[0], text: '  if (!ready) return undefined;\n' }];
  const result = track(resolveNotes(SOURCE, [note()]), changes)[0];
  assert.deepEqual([result.line, result.status], [3, 'review']);
});

test('Copy Line Down keeps the comment on the upper line', () => {
  const changes = [{ rangeOffset: span(3)[0], rangeLength: 0, text: `${SOURCE.split('\n')[2]}\n` }];
  const result = track(resolveNotes(SOURCE, [note(), createNote(SOURCE, 4, 'Render last.')]), changes);
  assert.deepEqual(result.map(item => [item.line, item.status]), [[3, 'attached'], [5, 'moved']]);
});

test('saving keeps entries that still find their line and rewrites the rest', () => {
  const notes = [createNote(SOURCE, 2, 'Read once.'), createNote(SOURCE, 4, 'Render last.')];
  const initial = resolveNotes(SOURCE, notes);

  const inserted = [{ rangeOffset: 0, rangeLength: 0, text: '// header\n' }];
  const moved = applyChanges(SOURCE, inserted);
  const kept = settleNotes(moved, trackEdits(SOURCE, moved, initial, inserted));
  assert.deepEqual(kept, notes);
  assert.deepEqual(resolveNotes(moved, kept).map(result => [result.line, result.status]), [[3, 'moved'], [5, 'moved']]);

  const edited = [{ rangeOffset: moved.indexOf('render()'), rangeLength: 0, text: 'await ' }];
  const settled = settleNotes(applyChanges(moved, edited), trackEdits(moved, applyChanges(moved, edited), resolveNotes(moved, kept), edited));
  assert.deepEqual(settled.map(item => [item.line, item.state]), [[3, 'attached'], [5, 'review']]);
});

test('combined read preserves original numbers and emits no raw patch hashes per note', () => {
  const result = render(SOURCE, resolveNotes(SOURCE, [note()]), { start: 2, end: 4 });
  assert.match(result, /^2 \|/m);
  assert.match(result, /^3 \|/m);
  assert.match(result, /^4 \|/m);
  assert.match(result, /@3 \[sc_/);
  assert.doesNotMatch(result, /@@ -|base=|\+\/\//);
});

test('comments-only read avoids repeating code', () => {
  const result = render(SOURCE, resolveNotes(SOURCE, [note()]), { start: 3, end: 3, mode: 'comments' });
  assert.doesNotMatch(result, /if \(!ready\)/);
  assert.match(result, /Wait for restoration/);
});

test('range reads report outside-range notes and limit large requests', () => {
  assert.match(render(SOURCE, resolveNotes(SOURCE, [note()]), { start: 1, end: 1 }), /outside this range/);
  assert.throws(() => render(SOURCE, [], { start: 4, end: 2 }), /Read/);
});

test('unresolved notes are explicit, not attached to former line numbers', () => {
  const changed = SOURCE.replace('  if (!ready) return null;', '');
  const result = render(changed, resolveNotes(changed, [note()]));
  assert.match(result, /UNRESOLVED/);
  assert.doesNotMatch(result, /@3 \[/);
});

test('property check: random insertions above target preserve source-line identity', () => {
  for (let count = 1; count <= 100; count++) {
    const prefix = Array.from({ length: count }, (_, i) => `const prefix${i} = ${i};`).join('\n') + '\n';
    const result = resolveNotes(prefix + SOURCE, [note()])[0];
    assert.equal(result.line, count + 3);
    assert.equal(result.status, 'moved');
  }
});

test('comment budget explicitly flags omitted text and can be raised', () => {
  const results = resolveNotes(SOURCE, [note()]);
  const small = render(SOURCE, results, { commentBudget: 4 });
  assert.match(small, /TRUNCATED/);
  assert.doesNotMatch(small, /restoration/);
  assert.doesNotMatch(render(SOURCE, results, { commentBudget: 1000 }), /TRUNCATED/);
  assert.throws(() => render(SOURCE, results, { commentBudget: 64001 }), /commentBudget/);
});
