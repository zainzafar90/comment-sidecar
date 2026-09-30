'use strict';

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 30_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchInvoice(id, request) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await request(`/invoices/${id}`);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

module.exports = { fetchInvoice };
