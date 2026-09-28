'use strict';
const { randomUUID } = require('node:crypto');
const { linesOf, sourceHash, assertLine } = require('./text');
const { anchorAt } = require('./fingerprints');

const MAX_NOTES = 1000;
const MAX_COMMENT_CHARS = 16000;
const PERSISTED_STATES = ['attached', 'review', 'detached'];
const HASH = /^[a-f0-9]{64}$/;
const ID_PATTERN = '(?:sc|lc)_[a-zA-Z0-9_-]{1,64}';
const ID = new RegExp(`^${ID_PATTERN}$`);

function assertComment(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_COMMENT_CHARS || text.includes('\0')) {
    throw new Error(`Comment must contain 1–${MAX_COMMENT_CHARS} characters and no NUL bytes.`);
  }
}

function normalizeComment(text) {
  assertComment(text);
  return text.replace(/\r\n/g, '\n');
}

function assertAnchor(anchor) {
  if (
    !anchor
    || !HASH.test(anchor.target)
    || !HASH.test(anchor.context)
    || typeof anchor.strong !== 'boolean'
  ) {
    throw new Error('Invalid anchor fingerprint.');
  }
  if (![anchor.before, anchor.after].every(n => Number.isInteger(n) && n >= 0 && n <= 2)) {
    throw new Error('Invalid anchor context counts.');
  }
}

function assertNote(note) {
  assertComment(note.text);
  if (!ID.test(note.id)) {
    throw new Error('Invalid note ID.');
  }
  if (!HASH.test(note.base)) {
    throw new Error('Invalid base hash.');
  }
  if (!PERSISTED_STATES.includes(note.state)) {
    throw new Error('Invalid note state.');
  }

  assertAnchor(note.anchor);
  if (!Number.isSafeInteger(note.line) || note.line <= note.anchor.before) {
    throw new Error('Invalid anchor line.');
  }
}

function createNote(source, line, text, options = {}) {
  return noteAt(linesOf(source), line, text, { ...options, base: options.base || sourceHash(source) });
}

function noteAt(lines, line, text, options) {
  assertLine(line, lines.length);
  return {
    id: options.id || `sc_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    base: options.base,
    state: options.state || 'attached',
    line,
    text: normalizeComment(text),
    anchor: anchorAt(lines, line),
  };
}

module.exports = { createNote, noteAt, assertNote, assertComment, normalizeComment, MAX_NOTES, ID_PATTERN, PERSISTED_STATES };
