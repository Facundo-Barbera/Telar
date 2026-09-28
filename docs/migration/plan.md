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

## Decisions taken

- Comment policy: "default none" (not an absolute ban).
- Source-reading tests: keep 14, rewrite 32, delete 6.
- The JSON journal backend is removed; the legacy import stays so old homes still migrate.
- docs/ is emptied except this folder. Untracked drafts were archived outside the repo.

## Log

- 2026-09-27: audit done. Phase 1 started (web, engine, iOS+desktop).
