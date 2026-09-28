# Architecture

## Processes

```
Telar.app (Electron main)
 ├─ telar-engine   the engine + an embedded worker. Owns all state (SQLite journal, TELAR_HOME).
 ├─ telar-ui       Next standalone server for the cockpit. Being removed (see "Headless").
 └─ renderer       the cockpit, plus WebContentsViews for the integrated browser
iPhone app ──HTTP──▶ cockpit /api/** today, engine /v2 later
providers (claude, codex, opencode) are child processes of the worker
```

- The engine listens on loopback with a per-boot token written to `<TELAR_HOME>/engine/engine.json`.
- Desktop main starts the engine, waits on `/v2/health`, then loads the cockpit.
- Electron main owns the integrated browser's tabs, views and CDP; the cockpit only draws and attaches to them through the preload bridge. Never add a second, renderer-owned browser: agents would drive tabs the person can't see.
- A turn goes: cockpit → engine `/v2` → queued in the journal → claimed by the worker → driver → provider. The worker streams observations back into the journal, and the cockpit folds them into the transcript.
- The cockpit's `src/proxy.ts` gates every request, but the engine makes the decision (`decideAccess`). If the engine can't answer, the request is denied.

## Domains

A domain is one feature, and it has the same name in every app:

| Area | Domains |
| --- | --- |
| Core | `sessions` `turns` `projects` `worktrees` |
| Agents | `providers` `agent-tools` `plugins` `computer-use` |
| Workspace | `files` `git` `github` `terminal` `browser` |
| Access | `remote` `hosts` `push` |
| Experience | `appearance` `settings` `dictation` `notes` `prompts` |
| Operations | `usage` `schedules` `storage` `updates` |

The cockpit has four UI-only features with no engine domain: `commands`, `composer`, `transcript` and `panel`.

### Shape of a domain

```
apps/engine/src/domains/<name>/
  index.ts      the domain's public API: the only file other code may import
  store.ts      state and persistence, through the kernel
  routes.ts     /v2 HTTP routes (zod-validated)
  tools.ts      agent tools, if the domain exposes any
  *.ts          logic, one concern per file
  *.test.ts     next to the file it tests

apps/web/src/features/<name>/
  index.ts  components/  hooks/  api.ts (typed engine calls)  *.ts (pure logic)  *.test.ts(x)
  server.ts + server/   Node-only code for /api routes; never imported by the client bundle

packages/engine-client/src/<name>/   schema.ts (zod)  client.ts (EngineClient methods)
apps/ios/TelarMobile/Features/<Name>/
```

A feature can have a second entry when the main index would pull too much into eager code. The one that exists is `features/sessions/cockpit`, which is loaded lazily.

### Around the domains

- **Engine:**
  - `src/` root: `main.ts` (process entry), `daemon.ts` (wiring only: stores, routes, timers) and `state.ts` (the `EngineStore` facade, still being taken apart).
  - `platform/`: `kernel/` (commands, the journal, commit hooks), `db/` (the SQLite execution store), `http/` (router, auth, params), `git/`, `fs/`, `process/`, `diagnose/`.
  - `drivers/`: `claude/`, `codex/`, `opencode/` behind `contract.ts`.
  - `worker/`: claim loop, execute, leases, supervisor.
- **Contract:** `packages/engine-client/src/` has one folder per domain, plus `protocol/` (the shared entities, events and items) and `platform/` (the client, transport and errors).
- **Web:**
  - `src/app/`: thin pages, plus the `/api` routes that forward to the engine;
  - `src/ui/`: the design system and generic hooks (`usePoll`, `useNow`, `useListNav`);
  - `src/platform/`: engine transport, desktop bridge, perf marks;
  - `src/test/`: shared test helpers only.
- **Desktop:** `src/{main,browser,terminal,login,store,handoff,preload,windows,dev}`, `test/`, `scripts/`, `assets/`.
- **iOS:** `TelarMobile/{Features,Platform,UI}`.

## Rules

1. No loose files in a `src/` root, except the engine's `main.ts`, `daemon.ts`, `state.ts` and the cockpit's `proxy.ts`. Every file belongs to a domain, `platform`, or `ui`.
2. A domain is imported only through its `index.ts` (or its `server.ts` for Node-only code). `platform` and `ui` never import a domain.
3. Engine domains don't call each other's internals. Cross-domain effects go through kernel hooks (`beforeCommit`, `afterCommit`, `onSessionDeleted`), wired in `daemon.ts`.
4. No file over 800 lines, no function over 150. `check:source` enforces this against the merge base.
5. Anything that crosses a process boundary is declared in `packages/engine-client`, once. Cockpit features reach the engine only through their `api.ts`.

## Headless (where this is going)

The engine already owns pairing, devices and the access gate, push and the notification decider, the other-Macs book, the folder listing, `sessions/live`, the MCP OAuth callback and `about`. What still runs in `telar-ui`:
- the `/api` routes: 155, most of them forwarding one call to the engine;
- forwarding requests to other Macs (`features/hosts/server`);
- `browse` and `desktop/metrics`.

The target:
- The cockpit becomes a static SPA. Desktop serves it over a `telar://` scheme whose handler injects the engine token.
- The `/api` pass-through routes and `telar-ui` go away.
- Every client uses the same `EngineClient`.
- An optional network listener on the engine serves the SPA and the API to paired devices.

The security invariants for that move are in `security.md`.
