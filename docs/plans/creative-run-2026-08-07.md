# Creative run — 2026-08-07

Seven scouts swept the repo (and the local t3code reference) for things to add,
upgrade, modify, or fix; three judges scored the 35 proposals against the feel
contract, value-per-effort, and architectural fit. This is the curated result —
what survived, what got folded together, and what the judges killed. Raw
material: the run returned 35 proposals; the clusters below are the ~20 that
remain after dedup and conflict resolution.

## Verified defects (highest priority — the new runtime's own gaps)

1. **Deleting a chat never closed its persistent runtime** — FIXED on this
   branch (9f361db). DELETE removed files only; a warm process and its agents
   outlived the deleted session.
2. **The sidebar never lights up for ordinary background agents.** `/api/chats`
   derives `live` from `isSessionRunLive` alone and its background-run list
   from Ultra runs only — a session whose window is alive with plain background
   agents looks idle in the sidebar. Fix: fold `isSessionWindowLive` into the
   derivation. BUNDLE with the **"needs your approval" sidebar indicator**
   (same new response field, same row-derivation pass — landing them separately
   means touching the shape twice).
3. **Crash-interrupted turns finish silently.** After a server restart both
   liveness checks are false, so the events route closes without a word and a
   half-finished turn reads as a completed one. The transcript should say
   "interrupted — the server restarted" (recoverSessionQueue already knows).
4. **The feed swallows its own failures.** `appendFeedEvent` returns a cursor
   or null; all five route.ts call sites drop the return, so a failed feed
   write makes background output vanish with no trace. Small fix, cheap
   diagnostics.
5. **Every streamed token recomputes the whole transcript** past the shell's
   memo boundary. Real, but the naive per-turn memo fights items.ts's design —
   needs a considered approach, not a hotfix.

## Top upgrades, in rough order of feel-per-effort

- **Clickable completion markers** (S) — "agent finished · X" jumps to that
  agent's tab. Post-coalescing (39188b8) the marker must carry an id LIST, one
  per merged completion.
- **Draft persistence across reload** (S) — the composer's in-progress text
  survives navigation. `PromptInputProvider` already accepts `initialInput`;
  the hydration-safe restore pattern exists for the queue.
- **Transcript export** (S) — one feature, proposed twice (menu item + server
  route). Ship as one: a route reading chats.json, a "Copy as Markdown /
  Download" item in the session menu. NOTE: the feed is NOT the source —
  feed.ndjson truncates every window.
- **Mid-session model/effort switching** (M) — the pickers lock the moment a
  session exists (`runtimeLocked`), yet the runtime-mode sibling control
  already changes live, and the fingerprint restart-on-change plumbing exists.
  GUARD REQUIRED: a fingerprint change closes the runtime, which would kill
  live background agents — only unlock while idle with no agents live.
- **Per-turn "Changed files" card** (M) — today an edit-heavy turn renders as
  "Edited file ×2" with no filenames. Port t3code's ChangedFilesTree +
  changedFilesPresentation as a new conversation kind, fed from the Edit/Write
  tool parts tool-step.tsx already parses.
- **AskUserQuestion** (M) — currently in ALWAYS_DENIED_TOOLS purely for lack
  of UI; a structured Q&A card (options as buttons) is a genuine regression
  against the Claude Code baseline. Same missing answer-widget primitive a
  future plan mode would need.
- **In-session search** (M) — Cmd-F is genuinely broken: the settled-turn fold
  unmounts content. Search that reaches folded content (auto-opening via
  view.setOpen) comes first; the proposed jump-to outline is a strict subset
  of the same index and can follow.
- **"While you were away"** — a four-proposal cluster (digest, unread divider,
  sticky strip, OS notifications). Pick ONE transcript mechanism: the
  unread-since-last-visit divider (it reuses the marker primitive). Separately,
  OS notifications today fire only for loom transitions — plain-session settle
  should ride the same notify path.
- **Pinned todo summary** (M) — TodoWrite renders nicely inline but scrolls
  away; the latest list's "3/5 done" could live in the strip above the
  composer, expandable.
- **Provider-status banner** (M) — auth expiry / rate limit is a standing
  condition, not one message's error; today it repeats as identical
  per-message failures. Port t3code's keyed dismissible banner.

**Slot discipline (flag):** five proposals want the strip between transcript
and composer (presence line's home). One rule before any of them land: that
strip speaks in words, one line at a time, priority-ordered — approval needed >
presence > todo summary — never stacked chrome.

## Structural moves (the server layer's next commits)

1. **Extract Codex provider glue into `server/providers/codex/`** (M) — the
   mechanical next step of the restructure, and the landing site for:
2. **The Codex persistent runtime** (L) — Codex still has the structural
   kill-zone Claude just lost (app-server child killed per turn;
   `thread/resume` already supported). Sequencing note: this invalidates the
   lifecycle design's F2 premise that "Codex Stop stays kill-the-child" —
   landing it first makes Codex Stop an interrupt too.
3. **Retire the line-counted log** (S–M) — point the dock tail and
   session-view's remaining bare `/events` form at the cursor feed; one live
   surface instead of a dual write.
4. **Commit a Playwright E2E smoke suite** (M) — the send/stop/permission
   paths just changed under zero end-to-end coverage; the tooling and the
   proof pattern were already validated during the stress rounds, just never
   committed.
5. **Plan mode** (L, undecided) — legitimate Claude Code vocabulary, but it
   adds a fifth runtime mode and a plan-accept verb; RUNTIME_MODES index order
   is load-bearing for profile ceilings. Decide deliberately, not by default.

## Killed or folded by the judges

- *Up-recall of already-sent messages* — conflicts with lifecycle F1/F3
  (ArrowUp walks the pending strip; editing history is F3's job).
- *Queue reordering primitive* — the lifecycle design explicitly decided
  against a core reorder ("the pull-back is what makes head-insertion
  possible").
- *Attachments on pending-strip lines* — already specified inside lifecycle
  STEP 1; only the file-badge rendering is new.
- *Turn-scoped diff review comments* — PR-review vocabulary that exists in
  neither Claude Code nor Codex; a system to tend. Feel-contract violation.
- *Wall-clock perf-budget test* — the classic flaky-test generator; this repo
  already has CI-diagnostics scar tissue.
- *MAX_DETAILED_TOOL_PARTS "fix"* — unverified premise; the ration is
  plausibly an intentional persistence cap. Confirm intent first.

## Suggested sequencing

Merge the current branch first (it now carries the runtime, the feel work, and
three fixes from this run's findings). Then: message-lifecycle STEPS 0–2 (the
committed roadmap) → the S-tier quick wins (clickable markers, draft
persistence, export, feed observability, sidebar liveness bundle) → Codex
extraction + runtime → the M-tier reading upgrades (changed-files card,
search, AskUserQuestion).
