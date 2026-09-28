'use strict';
const { linesOf, lineOffsets, lineAtOffset } = require('./text');

const MAX_DIFF_CELLS = 1_000_000;

function applyChanges(source, changes) {
  let result = source;
  for (const edit of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset || b.rangeLength - a.rangeLength)) {
    result = result.slice(0, edit.rangeOffset) + edit.text + result.slice(edit.rangeOffset + edit.rangeLength);
  }

  return result;
}

function isValidEdit(edit, previousEnd, sourceLength) {
  return Number.isInteger(edit.rangeOffset)
    && Number.isInteger(edit.rangeLength)
    && edit.rangeOffset >= previousEnd
    && edit.rangeOffset >= 0
    && edit.rangeLength >= 0
    && edit.rangeOffset + edit.rangeLength <= sourceLength
    && typeof edit.text === 'string';
}

function spanOf(offsets, edit) {
  const start = edit.rangeOffset;
  const end = start + edit.rangeLength;
  const atLineStart = offset => offsets[lineAtOffset(offsets, offset) - 1] === offset;
  const first = lineAtOffset(offsets, start);
  const endLine = lineAtOffset(offsets, end);
  const keepsEndLine = atLineStart(end) && (edit.text.endsWith('\n') || (!edit.text && atLineStart(start)));
  return [first, keepsEndLine ? endLine - 1 : endLine];
}

function matchLines(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }

  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }

  const pairs = [];
  for (let i = 0; i < head; i++) {
    pairs.push([i, i]);
  }

  const rows = a.length - head - tail;
  const columns = b.length - head - tail;
  if (rows && columns && rows * columns <= MAX_DIFF_CELLS) {
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        if (a[head + i] === b[head + j]) {
          lengths[i * width + j] = lengths[(i + 1) * width + j + 1] + 1;
        } else {
          lengths[i * width + j] = Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (a[head + i] === b[head + j]) {
        pairs.push([head + i, head + j]);
        i++;
        j++;
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }

  for (let k = tail; k > 0; k--) {
    pairs.push([a.length - k, b.length - k]);
  }

  return pairs;
}

function diffRegion(oldSource, offsets, oldLines, region) {
  const start = offsets[region.first - 1];
  const hasLines = region.last >= region.first;
  let end = start;
  if (hasLines) {
    end = region.last < offsets.length ? offsets[region.last] : oldSource.length;
  }

  let text = '';
  let cursor = start;
  for (const edit of region.edits) {
    text += oldSource.slice(cursor, edit.rangeOffset) + edit.text;
    cursor = edit.rangeOffset + edit.rangeLength;
  }

  text += oldSource.slice(cursor, end);

  const before = hasLines ? oldLines.slice(region.first - 1, region.last) : [];
  const after = linesOf(text);
  if ((!hasLines || region.last < offsets.length) && after.pop() !== '') {
    throw new Error('Editor changes do not end on a line break.');
  }

  const matched = new Map();
  const edited = new Map();
  const removed = [];
  const inserted = [];
  let i = 0;
  let j = 0;
  for (const [nextI, nextJ] of [...matchLines(before, after), [before.length, after.length]]) {
    if (nextI - i === nextJ - j) {
      for (let k = 0; k < nextI - i; k++) {
        edited.set(i + k, j + k);
      }
    } else {
      for (let k = i; k < nextI; k++) {
        removed.push(k);
      }

      for (let k = j; k < nextJ; k++) {
        inserted.push(k);
      }
    }
    if (nextI < before.length) {
      matched.set(nextI, nextJ);
    }

    i = nextI + 1;
    j = nextJ + 1;
  }

  return { ...region, before, after, matched, edited, removed: new Set(removed), inserted };
}

function findMoves(regions) {
  const count = (map, text) => map.set(text, (map.get(text) || 0) + 1);
  const removedTexts = new Map();
  const insertedTexts = new Map();
  const insertedAt = new Map();
  for (const region of regions) {
    for (const index of region.removed) {
      count(removedTexts, region.before[index]);
    }

    for (const index of region.inserted) {
      count(insertedTexts, region.after[index]);
      insertedAt.set(region.after[index], region.newFirst + index);
    }
  }

  return text => (removedTexts.get(text) === 1 && insertedTexts.get(text) === 1 ? insertedAt.get(text) : null);
}

function findPaste(regions, removed) {
  const hits = [];
  for (const region of regions) {
    const runs = [];
    for (const index of region.inserted) {
      const run = runs[runs.length - 1];
      if (run && run.end === index) {
        run.end++;
      } else {
        runs.push({ start: index, end: index + 1 });
      }
    }

    for (const run of runs) {
      for (let at = run.start; at + removed.lines.length <= run.end; at++) {
        if (removed.lines.every((line, k) => region.after[at + k] === line)) {
          hits.push(region.newFirst + at + removed.index);
        }
      }
    }
  }

  if (hits.length === 1) {
    return hits[0];
  }

  const line = removed.lines[removed.index];
  const single = [];
  for (const region of regions) {
    for (const index of region.inserted) {
      if (region.after[index] === line) {
        single.push(region.newFirst + index);
      }
    }
  }

  return single.length === 1 ? single[0] : null;
}

function trackEdits(oldSource, newSource, results, changes) {
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset || a.rangeLength - b.rangeLength);
  let previousEnd = -1;
  for (const edit of sorted) {
    if (!isValidEdit(edit, previousEnd, oldSource.length)) {
      throw new Error('Invalid or overlapping editor changes.');
    }

    previousEnd = edit.rangeOffset + edit.rangeLength;
  }

  if (applyChanges(oldSource, changes) !== newSource) {
    throw new Error('Editor changes do not match the new document.');
  }

  const offsets = lineOffsets(oldSource);
  const oldLines = linesOf(oldSource);
  const spans = [];
  for (const edit of sorted) {
    if (!edit.rangeLength && !edit.text) {
      continue;
    }

    const [first, last] = spanOf(offsets, edit);
    const previous = spans[spans.length - 1];
    if (previous && first <= previous.last) {
      previous.last = Math.max(previous.last, last);
      previous.edits.push(edit);
    } else {
      spans.push({ first, last, edits: [edit] });
    }
  }

  const regions = spans.map(span => diffRegion(oldSource, offsets, oldLines, span));
  regions.forEach((region, index) => {
    const count = region.after.length;
    const next = regions[index + 1];
    const duplicates = region.last < region.first
      && count > 0
      && region.after.every((line, k) => oldLines[region.first - 1 + k] === line)
      && (!next || next.first >= region.first + count);
    if (duplicates) {
      region.first += count;
      region.last += count;
    }
  });

  let shift = 0;
  for (const region of regions) {
    region.newFirst = region.first + shift;
    shift += region.after.length - region.before.length;
  }

  const moveOf = findMoves(regions);

  return results.map(result => {
    if (result.line === null) {
      const line = result.removed ? findPaste(regions, result.removed) : null;
      if (line === null) {
        return result;
      }

      const note = result.removed.note;
      return {
        note,
        line,
        status: note.state === 'review' ? 'review' : 'moved',
        reason: 'The line was cut and pasted; meaning is not verified.',
      };
    }

    const region = regions.find(candidate => result.line >= candidate.first && result.line <= candidate.last);
    const moved = (line, reason) => {
      let status = result.status;
      if (status !== 'review' && line !== result.line) {
        status = 'moved';
      }

      return { ...result, line, status, reason };
    };

    if (!region) {
      let delta = 0;
      for (const candidate of regions) {
        if (candidate.last < result.line) {
          delta += candidate.after.length - candidate.before.length;
        }
      }

      return moved(result.line + delta, 'Position tracked through editor changes; meaning is not verified.');
    }

    const index = result.line - region.first;
    if (region.matched.has(index)) {
      return moved(region.newFirst + region.matched.get(index), 'Position tracked through editor changes; meaning is not verified.');
    }
    if (region.edited.has(index)) {
      return {
        ...result,
        line: region.newFirst + region.edited.get(index),
        status: 'review',
        reason: 'The annotated line was edited. Review the comment.',
      };
    }

    const destination = moveOf(region.before[index]);
    if (destination !== null) {
      return moved(destination, 'The line was moved; meaning is not verified.');
    }

    let from = index;
    while (region.removed.has(from - 1)) {
      from--;
    }

    let to = index;
    while (region.removed.has(to + 1)) {
      to++;
    }

    return {
      note: { ...result.note, state: 'detached' },
      line: null,
      status: 'detached',
      reason: 'An editor change deleted, split, joined, or replaced the target range. Reattach explicitly.',
      removed: { lines: region.before.slice(from, to + 1), index: index - from, note: result.note },
    };
  });
}

module.exports = { trackEdits, applyChanges };
