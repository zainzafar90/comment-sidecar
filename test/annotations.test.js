'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNote } = require('../src/core/note');
const { resolveNotes } = require('../src/core/anchors');
const { annotationsFor, levelFor } = require('../src/core/annotations');

const SOURCE = ['one', 'two', 'three', 'four'].join('\n');

function resolve(...notes) {
  return resolveNotes(SOURCE, notes);
}

test('emits neutral records with forward-slash paths and 1-based lines', () => {
  const note = createNote(SOURCE, 3, 'Three.');
  const out = annotationsFor(resolve(note), 'src/app.ts');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    path: 'src/app.ts',
    line: 3,
    message: `[${note.id};attached] Three.`,
    level: 'info',
  });
});

test('review status maps to warning, attached and moved map to info', () => {
  const note = createNote(SOURCE, 3, 'provisional');
  const results = [
    { note, line: 3, status: 'review' },
    { note, line: 1, status: 'attached' },
    { note, line: 2, status: 'moved' },
  ];

  const out = annotationsFor(results, 'app.ts');
  assert.deepEqual(out.map(item => item.level), ['warning', 'info', 'info']);
  assert.deepEqual(out.map(item => item.message), [
    `[${note.id};review] provisional`,
    `[${note.id};attached] provisional`,
    `[${note.id};moved] provisional`,
  ]);
});

test('skips comments with no resolved line', () => {
  const note = createNote(SOURCE, 3, 'Three.');
  const duplicated = resolveNotes(SOURCE + '\n' + SOURCE, [note]);
  assert.equal(duplicated[0].status, 'ambiguous');
  assert.equal(annotationsFor(duplicated, 'app.ts').length, 0);
});

test('keeps multiple comments on the same line', () => {
  const notes = [createNote(SOURCE, 2, 'A.'), createNote(SOURCE, 2, 'B.')];
  const out = annotationsFor(resolve(...notes), 'app.ts');
  assert.equal(out.length, 2);
  assert.ok(out.every(item => item.line === 2));
});

test('preserves multiline comment text in the message', () => {
  const note = createNote(SOURCE, 2, 'first\nsecond');
  const out = annotationsFor(resolve(note), 'app.ts');
  assert.equal(out[0].message, `[${note.id};attached] first\nsecond`);
});

test('levelFor only produces info or warning', () => {
  assert.equal(levelFor('review'), 'warning');
  assert.equal(levelFor('attached'), 'info');
  assert.equal(levelFor('moved'), 'info');
});
