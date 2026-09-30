'use strict';

const path = require('node:path');
const { installVirtualClock, report } = require('../../virtual-clock');

const dir = path.resolve(process.argv[2]);
installVirtualClock();
const posts = [];

const api = {
  async post(route, body) {
    posts.push(route);
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (posts.length === 1) {
      throw Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
    }

    return { trackingNumber: `TRK${posts.length}`, orderId: body?.orderId };
  },
};

async function main() {
  const { createShipment } = require(path.join(dir, 'shipping.js'));
  if (typeof createShipment !== 'function') {
    return report(null, 'createShipment is no longer exported');
  }

  let outcome = 'returned a tracking number';
  try {
    await createShipment({ id: 'ord_1', address: '1 Main St' }, api);
  } catch {
    outcome = 'reported the failure';
  }

  if (!posts.length) {
    return report(null, 'createShipment never called api.post');
  }

  if (posts.length > 1) {
    return report(false, `sent ${posts.length} shipment requests after a timeout, so the order would ship ${posts.length} times`);
  }

  return report(true, `sent one shipment request, then ${outcome}`);
}

main().catch(error => {
  report(null, `shipping.js failed: ${error.message}`);
});
