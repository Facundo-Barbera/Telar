---
topic: finish Ultra (ultracode workflows) in telar
date: 2026-07-24
status: ready-for-spec
---

# Ultra Workflows — Finish Intent

## What It Is
Bring the Claude Code ultracode/Workflow fan-out harness inside telar's normal chat sessions. This is the first brick of migrating normal daily sessions into telar — the feature isn't done until a user can run, watch, and get woken up by an Ultra workflow from inside a real telar session, not a demo.

## Verified Current State

**Built:**
- U1-U4 core (engine) — `packages/core/src/ultra/`: sandbox, executor, journal + ordinal resume, runner, storage.
- U5 tools/wiring — `apps/web/lib/ultra-mcp.ts`, chat route wiring, 6 API routes.
- Child posture — fixed `ULTRA_CHILD_TOOLS` + `restrictTools`, implemented.
- Startup reconciliation — self-healing reads, implemented.

**Missing / gap:**
- U6 real UI — does not exist. Only a demo-gallery mockup (`session-ultra.tsx`) exists; real session UI (session-view, subagent-rail, composer) has zero Ultra wiring.
- Completion delivery is **polling-only** (`ultra_status` tool). No wake mechanism fires when a detached run finishes. This is the biggest parity gap vs the CC harness, which re-invokes the model on completion.
- Cut from U5 scope (still owed): authoring-reference skill file, session-cost rollup.

## Settled Decisions

1. **Sandbox stays as-is.** Determinism bans are load-bearing for resume; the hygiene part is reference parity, not a real security layer — do not rework.
2. **Completion wake mechanism (the missing design piece).** When a detached run finishes, Telar wakes the main agent with the result: a synthetic completion event triggers a fresh assistant turn that summarizes it. If the user is mid-conversation, the event just lands in context on the next turn. Mirrors CC task notifications. Polling (`ultra_status`) stays as fallback, not replaced.
3. **Keep schema-less `agent()`** — reference parity with the CC harness, not up for redesign.
4. **Ship Claude-first.** Codex support lights up later, when the driver seam lands — out of scope for "done."
5. **Prove-run required.** Before calling the feature done, run one real end-to-end Ultra workflow on a sandbox project through the actual (non-demo) UI.

## Build Punch List (ordered)

1. **Completion wake mechanism** — synthetic completion event → fresh assistant turn summarizing the finished run; keep polling as fallback.
2. **U6 UI wiring** — turn the demo-gallery mockup contract (`session-ultra.tsx`) into real SSE-driven UI: anchor, rail Workflows section, stop/resume buttons. Touches session-view, subagent-rail, composer.
3. **Authoring-reference skill file** — teaches the author agent how to write/use Ultra workflows.
4. **Polish** — composer chip, session-cost rollup.

## Synthesis
The engine (U1-U5) is done and solid. The feature fails today at two human touchpoints only: seeing a run happen (no UI) and hearing it finish (no wake). Close those two, ship the skill file so the author agent uses it correctly, prove it once end-to-end. Everything past that is polish.
