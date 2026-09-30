'use strict';

const PAGE_SIZE = 50;

async function syncContacts(api, save) {
  let offset = 0;
  let saved = 0;
  while (true) {
    const page = await api.listContacts({ offset, limit: PAGE_SIZE });
    for (const contact of page.items) {
      await save(contact);
      saved++;
    }

    if (page.items.length < PAGE_SIZE) {
      return saved;
    }

    offset += PAGE_SIZE;
  }
}

module.exports = { syncContacts };
