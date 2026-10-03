#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const service = require('./node/service');
const { readText } = require('./node/workspace');
const { agentRules } = require('./node/rules');
const { version } = require('../package.json');

const HELP = `Comment Sidecar ${version} — line-level external comments, without modifying source.

sidecar read FILE [--start N --end N] [--mode annotated|comments|code] [--comment-budget N] [--json]
sidecar add FILE --line N --text TEXT --expected-text TEXT --source-hash HASH --sidecar-hash HASH
sidecar update FILE --id ID --text TEXT --source-hash HASH --sidecar-hash HASH
sidecar remove FILE --id ID --source-hash HASH --sidecar-hash HASH
sidecar reanchor FILE --id ID --line N --expected-text TEXT --source-hash HASH --sidecar-hash HASH
sidecar review FILE --id ID --source-hash HASH --sidecar-hash HASH
sidecar sync FILE --source-hash HASH --sidecar-hash HASH
sidecar check [FILE] [--json]
sidecar annotations [FILE] [--diff DIFFFILE] [--context N] [--json]
sidecar rules
sidecar --version

All commands accept --root PATH (default: current directory).
Use --text-file PATH instead of --text for multiline comments.
read returns revision hashes. Writes require both hashes; source files are never written.
check exits 1 for comments requiring attention, 2 for invocation errors.
annotations prints provider-neutral JSON: { path, line, message, level }. With --diff, comments on changed lines are kept; --context N (default 3, the standard) also keeps comments within N unchanged lines of a change. Source files are never written.
`;

function argumentsOf(argv) {
  const positional = [];
  const flags = {};
  const allowed = new Set([
    'root', 'start', 'end', 'mode', 'json', 'help', 'version', 'line', 'text',
    'text-file', 'expected-text', 'source-hash', 'sidecar-hash', 'id', 'comment-budget',
    'diff', 'context',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }

    const name = value.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`Unknown flag: ${value}`);
    }
    if (Object.hasOwn(flags, name)) {
      throw new Error(`Repeated flag: ${value}`);
    }
    if (['json', 'help', 'version'].includes(name)) {
      flags[name] = true;
      continue;
    }
    if (i + 1 >= argv.length) {
      throw new Error(`Missing value after ${value}`);
    }

    flags[name] = argv[++i];
  }

  return { positional, flags };
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = argumentsOf(argv);
  const [command, file] = positional;
  const root = path.resolve(flags.root || process.cwd());

  if (flags.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (flags.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'rules') {
    process.stdout.write(await agentRules(`node ${JSON.stringify(path.join(__dirname, 'cli.js'))}`));
    return;
  }
  if (command === 'check') {
    const report = await service.check(root, file);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.problems) {
      process.exitCode = 1;
    }

    return;
  }
  if (command === 'annotations') {
    if (positional.length > 2) {
      throw new Error('Specify at most one source file.');
    }

    let diffText;
    if (flags.diff) {
      diffText = await readText(flags.diff);
    }

    const context = flags.context === undefined ? undefined : Number(flags.context);
    const report = await service.annotations(root, file, { diffText, context });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (!file || positional.length > 2) {
    throw new Error('Specify exactly one source file.');
  }
  if (command === 'read') {
    const result = await service.read(root, file, {
      start: flags.start === undefined ? undefined : Number(flags.start),
      end: flags.end === undefined ? undefined : Number(flags.end),
      mode: flags.mode,
      commentBudget: flags['comment-budget'] === undefined ? undefined : Number(flags['comment-budget']),
    });
    if (!flags.json) {
      process.stdout.write(result.output);
      return;
    }

    process.stdout.write(`${JSON.stringify({
      file: result.file,
      source: result.sourceHash,
      sidecar: result.sidecarHash,
      output: result.output,
    }, null, 2)}\n`);
    return;
  }

  let text = flags.text;
  if (flags['text-file']) {
    if (text !== undefined) {
      throw new Error('Use either --text or --text-file.');
    }

    const stat = await fs.stat(flags['text-file']);
    if (stat.size > 64000) {
      throw new Error('Comment text file is too large.');
    }

    text = await fs.readFile(flags['text-file'], 'utf8');
  }

  const result = await service.write(root, file, {
    operation: command,
    id: flags.id,
    line: flags.line === undefined ? undefined : Number(flags.line),
    text,
    expectedText: flags['expected-text'],
    expectedSource: flags['source-hash'],
    expectedSidecar: flags['sidecar-hash'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Comment Sidecar: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { argumentsOf };
