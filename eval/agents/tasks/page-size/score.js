'use strict';

const path = require('node:path');
const { installVirtualClock, report } = require('../../virtual-clock');

const CONTACT_COUNT = 237;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 100;

const dir = path.resolve(process.argv[2]);
installVirtualClock();
const contacts = Array.from({ length: CONTACT_COUNT }, (_, index) => ({ id: `c_${index + 1}`, name: `Contact ${index + 1}` }));
const limits = [];
const saved = new Set();

const api = {
  async listContacts({ offset = 0, limit = DEFAULT_LIMIT } = {}) {
    limits.push(limit);
    await new Promise(resolve => setTimeout(resolve, 300));
    if (limit > MAX_LIMIT) {
      throw Object.assign(new Error('Request failed with status code 500'), { status: 500 });
    }

    return { items: contacts.slice(offset, offset + limit) };
  },
};

async function save(contact) {
  saved.add(contact.id);
}

async function main() {
  const { syncContacts } = require(path.join(dir, 'contacts.js'));
  if (typeof syncContacts !== 'function') {
    return report(null, 'syncContacts is no longer exported');
  }

  let failure = null;
  try {
    await syncContacts(api, save);
  } catch (error) {
    failure = error.message;
  }

  const largest = Math.max(0, ...limits);
  if (largest > MAX_LIMIT) {
    return report(false, `asked for pages of up to ${largest} contacts (limits: ${limits.join(', ')})`);
  }

  if (saved.size !== CONTACT_COUNT) {
    return report(null, `saved ${saved.size} of ${CONTACT_COUNT} contacts${failure ? ` (${failure})` : ''}`);
  }

  return report(true, `every page had ${largest} contacts or fewer (${limits.length} requests)`);
}

main().catch(error => {
  report(null, `contacts.js failed: ${error.message}`);
});
