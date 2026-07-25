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

Three feature SPECs — `SPEC-loom-redesign`, `SPEC-organization-workspace`, `SPEC-ultra-workflows` — all land on one process, one state root, and one session surface. Each is internally coherent; none owns the machinery all three depend on. The 2026-07-24 architecture spine identified that overlap and fixed the invariants (AD-9 through AD-21); this SPEC is the **work** those invariants imply, gathered where it actually belongs instead of misattributed to whichever feature happens to touch it first.

It is deliberately unglamorous and deliberately first. Nothing here is a user-visible capability. Everything here is something two features would otherwise build twice, differently — or, in the case of the concurrency ceiling, a defect that only becomes visible when you hold all three specs at once.

Three findings drove it, all from reading the code rather than the specs:

- **The concurrency ceiling is a fiction.** `engine.ts` holds a module-private `MAX_CONCURRENT = 4` while a loom Charter promises `budget.maxAgents: 12` and Ultra stacks its own cap of 3 on top. The charter's number is unreachable, the real ceiling is invisible, the gate knows nothing about *who* is asking — so a build fan-out can starve verification, which is the loom system's own diagnosed failure reproduced by the scheduler — and the gate can drift above its own ceiling. See `admission.md`.
- **The spend ledger already exists.** `~/.telar/usage.ndjson` (`logUsage()` / `UsageEntry` in `apps/web/lib/store.ts`) is an append-only attributed ledger. Any new spend file would be a fourth counter competing with three. Worse, `store.ts` alone hardcodes `~/.telar` while every other module honors `TELAR_HOME`, so chat history and usage do not isolate in dev.
- **Session configuration is accreting branches.** Three features need four kinds of session — project, project-less master, loom node, steerer — and the only mechanism today is conditional paths through one 103KB route handler. Each feature adding its own `if` is how a moat enforced in one place becomes a moat enforced in three, each with its own chance to be forgotten.

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

- **CAP-7** Session config is a resolved profile, not a branch
  - **intent:** Every kind of session — project, project-less master, loom node, steerer — is described by data resolved before the request is handled, so a new surface adds a profile instead of another conditional path through the route.
  - **success:** A typed `SessionProfile` — `{cwd, guardrails, settingSources, mcpServers[], toolPolicy, requiredCapabilities, systemPromptAppendix}` — is resolved **before the route body**, and the four session kinds above are expressed as profiles with no session-kind conditional left in the handler. The project-less master is a profile supplying `cwd: TELAR_HOME/workspace/home` and `settingSources: []`, not a special case. Three properties are what make this safe to adopt: the `PreToolUse` guardrail is wired into the pipeline **outside** the profile and runs for every session regardless of profile; `toolPolicy` is **intersect-only**, carrying deny lists and allow-narrowing only, so no profile field can re-enable an accept path — enforced by its type, not by review; and a profile's `requiredCapabilities` are checked against what the provider port publishes, with an unmet requirement a hard error **before the stream opens**, matching the route's existing pre-SSE 400. No silent degradation. Governed by AD-9, AD-10, AD-11.

## Constraints

- **Reuse, never rebuild.** The usage ledger, the lease primitive, the atomic-write idiom and the `TELAR_HOME` resolution expression all already exist. Copy the settled expression; do not invent a variant. CAP-2 extends `usage.ndjson` and CAP-5 generalizes `runner/lease.ts` — creating a second spend file or a second lease shape is the failure each capability exists to prevent.
- **The lease primitive and `TELAR_HOME/sessions/<sessionId>/` are built exactly once, here, under CAP-5.** Every consumer — including the loom's per-owner service-lease registry — composes over that primitive and re-implements no stale-reclaim. AD-16 exists to stop two stale-reclaim implementations drifting, which is the path by which a false `done` gets issued, and a false `done` is a breach of the human-accept moat.
- **The Human-Accept Moat and the Verifier capability wall are non-negotiable.** CAP-6 makes them executable and CAP-7's intersect-only `toolPolicy` keeps them structural; neither capability may relax them. Making session config data is exactly the move that could turn a structural invariant into a configurable one, which is why the guardrail sits outside the profile.
- **One route, one resolver, one guardrail.** Separate routes per session kind were rejected on the ground that a moat enforced in three places has three chances to be forgotten.
- **Nothing in this SPEC is user-visible.** Every capability is substrate two or more features would otherwise build twice. A capability here that starts growing a surface has escaped its package.
- `@telar/core` is server-side only; client components import **types only**. Runtime core code lives in Route Handlers, Server Components and `instrumentation.ts`. All server surface is `app/api/**/route.ts` — no `pages/api`, no Server Actions, no `middleware.ts`.
- **Deterministic control flow in code, intelligence in the leaves.** The admission policy is pure for this reason (AD-17 / `admission.md`); entitlement and the admit/deny decision take policy and occupancy as arguments, with no I/O, clock, or implicit module state.
- **One owner per `TELAR_HOME` subtree**; shared runtime state that belongs to no module is written only through its owning core service (AD-5, AD-20). zod schemas for persisted entities are owned by `@telar/core` and never redefined in `apps/web`.
- **No CI.** `bun test`, `bun run lint` (web) and `bunx tsc --noEmit` run manually before committing. `bun run lint` currently reports ~77k pre-existing problems in `apps/web`, most under `.next-desktop/` build output — it is not a clean baseline and is not this SPEC's to fix.

## Non-goals

- **Tuning the admission ceiling or class weights against a real fleet.** The mechanism ships with defaults; numbers are an operational decision, not a cold-start one.
- **Wiring `processCeiling` into `tick.ts` and `executor.ts`'s live clamps.** The term exists and is tested at CAP-4; passing it changes scheduler output and earns its own story and test sweep.
- **Tagging `executor.ts`'s `agent()` call sites with `loom-build`.** Safe to defer — untagged calls land in `other`, the lowest-weight class with no precedence — and a mis-tag silently changes scheduling, so it belongs to the executor's own story.
- **Adding CI.** Declined at spine authoring time; CAP-6's assertions run manually.
- **Persisting bus events.** AD-14 fixes in-process delivery only; every durable trace today is already a module-owned NDJSON stream.
- **Codex MCP injection.** A distinct piece of Track B, already storied in `SPEC-organization-workspace` and optional for v1 because a Claude-backed master is unblocked without it. CAP-7 supplies the `requiredCapabilities` mechanism that makes the gap fail closed rather than degrade silently; the injection work itself is not re-claimed here.
- **The `SessionProfile` field set beyond the named core.** AD-9 fixes the resolved-before-the-body shape and the intersect-only `toolPolicy`; additional fields are added by the surface that needs them.
- **Rewriting the loom's per-owner service-lease registry.** It composes over CAP-5; it is not re-specified here.
- **Any UI for admission or bus state.** `admissionSnapshot()` is an export; whether a surface renders it is that surface's spec to decide.

## Success signal

Under `TELAR_HOME=<temp>`, one scripted run demonstrates the substrate serving a consumer on every port: an `agent-facing` event wakes a subscriber while a `human-facing` one provably does not push; a spend record attributes to an owner and reads back through a projection; a `loom-verify` call wins a freed slot ahead of already-queued `loom-build` work, with `admissionSnapshot()` naming why; a stale lease reclaims to `failed` and never to `done`; and a profile with an unmet `requiredCapability` fails before the stream opens. Throughout, the real `~/.telar` is untouched. Alongside it: CAP-6's assertions green, the full core suite green, and `bunx tsc --noEmit` clean in **both** `packages/core` and `apps/web`.

This is the gate before the three feature SPECs build on this substrate.

## Assumptions

- The five modules that already resolve `TELAR_HOME` correctly (`manifest.ts`, `looms.ts`, `session-log.ts`, `permissions.ts`, `vcs.ts`) are the reference and `store.ts` is the sole outlier. Verified against the working tree 2026-07-24; a sixth outlier is still CAP-1's to fix.
- `admissionSnapshot()`'s shape (policy, occupancy, waiting-by-class, in-flight, queued) is taken from `admission.md` as-is. No consumer has specified what it needs, so the export is defined by what the controller can honestly report rather than by a surface's requirements.
- CAP-7's profile set — project session, master session, loom-node session, steerer — is the set the spine names. Retrofitting the existing session kinds onto profiles is in scope; discovering a fifth kind is not, and would be that surface's own work.
- CAP-7 lands in two moves: the resolver arrives **additively**, with new profiles resolving through it while the existing project-session path is untouched, and a follow-on migrates the live chat path onto it. Both are in scope; separating them keeps the change that touches production traffic behind its own gate.
