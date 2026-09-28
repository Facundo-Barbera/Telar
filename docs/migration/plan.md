# Telar codebase migration: plan

Started 2026-09-27. Goal: shrink the codebase and move it to a T3-Code-style shape without changing behaviour.

The shape we're after:
- domains with an interface and an implementation;
- one composition file;
- shared contracts;
- behaviour tests;
- lint guards.

We are not adopting Effect-TS or event sourcing.

- `overview.html`: audit findings, bugs found and the decisions taken.
- `composition.html`: an interactive map of the repo (lines, comment share, largest files) and the target composition.

## Rules for every PR

- Behaviour-preserving, small, green on its own, never stacked.
- Leave every touched file smaller than you found it.
- Comment policy: see `AGENTS.md`. The default is none; allowed comments are ≤3 lines and state an invariant, never history.
- Size: no new file over 800 lines and no new function over 150. When you touch an oversized file, extract the part you changed.
- Nothing ships in a nightly until the owner has tested it locally.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Safe deletion: dead code, leftovers, fixtures; the `telarWall` tool-list bug fix; sweepers cleared on close | in progress |
| 2 | Safety net: root `AGENTS.md`/`CLAUDE.md`, oxlint + knip on every workspace, comment/size ratchet in CI, rewrite ~290 source-reading tests as behaviour tests (keep 14 files, delete 6) | next |
| 3 | Legacy/compat: move clients to `/plugins/<id>`, drop `/ds`, `/latex`, `/data-science` aliases and PATCH legacy fields; drop localStorage/panel-tab migrations and redirect tables; retire store migrations; journal SQLite-only | |
| 4 | Engine decomposition, one module per PR behind an `EngineStore` facade: `store/*` (~15 modules ≤1.5k), `daemon.ts` → `routes/*` with one router and zod bodies, `driver/` (single `FrameTranslator`), `worker/`, a single `ExecutionStore` sweep | |
| 5 | Web decomposition: `SessionCockpit` → hooks (≤800 lines), `right-panel`, `app-sidebar`, `composer`, `browser-live`, `diff-surface`; `usePoll`, `useListNav`, one `PanelEmpty` | |
| 6 | Sessions as sub-agents: `create` with mode child/handoff, the result is the last message, one notice per child, 21 → 10 tools | |
| 7 | One engine client: an `EngineClient` Transport, one `/api/engine/[...path]` catch-all, delete the pass-through routes | |
| 8 | Comment strip, one package per PR, following the policy | alongside 4–5 |
| 9 | Headless: the engine owns all functionality (pairing/auth, push, hosts, dictation, OAuth…); the cockpit becomes a static SPA; `telar-ui` is removed (#904). Absorbs phase 7 | inventory in progress |

## Phase 9, headless (from the 27 Sep inventory)

128 of the 155 `/api` routes are pure proxies. The real logic outside the engine:
- the access gate `proxy.ts` (roles, host secret);
- pairing, devices and remote settings (`remote.json`);
- the push worker started from `instrumentation.ts` (relay/APNs, read-sync);
- the Mac notification decider (IPC with main);
- other Macs (`hosts.json`, forwarding);
- `sessions/live` merging projects;
- `fs`;
- the MCP OAuth callback;
- `about`;
- `browse` and `desktop/metrics`, which the preload already covers.

The pages are already client-only, so a static SPA is viable.

Target:
- The engine owns all the logic plus `store/remote` and `routes/auth`. Loopback listener: management token. Optional network listener: device tokens, serves the SPA, and aliases `/api/*` for current iOS builds.
- Desktop serves the SPA over `telar://` and its protocol handler injects the bearer. `telar-ui` goes away.
- One `EngineClient` with a Transport everywhere.

PRs (~17), each landing as `store/*`/`routes/*`:
1. remote (pair, devices, ping)
2. auth
3. `sessions/live` projects
4. `fs`
5. mobile push routes
6. push worker into the engine (swapped in one PR)
7. notification decider
8. hosts
9. OAuth callback
10. `about`; delete `browse`/`metrics`
11. catch-all + Transport (old phase 7)
12. cockpit static-ready
13. static build
14. `telar://`
15. remove `telar-ui`
16. network listener + Tailscale
17. iOS on `/v2` behind `ping.proto`

Security invariants to preserve (10+): the engine token never reaches a browser or phone; only ping and pair are open; observers are GET-only; the pairing code is 8 digits, 5 min, 5 tries, fragment-only; hashes at rest with constant-time comparison; no CORS; Host-header checks on the network listener; login grants stay written by the shell.

## Phase 4, engine (design: docs/migration/engine-decomposition.md)

~65 PRs, in this order:
1. prep
2. kernel
3. ~26 modules bottom-up behind an `EngineStore` facade, plus the `turnEnded` hook
4. remove the facade (codemod)
5. daemon → router + `routes/*` (~14)
6. driver/worker/execution-store/capabilities (~15); the driver goes last

Precondition: JSON removal has landed.

Decision: `detachAssignments` stays. It is the "Continue myself" action for phase 6 (sessions as sub-agents).

## Decisions taken

- Comment policy: "default none" (not an absolute ban).
- Source-reading tests: keep 14, rewrite 32, delete 6.
- The JSON journal backend is removed; the legacy import stays so old homes still migrate.
- docs/ is emptied except this folder. Untracked drafts were archived outside the repo.

## Order from 27 Sep (evening)

Documentation first: AGENTS.md (glossary + domains), README, docs/internals, docs/user, docs/operations. Rewrites resume only after every agent has it. Target layout: `docs/migration/blueprint.html`.

## Log

- 2026-09-27: audit done. Phase 1 started (web, engine, iOS+desktop).
- 2026-09-27: phase 2 started (docs + AGENTS.md + guards; behaviour tests for web).
- #1086 (web test hygiene: order-dependent leak fixed, tail-cadence 23s → 1s, 6 source tests deleted; −221 LOC).
- #1087 (`telarWall`: one tool list; 3 bugs fixed, namely Claude without `prompt_*`, Codex/OpenCode without `display_*`, and sessions tools duplicated; −932 LOC).
- #1084 (iOS: `InboxView` deleted, −334) and #1085 (desktop: `jsonPrefs`, −45; `shadcn` moved to devDependencies).
- #1089 (web dead code: 6 modules, unused shadcn sidebar parts, `/api/sessions/stream`, dead CSS tokens, knip exports; −1347) and #1091 (fixtures + bench, report-cadence renamed to held-reports, Agent-era comments; −3700). Phase 1 web ✅.
- Phase 3 web started (client migrations, redirects).
- #1090 (engine leftovers: `report_window` cadence, subscribe knobs, one ETag, `stopTimers()` fixing leaked cohort/snooze/schedule timers; −531 net). Phase 1 engine ✅.
- Decision: GET /report-window became /held-reports, answering only `{held}`, because the right panel polls it. No iOS or desktop callers. The `run_*` aliases and `runId` are removed on or after 2026-10-09 (deprecated 2026-09-25).
- Phase 3 engine: the JSON journal backend is removed (SQLite only, legacy import kept).
- Desktop decomposition started (`browser-manager.js` → `browser/*`, `main.js` → `main/*`). Added to phase 4 so desktop also meets "no file over ~1.5k".
- Decision: the orchestrator follows each builder with its own subscription, so each PR merges as soon as it is green. This plan is updated through small PRs at the end of each phase.
