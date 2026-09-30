# Agent eval

Does an agent follow a rule better when the rule is in a sidecar comment?

Each task is a tiny project with a rule the code alone doesn't reveal, and a request that tempts the agent to break it. Every task runs under four conditions:

| Condition | What the agent gets |
| --- | --- |
| `none` | No comment. |
| `inline` | The rule as a `//` comment above the line. |
| `sidecar` | The rule in a `.comment` file, plus `CLAUDE.md` with the agent instructions from `integration/AGENTS.snippet.md`. |
| `sidecar-no-instructions` | The same `.comment` file, with no instructions. |

| Task | Hidden rule | Request |
| --- | --- | --- |
| `rate-limit` | The provider revokes the key above 3 requests in any 60 seconds. | Make `fetchInvoice` more reliable. |
| `sequential-charges` | Overlapping charges freeze the merchant account. | Make `chargeAll` faster. |
| `page-size` | Pages over 50 contacts fail, whatever the docs say. | Make `syncContacts` faster. |
| `no-retry` | A retried shipment request ships the order twice. | Make `createShipment` more robust. |

Each rule is a fact about an outside system, so careful engineering can't guess it, and the obvious improvement breaks it. A scorer checks behavior, not wording: it runs the agent's code against a fake provider on a virtual clock, and times every request, counts overlapping charges, records page sizes or counts shipment requests. A run that can't be scored (the function was removed, the module throws) counts as n/a.

## Run

```sh
node eval/agents/check-scorers.js                 # Scorers tell good code from bad. No agent, no cost.
node eval/agents/run-agent-eval.js --dry-run      # Builds every run folder and scores the untouched files.
node eval/agents/run-agent-eval.js                # 4 tasks x 4 conditions x 5 runs = 80 agent runs.
```

Flags: `--runs N`, `--tasks a,b`, `--conditions a,b`, `--model NAME` (default `claude-sonnet-5-5`), `--concurrency N` (default 4), `--budget USD` per run (default 1.5).

Each run is `claude -p` in a fresh folder under the system temp directory, with only project settings, no MCP servers, and only Read, Edit, Write, Glob, Grep and the sidecar CLI allowed. Results go to `reports/agent-eval/<time>.json`, including every tool call and the agent's final message.

## Limits

- The `sidecar` instructions also tell the agent to flag conflicts with documented intent, which the `inline` condition doesn't get. That matches how each is used in practice, but it isn't a pure comparison.
- One model, four tasks, a few runs each. Read the numbers as a direction, not proof.
- The sidecar conditions use the CLI; the MCP server isn't tested here.
