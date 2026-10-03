'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { changedLines, diffPath, DEFAULT_CONTEXT } = require('../src/core/diff');

test('collects only added lines with zero context', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    'index 111..222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-old',
    '+new',
    ' three',
  ].join('\n');

  const changed = changedLines(diff, 0);
  assert.deepEqual([...changed.get('a.ts')], [2]);
});

test('expands changed lines by a configurable context window', () => {
  const diff = [
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,5 +1,5 @@',
    ' one',
    '+two',
    ' three',
    ' four',
    ' five',
  ].join('\n');

  assert.deepEqual([...changedLines(diff, 0).get('a.ts')], [2]);
  assert.deepEqual([...changedLines(diff, 2).get('a.ts')], [1, 2, 3, 4]);
});

test('defaults the context window to the standard 3 lines', () => {
  const diff = [
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@',
    ' one',
    '+two',
  ].join('\n');

  assert.equal(DEFAULT_CONTEXT, 3);
  assert.deepEqual([...changedLines(diff).get('a.ts')], [...changedLines(diff, DEFAULT_CONTEXT).get('a.ts')]);
});

test('tracks the new line counter across hunks', () => {
  const diff = [
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -5,2 +6,2 @@',
    ' five',
    '+six',
    '@@ -10,1 +12,1 @@',
    ' twelve',
  ].join('\n');

  const changed = changedLines(diff, 0);
  assert.deepEqual([...changed.get('b.ts')], [7]);
});

test('treats a new file as all-added lines starting at one', () => {
  const diff = [
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,3 @@',
    '+a',
    '+b',
    '+c',
  ].join('\n');

  assert.deepEqual([...changedLines(diff, 0).get('new.ts')], [1, 2, 3]);
});

test('drops deleted files and removed lines', () => {
  const diff = [
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a',
    '-b',
    '--- a/keep.ts',
    '+++ b/keep.ts',
    '@@ -1,1 +1,1 @@',
    '+new',
  ].join('\n');

  const changed = changedLines(diff, 0);
  assert.equal(changed.has('gone.ts'), false);
  assert.deepEqual([...changed.get('keep.ts')], [1]);
});

test('handles renames under the new path', () => {
  const diff = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to new.ts',
    '--- a/old.ts',
    '+++ b/new.ts',
    '@@ -1,2 +1,2 @@',
    ' same',
    '+added',
  ].join('\n');

  const changed = changedLines(diff, 0);
  assert.equal(changed.has('old.ts'), false);
  assert.deepEqual([...changed.get('new.ts')], [2]);
});

test('ignores CRLF line endings and paths with spaces', () => {
  const diff = [
    '--- a/my file.ts',
    '+++ b/my file.ts\t2020-01-01 00:00:00',
    '@@ -1,1 +1,1 @@',
    '+changed',
  ].join('\r\n');

  const changed = changedLines(diff, 0);
  assert.deepEqual([...changed.get('my file.ts')], [1]);
});

test('strips a/ and b/ prefixes and quoted paths', () => {
  assert.equal(diffPath('b/src/app.ts'), 'src/app.ts');
  assert.equal(diffPath('a/src/app.ts'), 'src/app.ts');
  assert.equal(diffPath('b/my file.ts\t2020-01-01 00:00:00'), 'my file.ts');
  assert.equal(diffPath('b/src/app.ts'), 'src/app.ts');
  assert.equal(diffPath('/dev/null'), null);
});

test('returns an empty map for text with no hunks', () => {
  assert.equal(changedLines('no hunks here').size, 0);
});
