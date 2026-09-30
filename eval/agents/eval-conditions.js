'use strict';

const fs = require('node:fs');
const path = require('node:path');
const service = require('../../src/node/service');
const { agentRules } = require('../../src/node/rules');

const CONDITIONS = ['none', 'inline', 'sidecar', 'sidecar-no-instructions'];

function targetIndex(lines, task) {
  const matches = lines.flatMap((line, index) => (line === task.line ? [index] : []));
  if (matches.length !== 1) {
    throw new Error(`Task ${task.name}: expected one line equal to ${JSON.stringify(task.line)}, found ${matches.length}.`);
  }

  return matches[0];
}

function addInlineComment(runDir, task) {
  const file = path.join(runDir, task.file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const index = targetIndex(lines, task);
  const indent = lines[index].match(/^\s*/)[0];
  lines.splice(index, 0, `${indent}// ${task.rule}`);
  fs.writeFileSync(file, lines.join('\n'));
}

async function addSidecarComment(runDir, task) {
  const snapshot = await service.load(runDir, task.file);
  const lines = snapshot.source.split('\n');
  await service.write(runDir, task.file, {
    operation: 'add',
    line: targetIndex(lines, task) + 1,
    text: task.rule,
    expectedText: task.line,
    expectedSource: snapshot.sourceHash,
    expectedSidecar: snapshot.sidecarHash,
  });
}

async function writeInstructions(runDir, cliPath) {
  const rules = await agentRules(`node ${cliPath}`);
  fs.writeFileSync(path.join(runDir, 'CLAUDE.md'), rules);
}

async function prepareRun({ taskDir, task, condition, runDir, cliPath }) {
  if (!CONDITIONS.includes(condition)) {
    throw new Error(`Unknown condition: ${condition}`);
  }

  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(path.join(taskDir, 'files'), runDir, { recursive: true });
  if (condition === 'inline') {
    addInlineComment(runDir, task);
  }

  if (condition.startsWith('sidecar')) {
    await addSidecarComment(runDir, task);
  }

  if (condition === 'sidecar') {
    await writeInstructions(runDir, cliPath);
  }
}

async function commentState(runDir, task, condition) {
  if (condition === 'none') {
    return 'none';
  }

  if (condition === 'inline') {
    const source = fs.readFileSync(path.join(runDir, task.file), 'utf8');
    return source.includes(task.rule) ? 'kept' : 'edited or removed';
  }

  try {
    const report = await service.check(runDir, task.file);
    const statuses = report.reports.map(item => item.status);
    return statuses.length ? statuses.join(',') : 'removed';
  } catch (error) {
    return `unreadable: ${error.message}`;
  }
}

module.exports = { CONDITIONS, prepareRun, commentState };
