# Phase 2 — Out-of-process `telar-runner` — Implementation Plan

**Status:** Plan for review · not yet implemented. Builds on `docs/runtime-architecture.md §A` and Phase 1 (background sessions, shipped).
**Problem it closes:** loom and session runs are detached but still **in-process** — a full `bun dev` restart/hot-reload loses the in-process promises + `globalThis` registries, and loom build agents starve the web event loop (#36).

---

## Decisions (recommended defaults — override before building)

- **Standalone process, not a web-spawned worker.** A `worker_threads`/`child_process` worker shares the web server's lifecycle (dies on hot-reload) — the exact bug we're fixing. The runner is a separate long-lived OS process in a new workspace package **`packages/runner`** (`@telar/runner`, `bin: telar-runner`), run under Bun, importing `@telar/core` and reusing its disk persistence verbatim.
- **Lazy-spawn + single-instance.** First dispatch → web calls `ensureRunner()`: read `~/.telar/runner.json` (`{pid,port,token}`, 0600), health-check `GET /health`; if dead, `spawn(detached).unref()` and poll. An `O_EXCL` `~/.telar/runner.lock` (same primitive `startLoomFromBundle` already uses) keeps it single-instance. **[OPEN: lifecycle — idle self-exit vs explicit `bun runner` vs stay-until-killed. This is the one call that needs the human.]**
- **Loopback HTTP control channel.** Runner binds `127.0.0.1:<ephemeral>`; web POSTs `/dispatch/loom`, `/stop/loom`, (2b) `/dispatch/session`, `/stop/session`, `/permission-decision`, presenting the token. **The READ path does NOT move** — `GET /api/looms/[id]/events` and `GET /api/chat/[sessionId]/events` keep tailing `events.ndjson`/`loom.json`/`live.ndjson` off disk, unchanged. Only dispatch/stop/permission-decision cross the wire.
- **Env parity:** the spawned runner must inherit `TELAR_HOME` and any `CLAUDE_CONFIG_DIR`, so `getProject`/`accountEnv` resolve identically.
- **Build-agnostic resolution:** `ensureRunner()` must not hardcode the dev source path — resolve the runner through one seam that works under `bun dev` today AND a bundled/static build later (see "Packaging & static build").

---

## Stage 2a — Looms out of process (recommended first PR)

Looms are already detached + disk-backed, so 2a = "run `dispatcher.ts` in the runner + thin web proxies + boot recovery." `dispatcher.ts`/`executor.ts` stay behavior-identical — they just run runner-side; the module-global `active` map becomes the runner's process map.

**New:**
- `packages/runner/` — `src/main.ts` (lock, HTTP server, write `runner.json`, boot recovery, SIGTERM/idle handlers), `src/control.ts` (`/health`, `/active`, `/dispatch/loom`, `/stop/loom`), `src/recover.ts`.
- `apps/web/lib/runner-client.ts` — `ensureRunner()` + typed verbs (`dispatchLoom`, `stopLoom`, `getActive`, and the re-dispatch verbs).

**Rewire (proxy to the runner):**
1. `api/looms/route.ts` — `POST` `startLoom(...)` → `runnerClient.dispatchLoom(input)` (runner builds `{accounts,policy}` itself; returns the created `Loom`). `GET`'s `active: activeLoomIds()` → `runnerClient.getActive()` (fallback `[]`).
2. `api/looms/[id]/cancel/route.ts` — `cancelLoom` → `runnerClient.stopLoom(id)` (runner handles both the live-abort and paused-disk-halt branches).
3. `api/looms/[id]/{charter/approve,steer,reject}/route.ts` — route through runner verbs so `reDispatch` runs against the runner's `active` map.
4. `apps/web/lib/loom-mcp.ts` `start_loom` tool — `startLoomFromBundle(...)` → `runnerClient.dispatchLoomFromBundle(...)` (else that loom would run in the web loop, re-introducing #36). The human-approval moat is unaffected (it fired at the permission card before this tool ran).

**Wins:** survives `bun dev` restart; fixes #36 (build/critic agents + the `MAX_CONCURRENT` gate run in the runner, not the web loop); closes the orphan gap.

**Verify:** dispatch a loom → god-view unchanged; **restart `bun dev` mid-run → loom keeps advancing**; kill the runner mid-run → boot recovery forces `running`→`halted`; god-view no longer starves under a busy build.

---

## Boot recovery (runner start — `recover.ts`)

Reconcile each non-`draft` loom by state:
- `queued` → **auto-resume** (re-dispatch; zero side effects).
- `scoping` → **auto-resume** as `queued` (scoping is an agent call, no repo side effects).
- `running` / `verifying` → **force `halted`**, `error="interrupted by runner restart"`, append a `halted` event (possible live side effects; human/agent resumes via steer/reject). Matches `docs/loom-orchestrator.md §11`.
- `charter-review` / `ready` / `blocked` / `needs-review` → **leave as-is** (awaiting a human; resume on demand).
- `done` / `failed` / `skipped` / `halted` → **skip** (terminal).
- Woven roots/children: same per-state rule.
- Sessions (2b): a turn can't be safely resumed (SDK subprocess gone) — append a synthetic `closed`/`error("interrupted")` to any `live.ndjson` lacking a trailing `closed`, so the reconnect tail terminates cleanly instead of spinning.

---

## Stage 2b — Sessions out of process (harder; ship after 2a)

The turn loop in `apps/web/app/api/chat/route.ts` (the `ReadableStream.start()` closure) moves to the runner. Two risk sources:

1. **Lib relocation (do as its own behavior-preserving PR first).** The loop imports web-only libs the runner can't reach: `store.ts`, `titles.ts`, `transcript.ts`, `loom-mcp.ts`, `permissions.ts`, `session-log.ts`, `models.ts`, `codex-app-server.ts`. Relocate the turn-execution ones into a shared package (`@telar/core` or a new `@telar/session`); `session-log.ts`/`permissions.ts` are pure `fs`+logic and move cleanly; `loom-mcp.ts` already imports core. The web keeps only the thin API routes + React.
2. **Permission cross-process round-trip (the crux, riskiest correctness/security piece).** The permission *request* is already an SSE/`live.ndjson` event → browser renders the card unchanged. The *decision* posts to `POST /api/chat/permission`, which becomes a thin proxy → runner's `/permission-decision`; the runner validates (`isOfferedRule` against its own `pendingRuleOptions`) and `resolvePending`s on its **local** pending map. The pending `Map` + `createPending`/`resolvePending` move to the runner; `readRules`/`addRule` stay disk-backed.

**Then:**
- `POST /api/chat/route.ts` → keep the up-front 400 validations, then `runnerClient.dispatchSession(...)` and return an SSE `Response` that **proxies the runner's `GET /session/:runId/events`** (full token fidelity, no vocabulary duplication). Delete the heavy closure from the route.
- `GET /api/chat/[sessionId]/events` (reconnect) — **unchanged** (pure-disk tail). Back `isSessionRunLive` with a disk liveness marker the runner writes on turn start / clears on `closed`.
- `POST /api/chat/stop` → `runnerClient.stopSession(key)`.
- Codex path (`runCodexTurn`, `codex-app-server.ts` child spawn) moves with the loop; reuses the same pending map + `/permission-decision`.

**Invariants preserved:** SDK `resume: sessionId`, `canUseTool` + the `PreToolUse` guardrail + the `start_loom` `ask` hard-route + agent-spawn `mode`/`isolation` stripping all move verbatim; the human-approval moat still fires as a permission card.

**Verify:** message → tokens stream via the proxy; **hot-reload web mid-turn → reconnect shows the turn still running in the runner**; a permission card round-trips and unblocks; Stop aborts; runner restart marks the turn interrupted cleanly.

---

## Packaging & static build

Telar runs on `bun dev` today but will eventually be bundled into a static/standalone build (self-hosted, even if just for one user). The runner must be **build-agnostic** from the start:

- **Runner resolution — one seam, two backings.** `ensureRunner()` must not hardcode `bun <packages/runner/src/main.ts>`. Order: (1) if `TELAR_RUNNER_URL` is set, **connect-only** (don't spawn — production points at a supervised runner); (2) else if `TELAR_RUNNER_BIN` is set, spawn that (the bundled artifact); (3) else fall back to the dev source under `bun`. The build produces the runner artifact — e.g. `bun build --compile` a single-file `telar-runner` executable alongside the Next standalone output — and the packaged app sets `TELAR_RUNNER_BIN`/`TELAR_RUNNER_URL`.
- **`@telar/core` is raw `.ts` today** (fine under bun's loader); a static build must bundle/compile core into both the web output and the runner. Keep the runner importing `@telar/core` by workspace so `bun build --compile` inlines it.
- **Lifecycle becomes env-configurable, not baked to dev.** Dev: lazy-spawn (zero-config). Production/bundled: run the runner as a supervised long-lived process (service/process-manager) and set `TELAR_RUNNER_URL` so the web app connects instead of spawning. So the "lingers after Ctrl-C" worry is **dev-only**; the static build gets a proper daemon.

This reframes the lifecycle open-decision below: it's only about the *dev* default, since production is a supervised service pointed at by `TELAR_RUNNER_URL`.

## Open decisions for the human

1. **Runner lifecycle — DEV ONLY** (production is a supervised service via `TELAR_RUNNER_URL`, see "Packaging & static build"): for `bun dev`, lazy-spawn + idle self-exit (zero-config, but lingers briefly after Ctrl-C) · explicit `bun runner` beside `bun dev` (clean, two commands) · lazy-spawn stay-until-killed. Default recommendation: lazy-spawn + idle self-exit.
2. Control-channel: ephemeral port + shared token in `runner.json` (0600), `127.0.0.1`-bound — confirm the token requirement.
3. 2b POST fidelity: proxy the runner SSE (recommended) vs tail `live.ndjson` with deltas on disk.
4. Env parity: confirm the spawn inherits the web server's `TELAR_HOME`/`CLAUDE_CONFIG_DIR`.
5. Single-runner (`O_EXCL` lock) vs per-project runners.

## Recommended first PR
**Runner foundation + looms out-of-process (all of Stage 2a).** Stand up `packages/runner` (bin, lock, health file, loopback control server, boot recovery) + `apps/web/lib/runner-client.ts` + rewire the ~6 loom touch-points. `dispatcher.ts`/`executor.ts` unchanged. Optionally split into 2a-i (skeleton + `POST /api/looms` + cancel + recovery) and 2a-ii (re-dispatch verbs + `start_loom` proxy).
