'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const { javascriptFiles } = require('./javascript-files');

const files = javascriptFiles();

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
  vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
}

console.log(`Syntax checked ${files.length} JavaScript files.`);
