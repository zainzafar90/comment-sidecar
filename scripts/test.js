'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

const tests = fs.readdirSync(path.join(root, 'test'))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join(root, 'test', name));

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
}

process.exitCode = result.error || result.signal ? 1 : result.status ?? 1;
