# Telar

> **Generation is solved; verification is the moat.**

Telar is a project-centric agentic development tool built on the Claude Agent SDK.
It runs **looms** — self-verifying units of work that plan, fan out into parallel
threads, build, and verify against an explicit contract. A loom never accepts its
own work: every terminal `done` is a human sign-off.

## Why

Coding agents generate plausible code all day. What they can't be trusted to do is
*judge their own output*. Telar puts an independent, read-only **Verifier** between
generation and acceptance: it drives the running app, checks the work against a
Verification Contract, and hands concrete failures back to the builder for repair.
A green verify only moves a loom to `ready` — the human always accepts.

## Model

- **Loom** — a unit of work with a lifecycle: scope → orchestrate → build → verify
  → *(repair)* → `ready` → **human accept** → `done`.
- **Orchestrator (weaver)** — decomposes an objective into parallel **threads**
  (workers), schedules them under a budget, and folds their results.
- **Verifier** — an agent that can only *observe* (a real browser plus read-only
  tools), never edit code. Its verdict is trusted precisely because it cannot make
  itself pass.
- **The moat** — a red verdict blocks acceptance and `ready → done` is always a
  human click. There is no `accept` tool an agent can call.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | Next.js cockpit — create looms, watch orchestration, inspect verification, accept / steer / reject. |
| `packages/core` | The loom engine — executor, weaver/tick loop, verifier, environment lanes, MCP OAuth, project manifest + store. |
| `docs/` | Design docs and the living [`ROADMAP`](docs/ROADMAP.md). |

## Getting started

Requires [Bun](https://bun.sh).

```bash
bun install
cd apps/web && bun run dev   # the web cockpit
```

## Design docs

- [`ROADMAP`](docs/ROADMAP.md) — the living work tracker and current frontier
- [`loom-model`](docs/loom-model.md) · [`loom-orchestrator`](docs/loom-orchestrator.md) — the execution model
- [`verifier-agent`](docs/verifier-agent.md) · [`verification-environments`](docs/verification-environments.md) — the moat
- [`runtime-architecture`](docs/runtime-architecture.md) · [`mcp-oauth-design`](docs/mcp-oauth-design.md) · [`watchers-design`](docs/watchers-design.md)

## Status

Active development — solo project, moving fast. See the [`ROADMAP`](docs/ROADMAP.md)
for what's shipped and what's next.

## License

Proprietary — © 2026 Facundo Barbera. All rights reserved. See [`LICENSE`](LICENSE).
