'use strict';

async function chargeAll(orders, provider) {
  const receipts = [];
  for (const order of orders) {
    const receipt = await provider.charge(order.id, order.amount);
    receipts.push(receipt);
  }

  return receipts;
}

module.exports = { chargeAll };
