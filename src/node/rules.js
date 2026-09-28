'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function agentRules(invocation) {
  const text = await fs.readFile(path.join(__dirname, '../../integration/AGENTS.snippet.md'), 'utf8');
  return text.replaceAll('`sidecar ', `\`${invocation} `);
}

module.exports = { agentRules };
