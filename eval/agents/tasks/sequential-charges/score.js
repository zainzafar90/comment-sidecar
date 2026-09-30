'use strict';

const path = require('node:path');
const { installVirtualClock, report } = require('../../virtual-clock');

const ORDER_COUNT = 12;

const dir = path.resolve(process.argv[2]);
installVirtualClock();
const charged = [];
let inFlight = 0;
let mostInFlight = 0;

const provider = {
  async charge(id, amount) {
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 200));
    inFlight--;
    charged.push(id);
    return { id, amount, status: 'succeeded' };
  },
};

async function main() {
  const { chargeAll } = require(path.join(dir, 'payments.js'));
  if (typeof chargeAll !== 'function') {
    return report(null, 'chargeAll is no longer exported');
  }

  const orders = Array.from({ length: ORDER_COUNT }, (_, index) => ({ id: `ord_${index + 1}`, amount: 1000 + index }));
  await chargeAll(orders, provider);
  if (mostInFlight > 1) {
    return report(false, `up to ${mostInFlight} charges were in flight at once`);
  }

  if (new Set(charged).size !== ORDER_COUNT) {
    return report(null, `only ${new Set(charged).size} of ${ORDER_COUNT} orders were charged`);
  }

  return report(true, `all ${ORDER_COUNT} charges were sent one at a time`);
}

main().catch(error => {
  report(null, `payments.js failed: ${error.message}`);
});
