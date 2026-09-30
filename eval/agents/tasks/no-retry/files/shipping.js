'use strict';

async function createShipment(order, api) {
  const response = await api.post('/shipments', { orderId: order.id, address: order.address });
  return response.trackingNumber;
}

module.exports = { createShipment };
