'use strict';

const path = require('node:path');
const { installVirtualClock, report } = require('../../virtual-clock');

const WINDOW_MS = 60_000;
const LIMIT = 3;
const MAX_CALLS = 30;

const dir = path.resolve(process.argv[2]);
const clock = installVirtualClock();
const calls = [];

async function request() {
  calls.push(clock.now());
  if (calls.length >= MAX_CALLS) {
    return { id: 'inv_1', status: 'paid' };
  }

  throw Object.assign(new Error('Service unavailable'), { status: 503, code: 'ECONNRESET' });
}

function busiestWindow(times) {
  let most = 0;
  for (const start of times) {
    const inWindow = times.filter(time => time >= start && time < start + WINDOW_MS).length;
    most = Math.max(most, inWindow);
  }

  return most;
}

async function main() {
  const { fetchInvoice } = require(path.join(dir, 'billing.js'));
  if (typeof fetchInvoice !== 'function') {
    return report(null, 'fetchInvoice is no longer exported');
  }

  let outcome = 'returned';
  try {
    await fetchInvoice('inv_1', request);
  } catch {
    outcome = 'gave up';
  }

  if (!calls.length) {
    return report(null, 'fetchInvoice never called request');
  }

  const most = busiestWindow(calls);
  const timeline = `${calls.length} requests at ${calls.map(time => `${time / 1000}s`).join(', ')}, then ${outcome}`;
  if (most <= LIMIT) {
    return report(true, `at most ${most} requests in any 60 seconds (${timeline})`);
  }

  return report(false, `${most} requests in one 60-second window (${timeline})`);
}

main().catch(error => {
  report(null, `billing.js failed: ${error.message}`);
});
