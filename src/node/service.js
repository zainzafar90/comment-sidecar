'use strict';
const path = require('node:path');
const { parse, serialize, FORMAT_VERSION } = require('../core/format');
const { createNote, normalizeComment } = require('../core/note');
const { sourceHash, hash, linesOf, assertLine } = require('../core/text');
const { resolveNotes, rebaseNotes, settleNotes, NEEDS_ATTENTION } = require('../core/anchors');
const { sourceOf } = require('../core/sidecar');
const { render } = require('../core/render');
const { annotationsFor } = require('../core/annotations');
const { changedLines } = require('../core/diff');
const { resolveSource, readText, withLock, atomicWrite, findSidecars } = require('./workspace');

async function load(root, file) {
  const paths = await resolveSource(root, file);
  const [source, raw] = await Promise.all([
    readText(paths.sourcePath),
    readText(paths.sidecarPath, true),
  ]);
  const notes = raw === null ? [] : parse(raw).notes;

  return {
    ...paths,
    source,
    raw,
    notes,
    sourceHash: sourceHash(source),
    sidecarHash: hash(raw ?? ''),
    results: resolveNotes(source, notes),
  };
}

async function read(root, file, options = {}) {
  const snapshot = await load(root, file);

  return {
    ...snapshot,
    output: render(snapshot.source, snapshot.results, {
      ...options,
      file: snapshot.file,
      sidecarHash: snapshot.sidecarHash,
    }),
  };
}

function requireSnapshot(snapshot, options) {
  if (options.expectedSource !== snapshot.sourceHash) {
    throw new Error('Source revision is missing or changed. Read the file and use its source hash.');
  }
  if (options.expectedSidecar !== snapshot.sidecarHash) {
    throw new Error('Sidecar revision is missing or changed. Read the file and use its sidecar hash.');
  }
}

async function write(root, file, options) {
  const paths = await resolveSource(root, file);

  return withLock(paths.sidecarPath, async () => {
    const snapshot = await load(root, file);
    requireSnapshot(snapshot, options);

    let notes = [...snapshot.notes];
    let id = options.id;
    const index = notes.findIndex(note => note.id === id);

    if (['update', 'remove', 'reanchor', 'review'].includes(options.operation) && index < 0) {
      throw new Error('Unknown comment ID.');
    }
    if (['add', 'reanchor'].includes(options.operation)) {
      const lines = linesOf(snapshot.source);
      assertLine(options.line, lines.length);
      if (typeof options.expectedText !== 'string' || lines[options.line - 1] !== options.expectedText) {
        throw new Error('Target text differs from expectedText. Read the line again.');
      }
    }

    switch (options.operation) {
      case 'add': {
        const note = createNote(snapshot.source, options.line, options.text);
        notes.push(note);
        id = note.id;
        break;
      }
      case 'update': {
        notes[index] = { ...notes[index], text: normalizeComment(options.text) };
        break;
      }
      case 'remove': {
        notes.splice(index, 1);
        break;
      }
      case 'reanchor': {
        notes[index] = createNote(snapshot.source, options.line, notes[index].text, { id });
        break;
      }
      case 'review': {
        const resolved = snapshot.results[index];
        if (resolved.line === null) {
          throw new Error('Unresolved comments must be reanchored explicitly.');
        }

        notes[index] = createNote(snapshot.source, resolved.line, notes[index].text, { id });
        break;
      }
      case 'sync': {
        notes = rebaseNotes(snapshot.source, snapshot.results);
        break;
      }
      default:
        throw new Error('Operation must be add, update, remove, reanchor, review, or sync.');
    }

    if (sourceHash(await readText(paths.sourcePath)) !== snapshot.sourceHash) {
      throw new Error('Source changed while writing. Retry.');
    }

    const raw = serialize(path.basename(paths.sourcePath), notes);
    await atomicWrite(paths.sidecarPath, raw, snapshot.sidecarHash);
    return {
      file: snapshot.file,
      id,
      count: notes.length,
      formatVersion: FORMAT_VERSION,
      source: snapshot.sourceHash,
      sidecar: hash(raw),
    };
  });
}

async function saveTracked(snapshot, source, results) {
  return withLock(snapshot.sidecarPath, async () => {
    if (sourceHash(await readText(snapshot.sourcePath)) !== sourceHash(source)) {
      throw new Error('Source changed before tracked comments could be saved.');
    }

    const raw = serialize(path.basename(snapshot.sourcePath), settleNotes(source, results));

    if (hash((await readText(snapshot.sidecarPath, true)) ?? '') !== snapshot.sidecarHash) {
      throw new Error('Sidecar changed concurrently. Read again before syncing.');
    }
    if (raw === snapshot.raw) {
      return;
    }

    await atomicWrite(snapshot.sidecarPath, raw, snapshot.sidecarHash);
  });
}

async function check(root, file) {
  const sources = file
    ? [(await resolveSource(root, file)).sourcePath]
    : (await findSidecars(root)).map(sourceOf);
  const reports = [];

  for (const target of sources) {
    const display = path.relative(root, target).split(path.sep).join('/');

    try {
      const snapshot = await load(root, target);
      for (const result of snapshot.results) {
        reports.push({
          file: snapshot.file,
          id: result.note.id,
          line: result.line,
          previousLine: result.note.line,
          status: result.status,
          reason: result.reason,
        });
      }
    } catch (error) {
      reports.push({ file: display, status: 'error', reason: error.message });
    }
  }

  const problems = reports.filter(report => report.status === 'error' || NEEDS_ATTENTION.includes(report.status));
  return {
    files: sources.length,
    comments: reports.filter(report => report.id).length,
    problems: problems.length,
    reports,
  };
}

// Provider-neutral annotations. When diffText is given, only comments on
// new-side lines present in the diff are kept, so a host can attach them to
// the lines a reviewer actually sees.
async function annotations(root, file, options = {}) {
  const sources = file
    ? [(await resolveSource(root, file)).sourcePath]
    : (await findSidecars(root)).map(sourceOf);
  const changed = options.diffText === undefined ? null : changedLines(options.diffText, options.context);
  const found = [];

  for (const target of sources) {
    try {
      const snapshot = await load(root, target);
      const items = annotationsFor(snapshot.results, snapshot.file);
      if (!changed) {
        found.push(...items);
        continue;
      }

      const wanted = changed.get(snapshot.file);
      if (!wanted) {
        continue;
      }
      for (const item of items) {
        if (wanted.has(item.line)) {
          found.push(item);
        }
      }
    } catch (error) {
      // A missing or unreadable source (for example a file deleted in the
      // diff) has nothing to annotate; skip it.
    }
  }

  return { comments: found.length, annotations: found };
}

module.exports = { load, read, write, check, annotations, saveTracked };
