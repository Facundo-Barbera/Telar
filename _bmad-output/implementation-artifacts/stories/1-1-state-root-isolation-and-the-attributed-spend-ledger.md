---
story_id: "1-1"
title: "State-root isolation and the attributed spend ledger"
status: "ready-for-review"
epic: "Epic 1: Runtime Foundations"
frs: ["FR-RF-1", "FR-RF-2"]
baseline_commit: "9689844fc9299dad7c4b5be1ecf140e6b9b1923e"
---

# Story 1.1: State-root isolation and the attributed spend ledger

## 1. User Story

As the person running telar,
I want every persisted store to honor `TELAR_HOME` and every agent call's cost recorded against its owner in one ledger,
So that a dev run can never pollute or contend with my production state, and every spend readout derives from one place instead of three that can disagree.

## 2. Acceptance Criteria

- [x] **AC1** — **Given** `TELAR_HOME` points at an empty temp directory **When** the app writes chat history and usage **Then** `chats.json`, `usage.ndjson` and `plan-usage.json` are created there **And** the real `~/.telar` is untouched — asserted by a test, not by inspection
  - Refuter: MET. `apps/web/lib/store.test.ts` (13/13 pass) exercises this exactly, including a content-hash (sha256, not existence) comparison of the real `~/.telar` before/after. Independently re-verified by the refuter outside the harness with `sha256sum` on the real files — unchanged across a single-file run and the full 296-test `apps/web` suite.

- [x] **AC2** — **Given** `TELAR_HOME` is unset **When** any store resolves its root **Then** behavior is identical to today
  - Refuter: MET. `stateRoot()` (`apps/web/lib/store.ts`) and `telarDir()` (`packages/core/src/manifest.ts`) both reduce to the pre-existing hardcoded expression when unset. Proven by a pure string assertion (no disk write) plus a child-process test with `TELAR_HOME` genuinely deleted and `HOME` set to a fake dir. The new `NODE_ENV==="test"` write-guard in `logUsage` is a new refusal path but only fires under `bun test`, never under `next dev`/production, so it does not change resolved-root behavior.

- [x] **AC3** — **Given** a dev server and the packaged desktop app run at the same time **When** both log usage **Then** they write to distinct roots, and the `--smoke` release gate's throwaway home is genuinely hermetic
  - Refuter: MET. Repo test `"a dev root and a smoke root in one process stay distinct"` passes. The refuter additionally built and ran an independent two-concurrent-OS-process probe (real `bun run` child processes, one dev-shaped, one packaged-shaped, interleaved) and found zero cross-contamination in either root's `usage.ndjson`/`chats.json`, with the real `~/.telar` byte-identical before/after. `apps/desktop/main.js`'s `--smoke` `mkdtempSync` + forked-child `TELAR_HOME` injection was read and confirmed compatible with the now-lazy resolvers.

- [x] **AC4** — **Given** an agent call completes **When** its usage is logged **Then** `UsageEntry` carries owner-kind and owner-id alongside `account`/`model`/`sessionId`/`costUsd` **And** no new ledger file exists anywhere
  - Refuter: MET. `packages/core/src/schemas.ts`'s `UsageEntry` zod schema carries `ownerKind`/`ownerId` alongside the four named fields. `usage-ledger.test.ts`'s `"logUsage appends one line to $TELAR_HOME/usage.ndjson and creates no other file"` asserts `readdirSync(home)` gains nothing but `usage.ndjson`; a second test asserts all six fields are physically present on the re-read disk line.

- [x] **AC5** — **Given** a usage record written before owner attribution existed **When** totals are computed **Then** it still counts toward them and nothing throws
  - Refuter: MET. `usage-ledger.test.ts`'s `"a record written before owner attribution existed counts toward usageSummary and ledgerSpendUsd and never throws"` hand-writes a raw pre-attribution JSON line (no `ownerKind`/`ownerId`) and asserts it folds into `usageSummary()`, `usageCostBySession()`, `usageTokensBySession()` and `ledgerSpendUsd()` unwrapped (an uncaught throw would fail the test run). A second test independently pins the "never throws" half against genuinely malformed/unparseable lines.

- [x] **AC6** — **Given** the per-turn usage display, Ultra's manifest `spend`, and a charter's budget-left **When** each is read **Then** each is a projection over `usage.ndjson`, not an independent counter
  - Refuter: MET, but only *after* Repair Round 1. The first pass over this AC found the per-turn usage display (`route.ts`'s `done` SSE payload + `session-view.tsx`'s `sessionCost` state) was still an independent counter (`lastResult.totalCostUsd` / `setSessionCost((c) => c + …)`), unchanged by the initial diff, while Ultra's `spend` and the loom's `spentUsd` had genuinely become projections (`ledgerSpendUsd(...)` recomputed at each read site, proven by out-of-band-append tests that a `+=` accumulator cannot pass). Round 1 rewired the per-turn path to read `sessionSpendUsd()` (a thin export of the same ledger fold) and changed `session-view.tsx` to `setSessionCost(payload.costUsd)` (a set, not an accumulate). Re-verified MET post-repair with a new decisive test (out-of-band append moves the value; a poisoned stored counter of `999` is ignored; an ultra-owned line riding the same `sessionId` is excluded).

## 3. Tasks / Subtasks

### Phase 1 — CAP-1 (FR-RF-1)

- **T1 — `store.ts` resolves `TELAR_HOME` lazily.**
  Files: `apps/web/lib/store.ts`.
  Proof: `stateRoot()` unit assertions (`T-A2`, `T-A4`) and the cache-no-leak test (`T-A7`) in `apps/web/lib/store.test.ts`.

- **T2 — the isolation test (new).**
  Files: `apps/web/lib/store.test.ts` (new).
  Proof: the file itself — 13 tests (`T-A1`…`T-A12` plus the round-1 addition), all passing (`13 pass, 0 fail, 32 expect() calls` standalone; extended run below has more).

### Phase 2 — CAP-2 (FR-RF-2)

- **T3 — `UsageEntry` zod schema in core.**
  Files: `packages/core/src/schemas.ts`.
  Proof: `packages/core/test/usage-ledger.test.ts` — schema-default tests (`T-B2`, `T-B3`, `T-B4`, `T-B9`).

- **T4 — the usage-ledger port (new).**
  Files: `packages/core/src/usage-ledger.ts` (new), `packages/core/src/index.ts` (one export line).
  Proof: `packages/core/test/usage-ledger.test.ts`, 12 tests, all passing (`T-B1`…`T-B12`), including the byte-offset-cache burst test and the torn-line test.

- **T5 — `store.ts` re-exports the port; `getChat`/`listChats` project `costUsd`.**
  Files: `apps/web/lib/store.ts`.
  Proof: `T-A8` (poisoned-counter test), `T-A9` (ultra-spend-on-same-sessionId exclusion), `T-A10`, `T-A11` (out-of-band append moves the read) in `store.test.ts`.

- **T6 — pin `TELAR_HOME` in the five unpinned `runWeave` suites.**
  Files: `packages/core/test/orchestrator.test.ts`, `b2-orchestrator-mediation.test.ts`, `m5-weave-setup.test.ts`, `flag-off.test.ts`, `m11-blocked-propagation.test.ts`.
  Proof: those five suites stay green with the pin (part of the 1314-test `packages/core` run), and the empirical before/after `shasum` of the real `~/.telar` across a full `bun test` run shows no change.

- **T7 — Ultra's manifest `spend` becomes a projection.**
  Files: `packages/core/src/ultra/executor.ts`, `packages/core/src/ultra/storage.ts`.
  Proof: `packages/core/test/ultra-storage.test.ts` — `T-C1`…`T-C4`, including the decisive out-of-band-append test and the cached-resume no-double-count test.

- **T8 — the charter's budget-left becomes a projection.**
  Files: `packages/core/src/weave.ts`.
  Proof: `packages/core/test/weave.test.ts` — `T-D1`…`T-D3`, including the decisive "spend visible in the first decision before any child settles" test.

- **T9 — the gate and the dev-server proof.**
  Files: none (verification only).
  Proof: full `bun test` / `bunx tsc --noEmit` / `bun run lint` gate (see Debug Log) and the `TELAR_HOME=$(mktemp -d) bun run dev` proof (see Debug Log — **partial**, see below).

### Repair Round 1 — AC6(a), the per-turn usage display

- **Files:** `apps/web/lib/store.ts` (`sessionSpendUsd` made `export`), `apps/web/app/api/chat/route.ts` (`done` payload reads `sessionSpendUsd(capturedSession)`), `apps/web/components/session/session-view.tsx` (`setSessionCost(payload.costUsd)` replaces the `+=` accumulator).
  Proof: new test in `apps/web/lib/store.test.ts` — `"sessionSpendUsd — the LIVE readout's source — is a projection, not a counter"` (poisons the stored counter, asserts an out-of-band ledger append moves the value, asserts an ultra-owned line on the same `sessionId` is excluded).

## 4. Dev Agent Record

### Debug Log

**Gate output (final, post-repair-round-1), real command output:**

```
green: true
[packages/core] bun test -> pass
1314 pass, 0 fail, 4532 expect() calls
Ran 1314 tests across 99 files. [22.65s]

[packages/core] bunx tsc --noEmit -> pass
No type errors

[apps/web] bun test -> pass
296 pass, 0 fail, 1352 expect() calls
Ran 296 tests across 10 files. [308.00ms]

[apps/web] bun run lint -> pass
77415 total problems reported (4693 errors, 72722 warnings). 0 new lint problems in changed files.

[apps/web] bunx tsc --noEmit -> pass
No type errors
```

Story-suite-only rerun after repair round 1:
```
bun test packages/core/test/usage-ledger.test.ts packages/core/test/ultra-storage.test.ts \
         packages/core/test/weave.test.ts apps/web/lib/store.test.ts
-> 78 pass, 0 fail, 428 expect() calls
```

Repo-wide `bun test` (post-repair) reported `1610 pass, 1 fail, 1 error` across 110 files. The single failure/error is pre-existing and unrelated to this story: `_bmad-output/specs/spec-runtime-foundations/reference/admission-impl/admission.test.ts` fails with `Cannot find module '../src/admission'`, it is unmodified at `git status --porcelain`, it fails identically in isolation, and it belongs to story 1.2 / CAP-4 reference material, not this story's write set.

> **Correction, 2026-07-25.** The diagnosis above was wrong on one point: `admission.ts` **does** exist in that directory (9.2k, alongside the test and the patch). The failure is a path, not a missing file — the test is a copy of `packages/core/test/admission.test.ts` and still carries that location's relative imports (`../src/admission`, `../src/budget`), which do not resolve from `_bmad-output/`. Root cause was that repo-wide `bun test` discovery reached into planning artifacts at all. Fixed by adding `**/_bmad-output/**` to `bunfig.toml`'s `pathIgnorePatterns`, consistent with its existing rationale for `release/` and `.next-desktop/`. Repo-wide `bun test` is now **1610 pass, 0 fail** across 109 files. `bunx tsc --noEmit` was clean in both workspaces; `eslint` on the four touched files (`store.ts`, `store.test.ts`, `route.ts`, `session-view.tsx`) reported problems that pre-existed on unedited lines only — 0 new problems.

**Every AC verdict with its evidence (from the AC-refuter pass, run against the post-repair working tree):**

- **AC1 — MET.** Ran `bun test apps/web/lib/store.test.ts` fresh → 13 pass, 0 fail, 32 expects. The test named `"the real ~/.telar is unchanged in CONTENT by a TELAR_HOME-scoped run"` sha256-fingerprints the real `~/.telar`'s three files before and after a `TELAR_HOME`-scoped write and asserts equality — content-based specifically because an append wouldn't change file existence. Refuter independently ran `sha256sum` on the real files outside the test harness before/after running the file alone and after the full 296-test suite — unchanged both times (`b52520e7…`/`196ac51c…`/`9ab790a8…`). Confirmed the refuter's ambient shell had no `TELAR_HOME` set, so the fallback path was genuinely exercised.

- **AC2 — MET.** `stateRoot() === path.join(os.homedir(), ".telar")` when `TELAR_HOME` is deleted — a pure, hermetic string assertion (`bun test … -t "unset"` → 2 pass, 5 expects). A second test spawns a real child process with `TELAR_HOME` deleted and `HOME` pointed at a fake dir, and asserts the write lands at `<fakeHome>/.telar/usage.ndjson`. Refuter checked whether the new `NODE_ENV==="test"`-without-`TELAR_HOME` write guard in `logUsage` violates "identical to today" — it only fires under `bun test`, never `next dev`/production, and doesn't change which root is *resolved*, only gates a write inside a specific function — ruled out of scope for this AC.

- **AC3 — MET.** Repo test `"a dev root and a smoke root in one process stay distinct"` passes. Refuter additionally wrote and ran an independent probe (`/private/tmp/.../ac3probe/probe.ts`) spawning two genuinely concurrent OS processes (dev-shaped env, packaged-shaped env) hammering `upsertChatStub`/`logUsage`/`savePlanUsage` 20× each interleaved — each root ended with exactly its own 20 lines, 0 cross-contamination, real `~/.telar` hash unchanged. Read `apps/desktop/main.js:230-282`'s `--smoke` `mkdtempSync` + forked-child `TELAR_HOME` injection and confirmed both `stateRoot()` and `telarDir()` are lazy (resolved per-call), so the smoke child's injected root is honored on every read/write. `apps/desktop/main.js` itself was not modified and was not exercised end-to-end as a packaged Electron build (out of proportion for this check) — the refuter relied on the equivalent-mechanism concurrent-process probe plus code reading instead.

- **AC4 — MET.** `usage-ledger.test.ts`: `"logUsage appends one line to $TELAR_HOME/usage.ndjson and creates no other file"` asserts `readdirSync(home)` gains nothing but `usage.ndjson` after two calls. `"the appended record carries ownerKind and ownerId alongside account/model/sessionId/costUsd"` asserts all six keys are present on the re-read raw disk line, not just the in-memory object. Confirmed `store.ts`'s own former `UsageEntry` type and ledger implementation are deleted and replaced by a re-export from `@telar/core` — one implementation, one file.

- **AC5 — MET.** `usage-ledger.test.ts`'s `"a record written before owner attribution existed counts toward usageSummary and ledgerSpendUsd and never throws"` hand-writes a raw line missing `ownerKind`/`ownerId`, calls `usageSummary()`/`usageCostBySession()`/`usageTokensBySession()`/`ledgerSpendUsd()` unwrapped, and asserts each includes it; a second test pins "never throws" against genuinely malformed lines with `expect(() => usageSummary()).not.toThrow()`. Source: every field in the `UsageEntry` zod schema the historical record lacks has a `.default(...)`; `normalize()` returns `null` (never throws) on a parse failure and defaults `ownerId` to `sessionId` when absent.

- **AC6 — MET, post-repair-round-1 only.** Initial pass found the per-turn display (`route.ts`'s `done` SSE payload, `session-view.tsx`'s `sessionCost` `useState`) was untouched by the original diff and remained an independent, additive counter — a genuine, reproducible gap, not a nitpick, since it was the *same* architectural defect the story had already fixed for Ultra and weave. Round 1 rewired both files to read/set the ledger projection (`sessionSpendUsd()`). Post-repair re-verification: traced `apps/web/app/api/chat/route.ts:1813-1816` (`costUsd: capturedSession ? sessionSpendUsd(capturedSession) : lastResult.totalCostUsd`), `apps/web/components/session/session-view.tsx:1883` (`setSessionCost(payload.costUsd)`, a set), `packages/core/src/ultra/storage.ts:300` (`spend: ledgerSpendUsd({ownerKind:"ultra", ownerId: runId})`), `packages/core/src/weave.ts:249` (`const spentUsd = () => ledgerSpendUsd({ownerKind:"loom", ownerId: loom.id})`). Ran the decisive tests: out-of-band ledger appends move `sessionSpendUsd`/manifest `spend`/`rationale.budget.spentUsd` without those code paths writing them — a `+=` accumulator cannot pass this. Full suites rerun clean: `packages/core` 1314/0, `apps/web` 296/0, both `tsc --noEmit` clean.

**Dev-server proof observation — `TELAR_HOME=$(mktemp -d) bun run dev` (verdict: PASS — completed 2026-07-25 with one real, operator-authorized chat turn):**

An earlier pass of this proof was recorded as PARTIAL because no real chat turn had been driven, so `chats.json` and `usage.ndjson` were never produced live. The operator subsequently authorized spending real inference for a single cheap turn. That gap is now closed; what follows is the completed run, which supersedes the partial one.

- **Root override confirmed by the app itself.** Dev server started as `TELAR_HOME=/tmp/telar-proof-eIMkyn PORT=3111 bun run dev` against a `mktemp -d` root verified empty (0 entries) beforehand. `/api/doctor` reported `{"id":"telar-home","label":"Active TELAR_HOME","value":"/tmp/telar-proof-eIMkyn","status":"ok","detail":"Custom (TELAR_HOME override)."}` — the exported variable beat the package.json default `${TELAR_HOME:-$HOME/.telar-dev}`.
- **One real chat turn.** `POST /api/chat` with `model: claude-haiku-4-5`, `effort: low`, `account: personal`, `project: telar`, message `"Reply with exactly the word PROOF-OK and nothing else. Do not use any tools."` The model replied `PROOF-OK`. SSE terminated `event: done` → `{"subtype":"success","costUsd":0.021106899999999998,"turns":1,...}`, then `event: saved` → `{"chatId":"f69e530b-df27-4933-b566-16c07bdf1c99"}`.
- **`chats.json` AND `usage.ndjson` were created in the temp root by that turn.** Listing at teardown: `accounts.json`, `chats.json`, `plan-usage.json`, `projects.json`, `usage.ndjson`, `sessions/` — versus the five-file listing with neither chat nor usage file in the earlier partial pass.
- **The ledger line carries owner attribution**, verbatim from the temp root's `usage.ndjson` (exactly one line):
  `{"ts":1785019503298,"account":"personal","model":"claude-haiku-4-5","sessionId":"f69e530b-df27-4933-b566-16c07bdf1c99","inputTokens":10,"outputTokens":70,"cacheReadTokens":18589,"cacheCreateTokens":9144,"costUsd":0.021106899999999998,"ownerKind":"session","ownerId":"f69e530b-df27-4933-b566-16c07bdf1c99"}`
  Note `ownerId` is a real session id, not the schema's `""` default: `route.ts`'s `logUsage` call passes no owner fields, and `normalize()` (`packages/core/src/usage-ledger.ts:64`) fills `ownerId` from `sessionId`.
- **The displayed per-turn cost is the ledger projection.** A read-only probe with `TELAR_HOME` pinned at the temp root returned `sessionSpendUsd("f69e530b-…") = 0.021106899999999998` and `getChat(…).costUsd = 0.021106899999999998` — bit-for-bit equal to the `costUsd` the `done` event handed the UI, which `session-view.tsx` *sets* rather than accumulates.
- **Proof that it is a fold, not a counter.** On a single turn a total and a delta are numerically identical, so the equality above cannot by itself discriminate between them. The discriminating step, costing zero inference: a synthetic `+0.50` line for the same `sessionId` was appended out-of-band to the temp ledger. In a **fresh process**, `sessionSpendUsd` and `getChat().costUsd` both moved to `0.5211069` (= `0.021106899999999998 + 0.5`) while `chats.json` on disk still read `0.021106899999999998`. The persisted record did not change; the readout did — so the readout re-derives from `usage.ndjson` rather than reporting a stored or accumulated number. A `+=` counter cannot produce this result.
- **`~/.telar` byte-identical.** Before/after `find ~/.telar -type f -exec shasum {} \; | sort` manifests: 366 files each, both hashing to `2b579aca33c33c2dd2958e6bbdf4db77a75cdb37`, `diff` exit 0. The proof turn's session id appears **0** times in the real `~/.telar/usage.ndjson`, whose last entry remains `ts: 1784259798880` — the real ledger gained nothing.
- **Teardown.** Dev server killed (SIGTERM, exit 143); port 3111 refuses connections; no `next dev`/`next-server` process remained; the temp root was removed. No `git` write command was run and no repo file was modified by this proof pass — `git status --porcelain` after the run matched the pre-run working tree exactly.

**Net: the dev-server proof is now fully observed. Every clause — `chats.json` and `usage.ndjson` created in the temp root by a real turn, owner attribution on the ledger line, the UI's cost equal to `sessionSpendUsd()` over that ledger and demonstrably a projection rather than a delta, and `~/.telar` untouched — was confirmed live against the running app, not inferred from the test suites.**

**Repair rounds:**

- **Round 1** — Finding: AC6 was not fully met. The per-turn usage display (`apps/web/app/api/chat/route.ts`'s `done` SSE payload and `apps/web/components/session/session-view.tsx`'s `sessionCost` state) remained an independent, additive counter, unchanged by the initial diff, while Ultra's `spend` and the loom's `spentUsd` had genuinely become ledger projections. Fix: made `sessionSpendUsd()` an export of `apps/web/lib/store.ts`; changed `route.ts`'s `done` payload to read it (falling back to `lastResult.totalCostUsd` only in the practically-unreachable case where no session was captured); changed `session-view.tsx` to `setSessionCost(payload.costUsd)` (set, not accumulate — also closes a latent double-count on SSE-reconnect replay of a `done` event). Added a new decisive test in `store.test.ts` (out-of-band append moves the value; a poisoned `999` counter is ignored; an ultra-owned line on the same `sessionId` is excluded). Two comments that had become stale were corrected. Full gate rerun green after the fix (see Gate output above). This repair reached into `route.ts` (Track B) and `session-view.tsx` (Track C), outside the plan's declared write set — flagged explicitly rather than hidden, on the grounds that the AC is the contract and the plan had already crossed two other track boundaries for the identical AC6 clause.
- No further repair rounds were needed; "Outstanding at close" is empty.

### Completion Notes

**What landed:**
- CAP-1 (FR-RF-1): `apps/web/lib/store.ts` resolves `TELAR_HOME` lazily via the settled `permissions.ts`-style expression, exported as `stateRoot()`; the ledger read-memo was re-keyed to stop leaking across roots within one process. Covered by a new `apps/web/lib/store.test.ts`.
- CAP-2 (FR-RF-2): a new `packages/core/src/usage-ledger.ts` port is now the sole reader/writer of `usage.ndjson`, backed by a new `UsageEntry`/`UsageOwnerKind` zod schema in `packages/core/src/schemas.ts` with tolerant, defaulted fields. `apps/web/lib/store.ts` re-exports it rather than keeping a second implementation. `getChat`/`listChats`, Ultra's manifest `spend`, the loom charter's `spentUsd`, and (after repair) the per-turn SSE display all now read this one projection instead of four independent counters.
- Five `packages/core` test suites that call `runWeave` with zero prior `TELAR_HOME` pin were pinned, as a prerequisite so the loom's new unconditional ledger writes (T8) could not otherwise leak into the developer's real `~/.telar` during `bun test`.
- The full gate (`bun test` in both workspaces, `bunx tsc --noEmit` in both, `bun run lint` in `apps/web`) is green, with one pre-existing, unrelated failure in a story-1.2/CAP-4 reference-implementation test directory that this story's diff cannot reach.

**What did not land / was not fully verified:**
- **No commit was made.** CAP-1 was implemented and gated before any CAP-2 change per the plan's ordering, but the plan's own gate called for committing CAP-1 alone before starting CAP-2; that commit boundary does not exist — the working tree currently holds both phases' changes uncommitted together. The ordering was honored in execution sequence only, not recorded as a separate, revertable commit.
- ~~**The interactive dev-server proof is partial.**~~ **Closed 2026-07-25.** The operator authorized one cheap real turn, which was driven against the running dev server under a throwaway `TELAR_HOME`. `chats.json` and `usage.ndjson` were both created in the temp root by that turn, the ledger line carried `ownerKind`/`ownerId`, the UI's cost was shown bit-equal to `sessionSpendUsd()` over that ledger and proven to be a fold rather than a delta by an out-of-band append, and `~/.telar` stayed byte-identical. See the completed dev-server proof observation in the Debug Log above. No part of this story's dev-server proof now rests on the test suites alone.
- **`scripts/build-desktop.sh --smoke`** was not run; it pins `REF="origin/main"` and refuses any commit not reachable from an `origin/*` branch, so it cannot run against an uncommitted tree. It remains a post-merge confirmation step, not part of this story's gate. `apps/desktop/main.js` was read and found already correct/untouched.
- **Deliberately left to other tracks/stories, not silently dropped:** `apps/web/app/api/chat/route.ts`'s call site for `logUsage` was left unedited where the schema's own defaults suffice (AC4); surfacing loom/ultra spend in the sidebar (rather than keeping `usageSummary()` session-scoped) is recorded as a UX decision needing a human, not made here; finer-grained per-attempt loom ledger attribution is left to Track F; the typed event bus, admission control, the lease primitive, and `TELAR_HOME/sessions/<sessionId>/` belong to story 1.2 (CAP-3/4/5); `SessionProfile` belongs to stories 2.1/2.2 (CAP-7).
- Four-Walls sentinel reported clean (W1–W4), with one item flagged for the record rather than scored as a violation: several new tests write `usage.ndjson` directly by path (inside `mkdtemp`-pinned `TELAR_HOME` roots only) as deliberate out-of-band-append fixtures needed to falsify a `spend +=` counter implementation — never touching real state, but a literal path-write outside the port if the walls are read as binding test code.

## 5. File List

**Modified (14):**
- `apps/web/app/api/chat/route.ts`
- `apps/web/components/session/session-view.tsx`
- `apps/web/lib/store.ts`
- `packages/core/src/index.ts`
- `packages/core/src/schemas.ts`
- `packages/core/src/ultra/executor.ts`
- `packages/core/src/ultra/storage.ts`
- `packages/core/src/weave.ts`
- `packages/core/test/b2-orchestrator-mediation.test.ts`
- `packages/core/test/flag-off.test.ts`
- `packages/core/test/m11-blocked-propagation.test.ts`
- `packages/core/test/m5-weave-setup.test.ts`
- `packages/core/test/orchestrator.test.ts`
- `packages/core/test/ultra-storage.test.ts`
- `packages/core/test/weave.test.ts`

**Created (3):**
- `apps/web/lib/store.test.ts`
- `packages/core/src/usage-ledger.ts`
- `packages/core/test/usage-ledger.test.ts`

**`git diff --stat` (measured directly):**
```
 apps/web/app/api/chat/route.ts                     |  14 +-
 apps/web/components/session/session-view.tsx       |  24 ++-
 apps/web/lib/store.ts                              | 221 ++++++++-------------
 packages/core/src/index.ts                         |   3 +
 packages/core/src/schemas.ts                       |  34 ++++
 packages/core/src/ultra/executor.ts                |   7 +
 packages/core/src/ultra/storage.ts                 |  24 ++-
 packages/core/src/weave.ts                         |  30 ++-
 .../core/test/b2-orchestrator-mediation.test.ts    |  18 +-
 packages/core/test/flag-off.test.ts                |  18 +-
 packages/core/test/m11-blocked-propagation.test.ts |  18 +-
 packages/core/test/m5-weave-setup.test.ts          |  18 +-
 packages/core/test/orchestrator.test.ts            |  18 +-
 packages/core/test/ultra-storage.test.ts           | 124 ++++++++++++
 packages/core/test/weave.test.ts                   | 123 ++++++++++++
 15 files changed, 531 insertions(+), 163 deletions(-)
```
(New/untracked files do not appear in `git diff --stat` until staged; `bun.lock` is untouched, no dependency was added.)

## 6. Change Log

- **CAP-1 (FR-RF-1):** `apps/web/lib/store.ts`'s hardcoded `~/.telar` root became a lazily-resolved, exported `stateRoot()`, matching the pre-existing idiom used by `manifest.ts`/`looms.ts`/`session-log.ts`/`permissions.ts`, so a dev run, the packaged app, and the release smoke gate can each hold a distinct state root within one process — because `os.homedir()` under Bun resolves at process start and cannot be redirected by mutating `process.env.HOME` in-process, only lazy, use-site resolution makes this provable at all. Why: dev and production state were previously indistinguishable to the app itself.
- **CAP-2 (FR-RF-2):** the spend ledger (`usage.ndjson`, `UsageEntry`, `logUsage`, `usageSummary`) moved from `apps/web/lib/store.ts` into a new core-owned port, `packages/core/src/usage-ledger.ts`, with an additive, tolerant-reader `UsageEntry` zod schema carrying `ownerKind`/`ownerId`. Ultra's manifest `spend` and the loom charter's `spentUsd` were converted from independent accumulators into reads of this one port. Why: AC6 requires three named readouts to be projections over one file rather than three counters that can silently disagree; `packages/core` cannot import `apps/web`, so the projection had to live core-side.
- **Repair round 1:** the per-turn usage display (`route.ts`'s SSE `done` payload, `session-view.tsx`'s `sessionCost` state) was found to still be an independent accumulator after the initial pass and was converted to the same ledger projection, closing the last of AC6's three named readouts and a latent double-count on SSE-reconnect replay.
- Five `packages/core` test suites were given a `TELAR_HOME` pin as direct, load-bearing collateral of the loom-side change (T8) — without it, `bun test` itself would have begun writing loom-owned spend into the operator's real `~/.telar`.
- No dependency was added; `bun.lock` is untouched. No commit was created — this is a suggestion only, since the user commits, not the agent:

  Given the working tree currently holds both CAP-1 and CAP-2 uncommitted together (the plan's own commit-CAP-1-alone gate could not be executed under a no-git-writes constraint), a reasonable split is two commits:

  ```
  fix(web): resolve TELAR_HOME lazily in store.ts so dev runs never write production state

  os.homedir() is resolved once at process start under Bun, so the previous
  top-level `~/.telar` constant made a dev server, the packaged app, and the
  --smoke gate's throwaway home indistinguishable in-process. Export stateRoot()
  lazily, matching the existing idiom in manifest.ts/looms.ts/session-log.ts/
  permissions.ts, and re-key the usage-log memo on (file, mtime) so two roots
  can coexist in one process without one leaking into the other's cache.
  ```

  ```
  feat(core): move the spend ledger into a core-owned, owner-attributed port

  Ultra's manifest spend and a loom's budget-left were two more counters that
  could silently disagree with the sidebar's usage total. Move usage.ndjson's
  read/write into packages/core/src/usage-ledger.ts behind a tolerant UsageEntry
  schema carrying owner-kind/owner-id, and make every spend readout - including
  the per-turn SSE display - a read of that one projection instead of an
  independently accumulated number.
  ```

  If a single commit is preferred instead, combine both messages under one `feat(core):` conventional-commit header describing the same rationale.
