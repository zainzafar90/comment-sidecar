'use strict';

const { NEEDS_ATTENTION } = require('../core/anchors');

// Pure review-model logic. No `vscode`, no filesystem — only the merge/group
// helpers that turn check reports + live editor state into tree items.

const GROUP_ORDER = ['review', 'detached', 'ambiguous'];

const STATUS_LABELS = {
  review: 'Needs review',
  detached: 'Detached',
  ambiguous: 'Ambiguous',
};

const STATUS_ICONS = {
  review: 'warning',
  detached: 'unlink',
  ambiguous: 'question',
};

const CONTEXT_VALUES = {
  review: 'commentSidecar.reviewItem',
  detached: 'commentSidecar.detachedItem',
  ambiguous: 'commentSidecar.ambiguousItem',
};

const GROUP_CONTEXT_VALUE = 'commentSidecar.reviewGroup';

// checkReports: canonical entries [{ sourcePath, file, id, line, previousLine,
// status, reason, text }] (already enriched with sourcePath + text by the
// collector). liveEntries: [{ sourcePath, file, results }] from the Store cache,
// where each result is { note, line, status, reason }.
//
// Live editor state wins for open files; every other report passes through.
// Live entries with no matching check report are dropped (no committed sidecar
// to review). Entries whose status is not in NEEDS_ATTENTION are filtered out.
// Live editor state is authoritative for open files; disk reports cover closed
// files. A live entry is kept only when its sourcePath has a committed sidecar
// (sidecarFiles), so orphans and files outside the current root are dropped.
function mergeReviewEntries(checkReports, liveEntries, sidecarFiles) {
  const liveByPath = new Map();
  for (const entry of liveEntries) {
    liveByPath.set(entry.sourcePath, entry);
  }

  const entries = [];

  for (const [sourcePath, live] of liveByPath) {
    if (sidecarFiles && !sidecarFiles.has(sourcePath)) {
      continue;
    }
    for (const result of live.results) {
      if (!NEEDS_ATTENTION.includes(result.status)) {
        continue;
      }
      entries.push({
        sourcePath,
        file: live.file,
        id: result.note.id,
        line: result.line,
        previousLine: result.note.line,
        status: result.status,
        reason: result.reason,
        text: result.note.text,
      });
    }
  }

  for (const report of checkReports) {
    if (!NEEDS_ATTENTION.includes(report.status)) {
      continue;
    }
    if (liveByPath.has(report.sourcePath)) {
      continue;
    }
    entries.push(report);
  }

  return entries;
}

// Always returns the three groups in GROUP_ORDER (even when empty) so the tree
// has a stable shape. `empty` is true only when there are no items at all.
function groupReviewItems(items) {
  const groups = GROUP_ORDER.map(status => ({ status, entries: [] }));
  const byStatus = new Map(groups.map(group => [group.status, group]));

  for (const item of items) {
    const group = byStatus.get(item.status);
    if (group) {
      group.entries.push(item);
    }
  }

  for (const group of groups) {
    group.entries.sort((a, b) =>
      a.file.toLowerCase().localeCompare(b.file.toLowerCase())
      || (a.line ?? a.previousLine) - (b.line ?? b.previousLine)
      || a.id.localeCompare(b.id));
  }

  return { groups, empty: items.length === 0 };
}

// First line of a comment, truncated to 100 chars with an ellipsis. Empty text
// returns '' so callers can fall back to the note id.
function firstLine(text) {
  const line = (text || '').split('\n')[0];
  if (!line) {
    return '';
  }
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function describe(entry) {
  if (entry.status === 'review') {
    return `${entry.file}:${entry.line}`;
  }
  return `${entry.file} · was line ${entry.previousLine}`;
}

module.exports = {
  NEEDS_ATTENTION,
  GROUP_ORDER,
  STATUS_LABELS,
  STATUS_ICONS,
  CONTEXT_VALUES,
  GROUP_CONTEXT_VALUE,
  mergeReviewEntries,
  groupReviewItems,
  firstLine,
  describe,
};
