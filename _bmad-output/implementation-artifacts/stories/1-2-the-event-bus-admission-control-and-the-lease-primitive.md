---
story_id: "1-2"
title: "The event bus, admission control, and the lease primitive"
status: "review"
epic: "Epic 1: Runtime Foundations"
track: "A — Runtime foundations (packages/core/src only)"
caps: ["CAP-3", "CAP-4", "CAP-5"]
frs: ["FR-RF-3", "FR-RF-4", "FR-RF-5"]
ads: ["AD-2", "AD-5", "AD-6", "AD-14", "AD-16", "AD-17", "AD-20", "AD-21"]
nfrs: ["NFR-RF-1", "NFR-RF-3", "NFR-RF-5", "NFR-RF-6", "NFR-RF-7", "NFR-RF-8", "NFR-RF-9"]
baseline_commit: "578e5b4772f2c05bc514abae8704b4a98a58f9e0"
depends_on: ["1-1 (done — TELAR_HOME isolation + owner-attributed usage ledger)"]
blocks: ["1-3", "epic 4", "epic 5", "epic 6"]
---

# Story 1.2: The event bus, admission control, and the lease primitive

## 0. Read this first

**Citation policy for this whole file — inherited from story 1.1, which re-learned it four times.**
Every reference below names a **file and a symbol** — a function, a const, a type field, or a test title.
**A line number is not a name.** It identifies a slot in a file, and any edit above it hands that slot to
something else. Where a number genuinely helps you navigate a long file it is written `≈:N` and is a
**pointer, not a fact** — verify by symbol, never by number. Do not add a number to this file you have
not just measured.

**Three hard rules before you write a line:**

1. **Read `_bmad-output/specs/spec-runtime-foundations/admission.md` in full before touching admission.**
   It records a design that was **built and rejected on evidence** (a hard reservation for `loom-verify`).
   Re-deriving it breaks `ultra-runner.test.ts`'s `peak === 4` and permanently burns 25% of a 4-slot machine.
2. **There is exactly one lease implementation.** If you find yourself writing a second stale-reclaim, stop.
3. **Every test you add must be proven DISCOVERED by the runner, by name, in the repo-wide run.**
   See §6. A green gate over invisible tests is the specific failure this story was warned about in advance.

**Write set:** `packages/core/src/**` only. This is Track A. Do **not** edit `apps/web/**`, the chat route,
or any component. If you find work that cannot be done inside `packages/core/src`, **stop and record it**
as story 1.1 did for its AC6 — do not quietly cross the boundary. (One such collision is already known and
pre-resolved for you: see §5.6 T-3.)

---

## 1. User Story

As a telar module author,
I want one typed event bus, one admission controller and one lease primitive in core,
So that three features subscribe, schedule and lease through one implementation each rather than three that drift apart.

**Why this story exists, in one paragraph.** Three feature epics (4, 5, 6) all need "something finished",
"how many agents may run", and "is that process still alive". Today the answers are: nothing, a
module-private `MAX_CONCURRENT = 4` nobody can see or configure, and a lease that serves looms only. If each
epic answers for itself, we get three buses with three delivery semantics, two concurrency ceilings that
disagree, and two stale-reclaim implementations — and two stale-reclaims is the documented path by which a
false `done` gets issued, which is a breach of the Human-Accept Moat.

**Nothing in this story is user-visible.** No dev-server-observable change. A capability here that starts
growing a surface has escaped the epic.

---

## 2. Acceptance Criteria

Each AC is verbatim from `_bmad-output/planning-artifacts/epics.md` § "Story 1.2", followed by **Proof** —
what must exist for it to be checkable by someone who did not write the code.

### Event bus (CAP-3 / FR-RF-3)

- [x] **AC1** — **Given** a module publishes an event **When** the event is constructed **Then** a delivery
  class is a field the type system demands, not a convention.
  - **Proof — two separate things, and the order matters:**
    1. **Primary, and the only one that satisfies the AC:** a **compile-time** rejection. A declaration
       object literal missing `deliveryClass` must not typecheck. Pin it with a `// @ts-expect-error` line
       in the test (which *fails the build if the error stops occurring* — that is what makes it a test and
       not a comment), plus an in-source comment naming the required field on `EventDeclaration` that makes
       the omission unrepresentable.
    2. **Secondary, belt-and-suspenders only:** a runtime guard for callers that bypass the type system
       (`as any`, JS callers, a payload off the wire). Useful, but it does **not** on its own satisfy
       "the type system demands" — a story whose only evidence is `if (!e.deliveryClass) throw` has not met
       this AC.

- [x] **AC2** — **Given** an `agent-facing` event with a subscriber attached **When** it is published
  **Then** the subscriber may synthesize an assistant turn **And** a `human-facing` event provably pushes
  nothing — it renders only on a surface the user arrives at.
  - **Proof:** the "may synthesize a turn" capability is a **separate, class-gated subscription channel**.
    Registering a `human-facing` event name on that channel must be **refused** (throw), and publishing a
    `human-facing` event must **never** invoke a wake-channel handler. Both directions asserted. "Provably"
    means a test that would fail if the filter were removed — verify that by removing it and re-running.

- [x] **AC3** — **Given** a module attempts to subscribe to an event another module never declared
  **Then** the subscription is not permitted — undeclared events are internal.
  - **Proof:** `subscribe()` on an undeclared name throws with a message naming the event and the rule
    (AD-21). Publishing an undeclared name throws too — a declaration that only gates the read side lets a
    typo mint a silent, unsubscribable event.

### Admission control (CAP-4 / FR-RF-4)

- [x] **AC4** — **Given** `TELAR_MAX_AGENTS` is missing, blank, non-integer or below 1 **When** the
  controller initializes **Then** it falls back to 4 without throwing at import time.
  - **Proof:** `readCeiling()` is a pure function taking an env record, tested over `undefined`, `""`,
    `"   "`, `"abc"`, `"0"`, `"-3"`, `"2.5"` → all `4`; and `"8"` → `8`. Import-time safety follows from the
    parse never throwing; assert that too, do not assume it.

- [x] **AC5** — **Given** the pool is full of `loom-build` work with two more builds already queued
  **When** a `loom-verify` call arrives later and a slot frees **Then** the verify wins that slot, and
  `admissionSnapshot()` names why.
  - **Proof:** the reference suite's `"gives a freed slot to loom-verify ahead of a queued build fan-out"`.
    "Names why" means the snapshot exposes `policy` (including `priority`), `occupancy`, `waiting` by class,
    `inFlight` and `queued` — enough for a reader to reconstruct the decision without guessing.

- [x] **AC6** — **Given** an arrival lands between a `release()` and the woken waiter's resumption
  **Then** in-flight count never exceeds the ceiling.
  - **Proof:** this is a **pre-existing bug** being fixed, not a new feature. The current `engine.ts` gate
    wakes a waiter and lets it do `active++` with no re-check, so an arrival in that window over-commits the
    pool by one. The fix is: the slot is taken **before** the waiter is woken, plus no-barging. Pinned by
    the reference suite's `"never exceeds the ceiling, even when arrivals race a release"`.

- [x] **AC7** — **Given** every waiter sits over its entitlement and capacity remains **Then** the freed
  slot is still granted by the borrow pass rather than left idle.
  - **Proof:** the reference suite's `"does not idle a slot when every waiter is over its entitlement"`.

- [x] **AC8** — **Given** a pure-Ultra workload **When** it runs **Then** `ultra-runner.test.ts`'s
  `peak === 4` passes **unchanged**.
  - **Proof:** `packages/core/test/ultra-runner.test.ts` is **byte-identical** after your change. Prove it
    with `git diff --stat -- packages/core/test/ultra-runner.test.ts` returning empty output, pasted into
    the Debug Log. This is the empirical reason the reservation design was rejected — do not "fix" the test.

- [x] **AC9** — **Given** a double release, or a reconfigure/reset while waiters are queued **Then**
  capacity cannot be minted, and reconfigure/reset throw rather than strand waiters.
  - **Proof:** occupancy floors at zero on release (`Math.max(0, …)`), asserted directly; and
    `configureAdmission` / `resetAdmission` throw while `queue.length > 0`. A stranded waiter hangs the whole
    suite in a way that is miserable to diagnose — bun runs every test file in one process, so this is not
    hypothetical.

- [x] **AC10** — **Given** `fanoutClamp` is called without `processCeiling` **Then** behavior is
  byte-identical to today **And** with it, a charter of 12 under a ceiling of 4 reports `chosen: 4`,
  `binding: "process"`.
  - **Proof:** **six** existing call sites across **four** files are left **unedited** — measured, not
    hand-counted (`grep -rn "fanoutClamp(\|fanoutSize(" packages/core/src/`):
    `repair-guard.ts` ×1, `tick.ts` ×1, `executor.ts` ×3, `build-fanout.ts`'s `decideBuildFanout` ×1.
    **Re-run that grep yourself** — this story's first draft said "three" and was wrong, which is exactly
    why the instruction is a command and not a list.
    And the load-bearing regression guard stays green: `packages/core/test/orchestrator.test.ts`'s
    `"fanout binding term is 'pool' when the agent pool is the smallest cap"`,
    `"fanout binding term is 'budget' when the cost budget is the smallest cap"` and
    `"schedule rationale carries priority scores, the head, and the binding fanout term"` assert the
    `binding` field directly. The tie-break order stays `pool → budget → process` so the pre-existing
    `binding` readout cannot change when the new term is absent.

### Lease primitive (CAP-5 / FR-RF-5)

- [x] **AC11** — **Given** a loom-owned and a session-owned process **When** each leases **Then** both use
  one record shape (`{pid, token, ts}`, atomic temp+rename, heartbeat, stale-reclaim) **And**
  `TELAR_HOME/sessions/<sessionId>/` exists holding runtime state only, not absorbing `chats.json` **And**
  a stale lease on either path can at worst produce a false-positive `failed`, never an auto-`done`.
  - **Proof (three separate things, all required):**
    1. **One shape:** a test that leases a loom root and a session root through the **same** exported
       functions and asserts the two on-disk records are structurally identical. If you wrote two write
       paths, this AC is not met however green the suite is.
    2. **Tree exists, runtime only:** `sessionDir(id)` resolves under `TELAR_HOME`, is created on demand,
       and a test asserts that writing a session lease creates **nothing** named `chats.json`,
       `usage.ndjson` or `plan-usage.json` anywhere, and does not touch the root-level store.
    3. **Never auto-done:** the reclaim decision is a **pure function returning a union that structurally
       cannot express success**, mirroring `recover.ts`'s `reconcileState` (whose own comment reads
       "MOAT: no branch here can return a terminal-SUCCESS"). Assert it by enumerating every value the
       union can take and asserting `done` is not among them — a test over behavior alone would pass on a
       union that merely happens not to return `done` today.

---

## 3. Scope fences — what this story does NOT do

Each of these is an explicit non-goal in `SPEC-runtime-foundations`, `epics.md`, or the architecture's
Deferred list. Doing any of them is scope creep that changes scheduler behavior or another story's contract.

| Not in scope | Where it lives | Why not here |
| --- | --- | --- |
| CAP-6 executable invariant assertions | story 1.3 | separate FR (FR-RF-6) |
| The Track A prove-run under `TELAR_HOME=<temp>` | story 1.3 | separate FR; needs all ports first |
| Tagging `executor.ts`'s five `agent()` sites `loom-build` | the executor's own story | a mis-tag silently changes scheduling; needs each site read in a 156KB file. Untagged = `other` = lowest weight, no precedence — safe by construction |
| Wiring `processCeiling` into `tick.ts` / `executor.ts` / `repair-guard.ts` | its own story | passing it changes scheduler output and wants its own test sweep |
| Persisting bus events | declined (`SPEC.md` Non-goals) | AD-14 fixes in-process delivery only; every durable trace is already a module-owned NDJSON stream |
| Declaring concrete events (the event catalogue) | each module's own epic | architecture Deferred; AD-21 making published names binding is what makes the deferral safe. See T-B2 |
| The per-owner service-lease registry (`services/<name>.json`) | epic 6 | composes over this primitive; explicitly "not re-specified here" |
| Tuning ceiling or class weights | operational | defaults ship; numbers are a real-fleet decision |
| Any UI for admission or bus state | the surface's own spec | `admissionSnapshot()` is an export; rendering is not this story's |
| An `interactive-session` admission class | nowhere — rejected | the chat route calls the SDK's `query()` directly and never enters `engine.agent()`. A reserved slot for it would reserve nothing |
| Editing `apps/web/**` | Track B / Track C | write-set discipline. Includes `apps/web/lib/session-log.ts` — see §5.6 T-3 |
| Collapsing the five duplicated `TELAR_HOME` resolvers | tracked in `deferred-work.md` | deliberate duplication; do not "fix" it. New **core** code imports `telarDir` instead (§5.4) |
| Removing or editing `bunfig.toml` | nowhere | it is an open `[Review][Decision]` on story 1.1. See §6 |

---

## 4. Tasks / Subtasks

Three independent legs. **Order is a suggestion, not a constraint** — they touch disjoint files except
`packages/core/src/index.ts`. Land admission first if you want the highest-risk leg reviewed while you
still have budget.

### Leg A — Admission control (AC4–AC10)

- [x] **T-A1 — Create `packages/core/src/admission.ts`.**
  **Files:** `packages/core/src/admission.ts` (NEW).
  Adopt the reference implementation at
  `_bmad-output/specs/spec-runtime-foundations/reference/admission-impl/admission.ts`, **re-verified
  line-by-line against `admission.md`**, which is the authority where the two disagree.
  Required exports (names taken from the reference; keep them, downstream stories and the barrel assume them):
  `AdmissionClass`, `ADMISSION_CLASSES`, `ClassMap`, `AdmissionPolicy`, `DEFAULT_ADMISSION_CEILING`,
  `readCeiling`, `defaultAdmissionPolicy`, `entitlement`, `availableFor`, `AdmissionReason`,
  `admissionCheck`, `admissionCeiling`, `admissionSnapshot`, `acquireAdmission`, `releaseAdmission`,
  `configureAdmission`, `resetAdmission`.
  **The policy half must be pure** (NFR-RF-6): `entitlement`, `availableFor` and `admissionCheck` take
  policy and occupancy as arguments — no I/O, no clock, no implicit module state. Only the queue holds
  mutable state. This is the project's Design Law applied to the scheduler itself.
  Carry a WHY header block in the house voice (§5.4) stating: what it replaces, the precedence-not-
  reservation trade-off **and that a reservation was built and rejected**, and the scope line (gates
  `agent()` leaf calls only; not interactive chat; not long-lived processes).
  **Proof:** `packages/core/test/admission.test.ts` (T-A5).

- [x] **T-A2 — Replace `engine.ts`'s private gate.**
  **Files:** `packages/core/src/engine.ts`.
  Delete `MAX_CONCURRENT`, `active`, `waiters`, `acquire`, `release`. Add
  `admissionClass?: AdmissionClass` to `AgentOpts` (optional — omitted means `"other"`, so **no call-site
  sweep is required**). In `agent()`, replace `await acquire()` with
  `await acquireAdmission(opts.admissionClass ?? "other")` and the `finally { release(); }` with the
  matching `releaseAdmission(...)`. **The class must be resolved once into a local before the `try`** so
  acquire and release cannot disagree.
  **Must not break:** `agent()`'s exported signature, its `try`/`finally` shape, `accountEnv()`'s
  `delete env[p.configDirEnv]` behavior (the "personal silently resolves to work" fix), and the
  `restrictTools` capability wall.
  Leave a comment where the gate was, explaining what moved and why (the reference patch's replacement
  comment is a good model) — a bare deletion invites the next reader to re-add a semaphore.
  **Proof:** the whole `packages/core` suite stays green, `ultra-runner.test.ts` unedited (AC8).

- [x] **T-A3 — `fanoutClamp` gains an optional `processCeiling`.**
  **Files:** `packages/core/src/budget.ts`.
  Add a `FanoutArgs` type carrying the existing four fields plus `processCeiling?: number`; add
  `capByProcess: number` to `FanoutClamp`; add `"process"` to the `binding` union. `capByProcess` is
  `args.processCeiling ?? Infinity`. The `cap` becomes `Math.min(capByPool, capByBudget, capByProcess)`.
  **The tie-break order must stay `pool → budget → process`** so a call site that passes no ceiling reports
  exactly what it reports today.
  Update `DEFAULT_MAX_AGENTS`'s comment to say it is a **per-loom clamp, not a process ceiling**.
  **Must not break:** `fanoutSize` (a thin wrapper — `return fanoutClamp(pieces, args).chosen`, signature
  unchanged for callers), and **every existing call site, left unedited**. Enumerate them by grep, do not
  hand-count: `grep -rn "fanoutClamp(\|fanoutSize(" packages/core/src/`. At baseline `578e5b4` that is six
  sites in four files — `repair-guard.ts` ×1, `tick.ts` ×1, `executor.ts` ×3 (including
  `runFreeStepFanout`), `build-fanout.ts`'s `decideBuildFanout` ×1 — but **re-measure**; the count is a
  pointer, not a fact.
  **Proof:** the `fanoutClamp` block in `admission.test.ts`, plus the suites that actually exercise this
  code path staying green — `packages/core/test/orchestrator.test.ts` (the only place `binding` is asserted
  directly), `m9-thread-workflow.test.ts`, `weave.test.ts`, `repair-guard.test.ts`, `roster.test.ts`.
  There is no `budget.test.ts`, `tick.test.ts` or `executor.test.ts` — do not go looking for them.

- [x] **T-A4 — Tag the three call sites the reference patch tags, and only those.**
  **Files:** `packages/core/src/verifier.ts` (`admissionClass: "loom-verify"`),
  `packages/core/src/critic.ts` (`admissionClass: "loom-verify"`),
  `packages/core/src/ultra/runner.ts` (`admissionClass: "ultra"` on `runUltraAgent`'s schema'd branch,
  which delegates to `engineAgent`).
  **Add the option only.** Do not touch `VERIFIER_TOOLS`, `restrictTools`, or any `disallowedTools` list —
  the Verifier capability wall (AD-2) is non-negotiable and is orthogonal to this change.
  **⚠ Reword the reference patch's comments.** The patch's added comments at these three sites say
  *"the same reserved class as the verifier proper"*, *"Competes in the reserved class"* and
  *"never eats the verify reservation"*. That is the **vocabulary of the rejected design**. Copying it plants
  "reservation" in three files and the next reader re-derives a held-open slot from it. Write **precedence**
  instead: a freed slot goes to entitled waiters in class-priority order, and verification therefore waits
  at most one in-flight call — never a whole fan-out.
  **Proof:** `bunx tsc --noEmit` clean; the loom/verifier/critic/ultra suites green.

- [x] **T-A5 — Re-home the reference admission suite.**
  **Files:** `packages/core/test/admission.test.ts` (NEW).
  Copy `_bmad-output/specs/spec-runtime-foundations/reference/admission-impl/admission.test.ts` to
  `packages/core/test/admission.test.ts`. Its imports are `from "../src/admission"` and `from "../src/budget"`
  — **these resolve correctly only at `packages/core/test/`**, which is exactly why the file is invisible
  where it sits today.
  Two required adaptations:
  1. **`it(` → `test(`.** The reference uses `it(...)`; **zero** of the 102 files in `packages/core/test/`
     use `it(`. Match the house convention. Update the `bun:test` import accordingly.
  2. **Reset between tests.** bun runs every test file in one process and `admission.ts` holds module-level
     singleton state. `beforeEach(() => resetAdmission({}))` (or equivalent) is mandatory, and any test that
     queues a waiter must drain it before the file ends or `resetAdmission` will throw and take the run down.
  Then **extend** it to cover anything in `admission.md`'s Acceptance list the 22 reference cases miss, and
  add the AC5 snapshot assertion that `admissionSnapshot()` **names why** (priority order + waiting-by-class
  are both readable from it).
  **Proof:** §6's discovery proof, by name, for every test in the file.

- [x] **T-A6 — Clear the stale `MAX_CONCURRENT` prose in `packages/core/src`.**
  **Files:** `packages/core/src/ultra/runner.ts`, `packages/core/src/ultra/executor.ts`.
  Both carry header comments asserting a `MAX_CONCURRENT=4` gate in `engine.ts` — one of them citing
  `engine.ts:89-99`. Those coordinates are **accurate right now** (re-measured at `578e5b4`: they land
  exactly on `MAX_CONCURRENT` through `release`'s closing brace) and go stale **the moment T-A2 lands**.
  After T-A2 the gate does not exist at all. Replace the prose with the admission controller, keeping each
  file's real point intact:
  `ultra/runner.ts` — the schema'd branch delegates to `engine.agent()` and so joins the shared gate, while
  the schema-less branch does not; `ultra/executor.ts` — `RUN_CONCURRENCY = 3` is a **run-local fan-out
  limit stacked on top of admission**, deliberately kept, not a competitor to it.
  **Scope:** `packages/core/src` only. Leave `packages/core/test/ultra-runner.test.ts` byte-identical (AC8),
  including its describe title.
  **Why this is a task and not a nicety:** story 1.1's Repair Round 1 found a stale comment describing a
  removed guard as present, and recorded that it "would have led the next reader to restore it".

### Leg B — The typed event bus (AC1–AC3)

- [x] **T-B1 — Create `packages/core/src/event-bus.ts`.**
  **Files:** `packages/core/src/event-bus.ts` (NEW).
  Nothing like this exists today: there is **no** EventEmitter, pub/sub, listener registry or bus anywhere
  in `packages/core/src` or `apps/web` (the only listener `Set` in the repo is `apps/web/lib/ui-prefs.ts`,
  a client-side React external store for UI prefs — unrelated, and not a model to copy).
  Build the shape in §5.5. Non-negotiable properties:
  - `DeliveryClass = "agent-facing" | "human-facing"` — exactly these literals (AD-14, SPEC CAP-3).
  - The class is a **required field of the declaration type** (AC1).
  - A **declaration registry**: a module declares its event names with their class and payload shape
    (AD-21: "published event names and payload shapes are as binding as its tool signatures"). Subscribing
    to — or publishing — an undeclared name **throws** (AC3).
  - Event names follow `<module>:<past-tense-fact>` (`ultra:run-completed`, `loom:node-blocked`). **This is
    a new convention.** The existing NDJSON `type` literals (`"committed"`, `"accept-aborted"`,
    `"spend-record-failed"`) are a different, older, unrelated convention and are **not** being retrofitted.
  - A **class-gated wake channel** (AC2), so "human-facing pushes nothing" is structural rather than
    documented.
  - **In-process only.** No persistence, no file writes, no filesystem watching (§5.6 T-1).
  - A `resetBus()` test seam, for the same one-process reason as `resetAdmission`.
  - Subscriptions are the bus's own state and are written only through the bus (AD-20).
  **Proof:** `packages/core/test/event-bus.test.ts` (T-B3).

- [x] **T-B2 — Declare the story's own events: none.**
  This story builds the bus; it declares **no** concrete events. "Which concrete events each module declares
  is owned by that module's epic" (architecture Deferred, "Event catalogue"), and AD-21 is what makes that
  deferral safe. Ship the registry plus **fixtures in the test file only** — do not add a real event name to
  `packages/core/src`. If you feel one is needed to make the bus useful, that feeling is the escape the epic
  warns about; record it in Completion Notes instead.

- [x] **T-B3 — `packages/core/test/event-bus.test.ts` (NEW).**
  Cases, at minimum: declaration requires a class (the `// @ts-expect-error` case from AC1's Proof, plus the
  runtime guard); **a module cannot declare or publish into another module's namespace** (compose the name
  from `module` and prove a foreign-namespace name is unreachable — or, if you took a pre-composed `name`,
  prove it throws); declaring twice is an error or an idempotent no-op
  (decide, document, assert whichever you chose); subscribe-to-undeclared throws naming the event;
  publish-undeclared throws; an `agent-facing` publish reaches a wake-channel subscriber; registering a
  `human-facing` name on the wake channel throws; a `human-facing` publish reaches ordinary subscribers and
  **never** a wake handler; a throwing subscriber does not prevent the other subscribers from receiving,
  nor make `publish` throw (decide and document the error posture); unsubscribe stops delivery; `resetBus()`
  clears declarations and subscriptions.
  **Proof:** §6's discovery proof.

### Leg C — One lease primitive, two lifetimes (AC11)

- [x] **T-C1 — Generalize `runner/lease.ts` in place, without breaking its public API.**
  **Files:** `packages/core/src/runner/lease.ts`.
  Good news, verified against the tree: `leaseFile`, `writeLease`, `heartbeatLease` and `readLease` already
  take a **bare directory string** (named `loomDir`, but never validated as loom-specific), and the module
  deliberately does not import `looms.ts`'s `loomDir(id)`. So the generalization is mostly naming and
  contract, not surgery.
  Do: rename the parameter to an owner-neutral name (`ownerDir` / `leaseDir`) — positional, so no caller
  breaks; rewrite the header to state **both** lifetimes and both reclaim rules; keep `RunnerLease`,
  `LeaseFs`, `leaseFile`, `writeLease`, `heartbeatLease`, `readLease`, `isLeaseFresh` exported under their
  current names.
  **Do not rename the lease filename.** `leaseFile` returns `<dir>/.runner-lease` and must keep doing so for
  **both** lifetimes. One filename, one shape, zero divergence — and real loom trees may already hold a
  `.runner-lease` on disk, which a rename would orphan. The word "runner" is historical; say so in the
  header rather than fixing it.
  **Must not break:** `packages/core/src/index.ts` re-exports this whole module (`export * from
  "./runner/lease"`), so **every exported name here is public `@telar/core` API** — a rename is an API break,
  not a refactor. `packages/core/test/m5-lease.test.ts` and `packages/core/test/m5-liveness.test.ts` must
  stay green untouched.

- [x] **T-C2 — Create the session module: `packages/core/src/sessions.ts` (NEW).**
  This is the owner AD-5 names for `sessions/<sessionId>/`. It does not exist today — there is no
  `session*.ts` anywhere in `packages/core/src`, and `sessions/` under `TELAR_HOME` is currently an
  `apps/web`-only concept.
  Export at minimum:
  - `sessionsDir(): string` → `path.join(telarDir(), "sessions")`
  - `sessionDir(sessionId: string): string` → `path.join(sessionsDir(), sessionId)`, **with the same
    path-traversal id guard** `looms.ts`'s `loomDir` and `ultra/journal.ts`'s `runDir` use
    (`/^[A-Za-z0-9_-]+$/`, throwing on a bad id). SDK session ids are UUID-shaped and satisfy it.
  - A session-owned lease API composing over `runner/lease.ts` — write / heartbeat / read / reclaim-decide
    for a `sessionId`. **Composing**, not reimplementing: if the word `renameSync` appears in this file, you
    have written a second lease.
  Import `telarDir` from `./manifest` — **do not add a sixth copy** of the `TELAR_HOME` expression. This is
  the `vcs.ts` precedent, and the five existing copies are deliberate-and-tracked, not a pattern to extend.
  Carry a WHY header stating: what this subtree holds (**runtime state only — leases, ephemera**), what it
  explicitly does **not** absorb (`chats.json`, which keeps its own root-level home), and that
  `apps/web/lib/session-log.ts` is a **pre-existing co-tenant** of the same directory (§5.6 T-3).

- [x] **T-C3 — The reclaim decision that structurally cannot say `done`.**
  **Files:** `packages/core/src/sessions.ts` (or `runner/lease.ts` if you prefer it beside the primitive —
  state your choice in Completion Notes).
  A **pure** function over `(lease, ttlMs, now)` returning a small union — e.g. `"held" | "reclaimable"` —
  in which **no member can express a terminal success**. Model it on `packages/core/src/runner/recover.ts`'s
  `reconcileState`, whose comment reads *"MOAT: no branch here can return a terminal-SUCCESS. reconcileState
  only ever yields resume / queued / halt / leave / skip — never done."* Write the equivalent comment here
  and mean it.
  **Build it by wrapping `isLeaseFresh`** — `fresh → "held"`, otherwise `"reclaimable"`. Do **not** re-derive
  the `now - lease.ts <= ttlMs` comparison inline: `runner/lease.ts`'s `isLeaseFresh(lease, ttlMs, now)`
  already is that comparison, and re-deriving it is precisely the "second stale-reclaim" §0 rule 2 forbids —
  in the smallest, most innocent-looking form it takes.
  **Do not build a reconciler, a sweeper or a daemon.** There is no heartbeat timer anywhere in the repo
  today and this story does not add one — `heartbeatLease` is called by its owner's own loop, and the loom
  side's production sweep (`dispatcher.ts`'s `reconcileStuckLooms`) is out of this write set.
  **No TTL constant exists in production source today** — `ttlMs` is a caller-supplied parameter everywhere.
  Do not invent a global default; keep it a parameter. If you add a suggested constant, mark it as a
  suggestion and do not wire it into a caller.

- [x] **T-C4 — `packages/core/test/session-lease.test.ts` (NEW).**
  Cases, at minimum: the **same-shape** assertion (lease a loom root and a session root through the same
  exports; the two records are structurally identical); `sessionDir` resolves under a sandboxed
  `TELAR_HOME` and is created on demand; a traversal id (`"../../etc"`, `"a/b"`, `""`) throws; a session
  lease creates **no** `chats.json` / `usage.ndjson` / `plan-usage.json` and leaves the root-level store
  untouched; heartbeat keeps `pid`/`token` and moves `ts`; reclaim over the full outcome union, asserting
  `done` is not expressible; and — the load-bearing one — a **stale lease resolves to reclaimable/failed and
  never to a success value**, on **both** the loom path and the session path.
  Sandbox `TELAR_HOME` with the house idiom (§5.4). Never write to the real `~/.telar`.

### Leg D — Wiring and the gate

- [x] **T-D1 — Barrel exports.**
  **Files:** `packages/core/src/index.ts`.
  Add `export * from "./admission";`, `export * from "./event-bus";`, `export * from "./sessions";`.
  Match the house style: bare `export *`, with a short WHY comment above ports that carry an architectural
  rule — model it on the existing comment above the usage-ledger export, which reads
  `// AD-18/AD-20 — the one append-only spend ledger and its sole writer. The package exports only ".", so
  the barrel is this port's only route to apps/web.` Cite AD-17 for admission, AD-14/AD-21 for the bus,
  AD-5/AD-16 for sessions.
  **Watch for name collisions** — the barrel is flat and `export *` collides silently at type level. The one
  existing precedent is `tick.ts`'s `Decision`, re-exported as `OrchestratorDecision`. Run
  `bunx tsc --noEmit` in **both** `packages/core` **and** `apps/web` after this line lands; a barrel
  collision often shows up first on the consumer side.

- [x] **T-D2 — The gate.**
  **Files:** none (verification only).
  Run and paste real output for all of it — see §6.

### Review Findings

**Code review, 2026-07-26 — VERDICT: PASS. No blocking findings.** Reviewed diff `578e5b4..34379cf`
(the single commit, scoped to the 14 `packages/core` files in §10). Three parallel adversarial layers
(Blind Hunter / Edge Case Hunter / Acceptance Auditor) plus an independent pass over all 14 files and
every re-measurable claim in §6.3. All 11 ACs met; repo-wide suite green (1777 pass / 0 fail across 116
files, re-run by the reviewer, not quoted); both workspaces typecheck; every scope fence held. The §6
discovery proof was re-verified independently: 31/26/16 `<testcase>` rows carry the three new files'
`file=` attributes, matching the `test(` count in each source file exactly.

Everything below is **non-blocking** and was left as an action item — the review was a read-only pass and
edited no source. Each `[Review][Patch]` item marked *(reproduced)* was re-confirmed by the reviewer inside
`bun test`, not merely argued. Citations name a **file and a symbol** per this story's own policy; any
number is a pointer, not a fact.

Two findings were weighed for blocking and deliberately rated should-fix. `acquireAdmission`'s unvalidated
`cls` defeats the ceiling completely, but no *typed* path can produce a bad class, and AC6's text is
specifically the release/wake race, which is closed correctly. `fanoutClamp`'s NaN relabel is a literal
deviation from AC10's "byte-identical without `processCeiling`", but `chosen` is `NaN` both before and
after (only the diagnostic `binding` differs, and both values are wrong for a NaN input), no call site can
produce the input, and AC10's own Proof — six call sites unedited plus `orchestrator.test.ts`'s three
`binding` assertions — is satisfied and green.

**FIX PASS 1, 2026-07-26 — the six `should-fix` items from the review report are addressed: five closed
outright, one (the `cls` finding) closed in part with a recorded rebuttal.** Each was
reproduced by the reviewer inside `bun test` (probes BH#1, EC#1, EC#2, EC#3, EC#8); each now carries a
regression test that was verified load-bearing by reverting the fix and watching the test fail, and every
new test was confirmed DISCOVERED by the repo-wide runner by name and by `file=` attribution. Details in
Completion Notes 11–14; probe output in the Debug Log under "Fix pass 1". Items still open below are the
report's `nice-to-have` tier and were deliberately left — see Completion Note 14.

- [x] **[Review][Decision]** `admission.ts` captures `TELAR_MAX_AGENTS` **once at module evaluation** —
  `let policy = defaultAdmissionPolicy()` (`packages/core/src/admission.ts`, ≈`:142`); `readCeiling` is
  called nowhere else except `resetAdmission`. A process that sets the env var *after* importing
  `@telar/core` silently keeps ceiling 4 and `admissionCeiling()` reports 4 with no warning. Every other
  env-derived root in this repo resolves **lazily** — the convention story 1.1 learned the hard way
  (`98c065f fix(web): resolve TELAR_HOME lazily in store.ts…`, and the `?.trim()` scan
  `apps/web/lib/state-root.test.ts` now enforces). **The decision is genuinely yours:** AC4 specifies
  "when the controller initializes", so eager capture is what the AC asked for, and making the ceiling
  lazy is a behavior change to a shipped contract rather than a bug fix.
  **FIXED (fix pass 1) — reconciled, not traded off.** The import-time initialization AC4 asks for stays
  exactly as it was (`let policy: AdmissionPolicy = defaultAdmissionPolicy()` still runs at module
  evaluation, so the ceiling is present with no init call and the parse still cannot throw). What was added
  is `currentPolicy()`, which re-reads the ceiling from `envRoot` at every entry point
  (`acquireAdmission` / `releaseAdmission`'s `pump` / `admissionCeiling` / `admissionSnapshot`), so a value
  exported **after** the first import is now seen. An explicit `configureAdmission({ceiling})` **pins** it —
  deliberate code outranks an ambient variable — and `resetAdmission(env)` re-roots the read and unpins,
  which is also what makes a suite's `resetAdmission({})` immune to the shell it runs under. See
  Completion Note 12.

- [ ] **[Review][Decision]** `fanoutClamp` returns `binding: "pool-exhausted"` whenever `cap <= 0`, even
  when `capByProcess` alone is the zero term (`packages/core/src/budget.ts`, `fanoutClamp`'s early return,
  ≈`:74`). A surface rendering "the agent pool is full" would name the wrong cause when the real
  constraint is the process ceiling — the exact misstatement the `processCeiling` term was added to fix.
  **Yours to call because it is already a deliberate, tested contract:** `admission.test.ts`'s
  `"AC10 a zero process ceiling is pool-exhausted, and capByProcess is always reported"` pins it, so
  changing the label means changing a green assertion.

- [x] **[Review][Patch]** `resetAdmission` zeroes **live** occupancy behind a queue-only guard, minting
  capacity [`packages/core/src/admission.ts`, `resetAdmission` ≈`:239`]. With 4 slots held and the queue
  empty the guard does not fire; occupancy resets to zero, 4 more calls are admitted, and **8 concurrent
  model calls run against a ceiling of 4** — then the original 4 releases are absorbed silently by
  `Math.max(0, …)`, so occupancy under-reports permanently. `releaseAdmission`'s own comment two lines
  above states the invariant this breaks ("a double release must not MINT capacity (AC9)"). *(reproduced)*
  **FIXED (fix pass 1):** `resetAdmission` now throws when `sumMap(occupancy) > 0`, naming the classes
  still held. No force flag was added — a suite that trips it leaked a slot and should drain.
  Pinned by `"resetAdmission refuses to zero LIVE occupancy — a reset cannot mint capacity"` and
  `"the ceiling holds across a refused reset — never eight calls against a ceiling of four"`.

- [x] **[Review][Patch]** `cls` is trusted as a key into `occupancy` with no runtime validation
  [`packages/core/src/admission.ts`, `acquireAdmission` ≈`:211` / `releaseAdmission` ≈`:225`]. `sumMap`
  reduces only over `ADMISSION_CLASSES`, so any key outside it is invisible to `availableFor`: with 3 of 4
  slots held, **25 concurrent `acquireAdmission("bogus-N" as AdmissionClass)` calls are all admitted** and
  `admissionSnapshot().inFlight` still reads 3. Separately, acquiring under one class and releasing under
  another leaks the first class's slot for the life of the process while silently decrementing the second.
  `event-bus.ts`'s `declareEvents` adds exactly this guard for `deliveryClass`; admission has none. T-9's
  "mint an identity at the moment of the thing" argues for a slot handle rather than a bare class string.
  *(reproduced)*
  **FIXED (fix pass 1) — Failure (a) fully; Failure (b) structurally on the production path, with a
  documented residual (see the rebuttal in Completion Note 15).** `assertAdmissionClass` now guards
  `acquireAdmission` and `releaseAdmission` — the same posture `event-bus.ts` takes on `deliveryClass`, and
  here sharper because an out-of-enum key is invisible to `sumMap`; that closes (a) outright. For (b),
  `acquireAdmission` now **returns the release handle** for the slot it took (T-9: the identity is minted
  at the moment of the thing), and `engine.ts` — the only caller in `packages/core/src` — releases through
  it rather than naming the class a second time, so the shipped pair cannot disagree. What remains is that
  `releaseAdmission(cls)` is still exported and still trusts its argument; it cannot be made to detect a
  mismatch without breaking AC9. Pinned by
  `"acquireAdmission and releaseAdmission both refuse a class outside the enum"`,
  `"an out-of-enum class cannot slip 25 concurrent acquires past a full ceiling"`,
  `"the slot handle releases the class it actually took, and only once (T-9)"` and
  `"a queued waiter gets a handle for the slot pump() charged it"`.

- [x] **[Review][Patch]** `configureAdmission` accepts `ceiling <= 0`, wedging the controller unrecoverably
  [`packages/core/src/admission.ts`, `configureAdmission` ≈`:234`]. Nothing bounds `next.ceiling`. After
  `configureAdmission({ceiling: 0})` the next `acquireAdmission` queues and **never resolves**, and from
  then on *both* recovery seams — `configureAdmission` and `resetAdmission` — throw `waiters still queued`.
  No route back short of a process restart. This is T-4's "a stranded waiter takes the one-process run
  down", reachable *through* the guard written to prevent it. *(reproduced)*
  **FIXED (fix pass 1):** `configureAdmission` now rejects a `ceiling` that is not an integer `>= 1`,
  applying the same bound `readCeiling` applies to `TELAR_MAX_AGENTS`. The key is tested with
  `"ceiling" in next` rather than `!== undefined`, because the spread would otherwise write an explicit
  `undefined` straight into the policy. Pinned by
  `"configureAdmission refuses a ceiling that would wedge the controller"`.

- [x] **[Review][Patch]** `declareEvents` runtime-guards `deliveryClass` but not `payload`
  [`packages/core/src/event-bus.ts`, `declareEvents`'s validation loop ≈`:168`]. A declaration with the
  payload omitted **succeeds**; the first `publish` then throws
  `TypeError: undefined is not an object (evaluating 'decl.payload.safeParse')` from `publish` (≈`:247`) —
  an internal stack trace instead of the module's descriptive AD-21 error, surfacing in whichever module
  publishes rather than the one that mis-declared. Contradicts this file's own header claim that the
  payload shape is "enforced on every publish". *(reproduced)*
  **FIXED (fix pass 1):** the validation loop now refuses a declaration whose `payload` cannot validate a
  publish (`typeof decl.payload?.safeParse !== "function"`), and — same bypass, same failure mode — a whole
  entry that is `null`/`undefined`/not an object is now **named** instead of dereferenced. Both throw the
  module's descriptive AD-21 error at the moment the contract is broken, in the module that broke it.
  Pinned by `"the runtime guard covers the PAYLOAD too — a shapeless declaration is refused at declare time"`.

- [x] **[Review][Patch]** `"process"` is the unconditional final `else` of `fanoutClamp`'s new `binding`
  ternary [`packages/core/src/budget.ts`, `fanoutClamp` ≈`:81`]. `NaN !== NaN`, so every explicit
  comparison fails and any NaN-producing input lands on `"process"` — `fanoutClamp(5, {maxAgents:
  Infinity, inFlight: Infinity, …})` reports `binding: "process"` with **no `processCeiling` supplied**,
  where the pre-change formula reported `"budget"`. `admission.test.ts`'s otherwise-thorough AC10
  equivalence grid sweeps only finite `maxAgents`/`inFlight`, so it cannot see this. *(reproduced)*
  **FIXED (fix pass 1), label only.** `capByProcess === cap ? "process"` is now an explicit test like the
  other two, and the chain's final `else` is `"budget"` — the pre-`processCeiling` formula's own final
  else, so the no-ceiling answer is byte-identical for every input including a NaN cap (AC10). No value
  AC10 requires to be byte-identical was touched: `pieces`, `capByPool`, `capByBudget`, `capByProcess` and
  `chosen` are all unchanged, and `git show 578e5b4:packages/core/src/budget.ts` was re-read to confirm the
  old else. Pinned by `"AC10 a NaN cap still reports what it reported before the process term existed"`,
  and the AC10 equivalence grid now sweeps `Infinity` alongside the finite values — which is what made it
  blind to this in the first place.

- [ ] **[Review][Patch]** Neither `independentPieces` nor the new `processCeiling` is integer-validated, so
  `chosen` — documented as "the final n actually returned" — can be fractional
  [`packages/core/src/budget.ts`, `fanoutClamp` ≈`:65`/`:71`]: `processCeiling: 3.7` yields
  `chosen: 3.7`. `readCeiling` guards `Number.isInteger` for the same quantity. The `pieces` half is
  pre-existing and unchanged; `processCeiling` is new here and has no caller yet. *(reproduced)*

- [ ] **[Review][Patch]** `sessionDir`'s id guard permits uppercase and does not normalize case
  [`packages/core/src/sessions.ts`, `sessionDir` ≈`:56`], so on APFS `sessionDir("abc-session")` and
  `sessionDir("ABC-SESSION")` are different strings resolving to **one physical directory** — two
  logically distinct sessions sharing one `.runner-lease`, one's heartbeat overwriting the other's
  pid/token. Low risk today (ids are SDK UUIDs), and `session-log.ts`'s co-tenant resolver shares the
  property — which is another reason the two want collapsing into one shared resolver.

- [ ] **[Review][Patch]** `sessionDir` has no length bound on `sessionId` [same symbol]. A
  400-character regex-valid id passes the guard, then fails as a raw `ENAMETOOLONG` from `mkdirSync` deep
  inside `writeLease`, instead of the clean, catchable `invalid session id` the same guard already
  produces for every other malformed id.

- [ ] **[Review][Patch]** `publish`'s `catch { result.failed++ }` discards the error object entirely
  [`packages/core/src/event-bus.ts`, `publish`'s handler wrapper ≈`:278`]. A throwing subscriber is
  countable but undiagnosable — no message, no stack, nowhere. The posture itself was a decision this
  story delegated and the author documented, so this is not a breach; but `usage-ledger.ts` sets an
  in-house precedent for naming the swallowed failure.

- [ ] **[Review][Patch]** The compile-proof harnesses hard-code `packages/core/node_modules/typescript/bin/tsc`
  with no existence precondition [`packages/core/test/event-bus.test.ts`'s `REPO_TSC` ≈`:67`;
  `session-lease.test.ts`'s `REPO_TSC` ≈`:331`]. It resolves today, but a hoisting change would make six
  tests fail as "expected ok true" rather than "tsc not found". One
  `expect(fs.existsSync(REPO_TSC)).toBe(true)` makes the failure self-explaining.

- [ ] **[Review][Patch]** `expect(source).toContain("fs.watch")` couples a passing test to the wording of a
  header comment [`packages/core/test/event-bus.test.ts`, the T-1 source-scan test ≈`:453`]. The floor is
  well-intentioned — a scan whose target moved must not pass by matching nothing — but rewording the WHY
  block breaks the suite with no behavior change.

- [x] **[Review][Patch]** §6.3-8's `cd packages/core && bun test` line reports `7645 expect() calls`; the
  actual figure is **7651** [this file, Debug Log ≈`:1013`]. Re-measured twice: `1460 pass / 0 fail / 7651
  expect() calls / Ran 1460 tests across 105 files`. Every other number on that line matches exactly, and
  this file's own repo-root (9125) minus web (1474) figures imply 7651 — so only this tally is off. A
  six-count drift in the one section whose stated purpose is "paste real command output".
  **FIXED (fix pass 1):** the reviewer's figure was correct; the tally was corrected in place, and the
  whole §6.3-8 block re-measured after the fix pass (`1472 pass / 0 fail / 8429 expect() calls / 105
  files`). The repo-root run's own arithmetic still checks out: 8429 + 1474 = 9903, 1472 + 317 = 1789.

- [x] **[Review][Defer]** `writeLease`'s atomic-write temp path is `file + ".tmp"` with no
  pid/token/random suffix, so two writers to the same owner directory collide: B overwrites the shared tmp
  before A renames, A's `renameSync` promotes B's content, and B's own rename throws `ENOENT` — the
  surviving lease can name the wrong owner, which the header's MOAT paragraph does not account for
  [`packages/core/src/runner/lease.ts`, `writeLease` ≈`:60`] — deferred, pre-existing. `git diff` over this
  file shows only `loomDir` → `ownerDir` on the `mkdirSync` line, so the write path is byte-unchanged by
  this story. Flagged because this commit is what promotes `writeLease` to a shared two-lifetime primitive
  (AD-16) and adds `sessions.ts` as a second caller surface, multiplying the directories that can race.
  Recorded in `deferred-work.md`.

**Not changed by this review, and why:** story status was left at `review` rather than moved. The verdict
is PASS, so nothing here demands rework — but promoting 1.2 to `done` unblocks 1-3 and epics 4/5/6, and
whoever opens that gate should see the two `[Review][Decision]` items and the admission patches first.

---

## 5. Dev Notes

### 5.1 The architecture rules that bind this story

| Rule | What it obliges you to do here |
| --- | --- |
| **AD-14** — one event bus, every event carries a delivery class | A single typed in-process publish path in core. `agent-facing` may synthesize an assistant turn; `human-facing` renders on a surface the user arrives at and **never pushes**. The class is a **required field, not a convention** |
| **AD-21** — published event names are part of a module's port contract | Names and payload shapes are declared, versioned with the module, changed only deliberately. Cross-module subscription **only** to declared events; undeclared events are internal and nobody may subscribe |
| **AD-17** — one admission controller with per-class shares | Classes `loom-build` / `loom-verify` / `ultra` / `other`, weighted shares + entitlement floors under one configurable ceiling (`TELAR_MAX_AGENTS`, default 4). **Precedence, not a held-open slot.** Governs `agent()` concurrency only. `Charter.budget.maxAgents` is a per-loom clamp *within* a class |
| **AD-16** — one lease primitive, two lifetimes | One record (`{pid, token, ts}`, atomic temp+rename, heartbeat, stale-reclaim), generalized from `runner/lease.ts`. Loom leases live under the per-loom root and die at land; session leases live under `sessions/<sessionId>/` and die at session close. **Shape and reclaim semantics identical** |
| **AD-20** — shared runtime services are the sole writer of their own state | The bus's subscriptions and admission's accounting belong to no module's subtree. They are owned by their core service and written **only** through it. No module opens them |
| **AD-5** — one owner per `TELAR_HOME` subtree | `sessions/<sessionId>/` → owner: session. It holds session-scoped **runtime** state and does **not** replace `chats.json` |
| **AD-6** — persisted format follows artifact class | If any of this persists: human-editable → YAML, machine single-doc → JSON, append-only stream → NDJSON. **All non-append writes are atomic** (`.tmp` → `renameSync`). The bus persists nothing |
| **AD-2** — Verifier capability wall | `verifier.ts` / `critic.ts` / `verify-thread.ts` / `panel.ts` are granted no write or edit tools. T-A4 adds an admission tag beside those grants — **do not touch the grants** |
| **Design Law** — deterministic control flow in code | The admission policy half is **pure**: entitlement and the admit/deny decision take policy and occupancy as arguments. Non-determinism lives at injected seams (`now: () => number`, `io: LeaseFs`, `env` records), never inline in a control-flow function |

**And the NFRs that bind this story specifically** (from `epics.md` § Requirements Inventory). These are not
decoration — each one is a thing a reviewer will check:

| NFR | Obligation | Where it is discharged |
| --- | --- | --- |
| **NFR-RF-1** — reuse, never rebuild | The lease primitive, the atomic-write idiom and the `TELAR_HOME` expression all already exist. Copy the settled form; do not invent a variant | §5.4, T-C1, T-C2 |
| **NFR-RF-3** — built exactly once | The lease primitive and `sessions/<sessionId>/` are built **here and only here**; every later consumer composes over them | T-C1–T-C3, §3 |
| **NFR-RF-5** — nothing user-visible | No surface, no route, no component. A capability here that starts growing a surface has escaped the epic | §1, §3 |
| **NFR-RF-6** — the policy half is pure | `entitlement` / `availableFor` / `admissionCheck` take policy and occupancy as arguments: no I/O, no clock, no implicit module state | T-A1 |
| **NFR-RF-7** — admission governs `agent()` only | Interactive chat is out of band; long-lived processes take no slot; Ultra's run-local cap of 3 stays | T-A1, T-6, T-7 |
| **NFR-RF-8** — not a throughput change | Ceiling default stays 4; `ultra-runner.test.ts`'s `peak === 4` passes unchanged | AC8, T-A1 |
| **NFR-RF-9** — `processCeiling` is optional | The `pool → budget` tie-break is preserved so every current call site keeps byte-identical behavior | AC10, T-A3 |

### 5.2 Files to touch

| File | Action | What it is today → what changes | What must not break |
| --- | --- | --- | --- |
| `packages/core/src/admission.ts` | **NEW** | does not exist → the controller (T-A1) | — |
| `packages/core/src/event-bus.ts` | **NEW** | does not exist → the typed bus (T-B1) | — |
| `packages/core/src/sessions.ts` | **NEW** | does not exist → the session module + session lease (T-C2) | — |
| `packages/core/src/engine.ts` | UPDATE | holds `MAX_CONCURRENT = 4`, `active`, `waiters`, `acquire`, `release` — module-private, unexported, with the barging bug → admission calls + `AgentOpts.admissionClass` | `agent()`'s signature and `try`/`finally`; `accountEnv()`; `restrictTools`; `EngineEvent` |
| `packages/core/src/budget.ts` | UPDATE | `fanoutClamp(pieces, {maxAgents, inFlight, budgetLeftUsd, estCostPerAgent})` → `FanoutClamp {pieces, capByPool, capByBudget, chosen, binding}` → gains `processCeiling?` / `capByProcess` / `binding: "process"` | `fanoutSize`; `DEFAULT_MAX_AGENTS = 12`; the pool→budget tie-break; **all six call sites in four files unedited** (grep, don't count); `orchestrator.test.ts`'s `binding` assertions |
| `packages/core/src/runner/lease.ts` | UPDATE | per-loom lease: `LeaseFs`, `RunnerLease`, `leaseFile`, `writeLease`, `heartbeatLease`, `readLease`, `isLeaseFresh` → owner-neutral naming + both-lifetime contract | **every exported name is public `@telar/core` API**; `m5-lease.test.ts`; `m5-liveness.test.ts` |
| `packages/core/src/verifier.ts` | UPDATE | `agent(task, {schema: VerifierReport, tools: VERIFIER_TOOLS, restrictTools: true, …})` → adds `admissionClass: "loom-verify"` | the capability wall — tools/restrictTools/disallowedTools untouched |
| `packages/core/src/critic.ts` | UPDATE | `runCritic`'s schema-forced `run(...)` → adds `admissionClass: "loom-verify"` | same wall |
| `packages/core/src/ultra/runner.ts` | UPDATE | `runUltraAgent`'s schema'd branch delegates to `engineAgent` → adds `admissionClass: "ultra"`; stale `MAX_CONCURRENT` header prose replaced | the schema-less branch's documented non-participation; the fixed child posture |
| `packages/core/src/ultra/executor.ts` | UPDATE | header + `RUN_CONCURRENCY` comment cite `engine.ts:89`'s gate → cite admission instead | `RUN_CONCURRENCY = 3` and its `Semaphore` **stay**; behavior unchanged |
| `packages/core/src/index.ts` | UPDATE | flat barrel of `export * from "./x"` → three new lines + WHY comments | no name collision; `tsc --noEmit` clean in **both** workspaces |
| `packages/core/test/admission.test.ts` | **NEW** | re-homed reference suite + extensions (T-A5) | — |
| `packages/core/test/event-bus.test.ts` | **NEW** | T-B3 | — |
| `packages/core/test/session-lease.test.ts` | **NEW** | T-C4 | — |
| `packages/core/test/ultra-runner.test.ts` | **DO NOT EDIT** | holds `peak === 4` | AC8 requires it byte-identical |
| `bunfig.toml` | **DO NOT EDIT** | `pathIgnorePatterns` | §6 |

### 5.3 Read these before you write

Non-negotiable. Skipping this step is the primary cause of implementation failures and review cycles here.

- `_bmad-output/specs/spec-runtime-foundations/admission.md` — the full admission contract **including the
  rejected design**. Read all of it.
- `_bmad-output/specs/spec-runtime-foundations/reference/admission-impl/admission.ts`,
  `admission.test.ts`, `core-changes.patch` — a complete, previously-passing implementation, deliberately
  reverted so it lands as reviewed work. **Reference, not authority.** The patch is **unapplied**: every
  file it touches is still in its pre-admission state.
- `packages/core/src/engine.ts` — read `AgentOpts` and `agent()` end to end before editing.
- `packages/core/src/budget.ts` — the whole file; it is short and the tie-break is subtle.
- `packages/core/src/runner/lease.ts`, `runner/liveness.ts`, `runner/recover.ts` — the lease, its only
  consumer, and the reconciler whose comment states the invariant you must preserve.
- `packages/core/src/usage-ledger.ts` — read its **header block** specifically. It is the closest in-repo
  model for a core-owned shared-runtime-service port: it states its own port-ownership rule (AD-20), its
  deliberate deviation from the atomic-write idiom, and why. Your three new modules want headers of that
  quality.
- `packages/core/src/looms.ts` — `telarDir` / `loomsDir` / `loomDir` and the path-traversal guard you are
  mirroring in `sessions.ts`.
- `packages/core/src/manifest.ts` — `telarDir()` and the exported `atomicWrite(file, data)`.

### 5.4 Patterns and conventions — copy these exactly

- **Runtime & tooling.** Bun workspaces, **Bun only** (no npm/yarn/pnpm). `bun.lock` is mutated only by
  `bun install` / `bun add`. `@telar/core` is ESM with **no build step** (`exports["."] → ./src/index.ts`),
  TypeScript `^6.0.3`; `apps/web` pins TypeScript `^5` — **deliberately not unified**, so a type crossing the
  boundary must typecheck under both. Every command runs **inside a workspace dir**; there is no root
  `scripts` block. (`bun test` from the repo root is the *binary*, not a script — it works and is used in §6.)
- **No new dependencies.** Nothing here needs one. `zod ^4.4.3` is already a core dependency; there is no
  event-emitter library in either workspace and none should be added.
- **WHY header comments.** Non-obvious modules carry a header block explaining *why*, not *what*. House
  voice, from `manifest.ts`: `// Project manifests (telar.yaml in each repo) + global registry
  (~/.telar/projects.json). // The repo owns its manifest; the registry only remembers where repos live.`
  Follow this for all three new modules; each is subtle enough to earn one.
- **State root.** New **core** code imports `telarDir` from `./manifest` (the `vcs.ts` precedent). Do **not**
  re-declare the expression — five deliberate copies already exist and the duplication is separately tracked.
  The settled expression, for recognition only:
  `const v = process.env.TELAR_HOME?.trim(); return v ? path.resolve(v) : path.join(os.homedir(), ".telar");`
  Note the `?.trim()` — a raw read is the exact defect that blocked story 1.1's review, and
  `apps/web/lib/state-root.test.ts` now runs a repo-wide source scan requiring every `process.env.TELAR_HOME`
  read to go through it. **Your new code will be scanned by that test.**
- **Atomic writes.** `.tmp` → `fs.renameSync` for every non-append store. `manifest.ts` exports
  `atomicWrite(file, data)` (mkdir + tmp + rename) and `servers.ts` imports it — reuse it rather than
  inlining a seventh copy, unless you need something it does not provide (`secrets.ts` inlines its own only
  because it needs `chmod 0600`; `runner/lease.ts` inlines its own only because it needs the injectable
  `LeaseFs`).
  **The append-only exception:** `usage-ledger.ts`, `session-log.ts` and the loom/ultra `events.ndjson`
  journals use bare `appendFileSync` **deliberately**. Do not "fix" those. It does not apply to you — the
  bus persists nothing and a lease is a single-document store.
- **zod.** House idiom: `export const X = z.object({…}); export type X = z.infer<typeof X>;`. Schemas for
  persisted entities are owned by `@telar/core` and never redefined in `apps/web`.
- **Barrel.** `packages/core/src/index.ts`, flat `export * from "./x"`, WHY comment only where a rule or a
  collision needs stating.
- **Injected seams.** The house shape for non-determinism is a trailing defaulted parameter:
  `now: () => number = Date.now`, `io: LeaseFs = fs`, `env: Record<string, string|undefined> = process.env`.
  Use it. It is what makes these modules testable without mocking.
- **Tests.** `bun test` (`bun:test`) is the **only** tooling — no jest, no vitest, no Playwright dev suite.
  Core specs live **flat** in `packages/core/test/`, no subdirectories.
  Import line, the most common form in the suite:
  `import { afterAll, beforeEach, describe, expect, test } from "bun:test";`
  **`test(...)`, never `it(...)`** — zero of the 102 core test files use `it(`.
  `TELAR_HOME` sandbox idiom:
  ```ts
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-<prefix>-"));
  process.env.TELAR_HOME = home;
  beforeEach(() => { process.env.TELAR_HOME = home; }); // bun runs all files in ONE process
  afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });
  ```
  If your suite imports a module that could capture the root at evaluation time, pin **before** the import
  with `await import("../src/…")` — static imports are hoisted and evaluated first. Story 1.1 fixed four
  suites for exactly this and it is now the settled convention.
- **Formatting.** No Prettier, no Biome. ESLint exists only in `apps/web`. **Match surrounding style
  exactly** — that is the whole standard in `packages/core`.
- **Commits.** Conventional prefix + scope, explaining WHY: `feat(core): …`, `fix(core): …`.
- **No CI.** The gate is manual and is yours to run (§6).

### 5.5 Design decisions already made for you

These are settled so you do not spend budget re-deriving them. **The semantics are binding; symbol names may
be adjusted if the barrel collides — say so in Completion Notes if you change one.**

**Admission — take the reference shape.** `AdmissionPolicy = { ceiling, weight: ClassMap, floor: ClassMap,
priority: readonly AdmissionClass[] }`. Weights `{loom-build:3, loom-verify:2, ultra:2, other:1}`, floors
`{loom-build:1, loom-verify:1, ultra:1, other:0}`, priority `["loom-verify","loom-build","ultra","other"]`,
`entitlement = max(floor, ⌊ceiling × weight / totalWeight⌋)` guarded against a zero total weight.
At the default ceiling of 4 the floors dominate and this degenerates to *one each, borrow the rest* — that
is **correct on a 4-slot machine, not a flaw**. The pump is: pass 1 admits entitled waiters in class-priority
order (FIFO within a class); pass 2 lets the FIFO-first waiter borrow if capacity remains and nobody was
entitled. **The slot is taken before the waiter is woken** — that is what closes AC6 by construction.
Arrivals never barge a non-empty queue.

**Event bus — recommended shape.** A declaration is the unit of contract:

```ts
export type DeliveryClass = "agent-facing" | "human-facing";

export type EventDeclaration<P extends z.ZodTypeAny = z.ZodTypeAny> = {
  deliveryClass: DeliveryClass;  // REQUIRED — AC1 lives on this field
  payload: P;                    // AD-21: payload shapes are part of the contract
};

// A module declares its whole catalogue at once, keyed by the bare fact.
// The full event name is `${module}:${fact}` — minted here, never hand-written,
// so a module structurally CANNOT declare into another module's namespace.
export function declareEvents(
  module: string,
  decls: Record<string, EventDeclaration>,
): void;

export function publish(name: string, payload: unknown): void;
export function subscribe(name: string, handler: (payload: unknown) => void): () => void;
export function subscribeAgentFacing(name: string, handler: (payload: unknown) => void): () => void;
export function resetBus(): void;
```

- **`declareEvents(module, decls)`** — keyed map, not an array, and the **name is composed here**
  (`${module}:${fact}`) rather than supplied. That is deliberate: it makes "a module may not declare an
  event in another module's namespace" true by construction instead of by a validation rule someone can
  forget. AD-21 is the reason — event names are a published contract, and namespace ownership is the part
  of that contract nothing else enforces. If you instead take a pre-composed `name`, you **must** throw
  when it does not start with `` `${module}:` `` — and you must test that. Composing is simpler; prefer it.
- Re-declaring a name: an error, or an idempotent no-op. **Pick one, document it in-source, assert it.**
  (This one genuinely is your call — the sources do not decide it.)
- **`publish(name, payload)`** throws on an undeclared name and validates the payload against the
  declaration's zod schema.
- **`subscribe(name, handler)`** throws on an undeclared name; returns an unsubscribe function.
- **`subscribeAgentFacing(name, handler)`** — **the wake channel.** It throws if the declared class is
  `human-facing`, and `publish` never routes a `human-facing` event to it. This is what makes AC2's
  "provably pushes nothing" structural rather than documented.
- Delivery is **synchronous fan-out over a copied subscriber list**, each handler wrapped so one throwing
  subscriber cannot break `publish` or starve its siblings. (Copy the list first: a handler that
  unsubscribes during delivery must not shift the array being iterated.)
- `resetBus()` clears declarations and subscriptions — the one-process test seam.
- Typing beyond this sketch is yours. A generic that infers the payload type from the declaration at the
  `publish`/`subscribe` call site is a real improvement and is welcome — the sketch uses `unknown` so the
  *contract* is unambiguous, not because a loose type is the goal.

**Lease — the generalization is a second root, not a second implementation.** `runner/lease.ts`'s functions
already take a bare directory. So: keep them, rename the parameter to be owner-neutral, and add
`sessions.ts`'s `sessionDir(id)` as the second root that gets passed into the **same** functions.
`leaseFile` keeps returning `<dir>/.runner-lease` on both paths. The reclaim decision is a pure function
whose return union cannot express success.

**Where the session lease file goes.** `TELAR_HOME/sessions/<sessionId>/.runner-lease`. Not
`services/<name>.json` — that is the per-owner service-lease registry, epic 6's, explicitly out of scope
here (§3).

### 5.6 Traps

- **T-1 — Do not derive events by watching the filesystem.** It is the tempting design (state is already the
  source of truth and atomic renames are watchable) and it is explicitly forbidden twice: a watcher reads
  every module's subtree by path, which inverts AD-5/AD-20, and fs-watch semantics differ between the Next
  dev server and the packaged Electron app.

- **T-2 — The reference patch's comments carry the vocabulary of the rejected design.** `critic.ts`
  ("the same reserved class as the verifier proper"), `verifier.ts` ("Competes in the reserved class"),
  `ultra/runner.ts` ("never eats the verify reservation"). There is **no reservation**. Reword to
  precedence. See T-A4.

- **T-3 — `TELAR_HOME/sessions/<sessionId>/` is not empty ground, and the SPEC does not say so.**
  `apps/web/lib/session-log.ts` **already** creates and writes that exact directory today: its private
  `home()` → `sessionDir(sessionId)` → `logFile(sessionId)` = `<TELAR_HOME>/sessions/<id>/live.ndjson`,
  written with `mkdirSync` + truncating `writeFileSync` + `appendFileSync` (no tmp+rename — it is the
  append-only live-tail class).
  **Ruling for this story, so you do not have to make it:**
  - Core owns the **lease file**; `session-log.ts` keeps owning `live.ndjson`. Different files, same
    directory, `mkdirSync(..., {recursive: true})` is idempotent — coexistence is safe and is **not** a
    reason to cross into `apps/web`.
  - **Do not edit `session-log.ts`.** It is Track B/C's file.
  - `sessions.ts`'s `sessionDir()` **must produce the byte-identical path** `session-log.ts` produces, or
    the two split-brain the directory. Pin it with a literal-string assertion
    (`<TELAR_HOME>/sessions/<id>`), not by comparing against an import you cannot reach from core.
  - One deliberate asymmetry to record in-source: core's resolver **guards the id** and
    `session-log.ts`'s does not, so core **fails closed** on an id `session-log.ts` would happily write.
    That is the safer direction, and it is a stated choice rather than an accident.
  - **Record this collision in Completion Notes**, the way story 1.1 recorded its AC6 cross-track finding.
    It is a genuine hole in `WORK-SPLIT`'s disjoint-write-set guarantee — AD-5 assigns `sessions/` to the
    session module while an `apps/web` module already writes there — and epics 2 and 3 should know.

- **T-4 — Module-level singleton state meets one-process test runs.** `admission.ts`'s policy/occupancy/queue
  and the bus's registry are module singletons. `bun test` runs **every file in one process**, so state
  leaks across files. Every new suite resets in `beforeEach`, and **a test that leaves a waiter queued will
  make `resetAdmission` throw and take the run down**. Drain your waiters.

- **T-5 — The gate you are replacing has a real bug; do not carry it forward.** `release()` decrements and
  schedules a waiter's resumption as a microtask; an `acquire()` landing in that window takes the slot, and
  the woken waiter then does `active++` with no re-check. `active` ends above the ceiling, by one per barging
  arrival. Taking the slot before waking is the fix. (This is AC6, and it is why AC6 is phrased as a race,
  not as a feature.)

- **T-6 — `ultra/executor.ts`'s `RUN_CONCURRENCY = 3` stays.** It is a legitimately different thing: a
  per-run fan-out limit stacked on top of admission, not a competitor to it. Do not fold it in, do not
  delete it, do not "unify" the two semaphores.

- **T-7 — Interactive chat sessions never enter this gate, by design.** They call the SDK's `query()`
  directly from the chat route and never reach `engine.agent()`. There is no `interactive-session` class and
  a reserved slot for one would reserve nothing. The architecture spine originally claimed otherwise and the
  code disproved it.

- **T-8 — The barrel is flat.** `export *` collisions surface as confusing type errors, sometimes only in
  `apps/web`. Typecheck **both** workspaces after T-D1.

- **T-9 — Keys name events, not slots.** Story 1.1 shipped three successive idempotence keys derived from a
  position (`attempt:<loomId>:<index>`, then `+startedAt`, then `ultra:<runId>:<ordinal>`) and **each one was
  a silent money-loss regression measured worse than baseline**. If anything you build needs an identity —
  a subscription handle, a dedupe key, a lease token — **mint it at the moment of the thing**, never derive
  it from an array index, an ordinal, or a recomputed count.

- **T-10 — No NUL bytes, no raw control characters in source.** A literal `\x00` in `usage-ledger.ts` made
  a 263-line module **binary to git and invisible to grep** — the diff rendered as `Bin 0 -> 11047 bytes`
  with zero reviewable lines. If you need a separator in a key, write the escape sequence.

---

## 6. Testing requirements

### 6.1 The rule this story exists under

`bunfig.toml`'s `[test] pathIgnorePatterns = ["**/release/**", "**/.next-desktop/**", "**/_bmad-output/**"]`
excludes `_bmad-output/` from test discovery. The reference implementation you are adopting **lives inside
that excluded tree**, and the story 1.1 reviewer predicted, by name, that story 1.2 would re-apply that
reference and then report a green gate with its own tests invisible to the runner.

**Therefore:**

1. **Do not edit `bunfig.toml`.** Not to add a pattern, not to remove one. It is an unresolved
   `[Review][Decision]` on story 1.1 and it is the human's call, not yours. Prove you did not touch it:
   `git diff --stat -- bunfig.toml` must print nothing.
2. **Every test file you add lives under `packages/core/test/`**, flat, no subdirectories.
3. **Every test you add must be proven DISCOVERED by name, in the repo-wide run.** Passing when pointed at
   directly is not evidence — a file that is excluded from discovery still passes perfectly when named
   explicitly. Discovery is the property under test.

### 6.2 How to prove discovery — verified commands, real output

Bun `1.3.14`. `bun test` from the **repo root** works and discovers both workspaces; it is the binary, not a
package script, so the "every command runs inside a workspace dir" convention does not apply to it.

**Baseline first — measure, do not quote.** Counts in this repo drift silently and `project-context.md`
says so outright. Measure yours before you start:

```
ls packages/core/test/*.test.ts | wc -l      # pointer, measured 2026-07-26 at 578e5b4: 102
bun test 2>&1 | tail -3                       # pointer: "Ran 1704 tests across 113 files"
```

**Proof mechanism 1 — name pattern (per-suite spot check).** From the repo root:

```
bun test -t "<exact test name>"
```

- Discovered: exits `0`, prints e.g.
  `1 pass / 1703 filtered out / 0 fail … Ran 1 test across 113 files.`
  **The `across N files` figure is half the proof** — it says the whole tree was searched, not a subset.
- Not discovered: exits **`1`** with
  `error: regex "<name>" matched 0 tests. Searched 113 files (skipping 1704 tests)`.
  This is a hard failure, not a silent pass.
- `-t` matches by **regex** — escape metacharacters in a test name, or pick names without them.

This mechanism was validated against the exact failure mode you are guarding: temporarily adding
`"**/core/test/**"` to `pathIgnorePatterns` made the same command for the same real test name report
`Searched 11 files` instead of `113`. It catches the regression.

**Proof mechanism 2 — junit reporter (whole-suite proof, use this for the bulk).** From the repo root:

```
bun test --reporter=junit --reporter-outfile=<scratch>/discovery.xml
grep -F '<exact test name>' <scratch>/discovery.xml
```

The XML lists **every** discovered test, passing or failing, with its source file:

```xml
<testcase name="heartbeatLease refreshes ts, keeps pid/token" classname="lease round-trip"
          time="0.000756" file="packages/core/test/m5-lease.test.ts" line="20" assertions="2" />
```

**Check the `file=` attribute**, not just the name — it is what proves the test the runner executed is the
one at `packages/core/test/…` and not a copy somewhere else.

### 6.3 What the Debug Log must contain

Paste **real command output**, not a description of it. A summary of a run you did not paste is the failure
mode this section exists to prevent.

- [x] `git diff --stat -- bunfig.toml` → **empty**
- [x] `git diff --stat -- packages/core/test/ultra-runner.test.ts` → **empty** (AC8)
- [x] Baseline vs. final file count: `ls packages/core/test/*.test.ts | wc -l` before and after. The delta
      must equal the number of test files you added. A file you created that does not move this number is
      not being discovered.
- [x] Repo-root `bun test` — full output tail, including `Ran N tests across M files`. **M must have grown
      by the number of files you added.** A flat `M` with a grown `N`… is impossible; a flat `M` and a flat
      `N` means your tests are invisible and the gate is lying.
- [x] The junit run + a `grep -F` hit for **every new test name**, showing the `file=` attribute.
- [x] At least one `bun test -t "<name>"` spot check **per new suite**, with the `across N files` line.
- [x] One **negative control**: `bun test -t "a name that does not exist zzz"` showing the exit-1 /
      `matched 0 tests` behavior, so the reader knows your positive results mean something.
- [x] `cd packages/core && bun test` → pass/fail counts.
- [x] `cd packages/core && bunx tsc --noEmit` → exit 0.
- [x] `cd apps/web && bunx tsc --noEmit` → exit 0. **Both** workspaces; the barrel reaches `apps/web`.
- [x] `apps/web`'s `bun test` → green. `apps/web/lib/state-root.test.ts` runs a repo-wide source scan over
      `packages/core/src` requiring every `process.env.TELAR_HOME` read to go through `?.trim()`. If your new
      code reads it raw, **this is where it fails** — and it is a web-suite failure caused by a core file,
      which is confusing if you are not expecting it.
- [x] `bun run lint` is **not** a clean baseline (~77k pre-existing problems, mostly under
      `.next-desktop/`) and is not this story's to fix. Lint only files you touched, if any are in `apps/web`
      — none should be.

### 6.4 Coverage the suites must actually carry

Beyond the reference 22, these are required because an AC names them:

- **AC1** — a declaration missing its class does not compile. Assert the runtime guard *and* record the type
  that makes it unrepresentable; a runtime-only check does not satisfy the AC.
- **AC2** — both directions: `human-facing` on the wake channel is refused; a `human-facing` publish reaches
  ordinary subscribers and never a wake handler. **Verify the test is load-bearing by deleting the filter
  and re-running** — story 1.1's repair rounds found more than one green test that asserted nothing, and
  adopted "revert the fix, watch the test fail" as the standard.
- **AC3** — both `subscribe` and `publish` reject an undeclared name.
- **AC5** — `admissionSnapshot()` "names why": priority order and waiting-by-class are both readable, and
  the snapshot does **not** leak mutable internals (mutating the returned object must not change the
  controller).
- **AC9** — double release floors at zero; `configureAdmission` and `resetAdmission` both throw with waiters
  queued.
- **AC10** — no-`processCeiling` behavior is unchanged **and** `pieces=12, ceiling=4` gives
  `chosen: 4, binding: "process"`, **and** a case where pool or budget is tighter still reports `pool` /
  `budget` (the tie-break, which is where a regression would hide).
- **AC11** — the three proofs listed under AC11, including the structural "cannot say done" assertion.

---

## 7. Previous story intelligence — what 1.1 cost, so it doesn't cost again

Story 1.1 (`packages/core/src/usage-ledger.ts`, `apps/web/lib/store.ts`) landed across five commits and
then took **four adversarial repair rounds**. What generalizes:

- **A key that names a slot is a bug.** Three successive idempotence keys were derived from a position and
  each opened a new silent money-loss regression *measured worse than baseline*. See §5.6 T-9.
- **A line number is not a name.** Every line-number citation in that story's record drifted, some within
  the round that wrote them, including one re-measured three separate times. Hence this file's citation
  policy.
- **A green test can assert nothing.** Two of that story's load-bearing tests used a seam production never
  produces (`child.attempts = [...]` where production `push`es), so the finding they were meant to guard
  stayed green underneath them. **Verify a new guard is load-bearing by reverting the fix and watching it
  fail** — do this for at least AC2's class filter and AC6's race guard.
- **Comments that claim more than the code guarantees cause the next agent to "restore" a removed guard.**
  Two rounds were spent on exactly that. Hence T-A6.
- **A guard must read the same value as the thing it guards.** The blocking finding was a guard reading raw
  `process.env.TELAR_HOME` while the resolver read `?.trim()` — one whitespace-only value slipped a
  synthetic billing line into the operator's real `~/.telar`.
- **What 1.1 built that you inherit and must not duplicate:** `usage-ledger.ts` (the sole reader/writer of
  `usage.ndjson`, with `logUsage` / `usageSummary` / `ledgerSpendUsd` / `ledgerReadUnavailable` /
  `ledgerReadDegraded`), `UsageEntry` + `UsageOwnerKind` in `schemas.ts`, `stateRoot()` in
  `apps/web/lib/store.ts`, and the `?.trim()` guard in all five root resolvers. Nothing in this story
  touches spend.
- **Still open from 1.1, not yours:** the root-loom under-count; two `readFold` residuals; unbounded
  in-process ledger retention; `git-tab.ts`'s 2 NUL bytes; five `[Review][Decision]` items — one of which is
  the `bunfig.toml` exclusion (§6). Do not resolve any of them here.

**Git intelligence** (`git log 9689844..578e5b4`): six commits, conventional prefixes with scopes and
WHY-carrying bodies — `feat(core): move the spend ledger into a core-owned, owner-attributed port`,
`fix(web): make the per-turn spend readout a ledger projection, not a counter`,
`fix(core): make the ledger's test write-guard read the root it actually writes to`. New core ports arrive
as one module + one barrel line + one dedicated flat test file. Match that.

---

## 8. References

- `_bmad-output/planning-artifacts/epics.md` § "Story 1.2: The event bus, admission control, and the lease
  primitive" — the ACs above verbatim, plus the dev-server proof line and dispatch notes.
- `_bmad-output/specs/spec-runtime-foundations/SPEC.md` — CAP-3, CAP-4, CAP-5; Constraints; Non-goals.
- `_bmad-output/specs/spec-runtime-foundations/admission.md` — **the admission authority**, incl. the
  rejected reservation design and its Acceptance list.
- `_bmad-output/specs/spec-runtime-foundations/brownfield.md` — "Reuse, never rebuild" and "The gaps this
  SPEC closes".
- `_bmad-output/specs/spec-runtime-foundations/reference/admission-impl/` — `admission.ts`,
  `admission.test.ts` (22 cases), `core-changes.patch`. Reference, not authority. Unapplied.
- `_bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md` —
  AD-2, AD-5, AD-6, AD-14, AD-16, AD-17, AD-20, AD-21; the Consistency Conventions table (event naming);
  the state-root tree.
- `.../SOLUTION-DESIGN.md` § "Runtime: the collision nobody's spec saw" — why precedence beat reservation,
  and the pre-existing over-ceiling bug.
- `.../WORK-SPLIT.md` — Track A's write set; A3 → D/E/F is a real serialization point (nobody declares
  events before this bus exists).
- `_bmad-output/project-context.md` — stack versions, the Human-Accept Moat, the Verifier capability wall,
  the append-only-stream exception, the testing section.
- `_bmad-output/implementation-artifacts/stories/1-1-state-root-isolation-and-the-attributed-spend-ledger.md`
  — Review Findings and Repair Rounds 1–4.
- `_bmad-output/implementation-artifacts/deferred-work.md` — the citation policy this file inherits; the
  `TELAR_HOME` duplication entry.
- `_bmad-output/implementation-artifacts/orchestrator-run-log.md` § "Carry-forward hazards" — the
  test-discovery hazard §6 answers.

---

## 9. Dev Agent Record

### Agent Model Used

Claude Opus 5 (`claude-opus-5`), Claude Code CLI, effort `xhigh`. Run unattended end to end: every
"halt / ask / present options" checkpoint in the `bmad-dev-story` skill was resolved by the agent and
recorded below rather than surfaced. All decisions taken autonomously are listed in Completion Notes.

### Debug Log

Real output, pasted. Commands run from the repo root unless a `cd` is shown. Bun `1.3.14`.

**Baseline, measured at `578e5b4` before any edit (not quoted from the story):**

```
$ ls packages/core/test/*.test.ts | wc -l
     102
$ bun test   # tail
 1704 pass
 0 fail
 6474 expect() calls
Ran 1704 tests across 113 files. [28.08s]
```

**§6.3-1 — `bunfig.toml` untouched.**

```
$ git diff --stat -- bunfig.toml
$ git status --porcelain bunfig.toml
$
```
Both print nothing. `bunfig.toml` is neither modified nor staged.

**§6.3-2 — AC8: `packages/core/test/ultra-runner.test.ts` byte-identical.**

```
$ git diff --stat -- packages/core/test/ultra-runner.test.ts
$ git status --porcelain packages/core/test/ultra-runner.test.ts
$
```
Empty. The file is not in the staged change set either (see §10). Its `expect(peak).toBe(4)` passes
unchanged with `admissionClass: "ultra"` now tagged on `runUltraAgent`'s schema'd branch: `ultra`'s
entitlement at ceiling 4 is 1, the borrow pass lends it the other three, and the 4 remaining calls queue.

**§6.3-3 — file count before/after. Delta 3 = the three suites added.**

```
$ ls packages/core/test/*.test.ts | wc -l
     105          # baseline 102
```

**§6.3-4 — repo-root `bun test`, full tail. `M` grew 113 -> 116, `N` grew 1704 -> 1777 (+73 = 31+26+16).**

```
$ bun test   # tail
 1777 pass
 0 fail
 9125 expect() calls
Ran 1777 tests across 116 files. [30.55s]
$ echo $?
0
```

**§6.3-5 — junit discovery proof, checked by name AND by `file=` attribute, for EVERY new test.**

```
$ bun test --reporter=junit --reporter-outfile=<scratch>/discovery.xml   # tail
 1777 pass
 0 fail
Ran 1777 tests across 116 files. [30.71s]

$ # <testcase> elements carrying each new file's path:
admission.test.ts      31
event-bus.test.ts      26
session-lease.test.ts  16
total new: 73
```

Two representative rows, showing the `file=` attribute is the one under `packages/core/test/` (not a copy
inside the excluded `_bmad-output/` tree):

```xml
<testcase name="gives a freed slot to loom-verify ahead of a queued build fan-out"
          classname="the queue" file="packages/core/test/admission.test.ts" line="281" />
<testcase name="AC11 `done` is NOT assignable to LeaseReclaim — the moat, checked by tsc"
          classname="AC11.3 — the union is pinned against the compiler, not just against behavior"
          file="packages/core/test/session-lease.test.ts" line="374" />
```

Rather than eyeballing 73 rows, every `test("...")` in the three new files was extracted from source and
required to appear in the XML on a `<testcase>` whose `file=` is that same file:

```
packages/core/test/admission.test.ts
  31 tests | missing-by-name=0 | not-attributed-to-this-file=0
packages/core/test/event-bus.test.ts
  26 tests | missing-by-name=0 | not-attributed-to-this-file=0
packages/core/test/session-lease.test.ts
  16 tests | missing-by-name=0 | not-attributed-to-this-file=0
TOTAL PROBLEMS: 0
```

**§6.3-6 — one `-t` spot check per new suite. `across 116 files` is half the proof.**

```
$ bun test -t "gives a freed slot to loom-verify ahead of a queued build fan-out"
 1 pass / 1776 filtered out / 0 fail
Ran 1 test across 116 files. [304.00ms]        # exit 0

$ bun test -t "unsubscribe stops delivery"
 1 pass / 1776 filtered out / 0 fail
Ran 1 test across 116 files. [289.00ms]        # exit 0

$ bun test -t "AC11 heartbeat keeps pid/token and moves ts, identically on both paths"
 1 pass / 1776 filtered out / 0 fail
Ran 1 test across 116 files. [292.00ms]        # exit 0
```

**§6.3-7 — negative control, so the three passes above mean something.**

```
$ bun test -t "a name that does not exist zzz"
error: regex "a name that does not exist zzz" matched 0 tests. Searched 116 files (skipping 1777 tests)
$ echo $?
1
```

**§6.3-8/9/10/11 — workspace runs and both typechecks.**

```
$ cd packages/core && bun test   # tail
 1460 pass
 0 fail
 7651 expect() calls
Ran 1460 tests across 105 files. [29.14s]      # exit 0

$ cd packages/core && bunx tsc --noEmit ; echo $?
0

$ cd apps/web && bunx tsc --noEmit ; echo $?
0

$ cd apps/web && bun test   # tail
 317 pass
 0 fail
 1474 expect() calls
Ran 317 tests across 11 files. [1487.00ms]
```

`apps/web/lib/state-root.test.ts`'s repo-wide `process.env.TELAR_HOME` scan is green: the only new core
module that resolves the state root is `sessions.ts`, and it **imports** `telarDir` from `manifest.ts`
rather than adding a sixth copy of the expression, so it contributes no raw read for the scan to catch.

**§6.3-12 — lint.** `bun run lint` is not a clean baseline (~77k pre-existing problems, mostly under
`.next-desktop/`) and is not this story's to fix. Lint applies only to `apps/web`; this change touches
**no** `apps/web` file, so there is nothing here for it to cover. Not run.

**AC10 — the six call sites left unedited, re-measured rather than hand-counted:**

```
$ grep -rn "fanoutClamp(\|fanoutSize(" packages/core/src/ | grep -v "^packages/core/src/budget.ts"
packages/core/src/executor.ts:2511:    const chosen = fanoutSize(ranked.length, clampArgs);
packages/core/src/executor.ts:2716:                if (fanoutSize(1, { ...perStepClamp, budgetLeftUsd: sliceLeftUsd }) < 1) {
packages/core/src/executor.ts:2888:  const n = fanoutSize(step.agents.length, clamp); // same pool-slice clamp
packages/core/src/repair-guard.ts:165:  const clamp = fanoutClamp(1, {
packages/core/src/tick.ts:263:    const fanout = fanoutClamp(ready.length, {
packages/core/src/build-fanout.ts:111:  return fanoutSize(pieceCount, args);

$ git diff --stat -- packages/core/src/repair-guard.ts packages/core/src/tick.ts \
                     packages/core/src/executor.ts packages/core/src/build-fanout.ts
$
```
Six sites, four files, all unedited — matching the story's pointer exactly this time.
`orchestrator.test.ts`'s three `binding` assertions are green in the run above.

---

#### Load-bearing probes — "revert the fix, watch the test fail"

**AC6 — the race guard. Probe 1 was NOT faithful and is reported as such.**

First attempt reverted two surface details (`wake()` before `occupancy++` in `pump`, and dropping the
`queue.length === 0` no-barge check). **All 31 tests still passed.** That is not a green light — it means
the revert did not reproduce the bug, because `wake()` is `Promise.resolve` and only *schedules* a
microtask, so the slot was still taken synchronously either way.

Probe 2 reverted to the **actual shape of `engine.ts`'s old gate** — the arrival barges, and the woken
waiter does its own `occupancy[cls]++` in its own continuation with no re-check:

```
$ bun test packages/core/test/admission.test.ts   # against the faithful revert
(fail) the queue > AC6 the slot is taken BEFORE the waiter wakes — a synchronous barge cannot over-commit
(fail) the queue > gives a freed slot to loom-verify ahead of a queued build fan-out
(fail) the queue > AC5 admissionSnapshot NAMES WHY: priority order and waiting-by-class are both readable
(fail) the queue > does not idle a slot when every waiter is over its entitlement
(fail) the queue > release is idempotent below zero — a double release cannot mint capacity
(fail) the queue > AC9 a double release of a HELD slot floors at zero rather than lending one out
(fail) the queue > refuses to reconfigure while waiters are queued
(fail) the queue > snapshot does not leak mutable internals
(fail) (unnamed)
 23 pass / 9 fail

$ bun test packages/core/test/admission.test.ts -t "AC6 the slot is taken BEFORE the waiter wakes"
260 |     expect(admissionSnapshot().occupancy["loom-build"]).toBe(4);
error: expect(received).toBe(expected)
Expected: 4
Received: 3
 0 pass / 1 fail
```

`admission.ts` was then restored and byte-compared against a pre-probe copy (`diff` → identical), and the
suite re-run: 31 pass / 0 fail.

**FINDING, recorded because it matters to the reviewer: the SPEC reference suite's own AC6 case —
`"never exceeds the ceiling, even when arrivals race a release"` — PASSES against that faithful revert.**
It is not in the failure list above. Every `releaseAdmission` in it lands before any woken waiter resumes,
so the overlap it is named for never actually forms. It is the case §2's AC6 Proof cites, so it is kept
(it is a real smoke test of the fixed controller), but a caveat comment now sits above it naming the added
`AC6 the slot is taken BEFORE the waiter wakes …` as the load-bearing pin.

**AC2 — the delivery-class filter.** `canWake`'s body replaced with `=> true`:

```
$ bun test packages/core/test/event-bus.test.ts   # with the filter deleted
(fail) AC2 — the class-gated wake channel > AC2 registering a human-facing event on the wake channel is REFUSED
(fail) AC2 — the class-gated wake channel > AC2 canWake IS the gate — one rule, read by both the registration and the publish side
 22 pass / 2 fail
```
Restored (`diff` → identical), 26 pass / 0 fail. The **registration** side is the load-bearing guard. The
publish-side branch (`if (sub.wake && !wakeAllowed) continue;`) is unreachable by construction — a wake
subscription on a human-facing name cannot be created — so it is pinned by a source assertion instead of
by a behavioral test that would be asserting nothing. Both facts are written into the source comment.

---

#### T-10 — a NUL byte was introduced, caught by the check, and fixed

`packages/core/test/admission.test.ts` was first written with a **literal `\x00`** inside the AC4 input
list. It rendered exactly the way story 1.1's `usage-ledger.ts` did:

```
$ git diff --cached --stat -- packages/core/test/admission.test.ts
 packages/core/test/admission.test.ts | Bin 0 -> 20585 bytes
$ file -b --mime packages/core/test/admission.test.ts
application/octet-stream; charset=binary
```

Located by byte offset (offset 3533, line 83) and replaced with the escape sequences `"\x00"` / `"\t\n"`
written as characters — which are also better inputs than the plain space they replaced. After:

```
$ file -b --mime packages/core/test/admission.test.ts
text/x-java; charset=utf-8
$ git diff --cached --stat -- packages/core/test/admission.test.ts
 packages/core/test/admission.test.ts | 494 +++++++++++++++++++++++++++++++++++
```

All fourteen touched files re-checked: 0 control bytes, all valid UTF-8, no `Bin` row in the diffstat.

#### No write reached the real `~/.telar`

Every probe ran under the test harness with `TELAR_HOME` pinned to an `mkdtemp` root; no ad-hoc script was
run against the operator's state.

```
$ find "$HOME/.telar" -maxdepth 3 -newermt "-3 hours"
$                                  # nothing — no file touched during this run
$ ls -1 "$HOME/.telar"
accounts.json      # mtime 01:31, pre-dates this run
usage.ndjson       # mtime 01:20, pre-dates this run
```

---

#### Fix pass 1 (2026-07-26) — the six `should-fix` review items

Real output, pasted. Commands run from the repo root unless a `cd` is shown.

**The gate, after the fixes.** File count unchanged (no new suite — the twelve new cases live in the two
suites they belong to); test count `1777 -> 1789` (+12 = 11 admission + 1 event-bus).

```
$ bun test   # tail
 1789 pass
 0 fail
 9903 expect() calls
Ran 1789 tests across 116 files. [29.74s]      # exit 0

$ cd packages/core && bun test   # tail
 1472 pass
 0 fail
 8429 expect() calls
Ran 1472 tests across 105 files. [28.45s]      # exit 0

$ cd apps/web && bun test   # tail
 317 pass
 0 fail
 1474 expect() calls
Ran 317 tests across 11 files. [1488.00ms]     # unchanged by this pass

$ cd packages/core && bunx tsc --noEmit ; echo $?
0
$ cd apps/web && bunx tsc --noEmit ; echo $?
0
$ ls packages/core/test/*.test.ts | wc -l
     105                                        # unchanged: no file added
$ git diff --stat -- bunfig.toml packages/core/test/ultra-runner.test.ts
$                                               # both still byte-identical (§6.1, AC8)
```

Arithmetic checks out against the parts: 1472 + 317 = 1789, and 8429 + 1474 = 9903.

**Discovery, by name AND by `file=` attribution, for every test in both touched suites** — the same
mechanism §6.2 requires, re-run rather than assumed:

```
$ bun test --reporter=junit --reporter-outfile=<scratch>/discovery.xml   # tail
 1789 pass / 0 fail / Ran 1789 tests across 116 files. [29.77s]

packages/core/test/admission.test.ts
  42 tests | missing-by-name=0 | not-attributed-to-this-file=0     # 31 -> 42
packages/core/test/event-bus.test.ts
  27 tests | missing-by-name=0 | not-attributed-to-this-file=0     # 26 -> 27
TOTAL PROBLEMS: 0
```

`-t` spot checks, one per fix area — `across 116 files` is half the proof — and the negative control:

```
$ bun test -t "resetAdmission refuses to zero LIVE occupancy"
 1 pass / 0 fail / Ran 1 test across 116 files. [296.00ms]                    # exit 0
$ bun test -t "an out-of-enum class cannot slip 25 concurrent acquires past a full ceiling"
 1 pass / 0 fail / Ran 1 test across 116 files. [277.00ms]                    # exit 0
$ bun test -t "AC10 a NaN cap still reports what it reported before the process term existed"
 1 pass / 0 fail / Ran 1 test across 116 files. [278.00ms]                    # exit 0
$ bun test -t "the runtime guard covers the PAYLOAD too"
 1 pass / 0 fail / Ran 1 test across 116 files. [278.00ms]                    # exit 0
$ bun test -t "a name that does not exist zzz"
error: regex "a name that does not exist zzz" matched 0 tests. Searched 116 files (skipping 1789 tests)
```

**Load-bearing probes — every new guard reverted, every new test watched to fail.** This is §7's standard
("a green test can assert nothing"), applied to all six. Each probe reverted exactly one guard, ran the
suite, then restored the file from a pre-probe copy and `diff`ed it byte-for-byte (`RESTORED` below is that
`diff -q` passing). No probe ran outside `bun test`.

```
probe 1  resetAdmission's `held > 0` throw removed
         (fail) resetAdmission refuses to zero LIVE occupancy — a reset cannot mint capacity
         (fail) the ceiling holds across a refused reset — never eight calls against a ceiling of four
         40 pass / 2 fail          -> RESTORED

probe 2  both assertAdmissionClass call sites removed
         (fail) acquireAdmission and releaseAdmission both refuse a class outside the enum
         (fail) an out-of-enum class cannot slip 25 concurrent acquires past a full ceiling
         34 pass / 9 fail          -> RESTORED
         (the extra 7 are the cascade: an unknown key corrupts occupancy for every later test — which is
          itself the finding, since sumMap cannot see it)

probe 3  slotHandle made non-idempotent (the `released` latch removed)
         (fail) the slot handle releases the class it actually took, and only once (T-9)
         41 pass / 1 fail          -> RESTORED

probe 4  configureAdmission's ceiling bound removed
         (fail) configureAdmission refuses a ceiling that would wedge the controller
         41 pass / 1 fail          -> RESTORED

probe 5a currentPolicy() reduced to `return policy` (the ceiling frozen at import again)
         (fail) the ceiling is re-read from the environment — a value exported AFTER import is seen
         41 pass / 1 fail          -> RESTORED

probe 5b the configureAdmission pin removed (`ceilingPinned` never set)
         (fail) the queue > admissionCeiling reports the live policy ceiling      <- a PRE-EXISTING test
         ...and 9 more                                                              catches it first
         RESTORED

probe 6  budget.ts's binding chain final else put back to "process"
         (fail) AC10 the pool -> budget tie-break is byte-identical with the new term absent
         (fail) AC10 a NaN cap still reports what it reported before the process term existed
         40 pass / 2 fail          -> RESTORED
         (the widened grid catches it independently of the named case — that is the point of widening it)

probe 7  declareEvents' payload guard removed
         (fail) the runtime guard covers the PAYLOAD too — a shapeless declaration is refused at declare time
         26 pass / 1 fail          -> RESTORED

probe 8  declareEvents' null-entry guard removed (the same test's last assertion)
         (fail) the runtime guard covers the PAYLOAD too — a shapeless declaration is refused at declare time
         26 pass / 1 fail          -> RESTORED
```

**One test is honestly NOT a revert-proof, and is labelled as such in-source:**
`"AC4 a fresh import initializes the ceiling from the environment and never throws"` spawns a child that
imports `admission.ts` cold and asks immediately. It pins that a cold import answers from the environment
with no init call and does not throw on hostile input — but it **cannot distinguish eager initialization
from a memoized first read**, and nothing outside the module can. It is a preservation test for AC4, not a
regression test, and the comment above it says so rather than implying more.

**No write reached the real `~/.telar` in this pass either.** Every probe was a `bun test` run over
pure/in-memory functions or an `mkdtemp` root; the only child process spawned imports `admission.ts` and
prints a number.

### Completion Notes

**1. The `sessions/` co-tenancy finding (§5.6 T-3) — a real hole in `WORK-SPLIT`'s disjoint-write-set
guarantee, and epics 2 and 3 should know.** AD-5 assigns `sessions/<sessionId>/` to the session module,
which this story places in `packages/core/src/sessions.ts`. But `apps/web/lib/session-log.ts` **already**
creates and writes that exact directory (`<TELAR_HOME>/sessions/<id>/live.ndjson`, `mkdirSync` +
truncating `writeFileSync` + `appendFileSync`). So one `TELAR_HOME` subtree has two owners in two tracks.
Handled per the story's pre-resolution, and nothing in `apps/web` was touched:
- Core owns `.runner-lease`; `session-log.ts` keeps owning `live.ndjson`. Different files, same directory,
  `mkdirSync(…, {recursive: true})` is idempotent.
- `sessions.ts`'s `sessionDir()` is pinned by a **literal-string** assertion to
  `<TELAR_HOME>/sessions/<id>` — the byte-identical path `session-log.ts` builds — so the two cannot
  split-brain the directory. Pinned that way rather than by comparing against an import core cannot reach.
- **One deliberate asymmetry, stated in-source and tested:** core's resolver guards the id
  (`/^[A-Za-z0-9_-]+$/`, the `loomDir`/`runDir` guard) and `session-log.ts`'s does not. Core therefore
  **fails closed** on an id `session-log.ts` would happily write. That is the safer direction and a stated
  choice, not an accident.
- Still open for whoever owns Track B/C: the two resolvers are independent copies, so a future change to
  one silently diverges from the other. The literal-path test here fails if core drifts; nothing fails if
  `session-log.ts` drifts. Worth a shared resolver when the five-way `TELAR_HOME` duplication is collapsed.

**2. Where the reclaim decision went (T-C3): `packages/core/src/runner/lease.ts`, not `sessions.ts`.**
`leaseReclaim(lease, ttlMs, now) -> "held" | "reclaimable"`, plus `LEASE_RECLAIM_OUTCOMES` for
enumeration. Reason: §0 rule 2 — there is exactly one lease implementation, and the reclaim rule is a
property of the lease, not of sessions. Putting it in `sessions.ts` would imply the loom path needs its
own copy, which is precisely the second stale-reclaim the moat forbids. It is built by **wrapping**
`isLeaseFresh`, never by re-deriving `now - lease.ts <= ttlMs`. `sessions.ts`'s `sessionLeaseReclaim`
reads the file and defers the whole decision to it. `ttlMs` stays a caller-supplied parameter; no global
TTL constant was invented.

**3. The bus's re-declaration posture (T-B3): re-declaring a name is an ERROR.** Documented in-source and
asserted. An event name is a published contract (AD-21); a second declaration is either two modules
colliding on a namespace or one module's payload shape drifting, and both must surface at wiring time
rather than at the first publish that fails validation. "Re-declaring the *same* thing is fine" was
rejected because it cannot be checked honestly — two zod schemas cannot be compared for equivalence, so
the check would be a guess. Consequence a consumer must know: **declare from a deliberate init path, not
at module scope**, because a reloading dev server would otherwise re-run the declaration; `resetBus()` is
the seam for tests and reloads.

**4. Symbol names — nothing from §5.5 was renamed; four things were added.** Every name the story listed
survives verbatim, and there was no barrel collision (checked by name before writing, then by
`bunx tsc --noEmit` in **both** workspaces). Added beyond the sketch:
- `publish()` returns a `PublishResult` (`{name, deliveryClass, delivered, wakeDelivered, failed}`)
  instead of `void`. Additive and non-breaking. It is what makes "a human-facing event pushes nothing"
  *observable* (`wakeDelivered === 0`) and the swallowed subscriber error *countable* rather than silent.
- `declareEvents` returns a typed `EventPort` whose `publish`/`subscribe`/`subscribeAgentFacing` take the
  bare **fact** and infer the payload type from the declaration. §5.5 explicitly welcomes this. It also
  means a call site never hand-writes a full event name, which is what makes namespace ownership hold in
  practice and not only at declaration time. The string-keyed functions remain exported and are what the
  port delegates to.
- `canWake(deliveryClass)` — the delivery-class rule as one exported pure predicate, read by both the
  registration side and the publish side, so the rule itself is directly testable.
- `eventDeclaration(name)` / `declaredEvents()` — read-only observability, mirroring
  `admissionSnapshot()`'s role for admission.

**5. `declareEvents` is all-or-nothing — a defect found and fixed while writing the tests.** The first
implementation registered each event as it validated it, so a catalogue whose third entry was malformed
left the first two registered — and the retry after the fix then collided with its own leftovers under the
re-declaration rule. Now the whole catalogue is staged and committed only if every entry validates. Tested.

**6. The reference AC6 test does not fail against the bug it names.** Written up in full in the Debug Log
under "Load-bearing probes". Summary: `"never exceeds the ceiling, even when arrivals race a release"` —
the case §2's AC6 Proof cites — passes against a faithful revert of the old gate. Kept, with a caveat
comment; the added `"AC6 the slot is taken BEFORE the waiter wakes …"` is the pin that actually fails
(`Expected: 4, Received: 3`).

> **Stated plainly, because the two readings mean opposite things: the
> `Expected: 4, Received: 3` result was a REVERT-VERIFICATION FAILURE, not an unmet acceptance criterion.**
> It was observed ONLY while `admission.ts` was deliberately reverted to the old gate's shape (arrival
> barges a non-empty queue; the woken waiter does its own `occupancy[cls]++` with no re-check). That is the
> test doing its job: failing when the fix is absent. `admission.ts` was then restored and byte-compared
> against a pre-probe copy (`diff` → identical). **On the current tree, with the fix in place, that test
> PASSES** — verified on its own (`bun test -t "AC6 the slot is taken BEFORE the waiter wakes"` → 1 pass,
> 0 fail, exit 0), in its own suite (31 pass / 0 fail), and in the repo-wide gate (1777 pass / 0 fail
> across 116 files). AC6 is met. There is no failing test anywhere in this change.

**7. A compile-time AC cannot be proved from `packages/core/test/` without running the compiler.**
`packages/core/tsconfig.json` is `include: ["src"], exclude: ["test"]` — measured with
`bunx tsc --noEmit --listFilesOnly | grep "/test/"`, whose only hit is a file inside `@types/node`. So a
bare `// @ts-expect-error` in a test file is **never checked by the project's own typecheck gate**: it is
a comment wearing a test's clothes, exactly the failure mode §6 exists to prevent. AC1 and AC11's
structural claim are therefore proved by **invoking `tsc` from inside the test**, over fixtures generated
in a throwaway directory, in both directions (the omission must fail; the same declaration with the field,
and a `@ts-expect-error` over the omission, must compile clean). Cost: ~0.35s per fixture, ~1.4s per
suite. The compiler is run through `process.execPath` (bun) rather than `node_modules/.bin/tsc`, because
that shim is `#!/usr/bin/env node` and this repo is bun-only.
The ~25-line harness is duplicated across the two suites deliberately: every one of the 105 files in
`packages/core/test/` is a self-contained `*.test.ts` and that directory has never held a helper module,
so extracting one would introduce a file shape the convention does not have.

**8. Nothing was found that cannot be done inside `packages/core/src`.** The one known cross-track
collision (T-3) was pre-resolved by the story and needed no `apps/web` edit. No new dependency was added.
No `bunfig.toml` change. No concrete event was declared in `src` (T-B2) — the only event names in the repo
are fixtures inside `event-bus.test.ts`, and the temptation to add one "to make the bus useful" was noted
and declined.

**9. Comment-only cleanup slightly beyond T-A6's literal file list, and why.** T-A6 names the two stale
`MAX_CONCURRENT` headers. Editing `engine.ts` also invalidated four *other* line-number citations in
`ultra/executor.ts` (`engine.ts:222`, `:228`, `:92`, `:89`) — the file was already in T-A6's scope, and
leaving a citation I had just made wrong is the exact failure story 1.1's Repair Round 1 recorded. All
four were replaced with **symbol** references per this story's citation policy. No behavior changed;
`RUN_CONCURRENCY = 3` and its `Semaphore` are untouched (T-6).

**10. Recommendation, deliberately NOT acted on.** A repo-wide "no raw control characters in source" scan
would have caught item T-10 above at authoring time, and this is the second such incident (story 1.1's
`usage-ledger.ts`). It is **not** added here because `apps/web`'s `git-tab.ts` still carries 2 NUL bytes —
listed in §7 as "still open from 1.1, not yours" — so the scan would either fail on day one or need an
out-of-scope edit. Worth adding once that residual is cleared.

---

#### Fix pass 1 — review remediation (2026-07-26)

**11. All six `should-fix` items from the review report are addressed, each with a regression test proven
load-bearing** — five closed outright, and the `cls` item closed on its out-of-enum half and structurally
on the production path for its class-mismatch half, with the residual and its rebuttal in note 15. One
line each below; the detail sits under the matching `[Review]` item in §4 and the probe output in the
Debug Log.

| Finding | Fix | Regression test |
| --- | --- | --- |
| `resetAdmission` mints capacity (BH#1) | throws when `sumMap(occupancy) > 0`, naming the classes held | `resetAdmission refuses to zero LIVE occupancy…`, `the ceiling holds across a refused reset…` |
| `cls` unvalidated (EC#2) | `assertAdmissionClass` on both entry points **and** `acquireAdmission` returns the slot handle (partial — note 15) | four cases, incl. the 25-concurrent-bogus reproduction |
| `configureAdmission` ceiling ≤ 0 (EC#1) | ceiling must be an integer ≥ 1, the same bound `readCeiling` applies | `configureAdmission refuses a ceiling that would wedge the controller` |
| `declareEvents` payload unguarded (EC#8) | payload must be able to validate a publish; a null entry is named, not dereferenced | `the runtime guard covers the PAYLOAD too…` |
| `fanoutClamp`'s NaN relabel (EC#3) | `process` is an explicit test; the final else is `budget`, the pre-term formula's own | `AC10 a NaN cap still reports…` + the AC10 grid widened to sweep `Infinity` |
| `TELAR_MAX_AGENTS` frozen at import | `currentPolicy()` re-reads it at every entry point; `configureAdmission` pins | `the ceiling is re-read from the environment…`, `an explicit configureAdmission ceiling PINS…` |

**12. AC4 versus the lazy-resolution convention — reconciled rather than traded, and here is the
reasoning, because the fix brief flagged it as the one place the two could collide.** AC4 says the
controller "initializes" without throwing "at import time"; the repo's convention (learned in story 1.1,
`98c065f`) is that every env-derived root resolves lazily. The two only conflict if "initializes at
import" is read as "and never looks again" — which is not what the AC says and not what its Proof checks
(the Proof is entirely about `readCeiling` being a pure, never-throwing parse over an env record). So:
- **The import-time initialization is untouched.** `let policy: AdmissionPolicy = defaultAdmissionPolicy()`
  still runs at module evaluation, `admissionCeiling()` still answers with no init call, and the parse
  still cannot throw. Every AC4 test is unchanged and green, plus a new child-process test that imports the
  module cold under a hostile `TELAR_MAX_AGENTS` and asserts both halves end to end.
- **What is new is that the value stays true afterwards.** `currentPolicy()` re-reads the ceiling from
  `envRoot` on every entry point.
- **Precedence is explicit, not accidental:** an explicit `configureAdmission({ceiling})` pins the value
  (deliberate code beats an ambient variable — and the pre-existing test
  `"admissionCeiling reports the live policy ceiling"` fails without the pin, which is how it was checked);
  `resetAdmission(env)` re-roots the read at `env` and unpins.
- **Bonus the seam gets for free:** `resetAdmission({})` now roots the read at that empty record, so this
  suite's ceiling is immune to a `TELAR_MAX_AGENTS` in the developer's own shell. Previously the
  protection was accidental (nothing re-read the env at all).
- **The one hazard, stated:** the ceiling can now change mid-run. Lowering it while calls are in flight
  makes `availableFor` negative, which reads as `at-ceiling` — arrivals queue and releases drain until the
  new ceiling holds. It cannot over-commit, and `pump()` resolves the policy once per drain so the value
  cannot move underneath a wake loop.

**13. One deliberate, additive API change: `acquireAdmission` now returns the release handle for the slot
it took** (`Promise<() => void>`, was `Promise<void>`). The review's finding named the missing handle
directly, and T-9 is the reason it matters: an identity is minted at the moment of the thing, never
re-derived. Blast radius, measured: `engine.ts` is the only caller in `packages/core/src` and now calls the
handle in its `finally`; every existing test that ignores the resolved value keeps working; `apps/web`
imports none of these symbols. `releaseAdmission(cls)` stays exported unchanged, so AC9's double-release
flooring is still asserted against the same function. The handle is idempotent — a spent handle firing a
second time is a no-op rather than a release of a slot somebody else now holds, which the floor at zero
could not distinguish.

**14. What was deliberately NOT fixed in this pass, and why.** The brief was the report's six `should-fix`
items; everything below is its `nice-to-have` tier and stays an open action item in §4.
- `independentPieces` / `processCeiling` integer validation — `pieces` is pre-existing and unchanged by
  this story, and validating it changes what six untouched call sites do. Wants its own story.
- `sessionDir`'s case-insensitivity and missing length bound — both are `sessions.ts` behavior changes with
  a live co-tenant (`apps/web/lib/session-log.ts`) whose resolver shares the property; changing one side
  alone is what splits the directory in two. §5.6 T-3 says so, and the collapse is tracked.
- `publish`'s `catch { result.failed++ }` discarding the error — the error posture is a decision this story
  delegated and documented; changing it is a contract change, not a defect fix.
- The `REPO_TSC` existence precondition and the `toContain("fs.watch")` source scan — test-ergonomics
  improvements with no behavior behind them.
- The `binding: "pool-exhausted"` misnomer when `capByProcess` is the zero term — pinned by a green,
  deliberate assertion (`"AC10 a zero process ceiling is pool-exhausted…"`). Changing the label means
  changing a documented contract, which is the operator's call, not a fix pass's. Left open in §4.

**15. Rebuttal — the one half of a should-fix item that is NOT fully closed, and why closing it would
breach AC9.** The review's finding on `cls` had two failures. Failure (a) — an out-of-enum class admitted
without limit — is closed outright by `assertAdmissionClass`. Failure (b) — acquiring under one class and
releasing under another — is closed *structurally for the production path* by the slot handle, but the
exported `releaseAdmission(cls)` still trusts the class it is given: `acquireAdmission("loom-build")`
followed by `releaseAdmission("other")` still leaks the build slot and silently floors the `other`
decrement at zero. This was re-verified against the fixed code by an independent adversarial pass over
this diff, and it is real.
It is nevertheless left open, because **every way to close it breaks something the story requires**:
- The only evidence of a mismatch available inside `releaseAdmission` is `occupancy[cls] === 0` — which is
  *indistinguishable from a double release*. AC9 requires that exact case to floor silently rather than
  throw ("occupancy floors at zero on release (`Math.max(0, …)`), asserted directly"), and
  `"release is idempotent below zero"` and `"AC9 a double release of a HELD slot floors at zero"` assert it
  by name. Throwing there fails both, and fails AC9.
- Removing `releaseAdmission` from the public surface is the other route, and T-A1 lists it among the
  required exports that "downstream stories and the barrel assume".
- A `console.warn` on the zero-occupancy release would fire on the two AC9 tests that deliberately produce
  it, so it would report the correct behavior as an anomaly.
What was done instead: the handle is the safe form and is what production uses, and `releaseAdmission`
now carries an in-source paragraph stating precisely what it cannot detect, so the next reader does not
mistake the pair for symmetric. Closing (b) completely means changing AC9's asserted semantics — a
deliberate contract change, and the operator's call rather than a fix pass's.

**16. Decisions taken autonomously in this pass** (the operator was asleep; nothing was surfaced):
scope held to the six items; the AC4 reconciliation in note 12 chosen over both alternatives (freezing the
ceiling and writing a rebuttal, or making it fully lazy and dropping the pin); the slot handle in note 13
adopted rather than leaving the acquire/release pair to convention; `resetAdmission` given no `force`
escape hatch (a caller that trips it leaked a slot); the AC10 equivalence grid widened to include
`Infinity` rather than only adding the named NaN case; and the story's `7645` expect-call tally corrected
in place after re-measuring, since the Debug Log was being updated anyway. Status left at `review`.

## 10. File List

Measured with the change staged, which is the only form that sees created files:

```
$ git add -A -- packages/core && git diff --cached --name-status
A	packages/core/src/admission.ts
M	packages/core/src/budget.ts
M	packages/core/src/critic.ts
M	packages/core/src/engine.ts
A	packages/core/src/event-bus.ts
M	packages/core/src/index.ts
M	packages/core/src/runner/lease.ts
A	packages/core/src/sessions.ts
M	packages/core/src/ultra/executor.ts
M	packages/core/src/ultra/runner.ts
M	packages/core/src/verifier.ts
A	packages/core/test/admission.test.ts
A	packages/core/test/event-bus.test.ts
A	packages/core/test/session-lease.test.ts
```

**Created:**

- `packages/core/src/admission.ts` — the admission controller (T-A1).
- `packages/core/src/event-bus.ts` — the typed in-process event bus (T-B1).
- `packages/core/src/sessions.ts` — the session subtree + the session lifetime of the lease (T-C2).
- `packages/core/test/admission.test.ts` — re-homed reference suite + extensions (T-A5). 31 tests.
- `packages/core/test/event-bus.test.ts` — T-B3. 26 tests.
- `packages/core/test/session-lease.test.ts` — T-C4. 16 tests.

**Modified:**

- `packages/core/src/engine.ts` — `MAX_CONCURRENT`/`active`/`waiters`/`acquire`/`release` deleted;
  `AgentOpts.admissionClass?` added; `agent()` resolves the class once into a local, then
  `acquireAdmission` / `releaseAdmission` in the same `try`/`finally` (T-A2).
- `packages/core/src/budget.ts` — `FanoutArgs` with optional `processCeiling`; `capByProcess` on
  `FanoutClamp`; `"process"` added to `binding`; `pool -> budget -> process` tie-break; `DEFAULT_MAX_AGENTS`
  comment now says per-loom clamp, not process ceiling (T-A3).
- `packages/core/src/verifier.ts` — `admissionClass: "loom-verify"` added; capability wall untouched (T-A4).
- `packages/core/src/critic.ts` — `admissionClass: "loom-verify"` added; capability wall untouched (T-A4).
- `packages/core/src/ultra/runner.ts` — `admissionClass: "ultra"` on the schema'd branch; stale
  `MAX_CONCURRENT=4` / `engine.ts:89-99` header prose replaced (T-A4, T-A6).
- `packages/core/src/ultra/executor.ts` — stale gate prose replaced; four `engine.ts:<line>` citations
  re-pointed at symbols; `RUN_CONCURRENCY = 3` and its `Semaphore` unchanged (T-A6, T-6).
- `packages/core/src/runner/lease.ts` — parameter renamed `loomDir` -> `ownerDir` (positional, no caller
  breaks); both-lifetime header; `leaseReclaim` + `LeaseReclaim` + `LEASE_RECLAIM_OUTCOMES` added; every
  pre-existing export kept under its current name (T-C1, T-C3).
- `packages/core/src/index.ts` — three barrel lines with WHY comments citing AD-17, AD-14/AD-21,
  AD-5/AD-16 (T-D1).

**Fix pass 1 — review remediation (2026-07-26).** No file created, none deleted; the six fixes land in the
five files below and their two suites. Measured, not recalled:

```
$ git diff --name-status -- packages/core
M	packages/core/src/admission.ts
M	packages/core/src/budget.ts
M	packages/core/src/engine.ts
M	packages/core/src/event-bus.ts
M	packages/core/test/admission.test.ts
M	packages/core/test/event-bus.test.ts
```

- `packages/core/src/admission.ts` — `assertAdmissionClass` + `isAdmissionClass`; `currentPolicy()` and
  the `envRoot` / `ceilingPinned` pair; `slotHandle`; `acquireAdmission` returns the handle and validates
  its class; `releaseAdmission` validates its class; `configureAdmission` bounds the ceiling and sets the
  pin; `resetAdmission` refuses to zero live occupancy and re-roots the env read; `pump` resolves the
  policy once per drain.
- `packages/core/src/budget.ts` — `fanoutClamp`'s `binding` chain: `process` is an explicit test and the
  final else is `budget`. No value changed, on any input.
- `packages/core/src/engine.ts` — `agent()` releases through the handle `acquireAdmission` returns; the
  now-unused `releaseAdmission` import dropped.
- `packages/core/src/event-bus.ts` — `declareEvents` validates the payload schema and the declaration
  entry itself.
- `packages/core/test/admission.test.ts` — 31 → 42 tests (the `"the mutation seams"` describe, the NaN
  case) and the AC10 grid widened to sweep `Infinity`.
- `packages/core/test/event-bus.test.ts` — 26 → 27 tests.

**Deliberately NOT modified** (asserted in the Debug Log): `bunfig.toml`,
`packages/core/test/ultra-runner.test.ts`, `apps/web/**` (including `lib/session-log.ts`),
`packages/core/src/repair-guard.ts`, `tick.ts`, `executor.ts`, `build-fanout.ts`.

## 11. Change Log

| Date | Change |
| --- | --- |
| 2026-07-26 | Story created — ready-for-dev. Baseline `578e5b4`. |
| 2026-07-26 | Leg A landed: `admission.ts` (AD-17) + `engine.ts` gate replaced + `fanoutClamp` gains an optional `processCeiling` + three call sites tagged + stale `MAX_CONCURRENT` prose cleared. `admission.test.ts` re-homed from the SPEC reference and extended (22 -> 31 cases). |
| 2026-07-26 | Leg B landed: `event-bus.ts` (AD-14/AD-21) — declaration registry, composed `<module>:<fact>` names, class-gated wake channel, zod payload contract, in-process only. `event-bus.test.ts`, 26 cases including a compiler-run proof of AC1. |
| 2026-07-26 | Leg C landed: `runner/lease.ts` generalized to two lifetimes + `leaseReclaim`'s success-free union; `sessions.ts` (AD-5/AD-16) composing over it. `session-lease.test.ts`, 16 cases. |
| 2026-07-26 | Leg D landed: three barrel exports; both workspaces typecheck clean; repo-wide gate 1704/113 -> 1777/116 tests/files, 0 fail. |
| 2026-07-26 | Load-bearing probes run for AC6 and AC2 (revert the fix, watch it fail). Finding recorded: the SPEC reference suite's own AC6 case does not fail against a faithful revert; the added AC6 case does. |
| 2026-07-26 | T-10 incident: a literal NUL byte made `admission.test.ts` binary to git. Found, replaced with escape sequences, all 14 touched files re-verified as UTF-8 text. |
| 2026-07-26 | Status -> review. |
| 2026-07-26 | Code review (three adversarial layers + independent verification pass): **PASS, no blocking findings.** All 11 ACs met; suite re-run green (1777/0 across 116 files); §6 discovery proof independently re-confirmed by junit `file=` attribution (31/26/16). 2 `[Review][Decision]` + 12 `[Review][Patch]` + 1 `[Review][Defer]` recorded in §4; the deferred `writeLease` tmp-collision entry also appended to `deferred-work.md`. No source edited, nothing committed, status left at `review`. |
| 2026-07-26 | Fix pass 1 — the six `should-fix` review items closed in `admission.ts` (occupancy-safe reset, class validation + slot handle, bounded ceiling, lazy ceiling with an explicit pin), `budget.ts` (the NaN binding label), `event-bus.ts` (the payload guard) and `engine.ts` (release through the handle). +12 regression tests, each verified load-bearing by reverting its fix; gate 1777/116 -> 1789/116, 0 fail, both workspaces typecheck. Status stays `review`. |
