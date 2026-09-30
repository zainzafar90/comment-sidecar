'use strict';

const timersPromises = require('node:timers/promises');

function installVirtualClock() {
  const realSetImmediate = setImmediate;
  const startedAt = Date.now();
  const pending = [];
  let virtualMs = 0;
  let nextId = 1;
  let ticking = false;

  function tick() {
    ticking = false;
    if (!pending.length) {
      return;
    }

    pending.sort((a, b) => a.due - b.due || a.id - b.id);
    const timer = pending.shift();
    virtualMs = Math.max(virtualMs, timer.due);
    timer.callback(...timer.args);
    if (pending.length) {
      wake();
    }
  }

  function wake() {
    if (ticking) {
      return;
    }

    ticking = true;
    realSetImmediate(tick);
  }

  function schedule(callback, ms, args) {
    const timer = { id: nextId++, due: virtualMs + Math.max(0, Number(ms) || 0), callback, args };
    timer.ref = () => timer;
    timer.unref = () => timer;
    timer.hasRef = () => false;
    pending.push(timer);
    wake();
    return timer;
  }

  function cancel(timer) {
    const index = pending.indexOf(timer);
    if (index >= 0) {
      pending.splice(index, 1);
    }
  }

  global.setTimeout = (callback, ms, ...args) => schedule(callback, ms, args);
  global.clearTimeout = cancel;
  timersPromises.setTimeout = (ms, value) => new Promise(resolve => schedule(resolve, ms, [value]));
  Date.now = () => startedAt + virtualMs;
  Object.defineProperty(performance, 'now', { value: () => virtualMs, configurable: true });
  return { now: () => virtualMs };
}

function report(kept, reason) {
  process.stdout.write(`${JSON.stringify({ kept, reason })}\n`);
  process.exit(0);
}

module.exports = { installVirtualClock, report };
