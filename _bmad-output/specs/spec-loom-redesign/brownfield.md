# Brownfield — As-Built vs. The Redesign

Companion to `SPEC.md`. Verified against the codebase 2026-07-24. Looms already run in production; this redesign restructures them. What exists is listed so downstream reuses it instead of rebuilding it, and so the redesign's edges are honest about what they replace.

## Today's loom lifecycle

`WorkUnitState` (`packages/core/src/schemas.ts`):

```
queued → scoping → charter-review → preparing → running → verifying → ready → done
              ↘ needs-review   ↘ blocked   ↘ halted / failed
```

`ready → done` is human-only and enforced twice — by construction in `looms.ts` (`"done" is reachable solely through a human`, land-first-then-decide) and at the tool layer in `apps/web/app/api/chat/route.ts`, whose `PreToolUse` hook force-routes loom-affecting calls through an interactive permission card in every SDK permission mode.

**The moat is verified intact:** the in-process loom MCP server (`apps/web/lib/loom-mcp.ts`) exposes `draft_bundle_file · propose_contract · read_bundle · list_looms · get_loom · start_loom · steer_loom · reject_loom · answer_loom · answer_blocked · resume_loom · cancel_loom · watch_loom`. There is no `accept` tool. There never is one.

### Mapping onto the three acts

| Today | Redesign |
|---|---|
| `scoping` — one agent drafts charter + spec, infers too much | **Act 1**: a decision graph of real sessions, staffed by specialist seats, nodes spawned only on map drift (CAP-2, CAP-3, CAP-7) |
| `charter-review` | the **readiness gate** — Accept / Modify on the go / Deny → straight to dev (CAP-5) |
| `preparing` — a **no-op pass-through**; the `runSetup` hook in `weave.ts` is flag-off in production | the **verification-readiness node**: lab standup, probe, recipe emission, fail-closed (CAP-4) |
| `running` — pre-written thread templates | **flow compile**: thread-authored, schema-validated DAG with per-node context manifests; the templates survive as the low-confidence fallback (CAP-9) |
| `verifying` | **two altitudes** — thread-altitude always-on, loom-altitude lab under the per-repo mutex (CAP-13) |
| `ready` → `done` | **delivery card → accept → landing queue** (CAP-17, CAP-18); rejection becomes a **boomerang**, not a bin (CAP-19) |

The three acts **absorb** this lifecycle rather than running beside it. (Recorded as an assumption in the kernel.)

## Reuse, never rebuild

- **Deterministic control spine.** `tick.ts` (`tick`, `readySubGoals`, `validateDecision`), `weave.ts` (`rollupWeave`, repair continuation), `gates.ts`, `repair-guard.ts` — pure functions over integers, sets and injected clocks. The design law holds: deterministic control flow in code, intelligence in the leaves. Flow compile must not break it — the compiled DAG is *data*, executed deterministically.
- **Capability-walled verifier stack.** `verifier.ts`, `verify-thread.ts`, `critic.ts`, `panel.ts` hold no write or edit tools. Wall #1 already exists by construction; the redesign extends it to the loom-altitude lab agents, never relaxes it.
- **Lane and supervisor.** `run-server.ts` (`startProjectServer`, `startLane`, `killTree`, `findFreePort`) and `supervisor.ts` (process-liveness loop, crash-loop breaker) are the substrate for CAP-11/CAP-12 — but today they are reachable **only from privileged verify/setup code**. Unbundling them for agent-tool use is the work.
- **Runner lease.** `runner/lease.ts` — `{pid, token, ts}`, atomic temp+rename write, heartbeat, stale-reclaim, "a stale lease can at worst produce a false-positive failed, never an auto-done." This is the shape CAP-11's per-owner service-lease registry generalizes. Natural home: `TELAR_HOME/projects/<id>/looms/<loom-id>/services/<name>.json`, under the canonical per-loom root ruled in `map-and-storage.md`.
- **Worktree machinery.** `vcs.ts` already has `addWorktree`, `removeWorktree`, `withWorktreeLock`, `snapshotWorktreeToBranch`, `createConsolidationBranch`, `foldThreadIntoBranch`, `reapOrphanWorktrees`. CAP-10's branch-per-loom / worktree-per-loom doctrine builds on this, not next to it.
- **Servers config.** `ServersConfig` / `ServiceConfig` in `schemas.ts` is the narrower ancestor of the recipe's `services[]`. The recipe map region **compiles to** it (see `recipe-schema.md`).
- **Multi-account auth.** `accounts.ts` / `login.ts` / `engine.ts` `accountEnv()` already support per-account provider isolation — this is what makes CAP-14's "resume under a different account or provider" reachable.
- **Status vocabulary.** `apps/web/components/looms/status.tsx` (`Tone = done | attention | danger | active | muted`, `statusVisual()`, `StatusBadge`). Every new surface reuses it; hue stays a quiet state signal, never a highlighter.
- **SSE plumbing.** Hand-rolled `event:`/`data:` frames; `GET /api/looms/[id]/events` already tails a loom. New cockpit surfaces extend this pattern rather than introducing `useChat` or an `EventSource` polyfill.

## Known gaps the redesign must close

- **`preparing` is dead weight.** The `runSetup` hook exists in `weave.ts` but is absent (flag-off) in production, so `preparing → running` is a pass-through. Only the reactive repair-time `mediateThread` path runs `runSetupAgent`. This is the readiness node's slot.
- **No agent-facing service surface.** Nothing lets an agent declare a service; the lane stack is unreachable from tools. `ensure_service` does not exist.
- **No per-chat-session directory under `TELAR_HOME`.** Session-owned processes have nowhere to lease from — the "one primitive, two lifetimes" claim needs this gap closed.
- **No living map, no ledger, no MapStore.** Nothing on disk today corresponds to CAP-3, CAP-21 or CAP-22.
- **No progress-liveness layer.** `supervisor.ts` watches processes; nothing watches advancement, so a silent stall with green processes is currently invisible.
- **Production UI is the old shape.** `components/looms/god-view.tsx` (~70KB) and `godview.ts` (~49KB) are today's loom detail; `session-view.tsx` is the ~151KB session monolith the `Conversation` shell carves out of. The six redesigned surfaces exist only as demo-gallery prototypes.
- **Ordering.** Landing today folds threads into a consolidation branch (`vcs.ts`); there is no fleet-level serial landing queue with release-grade re-verification.

## Boundaries that bind the work

From `project-context.md` (adopted companion) — these are not re-decidable here:

- `@telar/core` is server-side only; client components import types only. Runtime core code lives in Route Handlers, Server Components and `instrumentation.ts`.
- All server surface is `app/api/**/route.ts` — no `pages/api`, no Server Actions, no `middleware.ts`.
- `TELAR_HOME` is the entire state root; all engine state is filesystem-backed with **atomic writes only** (`.tmp` → `renameSync`).
- No global client-state library; UI prefs in `lib/ui-prefs.ts` never write engine state.
- Next 16 canary — read `node_modules/next/dist/docs/` before writing framework code.
- `bun test` is the only test tooling; no CI exists, so `bun test`, `bun run lint` and `bunx tsc --noEmit` run manually before committing.
