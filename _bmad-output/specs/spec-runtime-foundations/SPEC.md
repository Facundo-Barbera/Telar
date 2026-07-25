---
id: SPEC-runtime-foundations
companions:
  - admission.md
  - brownfield.md
  - ../../project-context.md
  - ../../planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md
sources:
  - ../../planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md
  - ../../planning-artifacts/architecture/architecture-telar-2026-07-24/WORK-SPLIT.md
  - ../../planning-artifacts/architecture/architecture-telar-2026-07-24/SOLUTION-DESIGN.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Runtime Foundations — the shared substrate under three features

## Why

Three feature SPECs — `SPEC-loom-redesign`, `SPEC-organization-workspace`, `SPEC-ultra-workflows` — all land on one process, one state root, and one session surface. Each is internally coherent; none owns the machinery all three depend on. The 2026-07-24 architecture spine identified that overlap and fixed the invariants (AD-14 through AD-21); this SPEC is the **work** those invariants imply, gathered where it actually belongs instead of misattributed to whichever feature happens to touch it first.

It is deliberately unglamorous and deliberately first. Nothing here is a user-visible capability. Everything here is something two features would otherwise build twice, differently — or, in the case of the concurrency ceiling, a defect that only becomes visible when you hold all three specs at once.

Two findings drove it, both from reading the code rather than the specs:

- **The concurrency ceiling is a fiction.** `engine.ts` holds a module-private `MAX_CONCURRENT = 4` while a loom Charter promises `budget.maxAgents: 12` and Ultra stacks its own cap of 3 on top. The charter's number is unreachable, the real ceiling is invisible, the gate knows nothing about *who* is asking — so a build fan-out can starve verification, which is the loom system's own diagnosed failure reproduced by the scheduler — and the gate can drift above its own ceiling. See `admission.md`.
- **The spend ledger already exists.** `~/.telar/usage.ndjson` (`logUsage()` / `UsageEntry` in `apps/web/lib/store.ts`) is an append-only attributed ledger. Any new spend file would be a fourth counter competing with three. Worse, `store.ts` alone hardcodes `~/.telar` while every other module honors `TELAR_HOME`, so chat history and usage do not isolate in dev.

Ordering matters and is not negotiable: **CAP-1 precedes CAP-2**, because extending the usage ledger while its store ignores `TELAR_HOME` would write dev spend into production state.

## Capabilities

- **CAP-1** `TELAR_HOME` honored everywhere
  - **intent:** Every persisted store resolves its root the same way, so pointing `TELAR_HOME` at a throwaway directory genuinely isolates a dev run.
  - **success:** `apps/web/lib/store.ts` resolves its directory via `process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar")`, matching `manifest.ts`, `looms.ts`, `session-log.ts`, `permissions.ts` and `vcs.ts`. With `TELAR_HOME` set to an empty temp dir, `chats.json`, `usage.ndjson` and `plan-usage.json` are created there and the real `~/.telar` is untouched — asserted by a test, not by inspection. No behavior change when the variable is unset. Governed by AD-18.

- **CAP-2** One attributed spend ledger
  - **intent:** A single append-only record of what every agent call cost, attributed to its owner, with every spend readout in the app derived from it rather than counted independently.
  - **success:** `UsageEntry` carries owner attribution (owner-kind + owner-id) alongside its existing `account`, `model`, `sessionId` and `costUsd`; **no new ledger file is created**. The session's per-turn usage display, Ultra's manifest `spend` and a loom charter's budget-left are all projections over `usage.ndjson`. Readers tolerate records written before the field existed (AD-7) — an un-attributed historical record still counts toward totals and never throws. Cost language (USD on Claude, tokens on Codex) is a property of the projection, not of the record. Governed by AD-18, AD-20.

- **CAP-3** Typed event bus with a required delivery class
  - **intent:** One publish path for "something happened", where every event declares whether it may wake an agent or may only render on a surface the user chooses to visit.
  - **success:** A single in-process bus in `packages/core`; adapters subscribe (SSE tails, the session-wake injector, the dock aggregator). Every event carries a **required** delivery class — `agent-facing` may synthesize an assistant turn, `human-facing` renders only on arrival and never pushes. The class is a field the type system demands, so `SPEC-ultra-workflows` CAP-1's unprompted turn and `SPEC-organization-workspace` CAP-1's "never initiates contact" cannot be resolved inconsistently. A module's published event names and payload shapes are a declared contract; cross-module subscription is permitted only to declared events, and an undeclared event is internal. Governed by AD-14, AD-21.

- **CAP-4** Admission control for `agent()` concurrency
  - **intent:** One visible, configurable ceiling on concurrent model calls, divided into classes so verification is never stuck behind a build fan-out and no slot sits idle while work is queued.
  - **success:** Per `admission.md` in full. Headlines: the ceiling is configurable (`TELAR_MAX_AGENTS`) and defaults to the historical 4, so adopting the controller is not itself a throughput change; classes are `loom-build`, `loom-verify`, `ultra`, `other`; verification holds **precedence, not a held-open slot**; the controller never exceeds its own ceiling even when an arrival races a release; interactive chat sessions stay out of band by design. `fanoutClamp` accepts a `processCeiling` term so a charter cannot report a fan-out the process will not admit. Governed by AD-17.

- **CAP-5** One lease primitive, two lifetimes
  - **intent:** Session-owned and loom-owned processes lease through the same primitive, so there is exactly one implementation of stale-reclaim.
  - **success:** `runner/lease.ts`'s record (`{pid, token, ts}`, atomic temp+rename, heartbeat, stale-reclaim) is generalized to serve both owners. `TELAR_HOME/sessions/<sessionId>/` exists and is owned by the session module, holding session-scoped **runtime** state only — it does not absorb the existing `chats.json` store. Loom-owned leases live under the per-loom root and die at land; session-owned leases die at session close; record shape and reclaim semantics are identical. The invariant holds on both paths: a stale lease can at worst produce a false-positive `failed`, never an auto-`done`. Governed by AD-16, AD-5.

- **CAP-6** Load-bearing invariants are executable
  - **intent:** The rules the project calls non-negotiable are re-checked by something other than memory.
  - **success:** Assertions in `bun test`, running in the existing manual trio (`bun test`, `bun run lint`, `bunx tsc --noEmit`). At minimum: no MCP surface anywhere exposes an accept tool; `verifier.ts` / `verify-thread.ts` / `critic.ts` / `panel.ts` are granted no write or edit tools; no module reads another module's `TELAR_HOME` subtree by path; client components import no `@telar/core` runtime; no module writes a shared runtime service's state directly. Each assertion fails loudly with a message naming the invariant it defends. Governed by AD-19.

## Out of scope

- Tuning the admission ceiling or class weights against a real fleet. The mechanism ships with defaults; numbers are an operational decision, not a cold-start one.
- Wiring `processCeiling` into `tick.ts` and `executor.ts`'s live clamps. The term exists and is tested at CAP-4; passing it changes scheduler output and earns its own story and test sweep.
- Tagging `executor.ts`'s `agent()` call sites with `loom-build`. Safe to defer — untagged calls land in `other`, the lowest-weight class with no precedence — and a mis-tag silently changes scheduling, so it belongs to the executor's own story.
- Adding CI. Declined at spine authoring time; CAP-6's assertions run manually.
- Persisting bus events. AD-14 fixes in-process delivery only; every durable trace today is already a module-owned NDJSON stream.
