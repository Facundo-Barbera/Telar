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

The cockpit has a few UI-only features with no engine domain: `composer`, `transcript` and `panel`.

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
  index.ts  components/  hooks/  api.ts (engine calls)  model.ts (pure logic)  *.test.ts(x)

packages/engine-client/src/<name>/   schema.ts (zod)  client.ts (EngineClient methods)
apps/ios/TelarMobile/Features/<Name>/
```

### Around the domains

- **Engine `platform/`:**
  - `kernel/`: commands, the journal, commit hooks;
  - `db/`: the SQLite execution store;
  - `http/`: router, auth, body parsing, errors;
  - `git/`, `fs/`, `process/`.
- **Engine `drivers/`:** `claude/`, `codex/`, `opencode/`. **`worker/`:** claim loop, execute, leases.
- **Web:**
  - `src/app/`: thin pages only;
  - `src/ui/`: the design system;
  - `src/platform/`: engine client, desktop bridge, host;
  - `src/lib/`: generic utilities only.
- **Desktop:** `src/{main,browser,terminal,login,store,handoff,preload,windows,dev}`, `test/`, `scripts/`, `assets/`.

## Rules

1. No loose files in a `src/` root or in `lib/`. Every file belongs to a domain, `platform`, or `ui`.
2. A domain is imported only through its `index.ts`. `platform` and `ui` never import a domain.
3. Engine domains don't call each other's internals. Cross-domain effects go through kernel hooks (`beforeCommit`, `afterCommit`, `onSessionDeleted`, `turnEnded`) wired in one composition root.
4. No file over 800 lines, no function over 150.
5. Anything that crosses a process boundary is declared in `packages/engine-client`, once.

## Headless (where this is going)

The engine owns *all* functionality, so Telar can run without a UI:
- **Pairing and auth:** device tokens, roles.
- **Push**, including the push worker that today runs inside `telar-ui`.
- **Other Macs (hosts).**
- **Folder listing**, the MCP OAuth callback and `about`.

The target:
- The cockpit becomes a static SPA. Desktop serves it over a `telar://` scheme whose handler injects the engine token.
- The `/api` pass-through routes and `telar-ui` go away.
- Every client uses the same `EngineClient`.
- An optional network listener on the engine serves the SPA and the API to paired devices.

The security invariants for that move are in `security.md`.

## Status

The code is mid-migration. The old layout (a flat `apps/engine/src`, the `state.ts`/`daemon.ts`/`driver.ts` monoliths, a flat `apps/web/lib`) is still there. New code goes into the target layout; code you touch moves toward it.
