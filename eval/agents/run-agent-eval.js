'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertClaudeAvailable, runClaude } = require('./eval-claude');
const { CONDITIONS, prepareRun, commentState } = require('./eval-conditions');

const ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(ROOT, 'src/cli.js');
const TASKS_DIR = path.join(__dirname, 'tasks');
const SCORE_TIMEOUT_MS = 30_000;
const DRY_AGENT = { error: null, toolCalls: [], result: null, durationMs: 0 };

function positiveNumber(flag, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} needs a positive number, got ${JSON.stringify(value)}.`);
  }

  return number;
}

function readFlag(options, flag, value) {
  switch (flag) {
    case '--runs':
      options.runs = Math.floor(positiveNumber(flag, value));
      break;
    case '--concurrency':
      options.concurrency = Math.floor(positiveNumber(flag, value));
      break;
    case '--budget':
      options.budget = positiveNumber(flag, value);
      break;
    case '--model':
      if (!/^[\w.-]+$/.test(value)) {
        throw new Error(`Invalid model name: ${JSON.stringify(value)}`);
      }
      options.model = value;
      break;
    case '--tasks':
      options.tasks = value.split(',');
      break;
    case '--conditions':
      options.conditions = value.split(',');
      break;
    default:
      throw new Error(`Unknown flag: ${flag}`);
  }
}

function parseArgs(argv) {
  const options = { runs: 5, concurrency: 4, budget: 1.5, model: 'claude-sonnet-5-5', tasks: null, conditions: CONDITIONS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (argv[i + 1] === undefined) {
      throw new Error(`Missing value after ${argv[i]}`);
    }

    readFlag(options, argv[i], argv[i + 1]);
    i++;
  }

  const unknown = options.conditions.filter(condition => !CONDITIONS.includes(condition));
  if (unknown.length) {
    throw new Error(`Unknown conditions: ${unknown.join(', ')}. Use: ${CONDITIONS.join(', ')}`);
  }

  return options;
}

function loadTasks(names) {
  const available = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const chosen = names || available;
  const unknown = chosen.filter(name => !available.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown tasks: ${unknown.join(', ')}. Use: ${available.join(', ')}`);
  }

  return chosen.map(name => {
    const dir = path.join(TASKS_DIR, name);
    const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
    return { ...task, name, dir };
  });
}

function buildJobs(tasks, options, runsRoot) {
  const jobs = [];
  for (let run = 1; run <= options.runs; run++) {
    for (const task of tasks) {
      for (const condition of options.conditions) {
        jobs.push({ task, condition, run, runDir: path.join(runsRoot, `${task.name}-${condition}-${run}`) });
      }
    }
  }

  return jobs;
}

function fileHash(file) {
  if (!fs.existsSync(file)) {
    return null;
  }

  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function score(task, runDir) {
  const result = spawnSync(process.execPath, [path.join(task.dir, 'score.js'), runDir], {
    encoding: 'utf8',
    timeout: SCORE_TIMEOUT_MS,
  });
  if (result.error) {
    return { kept: null, reason: `scorer did not finish: ${result.error.message}` };
  }

  const last = result.stdout.trim().split('\n').pop();
  try {
    return JSON.parse(last);
  } catch {
    return { kept: null, reason: `scorer output unreadable: ${(result.stderr || result.stdout).trim().slice(0, 300)}` };
  }
}

async function runOne(job, options) {
  await prepareRun({ taskDir: job.task.dir, task: job.task, condition: job.condition, runDir: job.runDir, cliPath: CLI_PATH });
  const target = path.join(job.runDir, job.task.file);
  const before = fileHash(target);
  const agent = options.dryRun
    ? DRY_AGENT
    : await runClaude({ cwd: job.runDir, prompt: job.task.prompt, model: options.model, budgetUsd: options.budget, cliPath: CLI_PATH });

  const outcome = score(job.task, job.runDir);
  return {
    task: job.task.name,
    condition: job.condition,
    run: job.run,
    kept: outcome.kept,
    reason: outcome.reason,
    changedFile: fileHash(target) !== before,
    usedSidecarCli: agent.toolCalls.some(call => call.name === 'Bash' && call.input.includes('cli.js')),
    comment: await commentState(job.runDir, job.task, job.condition),
    costUsd: agent.result?.total_cost_usd ?? null,
    turns: agent.result?.num_turns ?? null,
    durationMs: agent.durationMs,
    agentError: agent.error,
    toolCalls: agent.toolCalls,
    finalMessage: String(agent.result?.result ?? '').slice(0, 2000),
    runDir: job.runDir,
  };
}

function verdictOf(result) {
  if (result.kept === null) {
    return 'n/a';
  }

  return result.kept ? 'kept' : 'broken';
}

function failedRun(job, error) {
  return { task: job.task.name, condition: job.condition, run: job.run, kept: null, reason: `harness error: ${error.message}`, runDir: job.runDir };
}

async function runAll(jobs, options, progressFile) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next];
      next++;
      const result = await runOne(job, options).catch(error => failedRun(job, error));
      results.push(result);
      fs.appendFileSync(progressFile, `${JSON.stringify(result)}\n`);
      console.log(`[${results.length}/${jobs.length}] ${result.task} · ${result.condition} #${result.run}: ${verdictOf(result)}. ${result.reason}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, () => worker()));
  return results;
}

function cell(results) {
  const scored = results.filter(result => result.kept !== null);
  const kept = scored.filter(result => result.kept).length;
  const unscored = results.length - scored.length;
  return unscored ? `${kept}/${scored.length} (+${unscored} n/a)` : `${kept}/${scored.length}`;
}

function summaryTable(results, tasks, conditions) {
  const rows = [['rule kept', ...conditions]];
  for (const task of tasks) {
    rows.push([task.name, ...conditions.map(condition => cell(results.filter(r => r.task === task.name && r.condition === condition)))]);
  }

  rows.push(['all tasks', ...conditions.map(condition => cell(results.filter(r => r.condition === condition)))]);
  rows.push(['used sidecar CLI', ...conditions.map(condition => {
    const runs = results.filter(r => r.condition === condition);
    return `${runs.filter(r => r.usedSidecarCli).length}/${runs.length}`;
  })]);
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
  return rows.map(row => row.map((value, column) => String(value).padEnd(widths[column])).join('  ')).join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(options.tasks);
  const version = options.dryRun ? 'dry run, no agent' : assertClaudeAvailable();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runsRoot = path.join(os.tmpdir(), 'comment-sidecar-agent-eval', stamp);
  const jobs = buildJobs(tasks, options, runsRoot);
  const reportDir = path.join(ROOT, 'reports', 'agent-eval');
  const progressFile = path.join(reportDir, `${stamp}.jsonl`);
  fs.mkdirSync(reportDir, { recursive: true });
  console.log(`${jobs.length} runs with ${options.model} (${version}), ${options.concurrency} at a time.`);
  console.log(`Run folders: ${runsRoot}`);
  console.log(`Results so far: ${progressFile}`);

  const results = await runAll(jobs, options, progressFile);
  const reportFile = path.join(reportDir, `${stamp}.json`);
  fs.writeFileSync(reportFile, `${JSON.stringify({ options, tasks: tasks.map(task => task.name), results }, null, 2)}\n`);

  const cost = results.reduce((sum, result) => sum + (result.costUsd || 0), 0);
  console.log(`\n${summaryTable(results, tasks, options.conditions)}\n`);
  console.log(`Total cost: $${cost.toFixed(2)}`);
  console.log(`Details: ${reportFile}`);
}

main().catch(error => {
  console.error(`Agent eval failed: ${error.message}`);
  process.exitCode = 1;
});
