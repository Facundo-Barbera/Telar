---
id: SPEC-ultra-workflows
companions:
  - ui-contract.md
  - brownfield.md
  - ../../project-context.md
sources:
  - ../../brainstorming/brainstorm-ultra-workflows-2026-07-24/brainstorm-intent.md
  - ../../../.cleanup-archives/docs-legacy-2026-07-17/plans/ultra-harness.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Ultra Workflows — Finish

## Why

A vision to realize with a concrete pain in the way. Ultra brings the Claude Code ultracode/Workflow fan-out harness inside telar's normal chat sessions — the first brick of migrating the owner's daily dev sessions into telar. The engine (U1–U5: sandbox, executor, journal + ordinal resume, runner, storage, MCP tools, API routes) is built and solid, but the feature fails today at the two human touchpoints: there is no real UI to see a run happen, and completion delivery is polling-only — nothing wakes the main agent when a detached run finishes. The feature is done only when a user can run, watch, and get woken by an Ultra workflow from inside a real telar session, not a demo.

## Capabilities

- **CAP-1** Completion wake
  - **intent:** When a detached Ultra run reaches a terminal state, telar wakes the session's main agent with the outcome: a synthetic completion event triggers a fresh assistant turn that summarizes it; if the user is mid-conversation, the event lands in context on the next turn instead.
  - **success:** With the session idle, a run finishing produces an unprompted assistant turn summarizing the result; mid-conversation, the next assistant turn already knows the outcome without calling `ultra_status`. `ultra_status` polling still works as fallback.

- **CAP-2** Real session UI (U6)
  - **intent:** User watches and controls Ultra runs from the real session surface (session-view, sub-agent rail, composer — not the demo gallery): a fixed-height run anchor in the transcript, a Workflows section in the existing rail, and Stop/Resume controls, live over the existing `/api/ultra` SSE.
  - **success:** Launching a run in a real session renders anchor + rail exactly per `ui-contract.md`, updating live from `/api/ultra/[id]/events`; Stop lands the run `stopped` and Resume re-runs from the journal, both from the UI.

- **CAP-3** Authoring-reference skill file
  - **intent:** The session's main agent has an authoring reference, shipped with the tool and injected for Claude sessions, that teaches how to write good Ultra scripts.
  - **success:** The reference is wired into Claude sessions (skill / system-prompt appendix) and covers: the injected surface API, the explicit-model rule, the quality patterns (adversarial-verify, loop-until-dry), and one worked example. The rail's Script tab links out to it.

- **CAP-4** Composer Ultra chip
  - **intent:** User arms Ultra for a single message via a composer chip that annotates the message (`ultra: true`) — the opt-in signal the `ultra` tool description honors.
  - **success:** A chip-armed message may trigger `ultra` without the keyword; a message with neither chip nor explicit ask never does. The chip only arms — no ceiling editor, no submenu.

- **CAP-5** Session-cost rollup
  - **intent:** A run's live spend is attributed to its owning chat message and folds into the session's per-turn usage display, in the session's cost language (USD on Claude, tokens on Codex).
  - **success:** During and after a run, the owning message's usage display includes the run's spend, matching the run manifest's `spend`.

- **CAP-6** Dock run signal
  - **intent:** From anywhere in the app, a session with live Ultra runs shows run status in its dock bubble (name · state · spend) — tracking what's happening without opening the full chat UI; tapping re-focuses the run.
  - **success:** With a run live and the user on another page, the session's dock bubble shows the run's name/state/spend updating live; tapping it navigates back and focuses the run. One dock signal per session; concurrent live runs summarize.

## Constraints

- Opt-in is a request, not a behavior flag: the agent may call `ultra` only on an explicit user ask (keyword or chip annotation), never inferred. No engine mode, no `TELAR_*` switch.
- The non-blocking contract is fixed: `ultra` validates synchronously and returns `{runId}` immediately; several runs may be live per session; completion is an event. The wake (CAP-1) supplements `ultra_status` polling — it never replaces it.
- The sandbox stays as-is: `node:vm` capability shaping with determinism bans (`Date.now`, `new Date()`, `Math.random` throw) is load-bearing for ordinal resume; it is not a security boundary and must not be reworked into one.
- Child posture is fixed: subagents run non-interactive under `ULTRA_CHILD_TOOLS` (Read, Grep, Glob, Write, Edit, Bash) + `restrictTools`; an approval-needing action fails that `agent()` call (fail-closed); there is no per-agent permission knob.
- Every `agent()` call names its `model`: static lint rejects a model-less script before `runId`; a runtime `MissingModel` is a control signal that ends the run `failed`, never coerced to `null`.
- Schema-less `agent()` (returns final text) stays — reference parity with the CC harness.
- No budgets anywhere: no spend ceilings, meters, or budget UI. Runaway brakes are the per-run cap (3), the engine gate (4), the 1000-agent backstop, human Stop, and `ultra_stop`.
- Claude-first: no Codex-specific Ultra work; Codex lights up via the codex-driver seam later.
- Ultra never writes loom state and never `done`s a loom; run state lives in `~/.telar/ultra/` under `TELAR_HOME`, invisible to loom listing/reaping.
- Terminal states are the as-built `done | failed | stopped` — the plan's draft name `completed` is superseded.
- The real UI implements the frozen contract in `ui-contract.md`; project-wide rules in `project-context.md` (client-bundle rule, hand-rolled SSE/native `EventSource`, single status vocabulary) bind.

## Non-goals

- Codex-backed Ultra — advertise Claude-only until the codex-driver seam lands.
- Reworking script isolation into a real security sandbox (`worker_threads` kill switch etc.).
- Budgets or spend ceilings of any kind.
- Nested runs — the injected surface never exposes `ultra` to a script.
- A cross-process supervisor or runs surviving server restart as `running` — reconciliation to `stopped` + Resume is the contract.
- Deferred or queued wake delivery for unattended sessions — the wake fires immediately at terminal; runs finishing with no client attached are rare and accepted.
- Any loom-lifecycle integration (charter, gates, verification, accept) — Ultra stays a side-quest tool one layer below the loom dispatcher.
- Rebuilding U1–U5 engine, tools, routes, or storage — finish work only.

## Success signal

One real end-to-end Ultra workflow runs on a sandbox project through the actual (non-demo) session UI: the user asks for it, the agent authors and launches the script, the transcript anchor and rail Workflows section track it live, and when the detached run finishes, the wake fires and the agent summarizes the outcome in chat — with no `ultra_status` poll and no page refresh needed.

## Assumptions

- The wake fires on every terminal state (`done`, `failed`, `stopped`), carrying `{state, result|error}` — the plan says the outcome reaches the agent "on terminal"; the brainstorm only says "finishes".
- The demo-gallery `session-ultra.tsx` is the as-built rendering of the frozen UI contract; the real UI implements the same contract. Its replay controls (Play/Pause/Restart/speed) are mockup-only.
- "Session-cost rollup" means run spend folding into the owning chat message's per-turn usage display — not a new cost surface.
