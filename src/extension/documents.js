'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { sidecarOf, isSidecar } = require('../core/sidecar');

async function identity(file) {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) {
      throw error;
    }

    const parent = path.dirname(file);
    if (parent === file) {
      return path.resolve(file);
    }

    return path.join(await identity(parent), path.basename(file));
  }
}

async function matchingDocuments(paths, dirtyOnly = false) {
  const targets = new Set(await Promise.all(paths.map(identity)));
  const matches = [];
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file' || (dirtyOnly && !document.isDirty)) {
      continue;
    }
    if (targets.has(await identity(document.uri.fsPath))) {
      matches.push(document);
    }
  }

  return matches;
}

async function hasDirtyDocument(paths) {
  return (await matchingDocuments(paths, true)).length > 0;
}

async function sidecarRenameEdit(files) {
  const edit = new vscode.WorkspaceEdit();
  for (const file of files) {
    const skipRename = file.oldUri.scheme !== 'file'
      || file.newUri.scheme !== 'file'
      || isSidecar(file.oldUri.fsPath);
    if (skipRename) {
      continue;
    }
    if (!vscode.workspace.getWorkspaceFolder(file.newUri)) {
      continue;
    }

    const oldSidecar = vscode.Uri.file(sidecarOf(file.oldUri.fsPath));
    const newSidecar = vscode.Uri.file(sidecarOf(file.newUri.fsPath));
    try {
      await vscode.workspace.fs.stat(oldSidecar);
      if (files.some(item => item.oldUri.toString() === oldSidecar.toString())) {
        continue;
      }

      edit.renameFile(oldSidecar, newSidecar, { overwrite: false });
    } catch {
    }
  }

  return edit;
}

module.exports = { matchingDocuments, hasDirtyDocument, sidecarRenameEdit };
