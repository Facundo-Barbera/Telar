---
story_id: "1-3"
title: "Executable invariants and the Track A prove-run"
status: "ready-for-dev"
epic: "Epic 1: Runtime Foundations"
track: "A — Runtime foundations (packages/core only)"
caps: ["CAP-6", "SPEC success signal (spec-runtime-foundations stories.yaml #9)"]
frs: ["FR-RF-6", "FR-RF-2 (asserted over, not built here)"]
ads:
  [
    "AD-1",
    "AD-2",
    "AD-3",
    "AD-5",
    "AD-7",
    "AD-14",
    "AD-15",
    "AD-16",
    "AD-17",
    "AD-18",
    "AD-19",
    "AD-20",
    "AD-21",
  ]
nfrs:
  [
    "NFR-X-1",
    "NFR-X-2",
    "NFR-X-3",
    "NFR-X-4",
    "NFR-X-14",
    "NFR-RF-1",
    "NFR-RF-5",
    "NFR-RF-6",
    "NFR-RF-8",
  ]
baseline_commit: "b71402a6042f4531867697123e9af89e9ae97c3b"
depends_on:
  [
    "1-1 (done — TELAR_HOME isolation + owner-attributed usage ledger)",
    "1-2 (done — event bus, admission controller, lease primitive)",
  ]
blocks:
  ["phase 2 of WORK-SPLIT — its gate is literally 'A6 assertions green' (epics 4, 5, 6)"]
---

# Story 1.3: Executable invariants and the Track A prove-run

## 0. Read this first

**Citation policy for this whole file — inherited from stories 1.1 and 1.2, which re-learned it five times
between them.** Every reference below names a **file and a symbol** — a function, a const, a type field, or
a test title. **A line number is not a name.** It identifies a slot in a file, and any edit above it hands
that slot to something else. Where a number genuinely helps you navigate a long file it is written `≈:N`
and is a **pointer, not a fact** — verify by symbol, never by number. Do not add a number to this file you
have not just measured. Counts obey the same rule: `project-context.md` says outright that the test counts
in it are "a smell test, not a fact — measure, don't quote", and this story's baseline numbers moved twice
while it was being written.

**Five hard rules before you write a line.**

1. **A scan that finds nothing must FAIL, never pass.** Every invariant in this story is a source scan or a
   pinned inventory. The characteristic failure of that shape is *vacuous green*: a bad root path, a typo in
   a glob, an excluded directory, and the assertion now holds over the empty set forever. **Every scan in
   this story asserts a non-trivial floor on what it found** (files walked, tool names collected, client
   components visited, edges traversed) before it asserts anything about violations. This is the single most
   important instruction in the file. Story 1.1 spent two repair rounds on tests that were green while
   asserting nothing; this story's entire deliverable is tests, so it can fail that way five times over.
2. **Every test you add must be proven DISCOVERED by the repo-wide runner, by name.** Passing when pointed
   at directly is not evidence. See §6. `bunfig.toml:12` excludes `**/_bmad-output/**` from discovery and is
   an unresolved `[Review][Decision]` on story 1.1 — **do not edit `bunfig.toml`**, not to add a pattern and
   not to remove one. Prove you did not: `git diff --stat -- bunfig.toml` must print nothing.
3. **Never run an ad-hoc probe outside the test harness.** Outside `bun test`, `NODE_ENV` is not `test`, so
   `usage-ledger.ts`'s write-guard correctly does not fire and a write lands on the home default. **This
   already happened.** `~/.telar` exists on this machine right now — created 2026-07-26 01:20 by a `bun -e`
   probe a story-1.1 verification agent ran outside the harness — and it holds a synthetic `$1` billing line
   plus a default `accounts.json`. It is logged under **NEEDS A HUMAN** in the orchestrator run log. Two
   consequences bind you: (a) run every probe as a `bun test` file or as a child process you spawn *from*
   one with `NODE_ENV=test`; (b) §5.5-D6 — **do not write an assertion that requires `~/.telar` to be
   absent**, and do not delete it.
4. **You are writing tests over existing code. You are not fixing the code they scan.** If an invariant
   surfaces a real pre-existing violation, the ruling in §5.5-D7 tells you exactly what to do. It is neither
   "weaken the assertion" nor "ship a red gate".
5. **Do not declare a real event, and do not add a tool.** `event-bus.test.ts`'s header states that its
   fixtures are "the ONLY event names in the repo" and that "nothing here should ever be promoted into
   `packages/core/src`". Story 1.2 recorded declining exactly that temptation (its Completion Note 8). Your
   prove-run declares its own fixture catalogue under its own module name and nothing reaches `src`.

**Write set:** `packages/core/test/**` — two new files, nothing else. This story is Track A and it is the
one story in the epic that should touch **no** `src` file at all. If you believe you need a `src` edit or an
`apps/web` edit, **stop and record it** the way story 1.1 recorded its AC6 cross-track finding and story 1.2
recorded its `sessions/` co-tenancy finding. Do not quietly cross the boundary.

---

## 1. User Story

As the owner of telar's non-negotiable invariants,
I want them re-checked by tests rather than by memory, and the substrate demonstrated end to end under a
sandboxed state root,
So that a rule nobody re-checks cannot quietly become false.

**Why this story exists, in one paragraph.** `brownfield.md` states the gap plainly: *"'No accept tool
anywhere' and 'the verifier stack holds no write tools' are true today by construction and by review, but
nothing re-checks them."* There is no CI (declined at spine-authoring time, AD-19 and the Deferred section
both say so), so the only gate is the manual pre-commit trio. AD-19 is the decision to put the five
load-bearing rules inside that trio. The second half of the story is `WORK-SPLIT`'s phase gate: phase 2 —
epics 4, 5 and 6, i.e. every remaining feature epic — is gated on *"A6 assertions green"*, and
`SPEC-runtime-foundations`'s success signal is a single scripted run proving the substrate serves a consumer
on every port. **This story is that gate.** Nothing downstream starts until it is green.

---

## 2. Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § "Story 1.3: Executable invariants and the Track A
prove-run". The `**Given/When/Then**` text is the contract; the `Proof` and `Notes` lines under each are this
story's, and are how a reviewer will check it.

### AC1 — the five invariant assertions exist

**Given** the full codebase
**When** the invariant suite runs
**Then** it asserts: no MCP surface exposes an accept tool; the verifier stack is granted no write or edit
tools; no module reads another module's `TELAR_HOME` subtree by path; client components import no core
runtime; no module writes a shared runtime service's state directly

Those five are labelled **INV-1 … INV-5** throughout this file, in the AC's clause order above. The same five
rules are AD-19's `Binds:` list and are restated clause-for-clause in `SPEC.md` CAP-6, in `epics.md` FR-RF-6,
and as `epics.md`'s **NFR-X-14** (which is where the `NFR-X-*` codes are *defined* — `project-context.md`
states the same rules in unlabelled prose and contains no `NFR` code at all).

**The AD numbers do not run in order, and mixing them up would put two invariants under the wrong rule.**
AD-19's `Binds:` reads `AD-1, AD-2, AD-3, AD-5, AD-20`, but the AC's clause order — which is what INV-1…INV-5
follow — is `AD-1, AD-2, **AD-5**, **AD-3**, AD-20`. So:

| Label | Rule | AD |
| --- | --- | --- |
| INV-1 | no MCP surface exposes an accept tool | **AD-1** |
| INV-2 | the verifier stack is granted no write or edit tools | **AD-2** |
| INV-3 | no module reads another module's `TELAR_HOME` subtree by path | **AD-5** |
| INV-4 | client components import no core runtime | **AD-3** |
| INV-5 | no module writes a shared runtime service's state directly | **AD-20** |

"At minimum" appears in the SPEC's wording, so more is permitted — but §3 fences what this story does *not*
add, and you should not exceed it.

**Proof:** five `describe()` blocks, one per invariant, in `packages/core/test/invariants.test.ts`. Each
carries **at least one anti-vacuity assertion** (rule 1 in §0) and at least one violation assertion.

**Notes:** each invariant's assertable form is specified in §5.5-D1 … D5. Those are decisions, not
suggestions — they were made against the tree so you do not spend budget re-deriving them.

### AC2 — a failure names the invariant it defends, and why it exists

**Given** any of those assertions fails
**Then** it fails loudly with a message naming the invariant it defends and why it exists

**Proof:** every failure message carries, in this order: the **AD id** (`AD-1`), the **rule in one clause**
("there is no agent-callable accept tool on any MCP surface"), the **consequence** (what breaks if it is
false), and the **actionable next step** for the person who hit it. Prove it the way story 1.2's
"load-bearing probes" did: **break the thing, capture the real failure output, restore, re-verify.** A
message you did not observe is a claim, not a proof. §6.3 requires the captured output in the Debug Log.

**Notes:** the target reader is someone hitting this in six months with no context, so
`expect(violations).toEqual([])` is a **failing grade for AC2** even when it is a correct assertion — its
output names nothing. **Do not reach for a message argument to `expect`:** no test in this repo uses one
(measured across all 105 core suites), so it is not the house idiom whatever `bun:test` may support. Instead
**build the diagnosis into the asserted value** — make the violation objects carry their own explanation, so
the diff bun prints *is* the message:

```ts
// The value under assertion carries the diagnosis, so the failure output explains itself.
expect(violations.map((v) => `${v.file}: ${v.why}`)).toEqual([]);
```

…or guard with an explicit `throw new Error(<the full paragraph>)` before the `expect`. The house pattern
that already does this well is `apps/web/lib/state-root.test.ts`'s decoy readback: the assertion's *value*
carries the diagnosis.

### AC3 — fast enough that skipping it is never tempting

**Given** the assertions run in the manual pre-commit trio
**Then** they are fast enough that running them is never the reason they get skipped

**Proof:** `invariants.test.ts` completes in **under 2000 ms** wall-clock, measured from `bun test`'s own
per-file timing, reported in the Debug Log. Walk the source tree **once** into a cached in-memory index and
have all five invariants read that index — not five independent walks.

**Notes:** the concrete threat to this AC is `tsc`. Story 1.2 measured its compile harness at *"~0.35s per
fixture, ~1.4s per suite"* (its Completion Note 7). **Add no new `tsc` invocation in this story** — see
§5.5-D8, which also states the rule that governs compile-time invariants if you ever do need one.

### AC4 — the prove-run, five legs, under a sandboxed state root

**Given** `TELAR_HOME` points at a temp directory
**When** one scripted run exercises the substrate
**Then** an `agent-facing` event wakes a subscriber while a `human-facing` one provably does not push
**And** a spend record attributes to an owner and reads back through a projection
**And** a `loom-verify` call wins a freed slot ahead of genuinely queued `loom-build` work
**And** a stale lease reclaims to `failed` and never to `done`
**And** the real `~/.telar` is untouched throughout

Those five are labelled **L1 … L5**, in that order.

**Proof:** `packages/core/test/track-a-prove-run.test.ts`, one named `test()` per leg inside
`describe("track-a prove-run")`, each printing one transcript line. The whole run is one command:
`TELAR_HOME=$(mktemp -d) bun test -t "track-a prove-run"` from the repo root — which produces the transcript
**and** the `across N files` discovery figure in the same output. **Verify the selector actually selects the
legs and nothing else**: the output must report the exact number of legs passing (five, unless you split one),
with the rest filtered out. If `-t` turns out not to match against the `describe` scope in Bun `1.3.14`, say
so and give the command that does — do not quietly report a run that selected a different set.

**Notes — the words that carry weight in this AC:**

- **"one scripted run"** — one command, one process, legs in order. Not five unrelated unit tests.
- **"serving"**, from the dispatch notes: *"Each leg must demonstrate the port SERVING something, not merely
  that the module loads."* A leg that imports a module and asserts it is defined does not satisfy its AC.
- **"provably does not push"** (L1) — structural, not documented. `publish()` returns a `PublishResult`
  carrying `wakeDelivered`; story 1.2's Completion Note 4 says that field exists precisely to make this
  observable. Assert `wakeDelivered === 0` for the `human-facing` publish *and* that
  `subscribeAgentFacing` refuses a `human-facing` name, *and* that an ordinary `subscribe` on the same name
  did receive it (so the zero is "not pushed", not "not delivered at all").
- **"genuinely queued"** (L3) — real contention. Fill the pool with `loom-build`, queue two more
  `loom-build`, then arrive `loom-verify` **after** them, then free exactly one slot and show the verify
  won it. And `admissionSnapshot()` must **name why** (the SPEC success signal says "with
  `admissionSnapshot()` naming why"): capture the snapshot at the moment of contention and assert the
  priority order and the waiting-by-class counts are both readable from it.
- **"reclaims to `failed` and never to `done`"** (L4) — two halves. The behavioural half: a stale lease
  reclaims. The structural half: `done` is **not expressible** in the reclaim result type — story 1.2
  already pinned this against the compiler in `session-lease.test.ts`'s
  ``AC11 `done` is NOT assignable to LeaseReclaim — the moat, checked by tsc``. **Cite that test by title; do
  not re-run tsc for it** (AC3). Re-read the real title off the file before quoting it.
- **"untouched throughout"** (L5) — see §5.5-D6 for the exact mechanism, and §0 rule 3 for why this one has
  teeth.

### AC5 — the gate

**Given** the run completes
**Then** the full core suite is green and `bunx tsc --noEmit` is clean in both `packages/core` and `apps/web`

**Proof:** §6.3's checklist, with real pasted output.

**Notes:** `bun run lint` is **not** a clean baseline — ~77k pre-existing problems in `apps/web`, mostly
under `.next-desktop/` build output — and is not this story's to fix. It is also not in AC5's text. You
should have no `apps/web` file to lint.

---

## 3. Scope fences — what this story does NOT do

| Not in scope | Why, and where it lives instead |
| --- | --- |
| **"no `SessionProfile` field can widen a tool grant"** and the **"unmet `requiredCapability` fails pre-stream" leg** | Moved to **story 2.1** by explicit ruling in this story's dispatch notes — asserted where the type is built, rather than creating a dependency on a later epic. `spec-runtime-foundations/stories.yaml` #8 still lists the first of these here and #9 still lists the second as a sixth prove-run leg; **`epics.md` supersedes both** (planning decision 4). RF's six-port success signal is jointly satisfied by 1.3 + 2.1 |
| Editing `bunfig.toml` | §0 rule 2. Unresolved `[Review][Decision]` on story 1.1; the human's call |
| Any change to `packages/core/src/**` | This is a test-only story. A `src` change means an invariant found a real violation — see §5.5-D7, which does not resolve it by editing `src` either |
| Any change to `apps/web/**` | Track B and C's files. Story 1.1's cross-track AC6 finding and story 1.2's `sessions/` co-tenancy finding both established the "record it, don't cross" protocol |
| Declaring a concrete event in `src` | §0 rule 5. The event catalogue is deferred per-module by AD-21; `event-bus.test.ts` is the only place event names exist and they are fixtures |
| Adding CI | Declined at spine-authoring time (AD-19, `SPEC.md` non-goals). AD-19's assertions run in the **manual** trio. Do not add a workflow file, a hook, or a script that pretends to be one |
| A repo-wide "no raw control characters in source" scan | Story 1.2's Completion Note 10 recommended it and **deliberately declined it**: `apps/web/components/projects/git-tab.tsx` still carries 2 NUL bytes (open from story 1.1, "not yours"), so the scan would fail on day one or need an out-of-scope edit. Not one of AD-19's five. §5.5-D7's exception mechanism would technically let it land quarantined — **do not**. Add it when that residual clears |
| Fixing story 1.2's open residual (its Completion Note 15) | `releaseAdmission(cls)` cannot detect a class mismatch. Closing it means changing AC9's asserted semantics — the operator's call. §5.5-D9 tells you how to write invariants that are *consistent with* the residual, which is different from fixing it |
| Extracting a shared test helper module | `packages/core/test/` holds 105 self-contained `*.test.ts` files (measured 2026-07-26 at `b71402a`) and **has never held a helper module**. Story 1.2's Completion Note 7 duplicated a ~25-line harness across two suites rather than introduce a file shape the convention does not have. Follow that |
| Tuning admission, wiring `processCeiling` into live clamps, class-tagging `executor.ts` | All three are named non-goals in `SPEC.md` and Deferred in the spine |
| A UI for admission or bus state | `SPEC.md` non-goals: "`admissionSnapshot()` is an export; whether a surface renders it is that surface's spec to decide." NFR-RF-5 — nothing in this epic is user-visible |

---

## 4. Tasks / Subtasks

Two legs, in order. **Leg A first**: its scan index is what tells you whether any invariant has a
pre-existing violation, and §5.5-D7's ruling needs that answer before you write assertions.

### Leg A — the invariant suite (AC1, AC2, AC3)

One new file: `packages/core/test/invariants.test.ts` (naming and test-title rules: §5.5-D10).

- [ ] **T-A0 — inventory before you assert.** Write the scan index first and print what it found. Do not
      write a single `expect` until you have looked at the index and know the current violation count for
      all five invariants. Record the inventory in the Debug Log. (This is the step that makes §5.5-D7
      actionable instead of a surprise at repair time.)
  - [ ] Repo-root resolution: walk up from `import.meta.dir` until a directory contains **both**
        `bunfig.toml` **and** a `packages/` directory; **throw** if you reach the filesystem root. A test
        that silently scans nothing is the failure §0 rule 1 exists to prevent.
  - [ ] One recursive walk, one cached index (§5.5-D0 for the exact shape, the exclude list and the
        anti-vacuity floors). Build it **once** at module scope; every `describe` reads it.
  - [ ] Assert the four §5.5-D0 floors: total files walked, `isClient` count (by **directive**), `*-mcp.ts`
        count, and files under `packages/core`. Measured pointers to sanity-check against are in §5.5-D0 —
        they are lower bounds to re-measure, not equalities.
- [ ] **T-A1 — INV-1: no MCP surface exposes an accept tool (AD-1 / NFR-X-1).** Per §5.5-D1 — **three** parts,
      because AD-1 says the moat is enforced twice and names the construction half.
  - [ ] Part 1, the tool surface: static extraction of every `tool("<name>", …)` literal and every
        `createSdkMcpServer({ name: … })` (three servers: `loom`, `ultra`, `out`); pinned `{server → tools}`
        inventory asserted **equal**; word-boundary deny check; the in-source note about
        `resolveProjectMcpServers` being out of static reach.
  - [ ] Part 2, the construction half: `acceptLoom` is the only `.state = "done"` writer in
        `packages/core/src`; it is not imported by `loom-mcp.ts`; its only importer is the accept API route;
        it refuses a blank `by`; `tick.ts` assigns `done` nowhere.
  - [ ] Part 3, the hook: the chat route wires `PreToolUse`, and the guardrail names `LOOM_START_TOOL` and
        `LOOM_ANSWER_BLOCKED_TOOL` — assert on the exported constants, never on the reason strings.
  - [ ] The discriminating fixture (§5.5-D0b); AC2 message quality; AC2 revert-probe captured.
- [ ] **T-A2 — INV-2: the verifier stack is granted no write or edit tools (AD-2 / NFR-X-2).** Per §5.5-D2 —
      **read the four existing tests first and assert the gap, not a fifth copy.**
  - [ ] Verify §5.5-D2's table of existing coverage still holds; cite it in-source.
  - [ ] The consolidating runtime assertion: the **ten**-name deny set is disjoint from `VERIFIER_TOOLS`, plus
        the floor.
  - [ ] The grant check on `verifier.ts` and `critic.ts` includes `restrictTools: true` — the field that is
        the actual wall — and pins that `critic.ts` **imports** the array rather than re-declaring it.
  - [ ] New coverage: `verify-thread.ts` and `panel.ts` grant nothing and call no `agent(`; `panel.ts` imports
        no `node:fs`.
  - [ ] New coverage: the verification-surface inventory, with each file's classification stated in-source
        (judge / must-not-grant / setup-wall). `verify-lane.ts`'s no-judge-import half is **cited** to
        `m10-verify-lane.test.ts`.
  - [ ] `ULTRA_CHILD_TOOLS` is deliberately write-capable and must not be swept up.
- [ ] **T-A3 — INV-3: no module reads another module's `TELAR_HOME` subtree by path (AD-5).** Per §5.5-D3.
  - [ ] Re-derive the 18-site path-composition table; pin it. **Not** the five resolvers — newer code imports
        `telarDir` instead of re-deriving it.
  - [ ] Per-site ownership check; the "cross-module reuse goes through an exported port" shape.
  - [ ] **Assert nothing about `projects/` or `workspace/`** — they do not exist as subtrees today (§5.5-D3, point 2).
  - [ ] Record the two known co-tenancies as *named, justified* entries, not as silence.
  - [ ] `scripts/backfill-tool-detail.ts` as a `KNOWN_VIOLATIONS` entry under D7 — D0's roots include `scripts`, so
        your scan **will** reach it.
- [ ] **T-A4 — INV-4: client components import no core runtime (AD-3 / NFR-X-3).** Per §5.5-D4.
  - [ ] Directive-based `isClient` detection (T-5: 119 real, 123 substring; the gap includes a file importing
        `node:fs`).
  - [ ] Type-only check that survives **multi-line** imports (T-4).
  - [ ] Transitive BFS following **value edges only** — the decision that keeps the invariant green-and-real
        rather than permanently red (§5.5-D4, point 2). Assert `godview.ts` is in the visited set by name.
  - [ ] Anti-vacuity floors on client files visited, import statements examined, and edges traversed.
- [ ] **T-A5 — INV-5: no module writes a shared runtime service's state directly (AD-20).** Per §5.5-D5.
  - [ ] `usage.ndjson` composed in exactly one non-test module; `apps/web/lib/store.test.ts` excluded or
        allow-listed by name with a reason; the three production `logUsage` call sites pinned; the
        `apps/web/lib/store.ts` re-export asserted.
  - [ ] The lease filename appears in exactly one module (and `sessions.ts` composing a *directory* is the
        AD-16 shape that must stay passing).
  - [ ] Bus and admission hold no file: assert their state is unreachable except through their ports, and
        **cite** the existing snapshot-immutability test rather than duplicating it.
  - [ ] The D9 handle invariant: no `packages/core/src` file outside `admission.ts` calls `releaseAdmission(`.
- [ ] **T-A6 — AC3 budget.** Measure the file's wall-clock. If it exceeds 2000 ms, the cause is almost
      certainly a second tree walk or a spawned process — fix that, do not raise the threshold.

### Leg B — the Track A prove-run (AC4)

One new file: `packages/core/test/track-a-prove-run.test.ts`.

**Read §5.5-D11 first.** Story 1.2 already unit-tests four of these five legs. D11 says exactly what that
means for what you write: each leg exercises its port for real, asserts only its own AC clause, prints its
transcript line, and **cites** the suite that owns the exhaustive coverage. The unique content of this leg is
the composition, the transcript, and L5.

- [ ] **T-B0 — the sandbox.** House `TELAR_HOME` idiom (§5.4), `resetBus()` and `resetAdmission({})` in
      `beforeEach`, full env restore in `afterAll`. `resetAdmission({})` is not optional — story 1.2's
      Completion Note 12 made the ceiling re-read the environment on every entry point, so a
      `TELAR_MAX_AGENTS` in the developer's own shell would otherwise change L3's arithmetic.
- [ ] **T-B1 — L1, the bus.** Declare a fixture catalogue under a module name of this suite's own; one
      `agent-facing` fact, one `human-facing` fact. Attach a wake handler to the first and an ordinary
      subscriber to the second. Publish both. Assert: the wake handler ran; the `human-facing` publish
      reports `wakeDelivered === 0` **and** `delivered >= 1`; `subscribeAgentFacing` on the `human-facing`
      name **throws**.
- [ ] **T-B2 — L2, attributed spend through a projection.** `logUsage` one entry carrying `ownerKind` +
      `ownerId` (`UsageOwnerKind` is `z.enum(["session", "loom", "ultra"])`; `logUsage` returns `boolean` —
      assert the return, not just the absence of a throw), then read it back through a **projection**
      (`ledgerSpendUsd({ownerKind, ownerId})` is the attribution-shaped one; `usageSummary` /
      `usageCostBySession` are the aggregate ones), never by opening `usage.ndjson`. Assert the file landed
      **inside the temp root**. Add the tolerant-reader half: append one record written in the
      pre-attribution shape and show it still counts and does not throw — every `UsageEntry` field **except
      `ts`** carries a zod `.default(…)`, including `ownerKind` / `ownerId` / `entryKey`. `ts` alone is
      required, which is why `logUsage` takes `UsageEntryInput = { ts: number } & Partial<UsageEntry>`. That
      tolerance is the AD-7 property being demonstrated.
- [ ] **T-B3 — L3, admission under real contention.** Per AC4's "genuinely queued" note. Take every slot
      through the **handle** `acquireAdmission` returns (§5.5-D9). Capture `admissionSnapshot()` at
      contention. **Drain every waiter and release every slot before the test ends, in `finally` blocks** — **T-6** in §5.6:
      a leaked waiter makes `resetAdmission` throw and takes the whole run down.
- [ ] **T-B4 — L4, the lease. Read §5.5-D12 before starting: this leg has two halves with different scopes,
      and the half that is genuinely new needs a module the earlier drafts of this story never named.**
  - [ ] The **reclaim-decision half** — a stale lease resolves `reclaimable`, never `done`, on **both** roots
        (loom-owned and session-owned), since AD-16's claim is one primitive two lifetimes. This is already
        exhaustively covered: **cite** `session-lease.test.ts`'s
        `AC11 a STALE lease resolves to reclaimable on BOTH the loom path and the session path`, its reclaim-union
        enumeration, its ``AC11 `done` is NOT assignable to LeaseReclaim`` tsc test, and its
        `AC11 the lease filename is` \``.runner-lease`\` `on BOTH lifetimes` — per D11, cite, do not re-run.
  - [ ] The **terminal-state half** — `reclaimable` actually becoming a persisted `failed`. This is the new
        content, it is **loom-only**, and its mechanism is `dispatcher.ts`'s `reconcileStuckLooms(liveness)`
        with `runner/liveness.ts`'s `crossProcessLiveness(...)` injected. See §5.5-D12 for why, and for the two
        traps in it.
  - [ ] Age the lease with an **injected clock**, never `sleep` (T-9).
- [ ] **T-B5 — L5, `~/.telar` untouched.** Per §5.5-D6: the guard is armed (layer 1); the before/after
      snapshot of the real path — **never-create, never-delete**, and never an "it does not exist" assertion
      (layer 2, the genuinely new content); positive evidence that the writes landed under the temp root
      (layer 3); and the fake-`HOME` child probe **cited**, not rebuilt (layer 4).
- [ ] **T-B6 — the transcript.** One line per leg, stable prefix, printed via `console.log`. It is the
      artifact AC4's dev-server-proof line calls "the scripted run's transcript". Paste it into the Debug Log
      verbatim.

### Leg C — the gate and the record

- [ ] **T-C1 — discovery proof.** §6.2, both mechanisms, for both new files.
- [ ] **T-C2 — the trio.** §6.3's full checklist, real output.
- [ ] **T-C3 — the record.** §9 Debug Log and Completion Notes; §10 File List measured with the change
      staged (`git add -A -- packages/core && git diff --cached --name-status`); §11 Change Log with a
      suggested conventional-commit message.

---

## 5. Dev Notes

### 5.1 The architecture rules that bind this story

| Rule | What it obliges you to do here |
| --- | --- |
| **AD-19** — load-bearing invariants are executable | The five assertions exist in `bun test` and run in the manual trio. `Binds: AD-1, AD-2, AD-3, AD-5, AD-20` — that binding list *is* AC1's list |
| **AD-1** — Human-Accept Moat | `ready → done` is human-only; there is no agent-callable accept tool on any MCP surface and none is ever added. **Enforced twice** — by construction in `packages/core` (`looms.ts`, `tick.ts`) and at the tool layer by the chat route's `PreToolUse` hook, in every SDK permission mode. INV-1 must reach both halves |
| **AD-2** — Verifier capability wall | `verifier.ts`, `verify-thread.ts`, `critic.ts`, `panel.ts` and every loom-altitude lab agent are granted no write or edit tools. "The wall extends to **new** verification surfaces" is why INV-2 needs a pinned inventory, not just four hard-coded filenames |
| **AD-3** — core is server-side only | Client components import **types only**. Runtime core lives in Route Handlers, Server Components and `instrumentation.ts`. The failure mode is concrete and already documented in `godview.ts`: *"a single runtime VALUE import drags `async_hooks` into the browser bundle and breaks the build"* |
| **AD-5** — one owner per `TELAR_HOME` subtree | The spine's assignment is `projects/<id>/looms/<loom-id>/` → looms · `workspace/` → organization-workspace · `ultra/<runId>/` → ultra · `sessions/<sessionId>/` → session, and no module reads or writes another's subtree by path. **Two of those four are the *planned* layout and do not exist in the tree yet** — today it is the flat `looms/<id>/`, plus `ultra/`, `sessions/`, `worktrees/` and `runs/` (legacy). INV-3 asserts against what exists (§5.5-D3, point 2), not against the diagram. Root-level files and state belonging to no module are AD-20's, not AD-5's |
| **AD-20** — shared runtime services are the sole writer of their own state | The usage ledger, bus subscriptions and admission accounting belong to no module's subtree; they are written **only** through their core service's port. "No module opens those files" is INV-5's exact claim |
| **AD-14 / AD-21** — the bus | L1's legs. Delivery class is a required field; cross-module subscription only to declared events; undeclared events are internal |
| **AD-16** — one lease, two lifetimes | L4 must exercise **both** roots. A stale lease can at worst produce a false-positive `failed`, **never** an auto-`done` — and a false `done` is a breach of the accept moat, which is why this leg sits in the same story as INV-1 |
| **AD-17** — one admission controller | L3. Precedence, not a held-open slot; classes; the snapshot naming why |
| **AD-18** — one append-only spend ledger | L2. Every readout is a projection over `usage.ndjson`; adding a second reader or a second accumulator is the failure FR-RF-2 exists to end |
| **AD-15** — restart doctrine | Why L4's terminal state is `failed`-or-resumable and never `done` |
| **Design Law** — deterministic control flow in code | L4 ages a lease by injecting `now`, never by sleeping. Non-determinism lives at injected seams |

**And the NFRs a reviewer will check:**

| NFR | Obligation | Where it is discharged |
| --- | --- | --- |
| **NFR-X-14** — executable invariants | AD-1, AD-2, AD-3, AD-5, AD-20 are assertions in `bun test`, run in the manual pre-commit trio | Leg A |
| **NFR-X-1 / X-2 / X-3 / X-4** | The four walls INV-1 … INV-5 encode. Restated in `project-context.md` as non-negotiable | Leg A |
| **NFR-RF-1** — reuse, never rebuild | The scan idiom, the child-probe idiom, the `tsc` harness and the `TELAR_HOME` sandbox all already exist. §5.4 names each one's home. Do not invent a variant | §5.4 |
| **NFR-RF-5** — nothing user-visible | No surface, no route, no component, no `src` file. This story adds two test files | §0, §3 |
| **NFR-RF-6** — the admission policy half is pure | L3 must not need I/O or a clock to produce contention | T-B3 |

### 5.2 Files to touch

| File | Action | What it is today → what changes | What must not break |
| --- | --- | --- | --- |
| `packages/core/test/invariants.test.ts` | **NEW** | does not exist → the five AD-19 assertions + the shared scan index (Leg A) | — |
| `packages/core/test/track-a-prove-run.test.ts` | **NEW** | does not exist → the five-leg prove-run (Leg B) | — |
| `bunfig.toml` | **DO NOT EDIT** | `pathIgnorePatterns` at `:12` | §0 rule 2; `git diff --stat` must be empty |
| `packages/core/src/**` | **DO NOT EDIT** | — | §0 rule 4; §5.5-D7 |
| `apps/web/**` | **DO NOT EDIT** | — | Track B/C's write set |
| `packages/core/test/event-bus.test.ts` | **DO NOT EDIT** | holds the fixture catalogue and the `tsc` harness | Your prove-run uses a **different** module name and calls `resetBus()`; a collision here is a re-declaration error |
| `packages/core/test/session-lease.test.ts` | **DO NOT EDIT** | holds the tsc-checked ``AC11 `done` is NOT assignable to LeaseReclaim`` test | L4 **cites** it by title; it does not re-implement it |
| `packages/core/test/admission.test.ts` | **DO NOT EDIT** | holds the snapshot-immutability assertion INV-5 cites | — |
| `packages/core/test/ultra-runner.test.ts` | **DO NOT EDIT** | holds `peak === 4` | NFR-RF-8; it must stay byte-identical across the whole epic |

### 5.3 Read these before you write

Non-negotiable. Skipping this step is the primary cause of implementation failures and review cycles here.

**The assertion targets** — you cannot pin a surface you have not read:

- `apps/web/lib/loom-mcp.ts` — the 13-tool `loom` server. Read the tool list and notice **what is absent**:
  there is a `reject_loom` and an `answer_blocked`, and **no accept**. That absence is the moat, and INV-1
  is what keeps it absent.
- `apps/web/lib/ultra-mcp.ts` — the 3-tool `ultra` server.
- `packages/core/src/engine.ts` — `agent()`'s own `createSdkMcpServer({name: "out"})` with the single
  `emit_result` tool. **This is an MCP surface too**, and INV-1's "no MCP surface anywhere" includes it. Also
  read `AgentOpts`, and `≈:148`'s `const releaseSlot = await acquireAdmission(admissionClass)` — the release
  handle from story 1.2's Completion Note 13, which §5.5-D9 turns into an invariant.
- `apps/web/app/api/chat/route.ts` — the `PreToolUse` hook. Read how it matches tool names. This is AD-1's
  second enforcement site and INV-1's second half. **Read only.**
- `packages/core/src/verifier.ts` — the header comment (it explains why `restrictTools` and not
  `allowedTools`), the exported `VERIFIER_TOOLS` array, and the grant at `≈:244`. Then `critic.ts`'s grant,
  which imports `VERIFIER_TOOLS` from `./verifier`. Then `verify-thread.ts` and `panel.ts`, whose headers
  state their own posture — `panel.ts` says *"PURE functions only, no fs, no agent calls"* — and
  `verify-lane.ts`, whose header states it is the setup wall, not the judge.
- `packages/core/src/looms.ts` — **`acceptLoom`**, specifically. It is the only `.state = "done"` writer in
  `packages/core/src`, and its four refusals (blank `by`; a child loom; a non-`ready` accept without an
  audited override; a void accept, which appends an `accept-aborted` event **before** any state flip) are the
  by-construction half of AD-1 that INV-1 part 2 pins. Also `telarDir` / `loomsDir` / `loomDir` and the id
  guard.
- **The four tests that already assert the verifier wall** — read them before writing INV-2, so you assert the
  gap rather than a fifth copy: `packages/core/test/roster.test.ts`,
  `packages/core/test/m10-verify-lane.test.ts`, `packages/core/test/m10-lane-escalation.test.ts`. §5.5-D2 has
  the table.
- **The two tests that already enumerate an MCP tool set** — `apps/web/lib/ultra-mcp.test.ts`'s
  `"registers exactly ultra / ultra_status / ultra_stop, matching ULTRA_AUTO_TOOLS"` (the exhaustive
  `instance._registeredTools` idiom) and `apps/web/lib/loom-mcp.answer-blocked.test.ts` (spot-checks named
  tools; asserts `LOOM_START_TOOL` / `LOOM_ANSWER_BLOCKED_TOOL` are absent from `LOOM_AUTO_TOOLS`). Neither
  covers the whole surface and neither mentions the moat — that is the gap INV-1 fills.
- `packages/core/src/usage-ledger.ts` — read the **whole header block** and the write-guard near `≈:480`
  (`process.env.NODE_ENV === "test" && !process.env.TELAR_HOME?.trim()` → throws
  *"logUsage refused: NODE_ENV=test with no TELAR_HOME — pin a temp home before writing the usage ledger."*).
  That guard is what makes L2 safe, and its scope is exactly what §0 rule 3 is about. **Know precisely what it
  does not protect:** any write outside a `NODE_ENV=test` process (dev and production are unguarded by
  design); any writer other than `logUsage` (it is a local guard, not a write interceptor); and a
  `TELAR_HOME` that is *set but wrong* — it catches "unset or blank", never "pointing somewhere real by
  mistake". Also the port surface: `logUsage` (returns `boolean`), `usageSummary`, `usageCostBySession`,
  `usageTokensBySession`, `ledgerSpendUsd`, `ledgerReadUnavailable`, `ledgerReadDegraded`.
- `packages/core/src/schemas.ts` — `UsageOwnerKind = z.enum(["session", "loom", "ultra"])` and `UsageEntry`.
  Every field **except `ts`** carries a zod `.default(…)`, including `ownerKind`, `ownerId` and `entryKey`;
  `ts` alone is required, which is why `logUsage` takes
  `UsageEntryInput = { ts: number } & Partial<UsageEntry>`. That tolerance is *why* L2's tolerant-reader half
  works and is the AD-7 property it demonstrates.
- `packages/core/test/usage-ledger.test.ts` — its three write-guard tests, including the real child-process
  proof that spawns `process.execPath` with `TELAR_HOME: " "` and `NODE_ENV: "test"` and asserts nothing
  appears under a fake `HOME`'s `.telar`. **That is the test §5.5-D6 layer 4 tells you to CITE, not copy.**
- `packages/core/src/event-bus.ts` — `DeliveryClass`, `canWake`, `EventDeclaration`, `PublishResult`
  (`{name, deliveryClass, delivered, wakeDelivered, failed}`), `EventPort`, `declareEvents`, `subscribe`,
  `subscribeAgentFacing`, `publish`, `eventDeclaration`, `declaredEvents`, `resetBus`.
- `packages/core/src/admission.ts` — `acquireAdmission` (returns `Promise<() => void>`), `releaseAdmission`
  and **the paragraph above it** stating what it cannot detect (that paragraph is story 1.2's residual, and
  §5.5-D9 depends on it), `admissionSnapshot`, `configureAdmission`, `resetAdmission`, `ADMISSION_CLASSES`,
  `DEFAULT_ADMISSION_CEILING`, `admissionCeiling`, `assertAdmissionClass`.
- `packages/core/src/runner/lease.ts` — `LeaseFs`, `RunnerLease`, `leaseFile`, `writeLease`,
  `heartbeatLease`, `readLease`, `isLeaseFresh`, `leaseReclaim` and `LEASE_RECLAIM_OUTCOMES`. Read the
  MOAT paragraph in the header.
- `packages/core/src/sessions.ts` — `sessionDir`, and the session-lease wrappers that defer their reclaim
  decision to `leaseReclaim`. Note what is **not** there: no `state` field, no state machine (§5.5-D12.4).
- **`packages/core/src/dispatcher.ts`'s `reconcileStuckLooms`, `packages/core/src/runner/liveness.ts`'s
  `crossProcessLiveness`, and `packages/core/src/runner/recover.ts`'s `reconcileState`** — the chain that turns
  a stale lease into a persisted `failed`, and the only place the `never done` moat is actually written. L4's
  new half lives here and nothing else in this story would lead you to these three files. §5.5-D12.
- `packages/core/test/m5-reconcile-liveness.test.ts` — its two tests (stub-oracle coverage of the same sweep)
  and its `seed(state)` helper, which is the shape L4 copies.
- `packages/core/test/admission.test.ts` — specifically
  `gives a freed slot to loom-verify ahead of a queued build fan-out` (≈`:288`) and
  `AC5 admissionSnapshot NAMES WHY: priority order and waiting-by-class are both readable` (≈`:314`). That is
  **line-for-line the contention shape T-B3 needs** — read it rather than re-deriving it. The one required
  difference: those tests legitimately call `releaseAdmission(cls)` directly; T-B3 releases through the handle
  (§5.5-D9).
- `packages/core/test/accept-ready.test.ts` — it already asserts
  ``a blank or whitespace-only `by` is rejected, even on an otherwise-ready loom`` (≈`:218`). INV-1 Part 2 pins
  the same refusal for a different purpose (the moat inventory); knowing this exists saves you wondering
  whether you missed something.
- `packages/core/src/manifest.ts` — `telarDir()` and `atomicWrite`. `packages/core/src/looms.ts` —
  `telarDir` / `loomsDir` / `loomDir` and the id guard.

**The idioms you are reusing** — read these for *shape*, and copy rather than invent:

- **`apps/web/lib/state-root.test.ts`** — the most important read in this list. It is the house precedent for
  (a) a repo-wide source scan, (b) generated child probes, (c) a child with an mkdtemp'd `HOME` **and**
  cwd so a regressed resolver "has nowhere to write that isn't cleaned up", and (d) a **decoy** so that
  "nothing new appeared" is not mistaken for "nothing was written". Read its header comment in full; it
  explains why each of those exists. Its `os.homedir()` note is load-bearing for §5.5-D6: *"`os.homedir()`
  under Bun is resolved at process start and ignores an in-process `process.env.HOME` write, so a fake home
  only exists for a child."*
- `packages/core/test/event-bus.test.ts` — the `typecheck()` harness (`REPO_TSC` via `process.execPath`,
  `--ignoreConfig`, fixtures in an mkdtemp'd dir, asserted in **both** directions) and the sandbox idiom.
  You are **not** adding a tsc call (AC3) — read it so you know the harness exists and where, because
  §5.5-D8 forbids the cheap alternative.
- `packages/core/test/session-lease.test.ts` — the tsc-checked structural claim L4 cites.
- `packages/core/test/state-root.test.ts` (the **core** one, distinct from the web file above) — the
  two-resolver agreement test.

**The contracts** (skim for the clauses cited here; do not re-derive):
`epics.md` § Story 1.3 · `spec-runtime-foundations/SPEC.md` CAP-6 + Success signal + Non-goals ·
`spec-runtime-foundations/brownfield.md` § "The gaps this SPEC closes" · `ARCHITECTURE-SPINE.md` AD-1, AD-2,
AD-3, AD-5, AD-19, AD-20 and the **State root** tree · `WORK-SPLIT.md` § "Sequencing the whole thing" (the
phase-2 gate) · `project-context.md` (all of it — 142 lines) · `apps/web/AGENTS.md`.

### 5.4 Patterns and conventions — copy these exactly

- **Runtime & tooling.** Bun workspaces, **Bun only**. Bun `1.3.14` (measured 2026-07-26). `bun.lock` is
  mutated only by `bun install` / `bun add` — and this story needs **no new dependency**. `@telar/core` is
  ESM with no build step (`exports["."] → ./src/index.ts`), TypeScript `^6.0.3`; `apps/web` pins `^5`,
  deliberately not unified. Every command runs inside a workspace dir; there is no root `scripts` block.
  `bun test` from the repo root is the **binary**, not a script, so it is exempt and is what §6 uses.
- **Test layout.** Core specs live **flat** in `packages/core/test/`, no subdirectories, no helper modules
  (105 files, measured; every one self-contained). Web specs are colocated beside the module they cover under
  `apps/web/lib/`.
- **Import line**, the most common form in the suite:
  `import { afterAll, beforeEach, describe, expect, test } from "bun:test";`
- **`test(...)`, never `it(...)`.** Zero of the 105 core test files use `it(`.
- **`TELAR_HOME` sandbox idiom** — verbatim from `event-bus.test.ts`, which is the cleanest instance:
  ```ts
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-<prefix>-"));
  const ORIGINAL_HOME = process.env.TELAR_HOME;
  process.env.TELAR_HOME = home;

  beforeEach(() => { process.env.TELAR_HOME = home; }); // bun runs all files in ONE process
  afterAll(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
    else process.env.TELAR_HOME = ORIGINAL_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });
  ```
  **Restore the original, do not just delete it** — `bun test` runs every file in one process, so a suite
  that re-points `TELAR_HOME` and does not put it back silently re-roots every suite that runs after it.
  (`usage-ledger.test.ts` uses a shorter form that never restores; `event-bus.test.ts` and
  `session-lease.test.ts` restore. **Restore.**)
  If your suite imports a module that could capture the root at evaluation time, pin **before** the import
  with `await import("../src/…")`; static imports are hoisted and evaluated first. `session-lease.test.ts`
  documents this variant best; story 1.1 fixed four suites for exactly this and it is now settled. Note
  `m5-lease.test.ts` uses a third form — a bare `mkdtemp`'d directory with no `TELAR_HOME` at all — which is
  correct for a module that takes a directory as a parameter. Your L4 needs the `TELAR_HOME` form because
  `sessions.ts` resolves the root itself.
- **`NODE_ENV=test` comes from the runner, not from repo config**, and that is worth knowing precisely because
  §0 rule 3 depends on it. Nothing in the repo sets it: no `bunfig.toml` preload, no env script, and the root
  `package.json` has no `scripts` block at all. It is proved *behaviourally* inside the suite —
  `usage-ledger.test.ts` asserts `expect(process.env.NODE_ENV).toBe("test")` in a file that never assigns it.
  So: inside `bun test`, the ledger's guard is armed. Outside it — `bun -e`, `bun run <script>`, a bare
  `bun file.ts` — it is not. That is the entire content of §0 rule 3, and it is why every probe you spawn
  passes `NODE_ENV: "test"` in its `env` explicitly.
- **Child probes**, when a claim is about the cwd, the home default, or an import-time read: generate the
  probe into an mkdtemp'd dir, spawn it through `process.execPath` (bun) with an mkdtemp'd `HOME` and cwd,
  import the module under test by **absolute path**, and print a JSON readback. `apps/web/lib/state-root.test.ts`
  is the reference. Pass `NODE_ENV: "test"` explicitly in the child env (§0 rule 3).
- **`spawnSync` import** is `import { spawnSync } from "node:child_process";` — the form already used by
  `event-bus.test.ts`, `admission.test.ts`, `session-lease.test.ts`, `usage-ledger.test.ts`,
  `loom-spend-idempotence.test.ts` and both web scan suites.
- **Running the compiler from a test**, if you ever must: `process.execPath` +
  `<workspace>/node_modules/typescript/bin/tsc`, never `node_modules/.bin/tsc` — that shim is
  `#!/usr/bin/env node` and this repo is bun-only, so there may be no `node` on `PATH` at all.
- **WHY header comments.** Non-obvious modules carry a header block explaining *why*, not *what*. Both new
  files earn one: `invariants.test.ts`'s header should state what AD-19 is, why there is no CI, and the
  anti-vacuity rule; `track-a-prove-run.test.ts`'s should state that it is `SPEC-runtime-foundations`'s
  success signal and the phase-2 gate.
- **Formatting.** No Prettier, no Biome, no formatter of any kind. ESLint exists only in `apps/web`. **Match
  surrounding style exactly** — that is the whole standard in `packages/core`.
- **No NUL bytes, no raw control characters in source.** A literal `\x00` in `usage-ledger.ts` once made a
  263-line module binary to git and invisible to grep — the diff rendered as `Bin 0 -> 11047 bytes` with zero
  reviewable lines. If you need a separator, write the escape sequence. Check your two new files before you
  finish.
- **Commits.** Conventional prefix + scope, explaining WHY: `test(core): …` is the right prefix for this
  story.
- **No CI.** The gate is manual and is yours to run (§6).

### 5.5 Design decisions already made for you

These are settled so you do not spend budget re-deriving them. **The semantics are binding; symbol names may
be adjusted — say so in Completion Notes if you change one.**

**D0 — the shared scan index.** One recursive walk at module scope, cached, read by all five invariants
(AC3). Shape:

```
type SourceFile = { rel: string; abs: string; text: string; isClient: boolean };
```

- **Roots walked:** `packages/core/src`, `packages/core/test`, `apps/web`, `apps/desktop`, `scripts`.
- **Extensions:** `.ts`, `.tsx`, `.mts`, `.js`, `.mjs`.
- **Excluded, by directory-name match anywhere in the path:** `node_modules`, `.next`, `.next-desktop`,
  `release`, `dist`, `build`, `.git`, `out`, `coverage`. **Also `_bmad-output`** — it holds a reference
  implementation whose imports belong to another location, it is excluded from test discovery by
  `bunfig.toml`, and scanning it would make an invariant fail on documentation. **`docs/` is not a root** —
  it is prose, and it is *stale* prose in exactly the places that matter (`docs/architecture-web.md` still
  says `lib/store.ts` owns `usage.ndjson`, which story 1.1 moved into core; `docs/architecture-core.md` still
  shows the pre-1.1 `??` form of the root resolver). An invariant that scans prose will fail on
  documentation of itself.
- **`isClient`** = the file's first non-comment, non-blank statement is a `"use client"` / `'use client'`
  directive. **This distinction is measured, not theoretical:** at `b71402a`, `grep -rl "use client"` over
  `app components lib hooks` matches **123** files, of which only **119** carry the actual directive. One of
  the four false positives is `apps/web/lib/permissions.ts`, which mentions the boundary in a comment and
  **imports `node:fs`, `node:os`, `node:path` and `node:crypto`** — so a substring match reports a
  server-only module as a client component and INV-4 fails on today's tree for a reason that is not a
  violation. See T-5.
- **Anti-vacuity floors** — assert these before anything else, with a message that says the index is broken
  rather than that an invariant is violated. Measured 2026-07-26 at `b71402a`, so treat as **lower bounds to
  re-measure, not equalities**: ≥ 400 files walked total; ≥ 100 files with `isClient` (measured: 119
  directives out of 123 substring matches); exactly ≥ 2 files matching `*-mcp.ts` under `apps/web/lib`
  excluding `*.test.ts` (measured: `loom-mcp.ts`, `ultra-mcp.ts` — and `find . -name "*-mcp.ts"` returns
  exactly those two); ≥ 100 files under `packages/core` (measured: 63 `src` + 105 `test`).

**D0b — every scan carries a permanent positive control ("the scan discriminates").** The house precedent is
`apps/web/lib/state-root.test.ts`'s `"the TELAR_HOME read idiom, across every source tree that resolves it"`
block, which pairs its floor count with a **fixture test proving the pattern itself still fires** — a
synthetic string that *should* match is fed to the same matcher and must be reported. `event-bus.test.ts`
does the same for its `fs.watch` source scan. **Do this for all five invariants.** It is strictly better than
the one-time revert probe §6.3 also asks for, because it survives in the suite: a scanner that stops matching
(a regex edited, a parser rewritten) fails immediately instead of going quietly green. Feed the synthetic
fixture through the **same code path** the real scan uses — a discriminator that calls a different function
proves nothing.

**Pass the fixture as an in-memory string, not as literal source text in this file.** `packages/core/test` is
one of the roots D0 walks, so a discriminator written as real source inside `invariants.test.ts` — a fake
`tool("accept_loom", …)` call, a fake `path.join(telarDir(), "workspace")` — is picked up by the very scan it is
meant to test and breaks INV-1's exact-equality inventory against the scanner itself. Call the extraction
function directly with a string. (This is the same self-reference hazard as T-13, arriving from the other
direction.)

**D1 — INV-1's assertable form.** AD-1 says the moat is **enforced twice** — "by construction in
`packages/core` (`looms.ts`, `tick.ts`) and at the tool layer by the chat route's `PreToolUse` hook". So
INV-1 has **three** parts, not one: the tool surface, the construction half, and the hook. Today the whole
invariant is enforced by prose only — `docs/integration-architecture.md` ("No route or MCP tool lets a model
call `acceptLoom`"), `docs/architecture-web.md` ("no agent-callable accept exists anywhere in the tree") —
and **no test anywhere enumerates the MCP surface and asserts no accept tool**.

**Part 1 — the tool surface.**

1. **Collect.** Every `tool(` call's first string-literal argument, and every `createSdkMcpServer({name: …})`
   server name, across the whole index. There are exactly **three** `createSdkMcpServer` call sites in the
   repo. Measured inventory at `b71402a`:
   - server `loom` (`apps/web/lib/loom-mcp.ts`) — 13 tools: `draft_bundle_file`, `propose_contract`,
     `read_bundle`, `list_looms`, `get_loom`, `start_loom`, `steer_loom`, `reject_loom`, `answer_loom`,
     `answer_blocked`, `resume_loom`, `cancel_loom`, `watch_loom`
   - server `ultra` (`apps/web/lib/ultra-mcp.ts`) — 3 tools: `ultra`, `ultra_status`, `ultra_stop`
   - server `out` (`packages/core/src/engine.ts`, built per-call inside `agent()`) — 1 tool: `emit_result`,
     exposed as `mcp__out__emit_result`. **This is an MCP surface too**, and AC1 says "no MCP surface".
   **Re-measure before you pin.** A count you did not derive from the tree is the defect this repo has hit
   most often.
   Static extraction is **safe here and that is a measured fact, not an assumption**: in all three servers
   every name is a bare string literal passed as `tool(name, description, shape, handler)` inside a literal
   `tools: [...]` array — no loop, no spread of a config-driven list, no template. Also collect the
   `mcp__<server>__<tool>` constants (`LOOM_START_TOOL`, `LOOM_ANSWER_BLOCKED_TOOL`, `LOOM_AUTO_TOOLS`,
   `ULTRA_AUTO_TOOLS`, `LOOM_ESCALATION_*`), since a tool name can be referenced as a const rather than
   inline.
2. **Pin.** Assert the collected set **equals** the inventory. A new tool fails the test until someone adds
   it deliberately — that is the mechanism, and the failure message must say so: *"a tool was added to an
   MCP surface. AD-1 forbids an agent-callable accept path: confirm this tool cannot move a loom from ready
   to done, then add it to the inventory in this test."* A substring deny-list alone is **not** the
   invariant, because `mark_delivered` would sail through it.
3. **Deny.** Word-boundary match the collected names against `accept|approve|done|complete|land|merge|ship|
   deliver|finalize|promote`. This is the belt to the inventory's braces, and it is what catches a tool added
   to the inventory carelessly. Note `answer_blocked` and `reject_loom` are the near-misses that must stay
   passing — a naive `/done|complete/` over *descriptions* rather than names would trip on them.
4. **Static is mandated; runtime enumeration is an option you should know about.** The constructed server does
   not expose its tools through the public SDK type (`McpSdkServerConfig = { type: 'sdk', name: string }`),
   but the real registered set is reachable through the undocumented, underscore-prefixed
   `server.instance._registeredTools` — and `apps/web/lib/ultra-mcp.test.ts`'s
   `"registers exactly ultra / ultra_status / ultra_stop, matching ULTRA_AUTO_TOOLS"` already does exactly
   that, exhaustively, for the `ultra` server. **Static extraction is what this story requires**, because it
   covers all three servers from one file in `packages/core/test/` without importing an `apps/web` module
   (which would need `mock.module("@telar/core", …)` installed before the import, per that suite's idiom) and
   without depending on a private field. Cite the runtime precedent; do not replace the static scan with it.
5. **The honest scope limit — state it in-source.** `packages/core/src/mcp.ts`'s `resolveProjectMcpServers`
   mounts **per-project, externally configured** MCP servers into the route's `mcpServers` map. Their tools
   are not in this repo and cannot be statically enumerated. The invariant therefore bounds *Telar's own*
   surfaces; external servers are governed by `strictMcpConfig: true` and the `PreToolUse` hook, not by this
   test. Say so in a comment — an invariant that silently claims more than it proves is the same defect as a
   vacuous scan.

**Part 2 — the construction half, in core.** This is the strongest of the three and it is cheap:

- `acceptLoom(id, by, opts?)` in `packages/core/src/looms.ts` is the **only** site in `packages/core/src` that
  writes `.state = "done"` (grep `'\.state = "done"'` → single hit). Assert that.
- `acceptLoom` is **not imported by `apps/web/lib/loom-mcp.ts`** — assert its `@telar/core` import list does
  not contain it, so no MCP tool has a call path to it.
- `acceptLoom` is imported by **exactly one** file in the repo: `apps/web/app/api/looms/[id]/accept/route.ts`,
  which passes `by` as the hardcoded string `"you"` and never reads it from the request body. Assert the
  import set is exactly that one file.
- `acceptLoom` refuses a blank `by` (`if (!by?.trim()) throw …`). Assert it — this is a runtime import of
  `looms.ts`, which core tests may do freely.
- `tick.ts` contains no `.state = "done"` assignment; it only *reads* `state === "done"` for subgoal
  readiness. Assert the absence, since AD-1 names `tick.ts` as part of the construction half.

**Part 3 — the hook.** Measured at `b71402a`: `apps/web/app/api/chat/route.ts` defines
`const preToolUseGuardrail = async (input: HookInput): Promise<HookJSONOutput> => {` and wires it as
`hooks: { PreToolUse: [{ hooks: [preToolUseGuardrail] }] }`. Inside, the moat check compares
`input.tool_name` against the imported `LOOM_START_TOOL` / `LOOM_ANSWER_BLOCKED_TOOL` and returns
`permissionDecision: "ask"` — deliberately regardless of `permissionMode`. Assert: the route wires a
`PreToolUse` hook; the guardrail names both constants; the two constants resolve to
`"mcp__loom__start_loom"` / `"mcp__loom__answer_blocked"`; and neither appears in `LOOM_AUTO_TOOLS`. **Assert
on the exported constants (symbols), not on the reason strings** — prose in a route you must not edit will
change for unrelated reasons, and an invariant that breaks on an unrelated edit gets deleted rather than
fixed.

**D2 — INV-2's assertable form. READ THIS BEFORE WRITING ANYTHING: most of INV-2 already exists.** Four
existing tests assert the wall today, and duplicating them is waste that a reviewer will call out:

| Existing test | What it already asserts |
| --- | --- |
| `packages/core/test/roster.test.ts` (≈`:138`) | `VERIFIER_TOOLS` excludes `Write`/`Edit`/`Bash`/`Agent` |
| `packages/core/test/roster.test.ts` (≈`:176`) | the **captured critic call**: `tools` equals `VERIFIER_TOOLS`, `restrictTools` is `true`, `disallowedTools` equals the six-name denylist |
| `packages/core/test/m10-verify-lane.test.ts` (≈`:371`) | `VERIFIER_TOOLS` bans the write tools; **greps `critic.ts` source** for `"VERIFIER_TOOLS"` and `"restrictTools: true"`; **greps `verify-lane.ts`'s imports** to prove it never imports `./verifier` or `./critic` |
| `packages/core/test/m10-lane-escalation.test.ts` (≈`:458`) | the same three grant fields on a captured call |

**So your job is the gap, plus one consolidating assertion, not a fifth copy.** Verify each of the four still
exists and still asserts what this table says (re-measure), then:

1. **The one consolidating runtime assertion, because AD-19 wants a named invariant in one place.**
   `import { VERIFIER_TOOLS } from "../src/verifier"` and assert the full deny set is disjoint from it:
   `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `BashOutput`, `KillShell`, `Agent`, `Task`,
   `TodoWrite`. The existing tests check four names; this checks ten. Plus an anti-vacuity floor:
   `VERIFIER_TOOLS.length >= 3` and it contains `Read`. *(Measured at `b71402a`: `VERIFIER_TOOLS` is `Read`,
   `Grep`, `Glob` plus **16** `mcp__playwright__browser_*` names — 19 entries total. The playwright tools drive and read, never
   write; `browser_take_screenshot` is marked "evidence only" in-source.)*
2. **The grant that is the actual wall — assert the right field.** The choke point is `agent()` in
   `packages/core/src/engine.ts`, and the availability wall is `restrictTools` → the SDK's `tools` option.
   `engine.ts`'s own header states that under `permissionMode: "bypassPermissions"`, **`allowedTools` alone
   does NOT restrict availability**. So an invariant that checks only `allowedTools` or only
   `disallowedTools` misses the load-bearing field. Assert all three fields are present on both grant sites
   (`verifier.ts`'s `verify()` and `critic.ts`'s `runCritic()`), noting `critic.ts` **imports**
   `VERIFIER_TOOLS` from `./verifier` rather than re-declaring it — that shared identity is itself worth
   pinning, because two copies of the list is how one of them drifts.
3. **The abstainers — this is genuinely new coverage.** `verify-thread.ts` and `panel.ts` introduce **no**
   tool grant of their own: assert neither file contains `tools:`, `allowedTools`, `restrictTools`,
   `disallowedTools` or `agent(`. Measured at `b71402a`, both are clean and both are one indirection further
   out — `verify-thread.ts` takes an injected `deps.runIntegrationVerify` and an injected `AutoRepairDeps.verify`;
   `panel.ts` holds only `panelSize` / `aggregatePanel` / `panelReason` / `classifyPanel` over already-produced
   verdicts, and `runPanel` — the thing that actually loops and calls `runCritic` — lives in `critic.ts`, not
   in `panel.ts`. Also assert `panel.ts` imports no `node:fs`; its header claims *"PURE functions only, no fs,
   no agent calls"*, so you are pinning a stated contract.
4. **The extension clause — also new.** AD-2 says the wall "extends to new verification surfaces". Pin an
   inventory of files under `packages/core/src` whose basename matches
   `/^(verifier|verify-.*|critic|panel|verification-.*)\.ts$/` and assert it equals the known set. Measured at
   `b71402a` the matches are `verifier.ts`, `verify-thread.ts`, `verify-lane.ts`, `critic.ts`, `panel.ts`,
   `verification-strategy.ts` — **re-measure**, and **state your classification of each in-source**: which
   grant tools (`verifier.ts`, `critic.ts`), which must not (`panel.ts`, `verify-thread.ts`), and which is
   deliberately a *setup* capability rather than a judge — `verify-lane.ts`'s own header says exactly that:
   *"this is the EXECUTOR/SETUP-wall capability (spawn/re-spawn/kill processes) — NOT a judge capability. The
   judge … only ever RECEIVES the target URL."* A new file matching the pattern fails until it is classified.
   For `verify-lane.ts`'s "never imports the judge" half, **cite `m10-verify-lane.test.ts`** rather than
   re-writing it.
5. **`ULTRA_CHILD_TOOLS` is not part of this wall.** `packages/core/src/ultra/runner.ts` exports
   `["Read", "Grep", "Glob", "Write", "Edit", "Bash"]` for the Ultra **builder** child — a deliberately
   write-capable agent — and it is referenced by none of the five verification files. Do not let a
   "no Write anywhere" pattern sweep it up; that would be a false positive on a correct grant.

**D3 — INV-3's assertable form.** The subtlest of the five, and the one where my first framing was wrong in a
way that matters: **do not build the allow-list out of the five root *resolvers*.** Newer code deliberately
*imports* `telarDir` instead of re-deriving it — `sessions.ts` says so in-source: *"`telarDir` is IMPORTED,
not re-derived … A sixth copy is how the guard and the thing it guards end up reading different values"* —
so **nine** core modules (`accounts.ts`, `secrets.ts`, `watches.ts`, `mcp-oauth.ts`, `dispatcher.ts`,
`usage-ledger.ts`, `sessions.ts`, `ultra/journal.ts`, `vcs.ts` — measured, re-derive it) plus
`apps/web/lib/mcp-oauth-pending.ts` reach the root without containing a
resolver. The assertable unit is the **path-composition site**, not the resolver.

1. **Pin the composition sites.** Every `path.join(<root-resolver-call>, "…")` in non-test source. Measured
   exhaustively at `b71402a` — **18 sites, and all 18 are owner-legitimate; no cross-module read by raw path
   exists in the tree today**. The table below has 15 rows because three files hold two sites each
   (`dispatcher.ts`, `looms.ts`, `store.ts` are marked `×2`); 12 singles + 3 doubles = 18. Command used:
   `grep -rn 'path\.join(telarDir()\|path\.join(stateRoot()\|path\.join(telarHome()\|path\.join(home()' packages/core/src apps/web/lib --include="*.ts" | grep -v '\.test\.ts'`
   → 18 hits. **If your own scan finds 18, that is correct.**

   | Site | Composes |
   | --- | --- |
   | `packages/core/src/manifest.ts` | `projects.json` |
   | `packages/core/src/accounts.ts` | `accounts.json` |
   | `packages/core/src/secrets.ts` | `credentials.json` |
   | `packages/core/src/watches.ts` | `watches.json` |
   | `packages/core/src/mcp-oauth.ts` | `mcp-oauth.json` |
   | `packages/core/src/dispatcher.ts` (×2) | `policy.json`, `roster.json` |
   | `packages/core/src/usage-ledger.ts` | `usage.ndjson` |
   | `packages/core/src/looms.ts` (×2) | `looms` (private `loomsDir`), `runs` (legacy migration source) |
   | `packages/core/src/vcs.ts` | `worktrees` |
   | `packages/core/src/sessions.ts` | `sessions` (exported `sessionsDir`) |
   | `packages/core/src/ultra/journal.ts` | `ultra` (exported `ultraDir`) |
   | `apps/web/lib/permissions.ts` | `permissions.json` |
   | `apps/web/lib/session-log.ts` | `sessions/<id>` |
   | `apps/web/lib/mcp-oauth-pending.ts` | `mcp-oauth-pending.json` |
   | `apps/web/lib/store.ts` (×2) | `chats.json`, `plan-usage.json` |

   **Re-derive this table; do not trust it.** It is the invariant's whole content.
2. **`projects/` and `workspace/` DO NOT EXIST as subtrees today. Do not assert on them.** They appear only in
   the spine's **State root** tree as the *planned* AD-5 layout. Current code uses the flat `looms/<id>/` tree
   exclusively, and no `projects/<id>/looms/` or `workspace/` path-join exists anywhere in `packages/core/src`
   or `apps/web`. An invariant written against the planned layout asserts over the empty set — §0 rule 1, in
   its most seductive form, because the *document* says the subtree exists.
3. **Check ownership, not existence.** For each site, assert the composing file is the owner of what it
   composes, against a table you write in the test. The failure message names the path, the owner, and AD-5.
   Cross-module reuse must go through an exported port that already carries the traversal guard — and it does:
   `executor.ts`, `dispatcher.ts` and `bundle.ts` build loom sub-paths off `looms.ts`'s exported `loomDir(id)`;
   `ultra/storage.ts` builds off `journal.ts`'s `runDir()`; `runner/lease.ts` and `runner/runner-json.ts` take
   a bare directory as a **parameter** and never resolve the root themselves. Assert that shape too: a *new*
   `path.join(telarDir(), "looms", …)` outside `looms.ts` is precisely the violation.
4. **Two co-tenancies you must encode as *named* facts, not as silence** — an invariant that quietly permits
   them teaches the next reader they are fine:
   - `sessions/<sessionId>/` has two writers in two tracks. Core owns `.runner-lease` (`sessions.ts`);
     `apps/web/lib/session-log.ts` owns `live.ndjson` in the same directory. Story 1.2's Completion Note 1 —
     *"a real hole in `WORK-SPLIT`'s disjoint-write-set guarantee, and epics 2 and 3 should know"*. Encode it
     as an explicit, commented entry so the invariant is green today and a **third** writer fails. Note also
     that core's four session-lease functions have **no consumer yet** outside `sessions.ts`, `index.ts` and
     tests — your L4 is their first demonstration.
   - `apps/web/lib/store.ts` resolves its root two ways within one file — `chats.json`/`plan-usage.json`
     through its own `stateRoot()`, `usage.ndjson` through core's `telarDir()` reached via the ledger port.
     The two expressions are byte-identical today. Recorded in `deferred-work.md`; do not fix it here.
5. **The known out-of-scope violation.** `scripts/backfill-tool-detail.ts`'s module-level `TELAR_DIR` is
   `path.join(os.homedir(), ".telar")` with no `TELAR_HOME` anywhere — the **only** remaining `~/.telar`
   literal in the tree (re-measured during story 1.1). D0's root list includes `scripts`, so your scan **will** reach it — this is your first
   `KNOWN_VIOLATIONS` entry under D7. It is cheap to fix and explicitly not yours.
6. **Do not** try to assert "no module *reads* another's subtree" by tracing reads at runtime. It is a static
   claim about path composition; keep it static. The precedent for the whole shape — text scan + floor count +
   a discriminating fixture — is `apps/web/lib/state-root.test.ts`'s
   `"the TELAR_HOME read idiom, across every source tree that resolves it"` block. Read it before writing
   yours.

**D4 — INV-4's assertable form.** Two halves, and the second is the one that actually bites.

1. **Direct.** For every `isClient` file, every `@telar/core` import must be type-only. **The trap is
   multi-line imports** — see T-4. Parse the import statement as a unit (from `import` to the matching
   `from "…";`), then accept it only if the statement starts with `import type` or every specifier inside is
   individually prefixed `type `. Measured exhaustively at `b71402a` (re-measure; do not trust these numbers):
   of the 119 directive-confirmed client files, **40 contain the substring `@telar/core`** and **36 have an
   actual `from "@telar/core"` import — every one of the 36 is `import type`**, several spanning 5+ lines. The
   other four (`components/projects/git-tab.tsx`, `components/settings/doctor-settings.tsx`,
   `components/settings/mcp-settings.tsx`, `components/session/tool-step.tsx`) mention `@telar/core` **only in
   a comment** and contain no import at all. **So the naive substring check counts 40 and the correct check
   counts 36** — the four comment-only files are *inside* the 40, not additional to it. This half should find
   zero violations, which means your anti-vacuity floor is what proves it ran (assert ≥ 20 client→core import
   statements examined).
2. **Transitive — the smuggling path. Only VALUE edges are traversable, and this is the single decision that
   makes INV-4 usable rather than permanently red.** A type-only import is erased at build and *cannot*
   smuggle runtime, so traversing it produces false positives on today's tree — specifically:
   `apps/web/lib/store.ts` is a local barrel that mixes `fs`/`os`/`path` **and** a runtime `@telar/core`
   import **and** `export { logUsage, usageSummary } from "@telar/core"`, and **four** client files
   (`app/projects/[name]/page.tsx`, `components/settings/accounts-settings.tsx`,
   `components/session/usage-pill.tsx`, `components/session/session-view.tsx`) import from `@/lib/store` — all
   four `import type`. Traverse those type-only edges and you report four violations that are not violations
   and cannot be fixed. Traverse only value edges and today's tree is clean **while the real regression is
   still caught**: flip any one of those four to a plain `import` and `fs`, `os`, `path` and core's whole
   runtime barrel enter the client bundle through that one file. That is the invariant.
   So: BFS from every `isClient` file, following **only non-type-only local imports** (relative and `@/…`),
   with a visited set; at every hop apply the same type-only rule to `@telar/core`. A violation is a
   value-edge path from a client file to a **value** import of `@telar/core`. Excluded from traversal: bare
   packages other than `@telar/core`, `*.test.ts(x)`, and anything D0 already drops. Assert ≥ 50 edges
   traversed, then assert the violation set is empty.
   `apps/web/components/looms/godview.ts` is the file that proves the design: **not** a client file, imported
   **by value** from client components (they use its derivations and its `isWoven`/`isTerminal` re-exports),
   and its own header says *"this file is imported by 'use client' components, so it may ONLY `import type`
   from '@telar/core'. A single runtime VALUE import drags `async_hooks` into the browser bundle and breaks the
   build."* Your BFS **must** reach it — if `godview.ts` is not in the visited set, the traversal is broken.
   Assert that by name.
3. **Why it matters mechanically**, for the failure message: `apps/web/next.config.ts` sets
   `transpilePackages: ["@telar/core"]`, so core is not treated as an external — Next transpiles its source
   directly into whichever bundle imports it. And `packages/core/src/index.ts` is a runtime barrel
   (`export * from "./schemas"` / `"./providers"` / `"./secrets"` / `"./mcp"` / `"./mcp-oauth"`), which
   `apps/web/instrumentation.ts`'s own comment describes as pulling in "Node-only modules (fs, child_process,
   the agent SDK)". One value import is the whole barrel.
4. **The message** must name the **path**, not just the endpoint:
   `session-view.tsx → lib/store.ts → @telar/core (value import)`. A path is the difference between a fixable
   finding and a puzzle.
5. **Nothing enforces this today.** No lint rule (`apps/web/eslint.config.mjs` is bare
   `eslint-config-next/core-web-vitals` + `/typescript`, with no `consistent-type-imports`), no build-time
   boundary test, no bundle-inspection test. It is enforced by convention plus a dozen hand-written per-file
   comments. That is exactly the "true by review, re-checked by nothing" condition AD-19 exists to end, and it
   makes INV-4 the highest-value of the five.

**D5 — INV-5's assertable form.** AD-20 covers four shared services; each gets the strongest assertion its
shape allows.

1. **The usage ledger has a file.** In **non-test source**, the only `path.join(…, "usage.ndjson")` is
   `packages/core/src/usage-ledger.ts`'s (measured at `b71402a`). Two things will trip a naive form:
   - **`apps/web/lib/store.test.ts` plants and reads `usage.ndjson` from outside** — deliberately, to assert
     the sole-writer contract. It is a **test**, not a second writer. Exclude `*.test.ts` from this
     assertion's file set, or allow-list that file by name with a comment saying why. Do not "fix" the test.
   - **Comment mentions** exist in several files. Assert on `path.join` / template *composition*, not on the
     bare string, or allow-list the comment-only mentions and assert the allow-list is exact.
   Then assert the three production `logUsage` call sites are the only ones — measured: `weave.ts` (loom),
   `ultra/storage.ts` (ultra), `apps/web/app/api/chat/route.ts` (session) — one per `UsageOwnerKind`
   (`z.enum(["session", "loom", "ultra"])`), which is a pleasing and checkable correspondence.
   And assert the **re-export**, which is what keeps the rule true across the workspace boundary:
   `apps/web/lib/store.ts` carries `export { logUsage, usageSummary } from "@telar/core";` and
   `export type { UsageEntry, UsageWindow } from "@telar/core";`, and imports `ledgerReadDegraded`,
   `usageCostBySession`, `usageTokensBySession` as values — never opening the file itself.
   `project-context.md` states the rule verbatim: *"exactly one writer (`logUsage`) and one reader path…
   **No module opens it by path**, including `apps/web`, which re-exports the port from `@telar/core` rather
   than reimplementing it."*
2. **The lease has a file.** The lease filename literal (`.runner-lease`, via `leaseFile`) appears only in
   `packages/core/src/runner/lease.ts`. `sessions.ts` composes a **directory** and hands it to the same
   functions — that is AD-16's "one primitive, two lifetimes" and it must stay passing.
3. **The bus and admission have no file** — their state is module-private in-memory. The assertable claim is
   that nothing reaches it except through the port: assert `event-bus.ts` and `admission.ts` export no
   mutable container (a snapshot must be a copy), and **cite** the existing test that already proves it
   rather than duplicating it — `admission.test.ts` holds the snapshot-immutability case per story 1.2's
   §6.4 AC5. Add the missing symmetric case for the bus only if it does not already exist; check first.
4. **Plus the AD-20 corollary this story is uniquely placed to pin:** see D9.

**D6 — L5, "the real `~/.telar` is untouched throughout".** Four layers, because §0 rule 3 is a description
of something that already went wrong.

1. **`NODE_ENV=test` + `TELAR_HOME` pinned** — `usage-ledger.ts`'s own guard then refuses a write that would
   land on the home default. This is the primary protection and it only exists inside the harness.
2. **Snapshot the real path, do not create it.** Resolve `path.join(os.homedir(), ".telar")` and take a
   before/after snapshot: existence, and for each entry `name + size + mtimeMs`. Compare for equality.
   **Use a read that tolerates `ENOENT` and never `mkdir`s** — a probe that creates the directory in order to
   check it is the exact failure mode. **`~/.telar` currently EXISTS on this machine** holding
   `accounts.json` and `usage.ndjson` (the story-1.1 pollution, logged as NEEDS A HUMAN), so an assertion
   written as "it does not exist" fails on this tree and would be wrong even if it passed. **Do not delete
   it** — that is the operator's call and the permission classifier denies it anyway.
3. **Assert the writes landed inside the temp root.** Positive evidence beats absence of evidence: after L2,
   assert `usage.ndjson` exists **under the temp root** and that its parent resolves under `os.tmpdir()`.
4. **The fake-`HOME` child probe — cite it, do not rebuild it.** `packages/core/test/usage-ledger.test.ts`
   already has exactly this probe:
   `a whitespace-only TELAR_HOME writes NOTHING under the resolved home (real child process)` — it spawns a
   child through `process.execPath` with a mkdtemp'd `HOME`, `NODE_ENV: "test"` and `TELAR_HOME: " "`, and
   asserts nothing appears under the fake home's `.telar`. **Cite that test by name** (D11's rule) rather than
   writing a second one.
   Write your own child probe **only** if you want the `TELAR_HOME`-*unset* variant rather than the
   whitespace-only one — the guard covers both (`!undefined?.trim()` is true), so it is a near-duplicate; if
   you add it, say in-source why the second case is worth a second spawn. If you do write one: `HOME=<tmp>`,
   cwd `<tmp>`, `NODE_ENV: "test"`, `TELAR_HOME` unset, import `usage-ledger.ts` by absolute path, attempt a
   `logUsage`, and **match the guard's message text** — a non-zero exit alone lets an unrelated crash read as
   a pass. `os.homedir()` under Bun is fixed at process start and ignores an in-process `process.env.HOME`
   write, which is why this can only be observed from a child.
   **What is genuinely new here is layer 2** — the before/after snapshot of the real `~/.telar` taken across
   the whole run. No existing test makes that claim. That is L5's unique content.

**D7 — the ruling for a pre-existing violation.** You will very likely find one; INV-3 and INV-4 both reach
`apps/web`, and INV-3 already has a known one (`scripts/backfill-tool-detail.ts`). The temptation is to
weaken the assertion. The alternative temptation is to ship a red gate, which breaks AC5. Do neither:

1. **Never weaken the invariant.** Do not broaden a pattern, drop a root, or delete a case to get green.
2. **Fix it only if it is inside this story's write set** — and this story's write set is
   `packages/core/test/**`, so in practice: no.
3. **Otherwise quarantine it, by name, with a justification, in a way that rots loudly.** A single
   hard-coded array:
   ```
   // Each entry is a REAL violation of a real invariant, left in place because the
   // file belongs to another track's write set (WORK-SPLIT). Recorded, not excused.
   const KNOWN_VIOLATIONS = [
     { file: "...", invariant: "INV-3", owner: "Track ? — <who owns it>",
       why: "<one sentence>", recorded: "<where it is tracked>" },
   ];
   ```
   and then **assert every entry still violates**. A stale exception — the file gone, or the violation fixed
   — must **fail**, with a message saying "this exception no longer applies; delete it." That is what keeps
   the list from rotting into a permanent hole, and it is the difference between a quarantine and a
   suppression.
4. **Report every entry** in Completion Notes as a cross-track finding, the way story 1.1 recorded its AC6
   and story 1.2 recorded its `sessions/` co-tenancy. Name the owning track so epics 2 and 3 can act.
5. **If the violation is a genuine breach of AD-1 or AD-2** — an agent-callable accept path, or a write tool
   granted to the verifier stack — **stop**. Do not quarantine it, do not fix it, do not guess. Those two
   are the constitution; `story-pipeline.md` says HALT and it means it. Report it and stop.

**D8 — compile-time invariants: the rule, and why this story adds none.** `packages/core/tsconfig.json` is
`include: ["src"], exclude: ["test", "node_modules"]` — measured, and story 1.2 measured it a second way
(`bunx tsc --noEmit --listFilesOnly | grep "/test/"`, whose only hit is inside `@types/node`). **So a bare
`// @ts-expect-error` in `packages/core/test/` is never checked by the project's own gate: it is a comment
wearing a test's clothes.** Therefore:

- **The rule:** any compile-time invariant must be proved by **invoking `tsc` from inside the test**, over
  fixtures generated in a throwaway directory, **in both directions** — the bad form must fail *with an
  error naming the right thing*, and the good form must compile clean (otherwise a fixture broken for an
  unrelated reason reads as a passing assertion).
- **The harness already exists.** `event-bus.test.ts`'s `typecheck()` and `session-lease.test.ts`'s
  structural test. Story 1.2's Completion Note 7 records the cost (~0.35 s per fixture, ~1.4 s per suite) and
  why it is duplicated rather than extracted.
- **This story adds none.** All five of AD-19's invariants are static-source or runtime facts, not type-level
  ones, and AC3 gives you a 2000 ms budget that two `tsc` spawns would eat. L4's `done`-not-assignable half
  is already pinned by `session-lease.test.ts` — **cite it, do not re-run it**.
- **Do not add a bare `@ts-expect-error` anywhere in `packages/core/test/`** as a substitute. That is the
  trap this decision exists to close.
- **Forward pointer:** story 2.1's intersect-only `toolPolicy` ("it does not compile") **is** a compile-time
  invariant, and it must use this harness. Say so in your Completion Notes so 2.1 does not re-derive it.

**D9 — writing invariants that are consistent with story 1.2's open residual.** Read its Completion Notes
**12, 14 and 15** in full before you write anything touching admission; the relevant part of 15, condensed:

> `acquireAdmission("loom-build")` followed by `releaseAdmission("other")` still leaks the build slot and
> silently floors the `other` decrement at zero. It is left open because **every way to close it breaks
> something the story requires**: the only evidence of a mismatch available inside `releaseAdmission` is
> `occupancy[cls] === 0`, which is **indistinguishable from a double release** — and AC9 requires that exact
> case to floor silently rather than throw. The mitigation shipped is that `acquireAdmission` now returns a
> release handle (Completion Note 13) and `engine.ts` uses it in its `finally`.

Three consequences, and they are binding:

1. **Do not write an invariant asserting that a mismatched release is detected or throws.** It cannot be, by
   construction, and such a test would either fail or be quietly satisfied by the double-release floor —
   which is worse, because it would look like coverage.
2. **Do write the invariant that guards the mitigation.** Measured at `b71402a`: inside `packages/core/src`,
   `releaseAdmission(` is called **only from inside `admission.ts` itself**; `engine.ts` — the sole
   `acquireAdmission` caller in `src` — releases through the handle. That is an assertable, load-bearing,
   currently-true fact and it belongs under INV-5 (AD-20: shared state is written only through its port, in
   the safe form the port provides). Assert: no file under `packages/core/src` other than `admission.ts`
   calls `releaseAdmission(`. **Re-measure before pinning**, and write the failure message to explain the
   residual: *"a new call site hands a slot back by class. `releaseAdmission` cannot detect a class mismatch
   (story 1.2 Completion Note 15) — use the handle `acquireAdmission` returns."*
3. **L3 takes and releases every slot through the handle.** Not because the test would otherwise fail, but
   because the prove-run is the demonstration of correct usage, and a prove-run modelling the unsafe form is
   a bad artifact. `admission.test.ts` legitimately uses `releaseAdmission(cls)` directly — it is testing
   that function. Yours is not.

**D10 — file names and structure.** `packages/core/test/invariants.test.ts` and
`packages/core/test/track-a-prove-run.test.ts`. Flat, `*.test.ts`, no helper module, no subdirectory, no
committed non-test file in `packages/core/test/` (the directory has held nothing but `*.test.ts` for its
whole life — measured). Test names: prefix each invariant's cases with `INV-n` and each prove-run leg with
`Ln`, and keep the strings **free of regex metacharacters** so `bun test -t "<name>"` works without escaping
(§6.2). The `describe` for the prove-run must be exactly `track-a prove-run` so the one-command form in AC4
selects all five legs and nothing else.

**D11 — what the prove-run adds, given that story 1.2 already unit-tests four of its five legs.** Read this
before you write Leg B, because both wrong readings are expensive. Measured test titles at `b71402a`:

| Leg | Already covered by |
| --- | --- |
| L1 bus wake / no-push | `event-bus.test.ts` — the AC2 class-filter cases, plus `T-1 the bus persists NOTHING — a busy publish leaves the state root empty` |
| L2 attributed spend | `usage-ledger.test.ts` — owner attribution, the projections, the write-guard |
| L3 precedence | `admission.test.ts` — `gives a freed slot to loom-verify ahead of a queued build fan-out` and `AC5 admissionSnapshot NAMES WHY: priority order and waiting-by-class are both readable` |
| L4 stale lease | `session-lease.test.ts` — `AC11 a STALE lease resolves to reclaimable on BOTH the loom path and the session path`, `AC11 every value the reclaim union can take is enumerated, and \`done\` is not among them`, ``AC11 `done` is NOT assignable to LeaseReclaim — the moat, checked by tsc``, and `AC11 the lease filename is \`.runner-lease\` on BOTH lifetimes — one filename, zero divergence` |
| L5 `~/.telar` untouched | **nothing.** No test makes this claim across a whole run |

**Neither wrong reading is acceptable:**

- **"It is already covered, so the leg is redundant"** — no. AC4 is a *demonstration*, and the SPEC's Success
  signal is explicit that it is **one** run: every port serving a consumer, in one process, under one
  sandboxed root, with `~/.telar` untouched throughout. Four suites each proving one thing in isolation is
  not that, and the dispatch note ("each leg must demonstrate the port SERVING something") is asking for the
  composition. The transcript is the artifact `epics.md`'s dev-server-proof line names. Deleting a leg because
  a unit test exists fails AC4.
- **"So I should re-assert everything those suites assert"** — also no. That is 40 duplicated assertions
  maintained in two places, and the first divergence is a lie in one of them.

**What each leg must therefore do:** exercise the port for real, assert the *one or two* facts that are its
AC clause (not the whole surface), print its transcript line, and **cite** the suite that owns the exhaustive
coverage. So L4 asserts a stale lease reclaiming on both roots *in this run* and cites the four `AC11` tests
above for the exhaustive cases; L3 asserts the verify winning the freed slot with the snapshot readable *in
this run* and cites the two `admission.test.ts` cases. The unique content of Leg B is the **composition, the
transcript, and L5** — which is why L5 is the one leg with no precedent and the one with the operational scar
behind it.

**D12 — L4's terminal-state half: the mechanism, because nothing else in this story names it.** AC4 says a
stale lease "reclaims to `failed`". `leaseReclaim` returns `"held" | "reclaimable"` — it never writes a state.
The **only** production path that turns a stale lease into a persisted `failed` is:

`packages/core/src/dispatcher.ts` — `reconcileStuckLooms(liveness: Liveness = inProcessLiveness)`. It walks
`listLooms()`, asks the injected oracle whether each loom is live, and for a dead in-flight loom writes
`loom.state = "failed"`, sets `RESTART_ERROR`, appends an `error` and a `state` event, and `saveLoom`s. Its
in-source comment is the AD-1/AD-15 claim in one line: *"MOAT: `reconcileState` can only ever yield
resume/queued/halt/leave/skip — never `done` — so this sweep can never auto-complete a loom."* **That comment
is what L4 makes executable end to end.**

`packages/core/src/runner/liveness.ts` —
`crossProcessLiveness(runnerActive: Set<string>, readLease: (id: string) => RunnerLease | null, ttlMs: number, now: () => number = Date.now): Liveness`.
It returns live if the runner reports the id active, else `isLeaseFresh(readLease(id), ttlMs, now())` — so a
**stale lease on disk makes the loom dead**, which is exactly the chain L4 must exercise.

**Five things that will make this leg silently prove nothing if you miss them:**

1. **The two `readLease`s have different shapes.** `runner/liveness.ts` wants `(id: string) => RunnerLease | null`;
   `runner/lease.ts` exports `readLease(ownerDir: string, io?: LeaseFs)`, keyed by **directory**. Adapt at the
   call site — `(id) => readLease(loomDir(id))` — do not pass one where the other is expected.
2. **Only an in-flight state flips.** `runner/recover.ts`'s `reconcileState` maps `queued`→resume,
   `scoping`→queued, `preparing`→resume, `running`→halt, `verifying`→halt (all of which get written `failed`),
   while `charter-review | ready | blocked | needs-review`→`leave` and `done | failed | skipped | halted`→`skip`
   are **left untouched**. Seed the loom in an in-flight state (`running` or `verifying`). Seed it `ready` and
   the sweep correctly does nothing — and a leg asserting "nothing changed" would pass while proving the
   opposite of its AC.
3. **Children are skipped.** `reconcileStuckLooms` opens with `if (loom.parentLoomId) continue`. Seed a **root**
   loom.
4. **`sessions.ts` has no state machine** — it is lease read/write/reclaim only. So "the terminal state is
   `failed`" is structurally **loom-only**; the "both roots" requirement belongs to the reclaim-decision half,
   not to this one. Say so in-source so the next reader does not go hunting for a session state that does not
   exist.
5. **The sweep also runs the worktree reaper.** It is guarded so a non-git project is a no-op rather than a
   boot crash, but keep your seeded project simple and do not be surprised by reaper log output.

**What is already covered, and what is new.** `packages/core/test/m5-reconcile-liveness.test.ts` already
asserts `default liveness: a stranded in-flight loom → failed (byte-identical)` and
`a loom the injected oracle judges LIVE is NOT touched (no strand, no auto-complete)` — **with a stub oracle**.
Its `seed(state)` helper (`createLoom` + `saveLoom` under a mkdtemp'd `TELAR_HOME`, with `createProject`) is
the shape to copy. **The new content in L4 is the composition**: a real lease record written to disk, aged past
its TTL by an injected clock, driving `crossProcessLiveness` into `reconcileStuckLooms`, ending in a persisted
`failed` — and never `done`. No existing test joins that chain, and joining it is precisely the "demonstrate
the port SERVING something" bar the dispatch notes set.

### 5.6 Traps

- **T-1 — A source-scanning test is green over the empty set.** The one failure mode that would make this
  entire story worthless. Every scan asserts a floor on what it found *before* asserting anything about what
  it did not find. Repeated from §0 rule 1 because it is worth two mentions.

- **T-2 — Your invariant will scan `_bmad-output/`, and it must not.** That tree holds
  `spec-runtime-foundations/reference/admission-impl/admission.test.ts` — a preserved reference
  implementation carrying the relative imports of the location it was written for. `bunfig.toml` excludes it
  from test discovery for that reason. A repo-wide scan that includes it will report violations in
  documentation. Exclude it in D0's list — and note the asymmetry this creates: **a test re-homed under
  `_bmad-output/` is invisible to the gate and the gate reports green.** That is the unresolved
  `[Review][Decision]` from story 1.1; do not resolve it, and do not rely on it.

- **T-3 — `_bmad-output/` is also where your own story file lives, and it is not source.** Do not write an
  invariant that scans prose. Several files in this repo *discuss* the rules in comments; an invariant
  matching on prose will fire on the documentation of itself.

- **T-4 — Multi-line imports will defeat a line-based type-only check.** Nearly every `@telar/core` import in
  `apps/web` looks like this (`apps/web/app/projects/[name]/page.tsx`, measured):
  ```
  import type {
    Loom,
    ProjectManifest,
    RegistryEntry,
    WorkUnitState,
  } from "@telar/core";
  ```
  A check that looks at the line containing `from "@telar/core"` sees `} from "@telar/core";` and finds no
  `type` keyword — reporting **every compliant file as a violation**. Parse whole statements. The inverse
  error is just as bad: a naive "does the file contain `import type` and `@telar/core`" check passes a file
  that has one type import and one value import.

- **T-5 — `"use client"` appears inside comments in this repo, and the difference is 4 files, one of which
  imports `node:fs`.** Measured at `b71402a`: `grep -rl "use client"` over `app components lib hooks` →
  **123**; files whose first non-comment statement is the directive → **119**. The gap includes
  `apps/web/lib/permissions.ts`, which discusses the boundary in a comment and imports `node:fs`, `node:os`,
  `node:path`, `node:crypto` — so a substring match makes INV-4 report a **server-only module** as a client
  component and fail on today's tree for a reason that is not a violation. `apps/web/components/looms/godview.ts`
  is the mirror-image hazard: it contains the phrase, is **not** a client file, and is the one file whose
  *transitive* obligation matters most — misclassifying it as a client file replaces a real check with a
  trivial one. Detect the **directive**, not the substring, and assert both counts in the Debug Log so the
  reader can see you did.

- **T-6 — Module-level singleton state meets one-process test runs.** `admission.ts`'s policy/occupancy/queue
  and the bus's registry are module singletons; `bun test` runs **every file in one process**, so state leaks
  across files. Reset in `beforeEach`. And: **a test that leaves a waiter queued will make `resetAdmission`
  throw and take the whole run down** (story 1.2 made that deliberate — a caller that trips it leaked a
  slot). Drain your waiters, release your slots, in `finally` blocks, even on a failing assertion.

- **T-7 — The bus errors on re-declaration, and `event-bus.test.ts` already declared fixtures.** Story 1.2's
  Completion Note 3: re-declaring a name is an **error**, not an idempotent no-op, because two zod schemas
  cannot honestly be compared for equivalence. So your prove-run must use its **own** module name and call
  `resetBus()` in `beforeEach` — and it must not `declareEvents` at module scope, for the same reason a
  reloading dev server must not.

- **T-8 — `TELAR_MAX_AGENTS` in the developer's shell can change L3's arithmetic.** Story 1.2's Completion
  Note 12 made the ceiling re-read the environment at every entry point; `resetAdmission({})` roots the read
  at that empty record and makes the suite immune. Call it. Do not assume the default of 4 without pinning
  it.

- **T-9 — Do not sleep to age a lease.** `leaseReclaim(lease, ttlMs, now)` takes an injected clock; that seam
  exists precisely so a staleness test costs nothing. A `setTimeout`-based test is slow (AC3) and flaky.

- **T-10 — A pinned inventory is a maintenance cost, and that is the point.** If the inventory feels noisy,
  the temptation is to relax it to a pattern. Do not: the pattern is what a `mark_delivered` walks through.
  What you *may* do is make the failure message excellent, so the person who adds a tool spends ten seconds,
  not ten minutes.

- **T-11 — `apps/web/lib/state-root.test.ts` runs a repo-wide source scan over `packages/core/src` requiring
  every `process.env.TELAR_HOME` read to go through `?.trim()`.** You are not adding `src` code, so this
  should not bite — but if you generate a child probe that reads the env raw, note that this web-suite test
  scans **source**, not your generated fixture, so it will not fire. Be aware of it as the reason a core
  change can fail a web test, in case you see it.

- **T-12 — A line number is not a name.** Every line-number citation in story 1.1's record drifted, some
  within the round that wrote them. This file's `≈:N` pointers were measured at `b71402a` and are pointers.
  Verify by symbol.

- **T-13 — Your invariant suite will match itself, and this will be your first failure.**
  `invariants.test.ts` necessarily contains the literals it searches for: `"usage.ndjson"`, `.runner-lease`,
  `releaseAdmission(`, `"use client"`, `tool(`, the deny-list words, and every `KNOWN_VIOLATIONS` path. D0's
  roots include `packages/core/test`, so a violation scan that reuses the whole index reports the scanner as a
  violator — of every invariant at once. Two rules follow, and they are not the same rule:
  - **Each invariant applies its own file-set filter to the shared index.** The index is walked once (AC3);
    the *scope* of each scan is narrower than the index. INV-2's scope is `packages/core/src`; INV-3's and
    INV-5's are non-test source across both workspaces; INV-4's is `apps/web` non-test; INV-1's is the three
    MCP surfaces plus `looms.ts`, `tick.ts` and the chat route.
  - **Every violation scan excludes `*.test.ts` / `*.test.tsx` — including this file.** State that in-source
    with the reason, or the next reader will "fix" the exclusion and be baffled.
  Note the tension with T-1 and resolve it the stated way: the **floor** counts are asserted over the whole
  index (so a broken walk fails), while the **violation** sets are computed over the filtered scope (so the
  scanner does not indict itself). Do not collapse the two.

---

## 6. Testing requirements

This story *is* tests, so read this section as the specification of the deliverable, not as a checklist
about it.

### 6.1 The rule this story exists under

`bunfig.toml`'s `[test] pathIgnorePatterns = ["**/release/**", "**/.next-desktop/**", "**/_bmad-output/**"]`
excludes `_bmad-output/` from test discovery. The story-1.1 reviewer predicted by name that story 1.2 would
re-apply a reference implementation from that tree and then report a green gate with its own tests invisible
to the runner. Story 1.2 proved discovery instead, and **so must you** — with more at stake, because your
entire deliverable is test files. An invisible invariant suite is worse than no invariant suite: it reports
that the moat is verified.

**Therefore:**

1. **Do not edit `bunfig.toml`.** `git diff --stat -- bunfig.toml` must print nothing.
2. **Both new test files live under `packages/core/test/`**, flat, no subdirectories.
3. **Every test you add must be proven DISCOVERED by name, in the repo-wide run.** Passing when pointed at
   directly is not evidence — a file excluded from discovery still passes perfectly when named explicitly.
   Discovery is the property under test.

### 6.2 How to prove discovery — verified commands, real output

Bun `1.3.14`. `bun test` from the **repo root** works and discovers both workspaces; it is the binary, not a
package script, so the "every command runs inside a workspace dir" convention does not apply to it.

**Baseline first — measure, do not quote.** Counts in this repo drift silently and `project-context.md` says
so outright. Measure yours before you start:

```
ls packages/core/test/*.test.ts | wc -l      # pointer, measured 2026-07-26 at b71402a: 105
ls apps/web/lib/*.test.ts | wc -l            # pointer: 10 (plus one nested spec → 11 files for apps/web)
bun test 2>&1 | tail -3                       # measure yours; 1.2 recorded 1789 pass / 0 fail
```

**Proof mechanism 1 — name pattern (per-suite spot check).** From the repo root:

```
bun test -t "<exact test name>"
```

- Discovered: exits `0` and prints e.g. `1 pass / N filtered out / 0 fail … Ran 1 test across M files.`
  **The `across M files` figure is half the proof** — it says the whole tree was searched, not a subset.
- Not discovered: exits **`1`** with
  `error: regex "<name>" matched 0 tests. Searched M files (skipping N tests)`. A hard failure, not a silent
  pass.
- `-t` matches by **regex**, so escape metacharacters — or, per D10, choose test names without them.

This mechanism was validated by story 1.2 against the exact failure mode you are guarding: temporarily
adding `"**/core/test/**"` to `pathIgnorePatterns` made the same command for the same real test name report
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

- [ ] `git diff --stat -- bunfig.toml` → **empty**.
- [ ] `git diff --stat -- packages/core/src apps/web` → **empty** (this story touches neither; §0 rule 4).
- [ ] `git diff --stat -- packages/core/test/ultra-runner.test.ts` → **empty** (NFR-RF-8).
- [ ] Baseline vs. final `ls packages/core/test/*.test.ts | wc -l`. The delta must be **exactly 2**.
- [ ] Repo-root `bun test` — full output tail including `Ran N tests across M files`. **M must have grown by
      2.** A flat `M` with a grown `N` is impossible; a flat `M` and a flat `N` means your tests are
      invisible and the gate is lying.
- [ ] The junit run + a `grep -F` hit for **every new test name**, showing the `file=` attribute.
- [ ] At least one `bun test -t "<name>"` spot check **per new suite**, with the `across M files` line.
- [ ] One **negative control**: `bun test -t "a name that does not exist zzz"` showing the exit-1 /
      `matched 0 tests` behaviour, so the reader knows your positive results mean something.
- [ ] **The AC3 measurement**: `invariants.test.ts`'s wall-clock from `bun test`'s per-file timing, and the
      number below 2000 ms.
- [ ] **If any `KNOWN_VIOLATIONS` entry exists (§5.5-D7)**: a probe showing that *fixing or removing* the
      underlying violation makes that entry's own assertion **fail** with the "this exception no longer applies"
      message — captured the same way as the AC2 probes. An unfalsifiable quarantine is a suppression.
- [ ] **The T-A0 inventory**: what the scan index found, per invariant, before any assertion — total files
      walked; the collected MCP tool set per server; the path-composition site table; **both** client-file
      counts (substring vs. directive, per T-5); import statements examined; BFS edges traversed; and the
      violation count per invariant *as found*, before any quarantine.
- [ ] **AC2 evidence, one revert-probe per invariant.** Break the thing (a temporary local edit, or a
      synthetic entry injected into the index), capture the **real failure message**, restore, and
      `diff`-verify the restore. Story 1.2's "Load-bearing probes" section is the format to copy, including
      its explicit statement that a failure observed under a deliberate revert is a **revert-verification
      failure, not an unmet AC** — say that in as many words, because the two readings mean opposite things.
- [ ] **The prove-run transcript**, verbatim, from
      `TELAR_HOME=$(mktemp -d) bun test -t "track-a prove-run"` at the repo root.
- [ ] **The `~/.telar` evidence**: the before/after snapshot values, side by side, showing equality. State
      explicitly that the directory **already existed** before your run and that you did not create, modify
      or delete it.
- [ ] `cd packages/core && bun test` → pass/fail counts.
- [ ] `cd packages/core && bunx tsc --noEmit` → exit 0.
- [ ] `cd apps/web && bunx tsc --noEmit` → exit 0. **Both** workspaces (AC5).
- [ ] `apps/web`'s `bun test` → green.
- [ ] `bun run lint` — **not** a clean baseline (~77k pre-existing problems, mostly under `.next-desktop/`),
      not in AC5, and not this story's to fix. You should have no `apps/web` file to lint. Say so.

### 6.4 Coverage the suites must actually carry

Required because an AC names it:

- **Every invariant** — a discriminating fixture proving the scanner still fires (§5.5-D0b), and an
  anti-vacuity floor asserted *before* the violation assertion (§0 rule 1).
- **AC1 / INV-1** — all three parts: the pinned inventory **equals** the collected set (not "is a subset of"),
  with `engine.ts`'s `out`/`emit_result` included; the deny-list check over collected names, with
  `answer_blocked` and `reject_loom` still passing; the construction half (`acceptLoom` sole `done` writer,
  not imported by `loom-mcp.ts`, single importer, blank-`by` refusal, `tick.ts` clean); the `PreToolUse` hook
  asserted via the exported constants.
- **AC1 / INV-2** — the ten-name runtime deny check; all three grant fields including `restrictTools: true`;
  `critic.ts` importing rather than re-declaring `VERIFIER_TOOLS`; the abstainer check on `verify-thread.ts`
  and `panel.ts`; the verification-surface inventory with every file classified in-source; existing coverage
  cited, not duplicated; `ULTRA_CHILD_TOOLS` not swept up.
- **AC1 / INV-3** — the 18-site composition table is exact; per-site ownership; nothing asserted about
  `projects/` or `workspace/`; the two co-tenancies encoded as named entries with comments; the
  `scripts/backfill-tool-detail.ts` exception under D7 (your scan reaches `scripts/` — it is in D0's roots).
- **AC1 / INV-4** — directive-based `isClient` (both counts reported); multi-line imports handled (T-4); the
  transitive BFS following **value edges only**, with `godview.ts` asserted present in the visited set; all
  three anti-vacuity floors; the failure message carries the **path**.
- **AC1 / INV-5** — `usage.ndjson` single non-test module with the `store.test.ts` planting excluded by name;
  the three `logUsage` call sites; the `apps/web/lib/store.ts` re-export; the lease filename single-module
  with `sessions.ts`'s directory composition still passing; the D9 handle invariant; the cited
  snapshot-immutability test.
- **AC2** — one captured revert-probe per invariant, per §6.3, *in addition to* the permanent discriminators.
- **AC3** — the measured number.
- **AC4 / L1** — all three halves: wake handler fired; `wakeDelivered === 0` **with** `delivered >= 1` on the
  `human-facing` publish; `subscribeAgentFacing` throws on the `human-facing` name. **Verify the class filter
  is load-bearing by removing it and re-running** — story 1.1 found more than one green test that asserted
  nothing, and "revert the fix, watch the test fail" is now the house standard.
- **AC4 / L2** — owner-attributed write; read back through a **projection**; the file is inside the temp
  root; and the tolerant-reader case (a pre-attribution record still counts, nothing throws).
- **AC4 / L3** — pool full of `loom-build`, **two** more `loom-build` queued, `loom-verify` arriving
  **after** them, exactly one slot freed, the verify winning it; `admissionSnapshot()` read at contention
  with priority order and waiting-by-class both observable; every slot taken and released through the handle;
  every waiter drained.
- **AC4 / L4** — the two halves of §5.5-D12 kept distinct: the **reclaim-decision** half on **both** roots,
  with `session-lease.test.ts`'s four `AC11` cases **cited** rather than re-run; and the **terminal-state**
  half — a real stale lease on disk driving `crossProcessLiveness` into `reconcileStuckLooms` to a persisted
  `failed`, loom-only, seeded in an **in-flight** state on a **root** loom, aged by an injected clock. State
  in-source that `sessions.ts` has no state machine, so the terminal half cannot apply to it.
- **AC4 / L5** — the four layers of D6, including the child probe's refusal message.
- **AC5** — the trio, both workspaces.

---

## 7. Previous story intelligence — what 1.1 and 1.2 cost, so it doesn't cost again

### 7.1 From story 1.1 (`usage-ledger.ts`, `store.ts`) — five commits, then **four** adversarial repair rounds

- **A green test can assert nothing.** Two of its load-bearing tests used a seam production never produces
  (`child.attempts = [...]` where production `push`es), so the finding they were meant to guard stayed green
  underneath them. **Verify a new guard is load-bearing by reverting the thing it guards and watching it
  fail.** For this story that is not one probe, it is **five** — one per invariant (§6.3).
- **A guard must read the same value as the thing it guards.** Its blocking finding was a guard reading raw
  `process.env.TELAR_HOME` while the resolver read `?.trim()`; one whitespace-only value slipped a synthetic
  billing line into the operator's real `~/.telar`. Generalized for you: an invariant that scans for pattern
  X while production writes pattern X′ is a guard that does not guard.
- **A key that names a slot is a bug.** Three successive idempotence keys derived from a position, each a
  silent money-loss regression measured *worse than baseline*. Nothing in this story mints an identity — but
  if you find yourself deriving one from an array index, stop.
- **Comments that claim more than the code guarantees cause the next agent to "restore" a removed guard.**
  Two rounds went on exactly that. Your invariant messages are read six months from now by someone with no
  context; make them true, not impressive.
- **What 1.1 built that you assert over:** `usage-ledger.ts` (the sole reader/writer of `usage.ndjson`),
  `UsageEntry` + `UsageOwnerKind` in `schemas.ts`, `stateRoot()` in `apps/web/lib/store.ts`, the `?.trim()`
  guard in all five root resolvers, and `apps/web/lib/state-root.test.ts` — the repo-wide-scan precedent this
  story leans on hardest.
- **Still open from 1.1, not yours:** the root-loom under-count; two `readFold` residuals; unbounded
  in-process ledger retention; `git-tab.tsx`'s 2 NUL bytes; `scripts/backfill-tool-detail.ts`'s hardcoded
  `~/.telar`; five `[Review][Decision]` items, one of which is the `bunfig.toml` exclusion. Do not resolve
  any of them here. Two of them (`git-tab.tsx`, `backfill-tool-detail.ts`) will show up in your scans — D7
  and §3 tell you what to do.
- **The `~/.telar` pollution.** An ad-hoc `bun -e` probe outside the harness, `NODE_ENV` not `test`, guard
  correctly silent, write landed on the home default. §0 rule 3. This is the single most important
  operational lesson in the epic and it is one of yours to not repeat.

### 7.2 From story 1.2 (`admission.ts`, `event-bus.ts`, `sessions.ts`) — 11 ACs met, then 6 should-fixes, 5 closed

The notes you were told to read in full — **12, 14 and 15** — plus the three that change what you write:

- **Note 15 (the open residual).** `releaseAdmission(cls)` cannot detect a class mismatch. Condensed in
  §5.5-D9 with the three consequences for your invariants. **Read the original before writing an admission
  assertion.** The short version: the only in-function evidence of a mismatch is `occupancy[cls] === 0`,
  which is indistinguishable from the double release AC9 requires to floor silently; the mitigation is the
  release handle, and `engine.ts` uses it.
- **Note 13 (the mitigation).** `acquireAdmission` returns `Promise<() => void>` — the handle for the slot it
  took, idempotent, so a spent handle firing twice is a no-op rather than a release of somebody else's slot.
  `engine.ts` is the only `src` caller and calls it in `finally`. This is what D9's invariant pins.
- **Note 12 (the ceiling re-reads the environment).** `currentPolicy()` re-reads `TELAR_MAX_AGENTS` at every
  entry point; `configureAdmission({ceiling})` pins; `resetAdmission(env)` re-roots and unpins;
  `resetAdmission({})` makes a suite immune to the developer's shell. Hazard stated in that note: the ceiling
  can now change mid-run, and lowering it while calls are in flight reads as `at-ceiling` — arrivals queue,
  releases drain. It cannot over-commit. **T-8**.
- **Note 14 (deliberately not fixed, still open).** `independentPieces`/`processCeiling` integer validation;
  `sessionDir`'s case-insensitivity and missing length bound; `publish`'s swallowed subscriber error; the
  `REPO_TSC` existence precondition; the `binding: "pool-exhausted"` misnomer. **None of these are yours**,
  and at least one (`sessionDir`'s bound) is deliberately unfixed because its co-tenant
  `apps/web/lib/session-log.ts` shares the property and changing one side alone splits the directory.
- **Note 7 (the compile-time harness).** §5.5-D8. Also the reason `packages/core/test/` has no helper module:
  every file there is self-contained, so 1.2 duplicated a ~25-line harness rather than introduce a shape the
  convention does not have.
- **Note 1 (the `sessions/` co-tenancy).** A real hole in `WORK-SPLIT`'s disjoint-write-set guarantee: AD-5
  assigns `sessions/<sessionId>/` to the session module, and `apps/web/lib/session-log.ts` already writes
  `live.ndjson` there. Core owns `.runner-lease`, guards the id, and **fails closed** on an id
  `session-log.ts` would happily write — a stated asymmetry, not an accident. INV-3 must encode this as a
  named fact (§5.5-D3).
- **Note 3 (re-declaration is an error).** T-7.
- **Note 8 (no concrete event in `src`).** The temptation to add one "to make the bus useful" was noted and
  declined. §0 rule 5.
- **Note 10 (the declined repo-wide scan).** A "no raw control characters" scan would have caught the NUL-byte
  incident twice over, and was declined because `git-tab.tsx` still carries 2 NUL bytes. §3.
- **Note 6, and how to write about a revert-probe.** Its `Expected: 4, Received: 3` result was a
  **revert-verification failure, not an unmet AC** — observed only while the fix was deliberately reverted,
  with the file then restored and byte-compared. It stated that in a blockquote so the two readings could not
  be confused. Copy that discipline in §6.3; you will be producing five such probes.

**Git intelligence** (`git log 578e5b4^..b71402a` — note the `^`; the bare `..` form excludes `578e5b4`
itself and returns only two): three commits — `feat(core): one event bus, one admission
controller, one lease primitive (story 1.2)`, `fix(core): close the six should-fix review findings on story
1.2`, and before them `fix(core): make the ledger's test write-guard read the root it actually writes to`.
Conventional prefix + scope, WHY-carrying bodies. New core ports arrived as one module + one barrel line +
one dedicated flat test file. Yours is a **test-only** story, so the shape is: two flat test files, no barrel
line, no `src` change — and `test(core):` is the right prefix.

---

## 8. References

- `_bmad-output/planning-artifacts/epics.md` § "Story 1.3: Executable invariants and the Track A prove-run" —
  the ACs above verbatim, the dev-server-proof line, and the dispatch notes (including the ruling that moves
  two assertions to story 2.1).
- `_bmad-output/specs/spec-runtime-foundations/SPEC.md` — **CAP-6** (the five assertions, "at minimum"), the
  **Success signal** (the prove-run's five legs), Constraints, Non-goals.
- `_bmad-output/specs/spec-runtime-foundations/brownfield.md` § "The gaps this SPEC closes" — *"No executable
  invariant assertions"*; § "Reuse, never rebuild".
- `_bmad-output/specs/spec-runtime-foundations/stories.yaml` #8 and #9 — the superseded `invoke_dev_with`
  briefings, carried forward here per planning decision 4. #8's "no `SessionProfile` field can widen a tool
  grant" is **superseded** by `epics.md`'s dispatch note moving it to 2.1.
- `_bmad-output/specs/spec-runtime-foundations/admission.md` — the admission authority; the rejected
  reservation design; the Acceptance list L3 is a live demonstration of.
- `_bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md` —
  **AD-19** (and its `Binds:` list, which is AC1's list — but see AC1's Notes: the AC-clause order swaps AD-5
  and AD-3), AD-1, AD-2, AD-3, AD-5, AD-7, AD-14, AD-15, AD-16, AD-17, AD-18, AD-20, AD-21; the **State root** tree (INV-3's ownership table); the dependency-direction diagram and its
  two dotted prohibitions.
- `.../SOLUTION-DESIGN.md` § "State: why weak references and tolerant readers" (why AD-20 exists at all — it
  closes a hole AD-5 cannot reach) and § "Runtime: the collision nobody's spec saw".
- `.../WORK-SPLIT.md` § "Track A" (unit **A6** = this story's Leg A) and § "Sequencing the whole thing" —
  phase 2's gate is *"A6 assertions green"*.
- `_bmad-output/project-context.md` — the Human-Accept Moat, the Verifier capability wall, the
  CLIENT-BUNDLE RULE, the port-ownership rule for `usage.ndjson`, the append-only-stream exception, the
  Testing section (including "measure, don't quote" and the `bunfig.toml` `[Review][Decision]`).
- `_bmad-output/implementation-artifacts/stories/1-1-state-root-isolation-and-the-attributed-spend-ledger.md`
  — Review Findings and Repair Rounds 1–4.
- `_bmad-output/implementation-artifacts/stories/1-2-the-event-bus-admission-control-and-the-lease-primitive.md`
  — **Completion Notes 12, 14, 15** (required reading before any admission assertion), plus 1, 3, 6, 7, 8, 10,
  13; §6.2's discovery mechanisms, reproduced in §6.2 above.
- `_bmad-output/implementation-artifacts/deferred-work.md` — the citation policy; the five-way `TELAR_HOME`
  duplication; `backfill-tool-detail.ts`; `writeLease`'s fixed-temp-filename race.
- `_bmad-output/story-pipeline.md` — the four HALT conditions. Two of them (an agent-callable accept path; a
  write tool granted to the verifier stack) are what INV-1 and INV-2 exist to detect. §5.5-D7 point 5.
- `apps/web/AGENTS.md` — the import-boundary doc `godview.ts`'s header cites.

---

## 9. Dev Agent Record

### Agent Model Used

<!-- model name + version -->

### Debug Log

<!-- Real pasted output for every item in §6.3. -->

### Completion Notes

<!-- Numbered. Include, at minimum:
  - the T-A0 inventory, and every KNOWN_VIOLATIONS entry with its owning track (§5.5-D7 point 4)
  - any cross-track finding, in the shape story 1.1 used for its AC6 and 1.2 for its sessions/ co-tenancy
  - your classification of verify-lane.ts / verification-strategy.ts under INV-2's wall (§5.5-D2 part 4)
  - the forward note for story 2.1 about the tsc harness (§5.5-D8)
  - any symbol name changed from §5.5
  - decisions taken autonomously, if the operator was not reachable
-->

## 10. File List

<!-- Measured with the change staged, which is the only form that sees created files:
     git add -A -- packages/core && git diff --cached --name-status
     Expected: exactly two A lines, both under packages/core/test/. Nothing else. -->

## 11. Change Log

<!-- Plus a suggested conventional-commit message, e.g.
     test(core): make the five load-bearing invariants executable and prove the Track A substrate end to end
     Do NOT commit _bmad-output/implementation-artifacts/orchestrator-run-log.md — it belongs to the
     orchestrator, not to this story. -->
