# Telar

Telar orchestrates looms: autonomous build-and-verify runs where a human
touches the process at most three times (charter where policy asks, a rare
dead-end question, and the final accept — `ready → done` is always human).

**Before planning ANY change to how looms operate, read `docs/PRINCIPLES.md`
(the Loom Doctrine). It is authoritative over every other design doc and over
existing code.** The short form:

- One engine, no behavior flags, no defaults/alternatives/dual paths.
  Improvements apply to every project immediately. Git branches + sandbox
  projects are the rollout safety, never runtime switches.
- `telar.yaml` / `.telar` hold project FACTS (gates, commands, servers, MCP),
  never engine behavior.
- Threads are their own inner orchestration loops (plan → execute → verify →
  mediate ↺); they escalate to the orchestrator only when exhausted, and the
  orchestrator mediates before it ever pings the human.
- The one gate that stays: the orchestrator's deterministic, fail-closed
  verification of the composed whole, then the single human accept. No
  autonomous path writes `done`.

## Build hygiene

- Green-gate before every commit: `NODE_OPTIONS= bun test packages/core`,
  `NODE_OPTIONS= bunx tsc -p packages/core/tsconfig.json --noEmit`,
  `NODE_OPTIONS= bunx tsc -p apps/web/tsconfig.json --noEmit`.
- Never touch `.env*`, `bun.lock` (package-manager only), secrets.
- `/demo-gallery` is the temporary design-review surface pending final cleanup.
  Don't ship product code that imports from it.
