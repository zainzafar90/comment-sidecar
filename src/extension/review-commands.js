'use strict';

const path = require('node:path');
const vscode = require('vscode');
const service = require('../node/service');
const { sidecarOf } = require('../core/sidecar');
const { hasDirtyDocument } = require('./documents');

// Commands behind the Review tree. They locate a comment by id and reuse the
// existing service.write / drafts machinery — never a direct filesystem write,
// and source files are never touched.

function registerReviewCommands(context, { store, drafts, updated, log, scheduleRescan }) {
  function leafOf(arg) {
    return arg && arg.entry ? arg.entry : arg;
  }

  function assertLeaf(arg) {
    const entry = leafOf(arg);
    if (!entry || typeof entry.id !== 'string' || typeof entry.file !== 'string') {
      throw new Error('Use the Comments to Review view to run this command.');
    }
    return entry;
  }

  // The workspace folder's lexical fsPath (as opened), not the canonical
  // realpath. getWorkspaceFolder matches lexically, so in a symlinked/aliased
  // workspace the canonical sourcePath would not match and the write commands
  // would refuse to run. service.load/write do the real containment check.
  function workspaceRoot() {
    const editor = vscode.window.activeTextEditor;
    const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
      || vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a folder first.');
    }
    return folder.uri.fsPath;
  }

  // Reconstruct the lexical path (matching the open document's URI) from the
  // canonical entry, so invalidate/refresh and open hit the same document the
  // editor has open, even through directory aliases.
  function lexicalPath(root, entry) {
    return path.resolve(root, entry.file);
  }

  async function openAt(entry, line) {
    const root = workspaceRoot();
    const target = Math.max(1, line ?? 1);
    const uri = vscode.Uri.file(lexicalPath(root, entry));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const clamped = Math.max(0, Math.min(document.lineCount - 1, target - 1));
    const position = new vscode.Position(clamped, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    return { document, editor };
  }

  async function requireCleanWrite(sourcePath) {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before changing comments.');
    }
    if (await hasDirtyDocument([sourcePath, sidecarOf(sourcePath)])) {
      throw new Error('Save the source and sidecar before changing comments through commands.');
    }
  }

  function command(name, action) {
    context.subscriptions.push(vscode.commands.registerCommand(`commentSidecar.review.${name}`, async arg => {
      try {
        return await action(arg);
      } catch (error) {
        log(error);
        void vscode.window.showErrorMessage(`Comment Sidecar: ${error.message}`);
      }
    }));
  }

  command('open', async arg => {
    const entry = assertLeaf(arg);
    await openAt(entry, entry.line ?? entry.previousLine);
    if (entry.line !== null) {
      await vscode.commands.executeCommand('editor.action.showHover');
    } else {
      void vscode.window.showInformationMessage(
        `This comment was on line ${entry.previousLine}. Place the cursor on the intended line and choose Reattach.`,
      );
    }
  });

  command('hold', async arg => {
    const entry = assertLeaf(arg);
    if (entry.status !== 'review' || entry.line === null) {
      throw new Error('Only comments that need review can be marked as still holding.');
    }
    const root = workspaceRoot();
    await requireCleanWrite(entry.sourcePath);
    const snapshot = await service.load(root, entry.sourcePath);
    await service.write(root, entry.sourcePath, {
      operation: 'review',
      id: entry.id,
      expectedSource: snapshot.sourceHash,
      expectedSidecar: snapshot.sidecarHash,
    });
    const uri = vscode.Uri.file(lexicalPath(root, entry));
    store.invalidate(uri);
    updated(uri);
    scheduleRescan();
  });

  command('edit', async arg => {
    const entry = assertLeaf(arg);
    const root = workspaceRoot();
    await requireCleanWrite(entry.sourcePath);
    const snapshot = await service.load(root, entry.sourcePath);
    const note = snapshot.notes.find(item => item.id === entry.id);
    if (!note) {
      throw new Error('Comment changed; select it again.');
    }
    const uri = drafts.create(snapshot, entry.line || note.line, note);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
  });

  command('reattach', async arg => {
    const entry = assertLeaf(arg);
    const root = workspaceRoot();
    await requireCleanWrite(entry.sourcePath);
    const { document, editor } = await openAt(entry, entry.line ?? entry.previousLine);
    const choice = await vscode.window.showInformationMessage(
      'Reattach this comment? Move the cursor to the intended line, then confirm. Source code is not changed.',
      'Reattach here',
    );
    if (choice !== 'Reattach here') {
      return;
    }
    if (vscode.window.activeTextEditor?.document.uri.toString() !== editor.document.uri.toString()) {
      throw new Error('Select the source file to reattach.');
    }
    const targetLine = editor.selection.active.line + 1;
    const snapshot = await service.load(root, entry.sourcePath);
    await service.write(root, entry.sourcePath, {
      operation: 'reanchor',
      id: entry.id,
      line: targetLine,
      expectedText: document.lineAt(targetLine - 1).text,
      expectedSource: snapshot.sourceHash,
      expectedSidecar: snapshot.sidecarHash,
    });
    const uri = vscode.Uri.file(lexicalPath(root, entry));
    store.invalidate(uri);
    updated(uri);
    scheduleRescan();
  });

  command('refresh', () => {
    scheduleRescan();
  });
}

module.exports = { registerReviewCommands };
