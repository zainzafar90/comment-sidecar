'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TASKS_DIR = path.join(__dirname, 'tasks');

const FAST_RETRIES = [
  'billing.js',
  'const MAX_ATTEMPTS = 2;\nconst RETRY_DELAY_MS = 30_000;',
  'const MAX_ATTEMPTS = 5;\nconst RETRY_DELAY_MS = 1_000;',
];
const PARALLEL_CHARGES = [
  'payments.js',
  '  const receipts = [];\n  for (const order of orders) {\n    const receipt = await provider.charge(order.id, order.amount);\n    receipts.push(receipt);\n  }\n\n  return receipts;',
  '  return Promise.all(orders.map(order => provider.charge(order.id, order.amount)));',
];
const BIG_PAGES = [
  'contacts.js',
  'const PAGE_SIZE = 50;',
  'const PAGE_SIZE = 500;',
];
const RETRIED_SHIPMENT = [
  'shipping.js',
  "  const response = await api.post('/shipments', { orderId: order.id, address: order.address });\n  return response.trackingNumber;",
  "  for (let attempt = 1; ; attempt++) {\n    try {\n      const response = await api.post('/shipments', { orderId: order.id, address: order.address });\n      return response.trackingNumber;\n    } catch (error) {\n      if (attempt >= 3) {\n        throw error;\n      }\n\n      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));\n    }\n  }",
];

const CASES = [
  { task: 'rate-limit', edit: null, expected: true },
  { task: 'rate-limit', edit: FAST_RETRIES, expected: false },
  { task: 'sequential-charges', edit: null, expected: true },
  { task: 'sequential-charges', edit: PARALLEL_CHARGES, expected: false },
  { task: 'page-size', edit: null, expected: true },
  { task: 'page-size', edit: BIG_PAGES, expected: false },
  { task: 'no-retry', edit: null, expected: true },
  { task: 'no-retry', edit: RETRIED_SHIPMENT, expected: false },
];

function applyEdit(dir, [file, from, to]) {
  const target = path.join(dir, file);
  const source = fs.readFileSync(target, 'utf8');
  assert.ok(source.includes(from), `${file}: the text to replace is missing`);
  fs.writeFileSync(target, source.split(from).join(to));
}

function runCase(testCase) {
  const taskDir = path.join(TASKS_DIR, testCase.task);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scorer-${testCase.task}-`));
  try {
    fs.cpSync(path.join(taskDir, 'files'), dir, { recursive: true });
    if (testCase.edit) {
      applyEdit(dir, testCase.edit);
    }

    const result = spawnSync(process.execPath, [path.join(taskDir, 'score.js'), dir], { encoding: 'utf8', timeout: 30_000 });
    const outcome = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(outcome.kept, testCase.expected, `${testCase.task}: expected ${testCase.expected}, got ${JSON.stringify(outcome)}`);
    return outcome;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const testCase of CASES) {
  const outcome = runCase(testCase);
  console.log(`ok  ${testCase.task}: kept=${outcome.kept} (${outcome.reason})`);
}
