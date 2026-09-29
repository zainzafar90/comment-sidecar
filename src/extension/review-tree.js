'use strict';

const vscode = require('vscode');
const service = require('../node/service');
const {
  NEEDS_ATTENTION,
  STATUS_LABELS,
  STATUS_ICONS,
  CONTEXT_VALUES,
  GROUP_CONTEXT_VALUE,
  mergeReviewEntries,
  groupReviewItems,
  firstLine,
  describe,
} = require('./review-model');
const { findSidecars } = require('../node/workspace');
const { sourceOf } = require('../core/sidecar');

// Build the canonical entry list from the disk (committed) state. Reports are
// grouped by file; each unique file is loaded once to add sourcePath + text.
// Unreadable sidecars are skipped (logged), never rendered, never written.
// NOTE: service.check() also walks the workspace (findSidecars) internally, so a
// full rescan walks twice. Acceptable: rescan is debounced and off the keystroke path.
async function loadCheckReports(root, log = () => {}) {
  const sidecarFiles = new Set((await findSidecars(root)).map(sourceOf));
  const report = await service.check(root);
  const byFile = new Map();
  for (const item of report.reports) {
    if (item.status === 'error') {
      log(new Error(`Unreadable sidecar for ${item.file}: ${item.reason}`));
      continue;
    }
    if (!NEEDS_ATTENTION.includes(item.status)) {
      continue;
    }
    if (!byFile.has(item.file)) {
      byFile.set(item.file, []);
    }
    byFile.get(item.file).push(item);
  }

  const entries = [];
  for (const [file, reports] of byFile) {
    let snapshot;
    try {
      snapshot = await service.load(root, file);
    } catch (error) {
      log(error);
      continue;
    }
    const textById = new Map(snapshot.notes.map(note => [note.id, note.text]));
    for (const item of reports) {
      const text = textById.get(item.id);
      if (text === undefined) {
        continue; // comment removed between check and load
      }
      entries.push({
        sourcePath: snapshot.sourcePath,
        file: item.file,
        id: item.id,
        line: item.line,
        previousLine: item.previousLine,
        status: item.status,
        reason: item.reason,
        text,
      });
    }
  }
  return { entries, sidecarFiles };
}

async function collectReviewItems(root, store, log = () => {}) {
  const { entries, sidecarFiles } = await loadCheckReports(root, log);
  return mergeReviewEntries(entries, store.liveEntries(), sidecarFiles);
}

// Untrusted comment text must go through appendText; only the fixed header and
// separator go through appendMarkdown. Line/previousLine are engine-provided
// numbers, never user text.
function leafTooltip(entry) {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;

  let header;
  if (entry.status === 'review') {
    header = `Comment on line ${entry.line}`;
  } else if (entry.status === 'detached') {
    header = `Detached comment (was line ${entry.previousLine})`;
  } else {
    header = `Ambiguous comment (was line ${entry.previousLine})`;
  }

  markdown.appendMarkdown(`**${header}**`);
  markdown.appendMarkdown('\n\n---\n');
  markdown.appendText(`${entry.text}\n\n${entry.file} · ${entry.id} · ${entry.status} · ${entry.reason}`);
  return markdown;
}

class ReviewGroup extends vscode.TreeItem {
  constructor(status, entries) {
    super(
      STATUS_LABELS[status],
      entries.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.status = status;
    this.entries = entries;
    this.description = String(entries.length);
    this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[status]);
    this.contextValue = GROUP_CONTEXT_VALUE;
    this.parent = undefined;
  }
}

class ReviewLeaf extends vscode.TreeItem {
  constructor(entry) {
    super(firstLine(entry.text) || entry.id, vscode.TreeItemCollapsibleState.None);
    this.entry = entry;
    this.description = describe(entry);
    this.tooltip = leafTooltip(entry);
    this.iconPath = new vscode.ThemeIcon(STATUS_ICONS[entry.status]);
    this.contextValue = CONTEXT_VALUES[entry.status];
    this.parent = undefined;
    this.command = {
      command: 'commentSidecar.review.open',
      title: 'Jump to Comment',
      arguments: [entry],
    };
  }
}

class ReviewTreeDataProvider {
  constructor(store, log) {
    this.store = store;
    this.log = log;
    this.reports = [];
    this.entries = [];
    this.sidecarFiles = new Set();
    this.events = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.events.event;
  }

  currentRoot() {
    const editor = vscode.window.activeTextEditor;
    const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
      || vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : undefined;
  }

  refresh() {
    this.entries = mergeReviewEntries(this.reports, this.store.liveEntries(), this.sidecarFiles);
    this.events.fire();
  }

  async rescan() {
    const root = this.currentRoot();
    if (!root) {
      this.reports = [];
      this.sidecarFiles = new Set();
    } else {
      try {
        const result = await loadCheckReports(root, this.log);
        this.reports = result.entries;
        this.sidecarFiles = result.sidecarFiles;
      } catch (error) {
        this.log(error);
        this.reports = [];
        this.sidecarFiles = new Set();
      }
    }
    this.refresh();
  }

  getChildren(element) {
    if (!element) {
      const { groups } = groupReviewItems(this.entries);
      return groups.map(group => new ReviewGroup(group.status, group.entries));
    }
    if (element instanceof ReviewGroup) {
      return element.entries.map(entry => {
        const leaf = new ReviewLeaf(entry);
        leaf.parent = element;
        return leaf;
      });
    }
    return [];
  }

  getTreeItem(element) {
    return element;
  }

  getParent(element) {
    return element.parent;
  }
}

module.exports = {
  loadCheckReports,
  collectReviewItems,
  leafTooltip,
  ReviewGroup,
  ReviewLeaf,
  ReviewTreeDataProvider,
};
