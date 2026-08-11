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

### vNext dogfood cockpit

The supported browser-only vNext development door is:

```bash
bun run dev:vnext
```

It uses the isolated `TELAR_HOME=$HOME/.telar-vnext-dogfood` by default (or an
absolute dedicated `TELAR_HOME` you set), starts or attaches the engine, starts
one vNext worker unless the attached engine already has a live registered
worker, then opens the web cockpit at `http://127.0.0.1:3000/vnext`. Set
`TELAR_VNEXT_WEB_PORT` to use a different explicit port. The launcher checks
the selected loopback port before it starts anything and passes that exact port
to both Next and the desktop shell; it fails rather than silently using Next's
automatic fallback. It never uses `~/.telar` or `~/.telar-dev`.

`/vnext` has its own visual shell as well as its own engine state: it does not
mount the legacy sidebar, dock, Loom/Workspace navigation, account registry, or
desktop/browser host. Existing `/`, `/projects`, `/looms`, `/workspace`,
`/settings`, and `/demo-gallery` URLs keep their unchanged legacy shell.
`/vnext/settings` is a read-only local-runtime guide; it does not manage
accounts, credentials, or provider configuration.

To use the same cockpit in the development Electron shell, run:

```bash
bun run dev:vnext:desktop
```

This starts the engine, worker, and one web server exactly as `dev:vnext` does,
then launches the existing desktop development runner with
`TELAR_DESKTOP_URL` set to the same selected `http://127.0.0.1:<port>/vnext`
route. It therefore does not start a second Next server. Ctrl-C stops only the worker, web, and desktop processes
this command launched; when it attaches to an already healthy vNext engine, it
deliberately leaves that engine running. Legacy `bun run dev:desktop` and all
desktop package/install commands remain unchanged.

### Local desktop install (unsigned)

Builds a macOS **arm64** (Apple Silicon) `.app` from the current working tree,
uncommitted changes included. One command packages, smoke-tests, installs, and
launches:

```bash
bun run desktop:install -- --open       # install to ~/Applications and launch it
```

`desktop:install` packages first — it is a full build, not a cheap step after
`desktop:package`, so running the two back to back builds everything twice.
Reach for the halves separately only when you want them apart:

```bash
bun run desktop:package                             # build + smoke only, no install
bun run --cwd apps/desktop install:app -- --open    # install the packed app, no rebuild
```

Neither needs `sudo`. Use `--system` when you specifically want
`/Applications/Telar.app`:

```bash
bun run desktop:install -- --system --open
```

The packed app lands at `apps/desktop/release/mac-arm64/Telar.app`, stamped with
the commit it came from — the smoke log prints `BUILD Telar <sha>`, so you can
confirm you launched what you just built.

This is intentionally an unsigned, local-only `.app` flow; it does not publish,
auto-update, sign, or notarize anything. On the first launch, macOS may block
the app because it is unsigned. In Finder, Control-click `Telar.app`, choose
**Open**, then confirm **Open**. Apple signing and notarized distribution can be
added later without changing this local workflow.

#### When the build fails on a route that does not exist

A type error naming a route absent from the tree — say
`Cannot find module '../../app/api/proxy/adopt/route.js'` — means a stale
`.next/` from an older build is being type-checked alongside `.next-desktop/`,
since `apps/web/tsconfig.json` includes both. Clear it and package again:

```bash
rm -rf apps/web/.next
```

## Design docs

Legacy design docs (outdated; kept for reference only) are archived in
`.cleanup-archives/docs-legacy-2026-07-17/`. Do not treat them as current —
fresh documentation is being regenerated from the codebase.

## Status

Active development — solo project, moving fast.

## License

Proprietary — © 2026 Facundo Barbera. All rights reserved. See [`LICENSE`](LICENSE).
