# Admission Control — the concurrency contract

Companion to `SPEC.md` (CAP-4). Governed by AD-17. This is the full contract for the fix; the SPEC's success line is a summary of it.

## The defect, verified in code 2026-07-24

| Claim | Reality |
| --- | --- |
| A Charter promises `budget.maxAgents` | `schemas.ts:341` defaults it to 12; `budget.ts` `DEFAULT_MAX_AGENTS = 12` |
| The process allows | `engine.ts:89` `const MAX_CONCURRENT = 4` — module-private, no exported hook, joined by every schema'd `agent()` call |
| Ultra adds | `ultra/executor.ts` a separate run-local semaphore, cap 3, stacked on top |
| The loom SPEC's premise | "7+ concurrent looms is the norm" |

So `maxAgents: 12` is unreachable, the effective ceiling is invisible to everything that reasons about fan-out, and `fanoutClamp`'s scheduler rationale reports numbers that will not happen.

Three distinct problems, all in that gate:

**1. The ceiling is invisible and unconfigurable.** Nothing outside `engine.ts` can read it or change it.

**2. The gate is class-blind.** It is a plain FIFO semaphore, so a build fan-out that fills all four slots leaves a verification call waiting behind the whole fan-out. That is the loom system's own diagnosed failure — *"verification never reliably closed the loop"* — reproduced mechanically by the scheduler.

**3. The gate can exceed its own ceiling.** A pre-existing bug:

```ts
const acquire = async () => {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;                       // no re-check after waking
};
const release = () => {
  active--;
  waiters.shift()?.();            // wakes a waiter, but the slot is not yet taken
};
```

`release()` decrements and schedules a waiter's resumption as a microtask. An `acquire()` arriving in that window sees `active < MAX_CONCURRENT` and takes the slot immediately; the woken waiter then does `active++` without re-checking. `active` ends up above the ceiling, by one per barging arrival.

## The contract

### Ceiling

One ceiling, read from `TELAR_MAX_AGENTS`, defaulting to **4** — the historical value, so adopting the controller is not itself a throughput change. Parsing is tolerant: a missing, blank, non-integer, or sub-1 value falls back to the default rather than throwing at import time and taking the server down with it.

### Classes

`loom-build` · `loom-verify` · `ultra` · `other`

Each class has a **weight** (share of the ceiling) and a **floor** (minimum entitlement, so a heavier class cannot starve a lighter one outright). Entitlement is `max(floor, ⌊ceiling × weight / totalWeight⌋)`. Starting values — tuning is explicitly out of scope:

| Class | Weight | Floor |
| --- | --- | --- |
| `loom-build` | 3 | 1 |
| `loom-verify` | 2 | 1 |
| `ultra` | 2 | 1 |
| `other` | 1 | 0 |

At the default ceiling of 4 the floors dominate and this degenerates to "one each, borrow the rest" — which is the correct behavior on a 4-slot machine, not a flaw. Weights only start to matter once the ceiling is raised.

A call site declares its class through an opt-in field on `AgentOpts`. **Omitted means `other`** — the lowest-weight class with no precedence — so an untagged call can never occupy a slot that precedence was meant to protect, and adopting this requires no sweep of every call site.

### Precedence, not reservation

**Verification gets precedence, not a held-open slot.** This is the load-bearing design decision and the one most likely to be re-litigated, so:

A hard reservation — keeping a slot empty whenever `loom-verify` is idle — was specified first, built, and then rejected on evidence:

- It broke `packages/core/test/ultra-runner.test.ts`'s existing `expect(peak).toBe(4)` assertion, because holding one slot back makes a pure-Ultra workload peak at 3.
- On a 4-slot machine it permanently burns 25% of capacity to insure against a wait that is already bounded.

The mechanism that gets the same protection for free:

1. **No barging.** Once anyone is queued, new arrivals queue too — they never take a slot a woken waiter is about to claim. This also fixes problem 3 above.
2. **A freed slot goes to entitled waiters first, in class-priority order** (`loom-verify`, `loom-build`, `ultra`, `other`), FIFO within a class.
3. **Then a work-conserving borrow pass**: if nobody is entitled and capacity remains, the FIFO-first waiter borrows it. Without this, several classes each sitting exactly at their entitlement would stall with free slots on the floor.

Consequence: verification waits **at most one in-flight call**, never a whole fan-out — and no slot ever idles while work is queued. The slot is taken *before* the waiter is woken, so the accounting is closed against races by construction.

### Scope

Admission governs **`agent()` concurrency only**.

- **Interactive chat sessions are out of band by design.** They call the SDK's `query()` directly from `apps/web/app/api/chat/route.ts` (~line 1171) and never enter `engine.agent()`, so a fleet can never make the cockpit wait. There is **no** `interactive-session` class and no reserved slot for one. (The architecture spine originally claimed otherwise; the code disproved it.)
- **Long-lived processes take no slot.** Labs, declared services and borrowed infra are governed by the run lease (CAP-5) and the per-repo worktree mutex. Without this line, one loom epic counts a lab standup as occupancy and another does not, and the ceiling becomes unknowable again.
- **Ultra's run-local cap of 3 stays.** It is a legitimately different thing — a per-run fan-out limit — stacked on top of admission, not a competitor to it.

### Shape

The policy half is **pure**: entitlement and the admit/deny decision take policy and occupancy as arguments — no I/O, no clock, no implicit module state — so the whole policy space is testable without a queue. Only the queue holds mutable state. This is the project's design law (deterministic control flow in code) applied to the scheduler itself.

An observability read (`admissionSnapshot()`-shaped: policy, occupancy, waiting-by-class, in-flight, queued) is part of the contract and exported from `@telar/core`, so a surface can show *why* a fan-out is queued instead of the user guessing. Reconfiguration and reset are a test seam and must **throw** rather than silently strand queued waiters — a stranded waiter hangs a suite in a way that is miserable to diagnose.

### Honest fan-out

`fanoutClamp` gains an optional `processCeiling` term (plus a `capByProcess` readout and a `process` value for `binding`), so the scheduler's own rationale can say the process is the binding constraint. It must be **optional**, and the existing `pool → budget` tie-break order preserved, so every current call site keeps byte-identical behavior until deliberately migrated.

## Acceptance

- Ceiling comes from `TELAR_MAX_AGENTS`; garbage input falls back to 4 without throwing.
- Entitlement is exercised at the default ceiling (floors dominate) *and* at a raised ceiling (weights dominate), including a zero-weight map that must not divide by zero.
- A single class can borrow up to the full ceiling — `ultra-runner.test.ts`'s `peak === 4` passes **unchanged**.
- With the pool full of `loom-build` and two more builds already queued, a later-arriving `loom-verify` wins the next freed slot.
- In-flight count never exceeds the ceiling, including a test that deliberately lands an arrival between a release and the woken waiter's resumption.
- With every waiter over its entitlement, a freed slot is still granted (the borrow pass) rather than left idle.
- A double release cannot mint capacity — occupancy floors at zero.
- Reconfigure/reset throw while waiters are queued.
- The observability snapshot does not leak mutable internals.
- `fanoutClamp` without `processCeiling` is behaviorally identical to today; with it, a charter of 12 under a ceiling of 4 reports `chosen: 4` and `binding: "process"`.
- Full suite green (`bun test` in `packages/core`), plus `bunx tsc --noEmit` clean in **both** `packages/core` and `apps/web`.

## Reference implementation

A complete, passing implementation of this contract was written during the 2026-07-24 architecture run and then deliberately reverted so it could land as reviewed work rather than an unrequested change. It is preserved beside this spec at:

```
reference/admission-impl/   (in this spec folder)
  admission.ts          # the controller
  admission.test.ts     # 22 tests covering the acceptance list above
  core-changes.patch    # engine.ts / budget.ts / index.ts / verifier.ts / critic.ts / ultra-runner.ts
```

It verified at 1317 pass / 0 fail across 99 core test files, with core and web typechecks clean. Treat it as a reference, not as authority: this document is the contract.
