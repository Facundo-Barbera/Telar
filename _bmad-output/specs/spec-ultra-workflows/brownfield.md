# Ultra — As-Built State (verified 2026-07-24)

What exists, where, and the facts downstream must not re-decide. Ground truth is the code plus the regenerated docs (`docs/architecture-core.md`, `docs/api-contracts-web.md`, `docs/architecture-web.md`).

## Built (U1–U5) — reuse, never rebuild

- **Engine** `packages/core/src/ultra/`: `sandbox.ts` (`node:vm` capability-shaped context, frozen injected surface, `Date`/`Math.random` throw), `surface.ts` (`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`), `executor.ts` (per-run concurrency cap 3, 1000-agent lifetime backstop, K=2 validate-and-retry on schema'd results), `journal.ts` (ordinal-keyed records with `(prompt, opts)` content hash as cache-validity check; prefix-serve resume, first mismatch invalidates that ordinal and everything after), `runner.ts` (child posture: `ULTRA_CHILD_TOOLS = Read, Grep, Glob, Write, Edit, Bash` + `restrictTools`; `model` required, no fallback), `storage.ts`, `signals.ts` (`AbortError`/`MissingModel` are control signals that propagate past `parallel` barriers).
- **Tools** `apps/web/lib/ultra-mcp.ts`: in-process MCP server exposing `ultra` / `ultra_status` / `ultra_stop`; the opt-in rule lives in the `ultra` tool description; wired into `POST /api/chat`; the per-message `ultra: true` chip annotation is honored (only literal `true`).
- **API** (`apps/web/app/api/ultra/`): `GET|POST /api/ultra` (list; non-blocking launch → `{runId}`, `400` on validation/compile reject), `GET /api/ultra/[id]` (manifest + state + result), `GET /api/ultra/[id]/events` (SSE `run`/`ev`/`end` poll-tail), `GET /api/ultra/[id]/agents/[ordinal]`, `POST /api/ultra/[id]/stop`, `POST /api/ultra/[id]/resume` (re-runs a possibly-edited script serving the journal prefix by ordinal).
- **Storage** `~/.telar/ultra/<runId>/` under `TELAR_HOME`, sibling of `looms/` — never inside it: `manifest.json` (atomic temp+rename; links `sessionId`+`messageId`; carries `spend`), `journal.jsonl`, `events.ndjson`, `agents/<ordinal>.ndjson`, `script.js`. States: `running | done | failed | stopped`; `result` attaches only alongside `done`.
- **Reconciliation, self-healing:** a manifest still `running` with no live in-process task reconciles to `stopped` on read (Resume offered). Runs are in-process detached tasks in a `globalThis`-backed registry (survives HMR, dies with the server).
- **Concurrency:** per-run 3 under the shared engine gate `MAX_CONCURRENT = 4`; one `AbortController` per run shared into every `agent()` call.
- **Demo UI:** `apps/web/lib/demo-gallery/ultra/session-ultra.tsx` renders the frozen contract against fixtures, including the mockup-only replay controls.

## Gaps — the finish work (SPEC capabilities)

- No wake: completion delivery is polling-only (`ultra_status`). → CAP-1.
- No real UI: session-view, sub-agent rail, and composer have zero Ultra wiring. → CAP-2, CAP-4.
- Cut from U5, still owed: authoring-reference skill file → CAP-3; session-cost rollup → CAP-5.
