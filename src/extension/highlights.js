'use strict';
const vscode = require('vscode');

function createHighlights() {
  const types = new Map();
  for (const style of ['line', 'underline']) {
    for (const state of ['highlight', 'review']) {
      const options = {
        isWholeLine: style === 'line',
        borderStyle: 'solid',
        borderWidth: style === 'line' ? '0 0 0 2px' : '0 0 1px 0',
        borderColor: new vscode.ThemeColor(`commentSidecar.${state}Border`),
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      };
      if (style === 'line') {
        options.backgroundColor = new vscode.ThemeColor(`commentSidecar.${state}Background`);
      }

      types.set(`${style}:${state}`, vscode.window.createTextEditorDecorationType(options));
    }
  }

  return {
    apply(editor, byLine, style) {
      const ranges = new Map([...types.keys()].map(key => [key, []]));
      const visible = style === 'line' || style === 'underline';
      for (const [line, items] of visible ? byLine : []) {
        if (line > editor.document.lineCount) {
          continue;
        }

        const state = items.some(item => item.status === 'review') ? 'review' : 'highlight';
        const sourceLine = editor.document.lineAt(line - 1);
        const first = style === 'underline' ? Math.max(0, sourceLine.text.search(/\S/)) : 0;
        const range = new vscode.Range(line - 1, first, line - 1, sourceLine.text.length);
        ranges.get(`${style}:${state}`).push(range);
      }

      for (const [key, type] of types) {
        editor.setDecorations(type, ranges.get(key));
      }
    },
    dispose() {
      for (const type of types.values()) {
        type.dispose();
      }
    },
  };
}

module.exports = { createHighlights };
