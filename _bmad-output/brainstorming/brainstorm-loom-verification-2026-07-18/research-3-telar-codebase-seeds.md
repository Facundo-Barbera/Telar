# Research 3 — Telar Codebase: Process/Service Seeds Inventory

> Scout report, 2026-07-18. Feeds the loom-verification brainstorm. All refs are file:line into the repo at time of survey.

## TL;DR

Telar already has a **surprisingly complete, unwired-at-the-edges service-supervision stack** in `packages/core/src` (`run-server.ts` + `supervisor.ts` + `verify-lane.ts` + `servers.ts` + `ServersConfig` in `schemas.ts`): ports, readiness, health checks, restart policy, crash-loop breaking, log tails. But it is built **exclusively for the verify path** and **never reachable from an agent session's tools**. The verification-readiness seed exists split in two (`requirements.ts` read-half + `setup/setup-agent.ts` write-half) but the proactive `preparing`-phase hook is **dead in production** (only the reactive repair-time path runs). Desktop (`apps/desktop/main.js`) reimplements port-pick/poll-ready independently. **No agent anywhere can declare "start this and keep it running, I own it."**

## What exists (the mature parts)

### The lane primitive — `run-server.ts`
- `startProjectServer()` (142-196): free port → spawn devCommand with `PORT` injected → poll until ready → `{url, port, stop}`.
- `startLane()` (515-632): multi-service — topological `dependsOn` ordering, templated env (`{port}`, `{peer.port}`, `{peer.url}`), three `portInject` variants (env/arg/file), per-service `readyCheck`, restart seam (`isAlive()`/`restart()`/`logTail()`) re-spawning on the same port.
- `killTree()` (93-134): detached spawn → SIGTERM-then-SIGKILL the whole process group.
- `findFreePort()` (40-51): OS-assigned via `listen(0)`.

### The supervisor — `supervisor.ts`
- Continuous liveness+health loop per service (5s default). **Cardinal rule: restart only on process death, never on unhealth** (16-19).
- Crash-loop breaker: `maxRestarts` in sliding `crashLoopWindowMs` (3/60s default) → `"crash-looped"` + `onEscalate`.
- `verify-lane.ts superviseStartLane()` composes both into a `Lane`; documented as the EXECUTOR/SETUP-wall capability the judge never touches.

### The verifier stack is a pure URL consumer
- `verifier.ts` / `critic.ts` take `opts.url`, pass to Playwright MCP; zero notion of ports/servers. Tool wall: no Write/Edit/Bash/Agent.
- URL assembled upstream: `runVerification()` (executor.ts:897-956, legacy single-server) and `frozenLaneVerify()` (verify-thread.ts:147-272, lane path via `resolveServersConfig` + `chooseVerificationStrategy`), with an explicit `noTarget: true` fail-closed floor.
- `verification-strategy.ts`: strategies = `server-lane` / `test-gate` / `cli-harness` / `sandbox-eval` / `artifact-assert` — only `server-lane` stands up processes.

### The verification-readiness seed (split in two)
- **Read-half** — `requirements.ts detectRequirements()`: bounded read-only sweep at scoping; classifies needs into `human-only` (secrets) / `maybe-resolvable` (ports/servers/DBs) / `greenfield-unknown`. MOAT comment: detection is a FACT, asking is an OFFER; missing requirement blocks only the verify step.
- **Write-half** — `setup-agent.ts runSetupAgent()`: scoped agent (Read/Grep/Glob/Write/Bash, no Agent/Edit) whose ONE job is to author `servers.yaml`, then validate via `startLane` with bounded repair (max 3), teardown in `finally` ("Ownership = validate-and-teardown (D8)"). Explicitly forbidden from starting long-lived servers itself.
- **Wiring**: the proactive `preparing`-phase `runSetup` hook (weave.ts:194-212 — "before the first build child spawns") is **flag-off in production** (dispatcher.ts:592-598 documents it). Only the **reactive** path runs: `mediateThread` (dispatcher.ts:513-526) calls `runSetupAgent` best-effort at repair time.
- Pre-flight predicate: `isLaneViable()` (executor.ts:559-577) consulted before any spend; failure → `parkBlockedIfLaneUnviable()` → `blocked` with shape-aware human question (`deliverable-signal.ts:268-296`).
- Human close-of-loop: `answerBlocked()` (dispatcher.ts:823-916) persists answers to the right tier (`.telar/servers.yaml` accepted vs committable `telar.yaml`); escalation chat enumerates the four substrates a human can supply, incl. "a SERVERS recipe — a background-process setup".
- Adjacent genre: `doctor.ts` = machine-readiness (binaries, auth, Playwright cache); `build-desktop.sh --smoke` = packaging-time readiness.

### Ownership patterns to generalize
- **Runner lease** (`runner/lease.ts`): `~/.telar/looms/<id>/.runner-lease` = `{pid, token, ts}`, heartbeated, `isLeaseFresh(ttl)` oracle, stale-pid reclaim (`runner-json.ts` lock + reclaim). **Exactly the shape a per-owner service registry wants.**
- `~/.telar/looms/<id>/` per-loom dir with traversal-guarded IDs; `atomicWrite` idiom; two-tier config precedence (`.telar/servers.yaml` accepted → `servers.yaml` committable → none).
- Per-owner service state would naturally live at `~/.telar/looms/<id>/services/<name>.json`; **no per-chat-session directory exists at all** (chat state in web's `chats.json`, which ignores TELAR_HOME — documented divergence bug).

### Loom lifecycle slots
- `queued → scoping → charter-review → preparing → running → verifying → ready → done`; `blocked` non-terminal park.
- **`preparing` is the natural readiness/lab-standup slot** — designed for it, currently a no-op pass-through.
- Root ALL-verify runs after rollup reaches `ready`: `frozenLaneVerify` inside `runAutoRepair`'s bounded loop; escalation demotes `ready → needs-review`; only human `acceptLoom` reaches `done`.

## Master gap list

1. **No agent-facing tool to start/own a background process anywhere** — a builder's `bun run dev &` is an untracked orphan; chat MCP tools have no `start_service`/`run_background`.
2. **Proactive readiness phase dead in production** — `weave.ts runSetup` exists but unwired; only reactive repair-time mediation runs.
3. **Two unreconciled spawn/port/readiness implementations** — `run-server.ts` vs `apps/desktop/main.js` bespoke fork+poll.
4. **No persisted ownership/lease for lane- or setup-spawned processes** — only the runner daemon has leases, and for a different concern (loom execution, not services). Lane handles are in-memory closures for one call.
5. **No per-chat-session state dir under TELAR_HOME**; web `store.ts` hardcodes `~/.telar`.
6. **Secrets excluded from mediation-rung auto-repair** — no mid-repair escalation path for a missing secret (only the charter-review offer).
7. **`localhost` vs `127.0.0.1`** literal inconsistency core vs desktop.
