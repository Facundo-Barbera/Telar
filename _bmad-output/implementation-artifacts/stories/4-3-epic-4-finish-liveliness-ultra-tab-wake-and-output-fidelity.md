---
story_id: "4.3"
title: "Epic 4 finish: liveliness, Ultra tab, wake, and output fidelity"
status: blocked
epic: 4
frs: ["FR-UW-1", "FR-UW-2", "FR-UW-5"]
baseline_commit: "0a05e30"
depends_on: ["4.1", "4.2"]
blocks: []
---

# Story 4.3: Epic 4 finish — liveliness, Ultra tab, wake, and output fidelity

## 0. Read this first

**This story has no entry in `epics.md`.** Stories 4.1 and 4.2 closed the FRs `epics.md` names for Epic 4 (`FR-UW-1/2/4/5/6`); this story is an owner-directed follow-on opened directly against a live gap list — five owner rulings and a fourteen-clause acceptance contract (`AC-L1..L5`, `AC-U1..U4`, `AC-E1..E5`) handed down in-session rather than drafted through `bmad-create-story`. Section 2 below reproduces that contract verbatim as the AC set, because there is no other canonical source to quote from. Treat the absence of an `epics.md` citation as a fact about this story's provenance, not an omission.

**Two lanes, two subagents, one gate.** The work split into a UI lane (`components/conversation/**`, `components/session/ultra-*`, `lib/ultra-runs.ts`) and an engine lane (`packages/core/src/ultra/**`, `lib/ultra-mcp.ts`, `lib/ultra-wake.ts`). Each ran its own build round and its own repair rounds against a shared gate. **The gate is RED at the close of this story**, and the cause is neither lane's file — see §9.1.

**Owner rulings this story was built under, verbatim:**

1. **Wake stays non-blocking.** No blocking wait tool. The existing durable wake becomes trustworthy and discoverable through tool descriptions and an opt-in per-run registration shape (`watch_loom`-style), preferring that a guiding agent end its turn and be woken over sleep-and-poll. Nothing blocks a turn; nothing weakens the four walls.
2. **The Ultra rail stays light** (`w-60`, not widened). The answer to "ultras are hard to visualize" is a full-pane Ultra tab using the same tab mechanism sub-agents already use — the rail becomes the glanceable index that opens it.
3. **Model policy:** never Fable; Opus for substantial build/judge work, Sonnet/Haiku for mechanical steps; any per-item fan-out carries a hard cap.

---

## 1. What this was, and why each piece was real

**(a) Liveliness — a streaming turn had no in-transcript indication of live work once its rendered parts stopped growing.** `session-view.tsx` derived a `liveWork` `WorkState` for its header spinner, but nothing bound that same state to the *last item inside the turn bubble* — the place a user's eye is actually on while reading. A finished turn, a non-last turn, and a page reload all needed to render nothing; a `LIVE` thinking block with no text yet needed to render its header affordance instead of nothing (the empty case a reload legitimately produces). This is `AC-L1..L4`.

**(b) Embedded surfaces got nothing.** `looms/chat-tab.tsx` and `looms/discuss-escalation.tsx` render no header bar at all, so a live turn inside them had no affordance whatsoever and could not be given one by editing those files (out of scope). This is `AC-L5`.

**(c) The rail's live agent snippet overflowed its own column.** `Shimmer`'s `inline-block` root cause meant a long `LIVE` snippet inside the 240px rail did not truncate — it overflowed or overlapped the column next to it. This is `AC-U1`.

**(d) An Ultra run had no way to be seen properly.** The rail is deliberately `w-60` and cannot show phases, a selected agent's transcript, the narrator timeline, the run result and the script at once. Owner ruling 2 named the fix: a full-pane tab, reusing the sub-agent tab mechanism, reusing the existing `ultra-runs.ts` projection and existing API routes rather than a second data path. This is `AC-U2/U3/U4`.

**(e) The wake appendix silently truncated a large run result at 1200 characters mid-sentence,** with no indication that it had, and `ULTRA_WAKE_PROMPT` actively forbade calling `ultra_status` to get the rest. This is `AC-E1`.

**(f) `ultra_status` reported a frozen snapshot.** A parallel fan-out that had started but not settled reported zero agents in flight and an unchanged phase, because only settle events reached the projection. This is `AC-E2`.

**(g) A non-string or stringified-object `agent()` prompt failed late, if at all.** A template literal interpolating a prior agent's result object (`` `${result}` `` where `result` is an object) silently produces the literal text `[object Object]` as a prompt, and nothing caught it before an ordinal was issued and money was spent. This is `AC-E3`.

**(h) A terminal manifest write that threw could strand a run as permanently `"running"`** with no wake possible, because nothing released the run's registry entry on that failure path. This is `AC-E4`.

**(i) The tool surface itself taught the wrong habit.** Nothing in `ultra`'s tool descriptions told a guiding agent that ending its turn and being woken is preferable to sleeping in background Bash and re-polling `ultra_status`. This is `AC-E5`.

---

## 2. Acceptance Criteria

Checked boxes are ACs a refuter confirmed with positive evidence at the close of repair round 2. Every checked box still carries, inline, the exact evidence and the exact limit of that evidence — none of them were observed pixel-for-pixel in a running browser against a live model turn, because **no DOM harness exists in this repo (deliberately) and `@anthropic-ai/claude-agent-sdk-darwin-arm64` is present in the bun store but unlinked in this checkout**, so no live model turn is possible here. That is the same disclosure stories 4.1 and 4.2 made under the same conditions. Nothing below is described as done that was only attempted.

### Liveliness (UI lane)

- [x] **AC-L1** — While an assistant turn is streaming and already has at least one rendered part, an inline status row renders as the LAST item inside that turn bubble, bound to the same `WorkState` the header derives (`session-view.tsx`'s `liveWork`) — not a second derivation.
  Evidence: `showsLiveStatus` (new, pure, on the `components/conversation` barrel) is exercised by 5 cases in `items.test.ts` covering exactly this predicate; `session-view.tsx` wires the row through the same `liveWork` object the header already reads, not a second one. **Not independently observed in a browser** — proved by traced wiring plus the passing predicate, per §9.2.
- [x] **AC-L2** — The status row is live-only: never on a finished turn, never on a non-last message, never after reload, nothing persisted to the store.
  Evidence: `showsLiveStatus`'s 5 test cases directly assert the negative space — `hasLiveWork: false` (finished/reload) → false, non-last → false, `partCount: 0` → false, `role: "user"` → false. The predicate is pure and reads no store; nothing about it is written anywhere persisted.
- [x] **AC-L3** — Appending the status row does not demote the real last item: a streaming tool group directly before it keeps `view.live` true, stays auto-expanded, and keeps its own spinner.
  Evidence: `isTrailingItem` gained the `conversation:status` exemption, pinned by 4 new cases in `items.test.ts` — `[tools, status]`, `[tools, permission, status]` composing, `[tools, status, text]` returning **false** (the discriminator that proves the exemption is narrow, not blanket), and the lone-`[status]` case.
- [x] **AC-L4** — A LIVE thinking block with no text yet renders its header affordance instead of nothing; a FINISHED thinking block with empty/whitespace text still renders nothing.
  Evidence: new `thinkingSuppressed` predicate, 4 cases in `items.test.ts`, including the live-with-no-text exemption that is the entire behaviour change and the finished-empty case that is the original suppression rule the reload path depends on.
- [x] **AC-L5** — Embedded surfaces (`looms/chat-tab.tsx`, `looms/discuss-escalation.tsx`), which render no header bar, get an in-flight affordance through the transcript itself, with no edits to those files.
  Evidence: the affordance is the tail status row inside the shared transcript renderer both surfaces already consume; neither file was touched (`git status` shows no change to either). **Rendered appearance inside those two specific embeddings was not independently observed** — same construction-not-observation caveat as AC-L1.

### The Ultra tab (UI lane)

- [x] **AC-U1** — A LIVE agent snippet in the 240px rail truncates with an ellipsis and never overflows or overlaps its column; the fix addresses the `inline-block`/shrink-to-fit root cause; every other `Shimmer` call site renders exactly as before.
  Evidence: 4 cases in `ultra-runs.test.ts` prove the composed display class **through the real `cn`/`twMerge`**, not a string match — including a positive control that `shimmer.tsx` still says `inline-block` (proving the fix is additive, not a rewrite) and a discriminator that the **pre-fix** string still yields `inline-block` (proving the test would have caught the original bug). `subagent-rail.tsx`, `kinds.tsx`'s `AgentStepRow`, and `working-indicator.tsx`'s call sites are unchanged per `git diff`.
- [x] **AC-U2** — An Ultra run can be opened as a full-pane tab using the same tab mechanism sub-agents use: selecting a run switches the main pane to that run view, the rail shows which run is open (the HERE-chip idiom), returning to Main works.
  Evidence: 5 cases in `ultra-runs.test.ts` for the `ultraTabId`/`ultraTabRunId` round-trip plus the three look-alike-vocabulary negative cases, plus static pins that `session-view.tsx` and `ultra-rail.tsx` actually wire through those functions (not a parallel id scheme). **The actual click-through and the HERE-chip's rendered state were not observed in a browser.**
- [x] **AC-U3** — The full-pane view shows run identity + state + spend + stop/resume, phases with agent rows, a selected agent transcript, the narrator timeline, the run result, and the script — reusing `ultra-runs.ts`'s projection and existing API routes, not a parallel data path.
  Evidence: 5 static scans in `ultra-runs.test.ts` confirm the projection fields used, that both surfaces (rail and tab) import the **same** reader functions, that no second hook/stream/list-poll exists, that the tone tables used are the shared four-state tables (not `RailStatus`), and that the narrator window has a fixed height (no layout shift). **Layout and live-tick behaviour were not observed in a browser.**
- [x] **AC-U4** — The rail stays light: not widened past `w-60`; `INV-8b`/`INV-8b2`/`INV-8f`/`INV-10`/`INV-4` all stay green; registered kinds remain pure module-scope functions reading no ambient context.
  Evidence: 2 cases in `ultra-runs.test.ts` pin `w-60` and the absence of `w-72`/`w-80` plus the 240px budget comment; `packages/core/test/invariants.test.ts` run below shows `INV-8b`/`INV-8b2`/`INV-10`/`INV-4` green throughout, and `INV-8f` green after this story's own pin edit (see §9.1).

### Output fidelity and the wake (engine lane)

- [x] **AC-E1** — A large run result reaches the guiding session usefully: the wake appendix no longer silently cuts at 1200 chars mid-sentence, and when clipping does happen the appendix says so explicitly and tells the model how to get the full text (`ultra_status`) rather than forbidding it.
  Evidence: `apps/web/lib/ultra-wake.test.ts` — a 4000-char result is **not** truncated; the truncation notice names the omitted-character count and points at `ultra_status("run_1")`; the per-run allowance shrinks with the pending-run count `n` but never below a 1200-char floor; a dedicated case proves a truncation notice can never make a run look already-carried (i.e. it cannot corrupt the ack predicate `appendixCarriesUltraWake` in `route.ts` relies on).
- [x] **AC-E2** — `ultra_status` reflects a live run: a started-but-unsettled fan-out reports agents in flight and its current phase rather than an unchanged zero; the true per-agent cost limit is stated honestly, not faked.
  Evidence: `apps/web/lib/ultra-mcp.test.ts`'s new `describe("ultra_status now READS agent-start...")`, 7 cases including a resume-safety set-difference check, an additive-only check (no denominator invented), and an explicit assertion that `ULTRA_STATUS_NOTE` states the cost-ceiling limit in prose rather than presenting an invented number. **Disclosed, not silent**: spend on a list-poll (`GET /api/ultra`) still moves only at settle — only the single-run `ultra_status` read was made live, by design, to avoid an O(ledger) fold storm on every agent start (§9.3).
- [x] **AC-E3** — An `agent()` call whose prompt is not a string, or contains a `[object Object]`/`[object Promise]` artifact, fails loudly before any ordinal is issued and before any spend, in both the schema and schema-less paths, naming the likely cause.
  Evidence: `packages/core/test/ultra-executor.test.ts`'s `describe("BadPrompt is a control signal...")`, 8 cases: the literal artifact with zero engine calls; a non-string prompt; `[object Promise]`; **no ordinal issued** (the journal holds only ordinal 0); propagation past a `parallel()` barrier; the schema-less path; the documented `allowStringifiedObject` escape (for a legitimate case — a synthesis prompt quoting upstream text that happens to contain the substring); and `isControlSignal(new BadPrompt)`. The guard sits above both the schema and schema-less branches in `executor.ts`, so it is one guard, not two that can diverge.
- [x] **AC-E4** — A terminal manifest write that throws can no longer strand a run as permanently `"running"` with no wake possible: the failure surfaces and/or is recovered rather than silently swallowed.
  Evidence: `packages/core/test/ultra-storage.test.ts`'s two new describes — the fs-error class (`manifest.json.tmp` is a directory) logs `terminal-manifest-write-failed`, releases the run from the registry, and the next `getUltraManifest` read self-heals it to `stopped`, which `pendingUltraWakes` then includes; and the unserializable-return-value class (`BigInt`, a circular structure) settles `done` with a tombstone string rather than throwing at all. **Honest limit, stated in both the code comment and the test title**: this recovery makes the wake *reachable*, not the outcome *accurate* — a run that genuinely finished with a real result but could not write it is reported `stopped` with no result. The only class where the result could have been preserved (serialization) is removed at the source by the tombstone fix, which lands first.
- [x] **AC-E5** — The tool surface teaches the non-blocking wake: a guiding agent is told to end its turn and be woken rather than sleep-and-poll, and can register interest in one run, delivered through the existing durable 4.1 mailbox; no tool blocks a turn; no new tool weakens the four walls.
  Evidence: `ultra_status` gained an optional `watch: z.boolean().optional()` input. `watch === true` calls core's existing `watchUltraRun`, stamping a `watchedAt` timestamp on the run's own `wake.json` — a plain synchronous write with no gate, no promise, no bus event. The launch handler's returned `note` now names `ultra_status(runId, watch: true)` and tells the model to call it once and end its turn; `ULTRA_STATUS_DESCRIPTION` states the registration "starts nothing, blocks nothing, subscribes to nothing" and that delivery is unconditional per session regardless of watching. `apps/web/lib/ultra-mcp.test.ts`'s `describe("AC-E5 — ultra_status can register interest...")`, 11 cases, load-bearing ones: the registered **tool-name set is still exactly three** (`ultra`, `ultra_status`, `ultra_stop` — `INV-1b` unchanged); an anti-vacuity case where omitting `watch` changes nothing in the serialized response; `watch: false` is a no-op; an unwatched terminal run is still delivered (the non-gate property); a cross-session watch attempt is refused without erroring the call; an unknown `runId` errors before anything is stamped.
  **Deviation from the owner's preferred shape, disclosed rather than buried**: ruling 1 named a dedicated tool in the shape of `watch_loom` as *preferred*. That shape was not built — see §9.4/§10 for why (four count-pinned files owned by neither lane) — and this flag-on-an-existing-tool shape was chosen instead because it satisfies the AC's literal text ("can register interest... nothing blocks a turn... no wall weakened") while adding zero new tool-name surface, which is strictly safer against wall 1 than a fourth name would have been.

### Not part of this story's checked set

No AC above is left unchecked — all fourteen received a refuter verdict of `notMet=false` at the close of repair round 2. What is **not** claimed by any checkmark: pixel-level rendering in a running browser, a live end-to-end model turn actually streaming and being woken, and the dedicated `mcp__ultra__ultra_watch` tool named in owner ruling 1. All three are named explicitly in §9 rather than folded silently into a checked box.

---

## 3. Tasks

### UI lane

- [x] Add `showsLiveStatus`, `thinkingSuppressed` as pure predicates on `components/conversation/items.ts`; export `showsLiveStatus` (and `StatusPayload`) from the barrel, keep `thinkingSuppressed` module-local to `kinds.tsx`.
- [x] Extend `isTrailingItem` with the `conversation:status` exemption, mirroring the existing `conversation:permission` exemption.
- [x] Register `conversation:status` as a built-in kind (`CONVERSATION_KINDS.status`) rendering a `WorkingIndicator` tail row bound to `session-view.tsx`'s existing `liveWork`.
- [x] Pin the seventh built-in kind into `packages/core/test/invariants.test.ts`'s `INV-8f` (id, title SIX→SEVEN, comment SEVENTH→EIGHTH — three hunks, nothing else in that file touched).
- [x] Fix `Shimmer`'s `inline-block`/shrink-to-fit root cause in `ultra-runs.ts`'s composed display class so a LIVE agent snippet truncates inside the 240px rail without touching any other `Shimmer` call site.
- [x] Build `ultra-tab.tsx` (new) and `ultra-run-views.tsx` (new): a full-pane Ultra run view registered as an item kind (not a `trailing`/`empty` bypass), reusing `lib/ultra-runs.ts` and the existing `/api/ultra` routes.
- [x] Wire `ultra-rail.tsx` and `session-view.tsx` to open a run into the tab via `ultraTabId`/`ultraTabRunId`, with a HERE-chip on the rail card for the currently-open run.
- [x] Widen `ultra-runs.test.ts` for AC-U1 (composed class), AC-U2 (id round-trip), AC-U3 (shared-projection static scans), AC-U4 (`w-60` pins); widen the existing AC9 budget scan from 4 to 6 enumerated files.
- [x] Move `ScriptTab`'s read of `ULTRA_AUTHORING_REFERENCE` from `ultra-rail.tsx` to `ultra-run-views.tsx` (file moved; import path unchanged).

### Engine lane

- [x] `packages/core/src/ultra/surface.ts` / `executor.ts`: add the `BadPrompt` control signal and its guard (non-string, `[object Object]`, `[object Promise]`), sitting above both the schema and schema-less branches, before `ctl.issued++` and before `hashCall`; add the documented `allowStringifiedObject` escape on `UltraAgentOpts`.
- [x] `packages/core/src/ultra/storage.ts`: wrap the terminal `saveManifest` in its own `try`/`catch` — on failure, log `terminal-manifest-write-failed` and release the run from the registry so the existing self-heal-on-read reconciles it to `stopped`; add `safeManifestResult` to tombstone an unserializable (`BigInt`, circular) result instead of throwing.
- [x] `packages/core/src/ultra/wake.ts` / `signals.ts`: land `watchUltraRun(sessionId, runId)` — a plain sync stamp of `watchedAt` on the run's own wake record, additive to the existing 4.1 mailbox, non-gating (`pendingUltraWakes` has no condition on it).
- [x] `apps/web/lib/ultra-wake.ts`: replace the silent 1200-char cut with an allowance that shrinks with the pending-run count but floors at 1200, plus a self-announcing truncation notice naming `ultra_status`; add rendering for the `watched` marker; both proved never to disturb `route.ts`'s `appendixCarriesUltraWake` ack predicate.
- [x] `apps/web/lib/ultra-mcp.ts`: add the read-side in-flight/phase computation to `ultra_status` (from `events.ndjson`, not the manifest); add the optional `watch` input and its handler; rewrite `ULTRA_STATUS_DESCRIPTION` and the launch handler's `note` to teach ending the turn instead of sleeping and polling, without naming a tool that does not exist.
- [x] Widen `ultra-executor.test.ts`, `ultra-storage.test.ts`, `ultra-wake.test.ts` (core) and `ultra-mcp.test.ts`, `ultra-wake.test.ts` (web) accordingly.

### Explicitly not done, and why (see §9 for the full reasoning)

- [ ] Register a distinct `mcp__ultra__ultra_watch` tool (owner ruling 1's literal preferred shape) — blocked on a single serialized commit touching four count-pinned files no lane owns; AC-E5 was met a different way instead.
- [ ] Extend the demo-gallery fixtures for the new `conversation:status` kind — outside both lanes' write sets; this is the one item keeping the gate red.

---

## 4. Dev Agent Record

### Agent model used

Both lanes ran under Opus-tier subagents per the standing model policy (never Fable; Opus for substantial build/judge work); mechanical repair-round re-verification used cheaper tiers where the step was purely re-running the gate.

### 4.1 The gate, as printed, at the close of repair round 2

```
cd packages/core && bun test
  -> 1755 pass / 0 fail / 9805 expect() across 112 files [50.11s]. FULLY GREEN.

cd packages/core && bun test test/invariants.test.ts
  -> 85 pass / 0 fail / 490 expect(). INV-8f green with the UI lane's pin;
     INV-8b/8b2/10/4/4c green.

cd apps/web && bunx tsc --noEmit   -> exit 0, ZERO output.
cd packages/core && bunx tsc --noEmit -> exit 0, ZERO output.

cd apps/web && bun test
  -> 724 pass / 1 FAIL / 2757 expect() across 23 files.

THE ONE FAILURE, verbatim, unchanged across both repair rounds:
  apps/web/lib/demo-gallery/conversation/fixtures.validate.test.ts:140
    for (const id of KINDS.ids()) expect(seen.has(id)).toBe(true);
    error: expect(received).toBe(expected)  Expected: true  Received: false
    (fail) the six configurations > between them, the configurations exercise
    EVERY built-in kind
```

**The gate is RED.** This is reported plainly rather than folded into a rounding-error footnote: `bun test apps/web` does not pass end to end at the close of this story.

**Why it is red, verified mechanically rather than assumed.** `GALLERY_KINDS = createItemKindRegistry([...BUILTIN_KINDS])` (`apps/web/lib/demo-gallery/conversation/shell.tsx`) reads the real built-in kind registry by design — that is the gallery's whole anti-drift purpose. This story's new seventh built-in kind, `conversation:status`, therefore gets a seventh registered id with no fixture in `apps/web/lib/demo-gallery/conversation/fixtures.ts` producing one, so the "every built-in kind is exercised" scan at `fixtures.validate.test.ts:140` fails, and the adjacent count pin at `:141` (`toBe(6)`) will fail next once `:140` is fixed.

**The exact three-line fix, verified against the current tree, not proposed from memory:**

1. `fixtures.ts` — add `type StatusPayload` to the existing `@/components/conversation` import (it **is** exported from the barrel — the UI lane added it) and a builder beside the existing ones:
   ```ts
   const status = (key: string, state: StatusPayload["state"]): TranscriptItem => ({
     kind: CONVERSATION_KINDS.status,
     key,
     payload: { state } satisfies StatusPayload,
   });
   ```
2. `fixtures.ts` — append **one** status item to `"conversation-full"`'s trailing turn, immediately after the existing permission card:
   ```ts
   status("m4:2", { kind: "tool", tool: "Bash", target: "bun test apps/web", elapsed: 34, silentFor: 22 })
   ```
   `"conversation-full"` is the documented donor (everything on, ending on a live approval) and is the only live configuration; it is also the exact `tools → permission → status` shape this story's new `isTrailingItem` composition case pins. It must **not** go in `"conversation-readonly"` — the row is live-only.
3. `fixtures.validate.test.ts:141` — `toBe(6)` → `toBe(7)`. The enclosing `describe("the six configurations")` is left alone (that six counts fixture **configurations**, still six). `UNREGISTERED_KIND` and configuration 6 are left alone — `INV-10b`'s negative half depends on the gallery never registering `ultra:run-anchor`.

**Why neither lane made this edit.** `apps/web/lib/demo-gallery/conversation/**` is outside both lanes' declared write sets. The UI lane additionally verified and **rejected** an in-write-set dodge: moving `statusKind`'s registration out of `BUILTIN_KINDS` into `SESSION_KINDS`-only would turn this test green without an out-of-lane edit (confirmed: `INV-8f` reads a different pin — `items.ts`'s `builtinKindIds()` — than the gallery's `BUILTIN_KINDS` import, so the two are actually independent here). It was rejected on principle, not difficulty: the gallery test is the repo's anti-drift proof, and hiding a real built-in kind from the registry the proof reads is weakening the test by a different door. The precedent (`markerKind`, a built-in with no production producer, still has a gallery fixture) settles it the other way: the fixture is owed, and it lives outside both lanes.

**This is a cross-lane write-set grant, not a code defect**, and it is the single item standing between this story and a green gate.

### 4.2 What "PROVED BY CONSTRUCTION, not observed" means here, stated once rather than repeated per AC

Two structural facts hold for the whole of §2's checked list and are not restated per bullet:

- **No DOM harness exists in this repo, deliberately** (story 3.1's hard rule, carried forward). Every liveliness/tab claim about actual rendered pixels, actual truncation, actual auto-expand, and actual layout is therefore a traced-wiring-plus-passing-predicate proof, never a screenshot.
- **`@anthropic-ai/claude-agent-sdk-darwin-arm64` is present in the bun store but unlinked in this checkout.** No live model turn — an Ultra child `agent()` call or a chat `query()` — can execute here. This blocked live proof identically in stories 4.1 and 4.2, and blocks it identically here.

Neither gap is repairable by writing more code in this story; introducing a DOM harness would itself be the forbidden refactor, and restoring the native binary is an environment fix outside this story's write set.

### 4.3 AC-E2's honest ceiling, stated in full

The engine lane took the read-side fix (`ultra_status` computes in-flight/phase from `events.ndjson` on each call) rather than writing new counters into the manifest on every agent start. Reasons checked, not assumed: every manifest write folds the **entire** usage ledger via `ledgerSpendUsd()`, so writing on agent-start would turn a write storm into an O(ledger) fold storm of up to the 1000-agent lifetime backstop per run; it would create a second progress source of truth beside `events.ndjson`, which this exact call already reads; and manifest counters would need the same resume-safe set-difference bookkeeping anyway, just persisted redundantly. What this does **not** fix, and what `ULTRA_STATUS_NOTE` states in its own prose rather than hiding: a reader of the run **list** (`GET /api/ultra`, the dock, the rail's list poll) still sees frozen spend during a survey phase — spend is genuinely unknowable before settle, on any surface, by this design.

### 4.4 Why the dedicated `mcp__ultra__ultra_watch` tool was not built

Registering a fourth ultra tool name requires editing, in the **same** commit, four files none of the two lanes' write sets grant:

1. `packages/core/test/invariants.test.ts:990` — `MCP_INVENTORY`'s `ultra` entry is compared **as an ordered list** by `INV-1b`; appending `"ultra_watch"` without registering the tool reports a phantom gain, and registering without appending reports a phantom loss. There is no edit order that avoids a red window.
2. `packages/core/src/session-profile.ts:223` — `ULTRA_AUTO_TOOL_NAMES` must mirror the addition or the new tool is silently filtered out of `allowedTools` at runtime.
3. `packages/core/test/session-profile.test.ts` — three hardcoded counts/titles (`:910` `toBe(24)`, and the prose at `:880`/`:647`) all assume three ultra tools.
4. `apps/web/lib/session-profiles.test.ts:251,256` — two more hardcoded counts (`toBe(20)`, `toBe(24)`) with the same assumption.

The engine lane verified all five edit sites exist exactly as described, confirmed the flag-based alternative satisfies AC-E5's literal text without touching any of them, and recommends **not** building the dedicated tool — a flag on the one tool that already takes the run id is a strictly smaller surface than a fourth tool name, and two ways to register interest in a run would be worse than one. If the owner still wants the dedicated tool, it is a single serialized post-merge commit touching exactly those five sites plus `ultra-mcp.ts`.

### 4.5 Repair history, summarized

- **Build round.** Both lanes shipped their full AC sets, engine lane's own build report flagging `AC-E5` as `NOT DONE` at that point (only the durable core half — `watchUltraRun` — had landed; nothing agent-callable existed yet). Gate: `apps/web bun test` 713/1 fail, same demo-gallery cause, present from the very first measurement.
- **Repair round 1.** UI lane made zero edits (nothing in its write set was red). Engine lane closed `AC-E5` by adding the `watch` flag to `ultra_status` rather than a new tool, specifically to avoid the four-file red window described in §4.4 — verified by execution that `INV-1b` stayed green with `invariants.test.ts` untouched.
- **Repair round 2.** Both lanes made zero further edits; re-running the gate reproduced the identical single failure, confirming it is stable and structural rather than flaky or newly introduced.

---

## 5. File List

### UI lane — edited

- `apps/web/components/conversation/items.ts` — `showsLiveStatus`, `thinkingSuppressed`, `isTrailingItem`'s status exemption, `StatusPayload`.
- `apps/web/components/conversation/kinds.tsx` — `conversation:status` kind registration.
- `apps/web/components/conversation/index.ts` — barrel export of `StatusPayload`/`showsLiveStatus`.
- `apps/web/components/conversation/items.test.ts` — 34 pass (was 21); new cases for all of the above.
- `apps/web/components/session/session-view.tsx` — the tail status row wired to `liveWork`; `ultraTabId`/`ultraTabRunId` wiring; `RunCard` reading `anchorControls(run)`.
- `apps/web/components/session/ultra-rail.tsx` — the `Shimmer` root-cause fix; the HERE-chip; the open-in-tab wiring; `ScriptTab` moved out.
- `apps/web/components/session/ultra-anchor.tsx` — minor wiring to the new tab-open path.
- `apps/web/lib/ultra-runs.ts` — display-class composition fix; `ultraTabId`/`ultraTabRunId` helpers.
- `apps/web/lib/ultra-runs.test.ts` — 134 pass; AC-U1..U4 cases, AC9 budget scan widened 4→6.
- `packages/core/test/invariants.test.ts` — **shared file, three hunks only** (`INV-8f`'s id, title, comment).

### UI lane — new

- `apps/web/components/session/ultra-run-views.tsx` — the full-pane Ultra view's content (identity/state/spend/stop-resume, phases, agent rows, transcript, narrator, result, script).
- `apps/web/components/session/ultra-tab.tsx` — the tab registration wiring `ultra-run-views.tsx` into the sub-agent-tab mechanism.

### Engine lane — edited

- `packages/core/src/ultra/signals.ts`
- `packages/core/src/ultra/surface.ts`
- `packages/core/src/ultra/executor.ts`
- `packages/core/src/ultra/storage.ts`
- `packages/core/src/ultra/wake.ts`
- `packages/core/test/ultra-executor.test.ts`
- `packages/core/test/ultra-storage.test.ts`
- `packages/core/test/ultra-wake.test.ts`
- `apps/web/lib/ultra-wake.ts`
- `apps/web/lib/ultra-wake.test.ts`
- `apps/web/lib/ultra-mcp.ts`
- `apps/web/lib/ultra-mcp.test.ts`

### Requested but not granted — cross-lane, blocking the gate

- `apps/web/lib/demo-gallery/conversation/fixtures.ts`
- `apps/web/lib/demo-gallery/conversation/fixtures.validate.test.ts`

### NUL-byte scan

`tr -dc '\0' < FILE | wc -c` returned `0` on every touched/created file in both lanes at every round.

---

## 6. Deferred items — for `deferred-work.md`

1. **BLOCKING THE GATE.** The three-line demo-gallery fixture edit in §4.1. Owner: whoever is granted `apps/web/lib/demo-gallery/conversation/{fixtures.ts,fixtures.validate.test.ts}` next — a single small, low-risk edit.
2. **The dedicated `mcp__ultra__ultra_watch` tool** (owner ruling 1's literal preferred shape). Not built; `AC-E5` was met via a `watch` flag on the existing `ultra_status` instead. If still wanted, it is one serialized commit touching the five sites in §4.4. Recommendation on record: do not build it — the flag is strictly smaller and already satisfies the AC's text.
3. **Two `WorkingIndicator`s render simultaneously** on a non-embedded session: the header block and the new tail row. No AC asks for the header one to go, and removing it would regress the only always-on affordance for a user scrolled away from the tail. Flagged as an owner decision, not a defect — if one should go, it is the header instance.
4. **Untested geometry**, worth one dev-server look: the status row passes `className="w-fit"` to `WorkingIndicator`, whose `tool` variant uses `min-w-0 flex-1 truncate` + `ml-auto`, while the header instance uses an explicit `max-w-[min(420px,60vw)]`. A long `Bash` command as `target` is the case to check; if it misbehaves, mirror the header's `max-w` rather than inventing a third sizing rule.
5. **Perf, not pre-optimized**: `liveWork` re-mints an object every second, so an idle-but-busy turn (a long silent tool) now re-renders once per second where before it did not. No new cost *class* — `transcriptItems` is already deliberately un-memoized — but worth a profiler look on a long transcript.
6. **`RunCard`'s local `act()` still duplicates `session-view.tsx`'s `ultraAct`.** The new tab uses `ultraAct` through its payload, so this is a second copy, not a third — but collapsing it changes the rail's error surface (`problem` renders Resume's 400) and belongs in its own change.
7. **`transcript.ts`'s `TOOL_INPUT_CAP`/`TOOL_OUTPUT_CAP` apply to every tool call with no MCP exclusion**, at five call sites in `route.ts` outside either lane's write set. This causes the Ultra launch tool's JSON to arrive head-truncated into invalid JSON on the display path, worked around today by an `extractRunId` regex fallback (`ultra-runs.ts`). Display-only — does not touch `AC-E1`, which is entirely about the wake appendix — but flagged for whoever owns `route.ts` next.
8. **The wake appendix's run-list bound stays unbounded in `n`** (n runs × the 1200-char floor) — pre-existing, restated as not worsened, not closed.
9. **Environment**: `@anthropic-ai/claude-agent-sdk-darwin-arm64` remains unlinked in this checkout, blocking live proof of every streaming-path AC across three consecutive stories (4.1, 4.2, 4.3). Restoring it is the single highest-leverage unblock for the next story that touches this surface.

---

## 7. Change Log

| Date | Change |
| --- | --- |
| 2026-07-31 | Build round: both lanes ship full AC sets; gate red on the demo-gallery cross-lane gap; `AC-E5` incomplete (durable half only). |
| 2026-07-31 | Repair round 1: engine lane closes `AC-E5` via a `watch` flag on `ultra_status`, avoiding a four-file red window; UI lane makes no changes (nothing in its write set was red). |
| 2026-07-31 | Repair round 2: both lanes re-verify with zero further edits; the single gate failure is confirmed stable and structural. |
| 2026-07-31 | Story report written; cross-lane fix and four deferred items handed to `deferred-work.md`. |

**Suggested commit message** (once the cross-lane fixture edit lands and the gate is actually green — do not use this message while the gate is red):

```
feat(epic-4): liveliness status row, full-pane Ultra tab, and wake fidelity

Adds a live-only trailing status row to streaming turns bound to the
existing liveWork WorkState, a full-pane Ultra run tab reusing the
sub-agent tab mechanism and the existing ultra-runs.ts projection, a
self-announcing wake-appendix truncation notice, a live-agent-count
ultra_status read, a BadPrompt guard against stringified-object
artifacts reaching agent(), a terminal-manifest-write recovery path,
and an opt-in per-run wake registration flag on ultra_status that
teaches ending the turn instead of sleep-and-poll.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

## 8. References

| What | Where |
| --- | --- |
| The owner rulings and the fourteen-clause acceptance contract this story was built from | This session's task brief (no `epics.md` entry exists for this story) |
| Prior Epic 4 work this story extends | `stories/4-1-completion-wake-and-session-cost-rollup.md`, `stories/4-2-the-real-session-ui-composer-chip-dock-signal-and-authoring-reference.md` |
| The four walls | `apps/web/AGENTS.md` / `_bmad-output/project-context.md` |
| The demo gallery's anti-drift design (`GALLERY_KINDS = createItemKindRegistry([...BUILTIN_KINDS])`) | `apps/web/lib/demo-gallery/conversation/shell.tsx` |
| The shared invariants suite | `packages/core/test/invariants.test.ts` |
