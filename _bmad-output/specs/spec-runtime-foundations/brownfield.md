# Brownfield — Runtime Foundations

Companion to `SPEC.md`. What exists, verified against the working tree 2026-07-24. Line numbers drift; the shapes do not.

## Reuse, never rebuild

- **The usage ledger already exists.** `apps/web/lib/store.ts` — file header says it plainly: *"File-backed persistence in ~/.telar — chats.json (chat history) and usage.ndjson (append-only usage ledger). Files remember; no database."* It ships `UsageEntry {ts, account, model, sessionId, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd}`, `logUsage()`, `usageSummary()`, plus `readPlanUsage()` / `savePlanUsage()` over `plan-usage.json`. CAP-2 **extends** this. Creating a second spend file would make a fourth counter compete with three — the exact failure CAP-2 exists to prevent.
- **The lease primitive already exists.** `packages/core/src/runner/lease.ts` — `{pid, token, ts}`, atomic temp+rename write, heartbeat, stale-reclaim, and the invariant *"a stale lease can at worst produce a false-positive failed, never an auto-done."* CAP-5 generalizes this shape to a second lifetime; it does not author a new one.
- **The atomic-write idiom is settled.** `.tmp` → `fs.renameSync`, per `manifest.ts` `atomicWrite`, `accounts.ts`, `secrets.ts`, and `store.ts`'s `savePlanUsage`. Every new store follows it.
- **`TELAR_HOME` resolution is settled — in five of six places.** `manifest.ts:17`, `looms.ts:17`, `session-log.ts:16`, `permissions.ts:45` and `vcs.ts` all use `process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar")`. Copy that expression; do not invent a variant.
- **Hand-rolled SSE is the streaming pattern.** Raw `ReadableStream` of `event:`/`data:` frames consumed via `lib/sse.ts consumeSSE()`; `GET` tails use the browser-native `EventSource`. CAP-3's SSE adapters extend this — no `useChat`, no `EventSource` polyfill.
- **Ultra's storage layer is the model for reconcile-on-read.** A manifest still `running` with no live in-process task reconciles to `stopped` on read, offering Resume. CAP-5's session tree inherits that posture (AD-15).
- **The fail-before-the-stream pattern already exists.** `apps/web/app/api/chat/route.ts` resolves `getProject(project).manifest` inside a try/catch that returns a **plain 400** for an unknown or missing project, deliberately before any SSE stream opens. CAP-7's `requiredCapabilities` check inherits that placement rather than inventing an error path (AD-11).
- **Telar already owns its MCP surface deliberately.** The Claude branch spreads `resolveProjectMcpServers(project)` alongside `loom` and `ultra` with `strictMcpConfig: true` — `settingSources` of `project`/`local` would leak the repo's `.mcp.json` and the user's local Claude MCP config as duplicate unauthenticated servers. CAP-7's `mcpServers[]` and `settingSources` fields formalize a posture the route already holds by hand.

## Track B — the chat route, as built

CAP-7 brings `apps/web/app/api/chat/route.ts` into this package. What is there today:

- **Nothing in the engine requires a project.** `packages/core` `engine.ts` `agent()` takes `cwd` as an **optional** parameter falling back to `process.cwd()`, with zero manifest dependency. The coupling is entirely in the route.
- **The gate is one expression.** `manifest = getProject(project).manifest`, and `const workspace = manifest.root` then feeds **cwd, guardrails and `settingSources`** for both providers. Those three are exactly the first three fields of the `SessionProfile`, which is why AD-9 calls the profile a refactor of what the handler already computes rather than a new concept.
- **The surrounding state is already profile-ready.** `Chat.project` is optional in core's store; session logs are keyed by `sessionId` only; permissions are string-keyed, so a synthetic key such as `'__master__'` needs no schema change; and the loom and ultra MCP servers dereference project **lazily, inside mutating tools**, so they can be mounted in a project-less session without exploding.
- **The handler is ~103KB.** That size is the argument in AD-9's `Prevents` line: three features accreting conditional branches in one file. Every session kind added as an `if` compounds it.
- **`runCodexTurn` has no MCP plumbing** — its call site passes `prompt, cwd, env, model, reasoningEffort, sandbox, resume, signal, approvalPolicy, onApproval` and nothing else; the Codex driver only *renders* inbound `mcpToolCall` events. CAP-7's `requiredCapabilities` is what turns that into a hard pre-stream error instead of a master session that comes up with no workspace tools and answers "where did I stop" from nothing. Closing the injection gap itself is `SPEC-organization-workspace`'s story, not this one — see that spec's `brownfield.md` for the verified per-invocation injection routes.

## The gaps this SPEC closes

- **`store.ts:8` hardcodes the state root.** `const DIR = path.join(os.homedir(), ".telar")` — no `TELAR_HOME`. Every other module honors it. So `chats.json`, `usage.ndjson` and `plan-usage.json` do **not** isolate when the web `dev` script points `TELAR_HOME` at `~/.telar-dev`. Pre-existing, unrelated to any feature SPEC, and load-bearing the moment CAP-2 touches the ledger — hence CAP-1 before CAP-2.
- **The concurrency gate.** `engine.ts:89-99` — module-private `MAX_CONCURRENT = 4`, class-blind, and able to exceed its own ceiling when an arrival races a release. Full analysis in `admission.md`.
- **`fanoutClamp` cannot express the process ceiling.** `budget.ts` clamps on `maxAgents - inFlight` and budget only, so its `binding` readout ("pool" / "budget" / "pieces") cannot name the constraint that is actually binding.
- **No per-session directory under `TELAR_HOME`.** Session-owned processes have nowhere to lease from — the blocker `SPEC-loom-redesign`'s brownfield names against CAP-11's "one primitive, two lifetimes."
- **No event bus.** Delivery today is per-feature SSE tails plus polling. Ultra's completion wake has no home in that shape: nothing on the client can synthesize a server-side turn.
- **No executable invariant assertions.** "No accept tool anywhere" and "the verifier stack holds no write tools" are true today by construction and by review, but nothing re-checks them. `bun test` (`bun:test`) is the only test tooling and there is **no CI**, so CAP-6's assertions run in the manual pre-commit trio.
- **No session-config abstraction.** There is no `SessionProfile`, no resolver, and no capability declaration — session shape is computed inline from `manifest.root` and branched on where a surface needs something different. Three features are queued to add a fourth, fifth and sixth session kind against that, and `SPEC-organization-workspace`'s story 6 is currently written as *"lift the chat route's project gate"* — the conditional AD-9 forbids. CAP-7 is the mechanism that story must be rewritten against.
- **`toolPolicy` has no type-level guarantee.** The `PreToolUse` hook force-routes loom-affecting calls through an interactive permission card in every SDK permission mode, and that is correct today — but it is correct by placement, not by a type that makes over-granting unrepresentable. CAP-7's intersect-only `toolPolicy` is what keeps that true once session config becomes data.

## Boundaries that bind this work

From `project-context.md` and the architecture spine — not re-decidable here:

- `@telar/core` is server-side only; client components import **types only**. Runtime core code lives in Route Handlers, Server Components and `instrumentation.ts`.
- All server surface is `app/api/**/route.ts` — no `pages/api`, no Server Actions, no `middleware.ts`.
- zod schemas for persisted entities are owned by `@telar/core`; don't redefine shapes in `apps/web`.
- Deterministic control flow in code, intelligence in the leaves. The admission policy is pure for this reason (AD-17 / `admission.md`).
- One owner per `TELAR_HOME` subtree; shared runtime state is written only through its owning core service (AD-5, AD-20).
- The Human-Accept Moat and the Verifier capability wall are non-negotiable — CAP-6 makes them executable, never relaxes them.
- `bun test`, `bun run lint` (web) and `bunx tsc --noEmit` run manually before committing. Note that `bun run lint` currently reports ~77k pre-existing problems in `apps/web`, most of them under `.next-desktop/` build output; it is not a clean baseline and is not this SPEC's to fix.
- TypeScript is not version-unified: core pins `^6.0.3`, web pins `^5`.
