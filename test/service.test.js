'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');

const exec = promisify(execFile);

const service = require('../src/node/service');
const { resolveSource } = require('../src/node/workspace');
const { createHandler } = require('../src/mcp');
const { parse, serialize } = require('../src/core/format');

const SOURCE = 'const ready = false;\nif (!ready) wait();\nstart();\n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-sidecar-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app.ts'), SOURCE);
  return root;
}

function revisions(snapshot) {
  return { expectedSource: snapshot.sourceHash, expectedSidecar: snapshot.sidecarHash };
}

async function add(root, text = 'Wait until initialization completes.') {
  const snapshot = await service.load(root, 'app.ts');
  return service.write(root, 'app.ts', {
    operation: 'add',
    line: 2,
    text,
    expectedText: 'if (!ready) wait();',
    ...revisions(snapshot),
  });
}

test('end-to-end CRUD never modifies source', async t => {
  const root = await fixture(t);
  const original = await fs.readFile(path.join(root, 'app.ts'));
  const created = await add(root);

  let snapshot = await service.read(root, 'app.ts');
  assert.match(snapshot.output, /Wait until initialization/);

  await service.write(root, 'app.ts', {
    operation: 'update',
    id: created.id,
    text: 'Updated reason.\nSecond line.',
    ...revisions(snapshot),
  });
  snapshot = await service.load(root, 'app.ts');
  assert.equal(snapshot.notes[0].text, 'Updated reason.\nSecond line.');

  await service.write(root, 'app.ts', { operation: 'remove', id: created.id, ...revisions(snapshot) });
  assert.deepEqual((await service.load(root, 'app.ts')).notes, []);
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
});

test('requires exact source, sidecar and target text guards', async t => {
  const root = await fixture(t);
  const snapshot = await service.load(root, 'app.ts');

  await assert.rejects(
    () => service.write(root, 'app.ts', { operation: 'add', line: 2, text: 'x' }),
    /revision/
  );
  await assert.rejects(
    () => service.write(root, 'app.ts', { operation: 'add', line: 2, text: 'x', expectedText: 'wrong', ...revisions(snapshot) }),
    /Target text/
  );
});

test('source changed after read rejects a stale write', async t => {
  const root = await fixture(t);
  const snapshot = await service.load(root, 'app.ts');
  await fs.appendFile(path.join(root, 'app.ts'), '\n');

  await assert.rejects(
    () => service.write(root, 'app.ts', {
      operation: 'add',
      line: 2,
      text: 'x',
      expectedText: 'if (!ready) wait();',
      ...revisions(snapshot),
    }),
    /Source revision/
  );
});

test('concurrent writers cannot silently overwrite each other', async t => {
  const root = await fixture(t);
  const snapshot = await service.load(root, 'app.ts');
  const options = {
    operation: 'add',
    line: 2,
    text: 'Reason.',
    expectedText: 'if (!ready) wait();',
    ...revisions(snapshot),
  };

  const attempts = await Promise.allSettled([
    service.write(root, 'app.ts', options),
    service.write(root, 'app.ts', options),
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await service.load(root, 'app.ts')).notes.length, 1);
});

test('external target edit produces check failure and explicit reanchor repairs it', async t => {
  const root = await fixture(t);
  const created = await add(root);
  await fs.writeFile(path.join(root, 'app.ts'), SOURCE.replace('if (!ready) wait();', 'if (!ready) awaitReady();'));
  assert.equal((await service.check(root)).problems, 1);

  const snapshot = await service.load(root, 'app.ts');
  await service.write(root, 'app.ts', {
    operation: 'reanchor',
    id: created.id,
    line: 2,
    expectedText: 'if (!ready) awaitReady();',
    ...revisions(snapshot),
  });
  assert.equal((await service.check(root)).problems, 0);
});

test('external file rename leaves old sidecar as an explicit error', async t => {
  const root = await fixture(t);
  await add(root);
  await fs.rename(path.join(root, 'app.ts'), path.join(root, 'new.ts'));

  const result = await service.check(root);
  assert.equal(result.problems, 1);
  assert.equal(result.reports[0].status, 'error');
});

test('rejects traversal and paths outside workspace', async t => {
  const root = await fixture(t);
  await assert.rejects(() => resolveSource(root, '../escape.ts'), /inside/);
  await assert.rejects(() => resolveSource(root, '/etc/passwd'), /inside/);
});

test('rejects source and sidecar symlinks', async t => {
  const root = await fixture(t);
  await fs.symlink(path.join(root, 'app.ts'), path.join(root, 'linked.ts'));
  await assert.rejects(() => service.load(root, 'linked.ts'), /non-symlink/);
  await fs.symlink(path.join(root, 'app.ts'), path.join(root, 'app.ts.comment'));
  await assert.rejects(() => service.load(root, 'app.ts'), /symlink/);
});

test('rejects escaping directory symlinks', async t => {
  const root = await fixture(t);
  await fs.symlink('/etc', path.join(root, 'outside'));
  await assert.rejects(() => service.load(root, 'outside/passwd'), /escape/);
});

test('rejects dependency directories and binary files', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules/a.js'), 'x');
  await assert.rejects(() => service.load(root, 'node_modules/a.js'), /excluded/);
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await assert.rejects(() => service.load(root, 'binary'), /Binary/);
});

test('does not overwrite a dirty/malformed existing sidecar', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'app.ts.comment'), 'user content');
  await assert.rejects(() => add(root), /Sidecar|sidecar/);
  assert.equal(await fs.readFile(path.join(root, 'app.ts.comment'), 'utf8'), 'user content');
});

test('CLI subprocess reads, writes, and reports status with exit codes', async t => {
  const root = await fixture(t);
  const cli = path.join(__dirname, '../src/cli.js');

  const response = await exec(process.execPath, [cli, 'read', 'app.ts', '--root', root, '--json']);
  const snapshot = JSON.parse(response.stdout);
  await exec(process.execPath, [
    cli, 'add', 'app.ts', '--root', root,
    '--line', '2',
    '--text', 'CLI note.',
    '--expected-text', 'if (!ready) wait();',
    '--source-hash', snapshot.source,
    '--sidecar-hash', snapshot.sidecar,
  ]);
  const read = await exec(process.execPath, [cli, 'read', 'app.ts', '--root', root]);
  assert.match(read.stdout, /CLI note/);

  await fs.writeFile(path.join(root, 'app.ts'), 'rewritten\n');
  await assert.rejects(() => exec(process.execPath, [cli, 'check', '--root', root]), error => error.code === 1);
  await assert.rejects(() => exec(process.execPath, [cli, 'read', '--nonsense']), error => error.code === 2);
});

test('MCP initialize, tool discovery and read through real service', async t => {
  const root = await fixture(t);
  const handler = createHandler(root);

  let response = await handler({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' },
  });
  assert.equal(response.result.protocolVersion, '2025-11-25');
  await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });

  response = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(response.result.tools.map(tool => tool.name), ['comment_sidecar_read', 'comment_sidecar_check']);
  assert.ok(response.result.tools.every(tool => tool.annotations.readOnlyHint));

  await add(root, 'MCP note.');
  response = await handler({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'comment_sidecar_read', arguments: { file: 'app.ts', start: 2, end: 2 } },
  });
  assert.match(response.result.content[0].text, /MCP note/);
});

test('MCP has no write tool, so a well-formed write call changes nothing', async t => {
  const root = await fixture(t);
  const handler = createHandler(root);
  await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const snapshot = await service.load(root, 'app.ts');
  const denied = await handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'comment_sidecar_write',
      arguments: {
        file: 'app.ts',
        operation: 'add',
        line: 2,
        text: 'x',
        expectedText: 'if (!ready) wait();',
        ...revisions(snapshot),
      },
    },
  });
  assert.equal(denied.error.code, -32602);
  assert.deepEqual((await service.load(root, 'app.ts')).notes, []);
});

test('MCP validates inputs and returns file errors as tool errors', async t => {
  const root = await fixture(t);
  const handler = createHandler(root);
  await handler({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });

  let result = await handler({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'comment_sidecar_read', arguments: { file: 'app.ts', start: -1 } },
  });
  assert.equal(result.error.code, -32602);

  result = await handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'comment_sidecar_read', arguments: { file: '../escape' } },
  });
  assert.equal(result.result.isError, true);
});

test('saved tracked comments use optimistic sidecar conflict detection', async t => {
  const root = await fixture(t);
  await add(root);
  const snapshot = await service.load(root, 'app.ts');

  const external = parse(snapshot.raw);
  external.notes[0].text = 'Other author.';
  await fs.writeFile(snapshot.sidecarPath, serialize('app.ts', external.notes));

  await assert.rejects(() => service.saveTracked(snapshot, SOURCE, snapshot.results), /concurrently/);
});

test('MCP stdio subprocess accepts newline-delimited JSON and returns no stdout logging', async t => {
  const root = await fixture(t);
  const child = spawn(process.execPath, [path.join(__dirname, '../src/mcp.js'), '--root', root]);
  t.after(() => child.kill());

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', value => {
    stdout += value;
  });

  child.stderr.on('data', value => {
    stderr += value;
  });

  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'comment_sidecar_read', arguments: { file: 'app.ts' } } },
  ];
  child.stdin.end(requests.map(value => JSON.stringify(value)).join('\n') + '\n');

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  assert.equal(code, 0);
  assert.equal(stderr, '');

  const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 3);
  assert.match(messages[2].result.content[0].text, /if \(!ready\) wait/);
});

async function aliasFixture(t) {
  const parent = await fixture(t);
  const real = path.join(parent, 'workspace');
  await fs.mkdir(real);
  await fs.writeFile(path.join(real, 'app.ts'), SOURCE);
  const alias = path.join(parent, 'alias');
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { real: await fs.realpath(real), alias };
}

test('canonical and aliased absolute source paths resolve inside the same workspace', async t => {
  const { real, alias } = await aliasFixture(t);
  for (const root of [real, alias]) {
    for (const file of ['app.ts', path.join(real, 'app.ts'), path.join(alias, 'app.ts')]) {
      const snapshot = await service.load(root, file);
      assert.equal(snapshot.sourcePath, path.join(real, 'app.ts'));
      assert.equal(snapshot.file, 'app.ts');
    }
  }
});

test('aliased workspace still rejects traversal, escaping directory links and source-file links', async t => {
  const { real, alias } = await aliasFixture(t);
  await assert.rejects(() => resolveSource(alias, '../app.ts'), /inside/);

  await fs.symlink(path.join(real, 'app.ts'), path.join(real, 'linked.ts'));
  await assert.rejects(() => service.load(alias, 'linked.ts'), /non-symlink/);

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(path.dirname(real), path.join(real, 'outside'), symlinkType);
  await assert.rejects(() => service.load(alias, 'outside/app.ts'), /escape/);
});

test('directory aliases cannot bypass excluded dependency directories', async t => {
  const { real, alias } = await aliasFixture(t);
  await fs.mkdir(path.join(real, 'node_modules'));
  await fs.writeFile(path.join(real, 'node_modules', 'module.js'), 'export const x = 1;');

  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(path.join(real, 'node_modules'), path.join(real, 'friendly'), symlinkType);
  await assert.rejects(() => service.load(alias, 'friendly/module.js'), /excluded/);
});

test('annotations stay neutral and filter to changed lines from a diff', async t => {
  const root = await fixture(t);
  await add(root, 'Needs review.');

  // Line 2 changed in the diff, line 1 is context. Only line 2 is in scope.
  const diff = [
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -1,2 +1,2 @@',
    ' const ready = false;',
    '+if (!ready) awaitReady();',
    ' start();',
  ].join('\n');

  const filtered = await service.annotations(root, undefined, { diffText: diff });
  assert.equal(filtered.comments, 1);
  assert.equal(filtered.annotations.length, 1);
  assert.equal(filtered.annotations[0].line, 2);
  assert.equal(filtered.annotations[0].level, 'info');

  const unfiltered = await service.annotations(root, undefined);
  assert.equal(unfiltered.comments, 1);
  assert.equal(unfiltered.annotations[0].path, 'app.ts');

  // An empty diff means nothing changed, so nothing is annotated.
  assert.equal((await service.annotations(root, undefined, { diffText: '' })).comments, 0);
});

test('annotations widen scope to context lines around changes', async t => {
  const root = await fixture(t);
  const snapshot = await service.load(root, 'app.ts');
  await service.write(root, 'app.ts', {
    operation: 'add',
    line: 1,
    text: 'Top-level note.',
    expectedText: 'const ready = false;',
    ...revisions(snapshot),
  });

  // Line 2 changes; line 1 is only context. A comment on line 1 is kept
  // only when the context window reaches it.
  const diff = [
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -1,2 +1,2 @@',
    ' const ready = false;',
    '+if (!ready) awaitReady();',
    ' start();',
  ].join('\n');

  assert.equal((await service.annotations(root, undefined, { diffText: diff, context: 0 })).comments, 0);
  assert.equal((await service.annotations(root, undefined, { diffText: diff, context: 1 })).comments, 1);
});

test('annotations CLI accepts a diff file and prints neutral JSON', async t => {
  const root = await fixture(t);
  await add(root);
  const cli = path.join(__dirname, '../src/cli.js');

  await fs.writeFile(path.join(root, 'diff.txt'), [
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -1,2 +1,2 @@',
    ' const ready = false;',
    '+if (!ready) wait();',
    ' start();',
  ].join('\n'));

  const response = await exec(process.execPath, [
    cli, 'annotations', '--root', root, '--diff', path.join(root, 'diff.txt'), '--json',
  ]);
  const report = JSON.parse(response.stdout);
  assert.equal(report.comments, 1);
  assert.equal(report.annotations[0].level, 'info');
});
