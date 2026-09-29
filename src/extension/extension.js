'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { Store } = require('./store');
const { DraftProvider } = require('./drafts');
const {
  sidecarDecoration, hoverHeader, commentMarkdown, diagnosticsFor, markerDecorations,
} = require('./presentation');
const { createHighlights } = require('./highlights');
const { readSettings } = require('./settings');
const { render } = require('../core/render');
const { matchingDocuments, sidecarRenameEdit } = require('./documents');
const { registerCommands } = require('./commands');
const { ReviewTreeDataProvider } = require('./review-tree');
const { registerReviewCommands } = require('./review-commands');
const { SUFFIX, isSidecar, sourceOf } = require('../core/sidecar');

function activate(context) {
  const output = vscode.window.createOutputChannel('Comment Sidecar');
  const diagnostics = vscode.languages.createDiagnosticCollection('comment-sidecar');
  const previewEvents = new vscode.EventEmitter();
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: { margin: '0 0 0 1em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
  });
  const highlights = createHighlights();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 30);
  status.command = 'commentSidecar.review.focus';

  const timers = new Map();
  const log = error => output.appendLine(`[${new Date().toISOString()}] ${error.message || error}`);

  function updated(uri) {
    const key = uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void refresh(uri);
      previewEvents.fire(previewUri(uri));
      reviewTree.refresh();
      syncTreeViewState();
    }, 100));
  }

  const store = new Store(updated, log);

  async function invalidateSource(uri) {
    const documents = await matchingDocuments([uri.fsPath]);
    for (const document of documents) {
      store.invalidate(document.uri);
      updated(document.uri);
    }
  }

  const changedSidecar = uri => invalidateSource(vscode.Uri.file(sourceOf(uri.fsPath))).catch(log);
  const drafts = new DraftProvider(invalidateSource);
  const previewUri = uri => vscode.Uri.from({
    scheme: 'comment-sidecar-preview',
    path: `/${path.basename(uri.fsPath)}.txt`,
    query: encodeURIComponent(uri.toString()),
  });

  const reviewTree = new ReviewTreeDataProvider(store, log);
  const reviewView = vscode.window.createTreeView('commentSidecar.review', { treeDataProvider: reviewTree });

  let rescanTimer;
  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(async () => {
      await reviewTree.rescan();
      syncTreeViewState();
    }, 300);
  }

  function syncTreeViewState() {
    const total = reviewTree.entries.length;
    reviewView.message = total === 0
      ? 'No comments need review. Add a comment (Ctrl+Alt+; / Cmd+Alt+;) or edit an annotated line, and it will be flagged here.'
      : undefined;
    reviewView.badge = total > 0 ? { value: total, tooltip: `${total} comments need review` } : undefined;
  }

  function clearPresentation(uri) {
    diagnostics.delete(uri);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri.toString()) {
        continue;
      }

      highlights.apply(editor, new Map(), 'off');
      editor.setDecorations(decoration, []);
    }

    if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) {
      status.hide();
    }
  }

  function updateStatus(pending, uri) {
    if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) {
      return;
    }
    if (!pending) {
      status.hide();
      return;
    }

    status.text = `$(comment) ${pending} to review`;
    status.tooltip = 'Comment Sidecar: inspect external comments';
    status.show();
  }

  async function refresh(uri) {
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (!document || !store.supports(document)) {
      return;
    }

    try {
      const entry = await store.get(document);
      if (!entry) {
        clearPresentation(uri);
        return;
      }

      const problems = diagnosticsFor(document, entry.results);
      diagnostics.set(uri, problems);
      const settings = readSettings(vscode.workspace.getConfiguration('commentSidecar', uri));
      const options = markerDecorations(document, entry.byLine, settings);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() !== uri.toString()) {
          continue;
        }

        highlights.apply(editor, entry.byLine, settings.highlightStyle);
        editor.setDecorations(decoration, options);
      }

      updateStatus(problems.length, uri);
    } catch (error) {
      clearPresentation(uri);
      log(error);
    }
  }

  registerCommands(context, { store, drafts, output, log, updated, previewUri });
  registerReviewCommands(context, { store, drafts, updated, log, scheduleRescan });

  context.subscriptions.push(
    output, diagnostics, previewEvents, decoration, highlights, status, drafts, reviewView,
    new vscode.Disposable(() => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
        clearTimeout(rescanTimer);
    }),
    vscode.workspace.registerFileSystemProvider('comment-sidecar-draft', drafts, { isCaseSensitive: true }),
    vscode.window.registerFileDecorationProvider({ provideFileDecoration: sidecarDecoration }),
    vscode.workspace.registerTextDocumentContentProvider('comment-sidecar-preview', {
      onDidChange: previewEvents.event,
      async provideTextDocumentContent(uri) {
        const sourceUri = vscode.Uri.parse(decodeURIComponent(uri.query));
        const document = await vscode.workspace.openTextDocument(sourceUri);
        const entry = await store.get(document);
        if (!entry) {
          return 'No source context available.';
        }

        return render(entry.source, entry.results, {
          file: entry.snapshot.file,
          end: Math.min(document.lineCount, 1000),
          sidecarHash: entry.snapshot.sidecarHash,
        });
      },
    }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      async provideHover(document, position, token) {
        try {
          const entry = await store.get(document);
          if (token.isCancellationRequested || !entry) {
            return undefined;
          }

          const items = entry.byLine.get(position.line + 1);
          if (!items?.length) {
            return undefined;
          }

          const { showHoverMetadata: showMetadata } = readSettings(
            vscode.workspace.getConfiguration('commentSidecar', document.uri),
          );
          const line = position.line + 1;
          const contents = [
            hoverHeader(line, items.length),
            ...items.map(item => commentMarkdown(item, { showMetadata })),
          ];
          return new vscode.Hover(contents, document.lineAt(position.line).range);
        } catch (error) {
          log(error);
          return undefined;
        }
      },
    }),
    vscode.workspace.onDidChangeTextDocument(event => store.changed(event)),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.scheme === 'file' && isSidecar(document.uri.fsPath)) {
        void changedSidecar(document.uri);
        return;
      }

      void store.saved(document);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      store.close(document);
      drafts.close(document.uri);
      diagnostics.delete(document.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      status.hide();
      if (editor) {
        updated(editor.document.uri);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) {
        updated(editor.document.uri);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('commentSidecar')) {
        return;
      }

      for (const editor of vscode.window.visibleTextEditors) {
        updated(editor.document.uri);
      }
    }),
    vscode.workspace.onWillRenameFiles(event => {
      if (vscode.workspace.isTrusted) {
        event.waitUntil(sidecarRenameEdit(event.files));
      }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(`**/*${SUFFIX}`);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(changedSidecar),
    watcher.onDidCreate(changedSidecar),
    watcher.onDidDelete(changedSidecar),
    watcher.onDidChange(() => scheduleRescan()),
    watcher.onDidCreate(() => scheduleRescan()),
    watcher.onDidDelete(() => scheduleRescan()),
  );
  for (const editor of vscode.window.visibleTextEditors) {
    updated(editor.document.uri);
  }
  scheduleRescan();
  return { store, drafts, refresh, reviewTree, reviewView, scheduleRescan };
}

function deactivate() {}

module.exports = { activate, deactivate };
