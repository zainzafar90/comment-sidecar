'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function javascriptFiles() {
  const files = [];
  const pending = ['src', 'test', 'scripts'].map(folder => path.join(root, folder));
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (file.endsWith('.js')) {
        files.push(file);
      }
    }
  }

  return files.sort();
}

module.exports = { javascriptFiles };
