---
title: 'vNext engine-owned session cockpit'
type: 'feature'
created: '2026-08-11'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'adc13a1f9405bd47405e83f2df7266453f8465c4'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Telar's current cockpit executes and persists interactive work in the Next process while the surrounding Loom, project, and workspace surfaces are tightly coupled to legacy state. The experimental engine-cutover tree cannot be adopted as a foundation: it is incomplete, has irreversible migration markers, and is incompatible with this branch's session runtime.

**Approach:** Deliver a new, isolated vNext vertical: an engine is the sole owner of project/session/runtime state and an intentionally small web cockpit is only its client. The vertical must make a local project usable through persistent chat: choose a project, create/open a session, stream a turn, stop it, reconnect it, and recover safely after a process restart.

## Boundaries & Constraints

**Always:** Work only in the `feat/vnext-session-cockpit` worktree and use an explicit dedicated vNext dogfood `TELAR_HOME`; retain the human-accept moat and verifier capability wall unchanged; keep all session/project/transcript mutations behind authenticated loopback engine APIs; use atomic document writes and append-only event journals; use stable client turn IDs for idempotency; permit at most one active turn per session; turn a possibly executed turn after engine recovery into an explicit ambiguous/retry-or-discard state, never a success or automatic replay; keep web and desktop as clients, never direct writers.

**Ask First:** Changing normal `~/.telar` or `~/.telar-dev` state, importing or mutating legacy chats/queues, publishing a legacy cutover marker, deleting current production surfaces, changing provider credentials/account records, or expanding the first engine beyond the session vertical.

**Never:** Cherry-pick the dirty session-integration worktree wholesale; reuse its Host ledger, session-projection, Ultra, attachment, permission-migration, or legacy worker layers; make Next execute/claim turns; retain `chats.json` or legacy live-feed state as a vNext writer; port Loom, workspace, Ultra, project-hub, Dock, or `SessionView` behavior into this cockpit; add a remote backend, product auth, global client-state library, or automatic agent acceptance.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Send a turn | Valid project, session, configured active provider, new `runId` | Engine durably accepts and claims one turn; cockpit streams engine events and rebuilds transcript from the journal | Engine unavailable returns typed `engine_unavailable`; no local fallback write |
| Repeated submit/reconnect | Same `runId`, or browser reconnects with a cursor | No duplicate provider execution; stream resumes from missed durable events | Existing active turn is reported, not restarted |
| Stop | Active `runId` or session | Engine forwards cancellation to the worker/driver and writes a terminal interruption event | Unknown/already terminal turn is an idempotent no-op |
| Engine restart | Queue contains claimed or running turn | Claimed work is safely returned to queue; running work becomes visible ambiguous work requiring user resolution | Never invent completion or replay a possibly side-effecting turn |
| UI restart | Engine remains alive mid-turn | Turn continues; opening the session hydrates prior events and tails new ones | A UI disconnect never cancels the turn |
| Invalid input/config | Unsafe identifier, missing project, unavailable worker, missing provider capability | Engine rejects before execution with a typed error | No partial session mutation beyond an auditable rejection where applicable |

</frozen-after-approval>

## Code Map

- `apps/engine/` -- new vNext daemon, exclusive state-root ownership, loopback API, worker protocol, and recovery.
- `packages/engine-client/` -- small typed discovery/authenticated client used by web and desktop.
- `packages/core/src/sessions.ts`, `session-queue.ts`, `runner/lease.ts` -- bounded reuse candidates for path safety, durable queue semantics, and leases.
- `apps/web/app/api/chat/**`, `apps/web/lib/server/session-engine.ts`, `apps/web/instrumentation.ts` -- legacy in-process execution seams to replace with adapters only.
- `apps/web/components/conversation/`, `apps/web/lib/sse.ts`, `components/ui/**` -- presentation and SSE parsing candidates only.
- `apps/desktop/engine-supervisor.js`, `execution-worker-supervisor.js` -- attach-or-spawn ownership patterns to re-test and adapt.

## Tasks & Acceptance

**Execution:**
- [x] `apps/engine/**`, `packages/engine-client/**` -- introduce a fresh, minimal engine/client protocol: authenticated discovery and health, exclusive daemon lock, project/session metadata, durable turn queue and append-only event feed, turn proxy/worker registration, stop, and conservative startup reconciliation.
- [x] `packages/core/src/{sessions.ts,session-queue.ts,runner/lease.ts}` and tests -- extract or reuse only the validated vNext-neutral pieces; add tests proving path safety, idempotency, one-active-turn ordering, and non-success crash recovery.
- [x] `apps/web/app/vnext/**`, `apps/web/app/api/vnext/**`, `apps/web/components/vnext/**` -- build a standalone minimal cockpit: project list, session list/create/open, transcript hydration/tail, plain composer, and stop/retry-or-discard controls. Use engine APIs exclusively.
- [x] `apps/web/app/api/chat/**`, `apps/web/lib/server/session-engine.ts`, `apps/web/instrumentation.ts` -- remove these from the vNext execution path without deleting legacy surfaces; add source-boundary tests proving no vNext Next handler claims or executes work.
- [x] `apps/desktop/**`, `scripts/**`, `README.md` -- start or attach engine and worker in vNext dev/desktop flows; only owned processes are stopped; document the dedicated dogfood root and supported door.
- [x] engine, web, and desktop tests -- cover the matrix, including daemon/UI restart, worker unavailable, authenticated health/discovery, and no direct client state writes.

**Acceptance Criteria:**
- Given the dedicated vNext dogfood root, when the supported vNext development command starts, then one engine and one worker are discoverable and the cockpit is usable without touching existing Telar state.
- Given a registered project, when a user creates a session and sends a turn, then the engine—not Next—owns execution and the complete streamed transcript survives a browser restart.
- Given an engine restart while a turn is running, when the engine comes back, then the session exposes an ambiguous recovery decision and no provider call is silently repeated.
- Given a stop from the cockpit, when the turn is active, then the engine reaches the worker/driver and durable terminal state reflects interruption.
- Given all existing legacy views remain mounted, when vNext is used, then no Loom/workspace/Ultra route or `chats.json` writer participates in a vNext turn.

## Design Notes

The first engine is a new small contract, not a cleanup of the integration prototype. Its state is namespaced beneath `TELAR_HOME/vnext/` (`engine.json`, lock, projects, sessions, per-session queue and event journal), so it has no state-format or marker dependency on legacy Telar. The worker is an engine-registered executor: it may run providers but never owns session state. The browser may replay/tail events but cannot settle a turn.

Provider/account configuration is read through existing audited account/provider ports; first implementation must preserve the configured interactive runtime capability needed for an actual turn rather than pretend unsupported providers work. Add another provider only through the new driver port and a dedicated contract test.

## Verification

**Commands:**
- `bun run --cwd apps/engine test` -- expected: engine state, protocol, recovery, and proxy tests pass.
- `bun run --cwd packages/engine-client test` -- expected: discovery and typed client boundary tests pass.
- `bun run --cwd apps/web test && bun run --cwd apps/web typecheck && bun run --cwd apps/web lint` -- expected: vNext cockpit and boundary tests pass with no new lint findings.
- `bun run --cwd apps/desktop test:desktop:unit` -- expected: owned-versus-attached companion lifecycle tests pass.
- `TELAR_HOME=$HOME/.telar-vnext-dogfood <supported-vnext-command>` -- expected: manually prove one persistent streamed turn, UI reconnect, stop, and conservative engine-restart recovery.

## Suggested Review Order

**Engine ownership and recovery**

- Authenticated loopback daemon centralizes all stateful commands and worker leases.
  [`daemon.ts:142`](../../apps/engine/src/daemon.ts#L142)

- Durable queue transitions preserve idempotency, one active turn, and explicit recovery outcomes.
  [`state.ts:390`](../../apps/engine/src/state.ts#L390)

- Startup reconciles uncertain work conservatively and repairs interrupted Claude continuity metadata.
  [`state.ts:555`](../../apps/engine/src/state.ts#L555)

- A completed queue record safely backfills a missing persisted provider session before claiming.
  [`state.ts:700`](../../apps/engine/src/state.ts#L700)

**Provider execution and reconnects**

- Worker observes cancellation and returns every execution observation to the engine.
  [`worker.ts:31`](../../apps/engine/src/worker.ts#L31)

- Supervisor retries the narrow registration-time daemon-loss race without publishing a stale worker.
  [`worker-supervisor.ts:48`](../../apps/engine/src/worker-supervisor.ts#L48)

- Claude bridge resumes persisted sessions and forwards partial text deltas without duplication.
  [`driver.ts:46`](../../apps/engine/src/driver.ts#L46)

**Client boundary and cockpit**

- Typed client discovers only vNext loopback state and attaches its bearer capability per request.
  [`index.ts:40`](../../packages/engine-client/src/index.ts#L40)

- Thin server adapter validates the browser command before forwarding it to the engine.
  [`route.ts:13`](../../apps/web/app/api/vnext/sessions/[sessionId]/turns/route.ts#L13)

- Cockpit serializes snapshot/tail reconciliation, exposes stop, and requires explicit ambiguous-turn resolution.
  [`session-cockpit.tsx:43`](../../apps/web/components/vnext/session-cockpit.tsx#L43)

**Supported local door and proof**

- Launcher isolates the vNext environment, supervises owned processes, and never starts legacy recovery.
  [`vnext-dev.mjs:39`](../../scripts/vnext-dev.mjs#L39)

- Regression tests cover crash recovery, reconnect races, streaming, and source-boundary isolation.
  [`state.test.ts:84`](../../apps/engine/test/state.test.ts#L84)

- The README defines the browser and desktop dogfood commands and their ownership rules.
  [`README.md:49`](../../README.md#L49)
