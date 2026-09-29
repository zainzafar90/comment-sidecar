'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

// Minimal VS Code mock — just what review-tree.js needs at require time plus
// the surfaces its provider touches. The heavier mock in extension.test.js is
// extended separately when wiring lands (WP3).
class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = callback => {
      this.listeners.add(callback);
      return { dispose: () => this.listeners.delete(callback) };
    };
  }
  fire() {
    return Promise.all([...this.listeners].map(callback => callback()));
  }
}

const vscode = {
  EventEmitter,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor() {
      this.parts = [];
      this.isTrusted = undefined;
      this.supportHtml = undefined;
    }
    appendMarkdown(value) {
      this.parts.push({ type: 'markdown', value });
      return this;
    }
    appendText(value) {
      this.parts.push({ type: 'text', value });
      return this;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
      this.description = undefined;
      this.tooltip = undefined;
      this.iconPath = undefined;
      this.contextValue = undefined;
      this.command = undefined;
    }
  },
  window: { activeTextEditor: undefined },
  workspace: { workspaceFolders: undefined, getWorkspaceFolder: () => undefined },
};

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
};

const {
  collectReviewItems,
  ReviewTreeDataProvider,
} = require('../src/extension/review-tree');
const { createNote } = require('../src/core/note');
const { serialize } = require('../src/core/format');

Module._load = originalLoad;

function entry(overrides = {}) {
  return {
    sourcePath: '/ws/src/app.tsx',
    file: 'src/app.tsx',
    id: 'sc_a',
    line: 4,
    previousLine: 4,
    status: 'review',
    reason: 'test reason',
    text: 'Wait for restoration.',
    ...overrides,
  };
}

function provider() {
  return new ReviewTreeDataProvider({ liveEntries: () => [] }, () => {});
}

const SOURCE = 'const ready = false;\nif (!ready) wait();\nstart();\n';

async function makeWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-sidecar-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- C: provider ---

test('C1: root children are the three groups with correct labels and state', () => {
  const p = provider();
  p.entries = [
    entry({ status: 'review' }),
    entry({ id: 'sc_b', status: 'detached', line: null, previousLine: 7 }),
  ];
  const groups = p.getChildren(undefined);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(g => g.label), ['Needs review', 'Detached', 'Ambiguous']);
  assert.equal(groups[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.equal(groups[1].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.equal(groups[2].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  for (const group of groups) {
    assert.equal(group.contextValue, 'commentSidecar.reviewGroup');
  }
});

test('C2: group children are its leaves; leaf children are empty', () => {
  const p = provider();
  p.entries = [entry({ status: 'review' })];
  const groups = p.getChildren(undefined);
  const leaves = p.getChildren(groups[0]);
  assert.equal(leaves.length, 1);
  assert.deepEqual(p.getChildren(leaves[0]), []);
});

test('C3: leaf label is first line of text, truncated, with id fallback', () => {
  const p = provider();
  p.entries = [
    entry({ id: 'sc_long', text: `${'x'.repeat(120)}\nsecond` }),
    entry({ id: 'sc_empty', text: '' }),
  ];
  const leaves = p.getChildren(p.getChildren(undefined)[0]);
  const labels = leaves.map(leaf => leaf.label);
  assert.ok(labels.includes(`${'x'.repeat(100)}…`));
  assert.ok(labels.includes('sc_empty'));
});

test('C4: leaf description is file:line for review, "was line N" otherwise', () => {
  const p = provider();
  p.entries = [
    entry({ file: 'a.ts', line: 4, status: 'review' }),
    entry({ id: 'sc_b', file: 'a.ts', line: null, previousLine: 7, status: 'detached' }),
  ];
  // Simpler: build leaves for each group directly.
  const groups = p.getChildren(undefined);
  const reviewLeaves = p.getChildren(groups[0]);
  const detachedLeaves = p.getChildren(groups[1]);
  assert.equal(reviewLeaves[0].description, 'a.ts:4');
  assert.equal(detachedLeaves[0].description, 'a.ts · was line 7');
});

test('C5: leaf tooltip is untrusted MarkdownString containing the comment data', () => {
  const p = provider();
  p.entries = [entry({ id: 'sc_a', status: 'review', line: 4, text: 'secret <b>text</b>' })];
  const leaf = p.getChildren(p.getChildren(undefined)[0])[0];
  assert.equal(leaf.tooltip.isTrusted, false);
  assert.equal(leaf.tooltip.supportHtml, false);
  const textPart = leaf.tooltip.parts.find(part => part.type === 'text');
  assert.ok(textPart.value.includes('secret <b>text</b>'));
  assert.ok(textPart.value.includes('sc_a'));
  assert.ok(textPart.value.includes('review'));
});

test('C6: leaf command points to review.open with the canonical entry as argument', () => {
  const p = provider();
  const e = entry({ status: 'review' });
  p.entries = [e];
  const leaf = p.getChildren(p.getChildren(undefined)[0])[0];
  assert.equal(leaf.command.command, 'commentSidecar.review.open');
  assert.deepEqual(leaf.command.arguments, [e]);
});

test('C7: per-status icons', () => {
  const p = provider();
  p.entries = [
    entry({ status: 'review' }),
    entry({ id: 'sc_b', status: 'detached', line: null, previousLine: 7 }),
    entry({ id: 'sc_c', status: 'ambiguous', line: null, previousLine: 9 }),
  ];
  const groups = p.getChildren(undefined);
  assert.equal(p.getChildren(groups[0])[0].iconPath.id, 'warning');
  assert.equal(p.getChildren(groups[1])[0].iconPath.id, 'unlink');
  assert.equal(p.getChildren(groups[2])[0].iconPath.id, 'question');
});

test('C8: per-status contextValues', () => {
  const p = provider();
  p.entries = [
    entry({ status: 'review' }),
    entry({ id: 'sc_b', status: 'detached', line: null, previousLine: 7 }),
    entry({ id: 'sc_c', status: 'ambiguous', line: null, previousLine: 9 }),
  ];
  const groups = p.getChildren(undefined);
  assert.equal(p.getChildren(groups[0])[0].contextValue, 'commentSidecar.reviewItem');
  assert.equal(p.getChildren(groups[1])[0].contextValue, 'commentSidecar.detachedItem');
  assert.equal(p.getChildren(groups[2])[0].contextValue, 'commentSidecar.ambiguousItem');
});

test('C9: getParent/getTreeItem round-trip', () => {
  const p = provider();
  p.entries = [entry({ status: 'review' })];
  const group = p.getChildren(undefined)[0];
  assert.equal(p.getParent(group), undefined);
  const leaf = p.getChildren(group)[0];
  assert.equal(p.getParent(leaf), group);
  assert.equal(p.getTreeItem(leaf), leaf);
  assert.equal(p.getTreeItem(group), group);
});

// --- D: collector (real temp fs + real service) ---

test('D1: live editor state overrides the disk report', async t => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'app.ts'), SOURCE);
  const note = createNote(SOURCE, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));

  const sourcePath = await fs.realpath(path.join(root, 'app.ts'));
  const store = {
    liveEntries: () => [{
      sourcePath,
      file: 'app.ts',
      results: [{
        note: { id: note.id, line: 2, text: 'Wait before starting.' },
        line: 2,
        status: 'review',
        reason: 'live reason',
      }],
    }],
  };

  const entries = await collectReviewItems(root, store);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, note.id);
  assert.equal(entries[0].status, 'review');
});

test('D2: closed file review note yields sourcePath and full text', async t => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'app.ts'), SOURCE);
  const note = createNote(SOURCE, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));

  // Edit a neighbor (line 1) so the target still matches uniquely but the
  // recorded context no longer does → review.
  const changed = SOURCE.split('\n');
  changed[0] = 'const ready = true;';
  await fs.writeFile(path.join(root, 'app.ts'), changed.join('\n'));

  const entries = await collectReviewItems(root, { liveEntries: () => [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'review');
  assert.equal(entries[0].text, 'Wait before starting.');
  assert.ok(path.isAbsolute(entries[0].sourcePath));
});

test('D3: deleted line detaches the comment with previousLine set', async t => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'app.ts'), SOURCE);
  const note = createNote(SOURCE, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));

  await fs.writeFile(path.join(root, 'app.ts'), 'const ready = false;\nstart();\n');

  const entries = await collectReviewItems(root, { liveEntries: () => [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'detached');
  assert.equal(entries[0].line, null);
  assert.equal(entries[0].previousLine, 2);
});

test('D4: workspace with no sidecars yields no items', async t => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'app.ts'), SOURCE);
  const entries = await collectReviewItems(root, { liveEntries: () => [] });
  assert.deepEqual(entries, []);
});

test('D5: unreadable sidecar produces no item and does not throw', async t => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'app.ts'), SOURCE);
  await fs.writeFile(path.join(root, 'app.ts.comment'), '# comment-sidecar v1\n');
  const entries = await collectReviewItems(root, { liveEntries: () => [] });
  assert.deepEqual(entries, []);
});
