---
story_id: "2-2"
title: "Retrofit the existing session kinds onto profiles"
status: "ready-for-review"
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
    "AD-18",
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
baseline_commit: "cbbac0a77e50bdab883c1731102e2f045d755376"
baseline_gate: "1896 pass / 0 fail across 120 files (story 2.1, post-review-fix). Re-measure; do not quote."
depends_on:
  [
    "2-1 (the SessionProfile resolver — 'the shape was settled in 2.1'). Landed at 52ee6af + cbbac0a.",
  ]
blocks:
  [
    "epic 4 (Ultra: a SessionProfile is Track D's seam)",
    "epic 5 (the project-less master profile is Track E's seam)",
    "epic 6 (node + steerer profiles are Track F's seam)",
  ]
---

# Story 2.2: Retrofit the existing session kinds onto profiles

## 0. Read this first

**Citation policy for this whole file — inherited from stories 1.1, 1.2, 1.3 and 2.1, which re-learned it six
times between them.** Every reference below names a **file and a symbol** — a function, a const, a type field,
or a test title. **A line number is not a name.** It identifies a slot in a file, and any edit above it hands
that slot to something else. Where a number helps you navigate `route.ts` (**1985 lines, measured at
`cbbac0a`**) it is written `≈:N` and is a **pointer, not a fact** — verify by symbol, never by number. Do not
add a number to this file you have not just measured. Counts obey the same rule: `project-context.md` says
outright that its test counts are *"a smell test, not a fact — measure, don't quote."* Measured at `cbbac0a`:
`ls packages/core/test/*.test.ts | wc -l` → **108**; `ls apps/web/lib/*.test.ts | wc -l` → **11**. Both will
have moved by the time you read this.

**Eight hard rules before you write a line.**

1. **This is the story that touches production traffic.** `epics.md`'s dispatch note, verbatim: *"This is the
   story that touches production traffic — the ~103KB handler whose conditional branches the moat currently
   rides on. The shape was settled in 2.1; resist redesigning it here. Removing a conditional is only safe
   once the profile expresses what that conditional did. Verify a real session runs on both providers before
   calling this done."* Every removal in this story is paid for by a profile field that already carries what
   the removed branch decided. If you cannot point at the field, do not remove the branch.
2. **Re-measure every value story 2.1 pinned. Do not inherit it.** 2.1 shipped
   `buildEscalationProfile` with `toolPolicy.allow: []` on a measurement that was **false** — the in-source
   justification claimed none of core's six base tools appeared in `LOOM_ESCALATION_READONLY_TOOLS`; three do.
   It was corrected in `cbbac0a` to `["Read", "Grep", "Glob"]`. Nothing caught it, because **nothing consumes
   `toolPolicy` until this story** — no test and no request could contradict it. You are the first consumer.
   §5.5-D13 is the measured BEFORE/AFTER table; **re-derive it against `route.ts` as it stands when you start**,
   do not copy it on faith. The same applies to `deny`, to `settingSources`, and to the appendix text.
3. **Prove behavioural equivalence per session kind. Do not assume the port is faithful.** There is **no test
   file for `apps/web/app/api/chat/route.ts` anywhere in the tree** (measured: `ls apps/web/app/api/chat/`
   shows `route.ts` plus the `[sessionId]`, `permission` and `stop` subdirectories, no spec; grepping every
   `*.test.ts*` in both workspaces for `api/chat/route` matches in exactly **two files**, both of which only
   *scan* or *mention* it — `invariants.test.ts` and `session-profiles.test.ts` — and neither imports or
   executes the module). `bun test`, `tsc`
   and `lint` all stay green while this route is broken. §6.2 is how you compensate: a per-kind equivalence
   table asserted against re-derived source constants, plus a mechanical AC1 scan, plus a real dev-server run
   on both providers.
4. **Never run an ad-hoc probe outside the test harness.** Outside `bun test`, `NODE_ENV` is not `test`, so
   `usage-ledger.ts`'s write-guard correctly does not fire and a write lands on the home default. **This
   already happened**: `~/.telar` on this machine holds a synthetic `$1` billing line created 2026-07-26 by a
   `bun -e` probe a story-1.1 verification agent ran outside the harness. Two consequences bind you: (a) run
   every probe as a `bun test` file, or as a child process you spawn *from* one; (b) **never mutate
   `process.env.TELAR_HOME` in the shared test process** — use a child process (§5.4-D).
5. **Do not edit `bunfig.toml`.** Not to add a pattern, not to remove one. It is an unresolved
   `[Review][Decision]` on story 1.1 and it is the human's call. Four consecutive stories have fenced
   themselves from it; you are the fifth. Prove you did not: `git diff --stat -- bunfig.toml` must print
   **nothing**.
6. **This story adds NO new `KNOWN_VIOLATIONS` entry.** The count in
   `packages/core/test/invariants.test.ts` is **exactly one** (`scripts/backfill-tool-detail.ts`) and `INV-3f`
   throws if it changes. If you find yourself wanting a second, you have composed a `TELAR_HOME` path
   somewhere you should not have — `INV-3a`'s inventory is exact and a nineteenth site fails it.
7. **A green test can assert nothing.** Every new assertion gets the house treatment: break the thing it
   guards, capture the **real** failure output, restore with `git checkout --`, verify the restore with an
   empty `git diff --stat`. Every scan carries an **anti-vacuity floor** and a **permanent positive control**
   (§5.4-E). Story 1.1 spent two repair rounds on tests that were green while asserting nothing.
8. **Any prove-run / filtered test command takes a path argument.** A bare repo-root `bun test -t "<filter>"`
   is poisoned by a pre-existing `mock.module("@telar/core", …)` leak from two `apps/web/lib/loom-mcp.*`
   suites — recorded in `deferred-work.md` under story 1.3, and **not yours to fix** (it is a hygiene defect
   in files this story does not own). Scope every filtered run: `bun test packages/core -t "…"`, or name the
   file.

**Write set — declared, because this story spans two workspaces and touches a third track's neighbours.**

| Path | New / Edit | Why it is in the write set |
| --- | --- | --- |
| `apps/web/app/api/chat/route.ts` | **EDIT, LARGE** | AC1–AC4 are statements about this file. WORK-SPLIT's Track B row owns it outright |
| `apps/web/lib/session-prompts.ts` | **NEW** | The three system prompts + the two per-turn live-context builders, hoisted out of `route.ts` so a profile builder can reach them (§5.5-D6) |
| `apps/web/lib/session-prompts.test.ts` | **NEW** | The hoisted prompts and the fail-safe context assembly (§5.5-D7) |
| `apps/web/lib/session-profiles.ts` | **EDIT** | The four builders stop returning inert values and start carrying the real per-kind decisions |
| `apps/web/lib/session-profiles.test.ts` | **EDIT** | The D11 table's `""` appendices and the 3-name escalation `allow` were deliberate tripwires; they fire now |
| `packages/core/src/session-profile.ts` | **EDIT** | `BASE_ALLOWED_TOOLS` grows (§5.5-D4); `resolveSessionKind` joins the port (§5.5-D2); `SessionResolutionContext` gains `ultraAnnotated` (§5.5-D3); the fold unions guardrails into `deny` (§5.5-D5) |
| `packages/core/src/index.ts` | **EDIT** | Barrel re-export of any new symbol. The barrel is the package's only public route (`exports` is `{".": "./src/index.ts"}`) |
| `packages/core/test/session-profile.test.ts` | **EDIT** | The `tsc` union pin fires on a `BASE_ALLOWED_TOOLS` change **by design** (§5.6 T-1); `registerFourKinds`'s escalation mirror updates; new fold coverage |
| `packages/core/test/invariants.test.ts` | **EDIT** | `INV-6e` — the mechanical proof of AC1 (§5.5-D15) |
| `_bmad-output/implementation-artifacts/deferred-work.md` | **EDIT** | §5.5-D9's decision must be recorded where the gap was recorded, with its residual and its named owner |

**Anything outside that table is a cross-track finding, not an edit.** The protocol is settled and has run
four times (story 1.1's AC6 finding, 1.2's `sessions/` co-tenancy, 1.3's `mock.module` leak, 2.1's Codex
guardrail gap). **Stop and record it in `deferred-work.md`.** In particular these are **not yours**:

- `apps/web/lib/loom-mcp.ts` and `apps/web/lib/ultra-mcp.ts` — §5.5-D4 explains how core gets the tool-name
  vocabulary **without editing either**. `ultra-mcp.ts` is Track D's column outright (WORK-SPLIT names the
  file). `loom-mcp.ts` is named in **no** track's column — measured, `grep -n "loom-mcp"` over `WORK-SPLIT.md`
  and `ARCHITECTURE-SPINE.md` returns nothing — so it is fenced on §5.5-D4's own reasoning rather than on
  ownership: it holds the tool vocabulary and the moat constants `INV-1g` pins, and a diff there buys nothing
  this story needs.
- `apps/web/lib/permissions.ts` (owns `makeGuardrailDecision`) — you **call** it from a second seam; you do
  not change it.
- `apps/web/components/**` (Track C), `packages/core/src/*` other than the two named above (Track A).

**Track B's write set, verbatim from `WORK-SPLIT.md`:**
`| **B — Session profiles** | apps/web/app/api/chat/route.ts, the profile resolver, Codex MCP injection | — | nothing |`.
"The profile resolver" is why `packages/core/src/session-profile.ts` is yours even though it sits in Track A's
directory — story 2.1 established that reading and it is the reading WORK-SPLIT's own row supports. The
corollary matters more than the entitlement: Tracks D, E and F list *a SessionProfile* in **their** seam
column, so **they must be able to add a session kind without editing your files.** That single sentence is why
2.1 made the catalogue a registry rather than a `switch`, and it is why this story must not re-introduce a
`switch` in the route while removing the `if`s.

---

## 1. User Story

As the maintainer of the chat route,
I want the project session, loom-node session and steerer expressed as profiles,
So that no session-kind conditional remains in the handler and the cleanup is real rather than aspirational.

**Why this story exists, in one paragraph.** Story 2.1 landed the port *additively*: the route resolves a
`SessionProfile` for every request and consumes **only** the capability gate. Every other field —
`cwd`, `guardrails`, `settingSources`, `toolPolicy`, `systemPromptAppendix` — is currently computed a second
time, inline, by three role-derived booleans inside a 1985-line handler. That is worse than not having the
port at all: it is two sources of truth for the shape of a session, one of which is decorative. `AD-9`'s
promise is *"a new surface adds a profile; it does not add an `if`"*, and three epics (4, 5, 6) are queued to
add a fourth, fifth and sixth session kind against exactly this handler. Until the existing kinds resolve
through the resolver, the promise is aspirational and the next kind lands as a fourth `if`.

**What is already true, and is why this is a retrofit rather than an invention.** `manifest.root` already
feeds `cwd`, `guardrails` and `settingSources` for both providers, through the single expression
`const workspace = manifest.root`. Those three are literally AD-9's first three profile fields. The
`allowedTools`/`disallowedTools`/`systemPrompt` triple is already a pure function of the session kind — it
just happens to be spelled as a ternary chain. You are renaming a computation the handler already performs,
not inventing a new one. The one thing you are genuinely *adding* is the **place where the kind is decided**
(§5.5-D1), because today it is decided inside the stream closure and the profile is resolved outside it.

---

## 2. Acceptance Criteria

AC1–AC4 are **verbatim** from `_bmad-output/planning-artifacts/epics.md` § "Story 2.2: Retrofit the existing
session kinds onto profiles". AC5 is verbatim from the `⚠️ Preserve from story 1.1` block that `epics.md`
attaches to this story. AC6 is **story-added**, sourced from the CONFIRMED finding that story 2.1's review
formally assigned to this story (`deferred-work.md` § "Deferred from: 2-1-the-sessionprofile-resolver"). The
`**Given/When/Then**` text is the contract; the `Proof` and `Notes` lines are this story's and are how a
reviewer will check it.

### AC1 — no session-kind conditional remains in the handler

**Given** the chat route after this story
**When** it is read
**Then** no session-kind conditional remains in the handler — every kind resolves through the story 2.1
resolver

**Proof.** Two layers, because a prose claim about a 1985-line file is not checkable.
1. **Mechanical**: `INV-6e` in `packages/core/test/invariants.test.ts` scans `ROUTE_SRC.code` (comments
   blanked — never `.text`, §5.6 T-4) and asserts that none of `isPlannerSession`, `isSteererSession`,
   `isEscalationSession` appears, **and** that the route reads `sessionProfile.toolPolicy`,
   `sessionProfile.guardrails`, `sessionProfile.cwd`, `sessionProfile.settingSources` and
   `sessionProfile.systemPromptAppendix`. The second half is the anti-vacuity floor: deleting the three
   identifiers *and* not consuming the profile would otherwise pass.
2. **Human**: the Debug Log records `git diff` of every removed conditional with the profile field that now
   carries its decision, one row per removal.

**Notes.** "Session-kind conditional" means a branch whose predicate is *which kind of session this is*. It
does **not** mean every `if` in the file. Explicitly **out of scope and staying** (§5.5-D16): the
provider fork (`if (provider === "codex")` — a *provider* dimension, not a kind), the escalation-kickoff
message substitution (`isEscalationKickoff` / `resolveEscalationMessage`, which select the **text of turn 1**,
not session configuration, and already live behind a pure lib seam), and value-shaped conditionals such as
`sessionProfile.systemPromptAppendix ? {…append} : {…}` (a branch on *emptiness*, which is exactly the shape
`ultraAnnotationNote ? … : …` already had).

### AC2 — the project session's shape comes from the profile by construction

**Given** the project session
**When** its profile resolves
**Then** `manifest.root` maps onto the profile's `cwd`, `guardrails` and `settingSources` by construction, not
by rewritten behavior

**Proof.** `const workspace = manifest.root` is **deleted** from `route.ts` and every one of its five
consumers reads `sessionProfile.cwd` instead (measured consumers at `cbbac0a`: the two
`makeGuardrailDecision` calls, `runCodexTurn`'s `cwd`, `query()`'s `cwd`, and
`buildEscalationContext(loomId, workspace)`). `manifest.guardrails.disallowedTools` is **deleted** from the
`disallowedTools` array and arrives via `sessionProfile.toolPolicy.deny` (§5.5-D5). The literal
`settingSources: ["project", "local"]` is **deleted** and arrives via `sessionProfile.settingSources`.
"By construction" is the operative phrase: the fold in `resolveSessionProfile` already sets
`cwd: ctx.manifest.root` and already unions the manifest's guardrails — you are **removing** the second
computation, not writing a new one.

**Notes.** After this AC, `manifest` is still needed in the route (the account-resolution 400 reads
`manifest.account` and `manifest.name`, and the profile context takes the whole manifest). Do not delete the
variable; delete the *derived* ones.

### AC3 — identical behaviour on both providers

**Given** a real session on **both** providers (Claude and Codex)
**When** it runs after the migration
**Then** it behaves identically to before — same tools, same guardrails, same streaming

**Proof.** Three layers.
1. **Per-kind equivalence table** (§6.2-A): for each of the four kinds, the resolved profile's
   `toolPolicy.allow`, `toolPolicy.deny`, `guardrails`, `settingSources`, `cwd` and `systemPromptAppendix` are
   asserted against values **re-derived from the same source constants the route used before**
   (`BASE_ALLOWED_TOOLS`, `LOOM_AUTO_TOOLS`, `ULTRA_AUTO_TOOLS`, `LOOM_ESCALATION_READONLY_TOOLS`,
   `LOOM_ESCALATION_DISALLOWED_TOOLS`, the three prompt constants) — never against a restated literal. A
   restated literal is a copy of a measurement, and a copy goes stale in silence; that is precisely how
   `allow: []` shipped in 2.1.
2. **Dev-server proof** (below), on both providers, with a real tool call.
3. **The one disclosed exception**, stated here because AC3 says *identical* and one thing is not:
   §5.5-D12 — sharpening kind detection to match the route's own precedence means a **resumed** planner
   or steerer chat on a **Codex** account now returns the pre-SSE 400 instead of a 200 that
   silently drops the thing that made it that kind of session.
   _(**Corrected in the review fix round, 2026-07-26.** This line and §5.5-D12 both said "planner, steerer
   or escalation". **Escalation cannot take the new 400**, measured: `resolveSessionKind`'s escalation rung is
   `input.role === "escalation" && input.loomId`, which gates on the **wire** role, so a resumed escalation
   chat whose client omits `role` still resolves to `project` exactly as it did before — the old
   `isEscalationSession = role === "escalation" && !!loomLink.loomId` had the identical requirement. The port
   is faithful; the disclosure was not. See §9's Review Fix Round.)_ That is the completion of story 2.1's AD-11
   gate, not a new policy: 2.1 already 400s those kinds when the client sends `role`. It fails **loudly in
   place of failing silently**, and it must be asserted, disclosed in the Completion Notes, and named in the
   commit message.

### AC4 — an unknown project still 400s before any stream opens

**Given** an unknown or missing project
**When** a project-session request arrives
**Then** it still returns the existing plain 400 before any stream opens

**Proof.** The `getProject(project).manifest` try/catch and its
`Response.json({ error: \`Unknown project "${project ?? ""}".\` }, { status: 400 })` are **byte-identical**
after your diff, and remain the **first** of the pre-stream checks. `INV-6c` continues to assert
`resolveSessionProfile(` < `new ReadableStream(` and `unmetCapabilities(` < `registerChatRun(` — and your
hoist (§5.5-D1) adds new statements into that window, so re-read `INV-6c` before you move anything.

**Notes.** The pre-stream sequence is a **validated order**, not an accident. Two placement rules from 2.1's
own comment survive verbatim and constrain where your hoisted `getChat`/`getLoom` reads may go: the
capability gate must precede `registerChatRun` (whose only cleanup is `endChatRun` inside the stream's
`finally` — a 400 after it leaves a registered run with no stream to end) and must precede `titlePromise`
(which spawns a real subprocess likewise only awaited or aborted in that same `finally`). Your hoisted reads
go **before** the resolve call, which is already before both.

### AC5 — the `done` payload's `costUsd` stays a ledger projection (story-added; sourced verbatim from `epics.md`)

**Given** the migrated route
**When** a turn completes
**Then** the `done` SSE payload still sends
`costUsd: capturedSession ? sessionSpendUsd(capturedSession) : lastResult.totalCostUsd` — the **session's
ledger total, not the turn's delta**

**Proof.** `git diff` over `route.ts` shows the expression unchanged, and the Debug Log states it explicitly.

**Notes.** `epics.md` carries this as a `⚠️ Preserve from story 1.1` block **on this story**, verbatim:
*"Do not restore `lastResult.totalCostUsd` while migrating onto profiles: that silently converts the readout
back into an independent counter and makes story 1.1's AC6 false again."* This is AD-18 — every spend readout
is a **projection** over the one ledger, never an independent counter. Note the trap shape: the safe-looking
edit is a *revert*, and a large refactor of this file is exactly the context in which someone "tidies" an
expression back to its simpler-looking predecessor.

### AC6 — the Codex guardrail gap is closed where it is closable and owned where it is not (story-added)

**Given** a project whose `telar.yaml` sets `guardrails.disallowedTools` or `guardrails.protectedPaths`
**When** a **Codex** session requests an approval
**Then** the profile's guardrails are consulted before the permission card is shaped, and a guardrail-denied
action is declined without a card

**And given** the part of the gap that cannot be closed at that seam
**Then** it is recorded in `deferred-work.md` with the residual stated precisely and a **named owner**

**Proof.** `makeGuardrailDecision` acquires a **third** call site, inside `onCodexApproval`, reading
`sessionProfile` and `sessionProfile.cwd`. A unit test drives a guardrail-denied and a guardrail-allowed
input through that decision. `deferred-work.md`'s 2-1 entry is amended in place (§5.5-D9) with what this story
closed, what it did not, and who owns the remainder.

**Notes.** Story 2.1's review confirmed the gap and assigned it here **or** to the Codex MCP-injection work.
§5.5-D9 makes the call explicitly and does **not** leave it unowned. Candidate fix (b) from `deferred-work.md`
— making the `project` profile require `tool-allow-deny-lists` — is **forbidden**: it 400s every Codex project
session and contradicts AC3 and AC4 of this very story. Do not reach for it. §5.5-D10.

### Dev-server proof

`epics.md`, verbatim: *"`bun run dev`, open a project session on each provider, send a turn that calls a tool
— both stream and complete exactly as before the change."*

The Debug Log must carry, for **each** provider: the account used, the tool that ran, the permission card (or
its absence) and why, the `done` payload's `costUsd` value with a note that it is the session total, and the
absence of a stream error. Then, on Claude only, one turn per remaining kind — a planner session (loom
planning), a steerer session (a loom's Chat tab) and an escalation session (a `blocked` loom's "Discuss with
the orchestrator") — each showing that the kind-specific guidance is still present in the model's behaviour.
`bun run dev` in `apps/web` defaults `TELAR_HOME` to `~/.telar-dev`; **confirm that before you start**, and
never point it at `~/.telar`.

---

## 3. Scope fences — what this story does NOT do

| Not in scope | Why, and who owns it |
| --- | --- |
| Building the `mcpServers` set from the profile | §5.5-D8. It is **not** a session-kind conditional today (measured: `{ loom, ultra, ...resolveProjectMcpServers(project) }` is unconditional), and constructing it requires closures over in-stream mutable state (`getSessionId: () => capturedSession`). The field stays `{}`. Epic 5's master profile is the owner |
| Making the `project` profile require any capability | §5.5-D10. It would 400 every Codex project session, contradicting AC3 and AC4. Explicitly forbidden |
| Fixing the Codex sandbox's lack of per-path granularity | §5.5-D9's residual. Owner: **story 5.5** (`5-5-handoff-external-sources-codex-mcp-injection-and-the-workspace-prove-run`) |
| Fixing the `mock.module("@telar/core")` leak in `apps/web/lib/loom-mcp.*.test.ts` | Recorded on story 1.3; a hygiene defect in files this story does not otherwise touch. Fence it, do not fix it (hard rule 8) |
| Editing `bunfig.toml` | Unresolved `[Review][Decision]` on story 1.1. Hard rule 5 |
| Adding a route, or a per-kind route | `NFR-RF-4`: *"One route, one resolver, one guardrail. Separate routes per session kind are rejected — a moat enforced in three places has three chances to be forgotten."* |
| Refactoring the SSE event vocabulary, the transcript flattening, the permission-card contract, or persistence | Track C owns the client; none of it is a session-kind conditional. Leave it alone |
| Extracting the whole `query()` options object into a testable helper | Tempting, and rejected: it is a redesign the dispatch note warns against, and §6.2's per-kind table plus `INV-6e` give the same signal for a fraction of the blast radius |
| Adding a `KNOWN_VIOLATIONS` entry | Hard rule 6 |
| Resolving story 1.1's five open `[Review][Decision]` items | The human's, all five, still |

---

## 4. Tasks / Subtasks

Five legs. **Leg A before Leg B before Leg C** — the core port must be able to express the values before the
builders can carry them, and the builders must carry them before the route can read them. Legs D and E close
the story.

### Leg A — the port can express what the route needs (AC1, AC2, AC3)

- [x] **A1. Read, in full, before writing anything**: `packages/core/src/session-profile.ts`,
      `apps/web/lib/session-profiles.ts`, `packages/core/test/session-profile.test.ts`,
      `apps/web/lib/session-profiles.test.ts`, `packages/core/test/invariants.test.ts`'s `INV-1g` and `INV-6`
      blocks, and `apps/web/app/api/chat/route.ts` end to end. §5.3 says what to look for in each.
- [x] **A2. Measure the BEFORE table.** Re-derive §5.5-D13's per-kind allow/deny/appendix from `route.ts` as
      it stands **right now**. Record the measurement in the Debug Log with the symbol you read it from. If it
      differs from §5.5-D13, **your measurement wins** and you say so in the Completion Notes.
- [x] **A3. Grow `BASE_ALLOWED_TOOLS`** (§5.5-D4). Add core-owned `as const` tuples for the loom and ultra
      auto-run tool names and fold them into the base tuple. Keep `as const` and **no** type annotation — the
      literal types are the whole mechanism behind 2.1's AC3. `mcp__loom__start_loom` and
      `mcp__loom__answer_blocked` **must stay outside the union**; that is a moat property, not an omission,
      and it gets its own assertion.
- [x] **A4. Add `resolveSessionKind` and `sessionRoleFromWire`** to the port (§5.5-D2, which gives both
      signatures literally). `resolveSessionKind` takes `{ role, linkRole, loomId }` — the **merged**
      `loomLink.role`, not the raw persisted role — and reproduces the route's precedence
      (escalation > steerer > planner > project). Keep `sessionKindFromRole`; it is the wire narrowing and is
      still correct for what it does.
- [x] **A5. Extend `SessionResolutionContext`** (§5.5-D3) with `ultraAnnotated: boolean`, and **rewrite the
      `loomId` field's comment**: after this story it is a *validated* loom id (the route resolves and
      validates it pre-stream), which is the exact opposite of what the comment says today. A stale comment on
      a security-adjacent field is a defect.
- [x] **A6. Union the manifest's `disallowedTools` into the resolved `toolPolicy.deny`** (§5.5-D5), so a
      consumer reads one field and cannot drop half the deny set. Update the fold's header comment to say why
      the redundancy with `guardrails.disallowedTools` is deliberate (AD-1's "enforced twice", one level down).
- [x] **A7. Barrel** — export every new symbol from `packages/core/src/index.ts`, matching the existing AD
      banner style.
- [x] **A8. Update `packages/core/test/session-profile.test.ts`.** Non-negotiable items: the `tsc` union pin
      (§5.6 T-1), `registerFourKinds`'s escalation mirror, new coverage for `resolveSessionKind`'s precedence,
      for the `deny ⊇ guardrails.disallowedTools` fold, and for the moat property in A3. **Do not rename any
      of the five test titles `INV-6` cites** (§5.6 T-2).

### Leg B — the builders carry the real decisions (AC1, AC2, AC3)

- [x] **B1. Create `apps/web/lib/session-prompts.ts`** (§5.5-D6): move `PLANNER_SYSTEM_PROMPT`,
      `STEERER_SYSTEM_PROMPT`, `ESCALATION_SYSTEM_PROMPT`, the Ultra annotation note text, `tail`, `safeRead`,
      `buildSteererContext` and `buildEscalationContext` out of `route.ts` **byte-identically**. Moved text is
      moved, not rewritten: `git diff` must show the prompt bodies unchanged. Add a WHY header (§5.4-A) saying
      what the module is and why it is not in `route.ts` any more.
- [x] **B2. Make the live-context assembly fail-safe** (§5.5-D7). It now runs **pre-stream**, where a throw is
      a 500 instead of an SSE `error`. `getLoom` returns `null` rather than throwing and both readers are
      already guarded, but the composition must be belt-and-suspenders: a failure degrades to the static
      prompt, never to a 500. Test it with an injected throwing reader or an id that resolves to nothing.
- [x] **B3. Fill in the four builders** in `apps/web/lib/session-profiles.ts` from the A2 measurement:
      `toolPolicy.allow` (omit for the three non-escalation kinds — an absent `allow` means the whole base
      set, which is the measured truth), `toolPolicy.deny`, and `systemPromptAppendix`. Every value carries a
      comment naming the symbol it was measured from.
- [x] **B4. Update `apps/web/lib/session-profiles.test.ts`.** The `D11` table's four `""` appendices and the
      three-name escalation `allow` were written as **deliberate tripwires** and they fire now
      (`deferred-work.md`: *"will fail loudly the moment they change — which is the intended tripwire"*).
      Replace them with re-derived expectations, keeping the existing re-derivation idiom. Add the anti-drift
      test pinning core's new tool-name tuples against `LOOM_AUTO_TOOLS` / `ULTRA_AUTO_TOOLS` from the web
      modules (§5.5-D4) — this is what makes the duplication safe without editing either web module.
- [x] **B5. Create `apps/web/lib/session-prompts.test.ts`** — the appendix composition per kind, the Ultra
      note's presence/absence, and B2's fail-safe.

### Leg C — the route reads the profile and stops branching (AC1–AC5)

- [x] **C1. Hoist the kind decision pre-stream** (§5.5-D1): move `resumeTarget`, `existingChat`, `wireLoomId`
      and `loomLink` out of the `new ReadableStream` closure into the preamble, **above** the
      `resolveSessionProfile` call. Verified safe at `cbbac0a`: every consumer of all four is lexically later
      than the resolve site, and `loomLink` must stay the **same mutable object** the loom MCP server narrows
      during the turn — create it earlier, do not freeze it or copy it. **§5.6 T-13 applies here and nowhere
      else**: hoist these four for the kind decision and for nothing else. Do not let `existingChat` start
      feeding model defaults, permission mode or account resolution while you are in the neighbourhood — each
      would be a new behaviour riding along inside a refactor.
- [x] **C2. Feed the sharpened kind + `ultraAnnotated` into `resolveSessionProfile`**, and delete
      `isPlannerSession`, `isSteererSession`, `isEscalationSession`.
- [x] **C3. Drive `query()` from the profile**: `cwd`, `settingSources`, `allowedTools`, `disallowedTools`,
      `systemPrompt`. §5.5-D11 has the target shape. **Do not touch** `permissionMode`, `canUseTool`,
      `hooks`, `strictMcpConfig`, `mcpServers`, `maxTurns`, `includePartialMessages`, `forwardSubagentText`,
      `abortController`, `model`, `effort`, `env`, `resume`.
      **Then remove the now-dead imports.** After this task `LOOM_AUTO_TOOLS`,
      `LOOM_ESCALATION_READONLY_TOOLS`, `LOOM_ESCALATION_DISALLOWED_TOOLS` and `ULTRA_AUTO_TOOLS` have **zero**
      use sites left in `route.ts` (measured at `cbbac0a`: each is used only inside the two tool arrays you are
      deleting). `grep` for each before you move on — `bun run lint` at E1 will otherwise fail on this exact
      file, mid-way through proving AC1. **Keep** `LOOM_START_TOOL`, `LOOM_ANSWER_BLOCKED_TOOL` and the
      `LoomSessionLink` type: the first two are the moat constants `INV-1g` pins by import, the third types
      `loomLink`.
- [x] **C4. Drive both `makeGuardrailDecision` call sites from the profile** — `sessionProfile` and
      `sessionProfile.cwd` in place of `manifest` and `workspace`. Then delete `const workspace`.
- [x] **C5. Drive the Codex branch's `cwd` from the profile**, and add the third `makeGuardrailDecision` call
      site inside `onCodexApproval` (AC6, §5.5-D9).
- [x] **C6. Verify `INV-1g` and `INV-6c` still pass without editing them.** Both scan this file by literal
      substring. `INV-1g` needs `LOOM_START_TOOL`/`LOOM_ANSWER_BLOCKED_TOOL` imported from `@/lib/loom-mcp`,
      the `input.tool_name === <CONST>` comparison form, `hooks: { PreToolUse: …`, and `preToolUseGuardrail`
      — none of which you are changing, but a "tidy" of the hook block would break it. `INV-6c` needs
      `resolveSessionProfile(` < `new ReadableStream(`, `unmetCapabilities(` < `registerChatRun(`, and the bare
      `import "@/lib/session-profiles";` present in `.code`.
- [x] **C7. Correct the false comment** above `ultraMcpServer` (§5.5-D17): it claims the ultra server is
      *"excluded from mcpServers"* for an escalation session. It is not — `mcpServers` is unconditional; only
      its **tools** are denied. A comment that misstates a moat-adjacent fact is worse than no comment.
- [x] **C8. Confirm AC5** — `git diff` the `done` payload's `costUsd` expression and paste it into the Debug
      Log unchanged.

### Leg D — the proofs (AC1, AC3, AC6)

_Task ids here are `V*` (verification), not `D*` — `D1`–`D17` are the design decisions in §5.5._

- [x] **V1. Add `INV-6e`** to `packages/core/test/invariants.test.ts` (§5.5-D15) — AC1's mechanical half, with
      an anti-vacuity floor and a discriminator fixture, in the house failure-message register (the diagnosis
      is built into the asserted value; no `expect` message argument — measured: no test in this repo passes
      one).
- [x] **V2. Write the per-kind equivalence table** (§6.2-A), re-deriving every expectation from source
      constants with an anti-vacuity floor on each derived set.
- [x] **V3. Probe every new assertion** (hard rule 7). Numbered `P1…Pn` in the Debug Log: what you broke, the
      real failure text, the restore, the empty `git diff --stat`.
- [ ] **V4. Run the dev-server proof** on both providers plus the three Claude-only kinds. Debug Log per §2.
      **DELIBERATELY NOT COMPLETE — left unticked on review, 2026-07-26.** The free half ran and is recorded
      (Debug Log item 5): the rewritten route loads under the real bundler, and eleven live pre-stream
      requests were driven through the real handler. The **billable** half — a real turn calling a real tool
      on each provider, plus one turn per Claude-only kind — was never run, because it spends the operator's
      money and this story ran unattended overnight with no human to supervise it. It is **outstanding for
      the operator**, enumerated as three steps at the end of Debug Log item 5. It had been ticked `[x]` with
      the qualification living only in the Debug Log, so a reader scanning Leg D saw four discharged V-items
      and concluded AC3's proof layer 2 was met. The checkbox now says what the prose always said.

### Leg E — the gate and the record

- [x] **E1. The manual pre-commit trio**, from `project-context.md` (there is **no CI**): `bun test` (repo
      root, unfiltered — the unfiltered form is green; only `-t` filtering is poisoned), `bunx tsc --noEmit` in
      **both** `packages/core` and `apps/web`, `bun run lint` in `apps/web`. Record before/after counts for
      each; lint is expected to be unchanged (it carries a pre-existing non-zero problem count — measure it,
      do not quote it).
- [x] **E2. Amend `deferred-work.md`** with §5.5-D9's decision: what AC6 closed, and **all three** residual
      holes named separately — the card not firing (`approvalPolicy: "never"` / sandbox-permitted actions), the
      sandbox's lack of per-path granularity, and the file-change shape mismatch that survives even
      `approvalPolicy: "untrusted"`. Name **story 5.5** as owner. A residual written as one hole when it is
      three is the "partial fix that reads as complete" this story exists to refuse. Amend the 2-1
      `systemPromptAppendix` entry too — it is closed by Leg B and should say so rather than reading as open.
      _(**There are FOUR, not three** — the code review found the fourth, and `deferred-work.md` now names it:
      the approval's own `cwd` is captured and never used as the resolution root. See §5.5-D9's correction
      block. This task's instruction is left as written, since it is what was asked at authoring time.)_
- [x] **E3. Completion Notes** — the disclosed behaviour change (AC3 layer 3), the A2 measurement and any
      divergence from §5.5-D13, the decisions you made that this file left to you, and any cross-track finding.
- [x] **E4. `git diff --stat -- bunfig.toml`** prints nothing (hard rule 5). `KNOWN_VIOLATIONS.length` is
      still `1` (hard rule 6).
- [x] **E5. Commit** with a conventional prefix and scope — this diff spans both workspaces, so
      `feat(web)`/`refactor(web)` with a body naming the core half is right; explain **why**, per
      `project-context.md`. **Never commit
      `_bmad-output/implementation-artifacts/orchestrator-run-log.md`** — it belongs to the orchestrator, not
      to this story.

---

## 5. Dev Notes

### 5.1 The architecture rules that bind this story

| Rule | What it obliges you to do here |
| --- | --- |
| **AD-9 — Session config is a resolved profile, not a branch** | **The primary AD.** *"A new surface adds a profile; it does not add an `if`."* This story is the one that makes that sentence true of the handler that exists |
| **AD-10 — The moat sits outside the profile** | The `PreToolUse` guardrail stays wired **outside** the profile and runs for every session. `toolPolicy` stays intersect-only **by its type**. Growing `BASE_ALLOWED_TOOLS` (§5.5-D4) is the one change that could weaken this — which is why the two human-gated tools must stay outside the union and why that gets its own assertion |
| **AD-11 — Missing harness capability fails closed** | *"No silent degradation, ever."* §5.5-D12's sharpened detection is this rule applied where 2.1's under-detection let it slip. §5.5-D9's residual is this rule's honesty requirement: what you cannot enforce, you record |
| **AD-1 — The Human-Accept Moat** | Enforced twice; your change must leave the tool-layer half byte-identical. `INV-1g` is the mechanical check. `mcp__loom__start_loom` and `mcp__loom__answer_blocked` are never in any `allowedTools`, never in any profile's `allow`, and always force-routed to the interactive card in every permission mode |
| **AD-3 — Client-bundle rule** | `apps/web/lib/session-prompts.ts` imports `@telar/core` **runtime** (`getLoom`, `readBundleFile`, `readContract`, `deriveDeliverableSignal`). It must never become reachable from a `"use client"` file. `INV-4` enforces this transitively through value edges |
| **AD-5 / AD-20 — Store ownership** | Compose **no** path off the state root, in any new file. `INV-3a`'s 18-site inventory is exact; a nineteenth site fails it. Everything path-shaped arrives already resolved, on the context |
| **AD-6 — Persisted schemas are core's** | `ProjectManifest["guardrails"]` is reused, never redefined. Applies to the fold's output type |
| **AD-17 — One admission controller** | *"Interactive chat sessions are out of band by design."* Nothing here takes an admission slot |
| **AD-18 — One append-only spend ledger** | AC5. The `done` payload's `costUsd` is a **projection**, never a counter |
| **AD-19 — Load-bearing invariants are executable** | AC1's mechanical half is `INV-6e`. *"Each fails loudly naming the invariant it defends"* |
| **NFR-X-8 / NFR-X-9** | Moat outside the profile; fail closed, fail early |
| **NFR-RF-1** | *"Reuse, never rebuild… Copy the settled expression; do not invent a variant."* Reuse the existing 400 shape, the existing `typecheck()` harness, the existing re-derivation test idiom, `makeGuardrailDecision` as-is |
| **NFR-RF-4** | One route, one resolver, one guardrail |
| **NFR-RF-5** | Nothing user-visible changes except the disclosed 400 in §5.5-D12 |

### 5.2 Files to touch

| File | New / Edit | What goes in it |
| --- | --- | --- |
| `packages/core/src/session-profile.ts` | **EDIT** | Grown `BASE_ALLOWED_TOOLS` + the two new name tuples; `resolveSessionKind`; `ultraAnnotated` on the context; the `deny ⊇ guardrails.disallowedTools` fold; header amendments where its own SCOPE paragraph says "that is 2.2, not this file" |
| `packages/core/src/index.ts` | **EDIT** | One export line per new symbol |
| `packages/core/test/session-profile.test.ts` | **EDIT** | The `tsc` union pin, `registerFourKinds`'s escalation mirror, `resolveSessionKind` precedence, the fold's new deny behaviour, the moat property |
| `packages/core/test/invariants.test.ts` | **EDIT** | `INV-6e` only. Do not touch `INV-1g`, `INV-3*`, `INV-6a–d` or `KNOWN_VIOLATIONS` |
| `apps/web/lib/session-prompts.ts` | **NEW** | The three prompts, the Ultra note, `tail`, `safeRead`, `buildSteererContext`, `buildEscalationContext`, and a fail-safe appendix composer |
| `apps/web/lib/session-prompts.test.ts` | **NEW** | Appendix composition per kind + the fail-safe |
| `apps/web/lib/session-profiles.ts` | **EDIT** | The four builders' real values |
| `apps/web/lib/session-profiles.test.ts` | **EDIT** | The fired tripwires, re-derived; the core↔web tool-name anti-drift pin |
| `apps/web/app/api/chat/route.ts` | **EDIT, LARGE** | Everything in Leg C |
| `_bmad-output/implementation-artifacts/deferred-work.md` | **EDIT** | §5.5-D9's decision and the closed 2-1 appendix entry |

**Read completely before editing, and record for each what it does today, what you change, and what must be
preserved.** This is the step whose omission is the top cause of review cycles in this repo.

- `apps/web/app/api/chat/route.ts` — **1985 lines** at `cbbac0a`. §5.3 item 1 says which regions and why.
- `packages/core/src/session-profile.ts` — 414 lines (`wc -l` at `cbbac0a`), almost all of it argued prose. Its header contains
  **four** forward notes addressed to you by name; find them before you edit around them.
- `apps/web/lib/session-profiles.ts` — 170 lines. Its header lists exactly three fields it left inert for you.
- `packages/core/test/invariants.test.ts` — 2806 lines.
- `packages/core/test/session-profile.test.ts` and `apps/web/lib/session-profiles.test.ts` — both in full.

### 5.3 Read these before you write

1. **`apps/web/app/api/chat/route.ts`, end to end.** Two orienting facts, both measured, both saving you a
   wrong turn: (i) the file has **exactly one export**, `POST`, and **no zod schema for the request body** —
   plain destructuring of `await req.json()` plus hand-written narrowing; (ii) there is no single "session
   kind" switch. There are **two independent branch dimensions**: the **provider** fork and, *inside the
   Claude branch only*, three role-derived flags. Only the second is yours.
   - The **pre-stream preamble**, in order (`≈:285` → `≈:566`): body destructure → `role` narrowing →
     `runId`/`ultraAnnotated` → escalation-kickoff message substitution → project 400 → account 400 →
     account-resolution 400 → account-health 400 → `const provider` → effort 400 → sandbox 400 →
     approvalPolicy 400 → permissionMode 400 → `model` → `const workspace = manifest.root` →
     **`resolveSessionProfile`** → **capability 400** → `abort` + `registerChatRun` → `titlePromise` →
     `new ReadableStream({`. Nine pre-SSE 400s in total, all the same shape.
   - The pre-SSE 400 shape, quoted so you copy it rather than paraphrase it:
     ```ts
     return Response.json(
       { error: `Unknown project "${project ?? ""}".` },
       { status: 400 },
     );
     ```
   - The **in-stream kind block** (`≈:623-689`): `resumeTarget`, `existingChat`, `wireLoomId`, `loomLink`,
     `isPlannerSession`, `isSteererSession`, `isEscalationSession`. Read the comments; they are the definition
     of each kind and the source for §5.5-D1's precedence.
   - The **Codex fork** (`≈:922-1191`). `runCodexTurn` takes exactly
     `{prompt, cwd, env, model, reasoningEffort?, sandbox, resume, signal, approvalPolicy, onApproval}` — no
     `hooks`, no `mcpServers`, no `allowedTools`/`disallowedTools`, no `settingSources`, no `systemPrompt`.
     Note what it **does** have: interactive approval, via `onCodexApproval`, which reuses
     `createPending`/`resolvePending` and the same permission-card SSE contract. That callback is AC6's seam.
   - The **Claude `query()` options** (`≈:1235-1388`). This block is what you are driving from the profile.
     Read the long comment above `settingSources` — it records the deliberate trust decision that a repo's own
     `settings.local.json` can widen its access, and names `disallowedTools` as *"the one lever we have."*
     That is why §5.5-D5 routes the manifest's deny set through `toolPolicy.deny` rather than dropping it.
   - The `done` payload's `costUsd` (`≈:1879-1881`). You are **not** editing it (AC5); read it so you know it
     exists and do not "simplify" it.
2. **`packages/core/src/session-profile.ts`, in full.** Four forward notes name this story explicitly: the
   `SCOPE.` paragraph (*"If you find yourself feeding a resolved toolPolicy into the route's `allowedTools`,
   that is 2.2"*), `sessionKindFromRole`'s under-detection note (*"Do NOT 'fix' this by hoisting the route's
   getChat call into the preamble… it is story 2.2's call"*), `BASE_ALLOWED_TOOLS`'s note (*"story 2.2 …
   is where LOOM_AUTO_TOOLS/ULTRA_AUTO_TOOLS join the base union"*), and the
   `DEVIATION FROM THE HOUSE SHAPE` paragraph explaining why the tuple carries `as const` and **no**
   annotation. Every one of them is a decision you are executing, not re-litigating.
3. **`apps/web/lib/session-profiles.ts`, in full**, especially `buildEscalationProfile`'s comment recording
   the `allow: []` failure. That paragraph is the single best statement in the repo of why hard rule 2 exists.
4. **`packages/core/test/invariants.test.ts`** — the top-of-file `THE FIVE LOAD-BEARING INVARIANTS` block, the
   **anti-vacuity rule**, the **self-reference rule** (violation scopes exclude `*.test.ts`; floors run over
   the whole index), the **failure-message rule** (*"the DIAGNOSIS IS BUILT INTO THE ASSERTED VALUE"*), then
   `INV-1g`, `INV-6a–d`, `KNOWN_VIOLATIONS` and `INV-3f`.
5. **`packages/core/test/session-profile.test.ts`** — the `typecheck()` harness (`FIXTURE_PRELUDE`, the
   absolute-path import so the throwaway directory needs no `node_modules`, `--ignoreConfig`), the `Equal<>`
   identity pin, and the two-direction discipline (a fixture that must fail **and** one that must pass).
6. **`apps/web/lib/session-profiles.test.ts`** — the re-derivation idiom
   (`BASE_ALLOWED_TOOLS.filter(t => branchGrants.includes(t))` with an anti-vacuity floor) and the
   `KINDS_AFTER_IMPORT` module-scope capture. Both are the templates for your new assertions.
7. **`apps/web/lib/loom-mcp.ts` and `apps/web/lib/ultra-mcp.ts`** — read-only. You need
   `LOOM_AUTO_TOOLS` (11 names), `LOOM_ESCALATION_READONLY_TOOLS` (6), `LOOM_ESCALATION_DISALLOWED_TOOLS` (9),
   `LOOM_START_TOOL`, `LOOM_ANSWER_BLOCKED_TOOL`, `ULTRA_AUTO_TOOLS` (3). Their comments explain the moat
   reasoning behind each set; the escalation ones are the source for §5.5-D13's escalation row.
8. **`apps/web/lib/permissions.ts`'s `makeGuardrailDecision`** — read-only. Signature:
   `(manifest: { guardrails: { disallowedTools: string[]; protectedPaths: string[] } }, root, toolName, input)`.
   It is **structural**, which is why `sessionProfile` can be passed where a manifest is expected, and it has
   **no concept of which harness is running** — which is why AC6 is a call-site change and not a change to it.
9. **`_bmad-output/implementation-artifacts/deferred-work.md`**, all of it, with the 2-1 section first.
10. **`.../architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md`** §§ AD-9, AD-10, AD-11, plus
    AD-1, AD-18, AD-19, and the `Consistency Conventions` table.

### 5.4 Patterns and conventions — copy these exactly

**A. The WHY header banner.** Multi-paragraph `//` block before the imports, ALL-CAPS section labels, prose
that argues from evidence — a named failure mode, a specific test name, or a measured number. Wrap at ~78–88
columns. Section dividers use `// --- text ---…` or `// ── text ────…`; pick one and be consistent within a
file. `session-profile.ts`'s own labels are the model: `WHAT IT REPLACES.` / `THE TRADE-OFF, stated plainly,
because it is the decision most likely to be re-litigated:` / `SCOPE.` Your new `session-prompts.ts` needs one.

**B. Enumerable tuples.** A closed union is always paired with an `as const` tuple naming every member, so a
test can enumerate the whole space (`ADMISSION_CLASSES`, `SESSION_KINDS`, `PROVIDER_CAPABILITIES`,
`BASE_ALLOWED_TOOLS`). Your new tool-name tuples follow it. **Do not annotate** the ones whose literal types
are load-bearing.

**C. Compile-time claims are proved by running the compiler — but only in `packages/core`.** The two
workspaces differ and the difference is worth knowing:

- `packages/core/tsconfig.json` is `include: ["src"], exclude: ["test", "node_modules"]`, so
  `bunx tsc --noEmit` there **never sees a test file**. A bare `// @ts-expect-error` in
  `packages/core/test/` is *"a comment wearing a test's clothes."* The `typecheck()` fixture harness in
  `session-profile.test.ts` is the only way to make a compile claim there — reuse it, both directions, every
  time. Budget ≈0.35 s per fixture.
- `apps/web/tsconfig.json` is `include: ["**/*.ts", …], exclude: ["node_modules"]`, so **web test files ARE
  type-checked** by `bunx tsc --noEmit` in that workspace (measured; and `session-profiles.test.ts` already
  carries a real `// @ts-expect-error no @types/bun in this workspace` on its `bun:test` import, which only
  makes sense because tsc reads the file). **Consequence you can use**: "`allow: [...LOOM_ESCALATION_READONLY_TOOLS]`
  typechecks against the grown base union" needs no fixture spawn — writing it in
  `apps/web/lib/session-profiles.ts` and running `bunx tsc --noEmit` in `apps/web` **is** the proof. Do not
  spend a `typecheck()` fixture on a web-side claim.

**D. Never mutate `process.env.TELAR_HOME` in the shared test process.** If you need to prove a guard fires
under a hostile env, spawn a child (`spawnSync(process.execPath, [probe], { env: { …, HOME: fakeHome,
TELAR_HOME: "   ", NODE_ENV: "test" } })`) — the pattern is in `track-a-prove-run.test.ts`'s L5. **This story
should need neither**: nothing you write composes a state path.

**E. Anti-vacuity floor + permanent positive control.** Every scan or derived set: measure the count, `throw`
a diagnostic paragraph if it is below a floor, *then* assert. Every discriminator: feed a deliberately-bad
fixture through the **same** function the real assertion uses and prove it is reported. A scan that would pass
over an empty extraction is a scan that will pass forever, silently.

**F. Failure messages carry the diagnosis in the asserted value.** No test in this repo passes a message
argument to `expect` (measured across all core suites). The form is: AD id + THE RULE + CONSEQUENCE + NEXT
STEP, inside a `throw new Error(...)` before the assertion, or embedded in the compared value.

**G. Comment register for moat-adjacent code.** `MOAT:` prefixes on the paragraphs that state a moat property.
Where a decision is likely to be re-litigated, state the rejected alternative and why. Where a value was
measured, name the symbol it was measured from.

**H. No classes. No new dependencies.** Plain functions and object literals. `bun add` is not needed for
anything in this story.

### 5.5 Design decisions already made for you

These are decided. Each records the alternative and why it lost, so you do not spend a day re-deriving it. If
you find a **measurement** that contradicts one, your measurement wins — say so in the Completion Notes and
proceed.

---

#### D1 — The kind must be decided **pre-stream**, which means hoisting `existingChat` and the loom-link validation into the preamble

**The problem.** The profile resolves pre-stream (`INV-6c` asserts it, AC1 of story 2.1 requires it). But the
three booleans that decide the kind are computed **inside** the `new ReadableStream` closure, because two of
their inputs are:

- `existingChat = resumeTarget ? getChat(resumeTarget) : undefined` — a resumed chat's **persisted** role;
- `loomLink.loomId` — a wire `loomId` validated against `getLoom(id)` and `l.project === project`.

So a resumed planner/steerer/escalation session whose client omits `role` currently gets its kind from
`existingChat`, and the pre-stream profile — which sees only the wire `role` — resolves it as `project`. If
you drive `query()` from that profile without sharpening detection, **you silently strip the guidance from
every resumed loom session**. That is the exact silent degradation AD-11 exists to end, reintroduced from the
other side.

> _**Corrected by measurement — review fix round, 2026-07-26: "planner/steerer/escalation" over-states by one
> kind here too, and this is the fourth and last place it appeared.** Only planner and steerer got their kind
> from `existingChat`. **Escalation never did**: the removed `isEscalationSession = role === "escalation" &&
> !!loomLink.loomId` required the **wire** role, and `resolveSessionKind` reproduces that requirement exactly
> — `existingChat` reaches the escalation predicate only through `loomLink.loomId`, never through the role
> half. So a resumed escalation chat with no wire `role` resolved to `project` before this story and still
> does, which means the hoist D1 argues for was never what stood between escalation and correct detection.
> D1's decision is unaffected — the hoist is still required for planner and steerer, which is the whole reason
> it was made. Full reasoning at §5.5-D12's correction block._

**The decision.** Hoist `resumeTarget`, `existingChat`, `wireLoomId` and `loomLink` into the pre-stream
preamble, above the `resolveSessionProfile` call, and resolve the kind from all three inputs.

**Why this is safe, measured rather than assumed.**
- **It adds no read.** `getChat(resumeTarget)` already runs on every resumed turn and `getLoom(rawLoomId)`
  already runs on every turn-1 steerer/escalation seed. Hoisting moves them **earlier in the same request**;
  the "store read added to the hot path" objection that deferred this in 2.1 dissolves on measurement. Say so
  in the Completion Notes — 2.1's comment states the objection and you are answering it.
- **It changes no ordering that matters.** Every consumer of all four values is lexically later than the
  resolve site (measured at `cbbac0a`: `resumeTarget` at the `resume` option; `loomLink` at
  `createLoomMcpServer`, `upsertChatStub` ×2, the two appendices, `appendTurn`; `existingChat` and
  `wireLoomId` nowhere but the block itself). And the three booleans are **already** computed before `query()`
  is called, so moving the decision earlier cannot change what `query()` sees.
- **`loomLink` stays mutable.** The loom MCP server narrows it in place during the turn
  (`draft_bundle_file` lazily sets `loomId`), and `appendTurn` reads it afterwards. Create the **same object**
  earlier; do not freeze it, spread it, or hand the builder a copy that then diverges.
- **Neither read throws.** `getLoom` returns `null` on a malformed/traversal id (measured: it catches and
  returns null rather than 500ing) and `getChat` returns `undefined` for a missing id. A bad or foreign
  `loomId` still fails **safe to a plain session**, exactly as today — it must never become a 400.

**The shape of the preamble afterwards**, so there is no ambiguity about where things land. Everything from
`const model` down to `new ReadableStream` in order:

```ts
const model: string = rawModel ?? (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL);

// Session <-> Loom link, hoisted out of the stream closure by story 2.2 because
// the session KIND is a function of it and the profile resolves before the body.
// Adds no read: getChat already ran on every resumed turn and getLoom on every
// turn-1 steerer/escalation seed — both simply run earlier in the same request.
const resumeTarget = sessionId ?? null;
const existingChat = resumeTarget ? getChat(resumeTarget) : undefined;
let wireLoomId: string | undefined;
if (!existingChat && (role === "steerer" || role === "escalation") && typeof rawLoomId === "string" && rawLoomId) {
  const l = getLoom(rawLoomId);
  if (l && l.project === project) wireLoomId = rawLoomId;   // bad/foreign id fails SAFE, never 400 (T-8)
}
const loomLink: LoomSessionLink = {          // MUTATED IN PLACE later by the loom MCP server — T-7
  loomId: existingChat?.loomId ?? wireLoomId,
  role: existingChat?.role ?? (wireLoomId && (role === "steerer" || role === "escalation") ? role : undefined),
};

const sessionProfile = resolveSessionProfile({
  kind: resolveSessionKind({ role, linkRole: loomLink.role, loomId: loomLink.loomId }),
  provider,
  manifest,
  project: typeof project === "string" ? project : undefined,
  role,
  loomId: loomLink.loomId,        // now VALIDATED — D3
  permissionMode,
  ultraAnnotated,
});

const unmetProfileCapabilities = unmetCapabilities(sessionProfile, provider);
if (unmetProfileCapabilities.length > 0) { /* unchanged pre-SSE 400 */ }

const abort = new AbortController();
registerChatRun(runId, abort);
const titlePromise = …;
const stream = new ReadableStream({ async start(controller) { …
```

Read that against `INV-6c`'s four ordered call sites before you commit to it: `resolveSessionProfile(` <
`new ReadableStream(`, and `unmetCapabilities(` < `registerChatRun(` < `new ReadableStream(`. Nothing above
inserts a call site between them.

**Rejected alternatives.** (a) Resolve the profile a second time inside the stream with a sharpened kind —
two resolutions means two truths and defeats `INV-6c`'s point. (b) Leave detection in-stream and let the
profile stay decorative for resumed sessions — that is the silent-degradation failure above. (c) Move the
resolve call **into** the stream — breaks AC1 of story 2.1 and `INV-6c`.

---

#### D2 — `resolveSessionKind` joins the port; `sessionKindFromRole` stays

The precedence, **measured from the route's own `systemPrompt` ternary chain** (escalation first, then
steerer, then planner, then plain):

```
escalation  ⟸ role === "escalation" && !!loomLink.loomId
steerer     ⟸ loomLink.role === "steerer"
planner     ⟸ role === "planner" || existingChat?.role === "planner"
project     ⟸ otherwise
```

**The signature, decided, so there is no fork.** `resolveSessionKind` takes the **already-merged link**, not
the raw persisted role — the route builds `loomLink` anyway (the MCP server and `appendTurn` both need it), so
re-deriving the merge inside core would duplicate logic that already has one home:

```ts
export function resolveSessionKind(input: {
  readonly role?: SessionRole;      // the narrowed WIRE role
  readonly linkRole?: SessionRole;  // loomLink.role — the merged persisted/wire link role
  readonly loomId?: string;         // loomLink.loomId — VALIDATED (D1/D3)
}): SessionKind {
  if (input.role === "escalation" && input.loomId) return "escalation";
  if (input.linkRole === "steerer") return "steerer";
  if (input.role === "planner" || input.linkRole === "planner") return "planner";
  return "project";
}
```

**Why `linkRole === "planner"` is exactly `existingChat?.role === "planner"`, and not an approximation of it.**
`loomLink.role = existingChat?.role ?? (wireLoomId && (role === "steerer" || role === "escalation") ? role : undefined)`.
The fallback arm can only ever produce `"steerer"` or `"escalation"` — never `"planner"` — so `linkRole` is
`"planner"` **iff** the persisted role is. Verify that reading against the route before you rely on it; if the
fallback ever grows a third arm, this equivalence dies silently.

Note also that `wireLoomId` is itself gated on `!existingChat`, so the merge's precedence (persisted wins over
wire seed) is already inside `loomLink` and does not need restating in core.

**Order is load-bearing and must be preserved.** A session can satisfy two predicates at once — a resumed chat
persisted as `steerer` whose client also sends `role: "planner"` is both `isSteererSession` and
`isPlannerSession` today, and the `systemPrompt` chain resolves it as **steerer**. An unordered `Record` or a
set of independent `if`s would not reproduce that. The ordered fold does. **Test the collision case
explicitly** — it is the one behaviour a careless port silently changes.

Put it in `packages/core/src/session-profile.ts` as a pure function over already-read values (no I/O, no
clock, no seams — matching the module's stated purity). Keep `sessionKindFromRole` exported: it is the correct
wire-only narrowing and other callers/tests use it.

**Also add `sessionRoleFromWire(raw: unknown): SessionRole | undefined`** and collapse the route's eight-line
`rawRole` ternary onto it. This is not optional and the reason is a measurement, not taste: "which strings are
session roles" is currently written **twice** — the route's ternary and core's `sessionKindFromRole` — and
`resolveSessionKind` is about to become a third consumer of the same fact. One home, three readers. It needs a
barrel export (task A7) and one test row; nothing else.

---

#### D3 — `SessionResolutionContext` gains `ultraAnnotated`, and `loomId` becomes a *validated* id

`ultraAnnotationNote` is composed today as `ultraAnnotated && !isEscalationSession ? "…" : ""`. That
`!isEscalationSession` is a session-kind conditional, so the composition moves into the builders — which means
the per-turn Ultra flag must reach them. `deferred-work.md` names this as a required 2.2 change:
*"add the per-turn Ultra annotation to `SessionResolutionContext`."*

**Safe with respect to `INV-6a`**: that invariant pins the field sets of `SessionProfile` and
`SessionProfileSpec`, **not** `SessionResolutionContext`. Adding a context field breaks nothing. Adding a
field to either of the other two does — do not.

`loomId`'s contract inverts. Today its comment reads *"NOT validated pre-stream — the route validates it
inside the stream closure. A builder must not treat this as a resolved loom id."* After D1 the route
validates it **before** the resolve call, and the steerer/escalation builders **must** treat it as resolved,
because they pass it to `buildSteererContext` / `buildEscalationContext`. Rewrite the comment. Consider
passing the **validated** id under a distinct name and keeping the raw wire value out of the context
entirely — a builder that can reach an unvalidated id is a builder that can read another project's loom.

---

#### D4 — `BASE_ALLOWED_TOOLS` grows to the full auto-run vocabulary; core declares the names, a test pins them against the web constants

**The problem.** `toolPolicy.allow` is keyed to `BaseAllowedTool`, derived from the six-name
`BASE_ALLOWED_TOOLS` tuple. The route's real `allowedTools` is six base names **plus** `...LOOM_AUTO_TOOLS`
(11) **plus** `...ULTRA_AUTO_TOOLS` (3) for non-escalation kinds, and `LOOM_ESCALATION_READONLY_TOOLS` (6) for
escalation. If `allow` can only name six of twenty, the route must keep composing the other fourteen — and any
composition it keeps is a place a future profile cannot narrow.

**The decision.** Grow `BASE_ALLOWED_TOOLS` to the full **20**-name auto-run vocabulary. Core declares
`LOOM_AUTO_TOOL_NAMES` and `ULTRA_AUTO_TOOL_NAMES` as its own `as const` tuples and folds them in. The route
then writes `allowedTools: [...sessionProfile.toolPolicy.allow]` with **zero** arithmetic, and `toolPolicy`
becomes the whole truth about tool grants — which is what AD-10 wants it to be.

**The moat bonus, and it is real.** `mcp__loom__start_loom` and `mcp__loom__answer_blocked` are **not** in
`LOOM_AUTO_TOOLS` (both are deliberately excluded — the human-gated commit and the human-gated escalation
write). Keeping them out of the grown tuple makes them **unspellable in any profile's `allow`, enforced by the
compiler**. That is a strictly stronger moat than exists today, and it deserves its own test:
`BASE_ALLOWED_TOOLS` must not contain `LOOM_START_TOOL` or `LOOM_ANSWER_BLOCKED_TOOL`, asserted against the
constants rather than against literals.

**Compose the tuple in the route's own order**: the six base names, then `LOOM_AUTO`, then `ULTRA_AUTO` —
matching `route.ts`'s literal array exactly. `unionOrdered` preserves order and the fold filters without
reordering, so a resolved non-escalation `allow` comes out **byte-identical** to today's `allowedTools`, and
the same is true of escalation's (`LOOM_ESCALATION_READONLY_TOOLS`'s own order survives). Order is irrelevant
to the SDK; it matters because it makes the equivalence assertion a `toEqual` on arrays rather than an
argument about sets.

**Why core may name `mcp__loom__*` strings.** Core already owns the loom domain (`looms.ts`, `tick.ts`) and
the port's own header names this as the sanctioned option: *"either by moving those constants into core or by
parameterising the base set."* These are tool-name **strings**, not an import of web code — the dependency
direction is unchanged.

**Do NOT parameterise the base set.** It is the other option the header names and it is **forbidden here**:
`BaseAllowedTool` is derived *from* the tuple, so a parameterised base widens the element type back to
`string`, over-granting compiles, and `INV-6b`'s
`expect(allow?.type).toBe("readonly BaseAllowedTool[]")` becomes a lie about a dead mechanism.

**Do NOT edit `apps/web/lib/loom-mcp.ts` or `apps/web/lib/ultra-mcp.ts`.** Re-exporting core's tuples from
them would be tidier in the abstract and is **out of your write set** — `ultra-mcp.ts` is Track D's column
outright. Instead, duplicate the names in core and **pin the duplication with a test** in
`apps/web/lib/session-profiles.test.ts` (Track B's file, which already imports from both worlds):

```ts
// Core cannot import apps/web, so the vocabulary is declared twice on purpose.
// This is what makes the duplication safe: drift in either copy indicts the other.
expect([...LOOM_AUTO_TOOL_NAMES].sort()).toEqual([...LOOM_AUTO_TOOLS].sort());
expect([...ULTRA_AUTO_TOOL_NAMES].sort()).toEqual([...ULTRA_AUTO_TOOLS].sort());
expect(LOOM_AUTO_TOOL_NAMES.length).toBeGreaterThan(0); // anti-vacuity
```

This is the same "measured, not restated" idiom the escalation re-derivation test already uses, and it is the
mechanism that would have caught 2.1's `allow: []`.

**Consequence you must plan for:** `INV-1b`'s `MCP_INVENTORY` scans `tool("name", …)` literal registrations in
the three MCP surfaces. You are not changing any registration, so it is unaffected — but confirm, do not
assume. And §5.6 T-1 is the `tsc` pin that fires **by design** on this change.

---

#### D5 — The fold unions the manifest's `disallowedTools` into the resolved `toolPolicy.deny`

Today `disallowedTools` is composed in the route as
`[...manifest.guardrails.disallowedTools, "AskUserQuestion", ...(escalation extras)]`. Three sources, one
array. If the profile carried only the last two, the route would still have to reach for
`manifest.guardrails` — and AC2 says the manifest's mapping is *by construction*.

**The decision.** `resolveSessionProfile` sets
`toolPolicy.deny = unionOrdered(guardrails.disallowedTools, spec.toolPolicy.deny)` (manifest entries first,
preserving the manifest's own ordering, deduplicated — the existing `unionOrdered` contract). The route then
writes `disallowedTools: [...sessionProfile.toolPolicy.deny]`, one field, no composition, no chance of
dropping half the set.

**The deliberate redundancy.** `guardrails.disallowedTools ⊆ toolPolicy.deny` afterwards. Both fields are
consumed, for **different mechanisms**: `guardrails` feeds `makeGuardrailDecision` (our own hook and
`canUseTool`, and the only carrier of `protectedPaths`), `toolPolicy.deny` feeds the SDK's own deny list. That
is AD-1's "enforced twice" applied one level down, and it must be said in the fold's comment or a reviewer
will read it as duplication.

**Equivalence check you must run, because it is the one case where the fold changes the resolved value:** if
`manifest.guardrails.disallowedTools` names a **base tool** (say `"Read"`), the fold's existing "deny beats
allow" filter drops it from `allow`. Today the route passes `"Read"` in **both** `allowedTools` and
`disallowedTools`, and the SDK's documented guarantee (disallow beats any allow) denies it. After the change
it is in `deny` only. **Same outcome, different route to it** — a tool that is neither allowed nor denied
falls through to `canUseTool`, where `makeGuardrailDecision` denies it on the same manifest entry. Assert
this case explicitly; it is the sharpest test of the port's faithfulness.

The escalation extras (`LOOM_ESCALATION_DISALLOWED_TOOLS`, `ULTRA_AUTO_TOOLS`) go in the **spec's**
`toolPolicy.deny`, not in `addDisallowedTools`. `addDisallowedTools` adds to *project guardrails*, which is a
different concept and would also change what `makeGuardrailDecision` denies. Keep the two concepts separate.

---

#### D6 — The three prompts and the two live-context builders move to `apps/web/lib/session-prompts.ts`

`deferred-work.md` states the requirement and the reason it could not be done in 2.1:
`PLANNER_SYSTEM_PROMPT`, `STEERER_SYSTEM_PROMPT` and `ESCALATION_SYSTEM_PROMPT` are **module-private consts
inside a Next.js route module whose only export is `POST`**. A builder cannot reach them, and copying the text
would create a second source of truth for moat-adjacent prompt content.

**The decision.** New module `apps/web/lib/session-prompts.ts` holding, moved **byte-identically**: the three
prompt constants, the Ultra annotation note, `tail`, `safeRead`, `buildSteererContext`,
`buildEscalationContext`. `session-profiles.ts` imports from it. The route imports nothing of it (after Leg C
it has no use for any of them).

**The consequence, stated plainly because it is the one place this story bends a stated property.** A builder
for `steerer` or `escalation` now performs **filesystem reads** (`getLoom`, `readBundleFile`, `readContract`,
`deriveDeliverableSignal`) while composing its appendix. The **core fold stays pure** — it takes an
already-read context and calls a surface-owned function — but a *builder* is no longer pure. That is honest
and correct: the kind→live-context mapping **is** the registry, and any design that keeps the read in the
route puts the branch back in the route. Say it in `session-prompts.ts`'s header and in the builders' comments.

**Rejected alternative.** Pass a pre-computed `loomContext: string` on the context — computing it requires
knowing the kind, so the route would branch to compute it. That is AC1 defeated by indirection.

**Timing note.** The read moves from inside the stream to pre-stream. It is still **once per turn** (one POST
= one turn), so no extra work is done — but see D7.

**Two prose comments go stale and are NOT yours to fix.** `apps/web/lib/escalation-kickoff.ts` and
`apps/web/lib/loom-mcp.ts` both name `ESCALATION_SYSTEM_PROMPT` / `buildEscalationContext` /
`buildSteererContext` in comments that read as if those symbols live in `route.ts`. Neither file is in your
write set and neither comment is load-bearing (no import, no test, no type depends on it). **Record both in
the Completion Notes** as knowingly-stale prose with their new home, so the next reader of either file is not
misled and the next story in those files can fix them in one line. That is the same record-do-not-cross
protocol every cross-track finding in this repo has followed.

---

#### D7 — Appendix assembly must be fail-safe: profile resolution must never 500 the live path

Pre-stream, a throw is a **500 with no SSE frame**. In-stream, it is an `error` event on an open stream. The
live-context readers are already guarded individually (`safeRead` swallows, `deriveDeliverableSignal` is
wrapped, `getLoom` returns `null`), but the **composition** must be too.

**Wrap the live-context read only, not the whole assembly**, so a failure drops exactly the part that failed:

```
appendix = STATIC_PROMPT + safeLiveContext(…) + ultraNote      // steerer
appendix = STATIC_PROMPT + safeLiveContext(…)                  // escalation — never an ultra note (D13)
appendix = STATIC_PROMPT + ultraNote                           // planner — no live read, nothing to fail
```

where `safeLiveContext` returns `""` on any throw. The Ultra note is a pure function of the wire flag and
cannot fail, so it must **survive** a live-context failure — do not wrap it in the same try. Never let the
whole appendix collapse to `""`: that would silently drop the moat language which is the entire content of the
steerer and escalation kinds, and it would be a 500 turned into a silent degradation, which is worse.

Pin both halves in the test (§6.2-E): a throwing reader yields an appendix that **contains** the static
prompt, and — for a steerer with `ultraAnnotated: true` — **still contains** the Ultra note.

The only failure `resolveSessionProfile` may still surface on the live path is an **unregistered kind**, which
means a surface forgot its side-effect import — a genuine programming error that should be loud. Everything
else fails safe.

Test it: a builder whose reader throws still returns a spec whose appendix contains the static prompt.

---

#### D8 — `mcpServers` stays route-owned; the profile's field stays `{}`

**Measured**: `mcpServers: { loom: loomMcpServer, ultra: ultraMcpServer, ...(project ? resolveProjectMcpServers(project) : {}) }`
is **unconditional** — it does not branch on session kind. AC1 therefore does not require moving it, and two
facts make moving it expensive and premature:

1. Building it is a **side effect**, not data: `createLoomMcpServer` and `createUltraMcpServer` capture
   `getSessionId: () => capturedSession`, a closure over a variable that is mutated *inside* the stream by the
   SDK's `system:init` message. A pure builder cannot produce it without the route restructuring how the
   session id is threaded — a change with far more blast radius than this story's own content.
2. The **first** kind that genuinely needs a different MCP set is epic 5's project-less master profile. That
   story is the one with a reason to pay for the restructure.

Leave `mcpServers` omitted in all four specs (resolving to `{}`), leave the route's construction untouched,
and **record it as a disclosed, measured deviation** in the Completion Notes with epic 5 as the forward owner
— exactly as 2.1 recorded its three inert fields. An undisclosed inert field is how `allow: []` survived.

---

#### D9 — The Codex guardrail gap: close the approval seam here, hand the residual to story 5.5

**The confirmed gap** (`deferred-work.md`, 2-1 section): a project's `manifest.guardrails` —
`protectedPaths` and `disallowedTools` — is **silently inert on Codex sessions**. `makeGuardrailDecision` has
exactly two call sites, `canUseTool` and `preToolUseGuardrail`, and both reach the SDK only as `query()`
options, which is called only in the Claude branch. Codex sessions have `sandbox` and `approvalPolicy` and
nothing else. Re-verify by grep before you act on it; do not trust this paragraph.

**Why this story must act at all.** AC2 says the profile's `guardrails` map onto the session *by
construction*. If the Codex branch ignores the profile's guardrails entirely, this story ships a profile whose
most security-relevant field is decorative on half the traffic. That is not a retrofit; that is a rename.

**The decision — close what is closable, here.** Add the **third** `makeGuardrailDecision` call site inside
`onCodexApproval`, before `createPending`:

```ts
// AD-1's tool-layer half, on the one seam the Codex harness has. `sessionProfile`
// (not `manifest`) so the profile's guardrails are what govern BOTH providers —
// AC2's "by construction", applied where it is otherwise silently inert.
//
// Only for a COMMAND approval, and that restriction is measured, not cautious:
// onCodexApproval shapes BOTH request kinds as a "Bash" card (a file change with
// no `command` gets a synthesized `[file change] ${reason}` string), so running
// the check on a file change would deny every file edit in a project whose
// guardrails merely disallow the Bash TOOL — a false positive on a request that
// is not a shell command at all. The file-change branch's residual is recorded
// in deferred-work.md.
if (req.kind === "command") {
  const guardrail = makeGuardrailDecision(sessionProfile, sessionProfile.cwd, "Bash", input);
  if (guardrail.behavior === "deny") {
    send("error", { message: guardrail.message });
    return "decline";
  }
}
```

No card is created for a guardrail-denied action — showing the human a card for something policy already
forbids invites them to approve it. **Verify the client's handling of a mid-turn `error` event before you
commit to `send("error", …)`**: grep `case "error"` in `apps/web/components/session/session-view.tsx`. The
reconnect-tail handler stores it in `streamErrorRef` and does **not** terminate; confirm the main POST
stream's handler behaves the same. If it is terminal, decline silently and leave a `WHY` comment naming what
you measured — the decline is the load-bearing half, the message is the courtesy.

**The residual, stated precisely, because a partial fix that reads as complete is worse than the gap.** Three
distinct holes remain, and all three belong in the `deferred-work.md` entry:

1. **`onCodexApproval` only runs when Codex asks.** With `approvalPolicy: "never"` the callback is not even
   installed (measured: `codex-app-server.ts`'s `onApproval` field comment says it "can be omitted entirely
   for approvalPolicy:'never'"), and for any action the chosen `sandbox` already permits, no approval is
   requested at all.
2. **The sandbox has no per-path or per-tool granularity.** `sandboxPolicy()` maps the three presets to
   `readOnly` / `workspaceWrite{writableRoots:[cwd]}` / `dangerFullAccess`. A `protectedPaths` entry **inside**
   the workspace is still not protected on a `workspace-write` turn.
3. **A file-change approval carries no path — and this hole is live even when the card DOES fire.** Measured
   in `codex-app-server.ts`'s `answerApproval`: the block that populates `command` and `cwd` is guarded by
   `if (!isFile)`, so a `fileChange`/`applyPatch` approval reaches `onApproval` as
   `{ kind: "file", reason?: string }` and **nothing else** — no path, no cwd. `makeGuardrailDecision` can
   therefore check `protectedPaths` two ways and neither works: `inputPaths()` reads `PATH_KEYS`
   (`file_path`/`path`/…), none of which exist here, and `bashTouchesProtectedPath` word-splits
   `input.command`, which for a file change is the synthesized free-text sentence
   `` `[file change] ${reason}` ``. So `protectedPaths` enforcement on a Codex file edit degrades to *"does the
   model's prose reason happen to contain the protected path as a standalone word"* — which is not a check.
   **Call this out by name**: it survives `approvalPolicy: "untrusted"`, the setting an operator would choose
   precisely *because* they expect every action to be gated. Hole (1) is about the card not firing; this one is
   about the card firing and carrying nothing to check. They are different failures and the record must say so.

> **CORRECTED BY MEASUREMENT — review fix round, 2026-07-26: there are FOUR, and this section's own standard
> is the reason that matters.** A fourth hole was found by the code review and is now item 4 in
> `deferred-work.md`'s residual list: **`onCodexApproval` captures the approval's own `cwd` and then never
> uses it as the resolution root.** It builds `input` with `...(req.cwd ? { cwd: req.cwd } : {})` and calls
> `makeGuardrailDecision(sessionProfile, sessionProfile.cwd, "Bash", input)` — the root argument is always the
> **session** root. Nothing reads `input.cwd`: `permissions.ts`'s `PATH_KEYS` is
> `["file_path", "notebook_path", "path"]`, and `bashTouchesProtectedPath` takes `root` as an explicit
> parameter. So a relative command issued from a subdirectory (`rm -rf ../../.env` from
> `/repos/demo/packages/app`, project root `/repos/demo`, `protectedPaths: [".env"]`) resolves to `/.env`,
> matches nothing, and is allowed. Like hole (3) it **survives the card firing** — and unlike hole (3) it
> survives with a real shell command, which is the case holes 1–3 all leave standing. It is neither a
> regression nor Codex-specific: the two Claude call sites have always had it. Not fixed here because the
> repair belongs in `apps/web/lib/permissions.ts`, which §0's write-set table scopes this story to **call and
> not change**. This section wrote its residual as three when it was four — which is the exact shape it warns
> against one paragraph below, and it is recorded rather than quietly renumbered for that reason.

There is no universal pre-tool interception point on the Codex path today; a complete closure needs one, and
building it is not this story. **The disclosure is the deliverable here** — this story's own standard is that
*"a partial fix that reads as complete is worse than the gap"*, and that standard binds the record you leave
as much as the code you write.

**The named owner for the residual: story 5.5**
(`5-5-handoff-external-sources-codex-mcp-injection-and-the-workspace-prove-run`). It is the story that builds
Codex MCP injection — the only queued work that adds plumbing to the Codex path — and `deferred-work.md`
already names "the Codex MCP-injection work" as one of two candidate owners. **Record this in
`deferred-work.md`** (Leg E2): what AC6 closed, the residual above, and story 5.5 by key. Do not leave it
unowned; that is the one outcome this decision exists to prevent.

**A clamp was considered and rejected.** Forcing `approvalPolicy` to at most `"on-request"` when the profile's
guardrails are non-empty would close the `"never"` hole. It is **new policy**, not a retrofit: it changes
Codex behaviour for projects that never asked for it, and it still would not close the sandbox half. Record it
as a candidate for 5.5; do not implement it here.

---

#### D10 — Do **not** make the `project` profile require `tool-allow-deny-lists`

This is candidate fix (b) in `deferred-work.md`, and it is **forbidden**. It would fail every Codex **project**
session closed. Story 2.1's AC5 forbade it; this story's AC3 (*"behaves identically on both providers"*) and
AC4 forbid it again. It also breaks
`packages/core/test/session-profile.test.ts`'s `AC4/AC5 the \`project\` kind requires NOTHING, on BOTH provider ids`
and `apps/web/lib/session-profiles.test.ts`'s
`a project session passes the capability gate on BOTH providers — AC5, unchanged` — two tests written
specifically to stop this. If a future product decision says Codex project sessions should stop working until
the residual lands, that is a decision made in the open, with the operator, not inside a refactor.

The `project` profile's `requiredCapabilities` stays `[]`. This is also what keeps D1's sharpened detection
safe in the one direction that matters: an under-detected session lands on `project`, which requires nothing,
so mis-detection can never produce a spurious 400.

---

#### D11 — What the route's `query()` options look like afterwards

The target shape. Everything not listed is unchanged.

```ts
const q = query({
  prompt: message,
  options: {
    cwd: sessionProfile.cwd,
    ...(resumeTarget ? { resume: resumeTarget } : {}),
    model,
    ...(effort ? { effort: effort as EffortLevel } : {}),
    env: accountEnv(profile),          // AccountProfile — NOT sessionProfile. See below.
    systemPrompt: sessionProfile.systemPromptAppendix
      ? { type: "preset", preset: "claude_code", append: sessionProfile.systemPromptAppendix }
      : { type: "preset", preset: "claude_code" },
    permissionMode,
    settingSources: [...sessionProfile.settingSources],
    allowedTools: [...sessionProfile.toolPolicy.allow],
    disallowedTools: [...sessionProfile.toolPolicy.deny],
    mcpServers: { loom: loomMcpServer, ultra: ultraMcpServer, ...(project ? resolveProjectMcpServers(project) : {}) },
    strictMcpConfig: true,
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUseGuardrail] }] },
    maxTurns: 25,
    includePartialMessages: true,
    forwardSubagentText: true,
    abortController: abort,
  },
});
```

Four things to keep in view:

- **`profile` vs `sessionProfile`.** `profile` in this scope is the **`AccountProfile`** — it feeds
  `accountEnv`, `accountHealth`, `generateTitle`, `savePlanUsage`, `logUsage`'s `account`, and the chat stub's
  `account` field. Shadowing or confusing the two is a **silent billing bug**. 2.1's own comment says this in
  as many words; it applies harder now that you are touching every neighbouring line.
- The `systemPrompt` ternary is a branch on **emptiness**, not on kind — the identical shape the
  `ultraAnnotationNote ? … : …` fallthrough already had, and it is what preserves *"a normal session's
  systemPrompt is byte-for-byte unchanged."*
- `settingSources` and the two tool arrays are **spread copies**. `ProfileSettingSource[]` is
  `Exclude<SettingSource, "user">[]` and is assignable to the SDK's `SettingSource[]`; the readonly arrays need
  spreading into mutable ones.
- The `hooks` / `canUseTool` / `strictMcpConfig` lines are **the moat**. They stay outside the profile, wired
  unconditionally, exactly as they are. `INV-1g` and AD-10 both depend on it, and `strictMcpConfig` is on
  `GRANT_SHAPED_FIELDS` precisely so no profile can ever reach it.

The Codex call becomes `cwd: sessionProfile.cwd` plus D9's guardrail check. Everything else there is unchanged.

---

#### D12 — The disclosed behaviour change

After D1, a **resumed** planner, steerer or escalation chat whose client omits `role` is detected as its real
kind rather than under-detected as `project`. On a **Codex** account those kinds fail the capability gate, so
such a session now returns the pre-SSE 400 where it previously returned 200 and silently dropped the appended
system prompt that **is** the kind.

> **CORRECTED BY MEASUREMENT — review fix round, 2026-07-26. This paragraph over-states by one kind, and the
> shipped code is right while the sentence above is wrong.** Only **planner** and **steerer** are re-detected
> from a resumed chat. `resolveSessionKind`'s escalation rung reads
> `if (input.role === "escalation" && input.loomId)` — the **wire** role, not `linkRole` — so a resumed
> escalation chat whose client omits `role` resolves to `project`, exactly as it did before this story. That
> is a faithful port, not an omission: the removed `isEscalationSession = role === "escalation" &&
> !!loomLink.loomId` had the identical wire-role requirement, and `resolveSessionKind` was written to
> reproduce the route's own precedence rather than to improve on it. Two consequences follow and both are
> recorded rather than acted on. (i) An operator reading the original sentence would believe escalation
> resumes are now gated on Codex; they are not. (ii) Such a session receives the `project` profile — the full
> twenty-name allow set rather than escalation's six read-only tools — which is unchanged by this story and
> unreachable in-app, because `apps/web/components/looms/discuss-escalation.tsx` always sends
> `role: "escalation"` together with the `loomId`. Narrowing the rung to `linkRole` would be a new,
> undisclosed behaviour change and is deliberately **not** made here; it is recorded in `deferred-work.md`
> under this story's review section for whichever story next owns escalation. §5.1's rule applies as written:
> a measurement that contradicts a design note wins, and the note says so rather than being quietly deleted.

This is the completion of story 2.1's AD-11 gate, not a new policy — 2.1 already 400s these kinds when the
client **does** send `role`, and `session-profiles.test.ts` already carries
`planner, steerer and escalation all FAIL on Codex — the disclosed behaviour change`. The under-detection was
2.1's deliberate safe default *given that it could not see `existingChat`*; you can, so the reason is gone.

Requirements: assert it, name it in the Completion Notes, name it in the commit message, and mention it in the
dev-server proof (you do not need to *reproduce* it live — the unit assertion is the proof — but the operator
should learn of it from the record, not from a support question).

Project sessions are untouched on both providers: `project` requires nothing (D10).

---

#### D13 — The measured BEFORE / AFTER table

**Re-derive this yourself (task A2). It is a measurement from `cbbac0a`, not a specification.**

Source sets: `BASE6` = `Read, Grep, Glob, WebSearch, WebFetch, ToolSearch`. `LOOM_AUTO` = the 11 names in
`LOOM_AUTO_TOOLS`. `ULTRA_AUTO` = the 3 in `ULTRA_AUTO_TOOLS`. `ESC_READ` = the 6 in
`LOOM_ESCALATION_READONLY_TOOLS` (`Read, Grep, Glob, mcp__loom__read_bundle, mcp__loom__get_loom,
mcp__loom__list_looms`). `ESC_DENY` = the 9 in `LOOM_ESCALATION_DISALLOWED_TOOLS`. `MG` =
`manifest.guardrails.disallowedTools`.

**BEFORE — what `route.ts` passes today (Claude branch):**

| kind | `allowedTools` | `disallowedTools` | `systemPrompt.append` |
| --- | --- | --- | --- |
| project | `BASE6 ∪ LOOM_AUTO ∪ ULTRA_AUTO` (20) | `MG ∪ {AskUserQuestion}` | `ultraNote` or none |
| planner | same 20 | same | `PLANNER + ultraNote` |
| steerer | same 20 | same | `STEERER + buildSteererContext(loomId) + ultraNote` |
| escalation | `ESC_READ` (6) | `MG ∪ {AskUserQuestion} ∪ ESC_DENY ∪ ULTRA_AUTO` | `ESCALATION + buildEscalationContext(loomId, cwd)` — **no** `ultraNote` |

Unconditional for all four: `cwd = manifest.root`; `settingSources = ["project","local"]`;
`mcpServers = {loom, ultra, ...project}`; `permissionMode` from the wire.

**AFTER — what each builder returns:**

| kind | spec `toolPolicy.allow` | spec `toolPolicy.deny` | `systemPromptAppendix` |
| --- | --- | --- | --- |
| project | **omitted** ⇒ the whole grown base set (20) | `["AskUserQuestion"]` | `ultraNote` or `""` |
| planner | **omitted** ⇒ 20 | `["AskUserQuestion"]` | `PLANNER + ultraNote` |
| steerer | **omitted** ⇒ 20 | `["AskUserQuestion"]` | `STEERER + liveContext + ultraNote` |
| escalation | `[...ESC_READ]` (6) | `["AskUserQuestion", ...ESC_DENY, ...ULTRA_AUTO]` | `ESCALATION + liveContext` |

The fold then adds `MG` to every `deny` (D5) and filters `allow` by `deny`. Resolved
`allow`/`deny` therefore reproduce the BEFORE table's effective grants exactly — with the one route-difference
for a manifest-denied base tool, argued in D5.

**Facts worth pinning while you are here**, because each is a place a careless port drifts:

- Every **non-escalation** kind gets the identical 20, including a plain project session with no loom link. The
  loom and ultra auto-tools are **not** gated on being a loom session; only escalation narrows.
- `escalation` gets **no** Ultra note and **no** ultra tools, but the ultra MCP **server is still constructed
  and passed** (D17).
- `ESC_READ ∩ ESC_DENY = ∅` — the three loom read names are in neither denial set. Verify; do not assume.
- `mcp__loom__answer_blocked` is in **neither** `ESC_READ` nor `ESC_DENY`: it stays *callable-but-human-gated*,
  the only escalation write path. A port that "tidies" it into either set breaks the moat in one direction or
  the surface in the other.

---

#### D14 — How equivalence is proved with no route test

There is no test file for `route.ts` and this story does not create one (a Next.js route module exporting only
`POST`, whose body constructs in-process MCP servers and drives a real subprocess, is not unit-testable
without a redesign this story explicitly refuses). The compensating stack, in order of strength:

1. **The per-kind equivalence table** (§6.2-A) — asserts the *profile* reproduces what the route used to build,
   re-derived from the same constants. This is the strongest available signal and it is where you spend effort.
2. **`INV-6e`** — asserts the route *consumes* those fields and no longer names the three flags. Together with
   (1), "the profile is right" + "the route reads the profile" ≈ "the route is right".
3. **`INV-6c` / `INV-1g`, unchanged** — the ordering and the moat wiring survive the rewrite.
4. **The dev-server proof** — the only end-to-end evidence, on both providers, with a real tool call.

State this stack in the Completion Notes with its limits. An over-claimed proof is worse than a scoped one.

---

#### D15 — `INV-6e`, and what not to touch in `invariants.test.ts`

Add exactly one new test to the existing `INV-6` describe block, in the house register:

- **Absence half**: `ROUTE_SRC.code` contains none of `isPlannerSession`, `isSteererSession`,
  `isEscalationSession`.
- **Presence half (the anti-vacuity floor)**: it contains `sessionProfile.toolPolicy`,
  `sessionProfile.guardrails`, `sessionProfile.cwd`, `sessionProfile.settingSources`,
  `sessionProfile.systemPromptAppendix`. Without this, deleting the three identifiers *and* the profile
  consumption passes.
- **Discriminator**: run the same predicate over an assembled-at-runtime fixture string containing a
  session-kind flag and prove it is reported. Assemble it with string concatenation, never as a literal —
  `packages/core/test` is one of this scanner's own roots and a literal would make the file a fixture for
  itself (the `"Session" + "Profile"` idiom `INV-6d` already uses).
- **`.code`, never `.text`** — §5.6 T-4.

**Do not touch**: `INV-1g`, `INV-3a`, `INV-3f`, `KNOWN_VIOLATIONS`, `AD5_SITES`, `SANCTIONED_ROOT_RESOLVERS`,
`INV-6a`, `INV-6b`, `INV-6c`, `INV-6d`, or the `PROFILE_FIELDS` / `SPEC_FIELDS` / `GRANT_SHAPED_FIELDS`
arrays. Nothing in this story adds a field to `SessionProfile` or `SessionProfileSpec`; if you find yourself
editing `PROFILE_FIELDS`, stop — you have designed something AD-10 forbids.

Budget: `invariants.test.ts` states its own **2000 ms** ceiling in-source (`INV-6`'s citation message: *"a
tsc spawn costs ~0.35 s against a 2000 ms budget"*); story 1.3 recorded it running well inside that — measure
it, do not quote a figure. `INV-6e` is a substring scan over one already-indexed file; it costs nothing.
**Do not add a `tsc` invocation to this file** — that is why `INV-6` cites `session-profile.test.ts`'s compile
pins instead of re-running them.

---

#### D16 — What stays a conditional, and why that is not an AC1 miss

State each of these in the Completion Notes so a reviewer does not read them as misses:

- **`if (provider === "codex")`** — a *provider* dimension, not a session kind. AD-11's whole design is that
  providers differ and profiles declare what they need; collapsing this fork is not this story and is not
  anything.
- **`isEscalationKickoff` / `resolveEscalationMessage`** — role-driven, but they select the **text of turn 1**
  and whether a user bubble renders. That is turn shape, not session configuration; they are already behind a
  pure, unit-tested lib seam (`@/lib/escalation-kickoff`), and no `SessionProfile` field expresses "what the
  first prompt should be".
- **`sessionProfile.systemPromptAppendix ? … : …`** — a branch on emptiness, identical in shape to the
  `ultraAnnotationNote` fallthrough it replaces.
- **`...(resumeTarget ? { resume } : {})`, `...(effort ? { effort } : {})`, `...(project ? resolveProjectMcpServers(project) : {})`**
  — presence branches on request fields.
- **`loomLink`'s own construction** — it resolves the *link*, which is persisted state the chat store owns; the
  profile consumes its output. It is the input to kind resolution, not a kind conditional.

---

#### D17 — Correct the false comment above `ultraMcpServer`

Measured: the comment claims the ultra server is *"Not offered to an escalation session (excluded from
mcpServers/allowedTools below…)"*. The `mcpServers` record is **unconditional** — `ultra` is present for an
escalation session; only `ULTRA_AUTO_TOOLS` are added to `disallowedTools`, which makes the tools uncallable
while the server is still registered. Behaviourally equivalent, but the comment misstates a moat-adjacent
fact, and this story is the one that reads that comment while deciding what `mcpServers` should carry. Fix
the comment; change no behaviour. Note it in the Completion Notes as a measurement, not as a bug fix.

---

### 5.6 Traps

**T-1 — The `tsc` union pin fires on `BASE_ALLOWED_TOOLS`, by design.**
`packages/core/test/session-profile.test.ts`'s `AC3 an \`allow\` naming a tool outside the base union does NOT typecheck`
asserts the compiler diagnostic contains the **whole rendered union**:
`'"Read" | "Grep" | "Glob" | "WebSearch" | "WebFetch" | "ToolSearch"'`. Its own comment says why: *"a change to
`BASE_ALLOWED_TOOLS` surfaces here rather than leaving a stale proof green."* Growing the tuple to 20 breaks
it — **that is the tripwire working**, not a regression. Two things:
- **Re-measure the real diagnostic.** TypeScript elides long unions (`… 14 more …`). Run the fixture, capture
  what `tsc` actually emits, and re-pin against that. If it elides, keep the assertions that still discriminate
  (the offending tool name, `ToolPolicy`, and at least two base members) and move the "the union is exactly
  these N names" claim to a **runtime** set-equality assertion in the same file, so the property is still
  pinned somewhere executable.
- **Do not rename the test.** `INV-6` cites five `session-profile.test.ts` titles by exact string; this is one
  of them. Renaming it fails `INV-6 the compile pins this invariant CITES still exist`.

**T-2 — The five cited test titles are load-bearing strings.** They are:
`AC3 an \`allow\` naming a tool outside the base union does NOT typecheck`;
`AC3 the SAME fixture with a base tool DOES compile, with empty output — the discriminator`;
`AC3 ToolPolicy is EXACTLY { deny, allow? } — adding a field breaks this compile`;
`AC3 the compile pin DISCRIMINATES — a wrong expectation really does fail`;
`L6 a profile declaring a capability the provider port does not publish fails before the stream opens`.
Change their **bodies** freely; change a **title** and `INV-6` fails. (`AC3 an MCP tool name cannot be granted
either — the base union is closed, not merely short` is **not** cited — and note it keeps passing after D4,
because it names `mcp__loom__start_loom`, which stays outside the union on purpose.)

**T-3 — `AC3 an absent \`allow\` means the whole base set` and its siblings assume six.** Several fold tests
lean on `BASE_ALLOWED_TOOLS`'s contents or length. Re-derive rather than re-literal. Same for
`apps/web/lib/session-profiles.test.ts`'s
`the escalation profile grants ONLY the base tools its own branch auto-runs`, whose `["Read","Grep","Glob"]`
becomes the full six of `ESC_READ`, and whose project-session half
(`allow.length === BASE_ALLOWED_TOOLS.length`) keeps passing untouched.

**T-4 — `.code`, never `.text`.** Every route-scanning invariant reads `ROUTE_SRC.code` (comments blanked) and
the reason is recorded in `INV-6c`: a commented-out `// import "@/lib/session-profiles";` keeps the literal in
`.text`, so a `.text` check stays green over an app that 500s on every chat request. Your `INV-6e` obeys the
same rule — and note that after this story the route's *comments* will legitimately discuss
`isEscalationSession` in past tense, which is exactly the case `.text` would fail on.

**T-5 — The side-effect import is the whole app.** `import "@/lib/session-profiles";` in `route.ts` is what
populates the registry. Without it `resolveSessionProfile` throws on **every** chat request and `bun test`,
`tsc` and `lint` all stay green. You are moving code around that import; do not let a "remove unused imports"
pass or an editor's organiser take it. `INV-6c` is the only mechanical guard and it checks `.code`.

**T-6 — `profile` is the account, `sessionProfile` is the session.** Repeated from D11 because it is the
highest-consequence naming collision in the file and this story edits both neighbourhoods. A mix-up bills the
wrong login.

**T-7 — `loomLink` is mutated during the turn.** Hoisting it must not turn it into a snapshot. The loom MCP
server narrows `loomId` in place and `appendTurn` reads the narrowed value. Move the object; do not copy it.

**T-8 — A bad or foreign `loomId` must still fail *safe*, never 400.** Today an id that does not resolve, or
resolves to a loom belonging to another project, leaves `loomLink.loomId` undefined and the session runs as a
plain one. After the hoist that logic runs pre-stream, where the surrounding code's idiom is *return a 400*.
Do not adopt it here. Under-detection is the safe direction; a 400 that depends on whether a client resent a
field is a non-deterministic failure.

**T-9 — Moved text must be moved, not retyped.** The three prompts are ~90 lines of moat-adjacent prose. A
retyped character changes model behaviour and no test would catch it. Cut and paste, then `git diff` and
confirm the bodies show as pure relocation.

**T-10 — Control characters.** Three stories running have been bitten by smart quotes, en-dashes and
non-breaking spaces sneaking into source. The prompt text legitimately contains `•`, `—` and backticks; keep
them, but do not introduce new ones into code.

**T-11 — `bun test -t` from the repo root is poisoned.** Always pass a path (hard rule 8). The unfiltered
repo-root `bun test` is green and is what E1 requires.

**T-12 — The `done` payload's `costUsd`.** AC5. The dangerous edit is a *revert* to something simpler-looking.

**T-13 — Do not hoist `getChat` for the wrong reason.** D1 hoists it because the **kind** needs it. Do not
also start using `existingChat` for anything else pre-stream (model defaults, permission mode, account
resolution) — each would be a new behaviour riding along inside a refactor.

**T-14 — `INV-3a`'s inventory is exact.** Your new `session-prompts.ts` must compose no `TELAR_HOME` path.
Everything it needs arrives through core's exported ports (`getLoom`, `readBundleFile`, `readContract`,
`STEERING_FILE`, `deriveDeliverableSignal`). If you find yourself writing `path.join(...)` against a state
root, stop.

---

## 6. Testing requirements

### 6.1 The rules this story exists under

- **`bun test` (`bun:test`) is the only test tooling.** No jest, no vitest. Core specs live flat in
  `packages/core/test/`; web specs colocate beside the module they cover, under `apps/web/lib/`.
- **There is no CI.** The manual pre-commit trio is `bun test`, `bunx tsc --noEmit` in **both** workspaces,
  `bun run lint` in `apps/web`. Run all four commands; record all four results.
- **Anti-vacuity floor + positive control on every scan or derived set** (§5.4-E).
- **The diagnosis lives in the asserted value** (§5.4-F). No `expect` message arguments.
- **Every new assertion is probed** — break it, capture the real failure, restore, verify the restore.
- **Compile-time claims run the compiler** (§5.4-C).
- **No `KNOWN_VIOLATIONS` entry is added.**

### 6.2 What the suites must actually carry

**A. The per-kind equivalence table** — `apps/web/lib/session-profiles.test.ts`. For each of the four kinds,
against a realistic `SessionResolutionContext` built on a real zod-parsed `ProjectManifest`:

- `toolPolicy.allow` equals a set **re-derived** from `BASE_ALLOWED_TOOLS` / `LOOM_ESCALATION_READONLY_TOOLS`
  — never a restated literal — with an anti-vacuity floor on the derived set.
- `toolPolicy.deny` equals `MG ∪ {AskUserQuestion} ∪ (escalation extras)`, re-derived from
  `LOOM_ESCALATION_DISALLOWED_TOOLS` and `ULTRA_AUTO_TOOLS`.
- `guardrails.disallowedTools` and `guardrails.protectedPaths` still contain the manifest's own entries.
- `settingSources` is `["project","local"]` for all four; `"user"` appears nowhere.
- `cwd === manifest.root` for all four.
- `systemPromptAppendix` **contains** the right static prompt for its kind and the Ultra note exactly when the
  kind and the flag say it should (`escalation` never; the other three when `ultraAnnotated`).
- **The manifest-denies-a-base-tool case** (D5): a manifest with `disallowedTools: ["Read"]` yields a resolved
  `allow` without `"Read"` and a resolved `deny` with it.
- **The moat**: no kind's resolved `allow` contains `LOOM_START_TOOL` or `LOOM_ANSWER_BLOCKED_TOOL`, asserted
  against the constants.
- **The core↔web vocabulary pin** (D4).

**B. Kind resolution** — `packages/core/test/session-profile.test.ts`. `resolveSessionKind` over the full
input space: wire role only; persisted role only; both; the **collision case** (persisted `steerer` +
wire `planner` ⇒ `steerer`); `escalation` **with** and **without** a resolved `loomId` (without ⇒ not
escalation); no role at all ⇒ `project`.

**C. The fold** — `packages/core/test/session-profile.test.ts`. `deny ⊇ guardrails.disallowedTools`; deny
still beats allow; an omitted `allow` still means the whole (now larger) base set; `BASE_ALLOWED_TOOLS`
excludes both human-gated tool names.

**D. Compile pins** — the updated union assertion (T-1) plus the existing set, all still two-directional.

**E. The appendix** — `apps/web/lib/session-prompts.test.ts`. Composition per kind; the fail-safe (D7): a
throwing reader still yields an appendix containing the static prompt — never `""`, never a throw — and, for a
steerer with `ultraAnnotated: true`, still containing the Ultra note (the pure half must survive the impure
half's failure).

**F. `INV-6e`** — `packages/core/test/invariants.test.ts` (D15).

**G. AC6** — the Codex approval-seam guardrail: a `kind: "command"` request whose command touches a
`protectedPaths` entry declines without creating a pending; one that does not, proceeds to the card; a project
whose `guardrails.disallowedTools` names `"Bash"` declines a command request; and a `kind: "file"` request is
**not** denied by that same `"Bash"` entry (D9's false-positive guard — this is the assertion that proves the
command-only restriction is real and not an accident). Drive `makeGuardrailDecision` with the exact shape
`onCodexApproval` builds (`toolName: "Bash"`, `input.command`, optional `input.cwd`).

### 6.3 What the Debug Log must contain

1. **The A2 measurement** — the BEFORE table as you measured it, with the symbol each value came from, and any
   divergence from §5.5-D13.
2. **The removal ledger** — one row per removed conditional: what it decided, which profile field decides it
   now, and the `git diff` hunk.
3. **Probes `P1…Pn`** — for every new assertion: what you broke, the real failure text, the restore, the empty
   `git diff --stat`.
4. **The `tsc` diagnostic** you re-measured for T-1, verbatim.
5. **The dev-server proof** — both providers, per §2's Dev-server proof, plus the three Claude-only kinds.
6. **AC5's `costUsd` expression**, pasted, unchanged.
7. **The gate** — `bun test` before/after counts, `bunx tsc --noEmit` exit codes for both workspaces,
   `bun run lint` before/after problem counts.
8. **`git diff --stat -- bunfig.toml`** printing nothing, and `KNOWN_VIOLATIONS.length === 1`.
9. **The disclosed behaviour change** (D12) and the disclosed deviations (D8's inert `mcpServers`, D9's
   residual).

---

## 7. Previous story intelligence

### 7.1 The four maxims, verbatim, because each was paid for twice

1. **"A line number is not a name."** *"It identifies a slot in a file, and any edit above it hands that slot
   to something else."* This story moves ~150 lines out of `route.ts` and hoists another ~50 within it —
   **every line number in every artifact that cites this file is about to become wrong.** Cite symbols.
2. **"Keys name events, not slots."** Story 1.1 redesigned an idempotence key three times, each redesign a new
   silent-money-loss regression. Nothing here mints a key; if you add an identity of any kind, mint it at the
   moment of the thing.
3. **"A guard must read the same value as the thing it guards."** Story 1.1's Repair Round 4: `logUsage`
   guarded the raw env var while the write landed wherever the resolver resolved. Generalised in 1.2: *"an
   invariant that scans for pattern X while production writes pattern X′ is a guard that does not guard."*
   This is the direct reason `INV-6e` must assert the route **consumes** the profile and not merely that it
   stopped naming three identifiers.
4. **"A green test can assert nothing."** Story 1.1 shipped two load-bearing tests using a seam production
   never produces. *"Revert the fix, watch the test fail"* is the house standard.

### 7.2 From story 2.1 — the story that built what you are wiring up

- **The `allow: []` failure is your template for what goes wrong here.** A value derived from a measurement
  that was never checked against its source, in a field nothing consumed, defended by a confident in-source
  comment. It survived authoring, review and a commit. What caught it was a human re-reading the comment
  against the constant. What now **prevents** it is the re-derivation test — which is why every expectation
  you write derives from a constant instead of restating one.
- **Two review findings closed in `cbbac0a`, both no-ops at the time**, both fixed precisely because they
  would otherwise have been inherited as verified fact: the escalation `allow`, and `INV-6c` reading
  `ROUTE_SRC.text` instead of `.code`. The lesson the fix commit states: a claim nothing can contradict is not
  a verified claim.
- **Three fields were left deliberately inert** and 2.1's header names all three: `mcpServers` (`{}`),
  `systemPromptAppendix` (`""` ×4), and `toolPolicy` (base six only). You close two (D4, D6) and consciously
  keep one (D8, with a forward owner). **Disclose the one you keep.**
- **The registry, not a switch.** Tracks D/E/F must add a kind without editing Track B's files. Do not
  reintroduce a per-kind `switch` in the route while removing the `if`s.

### 7.3 From story 1.3 — the tests you must live inside

- **The anti-vacuity rule and the positive control** are that story's central lesson, in its own words: *"This
  is the single most important instruction in the file."*
- **The self-reference hazard:** *"Your invariant suite will match itself, and this will be your first
  failure."* Floors run over the whole index; violation scopes exclude `*.test.ts`.
- **The compile-time harness exists twice** (`session-lease.test.ts`, `event-bus.test.ts`) plus a third copy in
  `session-profile.test.ts`. Do not re-derive it.
- **The `mock.module` cross-track defect** and the path-argument rule.

### 7.4 What is still open, and stays open

- Story 1.1's **five `[Review][Decision]` items** — all unresolved, all the human's. `bunfig.toml`'s
  `_bmad-output` exclusion is one; fence it a fifth time.
- Story 1.2's `writeLease` fixed-temp-filename race — recorded, deliberately unfixed, not yours.
- Story 1.3's `composesStateFile` gap (S21, partially closed) and its twelve nice-to-haves — not yours.
- Story 1.3's `mock.module` leak in two `apps/web/lib/loom-mcp.*.test.ts` files — **adjacent to you** (same
  workspace, and you edit a sibling test file) and still **not yours**. Fence it; do not fix it.
- The **`sessions/` co-tenancy** (`packages/core/src/sessions.ts` + `apps/web/lib/session-log.ts`), recorded in
  `AD5_OWNERS` with *"epics 2 and 3 need to know."* You now know. Nothing in this story writes there; a third
  writer fails `INV-3b`.
- The **unbounded in-process ledger fold** — recorded on story 1.1, not yours.

---

## 8. References

- `_bmad-output/planning-artifacts/epics.md` § "Story 2.2: Retrofit the existing session kinds onto profiles"
  — the four ACs verbatim, the dev-server-proof line, the dispatch notes (*"This is the story that touches
  production traffic… resist redesigning it here"*), and the `⚠️ Preserve from story 1.1` block that is AC5.
- `_bmad-output/planning-artifacts/epics.md` § "Epic 2: Session Profiles", § "Story 2.1" (what it deliberately
  left for you), § "Requirements Inventory" (FR-RF-7, FR-RF-6, the NFRs listed in this file's frontmatter),
  § "FR Coverage Map" row `FR-RF-7 | 2.1 + 2.2`.
- `.../architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md` §§ AD-9, AD-10, AD-11, plus AD-1,
  AD-3, AD-5, AD-6, AD-17, AD-18, AD-19, AD-20 and the `Consistency Conventions` table.
- `.../architecture/architecture-telar-2026-07-24/SOLUTION-DESIGN.md` — *"The moat is the reason this needed
  care. Making session config data is exactly the move that could turn a structural invariant into a
  configurable one"* and *"Separate routes per session kind were rejected on exactly this ground: a moat
  enforced in three places has three chances to be forgotten."*
- `.../architecture/architecture-telar-2026-07-24/WORK-SPLIT.md` — Track B's row, and *"D, E and F never edit
  the chat route… They add profiles, register kinds, and declare events"*, which is what this story exists to
  make true.
- `_bmad-output/implementation-artifacts/stories/2-1-the-sessionprofile-resolver.md` — §5.5's design decisions
  D1–D14 (the shape you are wiring up), §5.6's traps, its Review Findings and the `cbbac0a` fix round.
- `_bmad-output/implementation-artifacts/deferred-work.md` § "Deferred from: 2-1-the-sessionprofile-resolver"
  — both entries, both owned by this story.
- `_bmad-output/project-context.md` — the moat, the verifier capability wall, the core↔web boundary, the
  atomic-write idiom and its append-only exception, testing rules, commit conventions.
- In-tree, read as source of truth over any of the above: `packages/core/src/session-profile.ts`,
  `packages/core/src/providers.ts`, `apps/web/lib/session-profiles.ts`, `apps/web/lib/loom-mcp.ts`,
  `apps/web/lib/ultra-mcp.ts`, `apps/web/lib/permissions.ts`, `apps/web/app/api/chat/route.ts`,
  `packages/core/test/invariants.test.ts`, `packages/core/test/session-profile.test.ts`,
  `apps/web/lib/session-profiles.test.ts`.

---

## 9. Dev Agent Record

### Agent Model Used

Claude Opus 5 (`claude-opus-5`), via the `bmad-dev-story` skill, run unattended end to end.

### Debug Log

_(§6.3's nine items, in its order.)_

#### 1. The A2 measurement — the BEFORE table, re-derived rather than inherited

Measured against `route.ts` as it stood at the start of this story. `git diff --stat cbbac0a HEAD -- apps/web packages/core` printed **nothing**, so the working tree's `route.ts` was byte-identical to the baseline `cbbac0a` the story pinned. Every value below was read from the named symbol, not from §5.5-D13.

Source sets, each counted from its own declaration:

| Symbol | File | Count |
| --- | --- | --- |
| the six built-in names, inline in `allowedTools` | `route.ts` | 6 (`Read, Grep, Glob, WebSearch, WebFetch, ToolSearch`) |
| `LOOM_AUTO_TOOLS` | `apps/web/lib/loom-mcp.ts` | 11 |
| `ULTRA_AUTO_TOOLS` | `apps/web/lib/ultra-mcp.ts` | 3 |
| `LOOM_ESCALATION_READONLY_TOOLS` | `apps/web/lib/loom-mcp.ts` | 6 |
| `LOOM_ESCALATION_DISALLOWED_TOOLS` | `apps/web/lib/loom-mcp.ts` | 9 |
| `manifest.guardrails.disallowedTools` (`MG`) | `packages/core/src/schemas.ts` | project-supplied |

BEFORE — what `route.ts` passed, read from the `allowedTools` ternary, the `disallowedTools` array and the `systemPrompt` chain:

| kind | `allowedTools` | `disallowedTools` | `systemPrompt.append` |
| --- | --- | --- | --- |
| project | `BASE6 ∪ LOOM_AUTO ∪ ULTRA_AUTO` (20) | `MG ∪ {AskUserQuestion}` | `ultraNote` or **no `append` key at all** |
| planner | same 20 | same | `PLANNER + ultraNote` |
| steerer | same 20 | same | `STEERER + buildSteererContext(loomId) + ultraNote` |
| escalation | `ESC_READ` (6) | `MG ∪ {AskUserQuestion} ∪ ESC_DENY ∪ ULTRA_AUTO` | `ESCALATION + buildEscalationContext(loomId, workspace)` — **no** `ultraNote` |

Unconditional for all four: `cwd = manifest.root` (via `const workspace`), `settingSources = ["project","local"]`, `mcpServers = {loom, ultra, ...project}`, `permissionMode` from the wire.

**Divergence from §5.5-D13: none.** The table matched on every cell. Four adjacent facts §5.5-D13 asked to be verified rather than assumed, each checked:

- Every **non-escalation** kind gets the identical 20, including a plain project session with no loom link — the loom/ultra auto-tools were never gated on being a loom session. **Confirmed**: the ternary's only predicate is `isEscalationSession`.
- `escalation` gets no Ultra note and no ultra tools, but the ultra MCP **server is still constructed and passed**. **Confirmed** — and this is what made §5.5-D17's comment false; see item 9.
- `ESC_READ ∩ ESC_DENY = ∅`. **Confirmed**, and now asserted (`ESC_READ ∩ ESC_DENY = ∅, and answer_blocked is in NEITHER — verified, not assumed`).
- `mcp__loom__answer_blocked` is in **neither** set. **Confirmed**, same test.

#### 2. The removal ledger — one row per removed conditional, and the field that now decides it

| Removed from `route.ts` | What it decided | What decides it now |
| --- | --- | --- |
| `const isPlannerSession = role === "planner" \|\| existingChat?.role === "planner"` | which system prompt | `resolveSessionKind({role, linkRole, loomId})` → `sessionProfile.systemPromptAppendix` |
| `const isSteererSession = loomLink.role === "steerer"` | system prompt + live-context block | same, via `buildSteererProfile` → `steererAppendix` |
| `const isEscalationSession = role === "escalation" && !!loomLink.loomId` | system prompt, `allowedTools`, `disallowedTools` extras, the Ultra note | same, via `buildEscalationProfile`; tools via `sessionProfile.toolPolicy.{allow,deny}` |
| the 4-arm `systemPrompt:` ternary (escalation → steerer → planner → ultraNote → bare preset) | the appended text | `sessionProfile.systemPromptAppendix ? {…append} : {…}` — a branch on **emptiness**, the shape `ultraAnnotationNote ? … : …` already had |
| the 2-arm `allowedTools:` ternary over 4 constants | the tool grant | `allowedTools: [...sessionProfile.toolPolicy.allow]` |
| `disallowedTools: [...manifest.guardrails.disallowedTools, "AskUserQuestion", ...(isEscalationSession ? […] : [])]` | the deny set | `disallowedTools: [...sessionProfile.toolPolicy.deny]` (the fold unions `MG` in — §5.5-D5) |
| `const ultraAnnotationNote = ultraAnnotated && !isEscalationSession ? … : ""` | the per-turn Ultra note | `ultraNote(ctx.ultraAnnotated)` inside each builder; `escalationAppendix` has **no** `ultraAnnotated` parameter, so its exclusion is a signature rather than a branch |
| `const workspace = manifest.root` | `cwd` ×3 + guardrail root ×2 | `sessionProfile.cwd` (AC2, by construction) |
| `settingSources: ["project", "local"]` | which settings load | `[...sessionProfile.settingSources]` |
| the 8-line `rawRole` ternary | the wire role | `sessionRoleFromWire(rawRole)` in `@telar/core` |

Five consumers of `workspace`, all measured before deletion and all migrated: the two `makeGuardrailDecision` calls, `runCodexTurn`'s `cwd`, `query()`'s `cwd`, and `buildEscalationContext(loomId, workspace)` (which became `escalationAppendix({loomId, cwd})`).

**Net effect on the file**: `route.ts` 1985 → 1935 lines, with ~150 lines of prompt/reader text relocated to `session-prompts.ts` and ~50 lines of kind logic hoisted within it. `git diff --stat` reports `632 +++---` on that file.

**Mechanical proof**: `INV-6e` (see item 3, probes P1–P5). **Live proof**: item 5.

#### 3. Probes `P1…P20` — every new assertion broken, the real failure captured, the restore verified

**One deviation from V3's wording, stated because it is deliberate.** §5.4/V3 says "restore with `git checkout --`, verify with an empty `git diff --stat`". This story's work was **uncommitted** at probe time, so `git checkout --` would have restored each file to its pre-story `HEAD` state and destroyed the implementation. The restore was therefore a byte-exact copy from a snapshot taken immediately before each break, verified with `cmp` — **stricter** than an empty diff, because it compares bytes rather than git's view of them. Every one of the twenty reported `RESTORED byte-exact: yes`. Harness: `probe.sh` in the session scratchpad; filtered runs always carry a path argument (hard rule 8).

| # | What was broken | Real failure |
| --- | --- | --- |
| P1 | reintroduced `isEscalationSession` into the `allowedTools` line | `INV-6e` fails: *"the chat route still names ["isEscalationSession"]"* |
| P2 | reverted `settingSources` to the literal `["project","local"]` | `INV-6e` fails on the anti-vacuity floor: *"no longer reads ["sessionProfile.settingSources"] off the resolved profile"* |
| P3 | reintroduced `const workspace = manifest.root` | `INV-6e` fails: *"re-derives ["const workspace"] instead of reading the profile"* |
| P4 | fed `manifest` to `preToolUseGuardrail`'s `makeGuardrailDecision` | `INV-6e` fails: *"1 makeGuardrailDecision call site(s) are not driven from sessionProfile"*, printing the offending window |
| P5 | made `kindFlagsIn` return `[]` | `INV-6e`'s discriminator fails — the scanner cannot go quietly green |
| P6 | swapped the steerer/planner rungs in `resolveSessionKind` | `THE COLLISION CASE — persisted steerer + wire planner resolves STEERER` fails |
| P7 | reverted the deny fold to `unionOrdered(spec.toolPolicy.deny)` | **4** fold tests fail, incl. `THE SHARPEST CASE — a manifest that denies a BASE tool` |
| P8 | added `mcp__loom__start_loom` to `LOOM_AUTO_TOOL_NAMES` | **5** fail across core, incl. the MOAT guard printing its full AD-1/AD-10 diagnosis |
| P9 | reverted escalation `allow` to `["Read","Grep","Glob"]` | `escalation's resolved allow IS [...LOOM_ESCALATION_READONLY_TOOLS] — all six, not three` fails |
| P10 | dropped `...ULTRA_AUTO_TOOLS` from escalation `deny` | `escalation's resolved deny IS manifest ∪ {AskUserQuestion} ∪ ESC_DENY ∪ ULTRA_AUTO` fails |
| P11 | gave escalation the Ultra note | `escalation gets the Ultra note exactly when the flag AND the kind say so` fails |
| P12 | dropped `mcp__loom__watch_loom` from core's tuple | **5** fail: the core↔web anti-drift pin **and** all three non-escalation equivalence rows |
| P13 | removed the `try/catch` from `safeLiveContext` | **5** fail, each with the injected `the loom store is unreachable` escaping — a pre-stream 500 |
| P14 | wrapped the Ultra note inside the same `try` as the live read | `the PURE half survives the IMPURE half's failure` fails |
| P15 | made `steererAppendix` ignore `loomId` | the **sandboxed child** test fails (148 ms — it really spawned) |
| P16 | fed an empty guardrail set to the AC6 decision helper | **3** AC6 rows fail |
| P17 | emptied `ESCALATION_ALLOW` in the equivalence table | the §6.2-A anti-vacuity floor fires with its full paragraph |
| P18 | widened `ToolPolicy.allow` to `readonly string[]` | **5** compile pins fail, incl. `the compile pin DISCRIMINATES` |
| P19 | hard-coded `ultraAnnotated: false` in `buildPlannerProfile` | `planner gets the Ultra note exactly when the flag AND the kind say so` fails |
| P20 | made `sessionRoleFromWire` pass its argument through | `the three recognized values narrow, and everything else collapses to undefined` fails |

#### 4. The `tsc` diagnostic re-measured for T-1, verbatim

The old pin asserted the **whole rendered union**. With twenty names TypeScript elides the middle. Measured output, verbatim:

```
error TS2345: Argument of type '{ readonly deny: readonly []; readonly allow: readonly ["Bash"]; }'
is not assignable to parameter of type 'ToolPolicy'.
  Types of property 'allow' are incompatible.
    Type 'readonly ["Bash"]' is not assignable to type 'readonly ("mcp__loom__draft_bundle_file" |
    "mcp__loom__propose_contract" | "mcp__loom__read_bundle" | "mcp__loom__list_looms" |
    "mcp__loom__get_loom" | "mcp__loom__steer_loom" | ... 13 more ... | "ToolSearch")[]'.
```

Per T-1, the assertions that still **discriminate** stay in the compile test — the offending tool (`Bash`), the type (`ToolPolicy`), one union member from each end (`"mcp__loom__draft_bundle_file"`, `"ToolSearch"`) and the elision marker `more ...` itself, which is what proves the union is long rather than short. The "the union is EXACTLY these N names" claim moved to a **runtime** set-equality assertion in the same file (`AC3 BASE_ALLOWED_TOOLS is EXACTLY the twenty auto-run names, in the route's own order`), re-derived from `LOOM_AUTO_TOOL_NAMES`/`ULTRA_AUTO_TOOL_NAMES` with a duplicate check. **No cited test title was renamed** (T-2); `INV-6 the compile pins this invariant CITES still exist` passes.

#### 5. V4 — the dev-server proof (**PARTIAL, and the boundary is stated exactly**)

**`TELAR_HOME` confirmed before starting**, per §2: `apps/web/package.json`'s dev script is
`TELAR_HOME="${TELAR_HOME:-$HOME/.telar-dev}" next dev` — it defaults to `~/.telar-dev` and honours an explicit value. It was pointed at a **throwaway scratchpad root**, which is strictly safer than the default and leaves zero footprint. Verified afterwards: `~/.telar-dev` was **never created**, and `~/.telar`'s mtime (26 Jul 01:31) predates this session entirely.

Server: Next.js 16.3.0-canary.80 (Turbopack), ready in 269 ms on :3117, `[instrumentation] recovered 0 stuck loom(s) on boot`. **This alone proves what `bun test`/`tsc`/`lint` cannot: the rewritten route module loads and compiles under the real bundler.**

**What ran, all of it through the real handler:**

| Request | Result |
| --- | --- |
| unknown project | `400 {"error":"Unknown project \"__no_such_project__\"."}` — **AC4, live and byte-identical** |
| missing `project` | `400 {"error":"Unknown project \"\"."}` |
| unknown project **with** `role`+`loomId`+`sessionId`+`ultra` | same `400` — the new hoisted preamble does not disturb the first pre-stream check |
| `role:"planner"`, Codex account | `400 A "planner" session needs system-prompt-append…` |
| `role:"steerer"` + resolving `loomId`, Codex | `400 A "steerer" session needs system-prompt-append…` |
| `role:"escalation"` + resolving `loomId`, Codex | `400 A "escalation" session needs mcp-servers, pre-tool-use-hooks, tool-allow-deny-lists…` |
| **resumed** steerer chat, client omits `role`, Codex | `400 A "steerer" session needs system-prompt-append…` — **§5.5-D12's disclosed change, live** |
| **resumed** planner chat, client omits `role`, Codex | `400 A "planner" session needs system-prompt-append…` — same |
| **CONTROL**: resumed *plain* chat, Codex | `200`, stream opens — project requires nothing, untouched (§5.5-D10) |
| `role:"escalation"` + **unresolvable** `loomId` | `200`, stream opens — **T-8, live**: fails SAFE to a plain session, never a 400 |
| `role:"escalation"` + **foreign** loom (another project) | `200`, stream opens — T-8, the ownership half |

The three `200`s terminated with `codex app-server exited (code=127)` — no `codex` binary on PATH, so **no provider was contacted, no token was spent, and no account was touched**. That is the point: every assertion above lands *before* anything billable.

**What did NOT run, and why.** §2's full proof asks for a real turn on **each** provider that calls a tool, plus one turn per remaining kind on Claude. That requires a registered account and spends the operator's money against a live provider. This story ran unattended, overnight, with no human present to supervise a real-money agent turn — so it was **deliberately not run**, and no part of it is claimed. **Outstanding for the operator, and it is the one proof this record does not carry:**

1. `cd apps/web && bun run dev` (defaults `TELAR_HOME` to `~/.telar-dev` — confirm, never `~/.telar`).
2. A project session on a **Claude** account and one on a **Codex** account; send a turn that calls a tool. Record: the account, the tool, the permission card (or its absence) and why, the `done` payload's `costUsd` **noting it is the session total**, and the absence of a stream error.
3. On Claude only, one turn per remaining kind — a planner session, a loom's Chat tab (steerer), and a `blocked` loom's "Discuss with the orchestrator" (escalation) — each showing the kind-specific guidance still present in the model's behaviour.

The compensating stack for what is untested live is §5.5-D14's, with its limits: the per-kind equivalence table (the profile reproduces what the route used to build, re-derived from the same constants), `INV-6e` (the route consumes those fields and names none of the three flags), `INV-6c`/`INV-1g` unchanged, and the live pre-stream evidence above. "The profile is right" + "the route reads the profile" ≈ "the route is right" — an approximation, stated as one.

#### 6. AC5 — the `done` payload's `costUsd`, pasted unchanged

```ts
              costUsd: capturedSession
                ? sessionSpendUsd(capturedSession)
                : lastResult.totalCostUsd,
```

`git diff` over `route.ts` shows **no hunk touching this expression**. It remains the session's ledger total (AD-18: a projection over the one ledger, never an independent counter), not the turn's delta. The trap shape was watched for: the dangerous edit here is a *revert* to `lastResult.totalCostUsd`, and a large refactor of this file is exactly the context in which someone "tidies" an expression back to its simpler-looking predecessor.

#### 7. The gate (§6.1's manual pre-commit trio; there is no CI)

| Command | Before | After |
| --- | --- | --- |
| `bun test` (repo root, unfiltered) | **1896 pass / 0 fail**, 10368 `expect()`, 120 files | **1962 pass / 0 fail**, 10571 `expect()`, **121** files |
| `bunx tsc --noEmit` in `packages/core` | exit **0** | exit **0** |
| `bunx tsc --noEmit` in `apps/web` | exit **0** | exit **0** |
| `bun run lint` in `apps/web` | exit 1, **77** problems / 74 locations | exit 1, **77** problems / 74 locations |

Lint is **byte-for-byte unchanged** — the 77 figure was re-measured at baseline by stashing this story's work and re-running, not quoted. All 77 are pre-existing (`no-explicit-any`, `no-unused-vars` on the deliberately-underscored `_mode`/`_isolation` destructures, and unrelated component findings); the two new files and the two edited libs contribute **zero**. `invariants.test.ts` runs in 542 ms against its own stated 2000 ms ceiling.

> **THE 77 IS STALE — DO NOT INHERIT IT. Re-measured in the review fix round, 2026-07-26: both sides of this row are 165 (136 errors, 29 warnings), and the *conclusion* above survives intact.** The delta this story contributes is still exactly **zero**, and it is now proved the way it should have been in the first place: **one toolchain across two commits**, via a detached `git worktree` at this story's own baseline `cbbac0a` with `node_modules` symlinked in, rather than two numbers measured at two different times. Baseline and working tree agree on every figure including `route.ts`'s own 7 errors / 4 warnings. The 77 was real when measured and became wrong without anything in this story changing, because `apps/web/package.json` pins `"eslint": "^9"` — a floating range — and the `react-hooks` rules that account for the difference arrive through it. **The lesson is about the shape of the claim, not the arithmetic:** a story's lint evidence must be a *delta measured under one toolchain*, because a total is a fact about a dependency resolution nobody pinned. Both rows are left standing so the stale figure stays visible next to what replaced it. Full table: §9's Review Fix Round, item 7.

#### 8. The two fences

- `git diff --stat -- bunfig.toml` prints **nothing** (hard rule 5 — the fifth consecutive story to fence it; it remains story 1.1's unresolved `[Review][Decision]` and the human's call).
- `KNOWN_VIOLATIONS.length` is still **1** (`scripts/backfill-tool-detail.ts`); `INV-3f` passes and `INV-3a`'s inventory still reports **18 root-composition sites**, unchanged — no new file composes a `TELAR_HOME` path (hard rule 6, T-14).

#### 9. The disclosed behaviour change and the disclosed deviations

- **§5.5-D12 — the one thing that is not identical.** A resumed planner/steerer chat on a **Codex** account whose client omits `role` now takes the pre-SSE 400 instead of a 200 that silently dropped the appended system prompt that *is* the kind. Asserted in unit tests, proved live (item 5), named in the commit message. It is the completion of story 2.1's AD-11 gate, not new policy: 2.1 already 400s those kinds when the client *does* send `role`. It fails **loudly in place of failing silently**.
  - **Corrected on review, 2026-07-26: this said "planner/steerer/escalation" and escalation does not belong in the list.** `resolveSessionKind`'s escalation rung gates on the **wire** role (`input.role === "escalation" && input.loomId`), so a resumed escalation chat whose client omits `role` still resolves to `project` — a faithful port of the removed `isEscalationSession`, which had the identical requirement. The two live rows in item 5 that proved this behaviour are a resumed **steerer** and a resumed **planner**; there was never an escalation row, and nothing in the record claimed one. What was wrong was the disclosure, in three places, all now corrected: §2's AC3 layer 3, §5.5-D12, and this bullet. Full reasoning and the recorded consequence: §5.5-D12's correction block and `deferred-work.md`'s 2-2 review section.
- **§5.5-D8 — `mcpServers` stays inert (`{}`)**, disclosed rather than quietly kept. Measured: the route's set is unconditional, so AC1 never required moving it; building it is a side effect over `getSessionId: () => capturedSession`, which the SDK mutates mid-stream. Forward owner: **epic 5**.
- **§5.5-D9 — the Codex residual**, **four** distinct holes, recorded in `deferred-work.md` and owned by **story 5.5**. _(Three at implementation time; the review found a fourth, 2026-07-26 — `onCodexApproval` captures `req.cwd` onto `input` and then passes `sessionProfile.cwd` as the resolution root, and nothing in `makeGuardrailDecision` reads `input.cwd` (`PATH_KEYS` is `file_path`/`notebook_path`/`path`; `bashTouchesProtectedPath` takes `root` explicitly). So a relative command run from a subdirectory resolves against the wrong root and escapes `protectedPaths` — the hole that survives even when the card fires with a real shell command. Not a regression and not Codex-specific: the two Claude call sites have always had it. Named in full in `deferred-work.md`, same owner.)_
- **§5.5-D17 — the false comment above `ultraMcpServer`, corrected.** It claimed the ultra server is *"not offered to an escalation session (excluded from mcpServers/allowedTools)"*. Measured: `mcpServers` is unconditional, so the server **is** registered; only its tools are denied. Behaviour unchanged; this is a measurement, not a bug fix.

### Completion Notes

**What shipped.** The chat route no longer contains a session-kind conditional. `isPlannerSession`, `isSteererSession` and `isEscalationSession` are gone, and every decision they made is a field on the profile the route already resolved. AD-9's promise — *"a new surface adds a profile; it does not add an `if`"* — is now true of the handler that exists, which is what epics 4, 5 and 6 were waiting on.

**Every removal was paid for by a field, per the dispatch note.** The removal ledger (Debug Log item 2) is one row per conditional with the field that now carries its decision. Nothing was removed on the argument that it looked redundant.

**Three decisions this file left to me.**

1. **`ultraAnnotated` is REQUIRED on `SessionResolutionContext`, not optional.** Optional would default an omission to "no Ultra note", which is the safe direction for grants but silently drops the user's explicit per-turn ask — the failure AD-11 exists to end. `permissionMode` is already required, so this is consistent. The cost is that both test `ctx()` helpers had to declare it; that is the point.
2. **`INV-6e` does not assert the literal `sessionProfile.guardrails`,** which §5.5-D15 lists. It cannot: §5.5-D9 and §5.3 item 8 both prescribe passing the **whole profile** to `makeGuardrailDecision` (it is structural), so that literal never appears in the route. A measurement beats the design note, per §5.5's own rule. What `INV-6e` asserts instead is **stronger**: that `makeGuardrailDecision` has ≥3 call sites and that **every one** is driven from `sessionProfile`, plus that `manifest.guardrails` and `const workspace` no longer appear at all. Probes P3 and P4 show both halves firing.
3. **The dev-server proof was run only as far as it could go without spending the operator's money** — see Debug Log item 5, which states exactly what ran, what did not, and the three steps left for the operator. Nothing is claimed that was not executed.

**Two design choices worth a reviewer's attention.**

- **A `steerer`/`escalation` builder is no longer pure.** It performs the per-turn live read while composing its appendix, and that read moved from inside the stream (where a throw is an SSE `error`) to pre-stream (where a throw is a bare 500). The core fold stays pure — it takes an already-read context and calls a surface-owned function. `safeLiveContext` wraps the live read **and nothing else**, so a failure degrades to the static prompt and never to `""`; the Ultra note is pure and deliberately outside that `try` so it survives. Probes P13/P14 hold both halves. The rejected alternative was a pre-computed `loomContext: string` on the context — computing it requires knowing the kind, so the route would branch to compute it: AC1 defeated by indirection.
- **`BASE_ALLOWED_TOOLS` grew from 6 to 20, which strengthens the moat rather than weakening it.** `mcp__loom__start_loom` and `mcp__loom__answer_blocked` are deliberately outside the tuple, so they are now **unspellable in any profile's `allow`, enforced by the compiler** — stronger than the literal array the route used to build. That property has its own test in both workspaces (P8, P12). The rejected alternative — parameterising the base set — would widen `BaseAllowedTool` back to `string`, make over-granting compile, and turn `INV-6b` into a true statement about a dead mechanism.

**One behaviour genuinely changes; it is disclosed and asserted.** §5.5-D12, above and in the commit message. Project sessions are untouched on both providers.

**One prose comment is knowingly stale and is NOT mine to fix** (§5.5-D6, the record-do-not-cross protocol): `apps/web/lib/loom-mcp.ts` says *"parallel to **route.ts's** buildSteererContext"* and *"**route.ts** gathers the loom/contract/deliverable-signal and hands the primitives here"*, and both clauses are now false. **The new home is `apps/web/lib/session-prompts.ts`.** The file is not in this story's write set and the comment is not load-bearing — no import, no type, no test depends on it. The next story touching it can fix it in one line. (`route.ts`'s own two references were corrected, since that file *is* in the write set.)

_**Corrected on review, 2026-07-26: this said "two", and the second one is not stale.** `apps/web/lib/escalation-kickoff.ts` merely **names** `ESCALATION_SYSTEM_PROMPT` and `buildEscalationContext` without asserting where they live, and its surrounding claim — that `route.ts` recognizes the sentinel — is still true. Over-disclosure is a defect in the same family as under-disclosure: it sends the next engineer to edit a comment that is correct, and it inflates the count a reader uses to judge how much drift this story left behind._

**One cross-track finding, recorded not fixed** — corrected on review, 2026-07-26; this line previously read *"Cross-track findings: none new."* **The dock swallows the new pre-SSE 400 and the user's typed message vanishes with no error.** `apps/web/components/dock/session-runtime-host.tsx`'s `sendTurn` drains only under `if (res.ok && res.body)`, so a 400 body is never read, nothing throws, and the `finally` refetches a tail the turn was never persisted into. It POSTs `sessionId` and never `role`, so a docked **planner** chat on a Codex account reaches the new 400 and loses the message silently — which makes this story's own claim that the change "fails **loudly** in place of failing silently" true on the session page (`session-view.tsx` reads `body.error` and surfaces it) and false in the dock. The swallow is pre-existing and shared with all nine pre-SSE 400s; what this story changed is that a resumed loom-kind chat on Codex now reaches one. `apps/web/components/**` is **Track C**, outside the write set, so it is recorded in `deferred-work.md` with its owner and a one-branch fix, per the protocol that has now run five times. The other two fences held: the `mock.module("@telar/core")` leak in `apps/web/lib/loom-mcp.*.test.ts` was fenced, not fixed (hard rule 8, story 1.3's item), with every filtered run carrying a path argument; and `bunfig.toml` was fenced for the fifth consecutive story.

**One hazard found and worked around, worth carrying forward.** `getLoom` calls `ensureMigrated()`, which **renames directories** under the resolved state root — so calling the live-context readers from a test with no `TELAR_HOME` override would write into the operator's real `~/.telar`. This is the same class of failure that put a synthetic `$1` billing line there during story 1.1. No test in this story calls a real reader in the shared process: the composers are driven with injected readers, and the one assertion that needs the real arm spawns a **child** with `HOME` and `TELAR_HOME` pointed at throwaway directories (§5.4-D), importing by absolute path so the temp directory needs no `node_modules`. Probe P15 confirms that test genuinely discriminates.

> **THIS PARAGRAPH WAS FALSE WHEN IT WAS WRITTEN, BY EXACTLY ONE LINE, AND THE REVIEW PROVED IT BY EXECUTION RATHER THAN BY READING.** See the Review Fix Round below: the negative-**compile** assertion at the end of `apps/web/lib/session-prompts.test.ts`'s *"escalation: static prompt then LIVE CONTEXT, and NEVER an Ultra note"* was written as a bare `// @ts-expect-error` above a **call**, and a ts directive is a comment to the compiler and nothing to the runtime. That call really ran, with no injected `read`, straight through `buildEscalationContext` → `getLoom` → `ensureMigrated()`. It is fixed, and the claim above is now true — but the shape of the failure is the thing to carry forward, not the fix: **the hazard was known, named in this very paragraph, actively watched for, and it still shipped**, because a compile-time claim does not look like an execution. It is the same lesson `cbbac0a` recorded for story 2.1 — a claim nothing can contradict is not a verified claim — arriving one story later in a new costume. The remaining half is that nothing **mechanically** stops the next instance; the review's proposal for a scanner is recorded in `deferred-work.md` rather than built, with why.

**Suite health.** 1962 pass / 0 fail across 121 files, up from 1896 / 120. **No pre-existing failures were encountered**, so none are being reported as inherited.

### Review Fix Round — 2026-07-26 (fix attempt 1 of at most 2)

Against the code review's findings report. Verdict was **CHANGES-REQUIRED** on one blocking finding. One code
change; everything else is record. Nothing was fixed on a reviewer's say-so: **every finding below was
re-verified by executing or grepping it first**, and the one measurement that turned out to be more
interesting than the finding is item 7.

#### 1. B1 (BLOCKING) — a negative-**compile** assertion was executing and reaching the operator's real loom store — FIXED

`apps/web/lib/session-prompts.test.ts`, the test *"escalation: static prompt then LIVE CONTEXT, and NEVER an
Ultra note"*. The proof that escalation cannot be handed an Ultra note was written as a bare
`// @ts-expect-error` above a **call** to `escalationAppendix`. A ts directive is a comment to the compiler
and **nothing to the runtime**: the call ran, and it passed no `read`, so
`(opts.read ?? buildEscalationContext)(id, opts.cwd)` fell through to the real reader → `getLoom` →
`ensureMigrated()`, which renames directories under the resolved state root. `bunfig.toml` has no preload, so
`bun test` sets no `TELAR_HOME` and that root is `~/.telar`.

**Reproduced before fixing, against a throwaway root** — this was not taken on the review's word:

```
$ T=$(mktemp -d); mkdir -p $T/runs/loom_x; echo '{}' > $T/runs/loom_x/run.json
$ TELAR_HOME=$T bun test apps/web/lib/session-prompts.test.ts        # 18 pass
AFTER: looms/                       (was runs/)
       runs -> $T/looms             (symlink planted)
       looms/loom_x/loom.json       (was runs/loom_x/run.json)
```

Three filesystem mutations from one test file. It had not fired on this machine only because `~/.telar`
happens to hold no legacy `runs/` — an accident of layout, not a property of the code.

**The fix is structural rather than careful.** The compile claim is now a **type annotation on an object**,
which executes nothing at all, and the object is then fed through a call that injects `read`:

```ts
const optsAskingForTheNote: Parameters<typeof escalationAppendix>[0] = {
  loomId: "loom_1",
  cwd: "/repos/demo",
  // @ts-expect-error escalation never carries the Ultra note — by signature
  ultraAnnotated: true,
};
const appendix = escalationAppendix({ ...optsAskingForTheNote, read: () => LIVE });
```

The claim did not weaken; it got two properties it did not have. `Parameters<typeof escalationAppendix>[0]`
**re-derives** the opts type from the function instead of restating it (§7.2's lesson, the one `allow: []` was
paid for), and the runtime now **agrees with the type** — the property is smuggled past the compiler and the
composed appendix still has no note in it, which the old form could not show. The file's WHY header names the
exact shape that broke and forbids it: *"A negative COMPILE assertion must never be written as a live CALL in
this file."*

**Probed both directions** (hard rule 7), each restored byte-exact and verified with `cmp`:

| # | What was broken | Real failure |
| --- | --- | --- |
| P21 | deleted the `@ts-expect-error` line | `session-prompts.test.ts(189,7): error TS2353: Object literal may only specify known properties, and 'ultraAnnotated' does not exist in type '{ loomId?: string \| undefined; cwd: string; read?: ((loomId: string, root: string) => string) \| undefined; }'` |
| P22 | added `ultraAnnotated?: boolean` to `escalationAppendix`'s signature | `session-prompts.test.ts(189,7): error TS2578: Unused '@ts-expect-error' directive.` |

P22 is the half that matters and the old form did not have it: if the signature ever grows the parameter, the
directive goes unused and `tsc` fails, so the claim cannot rot into a comment about a signature that changed.

**Verified fixed by execution, not by reading.** The same throwaway-root run, now with a `find` snapshot
before and after: **identical, zero mutations** — for `session-prompts.test.ts` alone and for
`session-prompts.test.ts` + `session-profiles.test.ts` together (64 pass, 0 fail). The Completion Notes'
hazard paragraph, which was false by exactly this one line, now carries the correction above it.

#### 2. S1 — the dock swallows the new 400 — RECORDED, cross-track (Track C)

Re-verified in `apps/web/components/dock/session-runtime-host.tsx`: `sendTurn` POSTs `sessionId` and never
`role`, and drains only under `if (res.ok && res.body)`. Outside the write set — recorded in
`deferred-work.md` with the reachability chain, the owner and a one-branch fix. **The Completion Notes'
"Cross-track findings: none new" line was false and is corrected.**

#### 3. S2 — the D12 disclosure over-stated by one kind — RECORD CORRECTED in three places

Measured: `resolveSessionKind`'s escalation rung gates on the **wire** role, so escalation can never take the
new 400. **Four** places said "planner, steerer or escalation" and all four now say what the code does: §2's
AC3 layer 3, §5.5-D12, §5.5-D1's motivating paragraph, and Debug Log item 9. The fourth was missed on the
first pass of this fix round and caught by the verification sweep over it — a fix round that corrects a
disclosure in three of the four places it appears has the same defect as the disclosure did. The code is
**not** changed — narrowing the rung to `linkRole` would be a new, undisclosed behaviour change made inside a
fix pass. The consequence that follows from leaving it is recorded in `deferred-work.md` rather than buried
here.

#### 4. S3 — a fourth Codex guardrail residual — RECORDED where the gap lives

`onCodexApproval` puts `req.cwd` on `input` and then passes `sessionProfile.cwd` as the resolution root.
Verified inert: `apps/web/lib/permissions.ts`'s `PATH_KEYS` is `["file_path", "notebook_path", "path"]` and
`bashTouchesProtectedPath` takes `root` as an explicit parameter, so nothing reads `input.cwd`. A relative
command from a subdirectory therefore resolves against the wrong root and escapes `protectedPaths` — the hole
that survives even when the card fires with a real shell command. Not a regression and not Codex-specific
(both Claude call sites have always had it); fixing it means changing `apps/web/lib/permissions.ts`, which
this story is scoped to **call and not change**. `deferred-work.md`'s residual list now reads **four holes,
not three**, same owner (story 5.5).

#### 5. S4 — task V4's checkbox claimed a proof the Debug Log calls PARTIAL — FIXED

`- [x]` → `- [ ]`, with the boundary stated on the task itself instead of only in Debug Log item 5. The prose
record was already honest; the checkbox was the defect, because a reader scanning Leg D saw four ticked
V-items and concluded AC3's proof layer 2 was discharged. It is not, and the three outstanding operator steps
are unchanged.

#### 6. N2 (first half) — the unused `eslint-disable` — FIXED

`// eslint-disable-next-line no-throw-literal` above `throw undefined` in `safeLiveContext`'s test: the rule is
not enabled in this workspace's config, so the directive itself was the warning. Removed. The four files this
story owns now contribute **zero** lint problems, which is what Debug Log item 7 claimed and is now true.

#### 7. N2 (second half) — the lint total: the story's "77" is wrong, and this story is still responsible for **zero** of the difference

The review measured 165–166 problems where Debug Log item 7 records 77 both before and after, and could not
settle the cause without mutating the working tree. Settled here, decisively, by measuring **one toolchain
across two commits** instead of comparing two numbers from two toolchains: a detached `git worktree` at the
story's own baseline `cbbac0a`, with `node_modules` symlinked in so no install could move a plugin version.

| Tree | eslint | errors | warnings | total | `route.ts` |
| --- | --- | --- | --- | --- | --- |
| `cbbac0a` (baseline) | v9.39.4 | 136 | 29 | **165** | 7 e / 4 w |
| working tree, after this fix round | v9.39.4 | 136 | 29 | **165** | 7 e / 4 w |

**Byte-identical, including `route.ts`'s own row.** So the delta this story contributes is exactly **zero**,
which is the claim item 7 was making — but item 7's *number* was measured against a different resolved plugin
set (`apps/web/package.json` pins `"eslint": "^9"`, a floating range, and `eslint-config-next` carries the
`react-hooks` rules that account for the difference) and **must not be inherited as fact**. The correct
statement is the delta, not the total: totals drift with a floating dependency, deltas do not. Item 7's row is
annotated in place rather than rewritten, so the stale figure stays visible next to what replaced it.

#### 8. N1, N3, N4 — the rest

**N1** (no mechanical guard exists for "a test reaches the real state root", and B1 was that class's third
occurrence) is **recorded in `deferred-work.md`, not built.** The review classified it nice-to-have, and it is
a new several-hundred-line scanner over a 2800-line invariant suite whose false-positive surface is every
legitimate reader call in every suite that already sandboxes correctly — the shape of change that breaks a
green gate while repairing something else. The entry carries the review's full proposal, including its
anti-vacuity floor and discriminator, so whoever builds it does not re-derive it. **N3** (a malformed Codex
approval is guardrail-checked against the placeholder sentence `"Codex requested approval"`) is inherited from
the pre-existing card shaping, not introduced here, and lives in the same `permissions.ts`/`codex-app-server.ts`
territory as S3's residual — left as the review left it. **N4** is fixed: the Completion Notes said **two**
prose comments are knowingly stale, and only `loom-mcp.ts` is. `apps/web/lib/escalation-kickoff.ts` merely
*names* the symbols without asserting where they live, and its surrounding claim is still true — over-disclosure
sends the next engineer to edit a correct comment.

#### 9. The gate, re-run after the fix round

| Command | Before this round | After |
| --- | --- | --- |
| `bun test` (repo root, unfiltered) | 1962 pass / 0 fail, 121 files | **1962 pass / 0 fail**, 10571 `expect()`, 121 files, 40.58 s |
| `bunx tsc --noEmit` in `packages/core` | exit 0 | exit **0** |
| `bunx tsc --noEmit` in `apps/web` | exit 0 | exit **0** |
| `bun run lint` in `apps/web` | 166 problems | **165** problems (136 e / 29 w) — one fewer, the directive removed in item 6; identical to baseline `cbbac0a`, item 7 |
| sandboxed-root mutation check (new) | 3 mutations | **0** |

Test count is unchanged because no test was added or removed — B1's fix rewrites one existing assertion into a
stronger shape. `git diff --stat -- bunfig.toml` still prints **nothing** (hard rule 5 — still this story's
one fencing, not a new one); `KNOWN_VIOLATIONS.length` is still **1** and `INV-3a` still reports 18
root-composition sites (hard rule 6). Exactly three files were touched this round:
`apps/web/lib/session-prompts.test.ts` and `_bmad-output/implementation-artifacts/deferred-work.md`, both in
the story's declared write set, plus this story file, which is where the Dev Agent Record lives. No
production source was touched, and nothing in `apps/web/components/**` or `apps/web/lib/permissions.ts` —
the two places the findings pointed at and the two this story is fenced from.

#### 10. This round was itself verified adversarially, and the sweep found three defects in it

Four independent auditors were run over the fix round — one on the B1 code fix (re-reproducing the mutation
against a legacy-layout sandbox root and hunting for any other in-process reader call across
`apps/web/lib/*.test.ts`), one on record consistency, one fact-checking every symbol claim in the new
`deferred-work.md` material, and one on the fences and the gate. **The code fix and the fences/gate auditors
each returned zero findings.** The other two found three real defects **in the fix round's own record**, all
now repaired:

- **Two dead citations, both introduced by this round, both in the file whose preamble exists to prevent
  exactly this.** `apps/web/components/loom/discuss-escalation.tsx` — the directory is `looms/`, plural — and
  `apps/web/components/session-view.tsx`, which lives under `components/session/`. Neither path resolved.
  Every file path added by this round is now verified to exist, mechanically, by testing each one with
  `[ -f ]`. The citation policy `deferred-work.md` adopted *"after the THIRD drift"* says symbols survive
  edits and grep finds them; a path that resolves to nothing fails that on the first lookup, and writing two
  of them inside a round whose subject is unverified claims is worth recording rather than quietly fixing.
- **One wrong symbol on the load-bearing half of a contrast.** The dock entry attributed the `body.error`
  read to `session-view.tsx`'s `applyServerEvent`. It is `send`: `applyServerEvent` is the SSE event switch,
  takes `(event, payload)` rather than a `Response`, and is reached through `consumeSSE` only **after** the
  `!res.ok` branch has thrown. The behavioural claim was true and the symbol proving it was wrong — the same
  shape as B1, one register down.
- **The S2 disclosure was corrected in three of the four places it appears.** §5.5-D1's motivating paragraph
  also said "planner/steerer/escalation" and was missed. Now corrected, and item 3 above says four.

---

## 10. File List

| Path | New / Edit | What changed |
| --- | --- | --- |
| `packages/core/src/session-profile.ts` | EDIT | `LOOM_AUTO_TOOL_NAMES` + `ULTRA_AUTO_TOOL_NAMES`; `BASE_ALLOWED_TOOLS` 6 → 20; `sessionRoleFromWire`; `resolveSessionKind`; `SessionResolutionContext.ultraAnnotated`; `loomId`'s inverted contract; the `deny ⊇ guardrails.disallowedTools` fold; header SCOPE rewritten |
| `packages/core/src/index.ts` | EDIT | Barrel banner amended (the star export already carries every new symbol) |
| `packages/core/test/session-profile.test.ts` | EDIT | T-1 re-pin + the runtime union assertion; the moat property; `resolveSessionKind` precedence incl. the collision case; `sessionRoleFromWire`; the deny fold; `registerFourKinds`'s escalation mirror; `ctx()` gains `ultraAnnotated`. 37 → 55 tests |
| `packages/core/test/invariants.test.ts` | EDIT | `INV-6e` only. `INV-1g`, `INV-3*`, `KNOWN_VIOLATIONS`, `INV-6a–d` and the `PROFILE_FIELDS`/`SPEC_FIELDS`/`GRANT_SHAPED_FIELDS` arrays untouched. 47 → 48 tests |
| `apps/web/lib/session-prompts.ts` | **NEW** | The three prompts + the Ultra note + `tail`/`safeRead`/`buildSteererContext`/`buildEscalationContext`, moved byte-identically; `ultraNote`, `safeLiveContext`, and the four per-kind appendix composers |
| `apps/web/lib/session-prompts.test.ts` | **NEW** | 18 tests: prompt integrity, the moved helpers, composition per kind, and the pre-stream fail-safe with its discriminator. **Review fix round:** the escalation negative-compile claim rewritten from an executing call into a type annotation (B1 — it was reaching the real loom store); the unused `eslint-disable` removed; the WHY header names the shape that broke |
| `apps/web/lib/session-profiles.ts` | EDIT | The four builders carry real `toolPolicy` and `systemPromptAppendix` values; header records what closed and what stays inert with its owner |
| `apps/web/lib/session-profiles.test.ts` | EDIT | The fired tripwires re-derived; the core↔web anti-drift pin; the per-kind equivalence table with its anti-vacuity floor; the AC6 Codex-seam block; the sandboxed-child live-read test. 13 → 46 tests |
| `apps/web/app/api/chat/route.ts` | **EDIT, LARGE** | Leg C in full: the pre-stream hoist, the three flags deleted, `query()` driven from the profile, three profile-driven `makeGuardrailDecision` sites (one new, AC6), Codex `cwd`, dead imports removed, §5.5-D17's comment corrected. 1985 → 1935 lines |
| `_bmad-output/implementation-artifacts/deferred-work.md` | EDIT | §5.5-D9's decision with all three residual holes named separately and story 5.5 as owner; the 2-1 `systemPromptAppendix` entry marked closed, with `mcpServers` carried forward to epic 5. **Review fix round:** a **fourth** residual hole added to the D9 list (the approval's `cwd` is captured and never used as the resolution root); a new 2-2 review section carrying the dock's swallowed 400 (Track C), the missing mechanical guard for the B1 hazard class, and the escalation `linkRole` consequence |

---

## 11. Change Log

| Date | Change | By |
| --- | --- | --- |
| 2026-07-26 | Story created. Ultimate context engine analysis completed — comprehensive developer guide created. Baseline `cbbac0a`. | create-story |
| 2026-07-26 | Implemented end to end. Every session-kind conditional removed from the chat route; the four kinds now resolve through the story 2.1 resolver. `INV-6e` added. AC6 closes the Codex guardrail gap at the approval seam; the three-part residual is owned by story 5.5. One disclosed behaviour change (§5.5-D12). Gate: 1962 pass / 0 fail across 121 files, `tsc` clean in both workspaces, lint unchanged at 77. Status → ready-for-review. | dev-story (Opus 5) |
| 2026-07-26 | **Review fix round (attempt 1 of 2), against a CHANGES-REQUIRED review.** Blocking B1 fixed: a negative-**compile** assertion in `session-prompts.test.ts` was executing and reaching the operator's real loom store through `getLoom` → `ensureMigrated()` — reproduced (3 filesystem mutations), rewritten as a type annotation that executes nothing, probed both directions (P21/P22), and verified at zero mutations against a sandboxed root. Record corrected in four places: the D12 disclosure over-stated by one kind (escalation gates on the **wire** role and can never take the new 400), "Cross-track findings: none new" was false (the dock swallows the 400 — Track C), the Codex residual is **four** holes not three, and V4's checkbox is unticked to match its own PARTIAL Debug Log entry. Lint's stale 77 re-measured decisively at 165 = baseline, delta zero. Gate re-run: 1962 pass / 0 fail, `tsc` 0 / 0, lint 165 (one fewer than before the round). Status stays ready-for-review. | dev-story review fix (Opus 5) |
