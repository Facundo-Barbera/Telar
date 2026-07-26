---
story_id: "2-1"
title: "The SessionProfile resolver"
status: "review"
epic: "Epic 2: Session Profiles"
track: "B — Session profiles (the chat route + the profile resolver)"
caps: ["CAP-7 (spec-runtime-foundations)"]
frs: ["FR-RF-7"]
ads:
  [
    "AD-9",
    "AD-10",
    "AD-11",
    "AD-1",
    "AD-3",
    "AD-5",
    "AD-6",
    "AD-17",
    "AD-19",
    "AD-20",
  ]
nfrs:
  [
    "NFR-X-8",
    "NFR-X-9",
    "NFR-X-1",
    "NFR-X-3",
    "NFR-X-4",
    "NFR-X-14",
    "NFR-X-16",
    "NFR-RF-1",
    "NFR-RF-4",
    "NFR-RF-5",
  ]
baseline_commit: "b44d9b56e672a15dc23c9371062b1e398e308cc0"
baseline_gate: "1835 pass / 0 fail across 118 files (story 1.3, post-fix-pass). Re-measure; do not quote."
depends_on:
  [
    "nothing — WORK-SPLIT lists Track B's `Blocked by` column as `nothing`. Epic 1 happens to be done (`b44d9b5`), which removes the write-set collision risk that made Track A/B concurrency delicate, but this story was never gated on it.",
  ]
blocks:
  [
    "2-2 (retrofit the existing session kinds onto profiles — 'the shape was settled in 2.1')",
    "epic 4 (Ultra: a SessionProfile is Track D's seam)",
    "epic 5 (the project-less master profile is Track E's seam)",
    "epic 6 (node + steerer profiles are Track F's seam)",
  ]
---

# Story 2.1: The SessionProfile resolver

## 0. Read this first

**Citation policy for this whole file — inherited from stories 1.1, 1.2 and 1.3, which re-learned it five
times between them.** Every reference below names a **file and a symbol** — a function, a const, a type
field, or a test title. **A line number is not a name.** It identifies a slot in a file, and any edit above
it hands that slot to something else. Where a number helps you navigate `route.ts` (1922 lines, measured at
`b44d9b5`) it is written `≈:N` and is a **pointer, not a fact** — verify by symbol, never by number. Do not
add a number to this file you have not just measured. Counts obey the same rule: `project-context.md` says
outright that its test counts are "a smell test, not a fact — measure, don't quote", and the core suite count
moved 105 → 107 between story 1.3's authoring and this story's.

**Seven hard rules before you write a line.**

1. **The three properties ARE the story. The field list is not.** The dispatch note in `epics.md` says this
   in as many words: *"Three properties are the story, not the field list."* They are (i) the `PreToolUse`
   guardrail runs regardless of profile because it is wired **outside** the profile, (ii) `toolPolicy` is
   intersect-only **by its type**, and (iii) an unmet capability fails **before the stream opens**. A
   submission that lands seven typed fields and gets any of those three wrong has not done this story. AD-10
   names the failure it prevents: *"the moat degrading from structural to configurable."* Making session
   config **data** is exactly the move that could do that.
2. **"It does not compile" must be proved by RUNNING the compiler.** `packages/core/tsconfig.json` is
   `include: ["src"], exclude: ["test", "node_modules"]` — **measured on the working tree** (§5.4-C quotes
   `session-lease.test.ts`'s own header, which renders this as `exclude: ["test"]`; the real array also carries
   `node_modules`, and the consequence is identical either way) — so
   `bunx tsc --noEmit` in that workspace **never sees a test file**. A bare `// @ts-expect-error` in
   `packages/core/test/` is, in story 1.3's words, *"a comment wearing a test's clothes."* Story 1.3
   deliberately spent **zero** `tsc` invocations specifically to leave the budget for this story (its
   Completion Note 15 is a forward note addressed to you). The harness already exists **twice** — copy it,
   §5.4-C. Both directions, every time: a fixture that must fail **and** a fixture that must pass.
3. **Do not migrate the existing project session.** `epics.md`'s dispatch note: *"Do **not** migrate the
   existing project session here."* `SPEC.md`'s Assumptions: *"CAP-7 lands in two moves: the resolver arrives
   **additively**, with new profiles resolving through it while the existing project-session path is
   untouched, and a follow-on migrates the live chat path onto it. Both are in scope; separating them keeps
   the change that touches production traffic behind its own gate."* You are the first move. Story 2.2 is the
   second. Removing a session-kind conditional is 2.2's content, and doing it here defeats the gate.
4. **Never run an ad-hoc probe outside the test harness.** Outside `bun test`, `NODE_ENV` is not `test`, so
   `usage-ledger.ts`'s write-guard correctly does not fire and a write lands on the home default. **This
   already happened.** `~/.telar` exists on this machine right now — created 2026-07-26 01:20 by a `bun -e`
   probe a story-1.1 verification agent ran outside the harness — and it holds a synthetic `$1` billing line
   plus a default `accounts.json`. It is logged under **NEEDS A HUMAN** in the orchestrator run log. Two
   consequences bind you: (a) run every probe as a `bun test` file, or as a child process you spawn *from*
   one; (b) **never mutate `process.env.TELAR_HOME` in the shared test process to prove a guard fires** — use
   a child process (§5.4-D). Sandboxing a suite by pinning `TELAR_HOME` to an `mkdtemp` root before dynamic
   imports is a different thing and remains the settled convention; the ban is on using the shared process's
   env to demonstrate a guard's behaviour. **This story should need neither** — see §5.5-D2, the resolver
   composes no state path at all.
5. **Do not edit `bunfig.toml`.** Not to add a pattern, not to remove one. It is an unresolved
   `[Review][Decision]` on story 1.1 and it is the human's call. All three epic-1 stories fenced themselves
   from it; you are the fourth. Prove you did not: `git diff --stat -- bunfig.toml` must print **nothing**.
6. **The invariant suite already exists and it will fight you before it helps you.**
   `packages/core/test/invariants.test.ts` (2454 lines at `b44d9b5`) mechanically enforces five load-bearing
   rules over the whole tree, and three of its pins sit directly across your path: `INV-3a` asserts the
   `TELAR_HOME` path-composition inventory is **exactly 18 named sites**; `INV-1g` pins the chat route's
   `PreToolUse` wiring and both loom moat constants; `INV-3f` asserts every `KNOWN_VIOLATIONS` entry still
   violates. **Read both story-1.3 files before you design anything** (§5.3 item 1). **This story adds no new
   `KNOWN_VIOLATIONS` entry.** If you find yourself wanting one, you have designed a module that composes a
   state path, and §5.5-D2 says not to.
7. **A green test can assert nothing.** Every new assertion in this story gets the house treatment: break the
   thing it guards, capture the **real** failure output, restore with `git checkout --`, verify the restore
   with an empty `git diff --stat`. "Revert the fix, watch the test fail" is the house standard, named in
   story 1.2 and executed as numbered probes P1–P7 in story 1.3's Debug Log. Do the same. Any scan you write
   also carries an **anti-vacuity floor** and a **permanent positive control** (§5.4-E) — non-negotiable, and
   the reason is in story 1.1's history: it spent two repair rounds on tests that were green while asserting
   nothing.

**Write set — declared, because this story deliberately spans two workspaces.**

| Path | Why it is in the write set |
| --- | --- |
| `packages/core/src/session-profile.ts` (**NEW**) | The port: types, the pure fold, the registry, the capability check |
| `packages/core/src/providers.ts` (**EDIT**) | AD-11's "the provider port publishes what it supports" — the capability set belongs on the existing provider seam, not on a second one |
| `packages/core/src/index.ts` (**EDIT**) | The barrel is the package's only public route (`exports` is `{".": "./src/index.ts"}`), so it is the only way the route can reach the port |
| `packages/core/test/session-profile.test.ts` (**NEW**) | The unit suite + the two-direction `tsc` pins + prove-run leg L6 |
| `packages/core/test/invariants.test.ts` (**EDIT**) | AC6 says *"the invariant suite"* asserts it. INV-6, added per §5.5-D12 |
| `apps/web/lib/session-profiles.ts` (**NEW**) | Track B's own file: the four `SessionProfileSpec` builders |
| `apps/web/lib/session-profiles.test.ts` (**NEW**) | The builders carry D11's real per-kind decisions, and web specs colocate beside their module (`commands.test.ts`, `permissions.test.ts`, `titles.test.ts` all do). Without it, a wrong capability name in a builder is caught only by one manual `curl` |
| `apps/web/app/api/chat/route.ts` (**EDIT, MINIMAL**) | AC1 and AC4 are statements about this file. WORK-SPLIT's Track B row owns it outright |

**Anything outside that table is a cross-track finding, not an edit.** The protocol is settled and has run
three times: story 1.1's AC6 finding, story 1.2's `sessions/` co-tenancy finding, story 1.3's `mock.module`
finding. **Stop and record it.** Do not quietly cross the boundary. In particular: `apps/web/lib/permissions.ts`
(which owns `makeGuardrailDecision`), `apps/web/components/**`, and every `packages/core/src` file other than
the three named above are **not yours**.

**Track B's write set, verbatim from `WORK-SPLIT.md`:** `| **B — Session profiles** | apps/web/app/api/chat/route.ts, the profile resolver, Codex MCP injection | — | nothing |`. Its `Extends via seam` column is `—`
because it owns its files outright. The corollary matters more than the entitlement: Tracks D, E and F list
`a SessionProfile` in *their* seam column, so **they must be able to add a profile without editing your
files.** That single sentence is why §5.5-D10 makes the catalogue a registry and not a `switch`.

---

## 1. User Story

As a telar surface author,
I want a typed session profile resolved before the route body runs,
So that adding a new kind of session means adding a profile rather than another conditional branch through a
103KB handler.

**Why this story exists, in one paragraph.** `brownfield.md` states the gap without hedging: *"No
session-config abstraction. There is no `SessionProfile`, no resolver, and no capability declaration —
session shape is computed inline from `manifest.root` and branched on where a surface needs something
different. Three features are queued to add a fourth, fifth and sixth session kind against that, and
`SPEC-organization-workspace`'s story 6 is currently written as 'lift the chat route's project gate' — the
conditional AD-9 forbids."* Three epics are about to push three new session kinds through one 1922-line
handler on which the Human-Accept Moat currently rides. This story is the seam that lets them arrive as data.
And it is the seam that must not *become* the hole: `SPEC.md`'s own binding note reads *"Making session
config data is exactly the move that could turn a structural invariant into a configurable one, which is why
the guardrail sits outside the profile."*

**What is already true, and is the reason this is a refactor rather than an invention.** `brownfield.md`
again: *"The gate is one expression. `manifest = getProject(project).manifest`, and `const workspace =
manifest.root` then feeds **cwd, guardrails and `settingSources`** for both providers. Those three are
exactly the first three fields of the `SessionProfile`, which is why AD-9 calls the profile a refactor of
what the handler already computes rather than a new concept."* You are naming a thing the route already
builds — not designing a new one.

---

## 2. Acceptance Criteria

Verbatim from `_bmad-output/planning-artifacts/epics.md` § "Story 2.1: The SessionProfile resolver". The
`**Given/When/Then**` text is the contract; the `Proof` and `Notes` lines under each are this story's, and are
how a reviewer will check it.

### AC1 — a typed profile, resolved before the route body

**Given** a request arrives at the chat route
**When** the profile resolves
**Then** it produces a typed `SessionProfile` `{cwd, guardrails, settingSources, mcpServers[], toolPolicy, requiredCapabilities, systemPromptAppendix}` **before** the route body executes

- **Proof:** two halves, and both are required.
  1. **The type and the fold**, unit-tested in `packages/core/test/session-profile.test.ts`: for each of the
     four registered kinds, `resolveSessionProfile` returns an object carrying all seven fields with the
     values §5.5-D11's table specifies.
  2. **The ordering**, asserted structurally by `INV-6c` (§5.5-D12): in `apps/web/app/api/chat/route.ts` the
     character index of the `resolveSessionProfile(` call site is **less than** the index of
     `new ReadableStream(`. That is what "before the route body executes" means in this file, and it is
     checkable. `new ReadableStream({` sits at `≈:503`; everything from `POST(` at `≈:273` to `≈:501` is the
     pre-stream preamble. Your call goes in that preamble.
- **Notes:** "before the route body" is not a vibe — §5.5-D9 fixes the exact insertion point and the reason
  it is *there* and not three lines earlier or later. The `mcpServers[]` notation is honoured as a name-keyed
  `Record`, not an array; §5.5-D6 records that deviation and why refusing it would be worse.

### AC2 — the guardrail runs regardless of profile, and no field can skip it

**Given** any session, of any profile
**When** it runs
**Then** the `PreToolUse` guardrail runs for it regardless of profile — it is wired into the pipeline outside the profile and no profile field can skip it

- **Proof:** three halves.
  1. **Nothing moves.** `git diff -- apps/web/app/api/chat/route.ts` shows **no change** to the
     `hooks: { PreToolUse: [{ hooks: [preToolUseGuardrail] }] }` literal (`≈:1314`), to
     `preToolUseGuardrail` itself (`≈:789`), or to `canUseTool` (`≈:665`). `INV-1g` already asserts that
     wiring and must stay green — run it by name and paste the output.
  2. **The type cannot express it.** `INV-6a` pins `SessionProfile`'s field set to exactly AD-9's seven config
     names **plus `kind`** — eight, and the distinction matters (§5.5-D1, §5.5-D12). A field called `hooks`,
     `canUseTool`, `permissionMode`, `skipGuardrail` or anything else that could reach hook registration
     **fails that test**, which is what makes adding one a deliberate act rather than an accident.
  3. **Guardrail data unions, never replaces.** §5.5-D4: a spec may only *add* `disallowedTools` /
     `protectedPaths` on top of `manifest.guardrails`. Test the fold directly — a spec asking for an empty
     guardrail set still yields the manifest's entries.
- **Notes:** read the distinction precisely, because it is the whole AC. **The profile supplies guardrail
  DATA. It never supplies guardrail WIRING.** `makeGuardrailDecision` lives in `apps/web/lib/permissions.ts`
  and is called from two places — `canUseTool` (`≈:678`) and `preToolUseGuardrail` (`≈:792-802`, the
  documented backstop for `permissionMode` `auto`/`acceptEdits`, where the SDK can approve a call without
  ever invoking `canUseTool`) — and neither call site is yours to touch. `preToolUseGuardrail` is a closure
  over `manifest` and `workspace`, captured **once per request**, not per profile — which is itself the
  structural reason no profile field can reach it.

  **Scope note, stated so you do not over-assert, and it matters more than it looks.** `hooks` is a
  Claude-SDK concept. The Codex fork (`if (provider === "codex")` at `≈:859`) calls `runCodexTurn` with no
  `hooks` argument at all — it uses `approvalPolicy` + `onCodexApproval` instead, reusing the same
  permission-card machinery. AC2 is scoped to **profile**, not to **provider**. Do not write a test claiming
  `PreToolUse` runs on a Codex turn; it structurally cannot.

  **And there is a real pre-existing gap behind that, which you must record rather than fix.** Measured:
  `makeGuardrailDecision`, `disallowedTools` and `protectedPaths` appear **nowhere** in the Codex branch, so
  today a project's `manifest.guardrails` is **never enforced on a Codex session**. That is a genuine hole in
  AD-1's tool-layer half, it is older than this story, and closing it means changing behaviour **inside**
  `new ReadableStream` — which AC5 forbids. So: **record it in
  `_bmad-output/implementation-artifacts/deferred-work.md`** under this story's own section, with a
  file-and-symbol citation, exactly as story 1.1 recorded its AC6 finding and 1.3 recorded the `mock.module`
  defect. Recording it is a deliverable of this story (T-D3). Fixing it is not.

### AC3 — over-granting does not compile

**Given** a developer attempts to author a profile that grants a tool the base policy denies
**Then** it does not compile — `toolPolicy` carries deny lists and allow-narrowing only, and intersect-only is enforced by its type rather than by review

- **Proof:** the `tsc` harness of §5.4-C, run over generated fixtures, **in both directions**:
  - a fixture whose `allow` names a tool outside the base union → `ok === false`, and the diagnostic text
    contains the offending tool name **and** the type name. Not merely "some error" — story 1.2's
    `event-bus.test.ts` precedent asserts on the message for exactly this reason: a fixture that stopped
    compiling for an unrelated reason (a bad path, a renamed export) otherwise reads as a passing proof.
  - the same fixture with a name **inside** the base union → `output === ""` and `ok === true`.
  - a `Equal<>` identity pin on `ToolPolicy`'s own shape, so **adding a field** to it breaks this compile
    even when every runtime test still passes (`session-lease.test.ts`'s `AC11 the union is EXACTLY held | reclaimable`
    is the pattern; copy it).
- **Notes:** §5.5-D3 fixes the mechanism, and it is deliberately **not** a branded type — core has no
  branded-type precedent and inventing one here would be the wrong kind of clever. The house mechanism is the
  `as const` readonly tuple plus a union-element type, exactly as `ADMISSION_CLASSES` and
  `LEASE_RECLAIM_OUTCOMES` do it. **`epics.md`'s dispatch note is the standard to hold yourself to:
  `toolPolicy` is intersect-only by its type *"because 'we will review for it' is not a mechanism."*** The
  runtime fold intersects as well (§5.5-D3, belt-and-braces) so a `as` cast cannot widen either — that is
  AD-1's own "enforced twice" doctrine applied one level down.

### AC4 — an unmet capability fails before the stream opens

**Given** a profile declares a `requiredCapability` the provider port does not publish
**When** a session with that profile starts
**Then** it fails with a hard error **before the stream opens**, matching the route's existing pre-SSE 400 — no silent degradation

- **Proof:** three halves.
  1. **The checker**, unit-tested: `unmetCapabilities(profile, providerId)` returns the missing names for a
     profile requiring something Codex does not publish, and `[]` when the provider publishes everything
     required.
  2. **The route turns that into the existing 400**, not a new error path: a `Response.json({ error }, { status: 400 })`
     return placed in the pre-stream preamble, matching the **eight** existing pre-SSE 400s byte-for-byte in
     shape (measured: unknown project, unknown account, unregistered manifest account, account-not-logged-in,
     invalid effort, invalid sandbox, invalid approvalPolicy, invalid permissionMode — **all eight** use
     exactly `Response.json({ error: <string> }, { status: 400 })` with no custom headers).
     `brownfield.md`: *"The fail-before-the-stream pattern already exists… CAP-7's `requiredCapabilities`
     check inherits that placement rather than inventing an error path (AD-11)."*
  3. **A real dev-server 400**, captured verbatim in the Debug Log — §6.3's `curl` line. This is what the
     story's own dev-server-proof line asks to be *"shown in the response."*
- **Notes:** §5.5-D7 fixes the capability names by **measurement** against the Codex fork at `≈:859`, not by
  invention — there is no capability notion in the tree today, so every name you add must trace to a real
  divergence you can point at. §5.5-D11 fixes which kind requires what, and carries the one **disclosed
  behaviour change** this story makes. Read it before you set a single `requiredCapabilities` value: the
  honest answer changes what a Codex escalation session does today, and AD-11's whole point is that the
  change is in the right direction (*"No silent degradation, ever"*).

### AC5 — the existing project-session path is untouched

**Given** the existing project-session path
**When** this story lands
**Then** it is untouched — the resolver arrives additively and new profiles resolve through it

- **Proof:**
  - `git diff -- apps/web/app/api/chat/route.ts` is reviewable in one screen and contains **only**: import
    additions, the resolve call, the capability gate. Nothing inside `new ReadableStream` changes. Paste the
    whole diff into the Debug Log.
  - The `project` kind's spec declares **no** `requiredCapabilities` (§5.5-D11), so a project session on
    either provider passes the new gate unchanged. Assert that as a named test, on both provider ids.
  - `apps/web`'s `bun test` and `bunx tsc --noEmit` both green; `cd packages/core && bun test` green.
- **Notes:** "untouched" is about *behaviour*, and the resolver call is additive precisely because nothing
  consumes its output yet except the capability gate. §5.5-D8's ruling — **resolve for every request, consume
  only the gate** — is what makes AC1 and AC5 hold at once. If you find yourself feeding
  `sessionProfile.toolPolicy` into `allowedTools`, stop: that is story 2.2, and it is behind its own gate for
  a reason.

### AC6 — the invariant suite asserts no field can widen a grant

**Given** the invariant suite
**Then** it asserts that no `SessionProfile` field can widen a tool grant

- **Proof:** `INV-6` in `packages/core/test/invariants.test.ts`, per §5.5-D12: a pinned field inventory, a
  pinned `ToolPolicy` shape, the route-ordering assertion, an anti-vacuity floor, a positive control that the
  scan **discriminates**, and an executable citation of the `tsc` pins in
  `packages/core/test/session-profile.test.ts` so a renamed test fails loudly instead of rotting.
- **Notes:** this assertion was handed to you **by name**. Story 1.3's scope-fence table: *"'no
  `SessionProfile` field can widen a tool grant' and the 'unmet `requiredCapability` fails pre-stream' leg…
  both move to **story 2.1** by explicit ruling… asserted where the type is built, rather than creating a
  dependency on a later epic. RF's six-port success signal is jointly satisfied by 1.3 + 2.1."* You are the
  second half of that signal. §5.5-D14 is how the two halves become **one command**.

### Dev-server proof

**None — no dev-server-visible change** (NFR-RF-5: *"Nothing in this SPEC is user-visible. A capability here
that starts growing a surface has escaped its package."*). The proof is a profile with an unmet
`requiredCapability` returning a 400 before any SSE frame is written, shown in the response — §6.3's `curl`
line, captured verbatim.

---

## 3. Scope fences — what this story does NOT do

| Not in scope | Why, and where it lives instead |
| --- | --- |
| **Migrating the project / loom-node / steerer session onto the profile** | §0 rule 3. This is **story 2.2** in full, by explicit ruling in `SPEC.md`'s Assumptions and `epics.md`'s dispatch notes. 2.2 is *"the story that touches production traffic"* and is deliberately behind its own gate |
| **Removing any session-kind conditional from the handler** | Same. 2.2's AC1 is literally *"no session-kind conditional remains in the handler."* `isPlannerSession` (`≈:611`), `isSteererSession` (`≈:615`) and `isEscalationSession` (`≈:626`) all stay exactly as they are |
| **Codex MCP injection** | `SPEC.md` non-goal, verbatim: *"A distinct piece of Track B, already storied in `SPEC-organization-workspace` and optional for v1… CAP-7 supplies the `requiredCapabilities` mechanism that makes the gap fail closed rather than degrade silently; the injection work itself is not re-claimed here."* You build the mechanism that *reports* the gap. You do not close it |
| **`SessionProfile` fields beyond AD-9's seven (plus `kind`)** | `SPEC.md` non-goal: *"AD-9 fixes the resolved-before-the-body shape and the intersect-only `toolPolicy`; additional fields are added by the surface that needs them."* `INV-6a` pins the eight, so a spare field fails a test |
| **The project-less master profile (`cwd: TELAR_HOME/workspace/home`, `settingSources: []`)** | Track E / epic 5. AD-9 names it as the motivating example, not as this story's deliverable. §5.5-D2 has the forward note about what that profile will have to do about `INV-3a` when it lands |
| **A zod schema for `SessionProfile`** | §5.4-H and §5.6 T-12. It is a per-request resolution, never persisted, so AD-6's "zod schemas for persisted entities" does not reach it — and a zod round-trip would **destroy** AC3 by widening the literal union back to `string[]` |
| **Editing `bunfig.toml`** | §0 rule 5. Unresolved `[Review][Decision]` on story 1.1; the human's call. Fourth story in a row to fence itself from it |
| **Resolving any of story 1.1's five `[Review][Decision]` items, or story 1.2's open residual** | All still the human's. In particular **do not** touch `usageSummary`'s `ownerKind !== "session"` filter, `getChat`'s discarded `costUsd`, or `releaseAdmission`'s class-mismatch residual |
| **Touching `apps/web/lib/permissions.ts`** | Not in the write set. It owns `makeGuardrailDecision` and both its call sites are outside your diff. A change needed there is a **cross-track finding**, per §0's write-set table |
| **Adding an MCP tool, or an MCP server** | `INV-1b` pins the `{server → tools}` inventory for all three servers exactly. Adding either fails it. And AD-1 is absolute: there is no agent-callable accept tool and none is ever added |
| **A new `KNOWN_VIOLATIONS` entry** | §0 rule 6. It would mean you composed a state path; §5.5-D2 says the resolver composes none |
| **Extracting a shared test helper module in `packages/core/test/`** | 107 self-contained `*.test.ts` files (measured at `b44d9b5`) and the directory **has never held a helper module**. Story 1.2's Completion Note 7 duplicated a ~25-line harness across two suites rather than introduce a shape the convention does not have. Duplicate the `typecheck()` harness a third time; that is the house answer and story 1.3's own header says so |
| **Adding CI** | Declined at spine-authoring time (AD-19, `SPEC.md` non-goals). The trio is **manual**. No workflow file, no git hook, no script pretending to be one |
| **Rendering anything** | NFR-RF-5. Epic 2 has no user-visible outcome; `epics.md` flags this as accepted risk EQ-2 by owner ruling |

---

## 4. Tasks / Subtasks

Four legs, in order. **Leg A before Leg B before Leg C**: the port's type shape is what the spec builders are
written against, the specs are what the route consumes, and the invariant pins the result. Leg D is the
record.

### Leg A — the core port (AC1, AC3, AC4)

- [x] **T-A0 — measure before you design.** Do not write a line of `session-profile.ts` until you have
      recorded, in the Debug Log: the exact `allowedTools` array the route builds today (`≈:1242-1271`), the
      exact `disallowedTools` array (`≈:1285-1289`), the exact `settingSources` value (`≈:1227`), the
      `cwd`/`guardrails` expressions, and the full `runCodexTurn` argument list (`≈:931`). §5.5-D3's base
      allow-list and §5.5-D7's capability names are both **derived from those measurements**, not invented.
      An invented base list is a guard that does not guard — story 1.1's Repair Round 4 lesson verbatim:
      *"an invariant that scans for pattern X while production writes pattern X′ is a guard that does not
      guard."*
- [x] **T-A1 — `ProviderCapability` and the provider port** (`packages/core/src/providers.ts`). Per §5.5-D7.
  - [x] `ProviderCapability` as an `as const` readonly tuple + its union type, following
        `ADMISSION_CLASSES` exactly (§5.4-B). Every member's comment names the **measured** divergence it
        stands for and the `route.ts` symbol that proves it.
  - [x] `capabilities: readonly ProviderCapability[]` added to `ProviderDescriptor`, populated for both
        entries of `PROVIDERS`. Safe by measurement: `ProviderDescriptor` is constructed **only** by
        `PROVIDERS` (grepped — `providerOf` has five callers, all read-only), so a required field breaks no
        consumer. Re-verify that before you rely on it.
  - [x] `providerPublishes(id, cap)` and `providerCapabilities(id)`, both pure, both routed through the
        existing `providerOf` rather than re-reading `PROVIDERS`.
  - [x] Extend the file's header banner with a `CAPABILITIES.` paragraph explaining why the list lives on the
        auth/config seam — the file's current header says *"This file is auth/config only"*, so **that
        sentence must be updated in the same edit** or the header now lies. This is not optional politeness;
        a header contradicted by its own file is exactly the drift the citation policy exists to stop.
- [x] **T-A2 — the types** (`packages/core/src/session-profile.ts`). Per §5.5-D1, D3, D4, D5, D6.
  - [x] `SessionKind` as an `as const` tuple + union: the **four kinds that exist today**, named from the
        route's own vocabulary.
  - [x] `BASE_ALLOWED_TOOLS` as an `as const` tuple, derived in T-A0, plus `BaseAllowedTool`.
  - [x] `ToolPolicy` — `deny: readonly string[]` (anything) and `allow?: readonly BaseAllowedTool[]`
        (narrowing only). **A `MOAT:` comment in `runner/lease.ts`'s exact register** stating what the type
        cannot express and why. No third field.
  - [x] `ProfileSettingSource = Exclude<SettingSource, "user">` with the WHY (§5.5-D5). Same utility-type
        family as `critic.ts`'s `Omit<>` and `lease.ts`'s `Pick<>`.
  - [x] `SessionProfileSpec` (author-facing input) and `SessionProfile` (resolver output). §5.5-D1 fixes both
        shapes and the reason there are two.
  - [x] The file's WHY header, in the `admission.ts` register (§5.4-A): what it replaces, the trade-off most
        likely to be re-litigated, scope, and the moat paragraph.
- [x] **T-A3 — the fold** (`resolveSessionProfile`). Pure. No I/O, no clock, no state root.
  - [x] `guardrails` = manifest's ∪ spec's additions (§5.5-D4). Union, never replacement.
  - [x] `toolPolicy` = base ∩ spec's `allow` (when present), minus everything in `deny`; **`deny` always
        wins**, matching the SDK's own documented guarantee that a disallow beats any allow (the route's
        comment at `≈:1223-1226` states it).
  - [x] `cwd` from the resolution context, not from the spec (§5.5-D1's note and its epic-5 forward pointer).
  - [x] Error messages follow the house form: module-name prefix, the diagnosis, the consequence, the next
        step (§5.4-F).
- [x] **T-A4 — the registry** (`registerSessionProfile` / `resolveSessionProfile` / `resetSessionProfiles`).
      Per §5.5-D10 — mirror `event-bus.ts`'s `declareEvents` discipline exactly, including the reset export
      and the reason it exists (T-4).
- [x] **T-A5 — the capability check** (`unmetCapabilities`). Pure; returns the missing names, never throws,
      never formats a 400. Per §5.5-D8.
- [x] **T-A6 — the barrel** (`packages/core/src/index.ts`). One `export * from "./session-profile";` with an
      `AD-9/AD-10/AD-11` banner comment in the established register. §5.4-A reproduces the **event-bus**
      barrel banner verbatim as the model; the sibling **admission** banner it should also match sits at
      `packages/core/src/index.ts` immediately above `export * from "./admission";` and is not reproduced here
      — read it in place. Check for name collisions **before** using `export *`; the `tick.ts` precedent is
      what to do if there is one. Note `providers.ts` is already exported, so T-A1's additions need no barrel
      change.

### Leg B — the specs and the route (AC1, AC4, AC5)

- [x] **T-B0 — the four spec builders** (`apps/web/lib/session-profiles.ts`). Per §5.5-D11's table.
      Registered at module scope, mirroring how `declareEvents` is *shaped* (there is no production call site
      to copy — see T-B1). Each builder is `(ctx) => SessionProfileSpec` and reads **only** what the pre-stream
      preamble already has.
  - [x] Their colocated spec, `apps/web/lib/session-profiles.test.ts` — house convention for `apps/web/lib`
        logic. Drive each builder with a realistic `SessionResolutionContext` and **pin all four kinds'
        `requiredCapabilities` and `systemPromptAppendix` values** against D11's table. The core suite's own
        fixtures are synthetic contexts, so this is the only place a wrong capability *name* in a builder gets
        caught by the gate rather than by one manual `curl`.
- [x] **T-B1 — the resolve call.** At §5.5-D9's exact insertion point. Variable named **`sessionProfile`** —
      **never `profile`**, which is already an `AccountProfile` in this scope (`≈:377`). See T-1; this is the
      single most likely way to silently break billing in this file.
  - [x] **The side-effect import, which nothing else will do for you.** `route.ts` must carry
        `import "@/lib/session-profiles";` alongside its named imports. T-B0's builders register **at module
        scope**, and module scope only runs if something imports the module — so without this line the
        registry is **empty at request time** and `resolveSessionProfile` throws
        `session-profile: cannot resolve "<kind>" — no module declared it` on **every** chat request. That is
        a 500 on the live path, i.e. an AC5 regression, and **the gate cannot catch it**: there is no test for
        `apps/web/app/api/chat/route.ts` anywhere in the tree (measured:
        `ls apps/web/app/api/chat/*.test.ts` → no matches), so `bun test`, `tsc` and `lint` are all green
        while the app is broken. Two verifications, both required: grep `route.ts`'s import block for the
        literal, and — **before** you test the capability-gate 400 — run the dev-server proof against a
        **`project`** session and confirm it streams normally rather than throwing "no module declared it".
        **Note there is no precedent to copy here:** `grep -rn "declareEvents(" packages/core/src apps/web`
        finds **zero** production call sites (measured — the bus is declared only inside its own test), so
        this is the first self-registering module in the tree and nothing will remind you.
- [x] **T-B2 — the capability gate.** `unmetCapabilities` → the existing pre-SSE 400 shape. Placed **before**
      `registerChatRun` (`≈:486`) so a rejected request never leaves a registered run behind — §5.5-D9
      explains why that ordering is load-bearing and not cosmetic.
- [x] **T-B3 — nothing else.** Verify by diff, not by memory: `git diff -- apps/web/app/api/chat/route.ts`
      must show no hunk inside `new ReadableStream`. Paste it.

### Leg C — the proofs (AC2, AC3, AC6)

- [x] **T-C0 — the unit suite** (`packages/core/test/session-profile.test.ts`). §6.4's coverage table is the
      checklist; every row is a named test.
- [x] **T-C1 — the two-direction `tsc` pins.** Copy §5.4-C's harness verbatim. Keep SDK types **out of the
      fixture's import surface** so the simple form suffices (§5.5-D13). Both directions, plus the
      `Equal<>` identity pin, plus a **discriminator** proving a wrong expectation really does fail.
- [x] **T-C2 — prove-run leg L6.** Per §5.5-D14. Transcript line in the same register as L1–L5, and the
      **measured** one-command form that selects all six legs. If the filter does not behave as D14 predicts,
      **disclose two commands** — do not fake one.
- [x] **T-C3 — `INV-6`** (`packages/core/test/invariants.test.ts`). Per §5.5-D12. Floor, then pins, then the
      discriminator, then the executable citations. **Update the file's own `THE FIVE` header block** — it
      currently enumerates exactly five and says so twice. A sixth invariant under an unamended header is the
      same defect class as T-A1's stale sentence.
- [x] **T-C4 — `INV-1g`, `INV-3a`, `INV-3f` still green.** Run each by name. Paste each result. These are the
      three pins your change sits across (§0 rule 6).

### Leg D — the gate and the record

- [x] **T-D0 — the revert probes.** One per new assertion class, per §0 rule 7 and §6.3. Real failure output,
      restored, diff-verified.
- [x] **T-D1 — discovery proof.** §6.2, both mechanisms, for both new test files.
- [x] **T-D2 — the trio.** §6.3's full checklist, real output, both workspaces.
- [x] **T-D3 — the record.** §9 Debug Log and Completion Notes; §10 File List measured with the change staged
      (`git add -A -- packages/core apps/web && git diff --cached --name-status`); §11 Change Log with a
      conventional-commit message. Any finding you declined belongs in
      `_bmad-output/implementation-artifacts/deferred-work.md` under a new
      `## Deferred from: <this story>` section, following that file's own citation policy (**names a file and a
      symbol**; any number is a pointer, not a fact). **At least one entry is required**: the Codex guardrail
      gap of AC2's Notes — `manifest.guardrails` is never enforced on a Codex session — which you found by
      measurement, cannot fix inside AC5's fence, and must not leave unrecorded.

---

## 5. Dev Notes

### 5.1 The architecture rules that bind this story

| Rule | What it obliges you to do here |
| --- | --- |
| **AD-9 — Session config is a resolved profile, not a branch** | The seven-field shape, resolved before the route body. *"A new surface adds a profile; it does not add an `if`"* — which is why the catalogue is a registry (§5.5-D10) |
| **AD-10 — The moat sits outside the profile** | **The primary AD.** The guardrail is wired outside the profile and runs for every session regardless of profile; `toolPolicy` is intersect-only *"enforced by its type, which carries deny lists and allow-narrowing only. No profile field can re-enable an accept path."* Prevents: *"the moat degrading from structural to configurable; a mis-authored profile silently omitting it"* |
| **AD-11 — Missing harness capability fails closed** | *"a profile declares `requiredCapabilities`; the provider port publishes what it supports; an unmet requirement is a hard error **before the stream opens**, matching the route's existing pre-SSE 400. No silent degradation, ever."* Binds *"OW CAP-1, CAP-12 (Codex MCP gap)"* — the gap you must surface |
| **AD-1 — The Human-Accept Moat** | Enforced twice: by construction in core, and at the tool layer by the route's `PreToolUse` hook *"in every SDK permission mode."* Your change must leave the second half byte-identical. `INV-1g` is the mechanical check |
| **AD-3 — Client-bundle rule** | `@telar/core` is server-side only. The profile port's **types** may be `import type`'d by a client component later; its **runtime** may only be reached from a Route Handler. `INV-4` enforces this transitively through value edges — do not add a value import of the port to anything client-reachable |
| **AD-5 / AD-20 — Store ownership** | The resolver owns no subtree and writes no state. §5.5-D2: **compose no path off the state root.** `INV-3a`'s 18-site inventory is exact and a nineteenth site fails it |
| **AD-6 / AD-7 — Persisted format, tolerant readers** | **Do not apply them.** They govern *persisted* entities. `SessionProfile` is a per-request resolution; §5.6 T-12. Their reuse half **does** bind: `ProjectManifest["guardrails"]` is core's zod-owned shape and must not be redefined |
| **AD-17 — One admission controller** | *"Interactive chat sessions are out of band by design: they call the SDK's `query()` directly from the chat route and never enter `agent()`."* So the resolver takes **no admission slot** and must not call `acquireAdmission`. If you ever touch admission: release through the handle `acquireAdmission` returns, never `releaseAdmission(cls)` — story 1.2's Completion Note 15 residual, guarded by `INV-5f` |
| **AD-19 — Load-bearing invariants are executable** | AC6 is this rule applied to AD-10. `INV-6` joins the suite (§5.5-D12) |
| **NFR-X-8 / NFR-X-9** | The two NFRs that *are* this story: moat outside the profile; fail closed, fail early |
| **NFR-RF-4** | *"One route, one resolver, one guardrail. Separate routes per session kind are rejected — a moat enforced in three places has three chances to be forgotten."* Do not add a route |
| **NFR-RF-1** | *"Reuse, never rebuild… Copy the settled expression; do not invent a variant."* Reuse `ProjectManifest["guardrails"]`, the SDK's `McpServerConfig` and `SettingSource`, the existing pre-SSE 400 shape, `providerOf`, and the `typecheck()` harness |
| **NFR-RF-5** | Nothing user-visible. *"A capability here that starts growing a surface has escaped its package"* |

### 5.2 Files to touch

| File | New / Edit | What goes in it |
| --- | --- | --- |
| `packages/core/src/session-profile.ts` | **NEW** | `SessionKind`, `BASE_ALLOWED_TOOLS`, `BaseAllowedTool`, `ToolPolicy`, `ProfileSettingSource`, `SessionProfileSpec`, `SessionProfile`, `SessionResolutionContext`, `registerSessionProfile`, `resolveSessionProfile`, `resetSessionProfiles`, `unmetCapabilities`. Pure; no `node:fs`, no `node:os`, no `node:path`, no state root |
| `packages/core/src/providers.ts` | **EDIT** | `PROVIDER_CAPABILITIES` tuple + `ProviderCapability`; `capabilities` on `ProviderDescriptor`; both `PROVIDERS` entries; `providerPublishes`, `providerCapabilities`; header amended |
| `packages/core/src/index.ts` | **EDIT** | One `export *` line + its AD banner |
| `packages/core/test/session-profile.test.ts` | **NEW** | The unit suite, the two-direction `tsc` pins, prove-run leg L6 |
| `packages/core/test/invariants.test.ts` | **EDIT** | `INV-6` + the amended `THE FIVE` header |
| `apps/web/lib/session-profiles.ts` | **NEW** | The four `SessionProfileSpec` builders and their registration |
| `apps/web/lib/session-profiles.test.ts` | **NEW** | Each builder against a realistic `SessionResolutionContext`, pinning D11's four `requiredCapabilities` / `systemPromptAppendix` values |
| `apps/web/app/api/chat/route.ts` | **EDIT** | The named imports **plus `import "@/lib/session-profiles";`** (T-B1 — the registry is empty without it), one resolve call, one capability gate. Nothing else |

**Read completely before editing, and record for each what it does today, what you change, and what must be
preserved** (this is the step whose omission is the top cause of review cycles):

- `apps/web/app/api/chat/route.ts` — 1922 lines. §5.3 item 2 tells you which regions and why.
- `packages/core/src/providers.ts` — 48 lines. Read it all; it is small and its header makes a scope claim you
  are about to change.
- `packages/core/src/index.ts` — 88 lines. Read the two banner comments you are about to match.
- `packages/core/test/invariants.test.ts` — 2454 lines. §5.3 item 1.

### 5.3 Read these before you write

1. **`packages/core/test/invariants.test.ts` and `packages/core/test/track-a-prove-run.test.ts`, in full.**
   Non-negotiable, and first. They are story 1.3's deliverable and they mechanically enforce the rules you
   are about to build inside. What you are looking for:
   - the top-of-file `THE FIVE LOAD-BEARING INVARIANTS` block, the **anti-vacuity rule**, the
     **self-reference rule** (violation scopes exclude `*.test.ts`; floors are over the whole index — *"Do
     not 'fix' that exclusion"*), and the **failure-message rule**: *"No test in this repo passes a message
     argument to `expect` (measured across all core suites)… the DIAGNOSIS IS BUILT INTO THE ASSERTED VALUE."*
     Every assertion you add obeys that.
   - `INV-1g` — the exact route pins: `LOOM_START_TOOL`, `LOOM_ANSWER_BLOCKED_TOOL`, the
     `input.tool_name === <CONST>` comparisons, `/hooks\s*:\s*\{\s*PreToolUse\s*:/`, and the literal
     `preToolUseGuardrail`. **Your diff must not disturb any of them.**
   - `AD5_SITES` — the 18-entry pinned inventory, and `INV-3a`'s message: *"if the new site is legitimate,
     reach the subtree through the owner's exported port… Do not delete the entry to make this pass."*
   - `SANCTIONED_ROOT_RESOLVERS` (five modules) and `KNOWN_VIOLATIONS` (**exactly one** entry,
     `scripts/backfill-tool-detail.ts`), plus `INV-3f`, which fails if that count changes without the test
     being updated. Read its message; it tells you the quarantine is *"the difference between a quarantine
     and a suppression."*
   - `track-a-prove-run.test.ts`'s header: the **one-command form**, the **path-argument** rationale, the
     five legs, and the two module-singleton hazards. §5.5-D14 builds L6 on top of that header.
2. **`apps/web/app/api/chat/route.ts`** — these regions, with these questions. Two orienting facts first,
   both measured, both saving you a wrong turn: (i) the file has **exactly one export**, `POST`, and **no zod
   schema for the request body** — it is plain destructuring of `await req.json()` plus hand-written
   narrowing, so do not go looking for a schema to extend; (ii) there is no single "session kind" switch.
   There are **two independent branch dimensions**: the **provider** fork (`≈:859` / `≈:1129`) and, *inside
   the Claude branch only*, the three role-derived flags. That shape is why D11's table is per-kind while D7's
   is per-provider.
   - `≈:273-501`, the **pre-stream preamble**. This is the whole surface you may edit. Note the *order*:
     body destructure → `role`/`runId`/`ultraAnnotated` normalisation → escalation message resolution →
     project 400 (`≈:349`) → account 400 (`≈:358`) → account-resolution 400 (`≈:383`) → account-health 400
     (`≈:400`) → `const provider` (`≈:408`) → effort 400 (`≈:419`) → sandbox 400 (`≈:436`) → approvalPolicy
     400 (`≈:455`) → permissionMode 400 (`≈:470`) → `model` (`≈:477`) → `const workspace = manifest.root`
     (`≈:478`) → `abort` + `registerChatRun` (`≈:485-486`) → `titlePromise` (`≈:499`) →
     `new ReadableStream({` (`≈:503`).
   - The pre-SSE 400 shape, quoted so you copy it rather than paraphrase it:
     ```ts
     return Response.json(
       { error: `Unknown project "${project ?? ""}".` },
       { status: 400 },
     );
     ```
   - `≈:600-630`, the three session-kind flags. These are the conditionals 2.2 removes. Read them to learn
     what each kind *is*; do not touch them.
   - `≈:859-945`, the **Codex fork**. `runCodexTurn` takes `{prompt, cwd, env, model, reasoningEffort, sandbox, resume, signal, approvalPolicy, onApproval}` —
     **no `hooks`, no `mcpServers`, no `allowedTools`/`disallowedTools`, no `settingSources`, no
     `permissionMode`, no `systemPrompt`.** This argument list is the evidence base for §5.5-D7. Note also
     what Codex **does** have: interactive approval cards, via `onCodexApproval` reusing
     `createPending`/`resolvePending`. Do not invent a divergence that is not there.
   - `≈:1172-1324`, the Claude `query()` options — `cwd`, `systemPrompt`, `permissionMode`,
     `settingSources: ["project", "local"]`, `allowedTools`, `disallowedTools`, `mcpServers`,
     `strictMcpConfig: true`, `canUseTool`, `hooks: { PreToolUse: [{ hooks: [preToolUseGuardrail] }] }`.
     This block is what 2.2 will drive from the profile. Read the long comment above `settingSources` — it is
     the source for §5.5-D5.
   - `≈:1816-1817` — `costUsd: capturedSession ? sessionSpendUsd(capturedSession) : lastResult.totalCostUsd`.
     Story 1.1 changed this to the session's **ledger total**. `epics.md` carries a preservation warning on
     story **2.2** about it; you are not editing this line, and the point of reading it is to know that it
     exists so you do not.
3. **`packages/core/test/session-lease.test.ts`** — the `typecheck()` harness, the `Equal<>` identity pin, and
   the discriminator that proves the pin works. §5.4-C quotes it; read it in place for the surrounding
   reasoning.
4. **`packages/core/test/event-bus.test.ts`** — the second `typecheck()` copy, the `declareEvents` registry
   discipline (§5.5-D10's model), and the `z.input`/`z.output` split. Note the fixture-prelude technique:
   the fixture imports the module by **absolute path** so the throwaway directory needs no `node_modules`.
5. **`packages/core/src/admission.ts`** — the header banner you are matching (§5.4-A), the
   `ADMISSION_CLASSES` `as const` tuple you are copying (§5.4-B), the `assertAdmissionClass` error form
   (§5.4-F), and the release-handle pattern.
6. **`packages/core/src/runner/lease.ts`** — the `MOAT:` comment register and the `LEASE_RECLAIM_OUTCOMES`
   pairing of a union with an enumerable tuple. This is the exact idiom `ToolPolicy` uses.
7. **`_bmad-output/implementation-artifacts/deferred-work.md`** — all of it. Specifically the
   `mock.module("@telar/core")` cross-track defect (§5.6 T-7) and the `writeLease` fixed-temp-filename race.
8. **`_bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md`**
   §§ AD-9, AD-10, AD-11 and the `Consistency Conventions` table (naming, errors, config rows).
9. **`_bmad-output/specs/spec-runtime-foundations/brownfield.md`** — the Track B section. It is the shortest
   document that tells you why this is a refactor.

### 5.4 Patterns and conventions — copy these exactly

**A. The WHY header banner.** Multi-paragraph `//` block before the imports, ALL-CAPS section labels, prose
that argues from evidence — a named failure mode, a specific test name, or a measured number. Wrap at ~78-88
columns. Section dividers inside a file use either `// --- text ---…` (admission.ts) or
`// ── text ────…` (usage-ledger.ts); pick one and be consistent within the file. `admission.ts`'s labels
are the model: `WHAT IT REPLACES.` / `THE TRADE-OFF, stated plainly, because it is the decision most likely
to be re-litigated:` / `SCOPE.` / the AD-20 paragraph / the purity paragraph. The barrel's banners are short
and name the AD, verbatim:

```ts
// AD-14/AD-21 — the one typed, in-process event bus. Every event carries a
// delivery class as a REQUIRED field, and a published name is part of its
// module's port contract: undeclared events are internal and nobody may
// subscribe to them.
export * from "./event-bus";
```

**B. An enumerable union — the house mechanism for "this type cannot express X".** A union type plus an
`as const` tuple of every member, so a test can enumerate the whole space:

```ts
export const ADMISSION_CLASSES: readonly AdmissionClass[] = ["loom-build", "loom-verify", "ultra", "other"] as const;
```

```ts
// MOAT: no branch here can return a terminal-SUCCESS. leaseReclaim only ever
// yields held / reclaimable — never `done`. The union is the guarantee: there is
// no member that can express a completed unit of work…
export type LeaseReclaim = "held" | "reclaimable";
// Every value the union can take, in one place, so a test can enumerate the
// whole outcome space and assert that `done` is not among them.
export const LEASE_RECLAIM_OUTCOMES: readonly LeaseReclaim[] = ["held", "reclaimable"] as const;
```

Note the direction of the annotation in both: `readonly X[]` on the const, `as const` on the literal. Follow
it. For `BASE_ALLOWED_TOOLS` you additionally need the **element union** derived *from* the tuple, which is
the thing that makes AC3 work:

```ts
export const BASE_ALLOWED_TOOLS = ["Read", "Grep", /* …measured in T-A0… */] as const;
export type BaseAllowedTool = (typeof BASE_ALLOWED_TOOLS)[number];
```

So `BASE_ALLOWED_TOOLS` is annotated `as const` **without** a `readonly X[]` type annotation — because the
annotation would erase the literal types the union depends on. That is the one place you deviate from the
shape above, and the deviation is load-bearing; say so in a comment.

**C. The `tsc` harness — copy, do not re-derive.** From `packages/core/test/session-lease.test.ts`, whose
own header states the reason: *"packages/core/tsconfig.json is `include: ["src"], exclude: ["test"]`, so
`bunx tsc --noEmit` in this workspace never sees this file. A structural claim about a TYPE therefore has to
be proved by running the compiler."*

```ts
const CORE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_TSC = path.join(CORE_ROOT, "node_modules", "typescript", "bin", "tsc");
const PROFILE_MODULE = path.join(CORE_ROOT, "src", "session-profile");

const typecheck = (source: string): { ok: boolean; output: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profile-compile-"));
  try {
    const file = path.join(dir, "fixture.ts");
    fs.writeFileSync(
      file,
      `import { BASE_ALLOWED_TOOLS, type ToolPolicy } from ${JSON.stringify(PROFILE_MODULE)};\n` +
        `void BASE_ALLOWED_TOOLS;\n${source}\n`,
    );
    // Run the compiler through THIS runtime: node_modules/.bin/tsc is a
    // `#!/usr/bin/env node` shim and this repo is bun-only, so there may be no
    // `node` on PATH at all.
    const out = spawnSync(
      process.execPath,
      [REPO_TSC, "--noEmit", "--ignoreConfig", "--strict", "--target", "es2022",
       "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck", file],
      { encoding: "utf8" },
    );
    return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
```

`--ignoreConfig` is required: files-on-the-command-line plus a `tsconfig.json` alongside is an error
otherwise. `session-lease.test.ts` additionally passes `"--types", "node"` and `{ cwd: CORE_ROOT }` because
its module under test imports `node:fs`. **§5.5-D13 keeps you in the simpler form**; if you find you need the
`--types node` variant, take it from `session-lease.test.ts` verbatim and **record which form you used and
why** in the Debug Log. The identity pin, verbatim, adapt the type names:

```ts
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
```

Budget: ~0.35 s per fixture (measured by story 1.3), so keep the count small and deliberate.

**D. `TELAR_HOME` in tests — and the ban.** The settled sandboxing convention pins the root **before** the
dynamic imports, because static imports are hoisted:

```ts
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-profile-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = home;
const profiles = await import("../src/session-profile");
beforeEach(() => { process.env.TELAR_HOME = home; });
afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});
```

**Two things about that block.** First, **you should not need it**: §5.5-D2 makes the port pure, so it
resolves no root, and a suite that pins a root it never uses is misleading. Prefer plain static imports and
say in the header that no root is resolved. Second, if you ever need to demonstrate a **guard's** behaviour
under a different `TELAR_HOME`, do it in a **child process**, never by mutating the shared process's env.
§0 rule 4 says why, and the scar is on disk. The house idiom exists — `track-a-prove-run.test.ts`'s L5
layer 1 — and it fakes `HOME` as well as `TELAR_HOME`, which is the part that makes it genuinely hermetic:

```ts
const out = spawnSync(process.execPath, [probe], {
  env: { ...process.env, HOME: fakeHome, TELAR_HOME: "   ", NODE_ENV: "test" },
  encoding: "utf8",
});
if (out.status !== 0) throw new Error(`… the child probe exited ${out.status}. …`);
```

`probe` is a file written to a temp dir, not a `-e` string. Faking `HOME` is what keeps the probe off the real
`~/.telar` even when the guard under test is the thing that is broken — copy that, not just the env spread.

**E. Anti-vacuity floor + permanent positive control.** Every scan asserts a non-trivial floor on what it
found **before** it asserts anything about violations, and carries a control that feeds a synthetic fixture
through **the same matcher** the real scan uses and requires it to be reported. Test titles follow the house
form: `INV-6d the field scan DISCRIMINATES — an added grant-shaped field is reported`. Pass the fixture as an
**in-memory string assembled at runtime**, never as literal source — `packages/core/test` is one of the
scan's own roots, and a literal would make the scanner indict itself (story 1.3's T-13).

**F. Errors.** Plain `new Error(...)`; no custom subclass (the only two in core are `ultra/signals.ts`'s
control signals). The message is prefixed by the throwing function's or module's own name, then the
diagnosis, the consequence, and the next step:

```ts
throw new Error(
  `${fn}: ${JSON.stringify(cls)} is not an admission class — expected one of ${ADMISSION_CLASSES.join(", ")}. ` +
    `Occupancy is keyed by class, so an unknown key would be invisible to the ceiling and admit without limit (AD-17).`,
);
```

`event-bus.ts` uses the module-name prefix when the message is about module state rather than one argument:
`` throw new Error(`event-bus: cannot ${verb} "${name}" — no module declared it. …`) ``. Use
`session-profile:` for the module form.

**G. Naming.** Files kebab-case; singular when the module owns one mechanism, plural for a collection
(`admission.ts` vs `accounts.ts`). `session-profile.ts` is singular: it owns one resolution mechanism.
Public API is plain functions and, where a typed handle is wanted, a **factory function returning an object
literal of closures** (`declareEvents`) — **never a class**; there is no `class` in any of the three story-1.2
modules. Injected seams go **last** with real production defaults. Pure decision functions take **no** seams.

**H. zod.** Schemas share their type's identifier via declaration merging — `export const X = z.object({…});`
then `export type X = z.infer<typeof X>;`, no `Schema` suffix. External input uses `.safeParse` +
`z.prettifyError` in a prefixed `Error`; caller-controlled input uses `.parse`. **You are not adding a zod
schema** (§3's fence, §5.6 T-12) — this entry is here so you recognise, and resist, the pull to write one.

**I. Formatting.** No Prettier, no Biome; `apps/web` has ESLint, core has none. Match surrounding style
exactly. Two-space indent, double-quoted strings, semicolons, trailing commas in multi-line literals.

### 5.5 Design decisions already made for you

These are settled. Implement them; do not re-litigate them. Where a decision could reasonably have gone the
other way, the rejected option is named so you do not rediscover it.

**D0 — Where the code lives, and why the port is in `packages/core`.** `WORK-SPLIT` lists "the profile
resolver" as a Track B asset without fixing a workspace. It goes in `packages/core/src/session-profile.ts`,
for four reasons that stack: (1) AD-11 requires *"the provider port publishes what it supports"*, and the
provider seam is `packages/core/src/providers.ts` — putting the capability set anywhere else creates a second
provider seam, which is the exact failure AD-9/AD-20 exist to prevent; (2) AC3's "does not compile" needs the
`tsc` harness, which exists **only** in `packages/core/test/` (twice) and which story 1.3 explicitly reserved
for you; (3) AC6 says *"the invariant suite"*, and that suite is `packages/core/test/invariants.test.ts`; (4)
Tracks D, E and F must register profiles without editing Track B's files, and `@telar/core`'s barrel is the
one import surface all of `apps/web` already reaches (`exports` is `{".": "./src/index.ts"}`). The **spec
builders** stay in `apps/web/lib/session-profiles.ts` because they are `apps/web` vocabulary and because
story 2.2 will grow them into the MCP-server wiring that only `apps/web` has. *Rejected:* putting the whole
thing in `apps/web/lib/` — it would fork the provider seam, put the type-level proof in the workspace with
the `mock.module` contamination defect (§5.6 T-7), and make D/E/F's seam a deep import into another app.

**D1 — Two types, not one. `SessionProfileSpec` in, `SessionProfile` out.** This is what makes AD-10
structural rather than aspirational: an author writes a **spec**, and only the resolver can produce a
**profile**.

```ts
// What a surface AUTHORS. Note what is NOT here: no `guardrails` (a spec may only
// ADD restriction — D4), no `cwd` (the context supplies it — see below), and no
// field of any kind that could reach hook registration (D12 pins that).
export type SessionProfileSpec = {
  readonly kind: SessionKind;
  readonly settingSources: readonly ProfileSettingSource[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly toolPolicy: ToolPolicy;
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly systemPromptAppendix?: string;
  readonly addDisallowedTools?: readonly string[];
  readonly addProtectedPaths?: readonly string[];
};

// What the RESOLVER returns — AD-9's seven config fields, all folded, PLUS `kind`.
// Eight in total, and the distinction is load-bearing for INV-6a's pin: `kind` is
// the REGISTRY KEY, not session configuration, so it can carry no grant. Pin all
// eight; describe them as "AD-9's seven plus the registry key", never as "seven".
export type SessionProfile = {
  readonly kind: SessionKind;
  readonly cwd: string;
  readonly guardrails: ProjectManifest["guardrails"];   // manifest ∪ spec additions
  readonly settingSources: readonly ProfileSettingSource[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly toolPolicy: ResolvedToolPolicy;              // already intersected
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly systemPromptAppendix: string;                // "" when none — no undefined at the seam
};
```

`SessionResolutionContext` carries what the pre-stream preamble already holds:
`{ kind, provider, manifest, project?, role?, loomId?, permissionMode }`. **`cwd` comes from the context**
(`manifest.root`), not from the spec, so in this story no profile can redirect it. *Forward note for epic 5:*
AD-9's master profile needs `cwd: TELAR_HOME/workspace/home`, so that story adds an optional `cwd` to the
spec — and it must reach the state root through an owning module's exported port, not by composing a path
(D2). Say so in the port's header so epic 5 does not have to rediscover it.

*Rejected: a branded/nominal `SessionProfile`* (`declare const brand: unique symbol`) to make hand-construction
impossible. Core has **no** branded-type precedent — grepped, zero `unique symbol`, zero `__brand`, zero
phantom type params — and the house mechanism for "this cannot be expressed" is the enumerable union
(§5.4-B). It is also unnecessary: `toolPolicy` is the *only* tool-granting field, and its own type forbids
widening whether or not the enclosing object was minted by the resolver. Do not introduce the brand. Record
in your Completion Notes that it was considered and why it was declined, so 2.2 does not re-open it.

**D2 — The resolver is PURE and composes no path off the state root.** No `node:fs`, no `node:os`, no
`node:path`, no `telarDir()`, no `TELAR_HOME` read. Three reasons: (1) `INV-3a` pins the `TELAR_HOME`
path-composition inventory at **exactly 18 sites** and a nineteenth **fails it** — and §0 rule 6 forbids
quarantining your own new code; (2) the project's Design Law: *"Scheduling/repair/escalation decisions are
**pure functions**… Push all non-determinism (clocks, randomness, model calls) to injected seams"*; (3) a
pure resolver is testable with no sandbox at all, which is why §5.4-D tells you you probably need no
`TELAR_HOME` block. Everything path-shaped arrives in the context, already resolved by the caller.

**D3 — Intersect-only, by the type, plus a runtime intersect.**

```ts
// MOAT: this type cannot express "grant a tool the base policy denies". `allow`
// is keyed to the BASE union, so a name outside it is not assignable; `deny` may
// name anything, because denying more is always safe; and there is no third
// field. AD-10 — "it may deny more, never grant more — enforced by its type,
// which carries deny lists and allow-narrowing only." The alternative that was
// rejected in the spine is review: "'we will review for it' is not a mechanism."
export type ToolPolicy = {
  readonly deny: readonly string[];
  readonly allow?: readonly BaseAllowedTool[];
};
```

The fold intersects **again** at runtime — `effectiveAllow = (spec.allow ?? BASE_ALLOWED_TOOLS).filter(t => BASE_ALLOWED_TOOLS.includes(t) && !deny.includes(t))` —
so an `as` cast, a `JSON.parse`, or a future zod boundary cannot widen either. Two independent enforcements
of one rule is AD-1's own doctrine (*"enforced twice"*) applied one level down; say so in the comment.
**`deny` always wins over `allow`**, matching the SDK's documented guarantee that *"a disallow always wins
over any allow rule"* (the route's own comment at `≈:1223-1226`). `ResolvedToolPolicy` is
`{ readonly allow: readonly BaseAllowedTool[]; readonly deny: readonly string[] }` — both non-optional, so a
consumer never has to interpret `undefined`.

**`BASE_ALLOWED_TOOLS` is measured, not invented** (T-A0). Today's route builds, for a non-escalation Claude
session: `"Read", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch", ...LOOM_AUTO_TOOLS, ...ULTRA_AUTO_TOOLS`
(`≈:1242-1271`). `LOOM_AUTO_TOOLS` and `ULTRA_AUTO_TOOLS` are `apps/web/lib` constants, so core cannot import
them (it would invert the dependency). **Resolution:** `BASE_ALLOWED_TOOLS` holds the six harness tools core
can name for itself, and MCP-tool names enter through a spec's `allow` **only if** they are in the base
union — which they are not, and must not be, in this story. So in 2.1 a spec's `allow` narrows the six, and
the MCP tool names stay exactly where they are, in the route. **Record this as the deliberate seam it is**:
2.2, which owns the migration, is where `LOOM_AUTO_TOOLS`/`ULTRA_AUTO_TOOLS` join the base union — either by
moving those constants into core or by parameterising the base set. Do not do it here; doing it here means
touching `apps/web/lib/loom-mcp.ts`, which is not in your write set.

**D4 — `guardrails` unions; it never replaces.** A mis-authored profile handing back
`{disallowedTools: [], protectedPaths: []}` would *widen* access, and AD-10's promise is that no field can.
So the spec has **no** `guardrails` field at all: it has `addDisallowedTools` / `addProtectedPaths`, and the
resolver returns `manifest.guardrails.disallowedTools ∪ spec.addDisallowedTools` (deduplicated, order
stable: manifest entries first). The field **names** carry the guarantee, which is the cheapest form of it.
Reuse the existing type — `ProjectManifest["guardrails"]`, which is
`{ disallowedTools: string[]; protectedPaths: string[] }` from `schemas.ts` — do not redefine the shape
(NFR-RF-1, and AD-6's "zod schemas for persisted entities are owned by `@telar/core` and never redefined").

**D5 — `settingSources` excludes `"user"`, by type.** The SDK's `SettingSource` is `'user' | 'project' | 'local'`.
The route deliberately passes only `["project", "local"]`, and its comment says why: user-level settings stay
out *"on purpose (keeps the developer's personal config/tokens out of the subprocess)."* A profile that could
re-add `"user"` would undo that decision as config. So:

```ts
// `user` is excluded BY TYPE, not by convention. The route's own comment records
// the decision: user-level settings stay out so the developer's personal
// config/tokens never reach the subprocess. A profile field that could re-add it
// would turn that decision into a setting — the same degradation AD-10 forbids
// for tool grants. Same utility-type family as critic.ts's Omit<> and lease.ts's
// Pick<>.
export type ProfileSettingSource = Exclude<SettingSource, "user">;
```

Note honestly, in the same comment, that `settingSources: ["project", "local"]` **still** lets a repo's own
`settings.local.json` widen its access (the route's comment spells this out), and that the mechanism holding
against it is `disallowedTools` — which is why D3's fold always feeds `deny` through. That is a real,
documented, accepted trust decision; do not pretend the type closes it.

**D6 — `mcpServers` is a name-keyed `Record`, not an array.** AD-9 writes `mcpServers[]`. The SDK, the route
(`mcpServers: { loom: …, ultra: …, ...resolveProjectMcpServers(project) }`, `≈:1302`) and core's own
`resolveProjectMcpServers(projectName): Record<string, SdkMcpServerConfig>` all use a **name-keyed record**,
because the SDK requires the server *name* as the key. Converting to an array and back would be pure
ceremony that loses the keys, and a record also makes duplicate names structurally impossible (later key
wins — exactly what the route's spread already does). Read `mcpServers[]` as "the set of MCP servers", which
a name-keyed record is. **Record this deviation explicitly in your Completion Notes**, because a reviewer
holding the AC text will notice, and an undisclosed deviation reads as an error.

**D7 — `ProviderCapability`: measured from the Codex fork, never invented.** There is **no** capability
notion in the tree today. Every member must trace to a real divergence you can point at. The evidence is the
`runCodexTurn` argument list at `≈:931` versus the `query()` options at `≈:1172-1324`. The measured set:

| Capability | Claude | Codex | The measured evidence |
| --- | --- | --- | --- |
| `mcp-servers` | ✅ | ❌ | `runCodexTurn` has no `mcpServers` argument. `brownfield.md`: *"`runCodexTurn` has no MCP plumbing."* This is AD-11's own binding example (*"Codex MCP gap"*) |
| `pre-tool-use-hooks` | ✅ | ❌ | `hooks: { PreToolUse: … }` exists only on the Claude branch. The route's comment: *"No hooks/permissionMode (those are Claude SDK concepts)"* |
| `tool-allow-deny-lists` | ✅ | ❌ | `allowedTools`/`disallowedTools` are Claude-only options; Codex uses `sandbox` + `approvalPolicy` |
| `setting-sources` | ✅ | ❌ | `settingSources: ["project", "local"]` is Claude-only |
| `system-prompt-append` | ✅ | ❌ | `systemPrompt: { type: "preset", preset: "claude_code", append: … }` is Claude-only |

**Publish `interactive-approval` for BOTH** if you name it at all: Codex genuinely has it, via
`onCodexApproval` reusing `createPending`/`resolvePending` and the same permission-card SSE contract. A false
divergence here is worse than a missing capability — it would 400 a session that works today. **Re-measure
the whole table** before you commit to it; if the fork has moved, the table is wrong and your measurement
wins.

**D8 — The gate: a pure checker in core, the 400 in the route.** `unmetCapabilities(profile, providerId): readonly ProviderCapability[]`
— pure, returns the missing names, **never throws**, and knows nothing about HTTP. The route turns a
non-empty result into the existing pre-SSE 400. Two reasons: a thrown error crossing into a route handler
needs a `try/catch` the surrounding code does not use for this class of failure, and AD-11 says the failure
*"matches the route's existing pre-SSE 400"* — so it must be shaped by the route, which owns that response
vocabulary. The message names the profile kind, the provider, and every unmet capability, in the register of
the existing 400s (a sentence a human reads, ending in a period).

**D9 — The exact insertion point, and why it is there.** In the currently-empty window between
`const workspace = manifest.root;` (`≈:478`) and `const abort = new AbortController();` (`≈:485`) —
i.e. `≈:479-484`.

- **Not earlier:** the resolver needs `provider` (`≈:408`) and `manifest.root` (`≈:478`). Everything it wants
  becomes available only from `≈:408` onward, so it cannot be hoisted above the existing project/account 400s
  without duplicating their lookups. Reordering a validated 400 sequence in a file this story must barely
  touch is how AC5 gets broken.
- **Not later, for two independent leak reasons.** It must precede `registerChatRun(runId, abort)` (`≈:486`),
  whose only cleanup is `endChatRun(runId)` **inside the stream's `finally`** (`≈:1905`) — a 400 returned
  after it leaves a registered run with no stream to end, which `POST /api/chat/stop` would later try to
  abort. And it must precede `titlePromise = … generateTitle(message, profile, abort.signal)` (`≈:499-500`),
  which **spawns a real subprocess** that is likewise only awaited or aborted inside that same `finally`
  (`≈:1832-1839`, `≈:1896`) — a 400 after it orphans a live subprocess with no cleanup path. Both hazards
  point at the same window. This ordering is load-bearing, not cosmetic; say so in the in-source comment.
- **Not inside the stream:** `new ReadableStream({` at `≈:503` **is** the route body — everything from there
  to `≈:1913` is the SSE `start(controller)` closure, and once it begins, a failure can only become an SSE
  `error` event (`≈:1659-1660`), **never a status code**. AC1 is a claim about being before it, and `INV-6c`
  checks it mechanically.

**D9b — What is knowable pre-stream, and why that is safe.** This is the constraint most likely to bite you,
and it is measured. `existingChat` (`getChat(resumeTarget)`, `≈:568`) and `loomLink` (`≈:577-603`) are derived
**inside** the stream closure, so a pre-stream resolver **cannot see a resumed session's persisted `role` or
`loomId`**. Consequences, in order:

- `isPlannerSession` is `role === "planner" || existingChat?.role === "planner"`, and `isSteererSession` reads
  `loomLink.role`, which also folds in `existingChat?.role`. So a **resumed** planner or steerer session whose
  client omits `role` on the wire resolves pre-stream as kind `project`. That is **under**-detection.
- Under-detection is the **safe** direction, and it is why the gate cannot false-positive: kind `project`
  requires **no** capability (D11), so a session that should have been `planner` gets a *weaker* requirement,
  never a spurious 400. Assert that direction as a named test — it is the reason this design is safe to ship
  additively.
- `escalation` is the one kind that **is** reliably knowable pre-stream, and the route says why in as many
  words: the client *"sends it on every turn including reattached ones."* So `role === "escalation"` on the
  wire is sufficient for the capability gate — you do **not** need the validated `loomLink.loomId`, because a
  Codex account cannot run an escalation session whether or not that id resolves.
- **Do not hoist `getChat` into the preamble to fix this.** That is a real store read added to the hot path
  and it changes the pre-stream sequence — 2.2's call, made when it migrates the kinds for real. Record the
  constraint in the port's header and in your Completion Notes so 2.2 inherits the analysis instead of
  re-deriving it.

**Name the variable `sessionProfile`.** `profile` in this scope is an `AccountProfile` (`≈:377`) that feeds
`accountEnv(profile)`, `accountHealth(profile)`, `generateTitle(message, profile, …)` and
`upsertChatStub({ account: profile.name, … })`. Shadowing it is a silent billing bug. See §5.6 T-1.

**D10 — The catalogue is a registry, modelled on `declareEvents`.** WORK-SPLIT gives Tracks D, E and F
`a SessionProfile` as their **seam** and gives them no write access to Track B's files — so adding a kind
cannot require editing the resolver. That rules out a `switch` and a `Record<SessionKind, Builder>` table
(both of which live in a file D/E/F may not touch). Mirror `event-bus.ts` exactly, because it is the same
shape and story 1.2 already paid for the design:

- `registerSessionProfile(kind, builder)` — throws on a duplicate kind, in the `event-bus:` message register.
  A duplicate is a real collision, not a last-writer-wins convenience.
- `resolveSessionProfile(ctx)` — throws on an unregistered kind, with a message naming what **is** registered
  (`event-bus.ts`'s `cannot ${verb} "${name}" — no module declared it` is the model).
- `resetSessionProfiles()` — exported **for tests**, exactly as `resetBus()` and `resetAdmission()` are, and
  for the same measured reason: **bun runs every test file in one process**, so a module-scope registry
  leaks between suites. Call it in `beforeEach`. Story 1.3's T-B0 mandates exactly this for the bus and
  admission; story 1.2's Dev Notes carry the underlying finding, in its module-singleton passage (*"the bus's
  registry are module singletons. `bun test` runs every file in one process, so state leaks across files.
  Every new suite resets in `beforeEach`"*).
- **`SessionKind` stays a closed union** even though registration is open. A new kind adds a union member
  (one line, in core) *and* registers its builder (in the owning track's own file). That is the honest
  split: the *type* is a contract core owns; the *data* is the surface's. Note it in the header so epic 5
  does not read the union as an obstacle.

**D11 — The four kinds, their specs, and the one disclosed behaviour change.** The four that exist today,
named from the route's own vocabulary (`role` on the wire is `"planner" | "steerer" | "escalation" | undefined`):

| `SessionKind` | What it is today | `requiredCapabilities` | Why |
| --- | --- | --- | --- |
| `project` | The default session; no `role` on the wire | **none** | AC5. A project session must keep working on **both** providers — 2.2's AC3 requires identical behaviour on Claude *and* Codex. Assert this as a named test on both provider ids |
| `planner` | `isPlannerSession` (`≈:611`) — appends `PLANNER_SYSTEM_PROMPT` | `system-prompt-append` | The flag *"Drives ONLY the appended system-prompt guidance… never loom tool access/gating"* (the route's own comment), so the appendix **is** the whole kind. On Codex there is no `systemPrompt` option at all, so a planner session there silently becomes a plain session — textbook AD-11 silent degradation. **Deliberately NOT `mcp-servers`:** the same comment says the flag never touches tool access, and requiring it would gate a kind on something it does not use |
| `steerer` | `isSteererSession` (`≈:615`) — appended prompt + live-context block | `system-prompt-append` | Same reasoning, same comment (*"never loom tool access/gating (which stays exactly as wired)"*). The appendix plus its live-context block is the distinguishing content, and it is exactly what Codex drops |
| `escalation` | `isEscalationSession` (`≈:626`) — read-only loom toolset + the `answer_blocked`-only write path | `mcp-servers`, `pre-tool-use-hooks`, `tool-allow-deny-lists` | Provably impossible on Codex: the fork at `≈:859` returns before `createLoomMcpServer` (`≈:1137`) is ever reached, so there are **no loom tools at all**, and `answer_blocked`'s human gate is a `PreToolUse` comparison that does not run. An escalation session on a Codex account is non-functional today and says nothing about it |

**The disclosed behaviour change — three kinds, and it is reachable today.** After this story, a request for
an `escalation`, `planner` or `steerer` session on a **Codex** account returns a 400 instead of a 200 that
silently drops the thing that made it that kind of session. **That is the point** — AD-11: *"No silent
degradation, ever."*

**It is genuinely reachable, so measure it rather than assuming it is theoretical.** There is no code-level
restriction stopping a Codex account from being selected for a planner session: the provider selector in
`apps/web/components/session/session-view.tsx` (`setProvider`) is unrestricted, and the loom-plan route
(`apps/web/app/looms/plan/[project]/page.tsx` → `SessionView`) imposes none either. **Re-derive that by grep
before you commit** — if a restriction has since been added, the behaviour change evaporates for that kind and
your measurement wins over this paragraph.

Three obligations follow: (1) this is **not** covered by AC5, which scopes "untouched" to the
*project-session* path — so **do not weaken the capability set to avoid it**; (2) **disclose it in your
Completion Notes with the measurement**, exactly as story 1.1 disclosed its AC6 cross-track finding; (3) if
you conclude a different capability set is right for any kind, the table above is what a reviewer will check
against, so **state your reasoning and your measurement** rather than silently substituting values.

`systemPromptAppendix`: the name is honest, and the route's shape is why — `systemPrompt` is **always**
`{ type: "preset", preset: "claude_code", append?: string }`, so `append` is *never* a replacement for the
SDK's preset text, only additive (`≈:1187-1211`, a four-way precedence chain: escalation, else steerer, else
planner, else the bare `ultraAnnotationNote`). A field that could *replace* the preset would be a widening of
exactly the kind AD-10 forbids; `Appendix` is the guarantee in the name. `planner`'s value is a pure function
of the context (the static `PLANNER_SYSTEM_PROMPT` plus `ultraAnnotationNote`), so it can be supplied now.
`steerer`'s and `escalation`'s embed **per-turn live reads** (`buildSteererContext(loomId)`,
`buildEscalationContext(loomId, workspace)`) that happen inside the stream body — so leave those `""` in 2.1
and **record that 2.2 supplies them** once those reads are hoisted. Do not hoist them here; that is a
behaviour change inside `new ReadableStream`, and AC5 forbids it.

**D12 — `INV-6`, and what it can honestly assert.** AC6 says *"the invariant suite"*, so it goes in
`packages/core/test/invariants.test.ts`. Four tests, in the file's own idiom:

- **`INV-6a` — the field inventory is exact.** Extract `SessionProfile`'s and `SessionProfileSpec`'s
  declared field names from `session-profile.ts` and assert each equals its pinned set — **eight** for
  `SessionProfile` (AD-9's seven config fields plus `kind`, the registry key), and D1's list for the spec.
  Adding a field fails here, which is what makes it a deliberate act. The message names AD-10, the rule, the
  consequence (*a profile field that reaches hook registration turns the moat from structural into
  configurable*), and the next step (*if the field is legitimate, add it here with a comment saying why it
  cannot widen a grant*).
- **`INV-6b` — `ToolPolicy` has exactly `deny` and `allow`, and `allow`'s element type is the base union,
  not `string`.** A scan, plus the executable citation of `INV-6`'s compile pins (below).
- **`INV-6c` — the route resolves before the stream opens.** In `route.ts`: the index of
  `resolveSessionProfile(` is `>= 0`, the index of `new ReadableStream(` is `>= 0`, and the first is **less
  than** the second. This is AC1's ordering, made mechanical. Also assert the route calls
  `unmetCapabilities(` and that its index likewise precedes `registerChatRun(` (D9).
- **`INV-6d` — the scan DISCRIMINATES.** In-memory fixtures through the same extractors: a `SessionProfile`
  declaration carrying a `hooks` field **is** reported; a `ToolPolicy` whose `allow` is `readonly string[]`
  **is** reported; a correctly-shaped declaration is **not**. Assembled at runtime, never as literal source
  (§5.4-E).

Plus a **floor** before all of it: the extractor found both type declarations and a non-trivial field count.
Plus **executable citations** in `INV-2h`'s style — assert by title that
`packages/core/test/session-profile.test.ts`'s compile-pin tests still exist, so a rename fails here instead
of rotting silently. **What `INV-6` deliberately does NOT assert:** that the compiler rejects a widening —
that claim needs the compiler, it lives in `session-profile.test.ts`, and duplicating it here would double
`invariants.test.ts`'s runtime against its own 2000 ms AC3 budget for no new signal. Say so in-source, in the
register `INV-2`'s header uses for the same decision.

**Amend the file's header.** It opens `THE FIVE LOAD-BEARING INVARIANTS, MADE EXECUTABLE` and enumerates
exactly five. Add a paragraph: AD-19's five are the ones **AD-19 names**; `INV-6` defends **AD-10**, and it
lives here because story 2.1's AC6 requires the invariant suite to assert it. An unamended header is a header
that lies, which is the drift the citation policy exists to stop.

**D13 — Keep the SDK out of the compile fixture.** The intersect-only pin needs only `ToolPolicy` and
`BASE_ALLOWED_TOOLS`. Import **just those** in the fixture, so the throwaway program never has to resolve
`@anthropic-ai/claude-agent-sdk` and the simple `typecheck()` form (no `--types node`, no `cwd`) suffices.
`event-bus.test.ts`'s header states the same technique for zod: *"The fixtures never import zod themselves…
so they compile from a throwaway directory with no node_modules of its own."* If you must widen the fixture's
imports, take `session-lease.test.ts`'s `--types node` + `cwd: CORE_ROOT` variant **verbatim** and record why.

**D14 — Prove-run leg L6, and one command for all six.** `SPEC.md`'s success signal is **one scripted run**
proving every port serves a consumer. Story 1.3 delivered L1–L5 in
`packages/core/test/track-a-prove-run.test.ts`, whose one-command form is
`TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-a prove-run"`. Yours is L6:

> **L6** a profile declaring a capability the provider port does not publish fails **before the stream
> opens** — the checker names it, and the route's call site provably precedes `new ReadableStream`

It lives in **your** file, `packages/core/test/session-profile.test.ts`. **Do not edit
`track-a-prove-run.test.ts`** — it is story 1.3's deliverable and its header is pinned prose; a Track B leg
appended to a file titled "Track A" is worse than two commands.

**Make the filter select all six.** Title your describe block so a shared substring matches both files —
`-t "prove-run"` should select `"track-a prove-run …"` **and** `"prove-run L6 …"`. **Measure it**; do not
assume bun's `-t` semantics. Report the selected count and confirm it is exactly six. If the filter drags in
unrelated tests or misses a leg, **disclose two commands** instead — one per track — and say why. A faked
single command is worse than an honest pair.

**The `packages/core` path argument is mandatory, not decoration.** A repo-root `bun test -t "<filter>"`
evaluates every file's module scope before running any test, so the process-global
`mock.module("@telar/core", …)` installed at module scope by `apps/web/lib/loom-mcp.answer-blocked.test.ts`
and `apps/web/lib/loom-mcp.remint.test.ts` is never restored and stays live inside every core suite. This is
a **pre-existing cross-track defect**, recorded in `deferred-work.md`, owned by nobody yet, and it is why
**every prove-run command in this story carries a path argument**. §5.6 T-7.

**L6's honest scope.** It cannot open a real stream, so it proves the two halves that are provable in one
process: the checker returns the unmet name, and the route's source orders the call before
`new ReadableStream` (citing `INV-6c` rather than re-running it). The human-visible 400 is §6.3's `curl`,
captured in the Debug Log. State that scoping in the leg's own comment — an over-claimed prove-run is worse
than a scoped one.

### 5.6 Traps

- **T-1 — `profile` is already taken, and shadowing it breaks billing.** `apps/web/app/api/chat/route.ts`
  binds `let profile: AccountProfile` at `≈:377` and then uses it for `accountEnv(profile)`,
  `accountHealth(profile)`, `generateTitle(message, profile, abort.signal)` and
  `upsertChatStub({ account: profile.name, … })`. A `const profile = resolveSessionProfile(…)` in the same
  scope is a redeclaration error at best and a mis-attributed spend record at worst. **`sessionProfile`.**
- **T-2 — `INV-3a` will fail if your module composes a state path.** The inventory is pinned at exactly 18
  entries with an exact-equality assertion. A nineteenth site fails, and its own message tells you the fix is
  *"reach the subtree through the owner's exported port"* — **not** to add an entry, and not to quarantine.
  D2 is how you avoid the situation entirely.
- **T-3 — `INV-1g` pins the route's moat wiring by literal.** It requires the route to import
  `LOOM_START_TOOL` and `LOOM_ANSWER_BLOCKED_TOOL` from `@/lib/loom-mcp`, to contain
  `input.tool_name === LOOM_START_TOOL` (and the sibling), to match
  `/hooks\s*:\s*\{\s*PreToolUse\s*:/`, and to contain the literal `preToolUseGuardrail`. Reformatting the
  hook literal, renaming the guardrail, or "tidying" the imports **fails the moat invariant**. Touch none of
  it.
- **T-4 — bun runs every test file in ONE process, and your registry is a module singleton.** Without
  `resetSessionProfiles()` in `beforeEach`, a duplicate-registration throw from one suite takes down another,
  and the order is not stable. `resetBus()` and `resetAdmission({})` exist for exactly this and are called in
  `beforeEach` throughout story 1.3's prove-run. Do the same.
- **T-5 — `invariants.test.ts` will match itself.** It contains the literals it searches for and
  `packages/core/test` is one of its own scan roots. The resolution is already in the file and is **two
  rules, not one**: floors over the **whole** index; violation sets over a **filtered** scope that excludes
  `*.test.ts`. Do not collapse them, do not "fix" the exclusion, and pass every discriminator fixture as an
  **in-memory string built at runtime**.
- **T-6 — control characters in source.** Three stories running have shipped NUL bytes by editing slip —
  1.1's `usage-ledger.ts` ("a 263-line module binary to git and invisible to grep"), 1.2's `admission.test.ts`,
  and 1.3's own `invariants.test.ts` during its fix pass, where `file(1)` reported
  `application/octet-stream` and `grep` skipped it as binary. **Byte-check every file you write** before you
  stage it, and put the command and its output in the Debug Log.
- **T-7 — never run a filtered prove-run bare from the repo root.** `TELAR_HOME=$(mktemp -d) bun test -t "prove-run"`
  from the root leaves `@telar/core` stubbed inside every core suite (the `mock.module` defect above). Always
  pass a path. `deferred-work.md` names the three suites and states precisely which two reproduce the symptom.
- **T-8 — `@ts-expect-error` in a core test proves nothing.** `packages/core/tsconfig.json` excludes `test`,
  measured. The gate never compiles your test file, so the directive is never checked and a *removed* type
  error goes unnoticed. Run the compiler (§5.4-C) or you have not met AC3.
- **T-9 — a required field on `ProviderDescriptor` must be added to both `PROVIDERS` entries in the same
  edit**, or `cd packages/core && bunx tsc --noEmit` fails and — because the barrel re-exports it —
  `cd apps/web && bunx tsc --noEmit` may fail too. Both must be clean. Verified: `ProviderDescriptor` is
  constructed only by `PROVIDERS`; re-verify by grep before relying on it.
- **T-10 — do not let the port become client-reachable by value.** `INV-4` walks value edges transitively
  from every `"use client"` file. A client component may `import type { SessionProfile }`; a **value** import
  of anything in `@telar/core` from a client-reachable module fails `INV-4c` and, per its message, *"drags
  async_hooks into the browser, breaking the build."* You are not adding a component, so the way this bites
  is a stray helper — keep the port out of anything under `components/`.
- **T-11 — `resolveProjectMcpServers` reads the manifest from disk.** It is `Record`-returning and it is
  core's, but it performs I/O (`getProject`). If a spec builder ever wants project MCP servers, the **route**
  calls it and passes the result in — the resolver stays pure (D2). In 2.1 no spec needs it.
- **T-12 — a zod schema would silently destroy AC3.** `z.array(z.string())` parsed back out is `string[]`,
  which is exactly the widening `ToolPolicy` exists to forbid. §3's fence and §5.4-H. If a later story needs
  to persist a profile, it persists the **spec's inputs**, never the resolved policy.
- **T-13 — do not "fix" a pre-existing violation you discover.** Story 1.3's §0 rule 4 in its general form:
  you are adding a seam, not repairing the tree. Record it in `deferred-work.md` with a file-and-symbol
  citation and move on.
- **T-14 — do not gate on something you cannot see pre-stream.** `existingChat` and `loomLink` are derived
  **inside** the stream closure, so the resolver cannot know a resumed session's persisted `role`. If you gate
  a capability on a kind you can only detect *sometimes*, you get a 400 that depends on whether the client
  happened to resend `role` — a non-deterministic failure, which is worse than no gate. D9b is the analysis:
  gate only on what the wire reliably carries, and let under-detection fall to `project`, which requires
  nothing.
- **T-15 — measure the counts; do not quote this file's.** `1835 pass / 118 files / 107 core test files` are
  the figures at `b44d9b5`. `project-context.md` is explicit that counts *"go stale silently"* and that the
  core figure moved *while the sentence describing it was being written*. Re-measure your baseline **before**
  you write a file, and your final **after**.

---

## 6. Testing requirements

### 6.1 The rules this story exists under

- **`bun test` (`bun:test`) is the only test tooling.** No jest, no vitest, no Playwright (Playwright in this
  repo is Verifier infrastructure; there is no `playwright.config.*` and no human-authored `*.spec.ts`).
- **Core specs live in `packages/core/test/`, flat, no subdirectories, no helper modules.** 107 files at
  `b44d9b5`. Web specs colocate beside the module they cover, under `apps/web/lib/`.
- **There is no CI.** The gate is the manual trio: `bun test`, `bunx tsc --noEmit` (**both** workspaces),
  `bun run lint` (`apps/web`). `bun run lint` is **not** a clean baseline — ~77k pre-existing problems, most
  under `.next-desktop/` build output — and is *"not this SPEC's to fix."* Run it, say so, do not chase it.
- **`ultra-runner.test.ts` must stay byte-identical.** NFR-RF-8 pins its `peak === 4`.
  `git diff --stat -- packages/core/test/ultra-runner.test.ts` → empty.
- **No message argument to `expect`.** Measured across all core suites: it is not the house idiom. Build the
  diagnosis **into the asserted value** so the diff bun prints *is* the message. Each carries, in order: the
  AD id, the rule in one clause, the consequence if it is false, and the actionable next step.

### 6.2 How to prove discovery

Passing when pointed at directly is **not** evidence. Two mechanisms, both required, for **both** new test
files:

1. **The repo-wide count moved.** Record `ls packages/core/test/*.test.ts | wc -l` before and after — the
   delta must be **exactly 1** (`session-profile.test.ts`; `invariants.test.ts` already exists). Record
   `ls apps/web/lib/*.test.ts | wc -l` before and after — delta **exactly 1**
   (`session-profiles.test.ts`). Record the repo-root `bun test` tail including `Ran N tests across M files` —
   **M must have grown by exactly 2**, and N by the number of tests you added. A flat M with a grown N is
   impossible; a flat M **and** a flat N means your tests are invisible and the gate is lying to you.
   (`apps/web`'s own `bun test` reports one more file than the flat `lib/*.test.ts` glob, because of the
   nested `lib/gallery-fixtures/fixtures.validate.test.ts` — expect **12**, not 11, after your file lands.)
2. **By name, from the junit reporter.**
   `bun test --reporter=junit --reporter-outfile=<scratch>/discovery.xml`, then `grep -F` for **every new test
   name** and show the `file=` attribute. Plus at least one `bun test -t "<name>"` spot check per new suite,
   showing the `across M files` line. Plus one **negative control**:
   `bun test -t "a name that does not exist zzz"` → `matched 0 tests`, exit 1 — so the reader knows your
   positive results mean something.

### 6.3 What the Debug Log must contain

Paste **real command output**, not a description of it. A summary of a run you did not paste is the failure
mode this section exists to prevent.

- [ ] `git diff --stat -- bunfig.toml` → **empty** (§0 rule 5).
- [ ] `git diff --stat -- packages/core/test/ultra-runner.test.ts` → **empty** (NFR-RF-8).
- [ ] `git diff -- apps/web/app/api/chat/route.ts` → the **whole** diff. It must contain no hunk inside
      `new ReadableStream` and no change to the `hooks:`/`preToolUseGuardrail`/`canUseTool` region (AC2, AC5).
- [ ] `git diff --stat -- apps/web` → only `route.ts` and the new `lib/session-profiles.ts`.
- [ ] **T-A0's measurements**, verbatim: today's `allowedTools`, `disallowedTools`, `settingSources`, the
      `runCodexTurn` argument list. These are the evidence base for D3 and D7 and a reviewer will check them.
- [ ] Baseline vs. final `ls packages/core/test/*.test.ts | wc -l`. Delta **exactly 1**.
- [ ] Baseline vs. final `ls apps/web/lib/*.test.ts | wc -l`. Delta **exactly 1**.
- [ ] Repo-root `bun test` — full tail including `Ran N tests across M files`. **M grown by exactly 2.**
- [ ] The junit run + a `grep -F` hit for **every** new test name, showing `file=`.
- [ ] One `bun test -t "<name>"` spot check per new suite, with the `across M files` line.
- [ ] The negative control (§6.2).
- [ ] **The three pins still green, each run by name and pasted:** `INV-1g`, `INV-3a`, `INV-3f`.
- [ ] **`INV-3f`'s premise unchanged:** `KNOWN_VIOLATIONS` still holds **exactly one** entry. Show it.
- [ ] **`invariants.test.ts`'s wall-clock**, before and after `INV-6`, against the **2000 ms** AC3 budget
      story 1.3 set. Its recorded figures: **335 ms for 38 tests** at first delivery
      (`Ran 38 tests across 1 file. [335.00ms]`), then **558 ms for 40 tests** after its review fix pass added
      `INDEX-4`/`INDEX-5`. So the budget is 2000 ms and roughly 1.4 s of it is already spent — measure the
      current baseline yourself before you add `INV-6`, and note that a single `tsc` spawn costs ~0.35 s, which
      is exactly why D12 keeps the compile pins out of this file. If you exceeded the budget, the cause is almost certainly a
      spawned process or a second tree walk — fix that, do not raise the threshold.
- [ ] **The AC3 compile pins**, all directions, with the real `tsc` diagnostic text for the failing fixture
      **and** the empty output for the passing one. Plus which `typecheck()` variant you used and why (D13).
- [ ] **The L6 transcript line**, verbatim, in the same register as L1–L5.
- [ ] **The prove-run command**, measured: the `-t` filter you chose, the selected count, and confirmation it
      is exactly six legs. If you disclosed two commands instead, both, with the reason (D14).
- [ ] **The dev-server 400**, captured verbatim. `TELAR_HOME=$(mktemp -d) bun run dev` in `apps/web`, then a
      `curl -i` POST to `/api/chat` selecting a profile whose capability the account's provider does not
      publish. Show the status line, the JSON body, and **that no `event:`/`data:` frame was written**. Note
      the `TELAR_HOME` override: the dev script already defaults to `~/.telar-dev`, and an explicit temp root
      is belt-and-braces (§0 rule 4).
      **You do not need a real Codex login for this, and you must not fabricate the output if you lack one.**
      In the throwaway `TELAR_HOME`, `upsertAccount` a bare `{ name: "…", provider: "codex" }` with **no
      `configDir`** (via the port, never by hand-editing `accounts.json` — `project-context.md`).
      `accountHealth` returns `status: "unknown"` for any account without a `configDir` (measured:
      `packages/core/src/accounts.ts`, `accountHealth`'s first branch), and the route's account-health gate
      (`≈:398-406`) rejects only `missing-config-dir` and `never-logged-in` — so that account reaches your
      capability gate with no credentials involved.
- [ ] **The companion positive control for the same proof:** the identical `curl` against a **`project`**
      session on that same account **streams normally**. Without it, a 400 caused by the missing side-effect
      import (T-B1) is indistinguishable from a 400 caused by the capability gate — the failure would look
      exactly like success.
- [ ] **The revert probes**, one per new assertion class (§0 rule 7): break it, capture the **real** failure
      output, `git checkout --` it, and show `git diff --stat` empty afterwards. At minimum: `INV-6a` (add a
      `hooks` field), `INV-6c` (move the resolve call after the stream), the AC3 failing pin (widen `allow`
      to `readonly string[]`), and the capability gate (empty one provider's capability list).
- [ ] **The byte check** (T-6): a command proving no new file contains a NUL or stray control character, with
      its output.
- [ ] `cd packages/core && bun test` → pass/fail counts.
- [ ] `cd packages/core && bunx tsc --noEmit` → exit 0.
- [ ] `cd apps/web && bunx tsc --noEmit` → exit 0. **Both** workspaces.
- [ ] `cd apps/web && bun test` → green, with counts.
- [ ] `cd apps/web && bun run lint` — **not** a clean baseline. Say so and say why it is not yours.

### 6.4 Coverage the suites must actually carry

Every row is a named test. A row with no test is an unmet AC.

| # | What it proves | AC | Where |
| --- | --- | --- | --- |
| 1 | Each of the four kinds resolves to a profile carrying all seven fields, with D11's values | AC1 | `session-profile.test.ts` |
| 2 | The resolve call precedes `new ReadableStream` in `route.ts` | AC1 | `INV-6c` |
| 3 | `SessionProfile`'s and `SessionProfileSpec`'s field sets are exactly the pinned ones | AC2, AC6 | `INV-6a` |
| 4 | A spec's empty guardrail request still yields the manifest's `disallowedTools` and `protectedPaths` | AC2 | `session-profile.test.ts` |
| 5 | The union is a union: manifest entries **plus** spec additions, deduplicated, manifest first | AC2 | `session-profile.test.ts` |
| 6 | `route.ts`'s `PreToolUse` wiring is untouched | AC2 | `INV-1g` (run by name; do not duplicate it) |
| 7 | A fixture whose `allow` names a non-base tool **does not compile**, and the diagnostic names the tool | AC3 | `session-profile.test.ts` (`tsc`) |
| 8 | The same fixture with a base tool **does** compile, with empty output | AC3 | `session-profile.test.ts` (`tsc`) |
| 9 | `Equal<>` identity pin on `ToolPolicy` — adding a field breaks the compile | AC3 | `session-profile.test.ts` (`tsc`) |
| 10 | The compile pin **discriminates** — a wrong expectation really fails | AC3 | `session-profile.test.ts` (`tsc`) |
| 11 | The runtime fold intersects too: a cast-widened `allow` is filtered back to the base ∩ | AC3 | `session-profile.test.ts` |
| 12 | `deny` beats `allow` for the same tool name | AC3 | `session-profile.test.ts` |
| 13 | `unmetCapabilities` returns the missing names for a Codex escalation profile | AC4 | `session-profile.test.ts` |
| 14 | `unmetCapabilities` returns `[]` when the provider publishes everything required | AC4 | `session-profile.test.ts` |
| 15 | Both `PROVIDERS` entries publish a capability list, and Codex's is a strict subset of Claude's | AC4 | `session-profile.test.ts` |
| 16 | `interactive-approval` (if named) is published by **both** — the false-divergence guard | AC4 | `session-profile.test.ts` |
| 17 | The `project` kind requires **nothing**, on **both** provider ids | AC4, AC5 | `session-profile.test.ts` |
| 18 | L6: the prove-run leg, with its transcript line | AC4 | `session-profile.test.ts` |
| 19 | Registering a duplicate kind throws, with a message naming the collision | AC1 | `session-profile.test.ts` |
| 20 | Resolving an unregistered kind throws, with a message naming what **is** registered | AC1 | `session-profile.test.ts` |
| 21 | `resetSessionProfiles()` empties the registry (so T-4 is actually mitigated) | — | `session-profile.test.ts` |
| 22 | `ToolPolicy` has exactly two fields and `allow`'s element type is the base union | AC6 | `INV-6b` |
| 23 | The `INV-6` field scan **discriminates** on all three fixtures | AC6 | `INV-6d` |
| 24 | The `INV-6` extractor found both declarations — the anti-vacuity floor | AC6 | `INV-6` floor |
| 25 | `INV-6`'s citations of the compile-pin test titles still resolve | AC6 | `INV-6` |
| 26 | A context with no wire `role` resolves to kind `project` — under-detection, the safe direction (D9b) | AC4, AC5 | `session-profile.test.ts` |
| 27 | `role: "escalation"` on the wire resolves to kind `escalation` **without** a validated `loomId` (D9b) | AC4 | `session-profile.test.ts` |
| 28 | `systemPromptAppendix` is additive: the resolver never emits a value that could replace a preset | AC2 | `session-profile.test.ts` |
| 29 | Each of the four builders returns D11's exact `requiredCapabilities` and `systemPromptAppendix` | AC4, AC5 | `apps/web/lib/session-profiles.test.ts` |
| 30 | Importing `@/lib/session-profiles` populates the registry with all four kinds — the side-effect T-B1 depends on | AC1, AC5 | `apps/web/lib/session-profiles.test.ts` |

---

## 7. Previous story intelligence — what epic 1 cost, so it does not cost again

Epic 1 is **done**: `578e5b4`, `34379cf`, `b71402a`, `75d9b75`, `644c54a`, `b44d9b5`. Gate at `b44d9b5`:
**1835 pass / 0 fail across 118 files** (re-measure; do not quote). Three stories, four adversarial repair
rounds on the first alone. What that bought you:

### 7.1 The four maxims, verbatim, because each was paid for twice

1. **"A line number is not a name."** *"It identifies a slot in a file, and any edit above it hands that slot
   to something else"* — story 1.1's own citation policy, adopted in its Repair Round 3 after the **fourth**
   drift. `deferred-work.md`'s version of the same policy adds the operative half: *"Symbols survive edits;
   grep finds them."* This file obeys it; your Completion Notes must too.
2. **"Keys name events, not slots."** Story 1.1 redesigned an idempotence key **three times**, each redesign
   a new silent-money-loss regression, before landing: *"a billing key must be a unique id minted at the
   moment the money is spent, carried on the record, and never re-derived from position, order or count."*
   Nothing in this story mints a key — but if you add an identity of any kind, mint it at the moment of the
   thing.
3. **"A guard must read the same value as the thing it guards."** Story 1.1's Repair Round 4 blocking finding:
   `logUsage` guarded the **raw** `process.env.TELAR_HOME` while the write landed wherever `telarDir()`
   resolved — and `telarDir()` **trims first**. *"A green `bun test` run appended a synthetic billing line to
   the operator's REAL ledger — the one failure this whole story exists to prevent, defeated by the guard
   added to prevent it."* Generalised in 1.2: *"an invariant that scans for pattern X while production writes
   pattern X′ is a guard that does not guard."* This is why T-A0 makes you **measure** the base allow-list and
   the capability table instead of writing what you expect them to be.
4. **"A green test can assert nothing."** Story 1.1 shipped two load-bearing tests that used a seam production
   never produces (`child.attempts = [...]` where production `push`es), so the finding they guarded stayed
   green underneath them. *"Revert the fix, watch the test fail"* is now the house standard, executed as
   numbered probes P1–P7 in story 1.3's Debug Log. §6.3 requires yours.

### 7.2 From story 1.2 — three things that bind a new core module

- **No classes.** None of `admission.ts`, `event-bus.ts`, `runner/lease.ts` exports one. Plain functions, plus
  a factory returning an object literal of closures where a typed handle is wanted.
- **Injected seams last, with real defaults.** `writeLease(ownerDir, lease, now = Date.now, io = fs)`. Pure
  decision functions take **no** seams and receive an already-read `now: number`, not a clock. Your resolver
  is in the second category: it takes no seams at all.
- **Module singletons leak across suites** because bun uses one process. `resetBus()` / `resetAdmission()`
  exist for that, and `resetAdmission` **throws** when occupancy is non-zero rather than minting capacity — a
  review finding that measured *"8 concurrent model calls run against a ceiling of 4."* Your
  `resetSessionProfiles()` inherits the shape, not the throw (a registry has no occupancy to leak).
- **The admission residual is permanent.** `releaseAdmission(cls)` cannot detect a class mismatch and never
  will (it would break AC9). `INV-5f` guards the mitigation instead: nothing under `packages/core/src` other
  than `admission.ts` may call it. If you touch admission at all — you should not, AD-17 puts interactive
  sessions out of band — release through the handle.

### 7.3 From story 1.3 — the story that wrote the tests you must live inside

- **The anti-vacuity rule and the positive control** are that story's central lesson, in its own words: *"This
  is the single most important instruction in the file."* §5.4-E is the short form.
- **The self-reference hazard (T-13):** *"Your invariant suite will match itself, and this will be your first
  failure."* Floors over the whole index, violations over the filtered scope. §5.6 T-5.
- **The compile-time forward note, addressed to you.** Completion Note 15, verbatim: *"Forward note for story
  2.1 — do not re-derive the compile-time harness. Story 2.1's intersect-only `toolPolicy` ('it does not
  compile') **is** a compile-time invariant and must be proved by running the compiler, in **both**
  directions, over fixtures generated in a throwaway directory. The harness already exists twice… **A bare
  `// @ts-expect-error` in `packages/core/test/` is a comment wearing a test's clothes**… Budget: ~0.35 s per
  fixture, ~1.4 s per suite. This story added **no** `tsc` invocation, which is what keeps
  `invariants.test.ts` at 335 ms against a 2000 ms AC."* Story 1.3 spent nothing on `tsc` so that you could.
- **The `mock.module` cross-track defect** and the path-argument rule. §5.6 T-7.
- **Control characters, three stories running.** §5.6 T-6.

### 7.4 What is still open, and stays open

- Story 1.1's **five `[Review][Decision]` items** — all unresolved, all the human's. `bunfig.toml`'s
  `_bmad-output` exclusion is one of them and has now been fenced by three consecutive stories. Fence it a
  fourth time; do not resolve it.
- Story 1.2's `writeLease` fixed-temp-filename race — recorded, deliberately unfixed, not yours.
- Story 1.3's `composesStateFile` gap (S21, partially closed) and its twelve nice-to-haves — recorded, not
  yours.
- The **`sessions/` co-tenancy**: `packages/core/src/sessions.ts` and `apps/web/lib/session-log.ts` both write
  into `sessions/<sessionId>/`, recorded as a named fact in `AD5_OWNERS` with the comment *"epics 2 and 3 need
  to know."* You now know. Your resolver writes nothing there — D2 — so it stays a two-writer directory. **A
  third writer fails `INV-3b`.**

---

## 8. References

- `_bmad-output/planning-artifacts/epics.md` § "Story 2.1: The SessionProfile resolver" — the ACs verbatim,
  the dev-server-proof line, and the dispatch notes (including *"Three properties are the story, not the field
  list"* and *"Do not migrate the existing project session here"*).
- `_bmad-output/planning-artifacts/epics.md` § "Epic 2: Session Profiles", § "Story 2.2" (what you must leave
  for it, plus its own preservation warning about the `done` payload's `costUsd`), § "Requirements Inventory"
  (FR-RF-7, NFR-X-1/3/4/8/9/14/16, NFR-RF-1/4/5), § "Planning Decisions" (ultracode is the execution mode;
  ACs are Given/When/Then; this document is the source of truth).
- `.../architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md` §§ AD-9, AD-10, AD-11, plus AD-1,
  AD-3, AD-5, AD-6, AD-17, AD-19, AD-20 and the `Consistency Conventions` and `Stack` tables.
- `.../architecture/architecture-telar-2026-07-24/SOLUTION-DESIGN.md` — the ports-and-adapters law and
  *"Separate routes per session kind were rejected on exactly this ground: a moat enforced in three places has
  three chances to be forgotten."*
- `.../architecture/architecture-telar-2026-07-24/WORK-SPLIT.md` — Track B's row (`Owns`:
  `apps/web/app/api/chat/route.ts`, the profile resolver, Codex MCP injection; `Blocked by`: nothing), and
  D/E/F's `Extends via seam` column naming `a SessionProfile` — the constraint behind D10.
- `.../architecture/architecture-telar-2026-07-24/reviews/review-adversarial-seams.md` § A6 — the finding that
  produced AD-5's session-tree carve-out.
- `_bmad-output/specs/spec-runtime-foundations/SPEC.md` § CAP-7 (intent + success), § Assumptions (*"CAP-7
  lands in two moves"*), § Non-goals (Codex MCP injection; the field set beyond the named core), § Success
  signal. **Note the drift:** SPEC.md's success paragraph names five prove-run legs and does **not** name the
  `toolPolicy`-widening assertion; `epics.md` adds it as story 2.1's AC6 when it re-cuts the run across two
  stories. `epics.md` is the source of truth (planning decision 4). Record that you noticed.
- `_bmad-output/specs/spec-runtime-foundations/brownfield.md` § Track B — *"The gate is one expression"*,
  *"The surrounding state is already profile-ready"*, *"The fail-before-the-stream pattern already exists"*,
  *"`runCodexTurn` has no MCP plumbing"*, and the `toolPolicy` gap: *"correct by placement, not by a type that
  makes over-granting unrepresentable."*
- `_bmad-output/project-context.md` — the Human-Accept Moat, the Verifier capability wall, Design Law, the
  core↔web boundary, testing rules, and the standing warning that its counts are *"a smell test, not a fact."*
- `_bmad-output/implementation-artifacts/deferred-work.md` — the `mock.module` cross-track defect (three
  suites named, two reproducing), the `writeLease` race, story 1.3's open S21, and the file's own citation
  policy, which your own new entries must follow.
- `_bmad-output/implementation-artifacts/stories/1-3-…md` §§ 0, 3, 5.5-D8, 6.2, 6.3, Completion Notes 15/16 —
  the tsc forward note, the discovery-proof mechanisms, the Debug-Log checklist.
- `_bmad-output/implementation-artifacts/stories/1-2-…md` §§ 6.1, 7, Completion Notes 7/12/15.
- `_bmad-output/implementation-artifacts/stories/1-1-…md` — Repair Rounds 2/3/4 and the five open
  `[Review][Decision]` items.
- **Code:** `apps/web/app/api/chat/route.ts`; `packages/core/src/providers.ts`, `schemas.ts` (`ProviderId`,
  `AccountProfile`, `ProjectManifest.guardrails`), `mcp.ts` (`resolveProjectMcpServers`), `admission.ts`,
  `event-bus.ts`, `runner/lease.ts`, `critic.ts` (the `Omit<> &` precedent), `index.ts`;
  `apps/web/lib/permissions.ts` (`makeGuardrailDecision` — read-only), `apps/web/lib/loom-mcp.ts`
  (`LOOM_AUTO_TOOLS`, `LOOM_START_TOOL` — read-only); `packages/core/test/invariants.test.ts`,
  `track-a-prove-run.test.ts`, `session-lease.test.ts`, `event-bus.test.ts`.
- **SDK:** `@anthropic-ai/claude-agent-sdk@0.3.204` — `SettingSource = 'user' | 'project' | 'local'`;
  `McpServerConfig` (a four-member union including `McpSdkServerConfigWithInstance`); `allowedTools?: string[]`,
  `disallowedTools?: string[]` (plain `string[]`, which is exactly why the narrowing must live in **your**
  type). Read the installed `sdk.d.ts` under `node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.204*/`;
  `apps/web/AGENTS.md` is a standing reminder that this stack's APIs differ from training data — the same
  applies to the SDK, so verify a type before you rely on it.

---


## 9. Dev Agent Record

### Agent Model Used

`claude-opus-5` (Claude Opus 5), via the `bmad-dev-story` skill, run unattended end to end.
Parallelisable measurement was fanned out to four `claude-sonnet-5` sub-agents; every design decision,
every edit and every verification below was made in the Opus context.

### Debug Log

**Baseline, measured on the working tree at the start of this story — NOT quoted from the story file.**
`git rev-parse HEAD` → `deee7fb19bacf414e63773a433a6482fbed03e78`. The frontmatter's
`baseline_commit: b44d9b5…` was left exactly as written (the skill preserves an existing value); note the two
differ because `deee7fb` is this story's own context commit, which added no code.

```
ls packages/core/test/*.test.ts | wc -l   →  107     (before)   →  108  (after)   delta +1 ✅
ls apps/web/lib/*.test.ts       | wc -l   →   10     (before)   →   11  (after)   delta +1 ✅
repo-root bun test              →  1835 pass / 0 fail, Ran 1835 tests across 118 files   (before)
repo-root bun test              →  1895 pass / 0 fail, Ran 1895 tests across 120 files   (after)
                                   M grown by exactly 2 ✅ · N grown by 60
```

The baseline row was produced by `git stash push --include-untracked -- packages/core apps/web`, running the
suite, then `git stash pop` — i.e. measured, not remembered. **N's +60 reconciles exactly**: 37 tests in
`session-profile.test.ts` + 16 executed in `session-profiles.test.ts` (10 authored titles, two of which are
per-kind loops rendering 4× each → 8 + 8 = 16) + 7 new `INV-6` tests in `invariants.test.ts`
(40 → 47) = 60.

**§0 rule 5 and NFR-RF-8 fences — both empty, as required:**

```
$ git diff --stat HEAD -- bunfig.toml
(no output)
$ git diff --stat HEAD -- packages/core/test/ultra-runner.test.ts
(no output)
```

**T-A0 — the measurements everything else is derived from.** All read off `apps/web/app/api/chat/route.ts`
on the working tree. Line pointers are `≈:` and were true at measurement time; the symbols are the fact.

- **`allowedTools`** (the non-escalation Claude branch, `≈:1242`): `"Read", "Grep", "Glob", "WebSearch",
  "WebFetch", "ToolSearch", ...LOOM_AUTO_TOOLS, ...ULTRA_AUTO_TOOLS`. The escalation branch is instead
  `[...LOOM_ESCALATION_READONLY_TOOLS]` — containing **none** of those six.
- **`disallowedTools`** (`≈:1285`): `[...manifest.guardrails.disallowedTools, "AskUserQuestion",
  ...(isEscalationSession ? [...LOOM_ESCALATION_DISALLOWED_TOOLS, ...ULTRA_AUTO_TOOLS] : [])]`.
- **`settingSources`** (`≈:1227`): `["project", "local"]`, with the long comment recording that user-level
  settings stay out "on purpose (keeps the developer's personal config/tokens out of the subprocess)" and
  that a repo's own `settings.local.json` can still widen its access — the trust decision D5 quotes.
- **`cwd` / `guardrails`**: `const workspace = manifest.root;` (`≈:478`), fed to `cwd: workspace` and to
  `makeGuardrailDecision(manifest, workspace, …)`.
- **`runCodexTurn`'s full argument list** (`≈:931`): `{ prompt, cwd, env, model, reasoningEffort?, sandbox,
  resume, signal, approvalPolicy, onApproval }`. **No `hooks`, no `mcpServers`, no
  `allowedTools`/`disallowedTools`, no `settingSources`, no `permissionMode`, no `systemPrompt`.** This list
  is the entire evidence base for §5.5-D7's capability table, and the table was re-derived from it rather
  than copied.

`BASE_ALLOWED_TOOLS` is therefore exactly the six harness tools core can name for itself, measured — not
invented.

**Both `typecheck()` variants exist; this story used the SIMPLE one (D13).** No `--types node`, no
`cwd: CORE_ROOT` — copied from `event-bus.test.ts`, not from `session-lease.test.ts`. The reason is
mechanical: `session-lease.test.ts` needs the node ambient types only because `runner/lease.ts` imports
`node:fs`. `session-profile.ts` imports **no** `node:*` module at all, and the fixture prelude imports only
`BASE_ALLOWED_TOOLS`, `BaseAllowedTool` and `ToolPolicy` — never the Agent SDK — so the throwaway program
compiles from a directory with no `node_modules` of its own while the port's own imports still resolve from
their real location.

**AC3, both directions, with the REAL diagnostic text.** One measurement changed the fixture shape and is
worth recording because the story's expected assertion could not have held as first written: a direct
`const p: ToolPolicy = { deny: [], allow: ["Bash"] };` makes `tsc` report **only** the element mismatch and
never the words `ToolPolicy`, because the CLI does not print the related-information span that names the
declaring type. Measured across four fixture shapes (direct annotation, `satisfies`, a generic parameter, a
`Record` value) — all four printed the expanded union alone. In **argument** position `tsc` leads with the
parameter's type name, so the fixture authors the policy through
`declare function authorToolPolicy(p: ToolPolicy): void;` and `as const` keeps the literal from widening.
Failing direction:

```
fixture.ts(6,18): error TS2345: Argument of type '{ readonly deny: readonly []; readonly allow: readonly ["Bash"]; }'
  is not assignable to parameter of type 'ToolPolicy'.
  Types of property 'allow' are incompatible.
    Type 'readonly ["Bash"]' is not assignable to type 'readonly ("Read" | "Grep" | "Glob" | "WebSearch" | "WebFetch" | "ToolSearch")[]'.
      Type '"Bash"' is not assignable to type '"Read" | "Grep" | "Glob" | "WebSearch" | "WebFetch" | "ToolSearch"'.
```

— which contains the offending tool name, the type name, **and** the whole base union. Passing direction
(`allow: ["Read"]`): `status=0`, output exactly `""`.

**The prove-run filter — MEASURED, and it is TWO commands, not one (D14's own fallback).**

```
$ TELAR_HOME=$(mktemp -d) bun test packages/core -t "prove-run"          →  11 pass  (NOT 6)
$ TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-a prove-run"  →   5 pass  (L1–L5)
$ TELAR_HOME=$(mktemp -d) bun test packages/core -t "prove-run L6"       →   1 pass  (L6)
```

The single-command form selects 11 because three blocks beyond the six legs contain the substring: the
`prove-run citations` describe in `track-a-prove-run.test.ts` (1 test — its own integrity check), and two
**unrelated, pre-existing** suites whose prose titles happen to use the phrase —
`m11-1-modality-derivation.test.ts`'s describe *"library test-gate derivation fires ONLY under a sanction
(the prove-run fix, narrowed)"* (3 tests) and `m11-0-preflight-plan.test.ts`'s test *"greenfield: EMPTY root +
gate-mechanism charter intent → PROCEEDS (the prove-run case)"* (1 test). 5 + 1 + 3 + 1 + 1 = 11. Since the
count is not six, D14's instruction applies verbatim — *"disclose two commands instead… A faked single
command is worse than an honest pair"* — so **the honest pair is the two `track-a prove-run` / `prove-run L6`
commands above, six legs in total**. Every prove-run command carries the `packages/core` path argument (T-7).

**L6's transcript line, verbatim:**

```
[track-b] L6 a "escalation" profile requires mcp-servers, pre-tool-use-hooks, tool-allow-deny-lists; codex
publishes interactive-approval; unmet = mcp-servers, pre-tool-use-hooks, tool-allow-deny-lists → a pre-SSE
400, and INV-6c pins the call site ahead of new ReadableStream
```

**The three pins this story sits across — each run BY NAME, after every edit, all green:**

```
$ bun test packages/core/test/invariants.test.ts -t "INV-1g"  →  1 pass / 0 fail
$ bun test packages/core/test/invariants.test.ts -t "INV-3a"  →  1 pass / 0 fail
    [invariants] inventory: 3 MCP surfaces · 18 root-composition sites · 6 home-root derivations
$ bun test packages/core/test/invariants.test.ts -t "INV-3f"  →  1 pass / 0 fail
```

`INV-3a`'s inventory is still **exactly 18** sites — the resolver composes no state path (D2), so no
nineteenth entry and **no new `KNOWN_VIOLATIONS` entry**. `KNOWN_VIOLATIONS` still holds **exactly one**
entry, `scripts/backfill-tool-detail.ts` (read off the file: the array opens at `const KNOWN_VIOLATIONS = [`
and closes after that single object).

**`invariants.test.ts` wall-clock, against story 1.3's 2000 ms AC3 budget.** Before `INV-6`: `Ran 40 tests
across 1 file. [558.00ms]` (story 1.3's recorded post-fix figure). After: **`Ran 47 tests across 1 file.
[520.00ms]`** — measured repeatedly at 520–558 ms. Seven tests added at no measurable cost, because `INV-6`
reads the SAME cached module-scope index every other invariant reads and spawns **no** process. This is
exactly why D12 keeps the compile pins in `session-profile.test.ts`: a single `tsc` spawn costs ~0.35 s, and
the seven pins there would have tripled this file's runtime on their own.

**AC5 — the route diff, in full shape.** `git diff --cached -U0 -- apps/web/app/api/chat/route.ts` produces
**four hunks, every one a pure insertion (63 lines added, 0 removed)**:

```
@@ -19,0 +20,2 @@ import {      ← resolveSessionProfile, sessionKindFromRole
@@ -20,0 +23 @@  import {      ← unmetCapabilities
@@ -86,0 +90,8 @@ import {      ← the side-effect import + its comment
@@ -479,0 +491,52 @@ export async function POST(req: Request)   ← the resolve call + the capability gate
```

The last hunk ends at ≈`:543`; `const stream = new ReadableStream({` sits at ≈`:566`. **No hunk is inside
`new ReadableStream`.** And the moat region is byte-identical — grepping the diff for `hooks:`,
`preToolUseGuardrail`, `canUseTool`, `makeGuardrailDecision`, `LOOM_START_TOOL` or
`LOOM_ANSWER_BLOCKED_TOOL` on a `+`/`-` line returns **nothing**.

```
$ git diff --cached --stat -- apps/web
 apps/web/app/api/chat/route.ts        |  63 ++++++++++++
 apps/web/lib/session-profiles.test.ts | 181 ++++++++++++++++++++++++++++++++++
 apps/web/lib/session-profiles.ts      | 155 +++++++++++++++++++++++++++++
 3 files changed, 399 insertions(+)
```

**Discovery proof, mechanism 2 — by name, from the junit reporter.** `bun test --reporter=junit
--reporter-outfile=<scratch>/discovery.xml` from the repo root, then a `grep -F` for **every** authored test
title: **54/54 located, 0 missing**, each with its `file=` attribution
(`packages/core/test/session-profile.test.ts`, `apps/web/lib/session-profiles.test.ts`,
`packages/core/test/invariants.test.ts`). The two `${row.kind}` template titles were verified for **all four**
renderings (`project`, `planner`, `steerer`, `escalation`), not just one. *Recorded because it is the kind of
thing that silently invalidates a proof:* the first pass reported 10 false MISSINGs, every one containing an
apostrophe — my needle escaped `'` as `&#x27;` while bun's junit writer emits `&apos;`. The bug was in the
verification script, not in discovery; re-running with the correct escaping gave 54/54.

Spot checks and the negative control:

```
$ bun test -t "AC4 the five Claude-only capabilities are exactly the measured divergences"
   1 pass · 1894 filtered out · 0 fail · Ran 1 test across 120 files.
$ bun test -t "importing @/lib/session-profiles populates the registry with ALL FOUR kinds"
   1 pass · 1894 filtered out · 0 fail · Ran 1 test across 120 files.
$ bun test -t "INV-6c the chat route resolves the session profile BEFORE the stream opens"
   1 pass · 0 fail
$ bun test -t "a name that does not exist zzz"
   error: regex "a name that does not exist zzz" matched 0 tests. Searched 120 files (skipping 1895 tests)
   exit=1
```

**The revert probes (§0 rule 7). Five of them, each: break it, capture the REAL failure, `git checkout --`,
verify `git diff --stat -- packages/core apps/web` is empty.** (The four new files are untracked, so
everything was `git add`-ed first and each restore comes from the index.)

- **P1 — `INV-6a`**: added `readonly hooks: { PreToolUse: unknown[] };` to `SessionProfile`. Real failure:
  `AD-10 / INV-6: the SessionProfile field set MOVED. NEW fields: ["hooks"]. GONE: []. THE RULE: a profile
  carries AD-9's seven config fields plus "kind", the registry key… CONSEQUENCE: a field that reaches hooks,
  canUseTool or permissionMode turns the Human-Accept Moat from a STRUCTURAL invariant into a CONFIGURABLE
  one… NEXT STEP: if the field is legitimate, add it here WITH a comment saying why it cannot widen a grant.`
  The sibling rogue-field assertion fired too. Restored; diff empty; `INV-6a` → 2 pass.
- **P2 — `INV-6c`**: relocated the whole resolve+gate block inside `new ReadableStream`'s `start(controller)`.
  Real failure: `expect(received).toBeLessThan(expected) · Expected: < 26572 · Received: 27930`. Restored;
  diff empty; green again.
- **P3 — the AC3 compile pins**: widened `ToolPolicy.allow` to `readonly string[]`. **Six** assertions fired —
  five AC3 compile pins (`5 fail` in that describe) **and** `INV-6b`
  (`Expected: "readonly BaseAllowedTool[]" · Received: "readonly string[]"`). Restored; diff empty; `14 pass`.
- **P4 — the capability gate**: gave Codex `capabilities: PROVIDER_CAPABILITIES`, i.e. a gate that no longer
  gates. **Six** tests fired across BOTH workspaces — 5 in core (including **L6**) and 1 in
  `apps/web/lib/session-profiles.test.ts` (*"planner, steerer and escalation all FAIL on Codex"*). Restored.
  **P4b**, the story's literal wording — `capabilities: []` — fired 3, including the
  `interactive-approval`-published-by-both false-divergence guard. Restored; diff empty.
- **P5 — the side-effect import**: deleted `import "@/lib/session-profiles";` from `route.ts`. This is the
  failure with no other guard, and the probe proves it: **`bunx tsc --noEmit` in `apps/web` still exited 0**
  while the app would 500 on every chat request. `INV-6c` was the only thing that noticed
  (`Expected to contain: "import \"@/lib/session-profiles\";"`). Restored; diff empty; green.

**The byte check (T-6).** No file this story wrote or edited contains a NUL or a stray control character
(only TAB and LF permitted), and none is `application/octet-stream`:

```
packages/core/src/session-profile.ts:        text/plain; charset=utf-8      414 lines   0 control-char lines
packages/core/src/providers.ts:              text/x-java; charset=utf-8     152 lines   0
packages/core/src/index.ts:                  text/plain; charset=utf-8       95 lines   0
packages/core/test/session-profile.test.ts:  text/x-java; charset=utf-8     698 lines   0
packages/core/test/invariants.test.ts:       text/x-java; charset=utf-8    2800 lines   0
apps/web/lib/session-profiles.ts:            text/plain; charset=utf-8      156 lines   0
apps/web/lib/session-profiles.test.ts:       text/x-java; charset=utf-8     180 lines   0
apps/web/app/api/chat/route.ts:              text/x-java; charset=utf-8    1985 lines   0
```

(`text/x-java` is `file(1)`'s heuristic for C-family syntax; the load-bearing fact is that nothing is
`application/octet-stream` and every file is UTF-8 text `grep` reads as text.)

**THE DEV-SERVER PROOF — captured verbatim.** `TELAR_HOME=$(mktemp -d)` **and** `HOME=$(mktemp -d)`, per
§5.4-D (faking `HOME` too is what keeps a probe off the real `~/.telar` even when the guard under test is the
broken thing). The throwaway root was seeded **through the ports, inside a `bun test` file** — never a
`bun -e` probe (§0 rule 4): `createProject(<tmp workspace>, { name: "devproof", account: "codex-probe" })`
and `upsertAccount({ name: "codex-probe", provider: "codex" })` with **no `configDir`**. Confirmed
`accountHealth(codex-probe).status = unknown`, so it clears the route's account-health gate (which rejects
only `missing-config-dir` / `never-logged-in`) and reaches the capability gate with no credentials involved.
Server: `bun run dev --port 3111` → `✓ Ready in 273ms`, Next.js 16.3.0-canary.80.

*Proof 1 — the capability gate, `role: "planner"` on the Codex account:*

```
HTTP/1.1 400 Bad Request
Content-Type: application/json;charset=utf-8
Transfer-Encoding: chunked

{"error":"A \"planner\" session needs system-prompt-append, which the Codex agent does not support. Run this session on a Claude account, or start it as a plain project session."}
```

`grep -c -E "^(event|data):"` over that response → **0**. No SSE frame was written.

*Proof 2 — the COMPANION POSITIVE CONTROL, the identical request with no `role` (kind `project`), same
account:*

```
HTTP/1.1 200 OK
Cache-Control: no-cache, no-transform
Content-Type: text/event-stream
Transfer-Encoding: chunked

event: error
data: {"message":"Error: codex app-server exited (code=127, signal=null)"}
```

This is the control §6.3 demands, and it discriminates in exactly the way it was asked to. The stream
**opened** — 200 with `text/event-stream`, and the downstream failure (no `codex` binary on this machine)
arrives as an SSE `error` **event inside the stream**, never as a status code. So the 400 in Proof 1 was
caused by the capability gate and **not** by a missing side-effect import: had the registry been empty,
`resolveSessionProfile` would have thrown and this request would have 500'd instead of streaming. T-B1
verified from both ends.

*Proof 3 — `role: "escalation"`, naming all three unmet capabilities:*

```
HTTP/1.1 400 Bad Request
{"error":"A \"escalation\" session needs mcp-servers, pre-tool-use-hooks, tool-allow-deny-lists, which the Codex agent does not support. Run this session on a Claude account, or start it as a plain project session."}
```

SSE frames: **0**.

*Proof 4 — the gate is a gate, not a wall.* The same `role: "planner"` request against a **Claude** account
(`upsertAccount({ name: "claude-probe", provider: "claude" })`, added through the port in the same throwaway
root) → `HTTP/1.1 200 OK`, `Content-Type: text/event-stream`. AC5 holds on the surface as well as in the
suite.

*And the scar was not re-opened.* `ls -la ~/.telar` before and after the whole dev-server session is
**byte-identical** — still exactly the one pre-existing `usage.ndjson` (201 bytes, dated 26 Jul 01:20) left
by story 1.1's out-of-harness probe. `~/.telar-dev` was never created. Every write landed in the throwaway
root (`accounts.json`, `projects.json`). The dev server was stopped and port 3111 confirmed free.

**The gate — the manual trio, both workspaces.**

```
$ cd packages/core && bun test        →  1562 pass / 0 fail · Ran 1562 tests across 108 files. [34.19s]
$ cd packages/core && bunx tsc --noEmit  →  exit 0
$ cd apps/web && bun test             →   333 pass / 0 fail · Ran 333 tests across 12 files. [1.54s]
$ cd apps/web && bunx tsc --noEmit    →  exit 0
$ bun test            (repo root)     →  1895 pass / 0 fail · Ran 1895 tests across 120 files. [35.68s]
```

**`bun run lint` — and a correction worth recording, because the first answer was wrong.** This is **not** a
clean baseline and is *"not this SPEC's to fix"*; it exits 1 on pre-existing problems, overwhelmingly
`react-hooks/*` and `@typescript-eslint/no-explicit-any` in files this story never opened. I first reported
that the story added zero lint problems. **That claim came from a vacuous comparison** — my `grep -oE`
pattern matched nothing, so I was diffing two empty strings and reading "identical" as a pass. It is the
precise anti-vacuity failure this story's own §5.4-E exists to prevent, caught only because the count was
re-measured with a pattern that had to be non-empty. Re-measured properly:

```
BEFORE (stash):  165 problems (136 errors, 29 warnings)
AFTER  (first):  169 problems (136 errors, 33 warnings)   ← +4 warnings, all mine
```

The four were `'_ctx' is defined but never used` — one per builder in `apps/web/lib/session-profiles.ts`;
this config does not treat a leading underscore as an ignore pattern (the pre-existing `_mode`/`_isolation`
warnings in `route.ts` are the same shape). **Fixed rather than carried**: each builder is now declared
`export const buildXProfile: SessionProfileBuilder = () => ({…})`, annotating with the port's own exported
function type instead of naming a parameter it ignores — which states the contract more precisely than the
unused argument did. Final:

```
AFTER  (fixed):  165 problems (136 errors, 29 warnings)   ← IDENTICAL to baseline, zero added
$ grep -E "session-profiles" <lint output>  →  (none)
```

Errors never moved (136 → 136 → 136); the `route.ts` entries in the diff are pure line-number shifts from
this story's +63 lines, not new findings.

### Completion Notes

1. **The `typecheck()` variant (D13): the SIMPLE form** — no `--types node`, no `cwd: CORE_ROOT` — copied
   from `event-bus.test.ts` rather than `session-lease.test.ts`. The `--types node` variant exists only
   because `runner/lease.ts` imports `node:fs`; `session-profile.ts` imports no `node:*` module, and the
   fixture prelude imports only `BASE_ALLOWED_TOOLS`, `BaseAllowedTool` and `ToolPolicy`, keeping the Agent
   SDK out of the throwaway program's import surface entirely. Harness duplicated a **third** time, per the
   §3 fence: `packages/core/test/` has never held a helper module and this story did not introduce one.
2. **`mcpServers` is a name-keyed `Record`, not an array — a disclosed deviation from AC1's `mcpServers[]`
   notation.** The SDK, the chat route (`mcpServers: { loom, ultra, ...resolveProjectMcpServers(project) }`)
   and core's own `resolveProjectMcpServers` all key MCP servers by **name**, because the SDK requires the
   name as the key. Converting to an array and back would lose the keys for pure ceremony, and a record makes
   duplicate names structurally impossible. Read `mcpServers[]` as "the set of MCP servers". Flagged here
   because a reviewer holding the AC text will notice, and an undisclosed deviation reads as an error.
3. **The branded/nominal `SessionProfile` was considered and DECLINED — recorded so 2.2 does not re-open
   it.** Core has no branded-type precedent (grepped: zero `unique symbol`, zero `__brand`, zero phantom type
   parameters), and the house mechanism for "this cannot be expressed" is the enumerable union (§5.4-B). It
   is also unnecessary: `toolPolicy` is the *only* tool-granting field, and its own type forbids widening
   whether or not the enclosing object was minted by the resolver. The two-type split
   (`SessionProfileSpec` in, `SessionProfile` out) already delivers the property the brand was wanted for.
4. **The `BASE_ALLOWED_TOOLS` seam.** The base union is exactly the six tools core can name for itself —
   `Read, Grep, Glob, WebSearch, WebFetch, ToolSearch` — measured from today's route. `LOOM_AUTO_TOOLS` and
   `ULTRA_AUTO_TOOLS` are `apps/web/lib` constants; core importing them would invert the dependency, so they
   **stayed in the route**, and a spec's `allow` narrows the six. **Story 2.2 owns bringing them in**, either
   by moving those constants into core or by parameterising the base set; doing it here would mean touching
   `apps/web/lib/loom-mcp.ts`, which is not in this story's write set. Said in-source, above the const.
5. **The disclosed behaviour change, with the measurement.** After this story an `escalation`, `planner` or
   `steerer` session on a **Codex** account returns a 400 instead of a 200 that silently drops the thing that
   made it that kind of session. **It is genuinely reachable, re-derived by grep rather than assumed:**
   `apps/web/components/session/session-view.tsx`'s `selectProvider` is unrestricted (it sets provider,
   resets model/effort, and re-points the account — no kind check anywhere), the `planner`/`steerer`/
   `escalation` props are passed independently of provider, and `apps/web/app/looms/plan/[project]/page.tsx`
   imposes no restriction either. Nothing stops a Codex account being selected for a planner session today.
   Proven live in Proofs 1 and 3 above. This is **not** covered by AC5, which scopes "untouched" to the
   *project-session* path — so the capability set was **not** weakened to avoid it. AD-11: *"No silent
   degradation, ever."*
6. **What `planner` and `steerer` require, and why.** Both require **`system-prompt-append`** and
   deliberately **not** `mcp-servers`. The route's own comment on `isPlannerSession` is the reason: the flag
   *"Drives ONLY the appended system-prompt guidance below — never loom tool access/gating"*, and the steerer
   comment says the same (*"never loom tool access/gating (which stays exactly as wired)"*). So the appendix
   **is** the kind, and requiring a capability the kind does not use would gate it on something irrelevant.
   `escalation` requires `mcp-servers`, `pre-tool-use-hooks` and `tool-allow-deny-lists`, because the Codex
   fork returns before `createLoomMcpServer` is ever reached — there are no loom tools at all — and
   `answer_blocked`'s human gate is a `PreToolUse` comparison that does not run on that branch.
   `interactive-approval` is published by **both** providers on purpose: Codex genuinely has it via
   `onCodexApproval`, and a false divergence would 400 a session that works today.
6b. **`route.ts` carries `import "@/lib/session-profiles";`, and the registry was provably populated at
   request time.** Verified three ways: by grep (exactly 1 occurrence), mechanically by `INV-6c` (which
   asserts the literal — and P5 proved that assertion is the *only* thing in the tree that notices its
   removal, since `tsc` stayed green), and live by the Proof-2 positive control, where a `project` session on
   the same account streamed rather than throwing `no module declared it`.
7. **`systemPromptAppendix` is `""` for ALL FOUR kinds in 2.1 — including `planner`, which D11 expected could
   be supplied now.** This is a **deviation from the story's design table** and it is forced by a measurement
   D11 did not make: `PLANNER_SYSTEM_PROMPT`, `STEERER_SYSTEM_PROMPT` and `ESCALATION_SYSTEM_PROMPT` are all
   module-private consts inside `route.ts`, whose **only export is `POST`**. Reaching them would need either
   a second export from a Next.js route module or hoisting the constants out of the handler — both larger
   edits to `route.ts` than AC5 permits — and copying the text would create a second source of truth for
   moat-adjacent prompt content. `planner` has a second blocker: `ultraAnnotationNote` derives from the
   per-turn `ultra` wire flag, which is not a field of `SessionResolutionContext` (D1 fixes that shape).
   `steerer`/`escalation` were always 2.2's, since their values embed per-turn live reads
   (`buildSteererContext`, `buildEscalationContext`) inside the stream body. **Harmless in 2.1** (nothing
   consumes the appendix — D8), **not harmless in 2.2**, so it is written up in `deferred-work.md` with the
   fix, and the builder suite pins `""` for all four *on purpose* as the tripwire.
8. **The prove-run is TWO commands, not one, and the count was measured** — `-t "prove-run"` selects **11**,
   not six. Full arithmetic and the two honest commands are in the Debug Log. D14's own fallback applies:
   *"A faked single command is worse than an honest pair."*
9. **The pre-stream detectability constraint (D9b), so 2.2 inherits the analysis instead of re-deriving it.**
   `existingChat` (`getChat(resumeTarget)`) and `loomLink` are both derived **inside** the stream closure, so
   nothing pre-stream can see a resumed session's persisted `role`. A **resumed** planner or steerer session
   whose client omits `role` therefore resolves as kind `project`. That **under-detection is the safe
   direction** and is the reason the gate cannot false-positive: `project` requires no capability, so a
   mis-detected session gets a *weaker* requirement, never a spurious 400. `escalation` is reliably knowable
   because the client *"sends it on every turn including reattached ones"*. **`getChat` was deliberately NOT
   hoisted** into the preamble — that is a real store read on the hot path and a change to a validated
   pre-stream sequence, i.e. 2.2's call. Asserted as named tests and written into the port's header.
10. **The Codex guardrail gap is recorded, not fixed** — `deferred-work.md`, new
   `## Deferred from: 2-1-the-sessionprofile-resolver (2026-07-26)` section, with the measurement:
   `makeGuardrailDecision` has exactly two call sites in `route.ts` (inside `canUseTool` and inside
   `preToolUseGuardrail`), both reachable only as `query()` options in the `else` branch;
   `manifest.guardrails` is read in exactly one place, the Claude branch's `disallowedTools`; and searching
   the entire Codex fork for `makeGuardrailDecision`/`guardrails`/`disallowedTools`/`protectedPaths` returns
   nothing. So a project's `manifest.guardrails` is **never enforced on a Codex session**. Older than this
   story; fixing it means changing behaviour inside `new ReadableStream`, which AC5 forbids.
11. **`bunfig.toml` was not touched** (`git diff --stat HEAD -- bunfig.toml` → empty; fourth story in a row to
   fence itself from it), and **none of story 1.1's five `[Review][Decision]` items was resolved** — in
   particular `usageSummary`'s `ownerKind !== "session"` filter, `getChat`'s discarded `costUsd` and
   `releaseAdmission`'s class-mismatch residual are all untouched. `ultra-runner.test.ts` is byte-identical.
12. **`KNOWN_VIOLATIONS` still holds exactly one entry** (`scripts/backfill-tool-detail.ts`), and `INV-3a`'s
   `TELAR_HOME` inventory is still exactly **18** sites. This story added **no** new `KNOWN_VIOLATIONS`
   entry, because D2's pure resolver composes no state path at all.
13. **The `SPEC.md` ↔ `epics.md` drift was noticed and is recorded, as §8 asks.** `SPEC.md`'s success
   paragraph names **five** prove-run legs and does **not** name the `toolPolicy`-widening assertion;
   `epics.md` re-cuts the run across two stories and adds that assertion as story 2.1's AC6. Per planning
   decision 4, **`epics.md` is the source of truth**, and this story implemented AC6 accordingly (`INV-6`).
14. **Deliberately left to another story or track, each named rather than silently dropped.** (a) Migrating
   the project/planner/steerer/escalation session onto the profile, and removing any session-kind conditional
   — **story 2.2** in full; `isPlannerSession`, `isSteererSession` and `isEscalationSession` are untouched.
   (b) Codex MCP injection — the mechanism that *reports* the gap is built; the injection is not.
   (c) `LOOM_AUTO_TOOLS`/`ULTRA_AUTO_TOOLS` joining the base union — 2.2 (note 4). (d) The three
   `systemPromptAppendix` values — 2.2 (note 7, recorded in `deferred-work.md`). (e) The Codex guardrail gap
   — recorded, unowned (note 10). (f) No zod schema for `SessionProfile` (§3, T-12: a zod round-trip would
   widen the literal union back to `string[]` and destroy AC3). (g) No CI, no route, nothing user-visible.
15. **One addition beyond §5.2's literal export list, made deliberately and flagged.** `sessionKindFromRole`
   is exported from `session-profile.ts` even though §5.2 does not list it. §6.4's coverage rows 26 and 27
   require the wire-role→kind derivation to be **tested in the core suite**, and the only alternative was to
   put that logic inline in `route.ts` — a file with **no test anywhere in the tree**, which would have made
   the two rows untestable and defeated the coverage table. `SESSION_KINDS`, `SessionRole`,
   `SessionProfileBuilder`, `ResolvedToolPolicy`, `ProfilePermissionMode` and `registeredSessionKinds` are
   likewise present: D3 names `ResolvedToolPolicy` explicitly, §5.4-B's enumerable-union idiom requires the
   tuple, and the rest are the registry's own vocabulary.
16. **`ProfilePermissionMode` reuses the SDK's union rather than restating it** —
   `Exclude<PermissionMode, "bypassPermissions" | "plan" | "dontAsk">`, the same utility-type family as D5's
   `Exclude<SettingSource, "user">`. It resolves to exactly `apps/web`'s `ClientPermissionMode`
   (`"default" | "auto" | "acceptEdits"`) without core importing from the app, and the exclusions are the
   load-bearing part: `bypassPermissions` skips `canUseTool` entirely, so a context that could carry it would
   be the very degradation AD-10 forbids (NFR-RF-1: reuse, never rebuild).

---

## 10. File List

Measured with the change staged (`git add -A -- packages/core apps/web && git diff --cached --name-status`):

```
M	apps/web/app/api/chat/route.ts
A	apps/web/lib/session-profiles.test.ts
A	apps/web/lib/session-profiles.ts
M	packages/core/src/index.ts
M	packages/core/src/providers.ts
A	packages/core/src/session-profile.ts
M	packages/core/test/invariants.test.ts
A	packages/core/test/session-profile.test.ts
```

**4 `A` + 4 `M`, exactly as §10 predicted — no write-set breach.** Plus, outside the code write set and
staged separately:

```
M	_bmad-output/implementation-artifacts/deferred-work.md          (AC2's required finding + note 7)
M	_bmad-output/implementation-artifacts/sprint-status.yaml        (2-1 → review)
M	_bmad-output/implementation-artifacts/stories/2-1-the-sessionprofile-resolver.md
```

`_bmad-output/implementation-artifacts/orchestrator-run-log.md` is **deliberately excluded from every
commit** — it belongs to the orchestrator, not to this story.

---

## 11. Change Log

| Date | Change |
| --- | --- |
| 2026-07-26 | **Story 2.1 implemented.** New core port `session-profile.ts`: `SessionKind`/`SESSION_KINDS`, `sessionKindFromRole`, `BASE_ALLOWED_TOOLS`/`BaseAllowedTool`, the intersect-only `ToolPolicy` + `ResolvedToolPolicy`, `ProfileSettingSource`, `ProfilePermissionMode`, `SessionProfileSpec`/`SessionProfile`/`SessionResolutionContext`, the `declareEvents`-shaped registry (`registerSessionProfile` / `resolveSessionProfile` / `resetSessionProfiles` / `registeredSessionKinds`), the pure fold, and `unmetCapabilities`. |
| 2026-07-26 | `providers.ts`: added `ProviderCapability` + `PROVIDER_CAPABILITIES`, a required `capabilities` field on `ProviderDescriptor` populated for both `PROVIDERS` entries, and `providerCapabilities`/`providerPublishes`. Header's "auth/config only" claim amended in the same edit so it no longer contradicts its own file. |
| 2026-07-26 | `index.ts`: one `export * from "./session-profile";` with its AD-9/AD-10/AD-11 banner. |
| 2026-07-26 | `apps/web/lib/session-profiles.ts` (new): the four spec builders + module-scope registration. `route.ts`: named imports, the side-effect import, one resolve call and one capability gate in the pre-stream preamble — 63 inserted lines, zero removed, nothing inside `new ReadableStream`. |
| 2026-07-26 | Tests: `packages/core/test/session-profile.test.ts` (37, incl. 7 two-direction `tsc` pins and prove-run leg **L6**), `apps/web/lib/session-profiles.test.ts` (16), and **`INV-6`** in `invariants.test.ts` (7: floor, `INV-6a`/`6b`/`6c`/`6d`, and executable citations) with its `THE FIVE` header amended to name the sixth. |
| 2026-07-26 | `deferred-work.md`: new section recording the pre-existing Codex guardrail gap (AC2's required finding) and the `systemPromptAppendix` deferral to 2.2. |

**Suggested conventional-commit message** — `feat(core)` rather than `feat(web)`, because the port and its
proofs are the substance and the `apps/web` change is wiring:

```
feat(core): the SessionProfile resolver — session config as data, with the moat left outside it

Adds packages/core/src/session-profile.ts: a typed session profile resolved
once, before the chat route's body runs, so a new kind of session becomes a
registered profile rather than another conditional through a 1900-line handler.
Three epics are queued to add a fourth, fifth and sixth session kind against
that handler, and the Human-Accept Moat currently rides on it.

The three properties are the point, and each is enforced rather than reviewed:

- The PreToolUse guardrail stays wired OUTSIDE the profile. No field can reach
  hook registration, and INV-6a pins the field set to AD-9's seven config fields
  plus the registry key, so adding one fails a test.
- toolPolicy is intersect-only BY ITS TYPE — deny lists and allow-narrowing
  only — proved by running tsc over generated fixtures in both directions, and
  intersected again at runtime so a cast cannot widen either.
- An unmet capability is a hard error BEFORE the stream opens. providers.ts now
  publishes what each provider's harness supports, measured against the Codex
  fork; unmetCapabilities names what is missing and the route turns it into its
  existing pre-SSE 400.

Additive by design: the route resolves a profile for every request and consumes
only the capability gate. Migrating the live path onto it is story 2.2, behind
its own gate. Discloses one behaviour change — a planner, steerer or escalation
session on a Codex account now 400s instead of returning 200 while silently
dropping the thing that made it that kind of session (AD-11: no silent
degradation, ever).

Also records, without fixing, that a project's manifest.guardrails is never
enforced on a Codex session — older than this story, and outside AC5's fence.
```
