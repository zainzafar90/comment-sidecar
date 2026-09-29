'use strict';
const vscode = require('vscode');
const { load, saveTracked } = require('../node/service');
const { sourceHash } = require('../core/text');
const { resolveNotes, indexResults } = require('../core/anchors');
const { isSidecar } = require('../core/sidecar');
const { trackEdits } = require('../core/edits');
const { MAX_FILE_BYTES } = require('../node/workspace');
const { hasDirtyDocument } = require('./documents');

function setResults(entry, results) {
  entry.results = results;
  entry.byLine = indexResults(results);
}

// A comment detached by a cut stays ready to follow the paste, even if the file is saved in between.
function keepRemoved(previous, results) {
  const removed = new Map(previous.filter(result => result.removed).map(result => [result.note.id, result.removed]));
  return results.map(result => {
    if (result.line !== null || !removed.has(result.note.id)) {
      return result;
    }

    return { ...result, removed: removed.get(result.note.id) };
  });
}

class Store {
  constructor(onUpdate, onError) {
    this.cache = new Map();
    this.pending = new Map();
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.saving = new Set();
  }

  supports(document) {
    return document.uri.scheme === 'file'
      && !isSidecar(document.uri.fsPath)
      && !!vscode.workspace.getWorkspaceFolder(document.uri);
  }

  async get(document) {
    if (!this.supports(document)) {
      return null;
    }

    const key = document.uri.toString();
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    if (this.pending.has(key)) {
      return this.pending.get(key);
    }

    const promise = this.loadDocument(document).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async loadDocument(document) {
    const text = document.getText();
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      throw new Error('Comment Sidecar skips source files larger than 2 MiB.');
    }

    const root = vscode.workspace.getWorkspaceFolder(document.uri).uri.fsPath;
    const snapshot = await load(root, document.uri.fsPath);

    const current = document.getText();
    const entry = { snapshot, source: current, history: new Map(), version: document.version };
    const unchanged = current === snapshot.source;
    setResults(entry, unchanged ? snapshot.results : resolveNotes(current, snapshot.notes));
    if (entry.results.length) {
      entry.history.set(unchanged ? snapshot.sourceHash : sourceHash(current), entry.results);
    }

    this.cache.set(document.uri.toString(), entry);
    this.onUpdate(document.uri);
    return entry;
  }

  changed(event) {
    const document = event.document;
    const key = document.uri.toString();
    const entry = this.cache.get(key);
    if (!entry || !event.contentChanges.length) {
      return;
    }

    const next = document.getText();
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) {
      this.cache.delete(key);
      this.onUpdate(document.uri);
      return;
    }
    if (!entry.results.length) {
      entry.source = next;
      entry.version = document.version;
      this.onUpdate(document.uri);
      return;
    }

    const nextHash = sourceHash(next);
    if (entry.history.has(nextHash)) {
      setResults(entry, entry.history.get(nextHash));
    } else {
      try {
        setResults(entry, trackEdits(entry.source, next, entry.results, event.contentChanges));
      } catch {
        setResults(entry, resolveNotes(next, entry.snapshot.notes));
      }
    }

    entry.source = next;
    entry.version = document.version;
    entry.history.set(nextHash, entry.results);
    while (entry.history.size > 16) {
      entry.history.delete(entry.history.keys().next().value);
    }

    this.onUpdate(document.uri);
  }

  async saved(document) {
    const key = document.uri.toString();
    const entry = this.cache.get(key);
    if (!entry || !entry.snapshot.notes.length || !vscode.workspace.isTrusted || this.saving.has(key)) {
      return;
    }

    this.saving.add(key);
    try {
      if (await hasDirtyDocument([entry.snapshot.sidecarPath])) {
        throw new Error('Sidecar has unsaved edits. Save it before syncing tracked comments.');
      }

      const source = entry.source;
      const version = entry.version;
      const tracked = entry.results;
      await saveTracked(entry.snapshot, source, tracked);

      const snapshot = await load(entry.snapshot.root, entry.snapshot.sourcePath);
      entry.snapshot = snapshot;
      if (entry.version === version) {
        const unchanged = source === snapshot.source;
        setResults(entry, keepRemoved(tracked, unchanged ? snapshot.results : resolveNotes(source, snapshot.notes)));
      }

      this.onUpdate(document.uri);
    } catch (error) {
      this.onError(error);
    } finally {
      this.saving.delete(key);
    }
  }

  invalidate(uri) {
    const key = uri.toString();
    if (this.saving.has(key)) {
      return;
    }

    this.cache.delete(key);
  }
  liveEntries() {
    const entries = [];
    for (const entry of this.cache.values()) {
      entries.push({
        sourcePath: entry.snapshot.sourcePath,
        file: entry.snapshot.file,
        results: entry.results,
      });
    }
    return entries;
  }

  close(document) {
    this.cache.delete(document.uri.toString());
  }
}

module.exports = { Store };
