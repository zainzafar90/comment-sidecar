'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const service = require('../src/node/service');
const { sourceHash } = require('../src/core/text');
const { createNote } = require('../src/core/note');
const { serialize } = require('../src/core/format');

class Disposable {
  constructor(action = () => {}) {
    this.action = action;
  }

  dispose() {
    this.action();
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = callback => {
      this.listeners.add(callback);
      return new Disposable(() => this.listeners.delete(callback));
    };
  }

  fire(value) {
    return Promise.all([...this.listeners].map(callback => callback(value)));
  }

  dispose() {
    this.listeners.clear();
  }
}

class Uri {
  constructor(url) {
    this.url = new URL(url);
    this.scheme = this.url.protocol.slice(0, -1);
    this.fsPath = this.scheme === 'file' ? fileURLToPath(this.url) : decodeURIComponent(this.url.pathname);
    this.query = this.url.search.slice(1);
  }

  toString() {
    return this.url.href;
  }

  static file(file) {
    return new Uri(pathToFileURL(file));
  }

  static parse(value) {
    return new Uri(value);
  }

  static from({ scheme, path, query = '' }) {
    return new Uri(`${scheme}://${encodeURI(path)}${query ? `?${query}` : ''}`);
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === 'number' ? new Position(a, b) : a;
    this.end = typeof a === 'number' ? new Position(c, d) : b;
  }
}

class Selection extends Range {
  constructor(a, b) {
    super(a, b);
    this.active = b;
    this.isEmpty = a.line === b.line && a.character === b.character;
  }
}

class MarkdownString {
  constructor() {
    this.parts = [];
  }

  appendMarkdown(value) {
    this.parts.push({ type: 'markdown', value });
    return this;
  }

  appendText(value) {
    this.parts.push({ type: 'text', value });
    return this;
  }
}

const commands = new Map();
const hoverProviders = [];
const fileProviders = new Map();
const contentProviders = new Map();
const fileDecorationProviders = [];
const events = {};

function event(name) {
  const emitter = new EventEmitter();
  events[name] = emitter;
  return emitter.event;
}

const vscode = {
  Disposable,
  EventEmitter,
  Uri,
  Position,
  Range,
  Selection,
  MarkdownString,
  ThemeColor: class {
    constructor(id) {
      this.id = id;
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
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  Hover: class {
    constructor(contents, range) {
      this.contents = contents;
      this.range = range;
    }
  },
  FileDecoration: class {
    constructor(badge, tooltip, color) {
      Object.assign(this, { badge, tooltip, color });
    }
  },
  Diagnostic: class {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  },
  DecorationRangeBehavior: { ClosedClosed: 1 },
  DiagnosticSeverity: { Warning: 1 },
  FileType: { File: 1 },
  FileChangeType: { Changed: 1 },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: -2 },
  FileSystemError: {
    FileNotFound: () => new Error('File not found'),
    NoPermissions: message => new Error(message || 'No permissions'),
  },
  WorkspaceEdit: class {
    constructor() {
      this.renames = [];
    }

    renameFile(a, b, options) {
      this.renames.push({ a, b, options });
    }
  },
  commands: {
    registerCommand(name, fn) {
      commands.set(name, fn);
      return new Disposable(() => commands.delete(name));
    },
    executeCommand: async (name, ...args) => {
      vscode.executed = [...(vscode.executed || []), name];
      const handler = commands.get(name);
      if (handler) {
        return handler(...args);
      }
      return undefined;
    },
  },
  languages: {
    createDiagnosticCollection() {
      return {
        values: new Map(),
        set(uri, values) {
          this.values.set(uri.toString(), values);
        },
        delete(uri) {
          this.values.delete(uri.toString());
        },
        dispose() {},
      };
    },
    registerHoverProvider(selector, provider) {
      hoverProviders.push(provider);
      return new Disposable(() => hoverProviders.splice(hoverProviders.indexOf(provider), 1));
    },
  },
  workspace: {
    isTrusted: true,
    textDocuments: [],
    root: '',
    get workspaceFolders() {
      return [{ uri: Uri.file(this.root) }];
    },
    getWorkspaceFolder(uri) {
      return uri.scheme === 'file' && uri.fsPath.startsWith(`${this.root}${path.sep}`)
        ? { uri: Uri.file(this.root) }
        : undefined;
    },
    getConfiguration() {
      return {
        get: (key, fallback) =>
          Object.hasOwn(vscode.configuration, key) ? vscode.configuration[key] : fallback,
      };
    },
    registerFileSystemProvider(scheme, provider) {
      fileProviders.set(scheme, provider);
      return new Disposable();
    },
    registerTextDocumentContentProvider(scheme, provider) {
      contentProviders.set(scheme, provider);
      return new Disposable();
    },
    onDidChangeTextDocument: event('change'),
    onDidSaveTextDocument: event('save'),
    onDidCloseTextDocument: event('close'),
    onDidChangeConfiguration: event('config'),
    onWillRenameFiles: event('rename'),
    createFileSystemWatcher() {
      return {
        onDidChange: event('sidecarChange'),
        onDidCreate: event('sidecarCreate'),
        onDidDelete: event('sidecarDelete'),
        dispose() {},
      };
    },
    fs: {
      stat: async uri => fs.stat(uri.fsPath),
    },
    async openTextDocument(uri) {
      const known = this.textDocuments.find(doc => doc.uri.toString() === uri.toString());
      if (known) {
        return known;
      }

      let text;
      if (uri.scheme === 'file') {
        text = await fs.readFile(uri.fsPath, 'utf8');
      } else if (fileProviders.has(uri.scheme)) {
        text = (await fileProviders.get(uri.scheme).readFile(uri)).toString();
      } else {
        text = await contentProviders.get(uri.scheme).provideTextDocumentContent(uri);
      }

      const document = makeDocument(uri, text);
      this.textDocuments.push(document);
      return document;
    },
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel() {
      return {
        appendLine(value) {
          vscode.logs.push(value);
        },
        show() {},
        dispose() {},
      };
    },
    createTextEditorDecorationType(options) {
      const item = new Disposable();
      item.options = options;
      return item;
    },
    createStatusBarItem() {
      const item = {
        visible: false,
        hide() {
          this.visible = false;
        },
        show() {
          this.visible = true;
        },
        dispose() {},
      };
      vscode.status = item;
      return item;
    },
    createTreeView(viewId, options) {
      const view = {
        viewId,
        options,
        message: undefined,
        badge: undefined,
        reveal: () => {},
        dispose() {},
      };
      vscode.reviewViews = [...(vscode.reviewViews || []), view];
      return view;
    },
    onDidChangeActiveTextEditor: event('active'),
    onDidChangeVisibleTextEditors: event('visible'),
    registerFileDecorationProvider(provider) {
      fileDecorationProviders.push(provider);
      return new Disposable(() =>
        fileDecorationProviders.splice(fileDecorationProviders.indexOf(provider), 1),
      );
    },
    showInformationMessage: async (message, ...items) => {
      vscode.infoMessages = [...(vscode.infoMessages || []), { message, items }];
      return vscode.infoChoice === undefined ? undefined : items[vscode.infoChoice];
    },
    showErrorMessage: async message => {
      vscode.lastError = message;
    },
    showWarningMessage: async () => 'Delete comment',
    showQuickPick: async options => options[0],
    async showTextDocument(document) {
      const editor = makeEditor(document);
      this.activeTextEditor = editor;
      this.visibleTextEditors.push(editor);
      return editor;
    },
  },
  env: {
    clipboard: {
      writeText: async text => {
        vscode.clipboard = text;
      },
    },
  },
};

function makeDocument(uri, text) {
  return {
    uri,
    text,
    version: 1,
    isDirty: false,
    getText() {
      return this.text;
    },
    get lineCount() {
      return this.text.split('\n').length;
    },
    lineAt(line) {
      const text = this.text.split('\n')[line].replace(/\r$/, '');
      return { text, range: new Range(line, 0, line, text.length) };
    },
  };
}

function makeEditor(document) {
  return {
    document,
    decorations: [],
    decorationSets: new Map(),
    selection: new Selection(new Position(1, 0), new Position(1, 0)),
    setDecorations(type, options) {
      this.decorations = options;
      this.decorationSets.set(type, options);
    },
    revealRange(range) {
      this.revealedRange = range;
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

const originalLoad = Module._load;

Module._load = function (request, ...args) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
};

const { activate } = require('../src/extension/extension');

Module._load = originalLoad;

async function setup(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-sidecar-editor-'));
  let root = temporary;

  if (options.alias) {
    const real = path.join(temporary, 'workspace');
    await fs.mkdir(real);
    root = path.join(temporary, 'editor-alias');
    await fs.symlink(real, root, process.platform === 'win32' ? 'junction' : 'dir');
  }

  const text = 'const ready = false;\nif (!ready) wait();\nstart();\n';
  await fs.writeFile(path.join(root, 'app.ts'), text);

  vscode.configuration = {};
  vscode.logs = [];
  vscode.workspace.root = root;
  vscode.workspace.textDocuments = [];
  vscode.workspace.isTrusted = true;

  const document = await vscode.workspace.openTextDocument(Uri.file(path.join(root, 'app.ts')));
  const editor = makeEditor(document);
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];

  const context = { subscriptions: [], asAbsolutePath: file => path.join(__dirname, '..', file) };
  const api = activate(context);

  t.after(async () => {
    context.subscriptions.forEach(item => item.dispose());
    await fs.rm(temporary, { recursive: true, force: true });
  });

  return { root, document, editor, api, context };
}

test('extension registers commands, hover, multiline draft filesystem and preview provider', async t => {
  await setup(t);

  assert.equal(commands.size, 17);
  const manifest = require('../package.json').contributes.commands.map(item => item.command).sort();
  assert.deepEqual([...commands.keys()].sort(), manifest);
  assert.ok(hoverProviders.length > 0);
  assert.ok(fileProviders.has('comment-sidecar-draft'));
  assert.ok(contentProviders.has('comment-sidecar-preview'));
});

test('workspace commands work when no source file is active', async t => {
  const { root } = await setup(t);
  vscode.window.activeTextEditor = undefined;
  vscode.lastError = undefined;

  await commands.get('commentSidecar.check')();
  await commands.get('commentSidecar.copyMcp')();

  assert.equal(vscode.lastError, undefined);
  assert.ok(vscode.logs.some(line => line.includes('"problems": 0')));
  assert.deepEqual(JSON.parse(vscode.clipboard).mcpServers['comment-sidecar'].args.slice(1), ['--root', root]);
});

test('multiline draft saves real sidecar, without changing the source', async t => {
  const { root, document, api } = await setup(t);
  const snapshot = await service.load(root, 'app.ts');
  const uri = api.drafts.create(snapshot, 2);
  const original = await fs.readFile(path.join(root, 'app.ts'), 'utf8');

  await api.drafts.writeFile(uri, Buffer.from('First reason.\nSecond reason.'));

  assert.equal((await service.load(root, 'app.ts')).notes[0].text, 'First reason.\nSecond reason.');
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), original);
  const entry = await api.store.get(document);
  assert.equal(entry.results.length, 1);
});

test('hover returns comment as escaped text, never trusted HTML or commands', async t => {
  const { root, document, api } = await setup(t);
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  const text = '[run](command:evil) <script>bad()</script>';
  await api.drafts.writeFile(uri, Buffer.from(text));
  await api.store.get(document);
  const provider = hoverProviders[hoverProviders.length - 1];

  const hover = await provider.provideHover(document, new Position(1, 4), { isCancellationRequested: false });

  assert.ok(hover.contents.every(content => content.isTrusted === false && content.supportHtml === false));
  assert.ok(hover.contents[1].parts.some(part => part.type === 'text' && part.value === text));

  const noHover = await provider.provideHover(
    document,
    new Position(0, 0),
    { isCancellationRequested: false },
  );
  assert.equal(noHover, undefined);
});

test('store tracks an insertion above a comment, and saving leaves the .comment file and source alone', async t => {
  const { root, document, api } = await setup(t);
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  await api.drafts.writeFile(uri, Buffer.from('Wait.'));
  await api.store.get(document);
  const sidecar = await fs.readFile(path.join(root, 'app.ts.comment'), 'utf8');

  document.text = '\n' + document.text;
  document.version++;
  document.isDirty = true;
  api.store.changed({ document, contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: '\n' }] });

  assert.equal((await api.store.get(document)).results[0].line, 3);

  await fs.writeFile(path.join(root, 'app.ts'), document.text);
  document.isDirty = false;
  await api.store.saved(document);

  assert.equal(await fs.readFile(path.join(root, 'app.ts.comment'), 'utf8'), sidecar);
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), document.text);
  const snapshot = await service.load(root, 'app.ts');
  assert.deepEqual([snapshot.results[0].line, snapshot.results[0].status], [3, 'moved']);
});

test('a comment cut with its line follows the paste, even when the file is saved in between', async t => {
  const { root, document, api } = await setup(t);
  await addDraft(api, root);
  await api.store.get(document);
  const line = 'if (!ready) wait();\n';
  const start = document.text.indexOf(line);

  document.text = document.text.slice(0, start) + document.text.slice(start + line.length);
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: start, rangeLength: line.length, text: '' }] });
  await fs.writeFile(document.uri.fsPath, document.text);
  await api.store.saved(document);
  assert.equal((await service.load(root, 'app.ts')).results[0].status, 'detached');

  const end = document.text.length;
  document.text += line;
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: end, rangeLength: 0, text: line }] });
  await fs.writeFile(document.uri.fsPath, document.text);
  await api.store.saved(document);

  const result = (await service.load(root, 'app.ts')).results[0];
  assert.deepEqual([result.line, result.status], [3, 'attached']);
});

test('saving writes a comment again once its line is edited', async t => {
  const { root, document, api } = await setup(t);
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  await api.drafts.writeFile(uri, Buffer.from('Wait.'));
  await api.store.get(document);

  const end = document.text.indexOf('wait();') + 'wait();'.length;
  document.text = `${document.text.slice(0, end)} // soon${document.text.slice(end)}`;
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: end, rangeLength: 0, text: ' // soon' }] });
  await fs.writeFile(path.join(root, 'app.ts'), document.text);
  await api.store.saved(document);

  const snapshot = await service.load(root, 'app.ts');
  assert.deepEqual([snapshot.notes[0].line, snapshot.notes[0].state], [2, 'review']);
  assert.equal(snapshot.notes[0].base, sourceHash(document.text));
});

test('store undo restores pre-deletion attachment within in-memory history', async t => {
  const { root, document, api } = await setup(t);
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  await api.drafts.writeFile(uri, Buffer.from('Wait.'));
  await api.store.get(document);

  const old = document.text;
  const start = old.indexOf('if (!ready)');
  const length = 'if (!ready) wait();\n'.length;
  document.text = old.slice(0, start) + old.slice(start + length);
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: start, rangeLength: length, text: '' }] });

  assert.equal((await api.store.get(document)).results[0].status, 'detached');

  document.text = old;
  document.version++;
  api.store.changed({
    document,
    contentChanges: [{ rangeOffset: start, rangeLength: 0, text: 'if (!ready) wait();\n' }],
  });

  assert.equal((await api.store.get(document)).results[0].line, 2);
  assert.equal((await api.store.get(document)).results[0].status, 'attached');
});

test('untrusted workspaces and unsaved sources prevent draft writes', async t => {
  const { root, document, api } = await setup(t);
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);

  vscode.workspace.isTrusted = false;
  await assert.rejects(() => api.drafts.writeFile(uri, Buffer.from('Reason.')), /Trust/);

  vscode.workspace.isTrusted = true;
  document.isDirty = true;
  await assert.rejects(() => api.drafts.writeFile(uri, Buffer.from('Reason.')), /Save the source/);
});

test('source revision changed while drafting cannot attach comment to another line', async t => {
  const { root, api } = await setup(t);
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  await fs.writeFile(path.join(root, 'app.ts'), '\nchanged\n');
  await assert.rejects(() => api.drafts.writeFile(uri, Buffer.from('Reason.')), /Source revision/);
});

test('editor rename participants include sibling patch without overwrite', async t => {
  const { root, api } = await setup(t);
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  await api.drafts.writeFile(uri, Buffer.from('Reason.'));

  let pending;
  events.rename.fire({
    files: [{ oldUri: Uri.file(path.join(root, 'app.ts')), newUri: Uri.file(path.join(root, 'renamed.ts')) }],
    waitUntil(value) {
      pending = value;
    },
  });
  const edit = await pending;

  assert.equal(edit.renames.length, 1);
  assert.equal(edit.renames[0].a.fsPath, path.join(root, 'app.ts.comment'));
  assert.equal(edit.renames[0].options.overwrite, false);
});

function hoverText(hover) {
  return hover.contents.slice(1).flatMap(content => content.parts.map(part => part.value)).join('');
}

function hoverHeader(hover) {
  return hover.contents[0].parts.map(part => part.value).join('');
}

function hoverAt(document, line) {
  return hoverProviders.at(-1).provideHover(
    document,
    new Position(line, 0),
    { isCancellationRequested: false },
  );
}

async function addDraft(api, root, text = 'Wait for initialization.') {
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  await api.drafts.writeFile(uri, Buffer.from(text));
  return uri;
}

test('defaults show the labeled ring with one comment body and no healthy status or revision metadata', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  await api.refresh(document.uri);

  assert.equal(editor.decorations.length, 1);
  assert.equal(editor.decorations[0].renderOptions.after.contentText, '◌ comment');
  assert.equal(vscode.status.visible, false);

  const hover = await hoverProviders.at(-1).provideHover(
    document,
    new Position(1, 3),
    { isCancellationRequested: false },
  );
  assert.equal(hover.contents.length, 2);
  assert.equal(hoverHeader(hover), '**Comment on line 2**');
  assert.equal(hoverText(hover), 'Wait for initialization.');
});

test('optional markers are rings with no decoration hover to duplicate provider content', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  vscode.configuration.showMarkers = true;
  vscode.configuration.markerStyle = 'icon';
  await api.refresh(document.uri);

  assert.equal(editor.decorations.length, 1);
  assert.equal(editor.decorations[0].renderOptions.after.contentText, '◌');
  assert.equal(Object.hasOwn(editor.decorations[0], 'hoverMessage'), false);

  vscode.configuration.showMarkers = false;
  await api.refresh(document.uri);
  assert.deepEqual(editor.decorations, []);
});

test('hover metadata is explicitly opt-in', async t => {
  const { root, document, api } = await setup(t);
  await addDraft(api, root);
  vscode.configuration.showHoverMetadata = true;

  const hover = await hoverAt(document, 1);
  const note = (await service.load(root, 'app.ts')).notes[0];

  assert.ok(hoverText(hover).includes(note.id));
  assert.match(hoverText(hover), /attached/);
  assert.match(hoverText(hover), /Source matches the recorded revision/);
});

test('review warning remains visible when debug metadata and markers are off', async t => {
  const { root, document, api } = await setup(t);
  await addDraft(api, root);
  await api.store.get(document);

  const offset = document.text.indexOf('wait()');
  document.text = document.text.replace('wait()', 'awaitReady()');
  document.version++;
  api.store.changed({
    document,
    contentChanges: [{ rangeOffset: offset, rangeLength: 6, text: 'awaitReady()' }],
  });

  const hover = await hoverAt(document, 1);
  assert.match(hoverText(hover), /Needs review/);
  assert.doesNotMatch(hoverText(hover), /Source matches/);

  await api.refresh(document.uri);
  assert.equal(vscode.status.visible, true);
});

test('aliased workspace loads source and refreshes cached annotations after a canonical draft save', async t => {
  const { root, document, api } = await setup(t, { alias: true });
  assert.equal((await api.store.get(document)).results.length, 0);

  await addDraft(api, root);
  const entry = await api.store.get(document);

  assert.equal(entry.results.length, 1);
  assert.equal(entry.snapshot.sourcePath, await fs.realpath(document.uri.fsPath));
  assert.notEqual(entry.snapshot.sourcePath, document.uri.fsPath);
});

test('dirty source through an alias blocks draft save without writing the sidecar', async t => {
  const { root, document, api } = await setup(t, { alias: true });
  const uri = api.drafts.create(await service.load(root, 'app.ts'), 2);
  document.isDirty = true;

  await assert.rejects(() => api.drafts.writeFile(uri, Buffer.from('Reason.')), /Save the source/);
  await assert.rejects(() => fs.stat(path.join(root, 'app.ts.comment')), { code: 'ENOENT' });
});

test('dirty aliased sidecar blocks both draft edits and automatic tracked writes', async t => {
  const { root, document, api } = await setup(t, { alias: true });
  const uri = await addDraft(api, root);
  const sidecar = await vscode.workspace.openTextDocument(Uri.file(path.join(root, 'app.ts.comment')));
  const before = sidecar.getText();
  sidecar.isDirty = true;

  await assert.rejects(() => api.drafts.writeFile(uri, Buffer.from('Updated reason.')), /Save the source/);

  await api.store.get(document);
  const end = document.text.indexOf('wait();') + 'wait();'.length;
  document.text = `${document.text.slice(0, end)} // soon${document.text.slice(end)}`;
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: end, rangeLength: 0, text: ' // soon' }] });
  await fs.writeFile(document.uri.fsPath, document.text);
  await api.store.saved(document);

  assert.ok(vscode.logs.some(line => line.includes('Sidecar has unsaved edits')));
  assert.equal(await fs.readFile(sidecar.uri.fsPath, 'utf8'), before);

  sidecar.isDirty = false;
  await api.store.saved(document);
  assert.equal((await service.load(root, 'app.ts')).notes[0].state, 'review');
});

test('canonical sidecar watcher event invalidates an aliased editor cache', async t => {
  const { root, document, api } = await setup(t, { alias: true });
  const entry = await api.store.get(document);
  assert.equal(entry.results.length, 0);

  const snapshot = await service.load(root, 'app.ts');
  await service.write(root, 'app.ts', {
    operation: 'add',
    line: 2,
    text: 'External writer.',
    expectedText: 'if (!ready) wait();',
    expectedSource: snapshot.sourceHash,
    expectedSidecar: snapshot.sidecarHash,
  });
  await events.sidecarChange.fire(Uri.file(snapshot.sidecarPath));

  assert.equal((await api.store.get(document)).results[0].note.text, 'External writer.');
});

function highlightSets(editor) {
  return [...editor.decorationSets].filter(
    ([type]) => type.options?.borderColor?.id?.startsWith('commentSidecar.'),
  );
}

test('annotated lines receive one subtle theme-based highlight by default without another hover', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  await api.refresh(document.uri);

  const active = highlightSets(editor).filter(([, ranges]) => ranges.length);
  assert.equal(active.length, 1);

  const [type, ranges] = active[0];
  assert.equal(type.options.isWholeLine, true);
  assert.equal(type.options.backgroundColor.id, 'commentSidecar.highlightBackground');
  assert.equal(type.options.borderColor.id, 'commentSidecar.highlightBorder');
  assert.equal(type.options.borderWidth, '0 0 0 2px');
  assert.equal(type.options.rangeBehavior, vscode.DecorationRangeBehavior.ClosedClosed);
  assert.equal(type.options.color, undefined);
  assert.equal(type.options.after, undefined);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start.line, 1);
  assert.equal(ranges[0].hoverMessage, undefined);
});

test('highlight styles change to underline and off without leaving old decorations', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  await api.refresh(document.uri);

  vscode.configuration.highlightStyle = 'underline';
  await api.refresh(document.uri);
  const active = highlightSets(editor).filter(([, ranges]) => ranges.length);
  assert.equal(active.length, 1);
  assert.equal(active[0][0].options.isWholeLine, false);
  assert.equal(active[0][0].options.borderWidth, '0 0 1px 0');
  assert.equal(active[0][0].options.backgroundColor, undefined);

  vscode.configuration.highlightStyle = 'off';
  await api.refresh(document.uri);
  assert.ok(highlightSets(editor).every(([, ranges]) => ranges.length === 0));

  const hover = await hoverAt(document, 1);
  assert.equal(hoverText(hover), 'Wait for initialization.');
});

test('same-line notes share one highlight and review state uses a different theme color', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root, 'First explanation.');
  await addDraft(api, root, 'Second explanation.');
  await api.refresh(document.uri);
  assert.equal(highlightSets(editor).reduce((sum, [, ranges]) => sum + ranges.length, 0), 1);

  const offset = document.text.indexOf('wait()');
  document.text = document.text.replace('wait()', 'awaitReady()');
  document.version++;
  api.store.changed({
    document,
    contentChanges: [{ rangeOffset: offset, rangeLength: 6, text: 'awaitReady()' }],
  });
  await api.refresh(document.uri);

  const active = highlightSets(editor).filter(([, ranges]) => ranges.length);
  assert.equal(active.length, 1);
  assert.equal(active[0][0].options.backgroundColor.id, 'commentSidecar.reviewBackground');
});

test('deleting the target removes its highlight instead of highlighting its replacement line', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  await api.refresh(document.uri);

  const start = document.text.indexOf('if (!ready)');
  const length = document.text.indexOf('\n', start) - start + 1;
  document.text = document.text.slice(0, start) + document.text.slice(start + length);
  document.version++;
  api.store.changed({
    document,
    contentChanges: [{ rangeOffset: start, rangeLength: length, text: '' }],
  });
  await api.refresh(document.uri);

  assert.ok(highlightSets(editor).every(([, ranges]) => ranges.length === 0));
});

test('an unsupported sidecar is reported, shows no stale presentation and is never rewritten by the editor', async t => {
  const { document, editor, api } = await setup(t);
  const unsupported =
    '# comment-sidecar v1\n--- app.ts\n+++ app.ts.annotated\n@@ -1,3 +1,4 @@ id=sc_old base=' +
    'a'.repeat(64) +
    ' state=attached\n const ready = false;\n+// Old-format comment.\n if (!ready) wait();\n start();\n';
  const sidecar = `${document.uri.fsPath}.comment`;
  await fs.writeFile(sidecar, unsupported);

  await assert.rejects(() => api.store.get(document), /Unsupported .comment file version/);

  await api.refresh(document.uri);
  assert.ok(highlightSets(editor).every(([, ranges]) => ranges.length === 0));
  assert.deepEqual(editor.decorations, []);

  const hover = await hoverAt(document, 1);
  assert.equal(hover, undefined);
  assert.ok(vscode.logs.some(line => line.includes('Unsupported .comment file version')));

  for (const name of ['add', 'edit', 'remove', 'review', 'reanchor']) {
    vscode.lastError = undefined;
    await commands.get(`commentSidecar.${name}`)();
    assert.match(vscode.lastError, /Unsupported .comment file version/);
  }

  document.text = '\n' + document.text;
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: '\n' }] });
  await fs.writeFile(document.uri.fsPath, document.text);
  await api.store.saved(document);

  assert.equal(await fs.readFile(sidecar, 'utf8'), unsupported);
});

test('an unreadable sidecar clears prior highlights instead of showing stale attachments', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  await api.refresh(document.uri);
  assert.ok(highlightSets(editor).some(([, ranges]) => ranges.length > 0));

  await fs.writeFile(`${document.uri.fsPath}.comment`, 'broken sidecar');
  api.store.invalidate(document.uri);
  await api.refresh(document.uri);

  assert.ok(highlightSets(editor).every(([, ranges]) => ranges.length === 0));
  assert.ok(vscode.logs.some(line => line.includes('.comment file version')));
});

test('marker style can hide labels without disabling highlights or hover', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  vscode.configuration.markerStyle = 'off';
  await api.refresh(document.uri);

  assert.deepEqual(editor.decorations, []);
  assert.ok(highlightSets(editor).some(([, ranges]) => ranges.length));

  const hover = await hoverAt(document, 1);
  assert.equal(hoverText(hover), 'Wait for initialization.');
});

test('review markers retain the dashed circle in both labeled and icon modes', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  await api.store.get(document);

  const offset = document.text.indexOf('wait()');
  document.text = document.text.replace('wait()', 'awaitReady()');
  document.version++;
  api.store.changed({
    document,
    contentChanges: [{ rangeOffset: offset, rangeLength: 6, text: 'awaitReady()' }],
  });
  await api.refresh(document.uri);

  assert.equal(editor.decorations[0].renderOptions.after.contentText, '◌ comment !');

  vscode.configuration.markerStyle = 'icon';
  await api.refresh(document.uri);
  assert.equal(editor.decorations[0].renderOptions.after.contentText, '◌ !');
});

test('files without annotations update preview source without building edit history', async t => {
  const { document, api } = await setup(t);
  const entry = await api.store.get(document);
  assert.equal(entry.history.size, 0);

  for (let i = 0; i < 25; i++) {
    document.text = '\n' + document.text;
    document.version++;
    api.store.changed({ document, contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: '\n' }] });
  }

  assert.equal(entry.source, document.text);
  assert.equal(entry.version, document.version);
  assert.equal(entry.history.size, 0);
  assert.equal(entry.byLine.size, 0);
});

test('a saved source reuses the service resolution and line lookup groups same-line comments', async t => {
  const { root, document, api } = await setup(t);
  await addDraft(api, root, 'First.');
  await addDraft(api, root, 'Second.');
  const entry = await api.store.get(document);

  assert.equal(entry.results, entry.snapshot.results);
  assert.equal(entry.byLine.size, 1);
  assert.equal(entry.byLine.get(2).length, 2);

  // Reject full-list scans specifically in the hover path.
  entry.results.filter = () => {
    throw new Error('Hover scanned all annotations.');
  };

  const hover = await hoverAt(document, 1);
  assert.equal(hover.contents.length, 3);

  const bodies = hover.contents.slice(1).map(content => content.parts.map(part => part.value).join(''));
  assert.deepEqual(bodies, entry.byLine.get(2).map(item => item.note.text));
  assert.deepEqual([...bodies].sort(), ['First.', 'Second.']);
});

test('line lookup follows edits, deletion and undo without returning stale positions', async t => {
  const { root, document, api } = await setup(t);
  await addDraft(api, root);
  const entry = await api.store.get(document);
  const before = document.text;

  document.text = '\n' + before;
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: '\n' }] });
  assert.equal(entry.byLine.has(2), false);
  assert.equal(entry.byLine.get(3).length, 1);

  document.text = before;
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: 0, rangeLength: 1, text: '' }] });
  assert.equal(entry.byLine.has(3), false);
  assert.equal(entry.byLine.get(2).length, 1);

  const start = before.indexOf('if (!ready)');
  const length = before.indexOf('\n', start) - start + 1;
  document.text = before.slice(0, start) + before.slice(start + length);
  document.version++;
  api.store.changed({ document, contentChanges: [{ rangeOffset: start, rangeLength: length, text: '' }] });
  assert.equal(entry.byLine.size, 0);

  document.text = before;
  document.version++;
  api.store.changed({
    document,
    contentChanges: [{ rangeOffset: start, rangeLength: 0, text: before.slice(start, start + length) }],
  });
  assert.equal(entry.byLine.get(2).length, 1);
});

test('manifest defaults render the original labeled ring and a single hover contribution', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  await api.refresh(document.uri);

  assert.equal(editor.decorations.length, 1);
  assert.equal(editor.decorations[0].renderOptions.after.contentText, '◌ comment');
  assert.equal(Object.hasOwn(editor.decorations[0], 'hoverMessage'), false);

  const hover = await hoverAt(document, 1);
  assert.equal(hover.contents.length, 2);
  assert.equal(hoverHeader(hover), '**Comment on line 2**');
  assert.equal(hoverText(hover), 'Wait for initialization.');
});

test('persistent showMarkers=false only hides markers, not highlights or hover', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root);
  vscode.configuration.showMarkers = false;
  await api.refresh(document.uri);

  assert.deepEqual(editor.decorations, []);
  assert.ok(highlightSets(editor).some(([, ranges]) => ranges.length));

  const hover = await hoverAt(document, 1);
  assert.equal(hoverText(hover), 'Wait for initialization.');

  vscode.configuration.showMarkers = true;
  await api.refresh(document.uri);
  assert.equal(editor.decorations[0].renderOptions.after.contentText, '◌ comment');
});

test('multiple annotations share one labeled ring while retaining both comment bodies', async t => {
  const { root, document, editor, api } = await setup(t);
  await addDraft(api, root, 'First reason.');
  await addDraft(api, root, 'Second reason.');
  await api.refresh(document.uri);

  assert.equal(editor.decorations.length, 1);
  assert.equal(editor.decorations[0].renderOptions.after.contentText, '◌ comment');

  const hover = await hoverAt(document, 1);
  assert.equal(hover.contents.length, 3);
  assert.equal(hoverHeader(hover), '**2 comments on line 2**');
});

test('hover names the annotated line so a card covering the line above is unambiguous', async t => {
  const { root, document, api } = await setup(t);
  await addDraft(api, root);

  const hover = await hoverAt(document, 1);
  assert.equal(hoverHeader(hover), '**Comment on line 2**');
  assert.equal(hoverText(hover), 'Wait for initialization.');
});

test('sidecar files are dimmed in the explorer without affecting sources or folders', async t => {
  const { root } = await setup(t);
  assert.equal(fileDecorationProviders.length, 1);

  const provider = fileDecorationProviders[0];
  const decoration = provider.provideFileDecoration(Uri.file(path.join(root, 'app.ts.comment')));
  assert.equal(decoration.color.id, 'commentSidecar.sidecarForeground');
  assert.equal(decoration.propagate, false);
  assert.equal(provider.provideFileDecoration(Uri.file(path.join(root, 'app.ts'))), undefined);
  assert.equal(provider.provideFileDecoration(Uri.parse('untitled:notes.comment')), undefined);
});

test('manifest contributes the sidecar color with a theme-aware default', () => {
  const color = require('../package.json').contributes.colors.find(
    item => item.id === 'commentSidecar.sidecarForeground',
  );
  assert.deepEqual(color.defaults, {
    dark: 'disabledForeground',
    light: 'disabledForeground',
    highContrast: 'disabledForeground',
    highContrastLight: 'disabledForeground',
  });
});

test('review.hold marks a review comment attached and leaves source untouched', async t => {
  const { root, document } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));

  const changed = source.split('\n');
  changed[0] = 'const ready = true;';
  await fs.writeFile(path.join(root, 'app.ts'), changed.join('\n'));
  const sourceBefore = await fs.readFile(path.join(root, 'app.ts'), 'utf8');

  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.hold')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: note.id,
    line: 2,
    previousLine: 2,
    status: 'review',
    reason: 'test',
    text: note.text,
  });

  assert.equal(vscode.lastError, undefined);
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), sourceBefore);

  const snapshot = await service.load(root, 'app.ts');
  const result = snapshot.results.find(item => item.note.id === note.id);
  assert.ok(result);
  assert.equal(result.status, 'attached');
});

test('review.reattach reanchors a detached comment at the cursor line', async t => {
  const { root, document } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));

  const changed = 'const ready = false;\nstart();\n';
  await fs.writeFile(path.join(root, 'app.ts'), changed);
  document.text = changed;

  vscode.infoChoice = 0;
  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.reattach')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: note.id,
    line: null,
    previousLine: 2,
    status: 'detached',
    reason: 'test',
    text: note.text,
  });

  assert.equal(vscode.lastError, undefined);
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), changed);

  const snapshot = await service.load(root, 'app.ts');
  const result = snapshot.results.find(item => item.note.id === note.id);
  assert.ok(result);
  assert.equal(result.status, 'attached');
  assert.equal(result.line, 2);
});

test('review.open reveals the annotated line and shows hover', async t => {
  const { root } = await setup(t);
  vscode.executed = undefined;
  await commands.get('commentSidecar.review.open')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: 'sc_x',
    line: 2,
    previousLine: 2,
    status: 'review',
    reason: 'test',
    text: 'note',
  });
  assert.ok((vscode.executed || []).includes('editor.action.showHover'));
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 1);
  assert.ok(vscode.window.activeTextEditor.revealedRange);
});

test('manifest declares the activity-bar container and the Review view', () => {
  const manifest = require('../package.json').contributes;
  assert.ok(manifest.viewsContainers.activitybar.some(container => container.id === 'commentSidecar'));
  assert.ok(manifest.views.commentSidecar.some(view => view.id === 'commentSidecar.review'));
});

test('manifest menus gate review actions to view, viewItem and workspace trust', () => {
  const menus = require('../package.json').contributes.menus;
  const hold = menus['view/item/context'].find(item => item.command === 'commentSidecar.review.hold');
  assert.equal(hold.when, 'view == commentSidecar.review && viewItem == commentSidecar.reviewItem && isWorkspaceTrusted');
  const refresh = menus['view/title'].find(item => item.command === 'commentSidecar.review.refresh');
  assert.ok(refresh);
  const hidden = menus.commandPalette.find(item => item.command === 'commentSidecar.review.open');
  assert.equal(hidden.when, 'false');
});

test('rescan syncs the review view badge and message', async t => {
  const { root, document, api } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));
  const changed = source.split('\n');
  changed[0] = 'const ready = true;';
  await fs.writeFile(path.join(root, 'app.ts'), changed.join('\n'));
  document.text = changed;
  api.store.invalidate(vscode.Uri.file(path.join(root, 'app.ts')));

  api.scheduleRescan();
  await waitFor(() => api.reviewTree.entries.length === 1);

  assert.equal(api.reviewTree.entries.length, 1);
  assert.equal(api.reviewView.badge.value, 1);
  assert.equal(api.reviewView.message, undefined);
});

test('review.hold rejects a detached comment without writing', async t => {
  const { root } = await setup(t);
  const before = await fs.readFile(path.join(root, 'app.ts'), 'utf8');
  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.hold')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: 'sc_x',
    line: null,
    previousLine: 2,
    status: 'detached',
    reason: 'test',
    text: 'note',
  });
  assert.equal(vscode.lastError, 'Comment Sidecar: Only comments that need review can be marked as still holding.');
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), before);
});

test('review.reattach writes nothing when the toast is dismissed', async t => {
  const { root, document } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));
  const changed = 'const ready = false;\nstart();\n';
  await fs.writeFile(path.join(root, 'app.ts'), changed);
  document.text = changed;

  vscode.infoChoice = undefined;
  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.reattach')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: note.id,
    line: null,
    previousLine: 2,
    status: 'detached',
    reason: 'test',
    text: note.text,
  });

  assert.equal(vscode.lastError, undefined);
  const snapshot = await service.load(root, 'app.ts');
  const result = snapshot.results.find(item => item.note.id === note.id);
  assert.equal(result.status, 'detached');
});

test('review.hold rejects when the workspace is not trusted', async t => {
  const { root } = await setup(t);
  vscode.workspace.isTrusted = false;
  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.hold')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: 'sc_x',
    line: 2,
    previousLine: 2,
    status: 'review',
    reason: 'test',
    text: 'note',
  });
  assert.equal(vscode.lastError, 'Comment Sidecar: Trust this workspace before changing comments.');
  vscode.workspace.isTrusted = true;
});

test('manifest hides review commands from the palette except refresh and has no viewsWelcome', () => {
  const manifest = require('../package.json').contributes;
  for (const name of ['open', 'hold', 'edit', 'reattach']) {
    const item = manifest.menus.commandPalette.find(entry => entry.command === `commentSidecar.review.${name}`);
    assert.equal(item.when, 'false');
  }
  assert.equal(manifest.menus.commandPalette.some(entry => entry.command === 'commentSidecar.review.refresh'), false);
  assert.equal(manifest.viewsWelcome, undefined);
});

test('status bar item focuses the Review view', async t => {
  await setup(t);
  assert.equal(vscode.status.command, 'commentSidecar.review.focus');
});

test('live edit marks an annotated line for review', async t => {
  const { root, document, api } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));
  await api.store.get(document);

  const target = 'if (!ready) wait();';
  const offset = source.indexOf(target);
  document.text = source.replace(target, 'if (!ready) start();');
  await events['change'].fire({
    document,
    contentChanges: [{ rangeOffset: offset, rangeLength: target.length, text: 'if (!ready) start();' }],
  });

  const entry = api.store.cache.get(document.uri.toString());
  const result = entry.results.find(item => item.note.id === note.id);
  assert.equal(result.status, 'review');
});

test('sidecar watcher event triggers a rescan that populates the tree', async t => {
  const { root, document, api } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));
  const changed = source.split('\n');
  changed[0] = 'const ready = true;';
  await fs.writeFile(path.join(root, 'app.ts'), changed.join('\n'));
  document.text = changed.join('\n');
  api.store.invalidate(vscode.Uri.file(path.join(root, 'app.ts')));

  await events['sidecarCreate'].fire(vscode.Uri.file(path.join(root, 'app.ts.comment')));
  await waitFor(() => api.reviewTree.entries.length === 1);

  assert.equal(api.reviewTree.entries.length, 1);
  assert.equal(api.reviewView.badge.value, 1);
});

test('review tree view is registered with the correct view id', async t => {
  const { api } = await setup(t);
  assert.equal(api.reviewView.viewId, 'commentSidecar.review');
  assert.ok(vscode.reviewViews.some(view => view.viewId === 'commentSidecar.review'));
});

test('store ignores non-file documents', async t => {
  const { api } = await setup(t);
  assert.equal(api.store.supports({ uri: { scheme: 'untitled', fsPath: '' } }), false);
  assert.equal(api.store.supports({ uri: { scheme: 'file', fsPath: '/tmp/x.ts.comment' } }), false);
});

test('review.edit opens a draft for the comment', async t => {
  const { root, document } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));

  await commands.get('commentSidecar.review.edit')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: note.id,
    line: 2,
    previousLine: 2,
    status: 'review',
    reason: 'test',
    text: note.text,
  });

  assert.equal(vscode.window.activeTextEditor.document.uri.scheme, 'comment-sidecar-draft');
});

test('review.hold rejects an unknown comment id without writing', async t => {
  const { root, document } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));
  const sidecarBefore = await fs.readFile(path.join(root, 'app.ts.comment'), 'utf8');

  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.hold')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: 'sc_unknown_xyz',
    line: 2,
    previousLine: 2,
    status: 'review',
    reason: 'test',
    text: 'note',
  });

  assert.equal(vscode.lastError, 'Comment Sidecar: Unknown comment ID.');
  assert.equal(await fs.readFile(path.join(root, 'app.ts.comment'), 'utf8'), sidecarBefore);
});

test('review.open on a detached comment reveals previousLine and shows no hover', async t => {
  const { root } = await setup(t);
  vscode.infoMessages = undefined;
  vscode.executed = undefined;
  await commands.get('commentSidecar.review.open')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: 'sc_x',
    line: null,
    previousLine: 2,
    status: 'detached',
    reason: 'test',
    text: 'note',
  });
  assert.equal((vscode.executed || []).includes('editor.action.showHover'), false);
  assert.equal(vscode.infoMessages.length, 1);
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 1);
});

test('review.open surfaces an error for a missing file', async t => {
  const { root } = await setup(t);
  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.open')({
    sourcePath: path.join(root, 'nonexistent.ts'),
    file: 'nonexistent.ts',
    id: 'sc_x',
    line: 1,
    previousLine: 1,
    status: 'review',
    reason: 'test',
    text: 'note',
  });
  assert.ok(String(vscode.lastError).startsWith('Comment Sidecar: '));
});

test('review.hold re-resolves the current line, ignoring a stale tree line', async t => {
  const { root, document } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));
  const changed = source.split('\n');
  changed[0] = 'const ready = true;';
  await fs.writeFile(path.join(root, 'app.ts'), changed.join('\n'));

  vscode.lastError = undefined;
  await commands.get('commentSidecar.review.hold')({
    sourcePath: path.join(root, 'app.ts'),
    file: 'app.ts',
    id: note.id,
    line: 99,
    previousLine: 2,
    status: 'review',
    reason: 'test',
    text: note.text,
  });

  assert.equal(vscode.lastError, undefined);
  const snapshot = await service.load(root, 'app.ts');
  const result = snapshot.results.find(item => item.note.id === note.id);
  assert.equal(result.status, 'attached');
  assert.equal(result.line, 2);
});

test('editing an annotated line live-updates the review tree and badge', async t => {
  const { root, document, api } = await setup(t);
  const source = document.getText();
  const note = createNote(source, 2, 'Wait before starting.');
  await fs.writeFile(path.join(root, 'app.ts.comment'), serialize('app.ts', [note]));
  await api.store.get(document);
  await api.reviewTree.rescan(); // populate sidecarFiles so the live entry is kept

  const target = 'if (!ready) wait();';
  const offset = source.indexOf(target);
  document.text = source.replace(target, 'if (!ready) start();');
  await events['change'].fire({
    document,
    contentChanges: [{ rangeOffset: offset, rangeLength: target.length, text: 'if (!ready) start();' }],
  });
  await waitFor(() => api.reviewTree.entries.length === 1 && api.reviewView.badge.value === 1);

  assert.equal(api.reviewTree.entries.length, 1);
  assert.equal(api.reviewTree.entries[0].status, 'review');
  assert.equal(api.reviewView.badge.value, 1);
});
