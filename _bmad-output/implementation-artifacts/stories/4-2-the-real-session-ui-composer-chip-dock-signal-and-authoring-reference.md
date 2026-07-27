---
story_id: "4.2"
title: "The real session UI, composer chip, dock signal and authoring reference"
status: review
epic: 4
track: "D — Ultra finish (lib/ultra-mcp.ts, ultra owner-adapter pieces, ultra/ subtree)"
caps: ["UW CAP-2", "UW CAP-3", "UW CAP-4", "UW CAP-6"]
frs: ["FR-UW-2", "FR-UW-3", "FR-UW-4", "FR-UW-6"]
ads: ["AD-12", "AD-13", "AD-3", "AD-5", "AD-6", "AD-7", "AD-8", "AD-9", "AD-14", "AD-15", "AD-18", "AD-19", "AD-21"]
nfrs: ["NFR-UW-1", "NFR-UW-2", "NFR-UW-3", "NFR-UW-4", "NFR-UW-5", "NFR-UW-7", "NFR-UW-8", "NFR-UW-10", "NFR-UW-11", "NFR-X-3", "NFR-X-10", "NFR-X-11", "NFR-X-12", "NFR-X-15", "NFR-LR-24", "UX-DR10", "UX-DR11", "UX-DR24"]
uxdrs: ["UX-DR24", "UX-DR10", "UX-DR11"]
baseline_commit: "e093a98"
baseline_gate: "MEASURED 2026-07-27 at e093a98, not carried forward: `packages/core` → 1637 pass / 0 fail / 9241 expect() / 109 files (38.43s); `apps/web` → 498 pass / 0 fail / 2091 expect() / 20 files (2.53s). Combined 2135 pass / 0 fail / 129 files. It is still a POINTER — re-measure before you touch anything and record your own figure."
depends_on: ["1.1", "1.2", "1.3", "2.1", "2.2", "3.1", "4.1"]
blocks: []
closes_epic: 4
---

# Story 4.2: The real session UI, composer chip, dock signal and authoring reference

## 0. Read this first

**Citation policy, unchanged from 4.1 and binding here.** Every reference names a **file and a symbol** — a function, a const, a type field, a JSX element, or a test title. **A line number is not a name.** Where a number aids navigation it is written `≈:N` and is a **pointer, not a fact**; verify by symbol. This repo abandoned line-number citations after three drifts and a fourth inside the round that fixed them.

**The one recurring defect of this whole run, restated because it has now been found in every single story.** Every code review across epics 1–4 found *sentences* — comments, Debug Log entries, summary rows, File List entries — asserting something the tree does not support. Story 3.1's round-2 review found one such false sentence **inside the fix for the finding about false sentences**. Story 4.1's fix round produced a stale tally **inside the fix for the stale-tally finding**. So:

> **Every claim this story's implementation makes about the tree — in a comment, in a test title, in your Debug Log, in your Completion Notes — must be verified against the tree at the moment you write it. Every number is labelled a pointer, never a fact.** If you write "measured", you measured it in that session. If you carried it forward, say so and say from where. A sentence you cannot re-derive from the tree in one grep is a sentence you must not write.

That rule applies to this file too. Everything in §5 was measured against the working tree at `e093a98` on 2026-07-27, **including** the baseline gate in the frontmatter, which for the first time in this run was actually re-run rather than carried. Re-measure anyway. Do not quote.

**This story closes epic 4 and is the SPEC's own success signal.** `SPEC-ultra-workflows` § Success signal, verbatim:

> *"One real end-to-end Ultra workflow runs on a sandbox project through the actual (non-demo) session UI: the user asks for it, the agent authors and launches the script, the transcript anchor and rail Workflows section track it live, and when the detached run finishes, the wake fires and the agent summarizes the outcome in chat — with no `ultra_status` poll and no page refresh needed."*

Story 4.1 built the second half of that sentence. You are building the first half, and the dev proof is the whole sentence.

---

### 0.1 Twelve hard rules before you write a line

1. **THE FROZEN UI CONTRACT IS THE SPEC, AND THE DEMO GALLERY IS NOT THE CONTRACT.** `_bmad-output/specs/spec-ultra-workflows/ui-contract.md` is the frozen contract; `apps/web/lib/demo-gallery/ultra/session-ultra.tsx` is its *reference rendering against fixtures*. Where they disagree, the contract wins, and **they disagree in five places you will otherwise copy straight into production** (§5.6-T1). The gallery's `RunState` includes `"completed"`, which **is not a real state**; its `AgentState` union is entirely fabricated; its phase model has ids, a `kind` and an `activateAt` that do not exist; its replay controls are mockup-only by the epic's own dispatch note; and its `StageFrame`/theme-toggle chrome is lane-local scaffolding. Port the *layout and the density*, never the data model.

2. **THE DISPATCH NOTE'S SEAM DOES NOT EXIST, AND THIS STORY SAYS SO OUT LOUD RATHER THAN PRETENDING.** `epics.md` § Story 4.2 dispatch notes says *"Never edit the shell, the chat route, or `session-view.tsx` directly — this track extends through registered seams only."* Measured at `e093a98`: there is **no mechanism by which an outside module can add an item kind, a rail section, or a composer control to the real project-session surface.** `SESSION_KINDS` is a module-scope literal array inside `session-view.tsx`, and that file's own comment forbids the obvious workaround (*"never read by the shell from anywhere global … a shared mutable registry would also let two surfaces on one page clobber each other's registrations"*). `SubagentRail` takes seven props and has no `children`, no slot prop and no section list. A repo-wide search for an extension registry finds exactly one hit and it is a test file.
   **The ruling: the shell is untouched, the chat route is untouched, and `session-view.tsx` is edited — minimally, in a declared, enumerated write set, and disclosed again in your Completion Notes.** This is the same posture story 4.1 took for the same file and for the same reason (epic 4 is *"the first epic with a dev-server-visible outcome"*, and a story with no client edit cannot satisfy its own dev proof). §5.5-D1 fixes exactly which expressions may change; anything beyond that list is a scope breach, not a judgement call.

3. **NO PLACEBO. If the data does not exist, the UI does not claim it.** This is the rule that decides more of this story than any other, because the frozen contract asks for four things the engine does not currently produce: `agents done/total` (there is no **total**), a `model·effort` chip (there is no **effort**), a per-agent **live** state and snippet (an agent emits nothing until it settles), and a **progress sliver** (there is no fraction). §5.5-D6 rules on each: two are sourced by a minimal, additive core change, two are rendered honestly or not at all. **Do not fabricate a denominator, do not animate a bar off a timer, and do not show a chip whose second half is a guess.** `ui-contract.md`'s own house rules say it in three words: *"no placebo"*.

4. **`ultra:run-anchor` is registered HERE, into the ADAPTER's registry, and the gallery's tombstone must still be a tombstone afterwards.** Story 4.1's hard rule 9 held the id unregistered and named this story as the one that registers it. Two things that rule got slightly wrong and you must not inherit: registries are **independent instances passed as props** (`createItemKindRegistry`, pinned by *"two registries are INDEPENDENT — the registry is a prop, not a singleton"*), so registering into `SESSION_KINDS` cannot reach `GALLERY_KINDS`; and `MODULE_NAMESPACES` **already contains `"ultra"`**, so the id is legal today with no contract change. What you must actually protect is `apps/web/lib/demo-gallery/conversation/shell.tsx`'s `GALLERY_KINDS`, whose own comment says `ultra:run-anchor` *"is deliberately absent so configuration 6 can show the tombstone"*, and the two tests that pin it (*"the tombstone kind is genuinely NOT registered — the demo is not a mock"* and *"exactly one configuration carries the unregistered kind"*). **Register into `SESSION_KINDS`. Never into `GALLERY_KINDS`. Re-run those two tests by name and record their verdicts.**

5. **A NEGATIVE-COMPILE CLAIM IS WRITTEN AS A TYPE ANNOTATION ON A DATA OBJECT, NEVER AS A CALL.** `@ts-expect-error` is a comment to the **compiler** and nothing at all to the **runtime**: a directive above a *call* still calls. Story 2.2 shipped exactly that and it renamed directories under the operator's real `~/.telar` (via `getLoom` → `ensureMigrated`). Note also **where the claim lives decides whether it is checked**: `packages/core/tsconfig.json` is `include: ["src"]`, `exclude: ["test", …]`, so `bunx tsc --noEmit` in that workspace **never sees a core test file** and a bare directive there proves nothing — spawn a real `tsc` over a fixture (the `packages/core/test/session-profile.test.ts` / `event-bus.test.ts` `typecheck()` idiom). `apps/web/tsconfig.json` has **no** test exclusion, so a web-side inline directive genuinely is checked — but it still must sit on a `const x: Parameters<typeof f>[0] = { … }` literal, never above a call. §5.4-E. You will need this for AC10's proof that `ConversationProps` still has no tenth slot and that a renderer's signature is `(payload, view)`.

6. **ANY FILTERED OR PROVE-RUN COMMAND TAKES A PATH ARGUMENT.** A bare repo-root `bun test -t "<filter>"` is poisoned by the pre-existing process-global `mock.module("@telar/core", …)` leak in `apps/web/lib/loom-mcp.answer-blocked.test.ts`, `loom-mcp.remint.test.ts` and `ultra-mcp.test.ts` — recorded under story 1.3 in `deferred-work.md` and **not yours to fix**. Scope every run: `bun test packages/core -t "…"`, `bun test apps/web -t "…"`, or name the file. The prove-run command this story ships must itself take a path argument for the same reason. Note the third leaking file is `ultra-mcp.test.ts`, which **is** in your write set this time — you may extend it; you may not repair the leak.

7. **NO TEST IN THIS STORY MAY REACH THE OPERATOR'S REAL STATE ROOT.** `packages/core/test/invariants.test.ts`'s **INV-7** enforces this across every `*.test.ts` / `*.test.tsx` and its failure names your file and line. The three sanctioned mechanisms are in §6.1. **INV-7 scans BY NAME**, so a reader reached *transitively* through a helper it does not know about is invisible to it — the discipline still binds where the call is indirect, and `deferred-work.md`'s 4.1 entry records that INV-7's own reader surface is **still missing four symbols** and names you as the owner. Story 1.1 wrote a synthetic billing line into the operator's real `~/.telar` and **it is still there**; do not add a second. Every new route you add here reads `TELAR_HOME/ultra/` — the blast radius is larger than 4.1's, not smaller.

8. **`KNOWN_VIOLATIONS` in `invariants.test.ts` has held at exactly ONE entry. Add none.** `INV-3f` throws unless its length is exactly `1`, and `INV-7f` / `INV-8h` / `INV-9e` each independently assert their own invariant contributed zero. If you believe you need a second entry, that is a decision requiring explicit justification in your Completion Notes — not a detail you slip in.

9. **Do not edit `bunfig.toml`.** It carries an unresolved `[Review][Decision]` from story 1.1 (its third `pathIgnorePatterns` entry) that every story so far has been fenced from. You are fenced from it too.

10. **THE KIND RENDERER IS WRITTEN INLINE, IN A `: ItemKind<Payload> = {` DECLARATION, IN A FILE INV-8b2 ACTUALLY SCANS. THERE ARE FOUR WAYS TO GET THIS WRONG AND ALL FOUR COMPILE.** INV-8b2 extracts a kind's renderer **by brace-matching from a `: ItemKind<…> = {` declaration**, and `invariants.test.ts` states the first hole in its own words: *"the brace match ends at the OBJECT LITERAL, so this extractor sees a renderer only when the renderer is written INLINE. A kind declared `render: someTopLevelFn` yields a slice holding no hook-call text at all: `ambientContextScan` returns `[]` and INV-8b2 passes over the exact violation it exists to catch … NOT HYPOTHETICAL: `renderAgentBucket`, the top-level function story 3.1 deleted, was precisely that shape."* The other three are **not documented anywhere** and were found while writing this story:
   - **`render: someTopLevelFn`** — the documented one. The slice holds no hook-call text.
   - **`const k: ItemKind = { … }`** — the extractor's pattern requires the generic `<`, so a bare `: ItemKind` annotation never matches and yields **no slice at all**.
   - **`const k = { … } satisfies ItemKind<P>`** — no `: ItemKind<` annotation exists, so likewise no slice.
   - **any file other than `session-view.tsx`** — INV-8b2's slices come from **one** file: `const DONOR_KIND_SLICES = kindRendererSlices(byRel.get(SESSION_VIEW_REL)?.text ?? "")`. (`components/conversation/**` is INV-8a/8b's surface, scanned wholesale for ambient context and never brace-matched for kinds — the residual comment says so: *"INV-8b is scoped to components/conversation/** by design, and the donor is the one file outside it."*) So a kind declared in a third file is not scanned at all, and the widening you write is a **second `kindRendererSlices` call over a second rel, concatenated** — not a glob and not a change to `SHELL_ROOT`.

   Crucially, **three of those four leave INV-8b2 GREEN rather than red**: its anti-vacuity floor is satisfied by the existing `agentBucketKind` slice, and its `toContain("agentBucketKind")` assertion still holds. A silent removal from AD-12 enforcement is the failure mode, not a build break. §5.5-D9 closes all four for this kind — declare it as `export const ultraRunAnchorKind: ItemKind<UltraAnchorPayload> = { … }` with the renderer **inline**, in `apps/web/components/session/ultra-anchor.tsx`, and **widen INV-8b2's scan set to include that file, with a floor naming both kinds and a discriminator proving the widened scan really sees it**. The residual's own instruction is to *"follow the identifier and scan that function's body too, rather than widening the brace match or deleting the check"*; widening the **file set** is the sanctioned half of that and is what this story does. **The residual is recorded in-source and in `orchestrator-run-log.md` but is NOT in `deferred-work.md` — put it there, with the three undocumented shapes, as part of V4.**

11. **THE ENGINE IS FINISH-WORK-ONLY, AND THE TWO ADDITIVE EVENT FIELDS THIS STORY ADDS ARE NOT A REBUILD.** `SPEC.md` non-goals fence *"Rebuilding U1–U5 engine, tools, routes, or storage"*. This story adds **one new `UltraEvent` variant and one optional field** so the frozen rail contract has a data source at all (§5.5-D6, and it is a **disclosed widening**). Everything else in `packages/core/src/ultra/` is read and not written: `sandbox.ts`, `runner.ts`, `journal.ts`, `surface.ts`, `wake.ts`, `events.ts` are **not** in your write set. In particular `packages/core/test/ultra-executor.test.ts` pins **`expect("effort" in seen[0]!).toBe(false)`** — effort must keep NOT reaching `engineOpts`. You are emitting it on the **event**, not into the engine call. Break that pin and you have changed the child posture NFR-UW-4 fixes.

12. **NO BUDGET UI ANYWHERE, AND THAT IS AN ASSERTION, NOT A STYLE NOTE.** NFR-UW-7 and `ui-contract.md` §6. No meters, no ceilings, no percentages, no reserved headroom, no `<Progress value=…>` bound to money. The one bar this story renders is a **phase progress sliver**, and §5.5-D6 fixes what it is a fraction of — it is not a fraction of spend, and it never can be, because nothing in ultra gates on money (`storage.ts`'s own words: *"Ultra's spend is a READOUT, not a cap … nothing gates on this one"*). `apps/web/lib/spend-readout.ts` already says the same thing at the top of the file and is the formatter you reuse.

---

### 0.2 Write set — declared, and the widenings declared as widenings

| Path | New / Edit | Why it is in the write set |
| --- | --- | --- |
| `packages/core/src/ultra/executor.ts` | EDIT | **Disclosed widening (engine).** One new `UltraEvent` variant (`agent-start`) and one optional `effort` field on the existing `agent` variant. Nothing else. AC3. §5.5-D6. |
| `packages/core/src/ultra/storage.ts` | EDIT | `listUltraAgentOrdinals(runId)` — the "which ordinals have begun" reader the rail needs; and the `agent-start` pass-through in the existing `onEvent` tap. AC3. §5.5-D6, D7. |
| `apps/web/lib/ultra-runs.ts` | NEW | **The whole story's brain, and it is pure.** Manifest + event stream → the anchor payload, the phase groups, the agent rows, the narrator lines, the progress fraction. No React, no fetch, no `@telar/core` runtime. The shape of `apps/web/lib/spend-readout.ts` and `apps/web/lib/ultra-wake.ts`. AC1–AC5. §5.5-D3. |
| `apps/web/lib/ultra-runs.test.ts` | NEW | Its proof — every projection, every dedupe rule, every degradation, with no DOM and no disk. |
| `apps/web/lib/ultra-authoring.ts` | NEW | The authoring reference as one exported string, pure and dependency-free, shared by the server (the appendix) and the client (the Script tab's link-out target). AC8. §5.5-D12. |
| `apps/web/lib/ultra-authoring.test.ts` | NEW | The four required sections are present, the model rule is stated, the worked example compiles under `compileScript`. AC8. |
| `apps/web/lib/use-ultra-runs.ts` | NEW | Track D's client hook: one `EventSource` per live run on `/api/ultra/[id]/events`, plus the session-scoped list. `apps/web/lib/use-ultra-wake.ts` is the template. AC1–AC5. §5.5-D4. |
| `apps/web/components/session/ultra-anchor.tsx` | NEW | The `ultra:run-anchor` `ItemKind`, renderer written **INLINE** (hard rule 10). AC1, AC2, AC5. §5.5-D9. |
| `apps/web/components/session/ultra-rail.tsx` | NEW | The Workflows section: run cards, phase groups, agent rows, the fixed-height narrator window, the Script tab. AC3, AC4, AC5. §5.5-D10. |
| `apps/web/components/session/subagent-rail.tsx` | EDIT | **Declared widening (Track C-adjacent).** Two optional props — a `workflows?: ReactNode` section rendered above the sub-agent list, and a `workflowCount?: number` for the collapsed edge. Nothing else in the file changes. AC3. §5.5-D10. |
| `apps/web/components/session/session-view.tsx` | EDIT | **Declared widening, enumerated to TEN expressions in §5.5-D1.** The kind registration, the anchor splice, the run hook, the rail wiring and its `railAgents.length > 0` condition, the composer chip and the one wire key it adds to the POST body, the queue's armed flag, the focus param, and the auto-dock guard. AC1–AC7. |
| `apps/web/app/api/ultra/route.ts` | EDIT | `GET` gains an optional `?sessionId=` filter and returns rows already carrying a rendered `name`, plus the `try`/`catch` the wakes route already has. AC3, AC4, AC7. §5.5-D5, §5.6-T8. |
| `apps/web/app/api/ultra/[id]/agents/route.ts` | NEW | The agent index — which ordinals have begun, their latest text, whether they have settled. The rail's live rows have no other source. AC3. §5.5-D6. |
| `apps/web/app/api/ultra/[id]/script/route.ts` | NEW | `readUltraScript` has **no HTTP surface today**; the read-only Script tab has no other data source. AC3. §5.5-D11. |
| `apps/web/components/dock/dock-provider.tsx` | EDIT | `Runtime` gains one field for the session's live-run summary. AC7. §5.5-D13. |
| `apps/web/components/dock/dock.tsx` | EDIT | The head renders `name · state · spend` when that field is non-empty, and the tap carries the focus param. AC7. §5.5-D13. |
| `apps/web/components/common/ultra-dock-signal.tsx` | NEW | The app-wide poller, mounted once in the root layout beside `LoomNotifications`, which is what makes "from anywhere" true for a session the user never docked. AC7. §5.5-D13. |
| `apps/web/app/layout.tsx` | EDIT | One element, inside `<DockProvider>`. Precedent: `LoomNotifications`. AC7. |
| `apps/web/lib/session-prompts.ts` | EDIT | **Declared widening (Track B).** The authoring-reference block, composed into the three ultra-bearing appendices and **not** into `escalationAppendix`. AC8. §5.5-D12. |
| `apps/web/lib/session-prompts.test.ts` | EDIT | The appendix carries the reference on a Claude project/planner/steerer profile and never on escalation. AC8. |
| `apps/web/lib/ultra-mcp.ts` | EDIT | **Declared widening — and it is Track D's own literal write set (`WORK-SPLIT.md`'s Track D row names this file first), so the omission was this table's, not the fence's.** Two changes and no others: `ULTRA_TOOL_DESCRIPTION` loses the surface-API walk-through, the quality patterns and the worked example (they move to `ultra-authoring.ts`), and `export` is added to that const so its test can pin it by name. A cross-reference comment at each end. `createUltraMcpServer`, `ULTRA_AUTO_TOOLS`, `ULTRA_STATUS_DESCRIPTION`, `ULTRA_STOP_DESCRIPTION` and every handler are untouched. AC6, AC8. §5.5-D12. |
| `apps/web/lib/session-profiles.ts` | EDIT | **Declared widening (Track B), and the only place `ctx.provider` exists.** The three ultra-bearing builders pass `provider: ctx.provider` into their composer. Three expressions; nothing else changes, and **no `requiredCapability` is added** (§5.5-D12). AC8. |
| `apps/web/lib/session-profiles.test.ts` | EDIT | *"a plain project session with the Ultra chip OFF has an EMPTY appendix"* stays true for **Codex** and becomes deliberately false for **Claude**. Carry the old expectation, the reason it was right, and the half that did not change — the same protocol §5.5-D12 sets for `session-prompts.test.ts`. AC8. |
| `apps/web/lib/ultra-mcp.test.ts` | EDIT | The `ultra` tool description still names the chip annotation — the client half now exists, so pin the sentences the client depends on (AC6). **And D7's proof: `ultra_status`'s rollup is byte-identical with and without `agent-start` in the stream. `ultra_status` is defined in this workspace, so this is the only file that can assert it — `packages/core` cannot import `apps/web`.** AC3, AC6. §5.5-D7. |
| `packages/core/test/ultra-executor.test.ts` | EDIT | The new variant is emitted at spawn, carries `effort`, and **`effort` still does not reach `engineOpts`**. AC3. |
| `packages/core/test/ultra-storage.test.ts` | EDIT | `agent-start` lands on `events.ndjson`; `listUltraAgentOrdinals` sees a live ordinal before it settles. AC3. |
| `packages/core/test/invariants.test.ts` | EDIT | **INV-8b2's scan set widens by one file, with its own discriminator** (hard rule 10), and **INV-10** is appended (§5.5-D14). Nothing else above it is touched. AC10. |
| `apps/web/lib/demo-gallery/conversation/fixtures.validate.test.ts` | READ ONLY | Do **not** edit. Re-run it by name; its two tombstone tests are hard rule 4's proof. |
| `packages/core/test/track-d-prove-run.test.ts` | NEW | The story's prove-run, in the **house form** — a `bun test` suite named `track-d prove-run`, not a shell script. Modelled on `packages/core/test/track-a-prove-run.test.ts` including its header. **Its command carries a path argument** (hard rule 6). §6.4. |
| `_bmad-output/implementation-artifacts/deferred-work.md` | EDIT | Record what you find and do not cross, and **rule explicitly on the SIX items already assigned to you** — re-derive with `awk 'NR>=129' deferred-work.md | grep -n '4\.2'`. §3. |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | EDIT | This story's row, at the close. |
| `_bmad-output/implementation-artifacts/stories/4-2-*.md` | EDIT | This file — §9, §10, §11. |

**Anything outside that table is a cross-track finding, not an edit.** The record-do-not-cross protocol has now run seven times. **Stop and record it in `deferred-work.md`** with a named owner story.

In particular these are **not yours**, even though you will read them:

- `apps/web/components/conversation/**` — the shell. AD-12 froze it; INV-8a/8i pin it; `ConversationProps` is closed at nine names and **there is no tenth slot**. Everything your kind needs arrives in the item **payload**.
- `apps/web/app/api/chat/**` — the chat route. It already reads the `ultra` wire key (hard rule 2's one piece of good news); you are adding the client that sends it, not the server that reads it.
- `packages/core/src/ultra/{sandbox,runner,journal,surface,wake,events}.ts` — read, not written. `wake.ts` in particular: story 4.1 owns it and its guarantee sentence is delicate.
- `packages/core/src/event-bus.ts` and ultra's declared catalogue. §3 rules explicitly that this story declares **no** new event.
- `bunfig.toml`, `KNOWN_VIOLATIONS` (hard rules 8 and 9).
- `apps/web/lib/demo-gallery/**` — the mockup. You read it as a design reference and change nothing in it. Its `fixtures.validate.test.ts` is a gate on you, not a file you own.

**Track D's write set, verbatim from `WORK-SPLIT.md`:**

> | **D — Ultra finish** | `apps/web/lib/ultra-mcp.ts`, ultra owner-adapter pieces, `ultra/` subtree | a `SessionProfile`; item kind `ultra:run-anchor`; a rail section; declared events | A, C |

**Eight rows of the table above sit outside that literal Owns string, and each is deliberate and disclosed.** Six are the widenings proper: `session-view.tsx` (hard rule 2 — the seam does not exist, so the adapter is edited); `subagent-rail.tsx` (the "rail section" seam, which today is not a seam but a component with seven props and two consumers); `dock-provider.tsx` + `dock.tsx` + `layout.tsx` (FR-UW-6 has no other home, and `deferred-work.md` already names 4.2 as the dock's owner); and `session-prompts.ts` + `session-profiles.ts` + their two test files (the appendix is the only per-turn channel, exactly as 4.1 found, and `ctx.provider` reaches a composer only through a builder — §5.5-D12). **Two more are declared here rather than left implicit:** `apps/web/lib/session-prompts.test.ts` and `packages/core/test/invariants.test.ts` — `WORK-SPLIT.md` gives `packages/core/**` to Track A, whose A6 unit is *"executable invariant assertions in `bun test`"*; story 4.1 took the same widening under a one-line fence (*"Append INV-9 only"*), and this story's fence is **"INV-8b2's scan set plus INV-10, and nothing else."**

**`packages/core/src/ultra/executor.ts` is NOT one of them** — it is literally inside the `ultra/` subtree and therefore inside Track D's Owns column. What it widens is `SPEC.md`'s non-goal *"Rebuilding U1–U5 engine, tools, routes, or storage"* (hard rule 11), which is a different fence, and it is disclosed as such. **Likewise `apps/web/lib/ultra-mcp.ts` is inside Owns** — its row was simply missing from an earlier draft of this table.

**Disclose every one of these in your Completion Notes with the line counts you actually produced.**

---

## 1. User Story

As someone running an Ultra workflow,
I want to watch and control it from the session I launched it in,
So that the feature is usable outside the demo gallery.

**Why this story exists, in one paragraph.** `SPEC-ultra-workflows` says the engine *"is built and solid, but the feature fails today at the two human touchpoints: there is no real UI to see a run happen, and completion delivery is polling-only."* Story 4.1 closed the second. This closes the first, and with it the epic: after this story a user can ask for a run, watch it, stop it, resume it, see what it cost, and be told when it finished — all inside one session, with the app's own chrome. `brownfield.md` states the starting position without hedging: *"No real UI: session-view, sub-agent rail, and composer have zero Ultra wiring."* Measured at `e093a98` that is still exactly true. `grep -rn "api/ultra" apps/web --include="*.tsx"` yields **one** hit and it is a **comment** — story 4.1's note in `session-view.tsx` reserving `/api/ultra/[id]/events` for you. The only production **call** to any ultra endpoint in the whole app is `use-ultra-wake.ts`'s `GET /api/ultra/wakes`. **Every non-wake ultra endpoint has zero production callers.** (Run that grep yourself and exclude `.next` — the build artifacts under `apps/web/.next/dev/types/` list every route and will make any `api/ultra` search look busy.)

**What is already true, and is why this is wiring plus four small gaps rather than invention.** Measured at `e093a98`:

- **The launch already surfaces on the session's own SSE stream, and needs no new event.** `apps/web/lib/ultra-mcp.ts`'s header says it in advance: *"The transcript ANCHOR (doc §6.2) needs no new event type of its own here: launching a run already surfaces as an ordinary `mcp__ultra__ultra` tool-call/tool-result pair on the session's existing SSE stream (id/name/input/output, exactly like every other tool call route.ts already relays) — a future UI reads `output.runId` off that same event to open `/api/ultra/[runId]/events`."* You are that future UI. That sentence is the whole seam for AC1.
- **Every endpoint the anchor and rail need already exists** except three: `GET /api/ultra` (list), `GET /api/ultra/[id]` (manifest), `GET /api/ultra/[id]/events` (SSE `run`/`ev`/`end`), `GET /api/ultra/[id]/agents/[ordinal]` (one agent's transcript), `POST /api/ultra/[id]/stop`, `POST /api/ultra/[id]/resume`. The three missing ones are a session filter, an agent **index**, and the script's bytes (§5.5-D5, D6, D11).
- **The composer chip's server half already shipped, in story 2.2.** `apps/web/app/api/chat/route.ts` destructures a wire field literally named `ultra`, narrows it with `const ultraAnnotated: boolean = rawUltra === true` (*"anything but a literal `true` collapses to false"*), threads it into `resolveSessionProfile`, and `apps/web/lib/session-prompts.ts`'s `ultraNote` emits `ULTRA_ANNOTATION_NOTE` into the turn's appendix. `ultra-mcp.ts`'s `ULTRA_TOOL_DESCRIPTION` already honours it: *"ONLY call this when the user explicitly asked … they said 'ultra', or their message is Ultra-annotated (the composer's Ultra chip, noted in your system context for this turn). Never infer it yourself."* **The entire remaining job for AC6 is a toggle and one wire key.**
- **The shell's vocabulary already admits you.** `apps/web/components/conversation/registry.ts`'s `MODULE_NAMESPACES` already contains `"ultra"`, so `ultra:run-anchor` is legal with no contract change; and `session-view.tsx`'s own `SESSION_AGENT_BUCKET` / `agentBucketKind` is the worked example of an adapter-local kind, recorded by story 3.1 as *"4.2's template"*.
- **The cost language already exists and is already yours to reuse.** Story 4.1 shipped `apps/web/lib/spend-readout.ts` — pure, dependency-free, USD on Claude and tokens on Codex — and its own header anticipates this story reaching for it. **Do not mint a fourth formatter.**
- **The dock already survives navigation.** `DockProvider` is mounted above the router in `apps/web/app/layout.tsx`, so half of FR-UW-6 is free. The half that is not free is §5.5-D13.

---

## 2. Acceptance Criteria

**AC1–AC9 are verbatim from `epics.md` § Epic 4 / Story 4.2.** AC10 and AC11 are **story-added** and disclosed as such: AC10 exists because hard rule 10's blind spot means the frozen purity contract would otherwise be unenforced for the one kind this story adds, and AC11 exists because hard rule 3's four data gaps would otherwise be closed by whichever invention the implementer reached for first.

### AC1 — a fixed-height tool-style anchor appears in the transcript

**Given** a run is launched in a real session
**When** it renders
**Then** a compact **fixed-height** tool-style anchor appears in the transcript — run name, state pill, agents done/total, quiet spend readout, thin progress sliver — and the conversation continues beneath it

**Proof.**
1. The anchor is a registered item kind, `ultra:run-anchor`, in `SESSION_KINDS` — not adapter chrome, not a `trailing` node. `apps/web/components/session/ultra-anchor.tsx` exports the `ItemKind`; `session-view.tsx` splices it into the registry beside `agentBucketKind`.
2. It stands **where the launch happened**: `apps/web/lib/ultra-runs.ts`'s `spliceRunAnchors(items, runsById: ReadonlyMap<string, RunSnapshot>)` is a pure function over the `RenderItem[]`/`TranscriptItem[]` the adapter already builds, which finds the `mcp__ultra__ultra` tool part, reads `runId` off its `output`, and replaces that one part with an anchor item. **It splits the surrounding `conversation:tools` group rather than appending after it** (§5.6-T4 — appending steals the streaming turn's liveness).
3. Every field named in the AC comes from a source that exists, or is absent by AC11's rule. **`name` is the one that does not survive a naive reading:** `ultraRunLabel` is a `@telar/core` **VALUE** export, so calling it from `ultra-runs.ts` — reached from a `"use client"` root — is an `INV-4c` violation reported by name; and the anchor's own per-tick channel, the SSE tail, sends the **bare `UltraManifest`**, which has no `name` field at all. §5.5-D5a rules on it: the list route renders a `name` server-side **and** `ultra-runs.ts` carries a four-line copy of the label rule for the stream-only window, with a test asserting the two agree. `state` from `manifest.state`; spend from `spendReadout(provider, { usd: run.spendUsd, tokens: 0 })` — §5.5-D6a spells out why that literal `0` is not a fabricated figure; `agents done` from the deduped ordinal count; `agents total` and the sliver from §5.5-D6.
4. **The renderer is a pure function of `(payload, view)` and reads nothing else** — no fetch, no `EventSource`, no context, no `sessionId`. All run data arrives pre-fetched in the payload, which `session-view.tsx` builds from `use-ultra-runs.ts`. AC10 is what makes this executable.
5. Observed at the dev server, per the dev-server proof.
6. **The anchor is a focus control.** `ui-contract.md` §2's last sentence — *"Clicking it focuses that run in the rail."* — is part of the AC's own contract. Clicking the anchor body selects that run in the rail's Workflows section and expands it, through the same state the `?run=` param drives (§5.5-D13). It is **not** a `<button>` wrapping the Resume/Stop buttons (§5.6-T19 item 14): the container carries `role="button"` + `tabIndex={0}` + `onKeyDown` for Enter/Space, and the two real buttons `stopPropagation`.

**Notes.** "Tool-style" is a visual claim about `apps/web/components/session/tool-step.tsx`, not a licence to render the run as a tool call. Match its register — the bordered card, the mono name, the truncating one-line detail — and reuse its density, not its component.

### AC2 — the anchor never grows or reflows, and collapses exactly once

**Given** the run is progressing
**When** ticks arrive
**Then** the anchor never grows or reflows; its only permitted height change is a one-time collapse to a one-liner at terminal

**Proof.**
1. The running form is a fixed two-row card: a header row and a detail row carrying one **truncated** line plus the sliver. Every variable-width child carries `min-w-0` + `truncate` (`ui-contract.md`'s house rules). No wrapping, no conditional rows, no list that grows with tick count.
2. The terminal form drops the detail row. That is the **one** permitted height change, and it happens once, when `state` leaves `running`.
3. **Executable, not merely asserted:** `apps/web/lib/ultra-runs.test.ts` proves the payload's rendered-height class is a pure function of `state` alone — a helper (`anchorForm(payload) → "running" | "terminal"`) that the renderer consumes, driven across a sequence of twenty successive event snapshots of one run, asserting the value changes **at most once** and only on the terminal transition. A height claim cannot be tested without a DOM; a claim that *the shape-selecting function is constant while running* can, and that is the honest proof. Say so plainly.
4. Why this matters mechanically, and it is not cosmetic: `apps/web/components/ai-elements/conversation.tsx` configures `StickToBottom` with `resize="smooth"`, so **anything that grows mid-stream animates the whole transcript.** NFR-UW-11 is a rendering constraint with a real cause.

### AC3 — the sub-agent rail gains a Workflows section

**Given** the existing sub-agent rail
**When** a session has runs
**Then** it gains a Workflows section listing every run — cards with name, state, spend and Stop; phase groups holding per-agent rows with `model·effort` chip and masked-shimmer snippet; a **fixed-height scrolling narrator window with no layout shift, ever**; and a read-only Script tab linking out to the authoring reference

**Proof.**
1. `apps/web/components/session/ultra-rail.tsx` renders the section; `subagent-rail.tsx` gains **one optional `workflows?: ReactNode` prop** and renders it above the sub-agent list, plus `workflowCount?: number` for the collapsed edge. **The rail's `railAgents.length > 0` gate in `session-view.tsx` widens to include runs** — an Ultra-only session shows no rail at all today (§5.6-T3).
2. **Run cards** — `name`, `state`, spend, and a Stop button hitting `POST /api/ultra/[id]/stop`. `{"ok": false}` is the **normal** answer for an already-terminal or restarted run, not an error (§5.6-T9); the card reconciles from the next manifest snapshot rather than trusting the button's reply.
3. **Phase groups** — grouped by **stream order** on `events.ndjson`: an agent belongs to the most recent preceding `phase` event. There is no phase id, no `kind`, and no agent→phase link in the data (§5.6-T5); the grouping rule is a pure function in `ultra-runs.ts` and is unit-tested, including the resume case where the whole phase sequence re-emits.
4. **Per-agent rows** — `label` · state · `model·effort` chip · masked-shimmer snippet · cost. The **live** half of this has no data source today and §5.5-D6 gives it one: an `agent-start` event carrying `{ordinal, label?, model, effort?}`, plus `GET /api/ultra/[id]/agents` for the snippet. **The snippet comes from the HIGHEST `attempt`** — a retried ordinal's attempt-1 text is discarded work.
4b. **An agent row opens its transcript**, per `ui-contract.md` §3: *"Clicking an agent row opens its transcript as a sub-agent tab does today."* The data source already exists and this story adds none for it: `GET /api/ultra/[id]/agents/[ordinal]` → `{ ordinal, events }` from `readUltraAgentTranscript`, whose records carry `attempt` (`packages/core/src/ultra/storage.ts`, `appendAgentEvent`). Render the selected ordinal's events in the rail's own panel — **not** by minting a `RailAgent` and **not** by touching `agent-tabs.tsx`, whose `activeId` vocabulary belongs to session sub-agents. Show the HIGHEST `attempt` only, for proof 4's reason. **Without this the existing `[ordinal]` route has zero consumers after this story, which is how you can tell the clause was dropped.**
5. **The narrator window** — `log` events, in a container with an explicit height and `overflow-y-auto`, auto-scrolled in a post-mount effect (`el.scrollTop = el.scrollHeight`), never by `scrollIntoView` (there is none anywhere in `apps/web`) and never by a programmatic `.focus()` (WebKit 26.x). **It filters `storage.ts`'s four accounting-failure `log` prefixes** (§5.6-T6) — a naive narrator shows the ledger's bookkeeping errors to the user.
6. **The Script tab** — `GET /api/ultra/[id]/script` (new, §5.5-D11) renders read-only, and the link-out opens the authoring reference. **The gallery's `href="#authoring-reference"` with `preventDefault` is a dead anchor and is forbidden** (hard rule 3: no placebo). §5.5-D12 fixes the destination.
7. **The result stays reachable from the rail card.** `ui-contract.md` §7: *"`done` triggers the anchor's one permitted collapse; the result stays reachable from the rail card."* The anchor collapses and drops its detail row (AC2), so the script's returned value has exactly one home — the run card. `manifest.result` is present **only** alongside `done`; render it in the card, read-only, in the same `JsonBlock`-style `<pre>` register the rail already uses for the script. A `done` run whose result is unreachable anywhere in the UI fails this clause even though every other part of AC2 and AC3 passes.
8. `bun test apps/web/lib/ultra-runs.test.ts` proves every projection in 2–7 that is not a DOM claim. **One path, joined — `bun test apps/web ./lib/ultra-runs.test.ts` is NOT that command: bun ignores the second positional and runs all 20 `apps/web` files, so it exits 0 even if your file does not exist.** (Measured: `bun test apps/web ./lib/spend-readout.test.ts` → `Ran 498 tests across 20 files`; `bun test apps/web/lib/spend-readout.test.ts` → `Ran 6 tests across 1 file`.)

### AC4 — concurrent runs are first-class

**Given** two runs are live at once
**Then** anchors stack where launched and both list in the rail — concurrent runs are first-class

**Proof.**
1. `spliceRunAnchors` is keyed by `runId` and produces one anchor per launch call site; two launches in one turn produce two anchors in stream order, and two launches in different turns produce anchors in different turns. A test drives a two-launch transcript and asserts both keys, in order, and that no other item was dropped.
2. `use-ultra-runs.ts` holds a `Map<runId, RunSnapshot>` and opens **one `EventSource` per live run**, closing each on its `end` frame. §5.6-T7 is the trap: **missing `es.addEventListener("end", () => es.close())` re-opens the stream forever, per anchor, per run** — `session-view.tsx` already does this correctly twice and is the template.
3. The rail lists every run of the session, newest-first, from `GET /api/ultra?sessionId=`.
4. Anti-vacuity: a test with **one** run asserts exactly one anchor and one card, so "everything stacks" cannot pass this AC.

### AC5 — Resume on `stopped`/`failed`, and `failed` shows its terse error

**Given** a run in `stopped` or `failed`
**Then** a Resume affordance shows, and `failed` shows the terse terminal error

**Proof.**
1. The affordance appears for `stopped` and `failed` and **not** for `done`. That is a UI rule, not a core rule: **core does not gate resume on state, and a `done` run is resumable** (§5.6-T10). State the asymmetry in a comment so the next reader does not "fix" the UI to match the port.
2. Resume posts an **empty body** to `POST /api/ultra/[id]/resume`, which replays the persisted `script.js` and inherits the original project and account — that route's own comment names this exact affordance as the caller.
3. **Resume is not idempotent**: a second POST while the run is live returns `400 {"error":"Ultra run \"…\" is already running."}`. The affordance disables itself on click and reconciles from the next manifest snapshot; a 400 renders as the terse error, not as a crash.
4. `failed` renders `manifest.error` — one line, truncated, `min-w-0`. It is present only on non-`done` runs.
5. **A resumed run's stream duplicates, and the UI must survive it**: `events.ndjson` gains a second `agent` event for every replayed ordinal carrying `cached: true`, and `startedAt` is **reset**. `ultra-runs.ts` dedupes agent rows **by ordinal, last-wins**, and a test drives a real resumed event sequence to prove the row count does not double.
6. **The AGENT can stop a run too, and that must be visible.** `ui-contract.md` §5 requires the UI to accommodate *"the agent stopping a run by tool call (visible in anchor + rail)"* — an `mcp__ultra__ultra_stop` call, not a click. Because both the anchor and the rail read state from the **manifest** (the SSE `run` snapshot and the list poll) rather than from the button they own, this is satisfied by construction — **but only if you do not shortcut it.** A Stop button that optimistically sets local state to `stopped` and stops listening will show a stale `running` for every agent-initiated stop. **Do not render an optimistic state; render the manifest.** Say so in a comment and observe it once in the dev proof.

### AC6 — the composer chip arms exactly one message

**Given** the composer chip
**When** armed
**Then** it annotates that one message `ultra: true`, which the `ultra` tool description honors — arming only, no ceiling editor, no submenu
**And** a message with neither chip nor explicit keyword never triggers `ultra`

**Proof.**
1. The chip is a **toggle in `PromptInputTools`**, beside the existing per-message controls, on the **Claude branch only** — `route.ts` constructs the ultra MCP server only in the non-Codex fork, and NFR-UW-8 is *"Claude-first"*. It is **not** inside `ComposerSettings` (that popover is per-project remembered config, and the AC forbids a submenu).
2. Arming adds exactly `...(ultraArmed ? { ultra: true } : {})` to the existing `POST /api/chat` body. **The wire name is `ultra`** — the route destructures that key; do not invent `ultraAnnotated`, `ultraArmed` or `annotateUltra` on the wire.
3. **It disarms after the send it armed, and it is not persisted.** A test in `apps/web/lib/ultra-runs.test.ts` drives the pure arm-state reducer across `arm → send → next send` and asserts the second send carries no key. The armed flag must **not** be written into `telar:composer:${project}` (§5.6-T11). **And a second test asserts the wake path is unreachable from the chip**: story 4.1's hidden injection dispatch carries no `ultra` key even with the reducer armed (§5.5-D1 item 6 — the shared body literal is the mechanism that would otherwise annotate a turn that has no user message).
4. **Queued messages carry their own flag.** `messageQueue`'s element type cannot carry one today; arming while the agent is busy and pressing Enter would otherwise apply the annotation to the wrong message. §5.5-D2 is the two-line change, in the shape of story 4.1's `hidden` precedent.
5. **"Never triggers without an ask" is proved where it is actually enforced, and that is prose, not code.** `apps/web/lib/ultra-mcp.test.ts` asserts `ULTRA_TOOL_DESCRIPTION` still contains two substrings, **copied out of the file and not out of this story** — the source sentence is *"ONLY call this when the user explicitly asked for a large orchestrated/parallel run — they said "ultra", or their message is Ultra-annotated (the composer's Ultra chip, noted in your system context for this turn). Never infer it yourself from an ordinary request."*, and it does **not** end at "yourself". Pin `"the composer's Ultra chip"` and `"Never infer it yourself"` (no terminal period) so the assertion survives a re-word of the tail but not a deletion of the clause. `session-prompts.test.ts` asserts `ultraNote(false) === ""`. Say plainly in Completion Notes that this is a **prompt-level** constraint (`ultra-mcp.ts`'s own header says so — *"opt-in is a REQUEST enforced by the tool description … never a per-call human click"*) and that no test can prove a model's restraint.
6. The chip is **gated off the escalation surface**, which hard-denies all three ultra tools and whose appendix composer has no `ultraAnnotated` parameter at all — the absence is enforced by the type.

### AC7 — the dock shows a live run signal from anywhere, and tapping focuses it

**Given** the user is on another page with a run live
**Then** that session's dock bubble shows name · state · spend updating live, and tapping it navigates back and focuses the run

**Proof.**
1. `apps/web/components/common/ultra-dock-signal.tsx` is mounted **once in the root layout, inside `<DockProvider>`**, and polls **`GET /api/ultra` UNFILTERED** — one request, every run, newest-first — on the house cadence, grouping `running` rows by `manifest.sessionId`. **It must not use the `?sessionId=` filter.** The only sessions a component inside the provider can enumerate are `useDock()`'s `entries`, and AC7's whole case is a session that is **not** an entry: filtering by the sessions you already know about can never discover the one you do not. `?sessionId=` (§5.5-D5) exists for `use-ultra-runs.ts`, which knows its own id; this poller is the one caller that legitimately needs the whole list. It does **zero** background work when the list is empty — `loom-notifications.tsx`'s disarmed property, which polls an equally unfiltered `/api/looms` on a 30s cadence and is the shipped precedent for exactly this trade.
2. **A session with a live run gets a head even if the user never docked it.** `<Dock>` renders `null` when `entries.length === 0`, and `SessionRuntimeHost` mounts only for entries — so without this the whole AC is unreachable. The signal calls the dock's own public `autoDock(...)`. **`DockEntry` needs `{ id, title, project, initial }` and a manifest supplies none of them:** `title` and the project **slug** come from `GET /api/chats`, keyed by chat id; `initial` is minted exactly as `session-view.tsx`'s existing auto-dock mints it. **Never `manifest.project`** — that field is a filesystem root path (§5.6-T15) and `dock.tsx` interpolates the entry's `project` straight into `/projects/<project>/sessions/<id>`, so a path there produces a dead URL. A session id with no matching chat row is **skipped**, never docked with a placeholder title.
3. **Today's auto-dock does not fire for this case, and that is the second half of the same gap.** `session-view.tsx`'s unmount effect auto-docks only when the **chat turn** is `busy`; an Ultra run is detached and outlives its turn. The guard widens to "busy **or** this session has a live run". One expression, disclosed.
4. The head renders `name · state · spend`. **There is no spend anywhere in the dock today** — `Runtime.cost` is written and never read (four grep hits: one declaration, two defaults, one write, zero reads) — so this is new rendering, not a reuse. It goes through `spendReadout(...)`, not a new formatter.
5. Tapping pushes `/projects/<project>/sessions/<id>?run=<runId>`. **`SessionView` is keyed `project:id`, so a query-only change does not remount** — the consuming effect must depend on the param, not on `[]`. `session-view.tsx` reads it into `openRunId` (§5.5-D1 item 10) and passes it to the rail, then clears it with `router.replace(pathname, { scroll: false })` — the state lives in the adapter because its writer does, and because §3 forbids the new context a rail-local version would need. **No `element.focus()` on the session surface.** The rule is real but it is not a repo-wide absence — `grep -rn "\.focus()" apps/web --include="*.tsx"` finds `components/ui/input-group.tsx` and `app/demo-gallery/demo-nav.tsx`, both legitimate click-to-focus-an-input calls. What the policy forbids is a programmatic `.focus()` used to MOVE or SCROLL, and it is written down three times in the surface you are extending (`agent-tabs.tsx`'s header on WebKit 26.x, `subagent-rail.tsx`, `session-view.tsx`). **"Focus" in this AC means *select that run in the rail and expand it* — state, not a DOM call.**
6. "One dock signal per session; concurrent live runs summarize" (`ui-contract.md` §9): one run renders its name, N>1 renders `N runs live`, and the spend is the sum of those runs' readouts. A unit test drives the summarizer for 0, 1 and 3 runs.

### AC8 — the authoring reference is injected for Claude sessions

**Given** a Claude session
**Then** the authoring reference is injected via the profile's `systemPromptAppendix`, covering the injected surface API, the explicit-model rule, the quality patterns and one worked example

**Proof.**
1. `apps/web/lib/ultra-authoring.ts` exports `ULTRA_AUTHORING_REFERENCE` — one pure string, no React, no core import, no fs. **It is a module and not a `.md` on disk** (§5.5-D12 gives the two reasons, one of which is that the packaged Electron app would not ship the file).
2. `apps/web/lib/session-prompts.ts` composes it into `projectAppendix`, `plannerAppendix` and `steererAppendix` — the three composers that already carry `ultraNote` — and **not** into `escalationAppendix`, for the reason that file already states about the ultra note.
3. `apps/web/lib/session-prompts.test.ts` asserts the composed appendix contains each required subject by a stable marker, and that the escalation appendix contains **none** of them. **"The quality patterns" is not a free slot — `SPEC.md` CAP-3 enumerates it: *"the quality patterns (adversarial-verify, loop-until-dry)"*.** The reference names both, in those words, and `ultra-authoring.test.ts` asserts both literal strings are present. This matters mechanically: those two names appear in exactly **one** production string today — `ULTRA_TOOL_DESCRIPTION` — and §5.5-D12 has you delete that paragraph. **Re-derive `grep -rn "loop-until-dry\|adversarial-verify" apps packages --include="*.ts" --include="*.tsx"` before and after your change and record both figures.** If the reference does not carry them, this story *removes* two named patterns from the product.
4. `apps/web/lib/ultra-authoring.test.ts` asserts the worked example is a real script: it is fed to `compileScript` (the same static gate `ultra` uses before minting a `runId`) and must compile, with every `agent()` call carrying a `model`. **A reference whose own example would be rejected by the tool it teaches is worse than no reference**, and this is the only way to know.
   **And it carries a two-direction discriminator, because otherwise it proves nothing.** Measured at `e093a98`: `apps/web/lib/ultra-mcp.test.ts` installs a process-global `mock.module("@telar/core", …)` **at module scope** whose `compileScript` returns a canned value initialised to `{ ok: true, … }`, restored only in `afterAll`. Under the filtered form hard rule 6 requires (`bun test apps/web -t "…"`) every module scope evaluates before any test runs and no `afterAll` fires — so the stub is live and the positive assertion above is **satisfied by a stub that says yes to everything.** This is maxim 3 exactly: a guard that cannot fail is worse than no guard. So the same test also feeds `compileScript` a script the real gate **must** reject — a model-less variant of the same example, or a `meta` that is not a pure object literal — and asserts `ok === false` with a non-empty `kind`. If the negative case also returns `ok: true`, **you are testing the stub, the positive result means nothing, and the failure text must say so and stop.** Record in your Debug Log both the filtered verdict and the run-this-file-alone verdict (`bun test apps/web/lib/ultra-authoring.test.ts`); if they differ, the file-alone one is the fact. The leak is story 1.3's and is not yours to repair.
5. It is **static**, so it needs no `safeLiveContext` — say so in a comment, because every other block added to that file since 2.1 has been a live read.
6. The rail's Script tab links to the same string, so there is exactly one source (`ui-contract.md` §3's *"link-out to the authoring reference (CAP-3)"*).
7. The reference carries the dispatch note's **fifth** subject — no servers, no long-lived processes via Bash, because nothing supervises an Ultra child's processes and service work belongs to sessions and looms — and `ultra-authoring.test.ts` asserts it by a stable marker alongside the other four.

### AC9 — no budget UI anywhere

**Given** the whole surface
**Then** there is **no budget UI anywhere** — spend readouts only, no meters or ceilings

**Proof.**
1. Every money figure on every new surface goes through `spendReadout(...)`, whose own header says *"NOT A BUDGET (NFR-UW-7): a readout has no ceiling, no percentage and no reserved headroom. It states what was spent and stops."*
2. **Executable:** a static scan in `apps/web/lib/ultra-runs.test.ts` over an **enumerated four-path list — `apps/web/components/session/ultra-anchor.tsx`, `apps/web/components/session/ultra-rail.tsx`, `apps/web/components/common/ultra-dock-signal.tsx` (the three new component files) and `apps/web/components/dock/dock.tsx` (the one edited file this story makes render money, AC7 proof 4)** — rejects the tokens of a budget: `budget`, `ceiling`, `maxCost`, `remaining`, `headroom`, `%` adjacent to a currency, and `<Progress`. The floor is `expect(read.length).toBe(4)` over that literal list, so a renamed or deleted file fails loudly instead of scanning nothing; the discriminator feeds a synthetic file containing one token through the same function and asserts it is reported, and one without it and asserts it is not. §5.4-F.
3. The one bar that exists is the **phase** sliver and is a fraction of declared phases, never of money. Its own comment says so.
4. Core agrees by construction: `grep -rn "budget\|maxCostUsd\|ceiling" packages/core/src/ultra/` finds only prose contrasting ultra with `weave.ts`. **There is nothing to build a meter from.**

### AC10 — (story-added) the registered kind is provably pure, and the scan that proves it can actually see it

**Given** the `ultra:run-anchor` kind
**Then** its renderer reads nothing from ambient context, and INV-8b2 — the scan that asserts this — **actually scans it**

**Proof.**
1. The kind is declared as `export const ultraRunAnchorKind: ItemKind<UltraAnchorPayload> = { id: "ultra:run-anchor", render: (payload, view) => ( … ) }` — **that exact shape**: a `: ItemKind<…>` annotation carrying its generic, and the renderer **inline in the object literal**. Hard rule 10 enumerates the four shapes that defeat the extractor, three of which leave the invariant **green**. A test asserts the slice for `ultraRunAnchorKind` was found and that its source is longer than the 40-character body control — because "the scan found nothing" and "the scan found nothing wrong" are the same colour otherwise.
2. `invariants.test.ts`'s `DONOR_KIND_SLICES` scan set widens from `{session-view.tsx}` to `{session-view.tsx, components/session/ultra-anchor.tsx}`, with the reason written in place **and the floor's failure message updated to name both files** — a guard whose diagnosis names the wrong file is the defect class §0 exists to prevent.
2b. The new file is additionally scanned **whole**, not only as slices: `ambientContextScan`'s import arm cannot fire on a slice (a slice has no import statements), so only a whole-file pass catches an imported-but-not-yet-called context hook. Both assertions, or the widening is half a guard.
3. **The widened scan carries its own discriminator, in both directions**: a runtime-assembled fixture in the shape of the new file, containing a `useContext(` inside an inline renderer, is **reported** by the same function the real check uses; and one without it is not. Without this, widening a scan set is indistinguishable from widening it to a file that happens to be clean.
4. The floor grows with the set: the anti-vacuity assertion counts slices found and their names must contain both `"agentBucketKind"` (INV-8b2 already pins this) and `"ultraRunAnchorKind"`.
5. `ConversationProps` is still nine names — proved as a **type annotation** on a data object, never as a call (hard rule 5).

### AC11 — (story-added) the surface is honest about what the engine does not produce

**Given** the five fields the frozen contract names that the engine does not produce today
**Then** each is either sourced by this story's declared additive change, or is **not rendered at all** — and never faked

**Proof.**
1. **`effort`** — sourced. Added as an optional field on the `agent` and `agent-start` events (§5.5-D6). The chip renders `model·effort` when effort is present and `model` alone when it is not; a test drives both. **It still must not reach `engineOpts`** — `ultra-executor.test.ts`'s existing `expect("effort" in seen[0]!).toBe(false)` is re-run by name and recorded.
2. **live agent rows** — sourced, by `agent-start` plus `GET /api/ultra/[id]/agents`. A test asserts an ordinal is visible **before** it settles.
3. **agents `total`** — **NOT sourced, and NOT invented.** Nothing in the engine knows how many agents a script will spawn; a script may spawn any number, in a loop, conditionally. The readout is `N done` while running and `N done` at terminal, and the anchor renders a denominator **only** when the script's own `meta.phases` gives one for phases — never for agents. `apps/web/lib/ultra-runs.test.ts` asserts the projection returns `total: undefined` for a running run and that the renderer omits the denominator when it is undefined.
4. **the progress sliver** — sourced from **phases, not agents**: `meta.phases.length` (the convention `ULTRA_TOOL_DESCRIPTION` teaches: `export const meta = { name, description, phases }`) as the denominator, and the count of distinct `phase` events seen as the numerator. **`ScriptMeta` is `Record<string, unknown>` and nothing validates `phases`** — so the projection reads it only when it is an array of strings, and returns `undefined` otherwise, exactly as story 4.1's `ultraRunLabel` reads `meta.name` only when it is a non-empty string. **When it is undefined the sliver is not rendered.** An indeterminate animated bar is a placebo and is forbidden.
5. A single test named for this AC drives a run whose `meta` has no `phases` and asserts: no denominator, no sliver, no crash, and the rest of the anchor intact.
6. **per-agent `tokens` — NOT SOURCED, and NOT INVENTED.** `ui-contract.md` §3 asks the agent row for *"tokens/cost"* and §2 asks the anchor for *"tokens Codex"*. Measured: `grep -rn "tokens" packages/core/src/ultra/*.ts` finds a comment and no field, and ultra's own ledger write passes `costUsd` and **no token counts at all**. The gallery fakes it — `agentTokensAt` linearly interpolates a count over wall time (§5.6-T1 item 4). So the row renders **cost only**, and renders nothing where a live agent has no cost yet. The Codex half of `spendReadout` is unreachable here by NFR-UW-8 and the anchor always calls it with the Claude provider — **say that in a comment rather than passing `tokens: 0`**, which would render a confident `0` the moment anyone flipped the provider. `ultra-runs.test.ts` asserts the projected agent row has no `tokens` key at all.

### Dev-server proof

Quoted from `epics.md`: *"`bun run dev`, ask for an Ultra run in a real project session — anchor and rail track it live over SSE, Stop lands it `stopped`, Resume re-runs from the journal, and navigating away shows the dock signal."*

Your Debug Log must carry, for this:

- The exact `TELAR_HOME` the dev server resolved, **confirmed before you start it**. `apps/web`'s `dev` script defaults it to `~/.telar-dev` for isolation — confirm that, do not assume it, and never run a dev server or a probe that resolves the operator's real `~/.telar`.
- **First, the cleanup that story 4.1's own record demands.** `orchestrator-run-log.md` records five leftover run directories in `~/.telar-dev`, and names `u-fixround-bad` as *"a deliberately malformed manifest … Until it is gone, `pendingUltraWakes` throws for every session against that root."* **Your rail, your dock signal and your new list route read that same directory** (§5.6-T8). Record what you found there, what you removed, and what you left — and if you cannot remove it (no agent in this run has been able to delete under `$HOME`), record that the proof was gathered with a known-poisoned root and say which observations that invalidates.
- The armed chip: a screenshot-equivalent description of the composer with the chip on, the request body you observed carrying `ultra: true`, and the **next** message's body carrying no `ultra` key.
- The launch: the `runId` returned, the anchor's rendered fields at three moments (just after launch, mid-run, at terminal), and an explicit statement of whether the anchor's height changed more than once.
- The rail: the Workflows section with the run card, at least one phase group, at least one agent row **while it was still running** (this is what proves §5.5-D6 landed), the narrator window scrolling without moving anything around it, and the Script tab showing the real script bytes plus a link-out that goes somewhere real.
- Two concurrent runs: both anchors, both cards, and a note on whether either stream interfered with the other.
- Stop: the `POST` response body (including whether it was `{"ok": false}`), and the state the manifest actually reached.
- Resume: the second run's event stream, the duplicate `cached: true` agent events, and confirmation that the rail's agent-row count did **not** double.
- The dock: navigate away with a run live; record whether a head appeared **for a session you had not manually docked**, what the head displayed, and what happened on tap — including whether the run was focused on arrival.
- The wake, unchanged: story 4.1's assistant turn must still fire. **A regression here is a regression in the epic's headline feature and is more important than anything this story adds.**
- The gate: `bun test`, `bun run lint`, `bunx tsc --noEmit` in **both** workspaces, with real output and your own re-measured counts.

---

## 3. Scope fences — what this story does NOT do

| Not in scope | Why, and who owns it |
| --- | --- |
| **A new declared bus event, of either class** | **OUT, decided explicitly, and this reverses an obvious reading of the architecture.** `ARCHITECTURE-SPINE.md`'s capability map assigns *"UW CAP-6 dock signal | event bus, human-facing class → dock aggregator"*. Three facts make that the wrong build here: the dock is a **client**, so it cannot subscribe to an in-process bus and something must poll regardless; `INV-9a` pins ultra's catalogue as the exact set `["ultra:run-completed"]`, so a second name is a deliberate contract change that buys nothing this story needs; and NFR-X-15 already fixes the client pattern as poll-plus-refetch, which `LoomNotifications` is the working precedent for. **Consequence, recorded rather than hidden: the `human-facing` delivery class is still exercised by no production event after this story.** Record it in `deferred-work.md`. **Owner: epic 5's workspace, whose "never initiates contact" is the case that class exists to describe** — it is the first story with a real reason to pay for it. |
| **The `sessionId → runIds` index under ultra's subtree** | **OUT, and this is a ruling on an item `deferred-work.md` assigns to 4.2 by name.** The recorded fix is a storage index; what this story ships instead is a `?sessionId=` filter **on the server**, which bounds the payload and moves the filtering off the client but **does not remove the directory walk**. That is a genuine improvement and an honest partial. The index itself is a storage redesign, it is not needed to make any AC true at a developer's run volumes, and the dock's cadence is a slow poll rather than a per-turn path. **Re-record it with the partial noted and the owner unchanged: whichever story next finds the walk too expensive, most plausibly epic 6's fleet surfaces, which ask the same shape of question across many looms.** Do not let the re-record read as "done". |
| **`getUltraManifest`'s unwrapped self-heal `saveManifest`, and the swallowed terminal `saveManifest`** | **OUT, and this is a ruling on two more items assigned to 4.2 by name.** Both are real, both are in `storage.ts`, and both are about **`saveManifest`'s error contract** — changing it means deciding what a failed heal means to every reader and giving the run registry a `.delete` it does not have. This story's `storage.ts` edit is one new reader and one event pass-through; folding an error-contract change into it would make a UI story the owner of ultra's durability semantics. **What this story DOES do about them:** every new route that lists or reads runs is wrapped exactly as `apps/web/app/api/ultra/wakes/route.ts` already wraps its call, so the app-wide 500 stays closed — including `GET /api/ultra`, which is **not** wrapped today and will 500 on one malformed manifest (§5.6-T8). **Owner: unchanged — whichever story next opens ultra's terminal write path deliberately.** |
| **INV-7's four missing reader symbols and the `readWake:` predicate** | **OUT, partially.** `deferred-work.md` names 4.2 as owner *"which will add the run-anchor item kind and therefore touches INV-8's surface anyway"* — and you do touch INV-8's surface. But the recorded fix is to `STATE_ROOT_READERS` and `INJECTED_READER`, which is INV-7's surface, not INV-8's, and it is real work behind a fence this story's own write set draws at "INV-8b2's scan set plus INV-10". **Do the half that is free and say which half:** your new tests must satisfy INV-7 by one of the three sanctioned mechanisms whether or not the guard can see them, and you must state in Completion Notes whether any of your calls is one INV-7 cannot see. **Owner unchanged.** |
| The wake, the ledger, the cost rollup | **Story 4.1's, and shipped.** You consume `spendReadout` and `ultraCostByMessage`; you do not change them. If the wake regresses, that is a bug in your change, not a scope item. |
| Codex-backed Ultra | NFR-UW-8 and the SPEC's non-goals. `route.ts` builds the ultra MCP server only on the Claude branch; the chip is Claude-only for the same reason. **But `spendReadout` still renders the Codex language** — that is 4.1's projection and it stays provider-general. |
| Nested runs; a script-authoring UI; a run-history page; any standalone Ultra surface | `ui-contract.md` §1: *"Everything renders inside real session-window chrome … No standalone Ultra surface."* SPEC non-goals: *"Nested runs — the injected surface never exposes `ultra` to a script."* |
| The demo gallery's replay controls (Play / Pause / Restart / speed) | **Mockup-only** by the epic's dispatch note and `ui-contract.md` §8. They exist on a virtual clock over fixtures. There is no virtual clock in production and there must not be one. |
| Renaming `SessionView` → `ProjectSessionView`; deleting `handoffDismissed`; de-duplicating `SessionView`'s prop type | Three recorded 3.1-era cleanups in `session-view.tsx`. You are opening that file for a bounded set of expressions; opening it is not a licence to tidy it. **The dead `WorkflowIcon` import is NOT on this list and is not fenced** — §5.6-T19 item 1 sends you to *consume* it as the anchor's and the chip's glyph, which resolves the lint problem as a side effect of building the feature rather than as a tidy-up. **The rename in particular is pinned by `INV-8g`, whose failure message says it is a recorded deliberate deferral and instructs you to update `SESSION_VIEW_REL` rather than delete the test.** |
| `session-runtime-host.tsx`'s `applyLiveEvent` rebuild, and the dock's dropped typed text | Two 3.1 items whose recorded owner is *"whichever story next rebuilds the dock's transcript, most plausibly 4.2"*. **You are not rebuilding the dock's transcript** — you are adding one field to `Runtime` and one line to the head. Say so, and leave both items open with the owner re-stated. |
| **A per-turn cost SPLIT on the anchor, and the chat route's own `messageId`-less ledger row** | **OUT, and this is a ruling on a fifth item `deferred-work.md` assigns to your run anchor by name** (owner: *"the first story that needs a per-turn cost SPLIT on screen, most plausibly 4.2's run anchor"*). The anchor renders **the run's own spend**, from `manifest.spend` — one run, one number, no split — so the asymmetry that item describes never surfaces here: `ultraCostByMessage()` answers *"what did the runs this turn launched cost"*, never *"what did this turn cost"*, and nothing on this surface asks the second question. **Owner unchanged: the first story that puts BOTH figures beside each other in one readout.** Do not add `messageId` to the chat route's `logUsage` call — `INV-5b` pins its three call sites and story 1.1 spent four repair rounds on that row's shape. |
| **Bounding the wake appendix's run LIST** | **OUT, and this is a ruling on a sixth item assigned to you by name** (owner: *"whichever story first renders a bounded wake list — most plausibly 4.2, whose run anchor needs the same list from the same projection"*). Your rail's list is bounded by the `?sessionId=` filter and by the DOM, not by a character budget; `formatUltraWakeAppendix`'s `MAX_OUTCOME_CHARS` is a **prompt** bound in `ultra-wake.ts` — a different projection with a different consumer (the model's context window). Bounding one does not bound the other, and folding a prompt-budget change into a UI story would make this story the owner of what the model reads. **Owner unchanged.** Re-record it with the note that 4.2 rendered a list and deliberately did not bound the appendix's. |
| A DOM/component test harness | There is none in this repo and story 3.1's hard rule 9 forbids introducing one. Every proof here is a pure function, a core suite, a static scan, or the dev server. §6.2. |
| `bunfig.toml`, `KNOWN_VIOLATIONS` | Hard rules 8 and 9. |

---

## 4. Tasks / Subtasks

Leg order matters. **A is the spine and goes first** — every other leg consumes it, and it is the only leg that is fully testable without a browser. **B before C before D/E** (the events before the routes before the surfaces). **F and H are independent** of each other and of D/E. **G is not: G2 consumes A's `summarizeRuns`, and G5's `?run=` param has no consumer until E1 exists — AC7 proof 5's "focus" is rail state, not a DOM call. Build G after A and E, or build G1–G4 early and hold G5 until E1 lands.** **I needs D.** **V is last, always.** Task ids are `A1…`; `D*` in §5.5 means a *design decision*, never a task.

### Leg A — the pure brain (AC1–AC5, AC11)

- [x] **A1.** Write `apps/web/lib/ultra-runs.ts`. Pure, dependency-free, no React, no `@telar/core` runtime, no fetch — the shape of `apps/web/lib/spend-readout.ts` and `apps/web/lib/ultra-wake.ts`. Read both first. Export the wire types (a structural mirror of `UltraManifest` and `UltraEvent`, **type-only imported** from `@telar/core` where they exist) and the projections: `runSnapshot(manifest, events)`, `phaseGroups(events)`, `agentRows(events, agentIndex)`, `narratorLines(events)`, `progressFraction(manifest, events)`, `anchorForm(snapshot)`, `filterRunsBySession(runs, sessionId?)`, `summarizeRuns(runs)`. (§5.5-D3; **§5.6-T16 — write ONE envelope adapter here and use it everywhere**; §5.6-T13 — `runSnapshot` takes `manifest.spend`, never a sum of deltas.)
- [x] **A2.** `spliceRunAnchors(items, runsById: ReadonlyMap<string, RunSnapshot>)` — the transcript splice. **Keyed lookup, not a list**: proof 2's rule is "keyed by `runId`" and AC4 requires two anchors from one pass (§5.5-D8). It must **split** a `conversation:tools` group around the ultra call, not append after it, and must be a total function that returns the input unchanged when there is no ultra call.
- [x] **A3.** The composer's arm-state reducer and the dock summarizer, both pure, both here rather than in a component, for the same reason story 4.1 moved three functions out of `session-view.tsx`: **the client chain's DECISIONS must be testable.** (§5.5-D2 for the arm reducer; AC7 proof 6 for the summarizer's 1-vs-N rule.)
- [x] **A4.** `apps/web/lib/ultra-runs.test.ts` — every projection; the ordinal dedupe across a resume; the phase-grouping rule including a re-emitted phase sequence; the `meta.phases` absent case (AC11); `anchorForm` constant-while-running (AC2); the splice's group-split and its no-op case; the arm reducer; the summarizer for 0/1/3 runs; the narrator's accounting-prefix filter, one prefix per case (§5.6-T6); `filterRunsBySession(runs, undefined)` returning the input unchanged (C1); and AC9's budget-token static scan with its floor of exactly 4 and its two-direction discriminator.

### Leg B — the two additive engine fields (AC3, AC11)

- [x] **B1.** `packages/core/src/ultra/executor.ts` — add `{ type: "agent-start"; ordinal: number; label?: string; model: string; effort?: string }` to the `UltraEvent` union, and `effort?: string` to the existing `agent` variant. Emit `agent-start` **immediately before the first live attempt** of an ordinal (never on the cached-replay path, which returns early). Read the union's own doc comments before you write; they are load-bearing about `settleId` and you must not disturb them. (§5.5-D6.)
- [x] **B2.** **Do not put `effort` into `engineOpts`.** `ultra-executor.test.ts` pins `expect("effort" in seen[0]!).toBe(false)`. Add a test asserting the field reaches the **event** and still not the engine.
- [x] **B3.** `packages/core/src/ultra/storage.ts` — the existing `onEvent` tap already appends every `UltraEvent`; confirm by reading that the new variant flows through with no change, and add nothing if it does. Add `listUltraAgentOrdinals(runId): number[]` beside `readUltraAgentTranscript`, reading the `agents/` directory, tolerant of the directory not existing. (§5.5-D6.)
- [x] **B4. Confirm, do not edit.** `packages/core/src/ultra/index.ts` is a list of `export * from "./…"` lines including `"./storage"`, and `packages/core/src/index.ts` re-exports `./ultra` — so a new `export function` in `storage.ts` reaches `@telar/core` with **no barrel change**. Prove it by importing `listUltraAgentOrdinals` from `@telar/core` (not from the relative path) in `ultra-storage.test.ts`, and record that this leg left `index.ts` untouched.
- [x] **B4a. The one existing assertion `agent-start` breaks, named before you write it.** `packages/core/test/ultra-storage.test.ts`'s describe *"Ultra storage — events.ndjson tails phase/log/agent/state in order"* holds a test whose script is `phase("Phase 1"); await agent("p", {model:"sonnet"}); log("done")` and which asserts `expect(types).toEqual(["phase", "agent", "log", "state"])`. Your change makes that `["phase", "agent-start", "agent", "log", "state"]`, and **the describe title itself becomes false**. Update the array and the title, and carry the old expectation in a comment with the reason it was right (before this story an agent was invisible until it settled) and the reason it is wrong now (§5.5-D6). **Do not "fix" it by making `agent-start` conditional or by weakening `toEqual` to `toContain`** — an ordered sequence assertion is the only thing that proves `agent-start` precedes its own `agent`, which is the whole claim. (This is the ONLY existing assertion the new variant breaks; every other `UltraEvent` reader in the tree either forwards unconditionally or branches on a named type, and there is no zod schema over the union.)
- [x] **B5.** `packages/core/test/ultra-executor.test.ts` and `ultra-storage.test.ts` — the new variant is emitted once per live ordinal and **not** on a cached replay; `effort` rides the event; `listUltraAgentOrdinals` sees an ordinal that has emitted but not settled. (§5.5-D6. **D7's `ultra_status` proof is NOT here — it is F5**, because `ultra_status` is a web-side tool and `packages/core` cannot import `apps/web`.)

### Leg C — the three route additions (AC3, AC4, AC7)

- [x] **C1.** `apps/web/app/api/ultra/route.ts` — `GET` accepts `?sessionId=`, filters `run.sessionId === sessionId`, returns rows carrying a server-rendered `name` (so no client needs `ultraRunLabel`), and is **wrapped** exactly as `wakes/route.ts` is (§5.6-T8). An absent `sessionId` must keep today's behaviour byte-for-byte. **There is no route-test harness in this repo — every `apps/web` spec sits under `lib/` or `components/conversation/`, none under `app/` — and adding one is outside the write set.** So prove it the way §5.5-D3 requires of every other decision: put the filter in `ultra-runs.ts` as `filterRunsBySession(runs, sessionId?)` — **defined-and-equal, never truthy** (§5.5-D5) — and make the route a three-line caller of it. `ultra-runs.test.ts` then asserts `filterRunsBySession(runs, undefined)` returns the input unchanged, in order and length. **The route's own envelope is confirmed once, by hand, in the dev proof (`curl -s localhost:3000/api/ultra | head -c 400`, before and after your change), and recorded as an observation, not as a test.**
- [x] **C2.** `apps/web/app/api/ultra/[id]/agents/route.ts` — `GET` returns `{ agents: [{ ordinal, settled, attempt, lastText }] }` (an **envelope**, not a bare array — §5.6-T16's rule applied to a route you are minting). `ordinal` and `attempt` come from `listUltraAgentOrdinals` + `readUltraAgentTranscript`; **`lastText` is the last `{ type: "text" }` record whose `attempt` equals the maximum `attempt` present** — `UltraAgentEventRecord` is `EngineEvent & { attempt; ts }` and `EngineEvent`'s five variants (`session | text | tool | tool-result | result`) leave `text` as the only prose-bearing one, so a naive "last record" yields a `result` frame with no text at all. **`settled` has no source in either of those two readers**: it is `readUltraEvents(id, 0)`'s events containing an `agent` event for that ordinal — settlement IS the `agent` UltraEvent, which is the entire reason `agent-start` had to be added. Truncate `lastText` with `Array.from(...)`, never `.slice()` (§5.6-T19 item 9). Empty, never 404, for a run with no agents yet. Wrap the handler exactly as `wakes/route.ts` wraps its read (§5.6-T8). (§5.5-D6's "live agent rows" bullet.)
- [x] **C3.** `apps/web/app/api/ultra/[id]/script/route.ts` — `GET` returns `{ script }` from `readUltraScript`, `404` when null. (§5.5-D11.)
- [x] **C4.** Read `apps/web/node_modules/next/dist/docs/` before writing any of these (`apps/web/AGENTS.md` requires it; the path in that file is relative to `apps/web` and does NOT resolve from the repo root) — `apps/web/AGENTS.md` requires it and this is framework code. In particular confirm the static-beside-dynamic segment rule story 4.1 relied on for `wakes/`; your `agents/route.ts` is an **index beside a dynamic child**, which is a different case.

### Leg D — the anchor (AC1, AC2, AC5, AC10)

- [x] **D1.** `apps/web/components/session/ultra-anchor.tsx` — the payload type and the `ItemKind`, **renderer inline** (hard rule 10). Honour the quiet-colour law: neutral outline, hue on the icon only, a neutral spinner for the running state, never a saturated pill. §5.5-D9 rules on why you do **not** import `components/looms/status.tsx`; §5.6-T19's closing paragraph gives the state→tone table. **Use `WorkflowIcon` (§5.6-T19 item 1): it is already imported into `session-view.tsx` and used nowhere in the file — this feature is what it was imported for, and using it also clears the dead-import lint problem §3 forbids you to "tidy".**
- [x] **D2.** `session-view.tsx` — splice the kind into `SESSION_KINDS` beside `agentBucketKind`, and run `spliceRunAnchors` over the items it already builds (§5.5-D1 items 1–3; §5.5-D8 for the recognition and split rules; §5.6-T4 for why it is not an append). **Do not write `item.kind` anywhere in that file** (§5.6-T2 — `INV-8g` fails on it by name).
- [x] **D3.** `apps/web/lib/use-ultra-runs.ts` — the client hook. One `EventSource` per live run; **`es.addEventListener("end", () => es.close())` on every one of them** (§5.6-T7); the session list on the house cadence; type-only `@telar/core` imports with the erasure comment `use-accounts.ts` and `use-ultra-wake.ts` both carry.

### Leg E — the rail (AC3, AC4, AC5)

- [x] **E1.** `apps/web/components/session/ultra-rail.tsx` — the section, the cards, the phase groups, the agent rows, the narrator window, the Script tab. Fixed heights are explicit (`h-*`), never `max-h`, and every variable-width child is `min-w-0` + `truncate`. (§5.5-D10; §5.4-H for what "fixed height" means mechanically; §5.6-T17 for `Shimmer`; §5.6-T15 — never print `manifest.project`; §5.6-T19 items 2, 5, 6, 7, 8, 10, 13 and 14.)
- [x] **E2.** `subagent-rail.tsx` — two optional props on `SubagentRail` **plus one on `EdgeDots`**, and nothing else (§5.5-D10 gives the measured reason the count cannot join `running`). Read the whole file first. **`SubagentRail` has TWO consumers, not one**: `session-view.tsx`'s `rail={…}` expression and `apps/web/lib/demo-gallery/conversation/shell.tsx`'s configuration `conversation-full`, which passes the existing seven props and will never pass yours. §3 fences you out of the gallery, so **both new props must be optional and both must render identically to today when undefined** — and `EdgeDots`, whose three props are all required, takes its fourth **with a default**, never as a fourth required prop. Prove the no-op direction: the gallery's collapsed rail renders the same dot vocabulary it renders today.
- [x] **E3.** `session-view.tsx` — widen the rail's render condition beyond `railAgents.length > 0`, and pass the section through (§5.5-D10's second paragraph; §5.6-T3; §5.5-D1 item 4 — this is one of the nine expressions).
- [x] **E4.** **Do not let a permission event yank the rail away.** `session-view.tsx` forces `setActiveTab("main")` on every `"permission"` event. **The DEFAULT is: change nothing** — §5.5-D1 fences this file to nine expressions and a tenth would be a scope breach. What E4 requires is that you *observe* it in the dev proof and *record* the decision (§5.6-T12): if the Workflows view is separate state from `activeTab` (it should be — §5.5-D3b), the yank does not reach it and you say so; if you find it does, record it in `deferred-work.md` with an owner rather than widening the write set.

### Leg F — the composer chip (AC6)

- [x] **F1.** `session-view.tsx` — the toggle in `PromptInputTools`, Claude branch only, not inside `ComposerSettings`, not persisted (AC6 proof 1 for the placement; §5.6-T11 for the persistence ban; §5.5-D1 item 5). **The chip's glyph is `WorkflowIcon`, not `SparklesIcon` — the latter is already the Claude-config chip's (§5.6-T19 item 1).**
- [x] **F2.** The wire key: `...(opts?.ultra ? { ultra: true } : {})` on the existing body literal, read off the **per-dispatch options** and never off component state — §5.5-D1 item 6 gives the measured reason (the same literal fires story 4.1's hidden wake turn). **The key is `ultra`** (§5.5-D1 item 6; §5.6-T19's naming note — the route destructures `ultra`, not `ultraAnnotated`).
- [x] **F3.** The queue's armed flag — the two-line change of §5.5-D2, in the shape of 4.1's `hidden` precedent.
- [x] **F4.** `ultra-mcp.test.ts` — pin the two substrings of `ULTRA_TOOL_DESCRIPTION` the client now depends on, **copied out of the file, not out of this story** (AC6 proof 5, §6.2).
- [x] **F5.** `apps/web/lib/ultra-mcp.test.ts` — **D7's proof, and it lives here, not in core.** `ultra_status` is a web-side tool (`apps/web/lib/ultra-mcp.ts`'s `tool("ultra_status", …)` handler, whose rollup loop keys on `e.type === "agent"` / `"phase"` / `"log"`). Extend the existing `describe("ultra_status — state/journal-summary plumbing")` with one test: the same event stream fed twice, once with `agent-start` events interleaved and once without, produces **identical** tool output. `packages/core` cannot import `apps/web`, so no core suite can make this claim.

### Leg G — the dock signal (AC7)

- [x] **G1.** `dock-provider.tsx` — one field on `Runtime`. `setRuntime` is a **shallow merge over a fixed base**, not an accumulator — passing an array REPLACES it. Read `setRuntime`'s own body and the two default-object literals beside it before you write, and note that `Runtime.cost` is already declared, defaulted twice, written once and read nowhere: you are adding the first spend the dock has ever rendered.
- [x] **G2.** `apps/web/components/common/ultra-dock-signal.tsx` — the app-wide poller. Read `loom-notifications.tsx` end to end first and mirror its shape, including its "zero background work when there is nothing to watch" property. (§5.5-D13's first two paragraphs give the two facts that kill the obvious design.)
- [x] **G3.** `app/layout.tsx` — one element, **inside `<DockProvider>`** (it calls `useDock()`; `LoomNotifications` sits outside because it does not). §5.5-D13.
- [x] **G4.** `dock.tsx` — the head's `name · state · spend` and the tap's `?run=` param (§5.5-D13; AC7 proof 4 — there is no spend anywhere in the dock today; §5.6-T15 — never print `manifest.project`).
- [x] **G5.** `session-view.tsx` — widen the auto-dock guard, and read the `?run=` param into `openRunId` (§5.5-D1 items 8, 9 and 10 — the state lives here, not in the rail). **Two viable shapes; pick one deliberately and say which.** (a) `useSearchParams()` in the client component — but this is Next 16 canary and `useSearchParams` has historically required a Suspense boundary under a statically-rendered parent, so **read `node_modules/next/dist/docs/` before you write it** (`apps/web/AGENTS.md` requires this for framework code, and this is framework code). (b) Thread it as a prop: `apps/web/app/projects/[name]/sessions/[id]/page.tsx` is an async Server Component that already awaits `searchParams` and types it `{ role?: string }` — widen that type by one optional key and pass it down. Because the child is keyed `` `${name}:${id}` `` it does **not** remount on a query change, so the prop arrives as an ordinary re-render, which is the behaviour you want. **(b) is one line in a file the story has not otherwise declared** — if you take it, add that page to your write set and disclose it as a sixth widening.

### Leg H — the authoring reference (AC8)

- [x] **H1.** `apps/web/lib/ultra-authoring.ts` — the reference. Cover the four CAP-3 subjects **plus the one the dispatch note adds, and nothing else**. `epics.md` § Story 4.2 dispatch notes, verbatim: *"The authoring reference should steer scripts away from standing up servers or long-lived processes via Bash: nothing supervises an Ultra child's processes, and service work belongs to sessions and looms."* That is a **fifth required section**, not a nice-to-have — it is the only place in the planning artifacts where a script-authoring hazard is named, and `ULTRA_TOOL_DESCRIPTION` does not carry it today (its "Banned inside the script body" paragraph bans `require`/`import`/`process`/`Date`/`Math.random`, never a long-running Bash child). Read `ULTRA_TOOL_DESCRIPTION` first: this is the fuller version of a text that already exists, and the two must not contradict each other (§5.5-D12's ruling on what the description keeps and what it drops).
- [x] **H2.** `session-prompts.ts` — compose it into the three ultra-bearing appendices, **static**, no `safeLiveContext`, never into `escalationAppendix` (§5.5-D12's "Gating" and "Then face this squarely" paragraphs — the second names the assertions your change breaks).
- [x] **H3.** `ultra-authoring.test.ts` — the **five** subjects (H1's four plus the dispatch note's), and the worked example fed through `compileScript` (§5.5-D12, §6.2).
- [x] **H4.** `session-prompts.test.ts` — present on three profiles, absent on escalation, **and absent on a CODEX project session** — §5.5-D12 gates on `ctx.provider`, and that is the assertion that catches a gate written as "always on" (§5.5-D12, §6.2).
- [x] **H5.** The Script tab's link-out renders the same string. One source.

### Leg I — the executable contract (AC10)

- [x] **I1.** `invariants.test.ts` — widen INV-8b2's scan set by one file, with the reason in place, a floor that counts both kind names, and a **two-direction discriminator** (§5.4-F).
- [x] **I2.** Append **INV-10** only (§5.5-D14): the anchor kind's id is exactly `ultra:run-anchor`; it is registered in the adapter's registry and **not** in the gallery's; the shell's directory still contains no ultra file; and `KNOWN_VIOLATIONS` did not grow.
- [x] **I3.** Re-run and record by name, **and this list must match §6.3's item 3 exactly**: `INV-4` (client bundle — you add four `"use client"` files), `INV-5b` (§7.4 — `logUsage`'s three call sites; you add none), `INV-6a` (§7.4 — `SessionProfile`'s field set; you add no field), `INV-7`, `INV-8a`, `INV-8b`, **`INV-8b2` (the one you edited)**, `INV-8c` (contexts — you add **no** provider; confirm), `INV-8f`, `INV-8g` (the `MOVED_OUT_OF_ADAPTER` string list), `INV-8i`, `INV-9`, plus INV-10's own arms. If any fires, read §5.6-T2 before you edit a pin.

### Leg V — the gate and the record

- [x] **V1.** The gate, and it is **not symmetric between the workspaces** — measured at `e093a98`, do not assume: `bun test` in both; `bunx tsc --noEmit` in both; and `bun run lint` in **`apps/web` only**. `packages/core/package.json` has **no `scripts` key**, so `bun run lint` there returns `error: Script not found "lint"`; the repo root has none either, and `eslint.config.mjs` lives under `apps/web` alone. **Do not author an eslint config for `packages/core` — record the absence.** `apps/web`'s lint baseline is **already red**, and three of your write-set files carry pre-existing problems (`session-view.tsx`, including the `'WorkflowIcon' is defined but never used` warning §5.6-T19 item 1 sends you to consume; `dock.tsx`; `dock-provider.tsx`). **Re-measure the baseline before you touch anything, record your own figure, and report only problems your diff ADDED.** Fixing a pre-existing one is §3's declined-cleanup list, not a gate.
- [x] **V2.** `packages/core/test/track-d-prove-run.test.ts` — the prove-run (§6.4), run as `TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-d prove-run"`. **The `packages/core` path argument is load-bearing, not decoration** — read Track A's header for the measured reason before you drop it.
- [x] **V3.** The dev-server proof, in full, as specified in §2.
- [x] **V4.** `deferred-work.md` — everything you found and did not cross, **plus the SIX explicit rulings §3 requires on items already assigned to you** (re-derive the list; do not trust the number).
- [x] **V5.** §9, §10, §11 of this file. Every claim re-derived from the tree at the moment you write it (hard rule at the top of §0).

---
## 5. Dev Notes

### 5.1 The architecture rules that bind this story

| Rule | What it binds here |
| --- | --- |
| **AD-12** — the Conversation shell contract is frozen | Four slots, configured by props, never inheritance. The shell owns scrolling, auto-follow and streaming; it owns **no data fetching and no session semantics**. A registered kind's renderer is a **pure function of `(item payload, shell-provided view state)`** and reads nothing from ambient context. `ConversationProps` is nine names and INV-8i pins it: **there is no tenth slot and you are not getting one.** Everything the anchor needs arrives in its payload. |
| **AD-13** — item kinds are module-namespaced | `ultra:run-anchor`. `MODULE_NAMESPACES` already contains `"ultra"`, so no vocabulary change is needed — which also means an id typo will register cleanly and render a tombstone for a kind you can see in `ids()`. `createItemKindRegistry` throws on a malformed or colliding id at construction; read its five error messages before you name anything. |
| **AD-3 / NFR-X-3** — core is server-side only | Four new `"use client"` files. Every `@telar/core` import in them is `import type`, with the erasure comment `use-accounts.ts` and `use-ultra-wake.ts` both carry. `INV-4` walks a BFS from every client root and fails **by name** on a value edge. |
| **AD-8** — cross-tree references are weak | The anchor's payload carries the run's id **plus enough denormalized label to render without a lookup** — that is why `name` is rendered server-side into the list route's rows. A run whose manifest has vanished renders as a tombstone, never a throw. The shell's own unregistered-kind tombstone is the same rule one level up. |
| **AD-15 / NFR-X-12** — restart doctrine | No in-process work survives a restart; a stale `running` reconciles to `stopped` **on read** and offers Resume. Your Resume affordance is the UI half of that sentence. It also means a run can go terminal with **no event and no publish** (§5.6-T14) — so the UI reconciles from the **manifest**, never from having seen an event. |
| **AD-18 / AD-20** — one append-only spend ledger | `manifest.spend` is a **fold over `usage.ndjson`**, recomputed on every save. It is not an accumulator and it is **not monotonic**. Take it as the truth; never sum `agent.costUsd` deltas yourself — a resume replays them (§5.6-T13). |
| **AD-19** — load-bearing invariants are executable | AC10 exists because INV-8b2 cannot currently see a kind declared outside two files, and the frozen purity contract would otherwise be aspirational for the one kind this story adds. |
| **AD-21** — published event names are contract | `INV-9a` pins ultra's catalogue as the exact set `["ultra:run-completed"]`. §3 rules that this story adds **none**. Do not quietly add one for the dock. |
| **NFR-X-15** — client state and streaming | No global client-state library. `useState`/`useEffect` + `fetch`; refetch on mount, on `window "telar:refresh"`, and on a poll interval **while something runs**. `GET` tails use native `EventSource`. The dock's React context is the sanctioned "global-ish" mechanism and is already classified — **adding a second provider means adding it to `CLASSIFIED_CONTEXTS`/`CLASSIFIED_HOOKS` or INV-8c fails by name.** This story adds none. |
| **NFR-UW-11** — the anchor is fixed-height while running | The rail's narrator window is fixed-height scrolling with no layout shift, ever. Mechanically caused: `StickToBottom` is configured `resize="smooth"`, so anything that grows mid-stream animates the whole transcript. |
| **NFR-UW-7 / UX-DR10 / UX-DR11 / NFR-LR-24** — no budgets, quiet colour, tone law | No meters. Hue on the icon only; chips stay neutral outlines; active work gets a **neutral spinner**, never a saturated hue. No suggestion text, no doctrine captions — state and data only. The gallery violates the colour half throughout (§5.6-T1). |

### 5.2 Files to touch — what each one is today

| File | What it is today, in one sentence |
| --- | --- |
| `apps/web/components/session/session-view.tsx` | 2985 lines. Still exported as **`SessionView`**, not `ProjectSessionView` — the rename is a recorded deliberate deferral whose failure message inside `INV-8g` tells you to update `SESSION_VIEW_REL` rather than delete the test. It owns `messages`, both event streams, `applyServerEvent`, the whole turn state machine, `SESSION_KINDS`, `agentBucketKind`, the composer, the queue, and story 4.1's wake trigger. It no longer owns a render loop. |
| `apps/web/components/session/subagent-rail.tsx` | 434 lines. `SubagentRail` takes seven props, renders a pinned Main anchor, a live section and a Done history, and collapses to an icon edge with `EdgeDots`. No children, no slot, no section list. **It has two consumers** — `session-view.tsx` and the demo gallery's `conversation-full` configuration, which §3 fences you out of, so every prop you add must be optional and inert when absent. |
| `apps/web/components/conversation/**` | The frozen shell. `conversation.tsx` (the four slots + the opaque view state + the tombstone), `registry.ts` (`createItemKindRegistry`, `MODULE_NAMESPACES`, `ItemViewState`, `ItemRenderer`), `items.ts` (`TranscriptItem`, `groupParts`, `toTranscriptItems`, `isTrailingItem`), `kinds.tsx` (the six built-ins), `marker.tsx`, `approval-card.tsx`. **Read; do not write.** |
| `apps/web/components/dock/dock-provider.tsx` | 370 lines. The docked set + order in `localStorage`; a `Runtime` record per session written by the host. `cost` is declared, defaulted twice, written once and **read nowhere**. |
| `apps/web/components/dock/dock.tsx` | 426 lines. Returns `null` when `entries.length === 0`. The head's content is a single character; the only state word lives in `HeadTooltip`. |
| `apps/web/components/dock/session-runtime-host.tsx` | 454 lines. Mounts once per docked entry; owns the fetch + SSE tail that makes the dock live. Its `applyLiveEvent` is the seventh transcript reducer and is **not yours** (§3). |
| `apps/web/app/api/ultra/**` | Seven route files. Three envelopes for the same object: SSE sends the bare `UltraManifest`; `GET /api/ultra/[id]` sends `{run}`; `GET /api/ultra` sends `{runs}`. Only `wakes/route.ts` wraps its read. |
| `packages/core/src/ultra/executor.ts` | 531 lines. The `UltraEvent` union (four variants, all of whose doc comments are load-bearing about `settleId`), the run-local cap of 3, the 1000-agent backstop, the K=2 validate-and-retry, and the one-way `cacheValid` latch. |
| `packages/core/src/ultra/storage.ts` | 730 lines. The manifest, the event append, the per-agent transcript append, the ledger tap, the self-healing read, `listUltraRuns`, `readUltraScript`, `stopUltraRun`, `resumeUltraRun`, and story 4.1's terminal publish. |
| `apps/web/lib/session-prompts.ts` | The four appendix composers, `safeLiveContext`, `ultraNote`, and story 4.1's `ultraWakeAppendix`. Its tests assert composed appendices by **exact equality**. |
| `apps/web/lib/spend-readout.ts` | Story 4.1's pure USD/tokens projection. Its header already anticipates this story reaching for it. |
| `apps/web/lib/demo-gallery/ultra/**` | 2055 lines across three files. The design source of truth for **layout and density** and for nothing else (§5.6-T1). |

### 5.3 Read these before you write

1. **`_bmad-output/specs/spec-ultra-workflows/ui-contract.md`, all nine numbered clauses.** It is one page and it is the contract. Read it beside the gallery, not instead of it.
2. **`apps/web/lib/ultra-mcp.ts`'s file header, lines 1–24.** It tells you the anchor's seam in advance (*"launching a run already surfaces as an ordinary `mcp__ultra__ultra` tool-call/tool-result pair on the session's existing SSE stream … a future UI reads `output.runId` off that same event"*), tells you the chip's server half already exists, and tells you the authoring reference was cut from U5 and is yours. Then read `ULTRA_TOOL_DESCRIPTION` itself — you are about to become its second source of truth unless you follow §5.5-D12.
3. **`apps/web/components/conversation/registry.ts`, whole file.** The renderer contract, the five construction-time errors, and the two paragraphs explaining why a renderer is a plain function and not a `ComponentType` — including the architecture review's finding A3, which is the exact failure your anchor would reproduce if it read run state from a context.
4. **`apps/web/components/conversation/conversation.tsx`, whole file (136 lines).** In particular `renderItem`, the `scope()`-prefixed (`item.key`-scoped) `ItemViewState`, and the `trailing` prop's doc — the last of which explains why appending an anchor after the streaming turn steals its liveness.
5. **`apps/web/components/session/session-view.tsx`'s `agentBucketKind` and `SESSION_KINDS`.** Story 3.1 recorded this as *"4.2's template"*. Copy the shape — a payload type, an `ItemKind` with an **inline** renderer, spliced into a module-scope registry — and copy the comment explaining why the registry is a prop.
6. **`packages/core/src/ultra/executor.ts`'s `UltraEvent` union and its `settleId` doc.** You are adding a variant to this union. The doc beside `settleId` is the record of a money bug repaired three times; the maxim it produced — *"a key must name a billable event, not a slot"* — is why you must not derive anything from an index.
7. **`apps/web/app/api/ultra/wakes/route.ts`'s guard block.** It is the only route in the tree that wraps `listUltraRuns`, and its comment reproduces the two cases that make an unwrapped read 500 the whole app. Every route you add copies that guard.
8. **`apps/web/components/common/loom-notifications.tsx`, end to end — it is short.** It is the exact precedent for the dock signal: mounted once in the root layout, alive on every page, type-only core imports, `POLL_MS`, a `useRef<Map>` of prior state, `return null`, and **zero background work when disarmed**.
9. **`apps/web/lib/ultra-wake.ts` and `apps/web/lib/escalation-kickoff.ts`.** Both have **zero import statements**. That is the shape of `ultra-runs.ts` and `ultra-authoring.ts`, and it is the only shape that lets the server composer and the client rail reach the same text without breaking INV-4.
10. **`packages/core/test/invariants.test.ts`'s INV-8 header block and `kindRendererSlices`.** The residual paragraph is hard rule 10, in the repo's own words, and it ends with an instruction you are following.
11. **`_bmad-output/implementation-artifacts/deferred-work.md`** — the 3-1 section (the two dock items whose owner is named as you) and the whole 4-1 section (**six** items name you — re-derive with `awk 'NR>=129' deferred-work.md | grep -n '4\.2'` — and §3 rules on all six).
12. **`_bmad-output/implementation-artifacts/orchestrator-run-log.md`'s tail** — the `~/.telar-dev` leftovers, including the deliberately malformed manifest that poisons every read of that root. Your dev proof runs against it.

### 5.4 Patterns and conventions — copy these exactly

**A. The pure seam.** A module with no imports (or type-only imports), no React, no fetch, exporting the decisions. `escalation-kickoff.ts` → `ultra-wake.ts` → `spend-readout.ts` is a three-story lineage; `ultra-runs.ts` and `ultra-authoring.ts` join it. The reason is stated in 4.1's own record: **the client chain's DECISIONS must be testable in a repo with no DOM harness.** Anything you find yourself wanting to assert about the UI is a signal that the decision belongs in the seam.

**B. The client hook.** `"use client"`, a type-only `@telar/core` import with an explicit comment that the type import is erased at build time, `fetch` against the app's own API, `useState`/`useEffect`/`useCallback`, a best-effort `catch`, and **self-limiting polling** — stop when nothing runs. **`use-ultra-wake.ts` and `components/common/loom-notifications.tsx` are the templates, and `use-accounts.ts` is NOT** — measured at `e093a98`, `bunx eslint lib/use-accounts.ts` reports `react-hooks/set-state-in-effect` on its bare `useEffect(() => { void reload(); }, [reload])`, while the other two lint clean. Read it for its brevity if you like; copy its effect shape and you ship a new lint error in a new file that V1 makes you report — in a repo where that same rule already fires in `dock-provider.tsx` and `dock.tsx`, both of which you are editing. **Standalone client hooks live at `apps/web/lib/use-*.ts` — three do (`use-accounts.ts`, `use-anchored-overlay.ts`, `use-ultra-wake.ts`) and one does not: `apps/web/components/looms/spec-bundle.tsx`'s `useSpecBundle` is a fetch hook colocated with the component that uses it. That is the minority shape and you are not joining it** — `use-ultra-runs.ts` has two consumers (the anchor's payload and the rail), so colocating it would mean picking one. (`useDock`/`useDockOptional` and `prompt-input.tsx`'s four are context consumers colocated with their providers — a third shape, and not yours: this story adds no provider, §5.6-T2's INV-8c.)

**C. Native `EventSource` for a GET tail, and always close it on `end`.** `session-view.tsx` does this twice and is the template. The frame names on `/api/ultra/[id]/events` are `run` (a bare `UltraManifest`), `ev` (one `UltraEvent`) and `end`. There is **no heartbeat** and the route can be silent for an unbounded time on connect — do not treat silence as failure.

**D. Diagnosis lives in the asserted value, not in an `expect` message.** No suite in this repo passes a message argument to `expect`. Violation objects and thrown errors carry, in order: the AD id, the rule in one clause, the consequence if it is false, and the actionable next step.

**E. Negative-compile claims.** In `packages/core/test`, spawn a real `tsc` over a generated fixture — copy `session-profile.test.ts` / `event-bus.test.ts`'s `typecheck()` helper. In `apps/web`, an inline `@ts-expect-error` **is** checked by `bunx tsc --noEmit`, but it must sit on a **typed data object**, never above a call. `apps/web/lib/session-prompts.test.ts` carries the canonical shape: the erroring construct is confined to a `const x: Parameters<typeof f>[0] = { … }` literal and the actual call is made separately.

**F. Anti-vacuity, on every scan.** Assert a floor on what the scan found **before** asserting anything about violations, and carry a permanent discriminator that feeds a runtime-assembled fixture through the *same* function the real check uses, **in both directions**. INV-7d, INV-8d and INV-9d are the models. This binds AC9's budget-token scan and AC10's widened INV-8b2 equally.

**G. Comment density.** Non-obvious modules carry WHY headers. Four of your new modules are non-obvious (a projection layer whose whole job is refusing to invent data; a kind whose renderer's *inline-ness* is load-bearing; an app-wide poller; a reference text that is now the single source for guidance that used to live in a tool description). Match the surrounding style — and per §0's rule, every sentence must be true of the tree when you write it.

**H. Fixed height means an explicit height.** `h-28`, not `max-h-28`; `overflow-y-auto`, not `overflow-auto` on a flex child without `min-h-0`. Every variable-width flex child gets `min-w-0` + `truncate`. This is `ui-contract.md`'s own house rule and it is what makes AC2 and AC3 true rather than aspirational.

### 5.5 Design decisions already made for you

**D1 — The ten expressions of `session-view.tsx`.** Hard rule 2 rules that this file is edited. This is the complete list; anything beyond it is a scope breach.

1. `SESSION_KINDS` gains `ultraRunAnchorKind` (one array element).
2. The **turn's own** item list passes through `spliceRunAnchors(...)` — one wrapping call, and **not** around `transcriptItems`. **Measured at `e093a98`, and getting this wrong makes the whole feature a silent no-op:** `transcriptItems` — the value handed to `<Conversation items={…}>` — is exclusively `conversation:turn` items (or, on a subagent tab, one `session:agent-bucket`). `conversation:tools` exists only **one level down**, inside `TurnPayload.items`, produced by `toTranscriptItems(groupParts(m.id, mainParts), …)`. A wrapping call around `transcriptItems` finds zero groups and returns the input unchanged — and A2's own "total function" rule makes that failure **green**. The edit goes inside the existing `messages.map((m) => …)`, wrapping the `items:` expression.
   Two consequences to write down rather than discover: the anchor is a **nested** item rendered through `view.render(child, …)` by the turn kind, so it lays out in the assistant bubble's reading column (which is what `max-w-[92%]` is measured against, §5.6-T19); and `isTrailingItem` now sees it, so replacing the **last** tools group of a streaming turn hands the anchor `view.live === true`. `agentBucketItem`'s own nested list is deliberately **not** spliced — ultra is called from the main thread; if you find an `mcp__ultra__ultra` part inside a bucket, record it, do not handle it.
3. `useUltraRuns(sessionId)` is called and its result feeds 2, 4 and the composer (one hook call + its destructuring).
4. The `rail={…}` expression: the condition widens beyond `railAgents.length > 0`, and `workflows`/`workflowCount` are passed.
5. The composer's `PromptInputTools` gains the Ultra chip (one element + one `useState`).
6. `send`'s options type widens from `{ hidden?: boolean }` to `{ hidden?: boolean; ultra?: boolean }`, and the `POST /api/chat` body literal gains `...(opts?.ultra ? { ultra: true } : {})` — **read off the per-dispatch options, NEVER off the `ultraArmed` component state.** That body literal is shared by every turn this file fires, including story 4.1's **hidden wake turn** and the message-queue drain. Reading component state there would annotate the wake turn — a turn with no user message at all — with `ULTRA_ANNOTATION_NOTE`'s claim that *"the user's message below is Ultra-annotated"*, and would annotate a queued message with whatever the chip happened to say when the queue drained rather than when the user pressed Enter. **`handleSubmit` is the ONE site that reads `ultraArmed`**: the immediate path passes `ultraArmed ? { ultra: true } : undefined`, the busy path stores the flag on the queued item, and both disarm exactly once.
7. `messageQueue`'s item type gains `ultra?: boolean` and the drain threads it (§5.5-D2). **The injection drain is UNTOUCHED** — its dispatch stays `next.hidden ? { hidden: true } : undefined`, so a wake can never carry the key. Assert it with a pure test: the wake's dispatch options contain no `ultra` even when the arm reducer says armed.
8. The auto-dock unmount guard widens from `!s.busy` to "`!s.busy` **and** no live run".
9. The `run` param is read and cleared — one `useEffect`, **plus the `next/navigation` import this file does not have today** (it reaches for `window.history.replaceState` instead) and its hook calls. The effect depends on the param, **never `[]`** — the page keys `<SessionView key={`${name}:${id}`}>`, so a query-only change does not remount.
10. **`openRunId` — the selected-run state, and it lives HERE, not in the rail.** `useState<string | null>(null)` in `session-view.tsx`, passed down as `openRunId` + `onOpenRun` on the rail element inside the `workflows` slot. It cannot live inside `ultra-rail.tsx`: item 9's effect is the writer, §3 forbids a new context, and `INV-8c` fails **by name** on a provider (§5.6-T2). It must **not** ride `activeTab` either — `activeTab` is the rail's `activeId` **and** the transcript's bucket selector, so a runId in it silently changes what the transcript renders. This is also what makes §5.6-T12 answerable: the permission handler's `setActiveTab("main")` cannot reach `openRunId`.

**Nothing else. In particular: do not write the string `item.kind` in this file** — `INV-8g`'s `MOVED_OUT_OF_ADAPTER` list fails on it by name, along with twelve other strings including `function ToolStepGroup`, `ConversationContent`, `setGroupOverrides` and `setThinkingOpen`. A hand-written kind dispatch in the adapter fails the gate, which is exactly what that list is for.

**D2 — The queue's armed flag, and why it is the same two-line change story 4.1 made.** Measured: `messageQueue` is `useState<{ id: string; text: string }[]>` and the drain dispatches with no options. Story 4.1 hit the identical wall with `hidden` and its fix is the precedent: widen the item type by one optional field, thread it through the one dispatch expression, leave the **gate** untouched. Arming the chip and pressing Enter while the agent is busy must annotate **that** message when it eventually sends, not the next one the user types, and not none of them. Assert it with a pure test over the reducer, because the queue itself has no test.

**D3 — Every decision lives in `apps/web/lib/ultra-runs.ts`, and the components are thin.** The rule is not aesthetic. There is **no DOM harness in this repo** and story 3.1's hard rule 9 forbids introducing one, so a decision that lives inside JSX is a decision that ships unproven. Story 4.1's review round moved three functions out of `session-view.tsx` *for this reason* and gained sixteen tests by doing so. Everything that is a **choice** — which form the anchor takes, which agent rows exist, which phase an agent belongs to, which log lines are narration, whether a denominator exists, what the dock summary says, whether the chip is armed for this send — is a pure function here with a test. What is left in the components is layout.

**D3a — The shapes, pinned, because five files build against them.** These are the exported types of `apps/web/lib/ultra-runs.ts`. Structural mirrors of `UltraManifest`/`UltraEvent`, **type-only** imported from `@telar/core` where they exist (§5.4-B). Without this section the dev agent invents every one of them and every downstream file depends on the guess.

```ts
export type UltraRunState = "running" | "done" | "failed" | "stopped"; // NEVER "completed" (§5.6-T1 item 1)

export type AgentRow = {
  ordinal: number; label?: string; model: string; effort?: string;
  /** absent while live; set from the `agent` event's own `ok` once it settles */
  ok?: boolean;
  costUsd?: number;                 // AC11 proof 6: cost only. There is NO tokens field, deliberately.
  /** highest-`attempt` text from GET /api/ultra/[id]/agents; "" while nothing has streamed */
  snippet: string;
  settled: boolean;
};
export type PhaseGroup = { title: string; agents: AgentRow[] };

export type RunSnapshot = {
  runId: string;
  name: string;               // pre-rendered by the list route — NOT ultraRunLabel(), a core VALUE export (AC1 proof 3)
  state: UltraRunState;
  spendUsd: number;           // manifest.spend, verbatim (§5.6-T13)
  error?: string;
  startedAt: number; updatedAt: number;
  agentsDone: number;         // deduped ordinal count of settled agents
  agentsTotal: undefined;     // AC11 proof 3 — the TYPE ITSELF refuses the denominator
  phases: PhaseGroup[];
  narrator: string[];
  progress?: { seen: number; declared: number }; // undefined ⇒ NO SLIVER (AC11 proof 4)
  /** true until the first `run` frame or list row lands — D8's pending form */
  pending: boolean;
};

export type UltraAnchorPayload = {
  run: RunSnapshot;
  /** for spendReadout(); the adapter supplies it, since the renderer may read nothing else */
  provider: SpendProvider;
  onFocus: () => void;        // ui-contract §2: "Clicking it focuses that run in the rail."
  onStop: () => void;
  onResume: () => void;
  /** disables both affordances between the click and the next snapshot (AC5 proof 3) */
  busy: boolean;
};

export type ArmState = { armed: boolean };
export type DockRunSummary = { text: string; spend: SpendReadout; focusRunId?: string } | null;
```

and the projections:

```ts
export function runSnapshot(manifest: UltraManifestLike | null, events: readonly UltraEventLike[],
                            agentIndex?: readonly AgentIndexRow[], runId?: string): RunSnapshot;
export function phaseGroups(events: readonly UltraEventLike[], rows: readonly AgentRow[]): PhaseGroup[];
export function agentRows(events: readonly UltraEventLike[], agentIndex: readonly AgentIndexRow[]): AgentRow[];
export function narratorLines(events: readonly UltraEventLike[]): string[];
export function progressFraction(manifest: UltraManifestLike | null,
                                 events: readonly UltraEventLike[]): { seen: number; declared: number } | undefined;
export function anchorForm(run: RunSnapshot): "running" | "terminal";
export function filterRunsBySession(runs: readonly RunSnapshot[], sessionId?: string): readonly RunSnapshot[];
export function summarizeRuns(runs: readonly RunSnapshot[], provider: SpendProvider): DockRunSummary;
export function spliceRunAnchors(items: readonly TranscriptItem[],
                                 runs: ReadonlyMap<string, UltraAnchorPayload>): TranscriptItem[];
export function armReducer(state: ArmState, action: "arm" | "disarm" | "sent"): ArmState;
```

**`anchorForm` takes the `RunSnapshot`, not the payload** — the whole point of AC2's proof is that the form is a function of `state` alone, and the payload carries closures that would make that claim untestable. **`spliceRunAnchors`' second argument is a `ReadonlyMap` keyed by `runId`** — the same object the hook holds (AC4 proof 2), passed straight through: no re-keying, no `Record`.

**A callback in a payload does not violate AD-12.** The renderer still reads nothing ambient; `session-view.tsx` already hands callbacks down exactly this way twice (`agentBucketItem(bucket, onBack)` and `toTranscriptItems(…, { onRespond, onSelectAgent })`), and `items.ts`'s `ItemPayloadHooks` doc states the rule: *"Owner-supplied behaviour reaches a renderer THROUGH THE PAYLOAD, never through ambient context."*

**D3b — `use-ultra-runs.ts`'s return type, and the null-`sessionId` window.** `{ runs: ReadonlyMap<string, RunSnapshot>; live: number; reload: () => Promise<void> }`. `sessionId` is `string | null` in `session-view.tsx` and is **null until the first turn's `session` event** — the hook short-circuits to an empty map on null, exactly as `use-ultra-wake.ts`'s reload does. It does not throw and it does not fetch. That window is real: the very first turn of a brand-new session can launch a run before `sessionId` exists, so the anchor's pending form (D8) is what covers it until the first list poll answers.

**D4 — The anchor is fed by one `EventSource` per LIVE run, and the rail's list by a poll.** They answer different questions. The anchor needs per-tick fidelity for a run the user is looking at, and `/api/ultra/[id]/events` is the channel `ui-contract.md` names (story 4.1's D9 explicitly reserved it for you). The rail's *list* needs "which runs does this session have", which is one cheap question on the house cadence. **Open no stream for a terminal run** — reconcile it from the list — and **close every stream on its `end` frame** (§5.6-T7).

**D5 — `GET /api/ultra?sessionId=` filters on the server and renders the name there too.** Three reasons, in order of weight: `run.sessionId` is optional (a run launched outside a chat has none) so the filter needs a defined-and-equal test, not a truthiness test; rendering `name` server-side through `ultraRunLabel` keeps the client from needing a `@telar/core` value import; and a session-scoped payload is what makes the dock's poll cheap enough to run on every page. **An absent `sessionId` must keep today's behaviour byte-for-byte** — that route has no callers today but it is a published shape, and a test proves it.

**D5a — The run label is duplicated into `ultra-runs.ts`, deliberately, and it is four lines.** `ultraRunLabel` lives in `packages/core/src/ultra/events.ts` and is a **runtime value**. `ultra-runs.ts` is reached from `use-ultra-runs.ts`, a `"use client"` root, so a value import of it is an `INV-4c` violation reported **by name**. And the anchor cannot simply take the server-rendered `name` from the list route either: its per-tick channel is the SSE tail, whose `run`/`end` frames are the **bare `UltraManifest`** — which carries `meta` and no `name` at all. So `ultra-runs.ts` carries its own copy of the rule: *read `meta.name` when it is a non-empty string, else fall back to the `runId`.* Four lines, with a comment naming core's original and stating why it is duplicated rather than imported (the client-bundle rule), and a test asserting both paths agree on a `meta` with a name, a `meta` without one, and a `meta` whose `name` is not a string. **This is the second copy of one rule and it is the correct trade** — the alternative is either a value edge INV-4 forbids or an anchor with no label until the first list poll answers.

**D6 — The five data gaps, ruled on one at a time. This is the story's most consequential section.**

The frozen contract names five things the engine does not produce. Hard rule 3 forbids inventing any of them. Here is the ruling for each, with what it costs.

- **`effort` — SOURCED, by one optional field.** `UltraAgentOpts` accepts `effort`, the tool description advertises it as *"display only"*, and it is then **dropped on the floor**: `packages/core/test/ultra-executor.test.ts` asserts `expect("effort" in seen[0]!).toBe(false)` — it deliberately never reaches the engine — and no journal record or event carries it either. (`surface.ts`'s comment calling `effort`/`phase` *"journaled display metadata"* is **stale**; verify that yourself rather than trusting this sentence.) The fix is `effort?: string` on the `agent` and `agent-start` variants. **It must still not reach `engineOpts`.** Re-run that pin by name and record its verdict.
- **live agent rows — SOURCED, by one new variant.** An agent emits **nothing** on `events.ndjson` until it settles, so a running agent is invisible; the gallery's six-state `AgentState` is fabricated. Add `{ type: "agent-start"; ordinal; label?; model; effort? }`, emitted immediately before the first **live** attempt of an ordinal and **never on the cached-replay path** (which returns early — see the `cached` branch). The snippet then comes from `GET /api/ultra/[id]/agents`, whose `lastText` is taken **from the highest `attempt`**: a retried ordinal's attempt-1 text is discarded work, and showing it is showing the wrong thing.
- **agents `total` — NOT SOURCED, and NOT INVENTED.** A script may spawn any number of agents, in a loop, conditionally, forever until a budget clause stops it. **Nothing knows the total, and nothing can.** `ultra_status`'s `total: agentsDone + agentsDead` is a count of *settled* agents, so `done/total` through that lens is always 1.0 — a denominator that is always equal to its numerator is worse than no denominator. **The anchor renders `N done` and no denominator while running.** The projection returns `total: undefined` and a test asserts it.
- **the progress sliver — SOURCED FROM PHASES, NEVER FROM AGENTS.** `ULTRA_TOOL_DESCRIPTION` teaches `export const meta = { name, description, phases }`, and `{ type: "phase", title }` events say which one the run is in. So: numerator = distinct `phase` titles seen, denominator = `meta.phases.length`. **`ScriptMeta` is `Record<string, unknown>` and nothing validates `phases`** — `compileScript` checks only that `meta` is a pure object literal — so read it **only** when it is an array of strings, exactly as story 4.1's `ultraRunLabel` reads `meta.name` only when it is a non-empty string. **When it is absent, there is no sliver.** Not an indeterminate bar, not a pulse, not a spinner pretending to be progress. Nothing.

- **per-agent `tokens` — NOT SOURCED, and NOT INVENTED.** The fifth, and the one most likely to be faked because the gallery fakes it convincingly. AC11 proof 6 rules on it: **there are no token counts anywhere on the ultra path**, so the agent row renders cost only.

**Say all five rulings again in your Completion Notes.** A later reader looking at an anchor with no denominator must be able to find out in one grep that it is a decision and not an oversight.

**D6a — The spend call, spelled out, because the two halves do not fit.** `UltraManifest.spend` is a bare `number` (USD); `spendReadout(provider, { usd, tokens })` wants a pair. **There is no tokens figure anywhere on the ultra path** and no route that would produce one (AC11 proof 6). So the call is **always** `spendReadout(provider, { usd: run.spendUsd, tokens: 0 })`, and `provider` is **always the Claude value** on every ultra surface — anchor, rail card and dock head alike — because the ultra MCP server is constructed only on the Claude branch of the chat route and NFR-UW-8 fixes that. Write the comment in those words: *a `tokens: 0` here is not a readout of zero tokens; it is the unit that never applies on this path, and passing the Codex value would render a confident `0` — a fabricated figure, hard rule 3.* The anchor still takes `provider` **on its payload** rather than hard-coding it (a renderer that decides a unit is a renderer with a domain rule in it), and the adapter supplies its own. The dock's poller has no session provider — `Runtime` carries none — so `summarizeRuns` takes it as an argument and the poller passes the Claude value with the same comment. **If a Codex ultra path ever exists, this is the one place it changes.**

**D7 — `agent-start` must not disturb `ultra_status`, and proving that is part of the change.** `ultra-mcp.ts`'s rollup loop keys on `e.type === "agent"` for the done/dead counts and on `"phase"`/`"log"` for the rest, so a new variant is ignored by construction. That is a claim `git diff` and a test can both check: `ultra_status`'s output for a run with `agent-start` events is identical to its output for the same run without them. Story 4.1's AC3 protected `ultra_status` by not touching the file; you touch the stream it reads, so you owe the equivalent proof.

**D8 — The splice replaces the ultra tool part and SPLITS its group; it never appends.** `groupParts` collapses a run of consecutive tool calls into one `conversation:tools` item, so the `mcp__ultra__ultra` call usually arrives inside a group with neighbours. Three shapes were considered:

- *Append the anchor after the group.* **Rejected** — the shell marks only the **last top-level item** live, and `isTrailingItem` is what makes a streaming turn's trailing tool group auto-open. An item appended after it silently steals liveness from the turn. The `trailing` prop's own doc says this in the shell's words, and it is why story 3.1 put the loom rows there instead of in the item list.
- *Leave the tool row and add an anchor beside it.* **Rejected** — the contract says *"Each run is ONE compact fixed-height tool-style row"*, and a generic tool row showing `{script: "…4KB…"}` beside it is noise the density rule exists to prevent.
- *Replace the part and split the group.* **Chosen.** The group becomes: the parts before, the anchor, the parts after — dropping an empty side rather than emitting an empty group. Keys stay derived from the tool_use id, never from an index (the house maxim: *a key must name the event, not the slot*).

The splice is a **total function**: given items with no ultra call it returns them unchanged, and given a run whose manifest has not arrived yet it renders the anchor in a pending form rather than dropping it — the launch is a fact the moment the tool result carries a `runId`.

**How it recognises a launch, precisely, because getting this wrong is silent.** A `ToolPart` is `{ type: "tool", id, name, input?, output?, isError?, … }`; the tool's wire name is `mcp__ultra__ultra` (the SDK's `mcp__<server>__<tool>` composition of `createSdkMcpServer({ name: "ultra" })` and `tool("ultra", …)` — the same shape `ULTRA_AUTO_TOOLS` already spells out literally, so **read that const rather than re-deriving the string**). `output` is the tool's `okResult` text, which is `JSON.stringify({ runId, meta, note }, null, 2)`.

**And it is TRUNCATED.** The route passes every tool result through `capToolOutput`, a **head**-truncate at `TOOL_OUTPUT_CAP` (measured: 2500 characters at `e093a98` — re-derive it, do not quote it). A launch whose `meta` is large therefore arrives as a **prefix of valid JSON**, which `JSON.parse` rejects outright. Because `runId` is the first key the tool emits, the head survives — so the extractor is: try `JSON.parse` and read `runId`; on failure fall back to a `"runId"\s*:\s*"([^"]+)"` match over the same text; if neither yields an id, render nothing and leave the tool row alone. **Write both arms and test both**, including a fixture that is a deliberately truncated `okResult`. A splice that only handles well-formed JSON works on every small script you test by hand and fails on the first real one.

**Two more recognition rules:** an `isError: true` ultra tool result is a **validation rejection**, not a launch — `ui-contract.md` §5 requires the UI to accommodate *"a validation rejection (e.g. a `model`-less script) returning to the agent, which re-authors"*, and the correct rendering is the ordinary tool row, unspliced, because there is no run. And a tool part with **no `output` yet** is a launch in flight: leave it as a tool row until the result lands, then splice.

**D9 — The kind lives in its own file, its renderer is INLINE, and INV-8b2's scan set grows by exactly one entry.** Four blind spots meet here; one is recorded in `invariants.test.ts`'s own words and three are not recorded anywhere. Hard rule 10 lists all four. The two that decide this design are: the extractor's pattern requires a `: ItemKind<…> = {` annotation **with its generic**, and `DONOR_KIND_SLICES` is built from `SESSION_VIEW_REL` alone — **one file, one `kindRendererSlices` call**.

Declaring the kind inside `session-view.tsx` would close the file-set hole by making the one file this story is otherwise editing by nine expressions substantially bigger — the wrong trade. So: a new file, a `: ItemKind<UltraAnchorPayload> = {` declaration, an inline renderer, and a one-entry widening of the scan set with a floor naming both kind names and a two-direction discriminator (§5.4-F).

Two things stay open and must be **recorded, not claimed**: following an identifier into a top-level function is still not done, and the three undocumented shapes (`: ItemKind` without a generic, `satisfies ItemKind<…>`, and a file outside the set) are still undetected for any future kind. The residual's own instruction is to *"follow the identifier and scan that function's body too, rather than widening the brace match or deleting the check"* — widening the **file set** is the sanctioned half of that, and it is the half this story does.

**Three more constraints you must not trip while doing it, all measured in `invariants.test.ts`:**

- **INV-8b2's floor requires `session-view.tsx` to keep at least one `: ItemKind<…> = {` declaration named `agentBucketKind`**, and its failure message says so — *"if the donor stopped registering a kind of its own, say so here deliberately"*. Do not move `agentBucketKind` out while you are in that file.
- **The floor's failure message interpolates `SESSION_VIEW_REL` and names only that file.** Widening the set without widening the message leaves a guard whose diagnosis is false — the exact defect class §0 names. Update both.
- **`ambientContextScan`'s import arm is structurally inert under INV-8b2, and knowing that is what makes your widening honest.** The scan has three arms: `use(`, `useContext(`, and each of the eleven derived context-hook names — the third of which fires either on a **call** *or* on a bare **import** (*"importing it is the step before calling it, and nothing else here would flag the call"*). But INV-8b2 feeds it a **slice**, and a slice contains no import statements, so the import arm can never fire there. So the widening does two things, not one: add the new file's slices to the slice scan, **and** assert `ambientContextScan` over the new file's **whole text** is empty as well. Only the second catches an imported-but-not-yet-called `useDockOptional`, which is precisely the shape a later edit would reach for.

**On not importing `components/looms/status.tsx`.** `statusVisual` and `StatusBadge` take `GodStatusKind` and `WorkUnitState` — loom domain types. An Ultra run state is neither, and mapping one onto the other is a category error that would make `stopped` render as somebody's `halted`. `TONE_ICON` and `Tone` are domain-free and importable in principle, but `components/session/**` has **zero** imports from `components/looms/**` today, and story 3.1 already declined the identical import for `Marker` on the ground that it points a general surface at a domain module — recording instead that the right fix is lifting the tone tokens somewhere Track-neutral. **Follow that precedent: honour the law, duplicate the two Tailwind expressions, and add your file to the same recorded item rather than opening a new edge.** The law is what binds, not the module.

**D10 — The rail section is a slot on `SubagentRail`, not a wrapper around it.** `ui-contract.md` §3 says *"The existing sub-agent rail gains a Workflows section"* — inside, sharing the rail's border, its collapse behaviour and its scroll column. Rendering a sibling in the shell's `rail` slot would give two bordered columns and a Workflows section that vanishes when the rail collapses. So: `workflows?: ReactNode` above the Main anchor's divider, and `workflowCount?: number` rendered on the collapsed edge as a **fourth row inside `EdgeDots`** — which therefore gains one optional prop of its own, rendering a `WorkflowIcon` + count pair in the same register as the existing three, guarded on `> 0`. **Do not fold the run count into `running`**: that number is `agents.filter(c => c.status === "running").length`, the sub-agent figure the edge already publishes, and adding runs to it makes the edge lie about both. So the file changes in **three** places — `SubagentRail`'s prop list, its `EdgeDots` call, and `EdgeDots` itself — and that is the disclosed extent. Nothing else in it moves.

**And the rail must appear at all.** Today `rail={railAgents.length > 0 ? <SubagentRail …/> : undefined}` — an Ultra run that spawns no *session* sub-agents leaves the session with **no rail**, so the entire Workflows section is unreachable. That widening is D1's item 4 and it is not optional.

**D11 — The Script tab needs bytes, and there is no endpoint.** `readUltraScript(runId)` exists in core and is called only by `resumeUltraRun` and a test; `grep -rn "readUltraScript" apps packages` confirms no HTTP surface. Add `GET /api/ultra/[id]/script` → `{ script }` / `404`. It is read-only by construction — there is no PUT and there must not be one, because a script is the input to a resume and editing it from the UI would be a repo-mutating action with no approval path (the moat's posture, applied one level down).

**D12 — The authoring reference is ONE string, in a zero-import module, and it takes over from the tool description rather than duplicating it.**

`ultra-mcp.ts`'s header says the reference *"belongs to a later cut"* and that *"the tool description below carries a condensed version of the authoring guidance instead"*. That condensed version already covers all four CAP-3 subjects. So a second, fuller text elsewhere creates exactly the failure `session-prompts.ts`'s own header says that module exists to prevent — *"a SECOND source of truth … the failure mode this repo has paid for more than once"*.

**The ruling:** `apps/web/lib/ultra-authoring.ts` owns the text. `ULTRA_TOOL_DESCRIPTION` **keeps the opt-in rule, the non-blocking contract, the script format and the determinism bans** — the things a tool description must state because they decide whether the call is legal — and **drops the surface API walk-through, the quality patterns and the worked example**, which now arrive in the appendix on every Claude session and would otherwise ride the tool schema on every turn as well. Net token cost is roughly neutral; the number of sources goes from two to one. Add a comment at each end pointing at the other.

`ULTRA_TOOL_DESCRIPTION` is a **bare `const`** today — `grep -n "^export" apps/web/lib/ultra-mcp.ts` returns `ULTRA_AUTO_TOOLS`, `UltraMcpOpts` and `createUltraMcpServer` and nothing else. **Add `export` in the same edit**, because AC6 proof 5's pin is written against the identifier, and the only other way to reach the string is `server.instance._registeredTools[…].description` — the SDK's private registry, which `ultra-mcp.test.ts` already reaches through once and which breaks on an SDK upgrade for no reason. One word; say it in Completion Notes.

**Where it lives, and why not a `.md`.** Nothing in this repo reads a **shipped** markdown asset at runtime — every `.md` read in production code reads the state root or a target project's root — and there is no `import.meta.url`/`__dirname` asset resolution anywhere in `packages/core/src` or `apps/web`. A file read would also have to survive the packaged Electron build and Next's output tracing (`requirements.ts` is the one place in the tree that shows what that costs: a `/* turbopackIgnore: true */` on both the read and the join). A TypeScript const is the house pattern for every shipped prompt in the repo, and it is **the only shape that lets both the server composer and the client Script tab reach the same text without breaking INV-4.**

**Gating, and where it actually goes.** The gate goes in **`session-profiles.ts`'s builders**, not in `session-prompts.ts`'s composers, and the reason is mechanical rather than stylistic: `ctx` is the builder's argument and **nothing else in the tree holds it** — `projectAppendix` / `plannerAppendix` / `steererAppendix` take `{ ultraAnnotated, sessionId, readWake }` and have no provider in scope. So each of the three composers gains **one optional parameter** (`provider?`, spelled locally as `"claude" | "codex"` exactly as `spend-readout.ts` spells it, so `session-prompts.ts` acquires no new core type edge), the reference is appended only when it is `"claude"`, and each of the three builders passes `provider: ctx.provider`. **Absent ⇒ no reference**, so every existing call site keeps today's behaviour and the diff to the exact-equality assertions is bounded to the ones that opt in. `escalationAppendix` gains nothing — its signature stays free of both `ultraAnnotated` and `provider`, which is what enforces AC8 proof 3 by type rather than by memory.

`ctx.provider` is real on `SessionResolutionContext` and **no builder reads it yet**, so you are the first — write the comment. Do **not** "fix" the Codex case by adding a `requiredCapability`: `buildProjectProfile.requiredCapabilities` is `[]` and a project session is asserted to pass the gate on **both** providers; adding one would 400 every ordinary Codex session.

**Then face this squarely: `session-prompts.test.ts` asserts composed appendices by EXACT EQUALITY in roughly two dozen places, and an unconditional fragment breaks all of them at once.** **A POINTER, and two independent measurements of it disagreed while this story was being written — which is the whole reason maxim 2 exists.** At `e093a98`: `grep -c "\.toBe(" apps/web/lib/session-prompts.test.ts` → **35** total; the narrow `grep -cE "expect\((project|planner|steerer|escalation)Appendix"` form → **13**; counting every assertion whose subject is a composed appendix once the file's own locals are followed (`steerer`, `steererAppendixNoId`, `bothBroke`, and the locally-bound `appendix` consts) → somewhere in the low twenties, and two careful readers got different answers. **The number is your budget for how many assertions D12's change breaks, so re-derive it yourself, by reading subjects rather than by grepping, before you plan the edit. Do not carry any figure from this paragraph.** The ones that decide your design are `expect(projectAppendix({ ultraAnnotated: false })).toBe("")` (which appears more than once), the order pin `.toBe(STEERER + LIVE + NOTE + WAKE)` — **your block joins that concatenation and its position is now part of the contract** — and `session-profiles.test.ts`'s *"a plain project session with the Ultra chip OFF has an EMPTY appendix"*, whose comment says that `""` is *"what keeps 'a normal session's systemPrompt is byte-for-byte unchanged' true after the migration"*. **Your change makes that property false for Claude project sessions, deliberately, and you must say so in place.** Update those assertions the way story 4.1 updated the two it inverted: carry the old expectation, the reason it was right for its story, the reason it is wrong now, and the half that did **not** change (the Codex appendix, and the escalation appendix, both still empty of ultra text). Do not delete an assertion to make a suite pass.

**D13 — The dock signal is an app-wide poller, not a change to the runtime host.** Two facts kill the obvious design. `<Dock>` returns `null` when `entries.length === 0`, and `SessionRuntimeHost` mounts only for entries — so a session with a live run that the user never docked has no host, no poll and no bubble. And today's auto-dock fires only when the **chat turn** is `busy`, while an Ultra run is detached and routinely outlives its turn. So the mechanism that would carry the signal does not run in the exact case the AC describes.

The design: a render-nothing client component mounted once in the root layout, **inside `<DockProvider>`** (it calls `useDock()`; `LoomNotifications` sits outside because it does not). It polls **the unfiltered list** — AC7 proof 1 gives the measured reason a session-scoped poll cannot work here — calls the dock's own public `autoDock(...)` when a session acquires a live run, taking the head's identity from `GET /api/chats` (AC7 proof 2), and writes the summary through `setRuntime`. `setRuntime` is a **shallow merge over a fixed base** — passing an array replaces it; it is not an accumulator.

Widening the auto-dock guard in `session-view.tsx` (D1's item 8) covers the other direction: leaving a session that has a live run docks it, exactly as leaving a session mid-turn already does.

**Focus on arrival**: push `?run=<runId>` onto the session route and have **your** code read it — `SessionView` is keyed `project:id`, so a query-only change does **not** remount, which means the consuming effect must depend on the param and not on `[]`. Clear it with `router.replace(pathname, { scroll: false })`. **No programmatic `element.focus()` to move or scroll** (AC7 proof 5 states the rule precisely, including the two legitimate `.focus()` calls that do exist elsewhere in `apps/web`, so you do not mis-cite it as a repo-wide absence). "Focus" here means *select that run in the rail and expand it*, which is state, not a DOM call.

**D14 — INV-10, and why it is worth the file's budget.** `invariants.test.ts` deliberately spawns no process and invokes no compiler. INV-10 fits inside that as a static scan plus a runtime registry construction:

- **INV-10 floor** — the anchor file exists and declares exactly one `ItemKind`, so the whole invariant cannot pass vacuously if the file is deleted.
- **INV-10a** — the id is exactly `ultra:run-anchor`, one colon, module segment `"ultra"`, and it is a member of `MODULE_NAMESPACES`.
- **INV-10b** — the id is registered in the **adapter's** registry (`session-view.tsx` mentions `ultraRunAnchorKind`) and **is not** in the gallery's (`demo-gallery/conversation/shell.tsx` does not). This is hard rule 4 made mechanical, and it is what stops a later story quietly turning configuration 6's tombstone into an ordinary item.
- **INV-10c** — `components/conversation/**` contains no file mentioning `ultra` at all, so the kind never migrated into the shell.
- **INV-10d** — the discriminator: a runtime-assembled registry containing a mis-namespaced ultra id is **reported** by the same helper the real check uses.
- **INV-10e** — `KNOWN_VIOLATIONS` did not grow, in the shape of `INV-7f`/`INV-8h`/`INV-9e`.

### 5.6 Traps

**T1 — The gallery disagrees with the contract in five places, and every one of them is copy-pasteable.** This is the single largest source of avoidable defects in this story.

1. **`RunState` includes `"completed"`. That state does not exist.** The gallery declares `"running" | "stopped" | "completed" | "failed"`; the engine's is `"running" | "done" | "failed" | "stopped"`, and `SPEC.md` says outright that *"the plan's draft name `completed` is superseded"*. Any state pill, any `state !== "completed"` guard, any `STATE_STYLE` key copied across is wrong at runtime and silently — the lookup just misses.
2. **`AgentState` (`queued`/`running`/`retrying`/`done`/`failed`/`stopped`) is fabricated.** So is `AgentDef.snippets`, so is `PhaseDef` with its `id`/`kind`/`activateAt`, and so is `AgentDef.phaseId`. There is no phase identity and no agent→phase link in the data (§5.5-D6).
3. **The colours violate the quiet-colour law.** `STATE_STYLE` uses saturated fills (`bg-sky-500/10 text-sky-300`, `bg-emerald-500/10 text-emerald-300`), the anchor's border is `border-indigo-500/25`, the agent dots are saturated, and the running pill uses `animate-pulse`. `project-context.md` is explicit: *"only the icon (and, for a real failure, the label) carries a hue; the badge stays a neutral outline. Active build/verify use a neutral spinner, never a saturated hue."* **Port the geometry, not the palette.**
4. **`agentTokensAt` linearly interpolates a token count over wall time.** The rising `{n}t` numbers in the rail are theatre. **There are no token counts anywhere on the ultra path** — ultra's ledger rows carry cost, not tokens. Rendering a token figure per agent is inventing data (hard rule 3).
5. **`StageFrame`, the theme toggle, `Segmented`, `ToolCard`, the replay controls, the virtual clock, the hardcoded session title, `journalKept: true`, and `sel` opening pre-drilled into a specific run** are all lane-local scaffolding. The one number worth carrying from `ToolCard` is its `max-w-[92%]`, which is what makes the anchor read as tool-style.

**T2 — Three invariants will fire on a naive implementation, and each has a right response and a wrong one.**
- **`INV-8g`'s `MOVED_OUT_OF_ADAPTER`** — thirteen strings, including `item.kind`, that must not appear in `session-view.tsx`. If it fires you wrote a kind dispatch in the adapter. **Move the dispatch into the registry**; do not shorten the list.
- **`INV-8i`** — `ConversationProps` is exactly nine names. If it fires you tried to add a tenth slot. **Put the data in the payload**; do not widen the shell.
- **`INV-8c`** — classified React contexts and consuming hooks. If it fires you added a provider. **You do not need one**; the dock's context already exists and the anchor's data rides the payload. If you genuinely add one, adding it to `CLASSIFIED_CONTEXTS`/`CLASSIFIED_HOOKS` is a deliberate act needing a justification comment, not a way to make red go green.

**T3 — An Ultra-only session has no rail today, so the Workflows section is unreachable until you widen one condition.** `railAgents.length > 0`. It is one expression and it is easy to miss because every manual test you do by hand will probably also spawn a sub-agent.

**T4 — Appending after the streaming turn steals its liveness.** The shell marks only the last top-level item live; `isTrailingItem` treats a trailing run of permission items as not ending liveness, and everything else as ending it. This is why story 3.1 put the loom rows in `trailing` and why §5.5-D8 splits the group rather than appending. If you find the trailing tool group stops auto-opening mid-turn, this is what you did.

**T5 — Phase membership is an inference from stream order, and a resume re-emits the whole sequence.** There is no phase id and no link from an agent to a phase. The rule is "the most recent preceding `phase` event", which is `ultra_status`'s own dedupe idiom — and nothing pins it, so **you** are pinning it. On a resume the phase events re-emit from the cheap re-run, so the inference must be idempotent: grouping the same stream twice must produce the same groups, not double them.

**T6 — The narrator window will show the ledger's bookkeeping errors unless you filter.** A `log` event is not always a script's `log()` call: `storage.ts` narrates its own accounting and publish failures through the **same** variant. Measured at `e093a98`, four distinct prefixes — `spend-read-unavailable:`, `spend-record-skipped ordinal=`, `spend-record-failed ordinal=`, and `run-completed-publish-failed:` (the last added by story 4.1). **Re-derive that list rather than trusting this one**; the count moved once already. They are diagnostics for a developer reading `events.ndjson` with `tail` at 1am — the logging doctrine `ARCHITECTURE-SPINE.md` states — not narration for a user watching a run. Put the prefixes in one exported const in `ultra-runs.ts`, filter on it, and test that a stream containing one renders no narrator line **and** that an ordinary `log` line still does (a filter that eats everything passes the first assertion alone).

**T7 — An `EventSource` that is not closed on `end` reconnects forever.** The browser reconnects on stream close by design. `/api/ultra/[id]/events` sends `end` and closes; without `es.addEventListener("end", () => es.close())` the anchor re-opens the stream every few seconds, per anchor, per concurrent run, for the life of the page. `session-view.tsx` already does this correctly twice — copy it.

**T8 — One malformed manifest anywhere under the ultra root throws for every reader, and only one route in the tree guards it.** `listUltraRuns` → `getUltraManifest`'s self-heal is an **unwrapped write** inside a function whose contract is "never a 500". `apps/web/app/api/ultra/wakes/route.ts` reproduces two real cases in its own comment and wraps them; **`GET /api/ultra` does not and will 500.** Your list route, your agents route and your script route all copy that guard. And your dev proof runs against a root that the run log says **currently contains** exactly such a manifest (`u-fixround-bad`).

**T9 — `{"ok": false}` from Stop is the normal answer, not an error.** `stopUltraRun` returns false for three different situations — the run is unknown, it is not live *in this process*, or it is already terminal — and they are indistinguishable. The Stop button must not render an error on `false`; it reconciles from the next manifest snapshot. Say which of the three you are assuming, in a comment, and then do not assume it.

**T10 — Resume is not idempotent, and core does not gate it on state.** A second POST while live returns a 400 naming the run. And `resumeUltraRun` will happily resume a `done` run and re-fire its wake — so the "no Resume on `done`" rule is a **UI** rule, stated in a comment, not something the port enforces. Both directions matter: disable the affordance after a click, and do not "fix" the UI to match the port.

**T11 — Do not persist the armed flag.** `telar:composer:${project}` remembers model, effort and permission mode across sessions. The chip is per-message by NFR-UW-1 (*"Opt-in is a request, not a behavior flag … No engine mode, no `TELAR_*` switch"*). A remembered chip is a behaviour flag with extra steps.

**T12 — A permission event yanks the rail to Main.** `session-view.tsx` forces `setActiveTab("main")` on every `"permission"` event, so a user pinned on a Workflows view loses it the moment any tool asks for approval. This is existing behaviour for sub-agent tabs and is arguably right there. **Decide what it means for the Workflows view, write the decision down, and if you leave it as-is, say so** — a run the user was watching disappearing on an unrelated approval is a defect the dev proof will show you and the next reader will not be able to distinguish from an oversight.

**T13 — Never sum `costUsd` deltas.** `manifest.spend` is a fold over `usage.ndjson`, recomputed on every save, non-monotonic, and it can move without this run spending. A resume re-presents every replayed settle with its **original** `costUsd` and `settleId`, so a UI accumulating deltas double-counts on the first resume. Take the manifest's number.

**T14 — A run can reach a terminal state with no event, no publish, and no `end` frame you will ever see.** `getUltraManifest` rewrites a stale `running` to `stopped` **on read**, without going through `settle()`. Story 4.1's whole wake design turns on this. For you it means: the anchor's state comes from the **manifest snapshot** (the `run` frame, and the list poll), never from having observed a `state` event. A UI that waits for an event to declare a run finished will show a permanently-running anchor for every run a server restart killed.

**T15 — `manifest.project` is a root PATH; `POST /api/ultra`'s `project` is a SLUG.** They are not the same string and a rail card showing "project" from a manifest gets an absolute filesystem path. If you show a project at all, derive the label, do not print the field.

**T16 — Two envelopes, three shapes, one object.** SSE `run`/`end` send the bare `UltraManifest`; `GET /api/ultra/[id]` sends `{ run }`; `GET /api/ultra` sends `{ runs }`. Write one adapter in `ultra-runs.ts` and use it everywhere, or you will unwrap the wrong level exactly once, in the case you tested least.

**T17 — `Shimmer`'s `children` is typed `string`.** It cannot wrap elements. The masked-shimmer snippet is a string child, and if you need a chip beside it, the chip is a sibling.

**T18 — The wake must still work when you are done.** Story 4.1's mechanism runs through the same file you are editing: the `useUltraWake` hook, the injection queue, the `hidden` flag, the sentinel, and the drain gate whose three conditions you must not touch. **Do not add a second idleness predicate.** After your change, re-run the wake end-to-end at the dev server and say so — it is the epic's headline feature and yours is the story that could break it without any test noticing.

**T19 — Fourteen things about this repo's visual layer that the demo will teach you wrongly.** Each is measured; each will cost you a review round if you learn it late.

1. **`SparklesIcon` is taken twice over, and the second one is fatal.** `composer-settings.tsx` uses it for the Claude-config chip — the control your Ultra chip sits beside — and `subagent-rail.tsx`'s `TOOL_GLYPH` maps it to the `general-purpose`/`general` subagent type, which is **the very rail you are adding a Workflows section to**, so a Workflows glyph reusing it would collide inside one column. **`WorkflowIcon` is this repo's established Ultra/weave glyph**, and it is *already imported into `session-view.tsx` and used nowhere in that file* — a dead import waiting for exactly this feature. Use it, and the dead-import lint problem disappears as a side effect of building the thing rather than as a tidy-up.
2. **The rail is `w-60` in production, not the demo's `w-72`, and it has no `bg-card`.** Everything you add fits 240px minus `p-2`.
3. **`fmtCost` renders four decimals** (`$1.9500`). The demo minted a local two-decimal `usd()`. Go through `spendReadout()`; do not mint a third formatter — its own header says so.
4. **Every `animate-in` / `animate-out` utility is globally neutered** in this app's CSS. The terminal collapse must be a `transition-*` on `max-h`/`opacity`, which is exactly what `SubagentCard`'s mount transition already does — copy it.
5. **`Progress` auto-renders its own track and indicator after `children`, and its root adds `gap-3`.** For a 1px sliver, hand-roll two divs. (It would also read as a budget meter, which AC9 forbids.)
6. **`ScrollArea` exposes no viewport ref**, so you cannot pin it to the bottom. The narrator window is a plain `ref`'d `overflow-y-auto` div with an explicit `h-*` — which is what the demo does and is the one thing there worth copying verbatim.
7. **This is Base UI, not Radix.** `Tabs` uses `Tabs.Tab` / `Tabs.Panel` with `data-active`; polymorphism is the `render` prop, never `asChild`. Copying a Radix snippet compiles and then behaves differently.
8. **`Badge` force-sizes child SVGs with `[&>svg]:size-3!`** — an explicit `size-2.5` on a child icon is silently overridden.
9. **Truncate by code point.** `tool-step.tsx`'s `stepPreview` uses `Array.from(...)`; `.slice()` splits astral characters. `items.ts`'s `agentLabel` does the same and says why.
10. **`text-*-300` is dark-only and light mode is real.** The demo is dark-only throughout. Use the `text-X-600 dark:text-X-400` pairs `TONE_ICON` already defines; `text-destructive` and `bg-destructive/10` are theme-token driven and safe in both.
11. **Do not reach for `StateBadge`** (`components/common/state-badge.tsx`). It is the *other* palette — tinted borders and backgrounds — and it is keyed on `WorkUnitState`, which an Ultra run is not. `project-context.md` names `status.tsx` as the canonical vocabulary.
12. **`tool-step.tsx` itself contains one violation of the quiet-colour law** (a saturated amber spinner on the active to-do). Precedent existing in production does not make it the law. Do not propagate it.
13. **Two `Conversation`s and two `StatusBadge`s exist.** `components/ai-elements/conversation.tsx` (the viewport) and `components/conversation/conversation.tsx` (the shell); `components/looms/status.tsx` and `components/projects/git-tab-shared.tsx`. Import by explicit path, always.
14. **Do not nest interactives.** The demo's anchor is a `<button>` containing a `<span role="button" tabIndex={0}>` for Resume. Make the anchor a non-button container with two real buttons inside it.

**On mapping run states to tones:** `running` → `active` with the **neutral spinner** (`Loader2` in `TONE_ICON.active`, which is `text-foreground`); `done` → `done`; `failed` → `danger`; `stopped` → **`attention`**, because it is the state that grows a Resume affordance and is therefore waiting on a human, which is what `attention` means everywhere else — and it keeps `danger` exclusively for a real failure, which the law's own parenthetical depends on. **One mapping table, in one module, never per component.** Reproduce the tone classes rather than importing `status.tsx` (§5.5-D9).


---

## 6. Testing requirements

### 6.1 The rules this story exists under

- **`bun test` is the only tooling.** Core specs live flat in `packages/core/test/`; web specs sit beside the module they cover under `apps/web/lib/`. No jest, no vitest, **no DOM harness** — story 3.1's hard rule 9 forbids introducing one, and §5.5-D3 is how this story lives inside that constraint.
- **Counts are a smell test, not a fact.** Measured at `e093a98` on 2026-07-27: `ls packages/core/test/*.test.ts | wc -l` → **109**; `find apps/web \( -name "*.test.ts" -o -name "*.test.tsx" \) -not -path "*/node_modules/*" | wc -l` → **20** (the flat `lib/*.test.ts` glob undercounts — six specs are nested). Use the `find` form. These are **pointers**. Re-measure and record your own.
- **INV-7's three sanctioned mechanisms, and nothing else:** pin `process.env.TELAR_HOME` to an `fs.mkdtempSync` root at module scope **and** re-pin it in a `beforeEach` (the core house idiom — bun runs every suite in one process); or pass an injected read to the composer (the `session-prompts.test.ts` idiom); or move the call into a child spawned with a throwaway `TELAR_HOME` **and** `HOME` (the `session-profiles.test.ts` idiom). **Do NOT blank `TELAR_HOME` in this process to "disable" the read** — that is story 1.3's shape and it resolves to the real store.
  - Your core suite edits take the **first**.
  - Your `session-prompts.test.ts` edit takes the **second** — that file already does.
  - Your `apps/web/lib/ultra-runs.test.ts` and `ultra-authoring.test.ts` should touch **no disk at all**; that is the point of §5.5-D3, and a test that needs a state root is a signal that a decision leaked into a component.
- **Every filtered run takes a path argument** (hard rule 6).
- **`resetBus()` is global**, so any suite that touches the bus declares fixtures per test. This story declares no event, so this should not bind you — if it does, you added one (§3).

### 6.2 What the suites must actually carry

| Claim | Where it is proved | Shape |
| --- | --- | --- |
| The splice replaces the ultra part, splits its group, and is a no-op without one | `apps/web/lib/ultra-runs.test.ts` | pure function over `TranscriptItem[]` |
| Two launches produce two anchors, in order, dropping nothing | `ultra-runs.test.ts` | AC4, with a one-run anti-vacuity control |
| `anchorForm` changes at most once across a 20-snapshot run, and only at terminal | `ultra-runs.test.ts` | AC2, the honest stand-in for a height claim |
| Agent rows dedupe by ordinal across a resume's `cached: true` re-emissions | `ultra-runs.test.ts` | a real resumed event sequence |
| Phase grouping is stream-order and idempotent under a re-emitted sequence | `ultra-runs.test.ts` | T5 |
| The narrator filters the accounting prefixes | `ultra-runs.test.ts` | T6, one prefix per case |
| `total` is `undefined` while running; the sliver is absent when `meta.phases` is absent or malformed | `ultra-runs.test.ts` | **AC11**, with a `meta` fixture carrying `phases: 3` (a number) as the malformed case |
| The arm reducer arms one send and disarms after it | `ultra-runs.test.ts` | AC6 |
| The dock summarizer for 0 / 1 / 3 runs | `ultra-runs.test.ts` | AC7 |
| No budget token appears in the three new component files or in `dock.tsx` (enumerated in AC9 proof 2) | `ultra-runs.test.ts` | **AC9**, static scan with a floor of exactly 4 and a two-direction discriminator |
| `agent-start` is emitted once per live ordinal and never on a cached replay | `packages/core/test/ultra-executor.test.ts` | AC3/AC11 |
| `effort` rides the event and **still** does not reach `engineOpts` | `ultra-executor.test.ts` | the existing pin, re-asserted beside the new one |
| `ultra_status`'s rollup is unchanged by the new variant | `apps/web/lib/ultra-mcp.test.ts` | **D7** — same input stream ± `agent-start`, identical output |
| `listUltraAgentOrdinals` sees an ordinal that has emitted but not settled | `packages/core/test/ultra-storage.test.ts` | AC3 |
| `GET /api/ultra` without `sessionId` is byte-for-byte today's response | wherever route logic is testable without a server; otherwise the prove-run | D5 |
| The reference covers all four subjects; its worked example compiles under `compileScript` | `apps/web/lib/ultra-authoring.test.ts` | **AC8** — a reference whose own example the tool would reject is worse than none |
| The appendix carries the reference on Claude project/planner/steerer and never on escalation or Codex | `apps/web/lib/session-prompts.test.ts` | AC8, and the seventeen exact-equality assertions updated deliberately |
| The `ultra` tool description still names the chip and still forbids inferring | `apps/web/lib/ultra-mcp.test.ts` | AC6 proof 5 |
| The kind's id, its registration site, its absence from the gallery, and `KNOWN_VIOLATIONS` | `packages/core/test/invariants.test.ts` INV-10 | §5.5-D14 |
| INV-8b2 actually scans the new file | `invariants.test.ts` | **AC10**, floor + two-direction discriminator |
| The gallery's tombstone is still a tombstone | `apps/web/lib/demo-gallery/conversation/fixtures.validate.test.ts` | **run it; do not edit it** |

**Not provable without a DOM, and therefore proved at the dev server instead:** that the anchor's rendered height does not change while running; that the narrator window scrolls without moving anything around it; that the rail appears; that the chip renders and disarms visibly; that the dock head appears for an undocked session and that tapping it lands on the focused run. **Say so plainly in the Debug Log rather than implying a test covers it.**

### 6.3 What the Debug Log must contain

1. The full gate, with the asymmetry V1 names: `bun test` and `bunx tsc --noEmit` in **both** workspaces, `bun run lint` in **`apps/web` only** (`packages/core` has no `scripts` key — record that, do not create one). Real output, your own re-measured counts, and your own re-measured lint baseline with only the problems your diff ADDED called out.
2. **The prove-run:** the exact command you ran (`TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-d prove-run"`), its real output, the `mktemp` root it used, and a leg-by-leg statement of which of L1–L6 passed. **If L2 — the in-flight ordinal — did not pass, §5.5-D6 did not land, and the executor change is unproven no matter what compiles.**
3. The verdicts, **by name**, of `INV-4`, `INV-5b`, `INV-6a`, `INV-7`, `INV-8a`, `INV-8b`, `INV-8b2`, `INV-8c`, `INV-8f`, `INV-8g`, `INV-8i`, `INV-9`, plus INV-10's own arms — and the two gallery tombstone tests by title.
4. The dev-server proof in full, per §2, **opening with the `ls apps/web/node_modules/@anthropic-ai/` result §7.2 requires**, and including what you found in `~/.telar-dev` before you started and what you did about it.
5. The five AC11 rulings restated with what you actually shipped for each.
6. **All eight out-of-Owns rows and the one SPEC-non-goal widening (`executor.ts`) restated** with the line counts you actually produced (§0.2), and the TEN `session-view.tsx` expressions enumerated against what you actually changed. **If it is eleven, say eleven.** Plus the one-word `export` on `ULTRA_TOOL_DESCRIPTION` (§5.5-D12).
7. Your finding on **T12** — what a permission event does to a pinned Workflows view, and what you decided.
8. Confirmation that story 4.1's wake still fires end-to-end after your change (T18) — or, if the SDK native CLI is still absent, the explicit statement that it could not be observed and why.
9. Anything you recorded in `deferred-work.md`, with its owner — including the six rulings §3 requires, and the INV-8b2 residual with its three undocumented shapes (hard rule 10).

### 6.4 The prove-run

**The house form is a `bun test` suite, not a shell script, and you must not invent a second mechanism.** Read `packages/core/test/track-a-prove-run.test.ts`'s header before writing a line of this. It establishes everything: the file is *"a GATE, not a convenience"*, the whole run is **one command**, the suite **pins its own `mkdtemp` root regardless** so it is safe when someone forgets the environment variable, and the path argument is documented with a measured reason rather than a habit.

The command:

```
TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-d prove-run"
```

**Why the `packages/core` path argument is there, in Track A's own words, and it is hard rule 6's origin:** *"it looks redundant and is not. The bare `bun test -t 'track-a prove-run'` form fails on L4 … apps/web suites install a PROCESS-GLOBAL `mock.module("@telar/core", …)` at MODULE SCOPE and restore it only in `afterAll`. A repo-root run WITH a `-t` filter evaluates every file's module scope before running any test, so those `afterAll` hooks never fire and the stub is live inside every core suite in the process."* Note Track A also **measured** that `ultra-mcp.test.ts` — your file — installs the same process-global mock with the same hygiene defect but stubs no loom writer, so it does not reproduce that particular symptom. **That is not a reason to drop the path argument.** It is the file you are about to edit, and the next stub someone adds to it changes the answer.

**The legs, and their honest scope.** Track B's L6 states its own scope explicitly *"because an over-claimed prove-run is worse than a"* silent one. Do the same. These legs are the **engine and projection spine**, in one process, under one sandboxed root, with the real `~/.telar` untouched throughout:

- **L1 — a run is born and narrates.** Launch a tiny two-phase, two-agent script through `launchUltra` with a `sessionId` and a `messageId`. Assert `events.ndjson` contains, in order, at least one `phase`, at least one `agent-start`, at least one `agent`, and a terminal `state`.
- **L2 — an in-flight agent is visible.** Assert `listUltraAgentOrdinals` reports an ordinal that has emitted but **not settled**, at least once, while the run is live. **This is the one leg that proves §5.5-D6 landed rather than merely compiled**, and it is the reason this story touches the executor at all.
- **L3 — the projections are total.** **This leg lives in `apps/web/lib/ultra-runs.test.ts`, not in the core file**, and saying so is the honest scope line: `packages/core` importing from `apps/web` is an edge that exists nowhere in this tree, and Track B's own prove-run leg (`packages/core/test/session-profile.test.ts`'s `describe("prove-run L6")`) sets the precedent of a leg living where its subject lives. So the core file's L3 asserts only that the captured stream is **serialisable and complete** (every variant present, ordered, deduped by ordinal), and the web file replays that same fixture through `runSnapshot` / `phaseGroups` / `agentRows` / `narratorLines` and asserts the anchor payload — including that `agentsTotal` is `undefined` and, for a `meta` without `phases`, that the sliver is absent (AC11). **Write the captured stream to a shared fixture rather than duplicating it**, and say in both files which half proves what.
- **L4 — the session filter answers.** `listUltraRuns()` filtered by `sessionId` returns exactly this run; unfiltered returns a superset. (The HTTP layer is thin over this; the route test is the route's own.)
- **L5 — stop and resume keep the journal.** Stop a second run, assert `stopped`; resume it, assert the replayed ordinals carry `cached: true` and that `agentRows` **does not double** (AC5 proof 5).
- **L6 — the ledger and the manifest agree.** `manifest.spend` equals the first-occurrence-per-`entryKey` fold over the sandboxed `usage.ndjson` — story 4.1's own helper shape, reused rather than re-derived.

**What it deliberately does NOT prove, said out loud:** it does not drive a browser, does not render, and therefore proves nothing about the anchor's height, the narrator's layout stability, the chip, or the dock. Those are the dev-server proof's, and §6.2 already says which claims live where. A prove-run that implied otherwise would be the over-claim Track B warns about.

---

## 7. Previous story intelligence

### 7.1 The four maxims, verbatim, because each was paid for twice

1. **A line number is not a name.** Cite file + symbol.
2. **A count is re-derived, never carried.** Run the command.
3. **A guard that cannot fail is worse than no guard.** Every scan carries a floor and a discriminator.
4. **A key must name the event, not the slot it landed in.** `attemptKey` and ultra's `entryKey` were each re-cut after naming a position rather than a billable call. If you find yourself minting an identifier from an index, stop. **This binds your transcript keys directly** — derive them from the tool_use id and the runId, never from a loop counter.

### 7.2 From story 4.1 — the half of epic 4 you are completing

- **`ultra:run-anchor` was held unregistered for you**, deliberately, and 4.1's hard rule 9 named this story. Two corrections to that rule are in hard rule 4 above; the substance stands.
- **`spend-readout.ts` was built with you in mind.** Its own notes say *"4.2's anchor can compute the identical pair from `UsageEntry`'s own fields"* and fix the Codex token figure as `tokens.input + tokens.output`, **deliberately excluding the two cache fields** because they are re-presentations of content already sent and would climb every turn on an idle transcript. Use the same pair.
- **`ultraCostByMessage()` exists and answers "what did the runs this turn launched cost".** Its doc says plainly that it does **not** answer "what did this turn cost", because the chat route's own row carries no `messageId`. If you show a per-message split, that asymmetry is the thing to be careful about.
- **The `injectionQueue`/`hidden` change is the precedent for your `ultra` queue flag** (§5.5-D2), including the regression it risks: 4.1's Debug Log had to assert that the loom watcher's `[watcher] …` bubbles stayed **visible** afterwards. Yours has the mirror obligation: an unarmed queued message must send with no `ultra` key.
- **4.1 shipped with AC1 recorded as "proved by construction, not observed", and the reason is still true at `e093a98`.** Two *different* environment notes live in `deferred-work.md` and they must not be confused. (i) The **3.1** note — `bun run dev` served no route — is **✅ CLOSED** by commit `0bd6073`'s `shiki` entry in `next.config.ts`; routes serve. (ii) The **4.1** note — *"No live model turn is possible in this checkout: the Agent SDK cannot find its `darwin-arm64` native CLI"* — is **OPEN, has no owner, and is what actually blocked AC1**. Re-measured while writing this story: `ls apps/web/node_modules/@anthropic-ai/` returns `claude-agent-sdk` alone; the native package sits unlinked in the bun store at `node_modules/.bun/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.204/…`.
  **Run that `ls` as the FIRST line of your dev-server work, before anything else, and record its output in the Debug Log.** If the sibling is still absent then no model turn is possible, and therefore: no chip → `ultra` tool call, no `mcp__ultra__ultra` tool part, no anchor splice, and no wake turn. **Do not discover this at the end and do not paper over it.** The sanctioned fallback, if it is still absent: launch runs directly with `POST /api/ultra` (project **slug**, §5.6-T15) and prove the rail, the narrator, Stop, Resume, the concurrent case and the dock signal from real runs; prove the anchor splice and the chip by their pure functions in `ultra-runs.test.ts`, and say **in those words** that the rendered anchor and the armed chip were not observed. Mutating `node_modules` is the operator's call, not yours — the 4.1 note says why.
- **4.1's own adversarial round found two real bugs in its own new code**, both in the client chain, both caught only because the decisions had been moved into pure functions. That is the strongest available argument for §5.5-D3.

### 7.3 From story 3.1 — the surface you are extending

- The shell is frozen and `MODULE_NAMESPACES` already includes `"ultra"` — **no vocabulary change is needed and none should be made.**
- `SESSION_AGENT_BUCKET` / `agentBucketKind` spliced into `SESSION_KINDS` **without touching `components/conversation/**`** is your template, recorded as such.
- The `trailing` prop exists because the shell marks only the **last** top-level item live. §5.5-D8.
- `NH-2` decided, as documentation rather than behaviour, that `ItemViewState.render` **zeroes** a nested item's liveness rather than inheriting it — and named the consequence: `toolsKind` derives its disclosure default from liveness, so an inherited flag would default every nested tool group open. If your anchor ever renders nested items, that default is deliberate.
- `NH-11` declined to import `components/looms/status.tsx` into a presentational primitive and recorded the right fix as lifting the tone pair somewhere Track-neutral. §5.5-D9 follows it.
- Three cleanups in `session-view.tsx` are recorded with "any later story with this file open" as owner. §3 declines all three, deliberately, for the same reason 4.1 did: a bounded diff is auditable and a sprawling one is not.

### 7.4 From stories 1.1–1.3 and 2.1/2.2 — the substrate

- The ledger is the most heavily repaired file in the repo. You **read** it and never write it.
- `INV-5b` pins `logUsage` to exactly three call sites. This story adds none — if it fires, you added one.
- The route resolves the profile **before** the stream opens and an unmet capability is a pre-SSE 400; `INV-6c` pins the ordering. Your appendix change rides inside that, and `INV-6a` pins `SessionProfile`'s field set — **you add no field to it.**
- Story 2.2's blocking review finding was a test that reached the operator's real state root through a `@ts-expect-error` written above a **call**. That is hard rule 5.
- Story 1.3's `mock.module` leak is why hard rule 6 exists, and one of the three leaking files is in your write set.

### 7.5 What is still open, and stays open

- The five `[Review][Decision]` items on story 1.1, including the sidebar/dashboard owner-scope question.
- The `mock.module` leak in three `apps/web` suites.
- `scripts/backfill-tool-detail.ts`'s hardcoded `~/.telar` — the single `KNOWN_VIOLATIONS` entry.
- The four Codex-guardrail holes owned by story 5.5, and the appendix-contributor registry owned by 5.3.
- **After this story:** the `human-facing` delivery class is still exercised by no production event; the `sessionId → runIds` index is still a scan; `saveManifest`'s error contract is still unwrapped in two places; INV-7's reader surface is still missing four symbols; and INV-8b2 still cannot follow an identifier into a top-level function. **All five are re-recorded by §3 and V4 with owners. None of them is closed by this story and none should be claimed as closed.**

---

## 8. References

| What | Where |
| --- | --- |
| Story text, ACs verbatim, dev-server proof, dispatch notes | `_bmad-output/planning-artifacts/epics.md` § Epic 4 / Story 4.2 |
| CAP-2, CAP-3, CAP-4, CAP-6 success clauses; constraints; non-goals; the success signal | `_bmad-output/specs/spec-ultra-workflows/SPEC.md` |
| **The frozen session-UI contract — all nine clauses** | `_bmad-output/specs/spec-ultra-workflows/ui-contract.md` |
| What is built vs. what is owed | `_bmad-output/specs/spec-ultra-workflows/brownfield.md` |
| AD-3, AD-8, AD-12, AD-13, AD-14, AD-15, AD-18, AD-19, AD-20, AD-21 | `.../architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md` |
| Track D's write set and seams; the four serialization points | `.../architecture-telar-2026-07-24/WORK-SPLIT.md` |
| Why the shell's contract was frozen instead of queued; finding A3 | `.../architecture-telar-2026-07-24/SOLUTION-DESIGN.md` |
| Binding project rules (Bun only, client-bundle rule, SSE, status vocabulary, testing, no global client store) | `_bmad-output/project-context.md` |
| The renderer contract and the five construction-time errors | `apps/web/components/conversation/registry.ts` |
| The four slots, the opaque view state, the tombstone, the `trailing` rationale | `apps/web/components/conversation/conversation.tsx` |
| The adapter-local kind template | `apps/web/components/session/session-view.tsx`'s `agentBucketKind` / `SESSION_KINDS` |
| The anchor's seam, the chip's server half, the reference's absence — all stated in advance | `apps/web/lib/ultra-mcp.ts`'s header and `ULTRA_TOOL_DESCRIPTION` |
| The `UltraEvent` union and the `settleId` doctrine | `packages/core/src/ultra/executor.ts` |
| The manifest, the self-healing read, the ledger tap, `listUltraRuns` | `packages/core/src/ultra/storage.ts` |
| The one guarded route, and the two failures that make the guard necessary | `apps/web/app/api/ultra/wakes/route.ts` |
| The app-wide poller precedent | `apps/web/components/common/loom-notifications.tsx` |
| The zero-import pure-seam precedents | `apps/web/lib/escalation-kickoff.ts`, `apps/web/lib/ultra-wake.ts` |
| The cost-language projection you reuse | `apps/web/lib/spend-readout.ts` |
| INV-8's header, `kindRendererSlices`, and the residual that is hard rule 10 | `packages/core/test/invariants.test.ts` |
| The design source of truth for layout and density only | `apps/web/lib/demo-gallery/ultra/{session-ultra.tsx, ui.tsx, fixtures.ts}` |
| The tombstone that must survive | `apps/web/lib/demo-gallery/conversation/{shell.tsx,fixtures.validate.test.ts}` |
| Open residuals, named owners, and the five items §3 rules on | `_bmad-output/implementation-artifacts/deferred-work.md` |
| The `~/.telar-dev` hazard your dev proof runs into | `_bmad-output/implementation-artifacts/orchestrator-run-log.md` |
| The four maxims and the repair history behind them | stories `1-1` … `4-1` in this folder |

---

## 9. Dev Agent Record

### Agent Model Used

Claude Opus 5 (`claude-opus-5`), via the `bmad-dev-story` workflow, run autonomously in a single execution on 2026-07-27.

### Debug Log

**Pre-implementation entry, from story creation — a defect in THIS FILE, recorded because it is the third occurrence of one bug in this run and because of what it does to everything downstream.**

**What happened.** While §5.3 item 4 was being written, the mechanism from `apps/web/components/conversation/conversation.tsx` was quoted — the shell scopes a renderer's disclosure key as `` `${item.key}\u0000${key}` `` — and the separator was copied into this file as a **literal NUL byte** rather than as the escape. The file then contained exactly one `\x00`.

**Why that is not cosmetic.** A single NUL makes POSIX `grep` classify the whole file as binary and print `Binary file … matches` instead of the matching lines — or, piped, print nothing at all. This story's §0 citation policy is *"a sentence you cannot re-derive from the tree in one grep is a sentence you must not write."* A story file that greps as binary is a story **whose own citation policy cannot be checked by anyone downstream**, including the review round that exists to check it. It was independently observed: a carry-forward audit over this file came back empty for every search term and only produced results under `grep -a`.

**What was done.** Found by a byte scan at the close of the creation round, immediately before the file was finalised: the NUL sat inside §5.3 item 4, having eaten the symbol name it was standing between. The byte was replaced with the intended prose (the sentence now reads `the `scope()`-prefixed (`item.key`-scoped) `ItemViewState``), and the Change Log's account of the validation round names the same repair.

**Then it happened again, twice, inside this note — and that is the part worth reading.** Writing the paragraph above reintroduced **three** NUL bytes (offsets 182341, 184520, 184646), because the explanation of the bug quoted the separator the same way the original defect did. Repairing those and adding *this* sentence reintroduced **a fourth** (offset 183904), inside the clause explaining how to avoid it. Three repair passes, each verified by byte scan, before the file measured zero. The rule that finally held: write the separator as the **escape** (the six ASCII characters backslash-u-0-0-0-0) or as the word *NUL* — never as the byte, not even inside backticks, not even when the subject of the sentence is the byte itself. This is the same shape as story 3.1's round-2 review, which found a false sentence **inside the fix for the finding about false sentences**, and story 4.1's fix round, which produced a stale tally **inside the fix for the stale-tally finding**. The lesson generalises past NULs: **a paragraph describing a defect is written in the same medium as the defect, so the act of documenting it is itself an opportunity to commit it.** Re-run your check after writing the note, not only after writing the code.

**Verified after the fix, four ways** — measured on the finalised file after the note above was written, not carried:
- `tr -dc '\0' < <file> | wc -c` → **0**
- a Python byte scan for `0x00` → **0 occurrences, no offsets**
- `python3 -c "open(f,'rb').read().decode('utf-8')"` → decodes clean; `file(1)` reports *"Unicode text, UTF-8 text"*
- plain `grep -c` and `grep -ac` return **identical** counts for `Citation policy`, `INV-8b2`, `ultra:run-anchor`, `prove-run` and `spendReadout` — 1 / 19 / 11 / 12 / 10 — which is the only check that actually demonstrates the failure mode is gone rather than that the byte is.

**Why it is written down rather than quietly fixed.** This is the **third** instance in this run: story 1.1 shipped one in `packages/core/src/usage-ledger.ts`; story 1.2's dev agent caught its own in `admission.test.ts` through a T-10 check and fixed it at a named byte offset; this is the third. The common cause is the same every time — **transcribing a raw NUL separator (written `\u0000` in source) out of source code into prose or into a string literal.** `conversation.tsx`'s scope separator and `invariants.test.ts`'s NUL-joined keys are both in this story's reading set, so a dev agent quoting either into a comment, a test title or a Completion Note will reproduce it. **Add a NUL-byte scan to your own close-out check** — `tr -dc '\0' < <path> | wc -c` must print `0` for every file you touch, source and record alike — and if it fires, fix the byte and say so here rather than deleting the evidence.

---

## Implementation entry — every figure below was MEASURED in this session, not carried

### 1. The gate, with V1's asymmetry

Re-measured at `e093a98` BEFORE any edit (the frontmatter's baseline pointer, re-run rather than quoted):

| Workspace | pass | fail | expect() | files |
| --- | --- | --- | --- | --- |
| `packages/core` | 1637 | 0 | 9241 | 109 |
| `apps/web` | 498 | 0 | 2091 | 20 |

After this story, re-measured at the close:

| Workspace | pass | fail | expect() | files |
| --- | --- | --- | --- | --- |
| `packages/core` | **1660** | 0 | **9347** | **110** |
| `apps/web` | **610** | 0 | **2366** | **22** |

`bunx tsc --noEmit` — **clean in BOTH workspaces** (exit 0, no output).

`bun run lint` — **`apps/web` only**, and `packages/core` genuinely has no such script: `bun run lint` there prints `error: Script not found "lint"`. Confirmed by reading `packages/core/package.json` (no `scripts` key at all); `eslint.config.mjs` lives under `apps/web` alone and the repo root has no scripts block either. **No eslint config was authored for `packages/core` — the absence is recorded, not fixed.**

**The lint baseline was measured, not assumed, and not from the working tree.** A detached worktree was created at `e093a98` with `node_modules` symlinked in, `bunx eslint . --format json` run in both trees, and the two results diffed per (file, rule):

| | errors | warnings | total |
| --- | --- | --- | --- |
| baseline `e093a98` | 136 | 28 | **164** |
| after this story | 136 | 27 | **163** |

**Problems this diff ADDED: ZERO.** Problems it REMOVED: one — `@typescript-eslint/no-unused-vars` in `session-view.tsx`, which was the dead `WorkflowIcon` import §5.6-T19 item 1 sends you to consume. It disappeared as a side effect of building the feature, exactly as that item predicted.

Two problems were added and then fixed before the close, and they are recorded rather than hidden: `lib/use-ultra-runs.ts` first shipped an `eslint-disable-next-line react-hooks/set-state-in-effect` whose explanatory text ran onto a SECOND comment line — so the directive applied to that comment, the error still fired, AND eslint additionally reported the directive as unused. Two problems from one mistake. The fix is the bare directive on the line immediately above the call, with the explanation in a block above it, and the file now lints clean.

### 2. The prove-run

Command, exactly as run:

```
TELAR_HOME=$(mktemp -d) bun test packages/core -t "track-d prove-run"
```

Output (`7 pass / 0 fail / 41 expect() calls / Ran 7 tests across 110 files`, 1653 filtered out):

```
[track-d] L1 run u-9545daae568d narrated 8 events and settled done
[track-d] L2 ordinal 0 was visible in-flight (agent-start seen, agent not yet)
[track-d] L3 8 events complete, ordered and deduped by ordinal
[track-d] L4 2 runs for sess-track-d out of 4
[track-d] L5 stopped with ordinals [0,1] journaled
[track-d] L5 resumed: 1 cached replays, agent-start for [0,1,1], ordinals still [0,1]
[track-d] L6 manifest.spend 0.04 == ledgerSpendUsd 0.04; session fold 0.11 == 0.10999999999999999
[track-d] L7 real ~/.telar unchanged (2 entries); 5 run dirs under the sandbox
```

The `mktemp` root is per-invocation; the suite additionally pins its OWN `fs.mkdtempSync` root at module scope regardless, which is what makes the run safe when someone forgets the environment variable.

**Leg by leg: L1 ✅, L2 ✅, L3 ✅, L4 ✅, L5 ✅, L6 ✅, L7 ✅ — all seven.** **L2 — the in-flight ordinal — PASSED**, so §5.5-D6 landed rather than merely compiled.

Two deviations from §6.4's leg list, both deliberate:
- **L6 reads the ledger THROUGH ITS PORT.** §6.4 says "the first-occurrence-per-`entryKey` fold over the sandboxed `usage.ndjson`". Implementing that literally would mean opening `usage.ndjson` by path, and `project-context.md` fixes exactly one writer and one reader path for that file — "**No module opens it by path**". So L6 asserts `manifest.spend === ledgerSpendUsd({ownerKind:"ultra", ownerId})`, which IS that fold read through the port, plus the one-level-up agreement `ultraCostBySession(sid) === Σ ledgerSpendUsd` over that session's runs.
- **L7 does not arm the write-guard in-process.** Track A proves the guard from a CHILD with its own `HOME` and `TELAR_HOME`; re-proving it here would mean assigning a blank `TELAR_HOME` in the shared test process, and `telarDir()` falls back to `os.homedir()/.telar` on a blank value — so the only thing between that assignment and a synthetic billing line in the operator's REAL `~/.telar` is the very guard under test. L7 checks the guard is ARMED and fingerprints the real root before and after; it does not arm the weapon.

L5's first version was a **silent false pass in the making** and is worth recording: its fake blocked on a plain gate and ignored the shared `AbortController`, so `stopUltraRun` returned `true`, the gate released, the agent returned normally and the run reached **`done`** — a Stop leg proving the opposite of its own name. The fake now rejects with an `AbortError` off `o.abort.signal`, which is what the real runner does.

### 3. The named invariant verdicts

Each run by name against `packages/core/test/invariants.test.ts`:

| Invariant | verdict |
| --- | --- |
| `INV-4` (client bundle — this story adds four `"use client"` files) | 5 pass / 0 fail |
| `INV-5b` (`logUsage`'s three call sites — this story adds none) | 1 pass / 0 fail |
| `INV-6a` (`SessionProfile`'s field set — this story adds no field) | 2 pass / 0 fail |
| `INV-7` (no test reaches the real state root) | 6 pass / 0 fail |
| `INV-8a` | 1 pass / 0 fail |
| `INV-8b` | 1 pass / 0 fail |
| **`INV-8b2` (the one this story edited)** | **3 pass / 0 fail** (was 1 test; now 8b2 + 8b2b + 8b2c) |
| `INV-8c` (contexts — this story adds **no** provider; confirmed) | 1 pass / 0 fail |
| `INV-8f` | 1 pass / 0 fail |
| `INV-8g` (`MOVED_OUT_OF_ADAPTER` — `item.kind` never written) | 1 pass / 0 fail |
| `INV-8i` (`ConversationProps` is nine names) | 1 pass / 0 fail |
| `INV-9` | 6 pass / 0 fail |
| **`INV-10` (new)** | **6 pass / 0 fail** |

Whole file: **79 pass / 0 fail / 436 expect()** (was 71 / 0 / 397).

**INV-7 FIRED during implementation and was fixed by injecting, never by exempting.** It named `apps/web/lib/session-prompts.test.ts:393` — a `steererAppendix({ ultraAnnotated: false, provider })` this story added with no `read:` injection. Its live branch was unreachable (no `loomId`), but INV-7 scans BY NAME and the discipline binds regardless; the call now injects `read`, which is inert with no `loomId`. Two tests were red (`INV-7b`, `INV-7c`) until it was.

**The two gallery tombstone tests, by title** — `apps/web/lib/demo-gallery/conversation/fixtures.validate.test.ts -t "tombstone"` → **2 pass / 0 fail / 7 expect()**, 16 filtered out. That file was **read only and never edited**. `ultra:run-anchor` is registered in `SESSION_KINDS` and is **not** in `GALLERY_KINDS`; `INV-10b` now makes that mechanical.

**The `effort` pin, by name** — `ultra-executor.test.ts -t "opts mapping"` → **1 pass / 0 fail**. `expect("effort" in seen[0]!).toBe(false)` still holds: `effort` rides the EVENT and still never reaches `engineOpts`.

### 4. The dev-server proof

**FIRST LINE, as §7.2 requires, before anything else:**

```
$ ls apps/web/node_modules/@anthropic-ai/
claude-agent-sdk
```

**The `darwin-arm64` sibling is STILL ABSENT** (it sits unlinked in the bun store at `node_modules/.bun/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.204/`). Story 4.1's environment note is OPEN and unowned. **This story did not stop at the `ls` — it drove the engine to say so in its own words.** A real run launched through `POST /api/ultra` wrote this onto `events.ndjson`:

```
log: scout could not run: Native CLI binary for darwin-arm64 not found. Reinstall
     @anthropic-ai/claude-agent-sdk without --omit=optional, or set
     options.pathToClaudeCodeExecutable.
```

**Consequence, stated plainly and not papered over: NO MODEL TURN IS POSSIBLE IN THIS CHECKOUT.** Therefore **the rendered anchor and the armed chip were NOT OBSERVED**, and neither was the wake turn — there is no chip → `ultra` tool call, no `mcp__ultra__ultra` tool part, and so no anchor splice to look at. §7.2's sanctioned fallback was taken: runs were launched directly with `POST /api/ultra` (project **slug** `wake-proof`, never a manifest path), and the anchor splice and the chip's arm state are proved by their pure functions in `ultra-runs.test.ts`.

**`TELAR_HOME`, confirmed before starting rather than assumed.** `apps/web/package.json`'s `dev` script is `TELAR_HOME="${TELAR_HOME:-$HOME/.telar-dev}" next dev`. The server resolved **`~/.telar-dev`**. The real `~/.telar` was never read or written at any point in this story.

**What was found in `~/.telar-dev` before starting, and what was done about it.** Five run directories, exactly as `orchestrator-run-log.md` records: `u-534fd3ef96f8` (done), `u-ce023fe79cb5` (failed), `u-devproof-crashed` (stopped, spend 1.25), `u-fixround-a` (done, spend 0.25), and `u-fixround-bad` — whose manifest is `{ "sessionId": "nobody", "state": "running", "startedAt": …, "updatedAt": … }` with **no `runId`, no `meta`, no `spend`**.

**It was actively poisoning the root, and that was MEASURED rather than inferred.** With it in place:

```
GET /api/ultra                                   -> 200  {"runs":[]}     (five run dirs on disk)
GET /api/ultra/wakes?sessionId=devproof-session-1 -> 200  {"pending":[],"live":0}
```

Both **HTTP 200 with a silently empty body** — `listUltraRuns()` threw and the guards degraded. **That is this story's `GET /api/ultra` guard firing on its first contact with production data**, and before this story that route was unwrapped and would have returned a 500 instead. It is also live evidence that the two `saveManifest` deferred items are real.

**It was MOVED, not deleted** — to `…/scratchpad/quarantine/u-fixround-bad`, so the operator can restore it. Afterwards:

```
GET /api/ultra -> 4 runs, each with a server-rendered `name`:
  u-fixround-a       | 'fix round ack proof'         | done    | spend 0.25
  u-534fd3ef96f8     | 'wake proof done'             | done    | spend 0
  u-ce023fe79cb5     | 'wake proof sweep'            | failed  | spend 0
  u-devproof-crashed | 'killed by a server restart'  | stopped | spend 1.25
```

**Which observations the poisoned root invalidates: none of the ones below**, because every one of them was taken AFTER the quarantine. The pre-quarantine readings are themselves recorded above as the guard's proof.

**C1's required by-hand envelope observation.** `curl -s localhost:3000/api/ultra` after the change is shown above. **The "before" could not be captured as a live reading**, because the change was already in the tree when the dev server first came up and the baseline worktree had no dev server — that is stated rather than fabricated. What IS measured is the mechanism the "before/after" was for: `filterRunsBySession(runs, undefined)` returns the input unchanged (same reference, same order, same length), asserted in `ultra-runs.test.ts`, and the `{ runs }` envelope is unchanged. The one additive difference is the `name` field on each row.

**The `?sessionId=` filter, observed:**

```
?sessionId=devproof-session-1 -> 3 runs
?sessionId=fixround-session-1 -> 1 run
?sessionId=nope               -> 0 runs
?sessionId=            (empty)-> 0 runs     <- defined-and-equal, never truthy
(no parameter)                -> 4 runs
```

**The two new routes, observed:**

```
GET /api/ultra/u-d8d86a7a5c49/script  -> 200  {"script":"export const meta = { name: \"dev proof sweep\"…"}
GET /api/ultra/u-fixround-a/script    -> 404  {"error":"No script on disk for run \"u-fixround-a\"."}
GET /api/ultra/u-fixround-a/agents    -> 200  {"agents":[]}
GET /api/ultra/u-does-not-exist/agents-> 200  {"agents":[]}     <- empty, never 404
```

**The launch, and `agent-start` on a REAL stream.** `POST /api/ultra` returned `{"runId":"u-d8d86a7a5c49","meta":{…}}`, and `events.ndjson` held:

```
phase       {'title': 'Scan'}
log         {'msg': 'scanning the tree'}
agent-start {'ordinal': 0, 'label': 'scout', 'model': 'sonnet', 'effort': 'high'}
log         {'msg': 'scout could not run: Native CLI binary for darwin-arm64 not found…'}
phase       {'title': 'Rank'}
log         {'msg': 'ranking what we found'}
state       {'state': 'done'}
```

**`agent-start` is live in production code with its `label` and its `effort`**, from a real HTTP launch. Note there is **no `agent` settle event** — the call threw, so the ordinal began and never settled, and `agents` returned `[]` because no engine event ever streamed and no `agents/0.ndjson` was created. That is precisely the distinction `agent-start` exists to express.

**The SSE frame names, observed on `/api/ultra/[id]/events`:** `event: run` carrying the **bare `UltraManifest`** — and it carries **no `name` field**, which is §5.5-D5a's measured reason for the four-line label copy, seen live — then `event: ev` per `UltraEvent` (including `agent-start`), then `end`.

**Stop (§5.6-T9), observed:** `POST /api/ultra/u-d8d86a7a5c49/stop` → **`{"ok":false}` with HTTP 200**, and the manifest stayed `done`. `{"ok": false}` really is the normal answer, not an error.

**Resume (§5.6-T10), observed:** `POST /api/ultra/u-d8d86a7a5c49/resume` on a **`done`** run → **HTTP 200, and it really re-ran.** Core does **not** gate resume on state, so "no Resume on `done`" is confirmed to be a UI rule and nothing else. The resumed stream re-emitted the **whole phase sequence** (`phase Scan`, `agent-start 0`, `phase Rank`) — which is §5.6-T5's idempotency requirement meeting a real stream, and `phaseGroups` is asserted idempotent over exactly that shape.

**Two concurrent runs, observed:** `concurrent alpha` and `concurrent beta` launched back-to-back into one session; `GET /api/ultra?sessionId=devproof-session-1` returned **6 rows, newest-first**, each with its own server-rendered name. Neither stream interfered with the other. (Anchors stacking in the transcript is the half that needs a model turn and was not observed; `spliceRunAnchors` proves the two-launch case as a pure function, with a one-run anti-vacuity control.)

**The session page, observed:** `/projects/wake-proof/sessions/new` → **HTTP 200, 80565 bytes**; the same URL with **`?run=u-d8d86a7a5c49`** → **HTTP 200, 80670 bytes**. The `?run=` param is accepted and threaded (the page grew by the prop). The composer chip's `Ultra` label **is present in the server HTML** on the Claude branch — so the chip renders; **arming it was not observed**, because that needs a click and a browser.

**The dock signal — the honest result.** `GET /api/chats` returns **`{"chats":[]}`** against this root: no model turn has ever been possible here, so no chat was ever persisted. `ultra-dock-signal.tsx` correctly **skips** a session id with no matching chat row rather than docking it with a placeholder title (AC7 proof 2's rule) — so with zero chats it correctly docked nothing. **The code path was exercised and took its designed branch; the POSITIVE case — a head appearing for a session the user never docked — could NOT be reached in this checkout.** Neither could the tap, nor focus-on-arrival.

**Rendering claims that a browser would be needed for, and which are therefore NOT claimed here:** that the anchor's rendered height does not change while running; that the narrator window scrolls without moving anything around it; that the rail's Workflows section appears; that the chip visibly disarms; that the dock head appears and that tapping it lands on the focused run. §6.2 already assigns those to the dev server, and the dev server cannot produce them without a model turn. **No test in this story is claimed to cover them.**

### 5. The five AC11 rulings, restated with what actually shipped

1. **`effort` — SOURCED.** Optional field on the `agent` **and** the new `agent-start` variants (`packages/core/src/ultra/executor.ts`). The rail's chip renders `model·effort` when present and `model` alone when not; both directions are tested. **It still does not reach `engineOpts`** — the pre-existing pin was re-run by name (1 pass) and a NEW test re-makes it beside the positive claim, so the two halves of the contract sit in one place.
2. **live agent rows — SOURCED.** `agent-start` plus `GET /api/ultra/[id]/agents`. Proved three ways: a unit test (`an ordinal that has STARTED but not settled is a row`), a core test (`listUltraAgentOrdinals sees an ordinal BEFORE it settles`), and prove-run **L2**. Observed live on the dev server.
3. **agents `total` — NOT SOURCED, NOT INVENTED.** `RunSnapshot.agentsTotal` is **typed `undefined`** — the type itself refuses the denominator. The anchor renders `N done` with no denominator, running and terminal alike; asserted for both.
4. **the progress sliver — SOURCED FROM PHASES ONLY.** Numerator = distinct `phase` titles seen; denominator = `meta.phases.length`, read **only** when it is an array of strings. Absent, empty, a number (`phases: 3`), or an array of objects all yield `undefined`, and **undefined renders NO sliver** — not an indeterminate bar, not a pulse. Five separate tests.
5. **per-agent `tokens` — NOT SOURCED, NOT INVENTED.** `AgentRow` **has no `tokens` field**, asserted on the KEY (`expect("tokens" in row).toBe(false)`) for both a live and a settled row. The row renders cost only, and nothing where a live agent has no cost yet.

### 6. The out-of-Owns rows, with the line counts actually produced

`WORK-SPLIT.md`'s Track D Owns column is `apps/web/lib/ultra-mcp.ts`, ultra owner-adapter pieces, `ultra/` subtree.

**Inside Owns** (disclosed for completeness): `apps/web/lib/ultra-mcp.ts` (+15/−41 net −26 — the description shrank), `packages/core/src/ultra/executor.ts` (+60), `packages/core/src/ultra/storage.ts` (+36), and every new `lib/ultra-*`/`app/api/ultra/**` file.

**`packages/core/src/ultra/executor.ts` is inside Owns but widens a DIFFERENT fence** — `SPEC.md`'s non-goal "Rebuilding U1–U5 engine, tools, routes, or storage". +60 lines: one new `UltraEvent` variant, one optional field on an existing variant, one emit site, and their doc comments. Nothing else in `packages/core/src/ultra/` was written.

**The eight rows outside the literal Owns string, each deliberate and disclosed, with measured diffstat:**

| File | Δ lines | Why |
| --- | --- | --- |
| `apps/web/components/session/session-view.tsx` | +302/−… (302 changed) | hard rule 2 — the dispatch note's seam does not exist |
| `apps/web/components/session/subagent-rail.tsx` | 56 | the "rail section" seam is a component with seven props |
| `apps/web/components/dock/dock-provider.tsx` | 18 | FR-UW-6 has no other home |
| `apps/web/components/dock/dock.tsx` | 44 | as above |
| `apps/web/app/layout.tsx` | 6 | as above |
| `apps/web/lib/session-prompts.ts` | 63 | the appendix is the only per-turn channel |
| `apps/web/lib/session-profiles.ts` | 18 | `ctx.provider` exists nowhere else |
| `apps/web/lib/session-prompts.test.ts` + `packages/core/test/invariants.test.ts` | 80 / 421 | declared here rather than left implicit |

**A NINTH ROW, NOT IN §0.2's TABLE, disclosed as a widening rather than slipped in:** `apps/web/app/projects/[name]/sessions/[id]/page.tsx` (24 lines). §5.5-G5 offers two shapes for the `?run=` param and says of shape (b) *"if you take it, add that page to your write set and disclose it as a sixth widening"*. **Shape (b) was taken**, and the reason is measured rather than stylistic: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` states that on a prerendered route `useSearchParams` forces the client tree up to the nearest Suspense boundary to be client-rendered and recommends a `<Suspense>` wrapper. This page is `dynamic = "force-dynamic"` so it is not prerendered **today** — which makes the constraint a property of a route-segment config someone could change, enforced at `next build`, which this repo's gate does not run. Threading the value costs one optional key on a `searchParams` type the page already awaits and cannot break a build.

**`session-profiles.test.ts` (74 lines) is a tenth file not named in §0.2's table** — §0.2 lists it under Track B's widenings in prose but the table row says only what it asserts. Disclosed.

**The `export` on `ULTRA_TOOL_DESCRIPTION`** — one word, added so `ultra-mcp.test.ts` can pin AC6 proof 5's two substrings BY IDENTIFIER rather than through `instance._registeredTools[…].description`, the SDK private the file already reaches through once. `grep -n "^export" apps/web/lib/ultra-mcp.ts` now returns four names (was three).

### 6b. The TEN `session-view.tsx` expressions, against what actually changed — **it is ELEVEN, and here is the eleventh**

| # | §5.5-D1 says | What shipped |
| --- | --- | --- |
| 1 | `SESSION_KINDS` gains `ultraRunAnchorKind` | ✅ one array element |
| 2 | the TURN's item list passes through `spliceRunAnchors` | ✅ wrapping the `items:` expression inside `messages.map`, **not** `transcriptItems` |
| 3 | `useUltraRuns(sessionId)` called, feeding 2/4/composer | ✅ one hook call + the payload map, the pending factory, `openRunId`, `ultraBusyRunId` and `ultraAct` |
| 4 | the `rail={…}` condition widens; `workflows`/`workflowCount` passed | ✅ `railAgents.length > 0 \|\| ultraRunList.length > 0` |
| 5 | `PromptInputTools` gains the chip | ✅ one element + one `useState<ArmState>` |
| 6 | `send`'s options widen; the body literal gains `...(opts?.ultra ? …)` | ✅ read off `opts`, never off component state |
| 7 | `messageQueue`'s item type gains `ultra?`; the drain threads it | ✅ and the **injection drain is untouched**, pinned statically |
| 8 | the auto-dock guard widens | ✅ `!s.busy` → `(!s.busy && ultraLiveRef.current === 0)` |
| 9 | the `run` param is read and cleared | ✅ one `useEffect`, depending on the param and never `[]` |
| 10 | `openRunId` lives here | ✅ `useState<string \| null>(null)`, not on `activeTab` |
| **11** | **— not in the list —** | **`ultraLiveRef`, and it is a mechanical necessity rather than a scope creep.** Item 8 needs the live-run count inside the unmount cleanup, and `leaveRef.current` is assigned near the TOP of the component while `ultraLiveCount` is derived from the hook further down — reading it there is a temporal-dead-zone throw on every render. It is a one-line `useRef(0)` declared beside the guard and assigned at the hook's own site. **It is eleven, and this row says eleven.** |

### 7. The T12 finding

`session-view.tsx` forces `setActiveTab("main")` on every `"permission"` event, and **this story changed nothing about it**. The decision: **it cannot reach the Workflows view**, because the selected run lives in its own `openRunId` state rather than on `activeTab` (§5.5-D1 item 10 — `activeTab` is simultaneously the rail's `activeId` and the transcript's bucket selector, so a runId in it would silently change what the transcript renders). A permission event returns the transcript to Main and leaves the expanded run card expanded, because the Workflows section lives inside the rail's own column rather than behind a tab.

**This was reasoned from the code and NOT observed at the dev server** — no model turn is possible, so no permission event could be provoked. Recorded in `deferred-work.md` with that caveat.

### 8. The wake regression check (T18)

**The wake TURN could not be observed** — it needs a model turn, and none is possible. **What WAS observed is the durable half its guarantee actually rests on**, after this story's change to the stream `wake.ts` reads:

```
GET /api/ultra/wakes?sessionId=devproof-session-1
-> live: 0   pending: 6
   u-610965beb3d5 | 'concurrent beta'            | done    | spend 0
   u-5f0194385c42 | 'concurrent alpha'           | done    | spend 0
   u-d8d86a7a5c49 | 'dev proof sweep'            | done    | spend 0
   u-devproof-crashed | 'killed by a server restart' | stopped | spend 1.25
   u-534fd3ef96f8 | 'wake proof done'            | done    | spend 0
   u-ce023fe79cb5 | 'wake proof sweep'           | failed  | spend 0
```

**All three runs this story's dev proof launched are in the mailbox**, so the terminal publish path survives `agent-start` joining the stream — which is what §5.5-D7 predicted by construction (`storage.ts`'s `onEvent` appends unconditionally and only then branches on `e.type === "agent"`; that branch is untouched). D7's other half — that `ultra_status`'s rollup is **byte-identical** with and without `agent-start` interleaved — is asserted in `apps/web/lib/ultra-mcp.test.ts`, which is the only workspace that can make the claim.

### 9. What was recorded in `deferred-work.md`

A new section, `Deferred from: 4-2-…`, carrying: the **six** rulings §3 requires (re-derived with `awk 'NR>=129' … | grep -n '4\.2'` → six hits at absolute lines 135/137/143/162/163/172, plus 3.1's item at line 98); the **INV-8b2 residual with all three previously-undocumented shapes**, which was in-source and in the run log but **not** in `deferred-work.md` before this story; the `human-facing` delivery class still exercised by no production event; the tone-token lifting item joining 3.1's `NH-11`; three shipped-signature refinements against §5.5-D3a (the splice's third argument, `DockRunSummary.state`, `filterRunsBySession`'s generic); the T12 ruling; the environment note re-measured from the running server; and what was found, moved and left in `~/.telar-dev`.

### 10. The NUL-byte scan — **IT FIRED, on the fourth occurrence in this run**

The create stage's instruction was followed: `tr -dc '\0' < FILE | wc -c` over **every** file this story created or modified, source and record alike.

**The first run of that scan was itself broken and reported a false ALL ZERO.** It used `for f in $FILES` in zsh, which does **not** word-split an unquoted parameter — so it scanned one 2000-character "filename", got one `0`, and printed a clean verdict. Rewritten to iterate `git status --short` line by line, the same scan over **33 files** found:

```
1    apps/web/components/session/ultra-rail.tsx
```

**Offset 10544, line 249, column 42**, inside `key={group.title || "<NUL>unphased"}` — a literal NUL where a space was intended, in exactly the transcription shape the create stage's note predicted. This is the **fourth** occurrence in this run (story 1.1's `usage-ledger.ts`, story 1.2's `admission.test.ts`, this story file's own §5.3, and now this).

The repair does not re-use a separator at all: the key is now `` `phase:${group.title}` ``, which also fixes a latent collision (a real phase titled `unphased` would have shared the fallback key). Re-scanned after the fix: **33 files, every one `0`**. `grep`/`grep -a` counts are now **identical** on the repaired file for `Narrator` (2/2), `ScriptTab` (2/2) and `phase:` (1/1), and `file(1)` reports *"Java source, Unicode text, UTF-8 text"* — that parity check, not the byte count, is what demonstrates the failure mode is gone.

**The lesson, restated because this run keeps paying for it:** the scan is only worth what its own mechanics are worth. A byte scan that cannot fail is worse than no byte scan, and this one could not fail until it was rewritten.

### Completion Notes

**Status: every AC has an implementation and a proof, and the two things that could not be PROVED are named rather than implied.** The full gate is green in both workspaces (`packages/core` 1660/0, `apps/web` 610/0, `tsc` clean in both, `apps/web` lint 163 problems against a 164 baseline with **zero added**), and the Track D prove-run passes all seven legs including L2, the one that proves the executor change landed rather than merely compiled.

**What shipped, in one paragraph.** A pure projection layer (`lib/ultra-runs.ts`) that refuses to invent data; two additive engine fields (`agent-start`, `effort`) that give the frozen rail contract a data source at all; three route additions (a session filter, an agent index, the script's bytes); a registered `ultra:run-anchor` item kind whose renderer is inline in a file INV-8b2 now actually scans; a Workflows section inside the existing sub-agent rail; a composer chip that arms exactly one message; an app-wide dock poller; a script-authoring reference that TAKES OVER from the tool description rather than duplicating it; and two new executable invariants (a widened INV-8b2 with three tests where there was one, and INV-10).

---

#### The five AC11 rulings — stated again so a later reader finds them in one grep

1. **`effort` — SOURCED**, on the `agent` and `agent-start` events. **It still does not reach `engineOpts`**; the existing pin was re-run by name and a new test re-makes it beside the positive claim.
2. **live agent rows — SOURCED**, by `agent-start` + `GET /api/ultra/[id]/agents`. Proved by unit test, by core test, by prove-run L2, and observed on the dev server.
3. **agents `total` — NOT SOURCED AND NOT INVENTED.** `RunSnapshot.agentsTotal` is **typed `undefined`**: the type itself refuses the denominator. The anchor renders `N done`, running and terminal alike.
4. **the progress sliver — SOURCED FROM PHASES, NEVER FROM AGENTS OR MONEY.** `meta.phases.length` as denominator, read only when it is an array of strings; absent/empty/`3`/`[{…}]` all yield `undefined`, and **undefined renders no sliver at all**.
5. **per-agent `tokens` — NOT SOURCED AND NOT INVENTED.** `AgentRow` has **no `tokens` field**; asserted on the key.

#### The out-of-Owns rows, with real line counts

Nine rows plus `executor.ts`'s SPEC-non-goal widening — the full table with measured diffstat is in the Debug Log §6, and it names a **ninth** row §0.2's table did not: `app/projects/[name]/sessions/[id]/page.tsx` (24 lines), taken deliberately under §5.5-G5 shape (b) because `useSearchParams` carries a prerender/Suspense constraint enforced at `next build`, which this repo's gate does not run. `session-profiles.test.ts` (74 lines) is a tenth. Both are disclosed rather than slipped in.

#### The `session-view.tsx` expressions: **it is ELEVEN, not ten, and the eleventh is named**

The eleventh is `ultraLiveRef` — a one-line `useRef(0)`. Item 8's unmount guard needs the live-run count, `leaveRef.current` is assigned near the top of the component, and `ultraLiveCount` is derived from the hook further down, so reading it there is a temporal-dead-zone throw on every render. Full table in Debug Log §6b. **If it is eleven, say eleven.**

#### The T12 decision

A permission event's `setActiveTab("main")` **cannot reach the Workflows view**, because the selected run lives in its own `openRunId` state rather than on `activeTab` — which is exactly what §5.5-D1 item 10 asked for and why. **Reasoned from the code, NOT observed**, because provoking a permission event needs a model turn. Recorded in `deferred-work.md` with that caveat.

#### The wake regression check

The wake TURN could not be observed (no model turn is possible). The durable half its guarantee rests on WAS: after this story's change to the stream `wake.ts` reads, `GET /api/ultra/wakes` returned **6 pending, including all three runs this story's dev proof launched**. D7's other half — `ultra_status`'s rollup byte-identical with and without `agent-start` — is asserted in `ultra-mcp.test.ts`, the only workspace that can make the claim.

#### Deviations, refinements and judgements — every one disclosed

- **`spliceRunAnchors` takes a THIRD optional argument** §5.5-D3a does not name. D3a pins two arguments; D8 separately requires the pending form for a launch whose manifest has not arrived. Both cannot hold with two arguments, because the map is keyed by runId and the splice is the only thing that DISCOVERS a runId. The third is an optional `pending?: (runId) => UltraAnchorPayload` supplied in the same wrapping call, so `session-view.tsx` still spends one expression. Both arities tested.
- **`DockRunSummary` carries a `state` field** D3a does not name, because AC7 proof 4 requires `name · state · spend` and D3a's shape has nowhere for it.
- **`filterRunsBySession` is generic** over `{ sessionId?: string }` rather than over `RunSnapshot`, so the route (which filters `UltraManifest[]`) and the rail share one tested rule. That is the whole mechanism by which a route with no test harness in this repo is proved at all.
- **D14's INV-10c as specified was FALSE against the tree and was narrowed.** §5.5-D14 says INV-10c should assert `components/conversation/**` "contains no file mentioning `ultra` at all". It fails on a correct tree: `registry.ts`'s `MODULE_NAMESPACES` has contained the literal `"ultra"` since story 3.1, and **that entry is the reason `ultra:run-anchor` is legal with no contract change**. The arm now forbids what AD-12 actually forbids — the kind, its payload, its projection — and separately ASSERTS the vocabulary entry is present, because if `"ultra"` ever left that list `createItemKindRegistry` would throw at module scope and the whole session surface would fail to construct. Writing the loose version would have meant relaxing a guard until it passed, which is how a guard becomes decoration.
- **AC9's budget scan strips comments before matching, and the first version did not.** Counting comments reported all four files — on sentences that SAY the product has no ceiling and no meter. A rule that forbids documenting itself is a rule that gets documented somewhere the scan cannot see. The carve-out is exercised in both directions (`// no ceiling` is clean, `const ceiling = 10` is reported) and the stripper is asserted not to eat a URL's `//`.
- **The `ULTRA_TOOL_DESCRIPTION` split is a NET REMOVAL from the tool schema.** It keeps what decides whether the CALL is legal (opt-in rule, non-blocking contract, script format, the model requirement, the determinism bans) and drops the surface walk-through, the quality patterns and the worked example. **Re-derived before and after**, as AC8 proof 3 demands: `grep -rn "loop-until-dry\|adversarial-verify" apps packages --include="*.ts" --include="*.tsx"` (excluding `.next` and the demo-gallery mockup) found **one production string before** (`ultra-mcp.ts:103`) and **two in the shipped reference after** (`ultra-authoring.ts`, plus its test). The demo gallery's six mockup hits are unchanged. **The two named patterns are still in the product**; had the reference not carried them, this story would have removed them.
- **`session-prompts.test.ts` lost ZERO assertions, and that number was measured rather than predicted.** §5.5-D12 warns that the change "breaks all of them at once" and that two careful readers disagreed on the count. Making `provider` **optional with absent ⇒ no reference** meant every pre-existing exact-equality assertion stayed byte-for-byte true. **Exactly ONE assertion in the whole tree broke** — `session-profiles.test.ts`'s *"a plain project session with the Ultra chip OFF has an EMPTY appendix"* — and it was updated the way story 4.1 updated the two it inverted: the old expectation is carried, with the reason it was right (2.2's migration had to change no behaviour), the reason it is wrong now (AC8 injects the reference on Claude deliberately), and **the half that did not change** — the property survives unchanged on **Codex**, which is now what that test pins.
- **`INV-7` fired on this story's own new code and was fixed by injecting, never by exempting.** Details in Debug Log §3.
- **`u-fixround-bad` was MOVED, not deleted.** It is operator data in a dev root and the operator is asleep; moving it to a scratchpad quarantine is reversible and the path is recorded. It was measurably poisoning the root — with it in place `GET /api/ultra` returned `{"runs":[]}` against five run directories — which incidentally made it a free live fixture for §5.6-T8's guard.
- **`KNOWN_VIOLATIONS` did not grow.** It is still exactly one entry; `INV-10e` now pins that INV-10 contributed none, in the shape `INV-7f`/`INV-8h`/`INV-9e` already use.
- **No new declared bus event, no new React context, no new field on `SessionProfile`, no fourth cost formatter, no `bunfig.toml` edit, no `KNOWN_VIOLATIONS` entry, no DOM harness.** `INV-9`, `INV-8c`, `INV-6a`, `INV-5b` all re-run by name and green.
- **Three recorded `session-view.tsx` cleanups were declined**, as §3 requires: the `SessionView` → `ProjectSessionView` rename (pinned by `INV-8g`), `handoffDismissed`, and the duplicated prop type. The dead `WorkflowIcon` import was **not** on that list and was resolved by consuming it, which is why lint went down rather than up.

#### What this story did NOT prove, said plainly

**The rendered anchor and the armed chip were not observed.** Neither was the rail's Workflows section rendering, the narrator window scrolling, the terminal collapse, the dock head appearing for an undocked session, or the tap landing focused. All of them need a live model turn or a browser, and **no live model turn is possible in this checkout** — `apps/web/node_modules/@anthropic-ai/` holds `claude-agent-sdk` alone, and the engine said so in its own words on a real run's `events.ndjson`. That is story 4.1's OPEN, unowned environment note, re-measured. Everything not requiring a model was observed and is transcribed in the Debug Log.

**A fresh-context adversarial pass over this story's own output was NOT run**, deliberately: this run is budget-constrained to a single small workflow, which was spent on reconnaissance. The orchestrator's separate review stage is where that belongs, and these notes are written to be checkable rather than to be believed.

---

## 10. File List

Measured at the close from `git status --short` and `git diff --stat HEAD` — **not** copied from §0.2's table. `_bmad-output/implementation-artifacts/orchestrator-run-log.md` shows as modified in the working tree but was **not** touched by this story and is **deliberately excluded from the commit** (it belongs to the orchestrator).

**NEW (11 files, 3749 lines):**

| Path | lines |
| --- | --- |
| `apps/web/lib/ultra-runs.ts` | 651 |
| `apps/web/lib/ultra-runs.test.ts` | 979 |
| `apps/web/lib/ultra-authoring.ts` | 156 |
| `apps/web/lib/ultra-authoring.test.ts` | 141 |
| `apps/web/lib/use-ultra-runs.ts` | 263 |
| `apps/web/components/session/ultra-anchor.tsx` | 280 |
| `apps/web/components/session/ultra-rail.tsx` | 530 |
| `apps/web/components/common/ultra-dock-signal.tsx` | 199 |
| `apps/web/app/api/ultra/[id]/agents/route.ts` | 76 |
| `apps/web/app/api/ultra/[id]/script/route.ts` | 34 |
| `packages/core/test/track-d-prove-run.test.ts` | 440 |

**MODIFIED (20 files):**

| Path | Δ |
| --- | --- |
| `packages/core/src/ultra/executor.ts` | 60 |
| `packages/core/src/ultra/storage.ts` | 36 |
| `packages/core/test/invariants.test.ts` | 421 |
| `packages/core/test/ultra-executor.test.ts` | 116 |
| `packages/core/test/ultra-storage.test.ts` | 106 |
| `apps/web/app/api/ultra/route.ts` | 62 |
| `apps/web/app/layout.tsx` | 6 |
| `apps/web/app/projects/[name]/sessions/[id]/page.tsx` | 24 |
| `apps/web/components/dock/dock-provider.tsx` | 18 |
| `apps/web/components/dock/dock.tsx` | 44 |
| `apps/web/components/session/session-view.tsx` | 302 |
| `apps/web/components/session/subagent-rail.tsx` | 56 |
| `apps/web/lib/session-profiles.ts` | 18 |
| `apps/web/lib/session-profiles.test.ts` | 74 |
| `apps/web/lib/session-prompts.ts` | 63 |
| `apps/web/lib/session-prompts.test.ts` | 80 |
| `apps/web/lib/ultra-mcp.ts` | 55 (net **−26** — the description shrank) |
| `apps/web/lib/ultra-mcp.test.ts` | 120 |
| `_bmad-output/implementation-artifacts/deferred-work.md` | 41 |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | 8 |

Plus this story file (§4 checkboxes, §9, §10, §11, and the frontmatter `status`).

**READ ONLY, deliberately unedited:** `apps/web/lib/demo-gallery/**` (including `conversation/fixtures.validate.test.ts`, re-run by name as hard rule 4's proof), `apps/web/components/conversation/**`, `apps/web/app/api/chat/**`, `packages/core/src/ultra/{sandbox,runner,journal,surface,wake,events}.ts`, `packages/core/src/event-bus.ts`, `bunfig.toml`.

**Total diff: 31 files, 1737 insertions, 80 deletions** (excluding the story file and the untracked new files, which `git diff --stat HEAD` does not count).

---

## 11. Change Log

| Date | Change |
| --- | --- |
| 2026-07-27 | Story created. Baseline **measured, not carried**, at `e093a98`: `packages/core` 1637 pass / 0 fail / 9241 expect() / 109 files; `apps/web` 498 pass / 0 fail / 2091 expect() / 20 files. |
| 2026-07-27 | **Adversarial validation round, six independent fresh-context auditors over the finished file** (false sentences · AC coverage · write set and scope · implementability · regressions · LLM consumption). They returned findings the first draft would have cost review rounds for, and all of them are folded in above rather than appended. The ones that changed the *design* rather than the prose: the splice was aimed at `transcriptItems`, which never contains a `conversation:tools` item, so it would have been a permanent silent no-op (§5.5-D1 item 2); expression 6 read the chip off component state inside a body literal shared with story 4.1's **hidden wake turn**, which would have annotated a turn with no user message (§5.5-D1 item 6); `ultraRunLabel` is a core **value** export and the SSE frames carry no `name`, so the label needed §5.5-D5a rather than a call INV-4c fails on; `spendReadout` wants a pair and `manifest.spend` is a scalar with no tokens anywhere on the path (§5.5-D6a); the dock signal could only ever have polled sessions already docked, which is the opposite of the case AC7 exists for (AC7 proofs 1–2); `bun run lint` **does not exist in `packages/core`**, so Leg V1 as first written could only have been satisfied by fabricating output; and AC8's `compileScript` proof was vacuified by a process-global mock under the very run shape hard rule 6 mandates. Two clauses of the frozen `ui-contract.md` — the anchor's click-to-focus and the agent row's click-to-open — had no AC at all, and the epic's own dispatch-note requirement for the authoring reference (steer scripts away from long-lived Bash processes) was absent entirely. Five measured numbers did not re-derive and are now either corrected or converted to instructions to re-derive; a stray NUL byte had eaten a symbol name in §5.3. **The seventeen-vs-twenty-two-vs-fourteen disagreement between two auditors over one assertion count is left in the file as a disagreement**, because that is the honest state and maxim 2 is what it exists to teach. |
| 2026-07-27 | **Implemented, in one autonomous execution.** Baseline **re-measured, not carried**, at `e093a98`: `packages/core` 1637 pass / 0 fail / 9241 expect() / 109 files; `apps/web` 498 / 0 / 2091 / 20 — matching the frontmatter pointer. At the close: `packages/core` **1660 / 0 / 9347 / 110**; `apps/web` **610 / 0 / 2366 / 22**; `bunx tsc --noEmit` clean in both; `apps/web` lint **163 problems against a measured 164 baseline — zero added, one removed** (the dead `WorkflowIcon` import, consumed by the feature). The Track D prove-run passes **all seven legs**, including L2, the one that proves the executor change landed rather than compiled. |
| 2026-07-27 | **Three specification defects were found by implementing against them, and each was fixed rather than worked around.** (i) §5.5-D14's INV-10c as written — *"`components/conversation/**` contains no file mentioning `ultra` at all"* — is **FALSE against a correct tree**: `registry.ts`'s `MODULE_NAMESPACES` has held the literal `"ultra"` since story 3.1, and that entry is precisely why `ultra:run-anchor` needs no contract change. The arm was narrowed to what AD-12 actually forbids and now additionally ASSERTS the vocabulary entry is present. (ii) §5.5-D3a's two-argument `spliceRunAnchors` cannot satisfy D8's pending form, because the map is keyed by runId and the splice is the only thing that discovers one; a third optional argument closes it without costing a `session-view.tsx` expression. (iii) §6.4's L6 as written would have opened `usage.ndjson` by path, which `project-context.md` forbids outright; it reads the same fold through `ledgerSpendUsd` instead. |
| 2026-07-27 | **A NUL byte was shipped into `ultra-rail.tsx` and caught by the close-out scan — the FOURTH occurrence in this run.** Offset 10544, line 249, inside `key={group.title \|\| "<NUL>unphased"}`. Worse, **the first run of that scan reported a false ALL ZERO**: it used `for f in $FILES` in zsh, which does not word-split an unquoted parameter, so it scanned one 2000-character "filename". Rewritten to iterate `git status` line by line it found the byte immediately. The repair uses no separator at all (`` `phase:${group.title}` ``), which also removes a latent key collision. All 33 touched files now read 0, and `grep`/`grep -a` counts are identical on the repaired file — that parity, not the byte count, is what shows the failure mode is gone. **The lesson this run keeps re-paying for: a scan is worth only what its own mechanics are worth.** |
| 2026-07-27 | **The dev proof is PARTIAL and says so.** `ls apps/web/node_modules/@anthropic-ai/` still returns `claude-agent-sdk` alone, and this story drove the engine to confirm it on a real run's `events.ndjson`: *"Native CLI binary for darwin-arm64 not found."* So **the rendered anchor and the armed chip were not observed**, nor the wake turn, nor the dock head. Everything not needing a model WAS: the guarded list route (caught degrading to `{"runs":[]}` against five real run directories, which is this story's own §5.6-T8 guard firing on production data), the `?sessionId=` filter across five cases, both new routes, a real launch carrying **`agent-start` with `label` and `effort`**, the SSE frame names (and the `run` frame's absent `name`, §5.5-D5a's measured reason), Stop returning `{"ok":false}`, Resume succeeding on a `done` run, two concurrent runs, and story 4.1's wake mailbox reporting all three new runs. |

