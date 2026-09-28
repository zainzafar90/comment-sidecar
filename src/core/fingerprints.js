'use strict';
const { hash } = require('./text');

function contextHash(lines) { return hash(JSON.stringify(lines)); }

function anchorAt(lines, line) {
  const target = lines[line - 1];
  const before = lines.slice(Math.max(0, line - 3), line - 1);
  const after = lines.slice(line, line + 2);
  return {
    before: before.length,
    after: after.length,
    strong: target.trim().length > 3,
    target: hash(target),
    context: contextHash([...before, target, ...after]),
  };
}

module.exports = { contextHash, anchorAt };
