# Telar codebase migration: plan

Started 2026-09-27. Goal: shrink the codebase and move it to a T3-Code-style shape without changing behaviour. We are not adopting Effect-TS or event sourcing.

The target layout is in `docs/internals/architecture.md`, and it is in place in every app except `state.ts`. This file lists only what remains.

- `overview.html`: audit findings, bugs found and the decisions taken.
- `composition.html` and `blueprint.html`: the repo map at the start and the target composition.

## Rules for every change

- Behaviour-preserving, small, green on its own.
- Work lands on the `migration` branch. Builders don't push or open PRs; they run the local gate, commit on a branch from `migration`, and report the SHA.
- Leave every touched file smaller than you found it. Delete what you replace.
- Comments and size: see `AGENTS.md`. `check:source` enforces both against the merge base.
- Nothing ships in a nightly until the owner has tested it locally.

## What remains

| # | Step | Notes |
|---|---|---|
| L3 | Take `apps/engine/src/state.ts` apart | See below. |
| 3 | Legacy and compat | The ungated plugin aliases under `data-science` and `latex` (`domains/plugins/scoped.ts`) stay until released clients use `/plugins/<id>`. Retire the store migrations at open once every home has run them. |
| 6 | Sessions as sub-agents | Not started. `create` takes mode `child` or `handoff`; the result is the child's last message; one notice per child; the intents and cohorts go away (21 → 10 tools). |
| 9 | Headless | See below. |
| – | Source-reading tests | 16 test files still read source files (web 3, engine 10, desktop 3). Repo-wide scans belong in `scripts/source-checks/`; rewrite the rest as behaviour tests or delete them. |

### L3: `state.ts`

`EngineStore` is still one class of 10.2k lines (3.6k of them comments), and still holds the session, turn, subscription and journal logic that daemon routes reach through it. Seven functions are over 150 lines: `fireSubscriptions`, `journalObservation`, `createSession`, `submitTurn` (and its command callback), `claimNextTurn` (and its command callback).

1. Move the remaining methods into their domains' `store.ts`, bottom-up, one domain per change. Strip the comments as they move.
2. Add the `turnEnded` kernel hook, and move subscriptions, held notifications and delegation settling onto it in that order (see `internals/engine.md`).
3. Remove the facade with a codemod: callers import the domain stores through the domains' `index.ts`.
4. Move `engineRootFromEnv`, `migrateLegacyEngineRoot` and `acquireDaemonLock` into `platform/`, then delete `state.ts`.

`detachAssignments` stays: it is the "Continue myself" action for step 6.

### Headless

Done: remote (pairing, devices, settings), the access gate, `sessions/live` projects, `fs`, mobile push routes, the push worker and notification decider, the other-Macs book, the MCP OAuth callback, and `about`. Cockpit features call the engine through typed clients.

Left, in order:
1. Move forwarding to other Macs into the engine, then delete `browse` and `desktop/metrics` (the preload covers them).
2. One `/api/engine/[...path]` catch-all and a Transport. Delete the 155 per-route files.
3. Make the cockpit static-ready, build it statically, and serve it over `telar://`.
4. Remove `telar-ui`.
5. Add the network listener with Tailscale, and move iOS to `/v2` behind `ping.proto`.

Security invariants to preserve: the engine token never reaches a browser or phone; only ping and pair are open; observers are GET-only; the pairing code is 8 digits, 5 min, 5 tries, fragment-only; hashes at rest with constant-time comparison; no CORS; Host-header checks on the network listener; login grants stay written by the shell.

## Decisions taken

- Comment policy: "default none", not an absolute ban.
- Source-reading tests: keep 14, rewrite 32, delete 6.
- The JSON journal backend is removed; the legacy import stays so old homes still migrate.
- GET /report-window became /held-reports and answers only `{held}`. The `run_*` aliases and `runId` are removed on or after 2026-10-09 (deprecated 2026-09-25).
