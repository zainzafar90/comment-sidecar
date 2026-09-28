'use strict';
const vscode = require('vscode');
const { render } = require('../core/render');
const { sidecarOf } = require('../core/sidecar');
const service = require('../node/service');
const { agentRules } = require('../node/rules');
const { hasDirtyDocument } = require('./documents');

function selectedLines(editor) {
  const { selection, document } = editor;
  if (selection.isEmpty) {
    return { start: 1, end: Math.min(document.lineCount, 200) };
  }

  const start = selection.start.line + 1;
  const endsAtLineStart = selection.end.character === 0;
  const end = endsAtLineStart ? selection.end.line : selection.end.line + 1;
  return { start, end: Math.max(start, end) };
}

function registerCommands(context, { store, drafts, output, log, updated, previewUri }) {
  async function current(requireClean = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !store.supports(editor.document)) {
      throw new Error('Select a saved source file inside a workspace folder.');
    }
    if (requireClean && !vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before changing comments.');
    }
    if (requireClean && editor.document.isDirty) {
      throw new Error('Save the source before adding or changing a comment.');
    }

    const root = vscode.workspace.getWorkspaceFolder(editor.document.uri).uri.fsPath;
    const sidecarPath = sidecarOf(editor.document.uri.fsPath);
    if (requireClean && await hasDirtyDocument([editor.document.uri.fsPath, sidecarPath])) {
      throw new Error('Save the source and sidecar before changing comments through commands.');
    }

    return { editor, root, entry: await store.get(editor.document) };
  }

  function workspaceRoot() {
    const editor = vscode.window.activeTextEditor;
    const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) || vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a folder first.');
    }

    return folder.uri.fsPath;
  }

  async function pick(entry, line, all = false) {
    const local = entry.results.filter(item => item.line === line);
    const list = all || !local.length ? entry.results : local;
    if (!list.length) {
      throw new Error('This file has no external comments.');
    }
    if (list.length === 1) {
      return list[0];
    }

    const items = list.map(item => ({
      label: item.note.text.split('\n')[0].slice(0, 100),
      description: `${item.line ?? 'unresolved'} · ${item.status} · ${item.note.id}`,
      item,
    }));
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a line comment' });
    return choice?.item;
  }

  function command(name, action) {
    context.subscriptions.push(vscode.commands.registerCommand(`commentSidecar.${name}`, async () => {
      try {
        return await action();
      } catch (error) {
        log(error);
        void vscode.window.showErrorMessage(`Comment Sidecar: ${error.message}`);
      }
    }));
  }

  async function mutate(operation, chooseAll = false) {
    const { editor, root, entry } = await current(true);
    const line = editor.selection.active.line + 1;
    const item = await pick(entry, line, chooseAll);
    if (!item) {
      return;
    }

    if (operation === 'remove') {
      const confirmed = await vscode.window.showWarningMessage(
        'Delete this external comment? Source code will not change.',
        { modal: true },
        'Delete comment',
      );
      if (confirmed !== 'Delete comment') {
        return;
      }
    }

    const snapshot = await service.load(root, editor.document.uri.fsPath);
    await service.write(root, snapshot.sourcePath, {
      operation,
      id: item.note.id,
      line,
      expectedText: editor.document.lineAt(line - 1).text,
      expectedSource: snapshot.sourceHash,
      expectedSidecar: snapshot.sidecarHash,
    });

    store.invalidate(editor.document.uri);
    updated(editor.document.uri);
  }

  command('add', async () => {
    const { editor, root } = await current(true);
    const snapshot = await service.load(root, editor.document.uri.fsPath);
    const uri = drafts.create(snapshot, editor.selection.active.line + 1);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
    void vscode.window.showInformationMessage('Write the comment here, then save. Only the sibling .comment file will be written.');
  });

  command('edit', async () => {
    const { editor, root, entry } = await current(true);
    const item = await pick(entry, editor.selection.active.line + 1);
    if (!item) {
      return;
    }

    const snapshot = await service.load(root, editor.document.uri.fsPath);
    const note = snapshot.notes.find(note => note.id === item.note.id);
    if (!note) {
      throw new Error('Comment changed; select it again.');
    }

    const uri = drafts.create(snapshot, item.line || note.line, note);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
  });

  command('remove', () => mutate('remove'));
  command('review', () => mutate('review'));
  command('reanchor', () => mutate('reanchor', true));
  command('openSidecar', async () => {
    const { editor } = await current();
    const sidecarUri = vscode.Uri.file(sidecarOf(editor.document.uri.fsPath));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sidecarUri), {
      viewColumn: vscode.ViewColumn.Beside,
    });
  });

  command('preview', async () => {
    const { editor } = await current();
    const preview = await vscode.workspace.openTextDocument(previewUri(editor.document.uri));
    await vscode.window.showTextDocument(preview, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
  });

  command('copy', async () => {
    const { editor, entry } = await current();
    const { start, end } = selectedLines(editor);
    const text = render(entry.source, entry.results, {
      start,
      end,
      file: entry.snapshot.file,
      sidecarHash: entry.snapshot.sidecarHash,
    });
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('Copied source and per-line comments with original line numbers.');
  });

  command('list', async () => {
    const { editor, entry } = await current();
    const item = await pick(entry, 0, true);
    if (!item) {
      return;
    }
    if (item.line === null) {
      void vscode.window.showWarningMessage(`${item.note.id}: ${item.reason} Place the cursor on the intended line and run Reattach Comment.`);
      return;
    }

    const position = new vscode.Position(item.line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    await vscode.commands.executeCommand('editor.action.showHover');
  });

  command('check', async () => {
    const root = workspaceRoot();
    const report = await service.check(root);
    output.appendLine(JSON.stringify(report, null, 2));
    output.show(true);
    void vscode.window.showInformationMessage(`${report.comments} comments checked; ${report.problems} need attention.`);
  });

  command('copyRules', async () => {
    const invocation = `node ${JSON.stringify(context.asAbsolutePath('src/cli.js'))}`;
    await vscode.env.clipboard.writeText(await agentRules(invocation));
    void vscode.window.showInformationMessage('Copied agent instructions. Merge into AGENTS.md or a Cursor rule; existing files have not been changed.');
  });

  command('copyMcp', async () => {
    const root = workspaceRoot();
    const args = [context.asAbsolutePath('src/mcp.js'), '--root', root];
    const config = { mcpServers: { 'comment-sidecar': { type: 'stdio', command: 'node', args } } };
    await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
    void vscode.window.showInformationMessage('Copied Cursor MCP configuration. Merge its server entry into .cursor/mcp.json.');
  });
}

module.exports = { registerCommands };
