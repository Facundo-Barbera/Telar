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
| `docs/` | Fresh project documentation is being regenerated here; legacy design docs are archived in `.cleanup-archives/docs-legacy-2026-07-17/`. |

## Getting started

Requires [Bun](https://bun.sh).

```bash
bun install
cd apps/web && bun run dev   # the web cockpit
```

### Local desktop install (unsigned)

For a usable local macOS app built from the current working tree:

```bash
bun run desktop:package                 # build + smoke-test apps/desktop/release/mac-arm64/Telar.app
bun run desktop:install -- --open       # install to ~/Applications and launch it
```

The install command does not need `sudo`. Use `--system` when you specifically
want `/Applications/Telar.app`:

```bash
bun run desktop:install -- --system --open
```

This is intentionally an unsigned, local-only `.app` flow; it does not publish,
auto-update, sign, or notarize anything. On the first launch, macOS may block
the app because it is unsigned. In Finder, Control-click `Telar.app`, choose
**Open**, then confirm **Open**. Apple signing and notarized distribution can be
added later without changing this local workflow.

## Design docs

Legacy design docs (outdated; kept for reference only) are archived in
`.cleanup-archives/docs-legacy-2026-07-17/`. Do not treat them as current —
fresh documentation is being regenerated from the codebase.

## Status

Active development — solo project, moving fast.

## License

Proprietary — © 2026 Facundo Barbera. All rights reserved. See [`LICENSE`](LICENSE).
