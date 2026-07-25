# Solution Design — the reasoning behind the spine

Companion to `ARCHITECTURE-SPINE.md`, which deliberately carries decisions without rationale. This carries the rationale: what was weighed, what was rejected, and why each call went the way it did. Written for the version of you that comes back in six months and wants to know whether a rule is load-bearing or incidental.

## The problem this spine was written to solve

Three SPEC packages — a loom redesign (24 capabilities), an organization workspace (13), and finishing Ultra (6) — all land on one codebase, one process, one state root, and one chat surface. Each was distilled independently and each is internally coherent. That is exactly the condition under which independently-built units diverge: nobody was wrong, and nobody owned the overlap.

The scan found four places where the three specs had each made a local call that only works if the other two made the same one:

1. **Three `TELAR_HOME` trees**, three serialization formats, three id schemes — and a fourth tree (per-session) that all three need and none defines.
2. **One chat route** at 103KB, already accreting session-kind branches, that is simultaneously the project gate, the MCP mount point, and the enforcement site for the Human-Accept Moat.
3. **One session monolith** at 151KB, which all three specs carve concurrently — plus a `conversation-component.md` teardown proving the same chat surface had already been hand-rebuilt six times.
4. **One "async thing finished" problem** with three answers: Ultra wants to wake an agent, looms tail SSE, and the workspace is emphatically pull-only.

Everything in the spine exists to close one of those, or to close a seam the closing of those opened.

## Why three laws instead of one paradigm

The instinct was to name the paradigm already written down — *deterministic control flow in code, intelligence in the leaves*, which `project-context.md` states and the code genuinely honors (`tick`, `weave`, `gates`, `repair-guard` are pure over integers, sets and injected clocks).

That was rejected because it answers the wrong question. The four collisions above are **boundary**-shaped, not control-shaped. A paradigm that makes boundaries a footnote gives a builder nothing to reason from at exactly the moment they need it. Pure hexagonal was rejected for the opposite reason: it would reframe settled ground as a rewrite, and the determinism law is doing real work that "ports and adapters" does not describe.

So: three laws, one per layer, one per class of collision. The third is scoped deliberately — **log + lazy projection holds for the ultra journal, the drift ledger, evidence and the usage ledger, and explicitly not for workspace packets, lane files or manifests.** Without that scoping, a reasonable builder reads "the map is a regenerable projection" in one spec and event-sources the workspace store, which holds the user's verbatim notes and must never be rebuilt from anything.

## State: why weak references and tolerant readers

**One owner per subtree** is the direct consequence of law 2. The interesting part is what it does *not* cover, which the adversarial pass caught: shared runtime state — the usage ledger, bus subscriptions, admission accounting — belongs to no module's subtree, so two modules could each append their own record shape to a root-level file while both technically obeying the rule. AD-20 exists solely to close that; it is the kind of hole that only shows up when you try to construct the failure.

**Weak references** were chosen over referential integrity because integrity requires each module to know who points at it — an inbound-dependency web that law 2 is specifically shaped to prevent. Denormalized snapshots were rejected because a workspace row showing a loom's state *at the moment of weave* would break OW CAP-11's requirement that the row stays until the loom lands **and** the human accepts. The tombstone rule is the price: a dangling ref renders, never throws. It also happens to make the planned legacy-loom drain a non-event.

**Tolerant readers, version only the unregenerable** is an asymmetry argument, not a uniformity one. Migration ceremony on every store would be safe and wasteful — a reconciliation loom can rebuild the living map from repo plus ledger in seconds. But `packet.yaml` holds `raw` verbatim, never overwritten, deliberately kept beside `fixed` so the user can check the expert did not drift from what they meant. That content has no source to rebuild from. So the version field and the real migrate-on-read go there and essentially nowhere else.

## Sessions: why config became data

The chat route was already showing the failure mode before any of these features touched it — planner and steerer session kinds exist as branches inside a 103KB handler. Three more features adding three more branches is not a hypothetical.

The `SessionProfile` turns the workspace's hardest requirement into the easy case: "skip the project gate" stops being a special path through the handler and becomes a profile that supplies `cwd: TELAR_HOME/workspace/home` and `settingSources: []`. Node conversations and steerers become profiles too, retroactively cleaning up what is already there.

**The moat is the reason this needed care.** Making session config data is exactly the move that could turn a structural invariant into a configurable one, and `project-context.md` calls the Human-Accept Moat non-negotiable. So the guardrail is wired outside the profile and runs unconditionally, and `toolPolicy` is intersect-only — typed to carry deny lists and allow-narrowing, with no field that could re-enable an accept path. Separate routes per session kind were rejected on exactly this ground: a moat enforced in three places has three chances to be forgotten.

**Fail-closed on missing capability** follows the same posture. Today a Codex session silently receives no MCP servers — `runCodexTurn` has no injection path at all. A Codex-backed master would come up looking fine and answer "where did I stop" from nothing, which is worse than refusing to start. Graceful degradation was considered and rejected for that specific failure.

## The shell: freezing a contract instead of a queue

`conversation-component.md` had already done the hard thinking — three layers, an item-kind registry, four slots, owner adapters, config over inheritance. It was a plan, not a change, and three features were about to need it simultaneously.

Hard serialization (nobody starts until the carve-out lands) puts a 151KB refactor on the critical path of all three specs. Parallel carving guarantees the merge conflict and produces the seventh hand-built copy. The resolution is that **the contract is the artifact, not the code**: the spine freezes the four slots and the registry, an epic-0 story does the carve-out and migration, and D/E/F build owner adapters against the frozen contract in the demo gallery meanwhile. Only final wiring waits.

Two seams had to be closed for that to actually hold. Kind ids are module-namespaced, or three features register colliding bare names. And a registered renderer must be a **pure function of payload plus shell view state** — because otherwise Ultra's anchor reads live run state from its own React context, loom's gate card reads its payload, and `TranscriptView`, which provides no context, can render neither.

## Events: one bus, two delivery classes

Ultra CAP-1 wants a finished run to produce an unprompted assistant turn. Workspace CAP-1 says the surface never initiates contact, and its Why is unambiguous: notifications are a dead channel for this user, who reacts instantly or never.

These are not in conflict — one wakes an **agent**, the other refuses to interrupt a **human** — but nothing wrote that down, so the next builder reads one spec and gets it wrong in one direction or the other. Making the delivery class a **required field** on every event turns a distinction that lived in two prose documents into something the type system asks about.

Filesystem-watch-derived events were the tempting alternative — state is already the source of truth and atomic renames are watchable — and were rejected because a watcher reads every module's subtree by path, which is law 2 inverted, and because fs-watch semantics differ between the dev server and the packaged Electron app.

AD-21 came out of the adversarial pass: with the event catalogue deferred to each module's epic, nothing stopped looms renaming `loom:landed` during unrelated work and silently breaking the workspace subscription that makes queue rows disappear. Event names are a published contract or the deferral is unsafe.

## Runtime: the collision nobody's spec saw

The loom redesign's premise is that 7+ concurrent looms is the norm, and charters budget `maxAgents: 12`. Meanwhile `engine.ts:89` holds a module-private, process-wide `MAX_CONCURRENT = 4` that every schema'd `agent()` call joins, and ultra stacks a separate cap-3 semaphore on top of it.

So `maxAgents: 12` is currently meaningless — the effective ceiling is 4, invisible, with no fairness. A fleet can starve your own chat session, and one ultra fan-out can stall the fleet. This is a real defect that no single spec could have found, because it only appears when you hold all three at once.

The admission controller keeps one visible, configurable ceiling and divides it into weighted classes. `Charter.budget.maxAgents` demotes to a per-loom clamp within its class. The adversarial pass then forced the scope question: admission governs **`agent()` concurrency only** — labs and declared services are long-lived processes governed by the lease and the worktree mutex, or two loom epics would count occupancy differently and the ceiling would be unknowable again.

Two things this AD first got wrong, both corrected by reading the code rather than the specs:

- **There is no `interactive-session` class.** The chat route calls the SDK's `query()` directly and never enters `engine.agent()`, so interactive sessions never joined this gate at all. "A fleet starves your chat session" was false via this mechanism, and a reserved slot for it would have reserved nothing. Interactive is out of band by design — which is the outcome we wanted anyway.
- **Verification gets precedence, not a reserved slot.** A hard reservation was specified, built, and rejected on evidence: it broke the existing `peak === 4` assertion in `ultra-runner.test.ts`, because holding a slot open for an idle verifier makes a pure-Ultra workload peak at 3 — permanently burning 25% of a 4-slot machine to insure against a wait that is already bounded. No-barging plus priority-ordered wakeup gets the same protection for free: a verify waits at most one in-flight call, and no slot idles while work is queued.

Reading the gate also turned up a pre-existing bug: it could exceed its own ceiling. A woken waiter did `active++` without re-checking, so an arrival landing between `release()` and that resumption over-committed the pool. The fix is to take the slot before waking the waiter.

The full contract, including the rejected design so it is not re-derived, is `SPEC-runtime-foundations`'s `admission.md`.

**Restart doctrine** generalizes what is already true rather than inventing anything: ultra already reconciles a stale `running` to `stopped` on read, and the lease rule already guarantees a stale lease can at worst produce a false-positive `failed`, never an auto-`done`. Supervisor re-adoption on boot was genuinely attractive — looms run for hours and a dev-server reload is an expensive way to lose one — but it auto-advances work with no human in the loop, which cuts against the accept moat's entire posture. It is recorded under Deferred with the condition that would justify revisiting it. The consequence, caught adversarially: reconciliation is not rollback, so anything mutating the repo or the map must be idempotent and resumable from its own journal.

## The mistake worth remembering

AD-18 was first written as a new root-level `spend.ndjson`, on the reasoning that Ultra's manifest spend, loom charter budgets and the session usage display should not be three counters that can disagree.

The repo already ships `~/.telar/usage.ndjson` — an append-only ledger with `logUsage()`, `UsageEntry` carrying `account`, `model`, `sessionId` and `costUsd`, plus `usageSummary()` and a `plan-usage.json` projection. A rule written to stop three counters from disagreeing would have created a fourth.

It was asserted from the SPECs rather than checked against the code, and the reality-check lens caught it. AD-18 now extends the ledger that exists. The general lesson, and the reason that reviewer lens is configured at all: **in a brownfield spine, every "we should have X" is a claim about the codebase, and the codebase is the only place it can be checked.**

Checking also turned up that `store.ts:8` hardcodes `~/.telar` while every other module honors `TELAR_HOME` — so chat history and usage do not isolate under `~/.telar-dev`. Pre-existing, unrelated to any of the three specs, and now load-bearing: it is the first unit of Track A, because building the spend ledger on a store that ignores `TELAR_HOME` would write dev spend into production state.

## What the spine deliberately does not decide

The Deferred section is half the contract. The things most likely to be mistaken for omissions:

- **Admission weights and the ceiling number.** The shape is fixed; the numbers are tuning against a real fleet, and picking them cold would be inventing precision.
- **The event catalogue.** Safe to defer *only because* AD-21 makes published names binding. Without AD-21 this would be a hole.
- **Living-map regions beyond v1.** Regions are declared by the loaded methodology, so the catalogue is data by construction, not architecture.
- **Bus durability.** Undecided, and nothing is blocked on it — every durable trace today is already a module-owned NDJSON stream.
- **CI.** Declined as scope beyond the three specs. AD-19's assertions run in the manual pre-commit trio instead, which is weaker but honest, and the revisit condition is a second contributor.
