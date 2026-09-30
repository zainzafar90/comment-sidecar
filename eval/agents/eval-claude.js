'use strict';

const { spawn, spawnSync } = require('node:child_process');

const RUN_TIMEOUT_MS = 8 * 60 * 1000;

function assertClaudeAvailable() {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error('The claude CLI is not available on PATH. Install Claude Code and sign in first.');
  }

  return probe.stdout.trim();
}

function claudeArgs({ prompt, model, budgetUsd, cliPath }) {
  return [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--no-session-persistence',
    '--permission-mode',
    'acceptEdits',
    '--max-budget-usd',
    String(budgetUsd),
    '--disallowedTools',
    'Task',
    'Agent',
    'WebFetch',
    'WebSearch',
    '--allowedTools',
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    `Bash(node ${cliPath}:*)`,
  ];
}

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function summarizeStream(stdout) {
  const toolCalls = [];
  let result = null;
  for (const line of stdout.split('\n')) {
    const event = parseEvent(line);
    if (!event) {
      continue;
    }

    if (event.type === 'assistant') {
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_use') {
          toolCalls.push({ name: block.name, input: block.input?.command || block.input?.file_path || '' });
        }
      }
    }

    if (event.type === 'result') {
      result = event;
    }
  }

  return { toolCalls, result };
}

function runClaude(options) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn('claude', claudeArgs(options), {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, error: `could not start claude: ${error.message}`, toolCalls: [], result: null, durationMs: 0 });
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      const { toolCalls, result } = summarizeStream(stdout);
      let error = null;
      if (timedOut) {
        error = `timed out after ${RUN_TIMEOUT_MS / 1000}s`;
      } else if (exitCode !== 0 && !result) {
        error = `claude exited with ${exitCode}: ${stderr.trim().slice(-500)}`;
      }

      resolve({ exitCode, error, toolCalls, result, durationMs: Date.now() - started });
    });
  });
}

module.exports = { assertClaudeAvailable, runClaude };
