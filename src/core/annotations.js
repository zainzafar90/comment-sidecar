'use strict';

// Turns resolved comments into platform-neutral annotation records. The host
// maps these to its own API. Nothing here knows about a specific hosting
// platform; `level` is `info` or `warning`, never a platform name.

function levelFor(state) {
  return state === 'review' ? 'warning' : 'info';
}

// results: the output of resolveNotes, one item per comment. file: the
// repo-relative path of the source file, using forward slashes.
function annotationsFor(results, file) {
  return results
    .filter(item => item.line !== null)
    .map(item => ({
      path: file,
      line: item.line,
      message: `[${item.note.id};${item.status}] ${item.note.text}`,
      level: levelFor(item.status),
    }));
}

module.exports = { annotationsFor, levelFor };
