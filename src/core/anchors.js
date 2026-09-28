'use strict';
const { linesOf, sourceHash, hash } = require('./text');
const { noteAt } = require('./note');
const { contextHash } = require('./fingerprints');

function resolveNotes(source, notes) {
  if (!notes.length) {
    return [];
  }

  const lines = linesOf(source);
  const base = sourceHash(source);
  const lineHashes = new Map();
  let positionsByHash;

  function digestOf(text) {
    if (text === undefined) {
      return undefined;
    }

    let digest = lineHashes.get(text);
    if (!digest) {
      digest = hash(text);
      lineHashes.set(text, digest);
    }

    return digest;
  }

  function candidatesFor(target) {
    if (!positionsByHash) {
      positionsByHash = new Map();
      for (let i = 0; i < lines.length; i++) {
        const digest = digestOf(lines[i]);
        const positions = positionsByHash.get(digest);
        if (positions) {
          positions.push(i + 1);
        } else {
          positionsByHash.set(digest, [i + 1]);
        }
      }
    }

    return positionsByHash.get(target) || [];
  }

  return notes.map(note => {
    const anchor = note.anchor;
    if (!anchor) {
      throw new Error(`Comment ${note.id} has no anchor fingerprint.`);
    }

    const result = (line, status, reason) => ({ note, line, status, reason });

    if (note.state === 'detached') {
      return result(null, 'detached', 'Target was detached by an editor change; reattach explicitly.');
    }
    if (note.base === base && digestOf(lines[note.line - 1]) === anchor.target) {
      return result(note.line, note.state, 'Source matches the recorded revision.');
    }

    const candidates = candidatesFor(anchor.target);
    const exact = candidates.filter(line => {
      const start = line - 1 - anchor.before;
      if (start < 0 || line + anchor.after > lines.length) {
        return false;
      }

      return contextHash(lines.slice(start, line + anchor.after)) === anchor.context;
    });

    if (exact.length === 1) {
      let status;
      if (note.state === 'review') {
        status = 'review';
      } else if (exact[0] === note.line) {
        status = 'attached';
      } else {
        status = 'moved';
      }

      return result(exact[0], status, 'Target and recorded neighboring lines match uniquely; meaning is not verified.');
    }
    if (exact.length > 1 || candidates.length > 1) {
      return result(null, 'ambiguous', 'Multiple matching lines; choose the target explicitly.');
    }
    if (candidates.length === 1 && anchor.strong) {
      return result(candidates[0], 'review', 'Only the target text matches; neighboring context changed. Verify this provisional attachment.');
    }

    return result(null, 'detached', 'The original target cannot be located confidently.');
  });
}

function rebaseNotes(source, results) {
  const base = sourceHash(source);
  const lines = linesOf(source);
  return results.map(result => {
    if (result.line === null) {
      return result.note;
    }

    return noteAt(lines, result.line, result.note.text, {
      id: result.note.id, base, state: result.status === 'review' ? 'review' : 'attached',
    });
  });
}

function settleNotes(source, results) {
  const alone = resolveNotes(source, results.map(result => result.note));
  const keeps = results.map((result, i) => {
    if (result.line === null) {
      return true;
    }

    return alone[i].line === result.line && (alone[i].status === 'review') === (result.status === 'review');
  });

  const rewriting = keeps.includes(false);
  const rebased = rebaseNotes(source, results);
  return results.map((result, i) => {
    if (keeps[i] && !(rewriting && alone[i].status === 'moved')) {
      return result.note;
    }

    return rebased[i];
  });
}

const NEEDS_ATTENTION = ['review', 'ambiguous', 'detached'];

function indexResults(results) {
  const byLine = new Map();
  for (const result of results) {
    if (result.line === null) {
      continue;
    }

    const items = byLine.get(result.line);
    if (items) {
      items.push(result);
    } else {
      byLine.set(result.line, [result]);
    }
  }

  return byLine;
}

module.exports = { resolveNotes, rebaseNotes, settleNotes, indexResults, NEEDS_ATTENTION };
