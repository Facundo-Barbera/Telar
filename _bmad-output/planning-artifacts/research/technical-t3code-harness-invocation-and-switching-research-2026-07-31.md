---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
workflowType: 'research'
lastStep: 6
research_type: 'technical'
research_topic: 't3code harness invocation and switching'
research_goals: 'Understand how t3code invokes coding harnesses, enables simple switching between Codex and Claude Code, and exposes ultracode from the app — to inspire a harness-abstraction layer for telar (balanced technical + UX, with a closing telar-mapped recommendations section)'
user_name: 'Facundo'
date: '2026-07-31'
web_research_enabled: true
source_verification: true
---

# Research Report: technical

**Date:** 2026-07-31
**Author:** Facundo
**Research Type:** technical

---

## Research Overview

This research examines **T3 Code** (pingdotgg/t3code) — Theo Browne's open-source "control plane for coding agents" — to understand how it invokes agent harnesses, makes switching between Codex and Claude Code a single-dropdown action, and exposes ultracode from its app. The goal is design inspiration for a harness-abstraction layer in telar, with balanced technical and UX coverage and a closing telar-mapped recommendations section.

The research proceeded in five verified phases: technology stack analysis (what t3code is built with and which harness entry points it uses), integration patterns (the adapter contract, wire protocols, and approval normalization), architectural patterns (the four-layer local-first control plane and its stated trade-offs), implementation research (rollout strategy, compatibility discipline, auth/cost realities), and a final synthesis. All claims were verified against live sources on 2026-07-31, primary sources first, with confidence levels flagged inline.

Headline findings: switching is powered by a canonical provider-neutral event stream plus persisted resume cursors; ultracode is a Claude Code session setting that t3code merely passes through versioned per-provider option schemas; and the architecture independently validates telar's own determinism design law. See the **Executive Summary** in the Research Synthesis section ("From Harness to Control Plane") for the complete findings and recommendations.

---

## Technical Research Scope Confirmation

**Research Topic:** t3code harness invocation and switching
**Research Goals:** Understand how t3code invokes coding harnesses, enables simple switching between Codex and Claude Code, and exposes ultracode from the app — to inspire a harness-abstraction layer for telar (balanced technical + UX, with a closing telar-mapped recommendations section)

**Technical Research Scope:**

- Architecture Analysis - process model around external harnesses (CLI wrapping, PTY, SDK embedding), session lifecycle, harness boundary
- Implementation Approaches - harness abstraction enabling Codex/Claude Code switching, capability normalization, streaming/event unification, auth per harness
- Technology Stack - t3code's own stack, harness entry points used, ultracode trigger path
- Integration Patterns - app↔harness protocols, tool-permission flows, MCP; light comparative scan (opencode, Conductor, Amp)
- Performance Considerations - switching cost, context continuity, concurrency, cost/token implications of ultracode-style orchestration

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights; closing telar mapping section

**Scope Confirmed:** 2026-07-31

## Technology Stack Analysis

### What T3 Code Is (grounding)

T3 Code is an MIT-licensed, open-source "control plane for coding agents" by Theo Browne's team (pingdotgg), positioned as an OSS alternative to the Codex desktop app. It is explicitly **not** an AI engine: "You bring your inference, your subs, your harnesses… and we give you a better interface." It drives locally installed agent CLIs (Codex, Claude Code, Cursor, Grok Build, OpenCode) through their existing authentication, on a bring-your-own-key/subscription model.
_Confidence: High (primary sources — repo, official site, Theo's announcements)_
_Source: https://github.com/pingdotgg/t3code_
_Source: https://t3.codes/_
_Source: https://x.com/theo/status/2054737293186126056_
_Source: https://x.com/theo/status/2030071716530245800_

### Programming Languages

_Primary Language: TypeScript throughout (app, server, adapters)._
_Runtime: Node.js 22.16+ / 23.11+ / 24.10+ required._
_Native mobile code lives in a separate `native/` tree (iOS + Android apps)._
_Notably for telar: same language family as telar's Bun/TypeScript monorepo — patterns port directly._
_Confidence: High_
_Source: https://github.com/pingdotgg/t3code_

### Development Frameworks and Libraries

_Frontend: React with Vite (Vite+ / `vp` CLI) — web app at app.t3.codes plus the same UI packaged in Electron._
_Server: Node.js WebSocket + HTTP server; the browser connects via `ws://localhost:3773`._
_Effect ecosystem (Effect TS) underpins the server: typed services, Effect SQL for persistence, background fibers (e.g., a "Session Reaper" cleaning stale sessions)._
_Harness adapters: per-provider adapter classes (e.g., `ClaudeAdapter.ts` wrapping `@anthropic-ai/claude-agent-sdk`); Codex driven via JSON-RPC over stdio against the Codex App Server._
_Confidence: High for frontend/server/adapters (repo + merged PR #179); Medium for Effect internals (secondary write-ups)_
_Source: https://pingdotgg-t3code.mintlify.app/introduction_
_Source: https://github.com/pingdotgg/t3code/pull/179_
_Source: https://pyshine.com/T3Code-Minimal-Web-GUI-Coding-Agents/_

### Database and Storage Technologies

_Persistence: SQLite stores all session data, thread history, and configuration — conversations survive server restarts and browser refreshes._
_Access layer: Effect's SQL abstractions for type-safe database operations._
_Session model: a "Provider Session Directory" creates isolated per-session contexts (own state, history, provider-specific config); a background Session Reaper prevents resource leaks._
_Confidence: Medium (consistent across secondary sources; not yet verified against repo code)_
_Source: https://pyshine.com/T3Code-Minimal-Web-GUI-Coding-Agents/_

### Development Tools and Platforms

_Monorepo: pnpm workspaces (`apps/`, `packages/`, `native/`, `docs/`, `scripts/`)._
_Build: Vite / Vite+ (`vp` CLI)._
_Distribution: web app, Electron desktop (GitHub releases), iOS App Store / Android Play Store apps; quick start via `npx`; planned `t3code .` project-open command._
_Remote-ready: the same local server can be reached from a phone or another machine._
_Confidence: High_
_Source: https://github.com/pingdotgg/t3code_
_Source: https://betterstack.com/community/guides/ai/t3-code/_

### Harness Entry Points (the layer telar cares about)

_Codex: primary integration — JSON-RPC over stdio against the **Codex App Server**, reusing the user's Codex subscription, plugins, and harness ("built around the Codex App Server so you can use the same harness, plugins, and subscription")._
_Claude Code: dedicated `claudeAgent` provider adapter wrapping `@anthropic-ai/claude-agent-sdk` — streaming, approvals, user-input flows, thinking tokens, resume state, NDJSON event logging. Underlying wire format is Claude Code's `stream-json` NDJSON protocol._
_Cursor / OpenCode / Grok Build: additional adapters (some in progress) — each adapter translates its agent's native protocol into T3 Code's internal representation._
_Auth: none of its own — reuses each CLI's login (`codex login`, Claude login, etc.)._
_Confidence: High (Theo's own description + merged adapter PR)_
_Source: https://x.com/theo/status/2049975633569251550_
_Source: https://github.com/pingdotgg/t3code/pull/179_
_Source: https://dev.to/lynkr/how-to-use-t3-code-with-claude-code-and-an-open-source-llm-gateway-2aek_

### Ultracode (clarified)

_Ultracode is a **Claude Code feature, not a T3 Code feature**: a session setting (`/effort ultracode`) shipped in Claude Code v2.1.154 (May 2026) alongside Opus 4.8, activating xhigh reasoning effort plus automatic dynamic workflow orchestration; older models silently fall back to high._
_T3 Code surfaces this class of control in-app (reasoning-level/effort controls per thread), which is what makes "ultracode from the app" possible — the GUI passes the session setting through its Claude adapter._
_Best suited to codebase-wide audits, large migrations, adversarial reviews; adds latency/cost for everyday edits._
_Confidence: High for what ultracode is; Medium for the exact T3 Code UI pass-through mechanism (to verify in integration-patterns step)_
_Source: https://claudefa.st/blog/guide/development/ultracode_
_Source: https://www.vibecodingacademy.ai/blog/claude-code-ultracode_

### Technology Adoption Trends

_The "GUI over CLI harnesses" category is consolidating fast: T3 Code (25+ agents claimed on some listings, 5 confirmed first-party), plus opencode, Conductor, Amp, and the first-party Codex/Claude desktop apps._
_The pattern that is winning: **do not reimplement the agent** — reuse the user's existing CLI auth and subscription, and speak each harness's native machine protocol (App Server JSON-RPC, Agent SDK / stream-json)._
_Vendor protocols are stabilizing into de-facto integration surfaces: Codex App Server protocol and Claude's Agent SDK are both designed for exactly this kind of third-party frontend._
_Confidence: Medium-High_
_Source: https://betterstack.com/community/guides/ai/t3-code/_
_Source: https://www.aitoolnet.com/t3-code_

## Integration Patterns Analysis

### T3 Code's Adapter Contract (the load-bearing abstraction)

Every harness integration implements one provider adapter contract whose job is to translate the agent's native protocol into a **canonical event stream** (`ProviderRuntimeEvent`). The Claude adapter (`ClaudeCodeAdapter.ts`, ~1,857 lines) demonstrates the full contract:

- _Canonical events: turn lifecycle (`turn.started` / `turn.completed` / `turn.interrupted`), tool execution (`tool.requested` / `tool.started` / `tool.completed`), user interaction (`approval.requested` / `approval.resolved`), and `provider_error` with message/detail payloads._
- _Registration & routing: adapters register in a `ProviderAdapterRegistry`; a `ProviderService` owns session lifecycle plus checkpoint capture/revert (thread rollback)._
- _Streaming: the SDK stream runs in a managed Effect fiber (`Effect.forkChild`) feeding a queue; session stop is an explicit `Fiber.interrupt`, and interruption is normalized into a completed-interrupted turn — never a dangling state._
- _Interrupts, approvals, user-input requests, resume cursors, and rollback are all first-class in the contract — not per-harness special cases._
_Confidence: High (merged PR #179 with implementation detail)_
_Source: https://github.com/pingdotgg/t3code/pull/179_

### Wire Protocol: Codex App Server (JSON-RPC over stdio)

_Transport: newline-delimited JSON-RPC 2.0 over stdio (omitting the `jsonrpc` field); the app-server component also supports WebSocket and remote-control transports._
_Lifecycle: `initialize`/`initialized` handshake → `thread/start` (conversation session) → `turn/start` (user input triggers agent work) → streamed notifications (`item/agentMessage/delta`, `item/commandExecution/outputDelta`, …)._
_Approvals are **server→client JSON-RPC requests**: `applyPatchApproval { conversationId, callId, fileChanges, reason?, grantRoot? }` and `execCommandApproval { conversationId, callId, command, cwd, reason? }`, answered with `accept`, `acceptForSession`, `decline`, `cancel`, or an execpolicy amendment._
_This is OpenAI's official integration surface — "the protocol that powers every surface" (Codex CLI, IDE extension, desktop app), which is why T3 Code could build on it and inherit the full harness, plugins, and subscription._
_Confidence: High (official docs + OpenAI engineering post)_
_Source: https://developers.openai.com/codex/app-server_
_Source: https://openai.com/index/unlocking-the-codex-harness/_
_Source: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md_
_Source: https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/_

### Wire Protocol: Claude Code (Agent SDK, in-process)

_T3 Code's Claude integration embeds `@anthropic-ai/claude-agent-sdk` in the Node server process (same pattern telar uses) rather than shelling out to raw `claude --output-format stream-json`; the SDK manages the NDJSON stream underneath._
_Permission flow: the SDK's `canUseTool` runtime callback (tool name + input + context → `{behavior: "allow"}` / `{behavior: "deny", message}`), plus `PreToolUse` hooks that can return `permissionDecision: "defer"` producing `stop_reason: "tool_deferred"` — resumable later with the same `session_id`._
_Streaming input mode is used for conversational UIs where the user interacts mid-execution, not only at approval checkpoints._
_Confidence: High (official SDK docs + PR #179)_
_Source: https://code.claude.com/docs/en/agent-sdk/typescript_
_Source: https://code.claude.com/docs/en/sdk/sdk-permissions_
_Source: https://platform.claude.com/docs/en/agent-sdk/user-input_

### Approval & Permission Normalization (the hardest unification)

The two harnesses have structurally different approval models — Codex sends *server→client RPC requests*; Claude Code invokes *in-process callbacks* — and T3 Code normalizes both into the same `approval.requested` / `approval.resolved` canonical events:

- _Pending approvals are tracked as **deferreds** in session context; the UI resolves them; user cancellation returns an explicit deny to the harness; stale approvals are cleared on restart (fail-closed)._
- _The UI-level "Runtime Modes" (Full Access vs Supervised) then map onto each harness's native permission mode, so the user-facing model stays harness-independent._
_Confidence: High for the mechanism (PR #179); Medium for exact mode-mapping details_
_Source: https://github.com/pingdotgg/t3code/pull/179_
_Source: https://pingdotgg-t3code.mintlify.app/introduction_

### Frontend ↔ Server Protocol and State Projection

_Browser/desktop/mobile clients connect to the local Node server over WebSocket (`ws://localhost:3773`); the canonical event stream is projected to the UI, with SQLite as the durable record — so any client (including a phone) can attach to the same threads._
_Derived state flows through projection/snapshot layers (e.g., an in-flight turn's proposed plan is surfaced via projection rather than ad-hoc UI state)._
_Confidence: Medium-High_
_Source: https://pingdotgg-t3code.mintlify.app/introduction_
_Source: https://github.com/pingdotgg/t3code/pull/179_

### Session Continuity and Switching

_Resume: a persisted `resumeCursor` per thread/provider survives server restarts; restarting the same thread+provider reuses it; **model-only changes preserve resume state** — this is what makes the "switch model in a dropdown" UX cheap._
_Switching **providers** mid-thread is a new provider session against the same thread history (the canonical event stream is provider-neutral, so the transcript carries over even though the harness-native session does not)._
_Confidence: High for resume mechanics; Medium for cross-provider transcript handling details_
_Source: https://github.com/pingdotgg/t3code/pull/179_
_Source: https://betterstack.com/community/guides/ai/t3-code/_

### Effort / Ultracode Pass-Through

_Per-provider option schemas are part of the adapter contract: `ClaudeModelOptions` includes effort levels (`normal` / `extended` / `ultrathink`), a `thinking` flag, and `fastMode`; the UI composes them via a `ClaudeTraitsPicker` with a **versioned options schema (v2) and migration from legacy fields** — options evolve per harness without breaking stored threads._
_"Ultracode from the app" is therefore just an option value flowing through the adapter into the Claude Code session (`/effort`-class setting) — no orchestration logic lives in T3 Code itself; Claude Code's own dynamic workflow orchestration does the heavy lifting._
_Note: the PR names `ultrathink`, while current Claude Code exposes `ultracode`; naming likely tracks harness versions — flag for verification against latest release._
_Confidence: High for the pass-through pattern; Medium on exact current option names_
_Source: https://github.com/pingdotgg/t3code/pull/179_
_Source: https://claudefa.st/blog/guide/development/ultracode_

### MCP and Tool Extension

_Both integration surfaces natively support MCP configuration (Codex app-server exposes MCP tool management; the Agent SDK accepts MCP server config), and T3 Code passes MCP server connections through to the harnesses rather than implementing its own tool runtime._
_Confidence: Medium_
_Source: https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md_
_Source: https://betterstack.com/community/guides/ai/t3-code/_

### Comparative Scan: Three Ways to Sit on Top of Harnesses

- _**Speak the vendor's machine protocol** (T3 Code): per-harness adapters over App Server JSON-RPC / Agent SDK; maximum fidelity, adapter maintenance cost per harness._
- _**Expose your own server API** (opencode): the harness itself runs in server mode with an OpenAPI-specified HTTP API + generated TypeScript SDK + plugin lifecycle hooks; frontends are thin clients. This inverts T3 Code's model — the harness is the platform._
- _**Own the whole harness** (Amp/Sourcegraph): one vendor controls agent + clients; no switching story by design._
- _**Conductor (conductor.build)** is the closest UX comparison for parallelism: a free Mac app running parallel Claude Code and Codex agents, each in an isolated git worktree (own branch, files, terminal, diff, review path), bring-your-own-subscription — worktree isolation as the concurrency primitive rather than protocol unification._
- _Also notable: rivet-dev/sandbox-agent normalizes Claude Code, Codex, OpenCode, and Amp behind one HTTP API in sandboxes — evidence the "adapter over harness" pattern is generalizing._
_Confidence: High for opencode/Conductor (official docs/sites); Medium for Amp positioning_
_Source: https://opencode.ai/docs/sdk/_
_Source: https://open-code.ai/en/docs/server_
_Source: https://docs.conductor.build/_
_Source: https://www.conductor.build/_
_Source: https://github.com/rivet-dev/sandbox-agent_

## Architectural Patterns and Design

### System Architecture: Four-Layer Local-First Control Plane

T3 Code's first-party docs describe a strict four-layer separation:

1. _**Frontend** — React in browser or Electron window, persistent WebSocket to the local server. **No direct filesystem or model access.**_
2. _**Node server (port 3773)** — the orchestration layer: sessions, thread state, git operations, project registry, provider subprocess lifecycle._
3. _**Provider subprocess/runtime** — provider CLIs launched as subprocesses (`codex app-server` over JSON-RPC/stdio) or embedded SDK (Claude); native events translated into the app's orchestration model._
4. _**Model provider** — OpenAI/Anthropic/etc., reached only through the provider's own CLI/SDK with the user's existing credentials. "T3 Code has no model access of its own. Authentication is entirely the CLI's."_

_Confidence: High (first-party architecture docs)_
_Source: https://t3codedocs.com/docs/architecture/_

### Design Principles and Stated Trade-offs

- _**Wrap, don't reimplement**: providers are adapters over existing CLIs. Benefits stated explicitly: new provider features arrive automatically, existing authentication carries over unchanged, and users keep terminal-level escape hatches._
- _**The acknowledged cost is coupling**: T3 Code inherits breaking changes from downstream provider CLIs — version compatibility is called out as critical for stability (and the project itself warns it is "in very early development")._
- _**Deterministic orchestration around intelligent leaves**: long-running async flows (runtime ingestion, command reaction, checkpoint processing) run as **queue-backed workers**, keeping work ordered and reducing timing races — the intelligence stays in the harness; the control plane stays deterministic. This is structurally the same design law telar already enforces (`tick()`/`decide()` purity, LLM calls only in schema-forced leaves)._
- _**Versioned per-provider option schemas** with migrations decouple UI evolution from harness evolution._
_Confidence: High_
_Source: https://t3codedocs.com/docs/architecture/_
_Source: https://github.com/pingdotgg/t3code/pull/179_

### Scalability and Performance Patterns

_Concurrency primitive: session isolation (Provider Session Directory) plus git worktrees for parallel file work; a background Session Reaper bounds resource leaks._
_Ordering primitive: queue-backed workers rather than ad-hoc async — races are designed out, not debugged out._
_Read-path: SQLite as durable record with projection/snapshot layers, so derived UI state (diffs, in-flight plans) is cheap to serve to any number of attached clients._
_Resume cursors avoid replaying entire harness sessions on restart or model change._
_Confidence: Medium-High_
_Source: https://t3codedocs.com/docs/architecture/_
_Source: https://pyshine.com/T3Code-Minimal-Web-GUI-Coding-Agents/_

### Security Architecture Patterns

_Credential posture: T3 Code holds **zero** provider credentials — auth lives entirely in each harness CLI's own login state. Nothing to leak, rotate, or store._
_Capability posture: the frontend cannot touch the filesystem or models; every effect is mediated by the server layer._
_Runtime modes: Full Access (agent reads/writes without prompting) vs Supervised (approval for each action) — documented with per-repository risk guidance._
_Approval hygiene: pending approvals are deferreds cleared fail-closed on restart; cancellation returns explicit deny._
_Remote access is deliberately loopback-first: the desktop SSH launcher writes a script under `~/.t3/ssh-launch/<host-key>/`, starts or reuses a remote T3 server, and **forwards the remote loopback port** back to the desktop; LAN/Tailscale/HTTPS environments use the same paired-environment model — the server is never naively exposed._
_Confidence: High_
_Source: https://t3codedocs.com/docs/architecture/_
_Source: https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md_

### Data Architecture Patterns

_System of record: SQLite (sessions, threads, configuration) — survives restarts and refreshes; all clients project from it._
_Event-sourced flavor without full CQRS ceremony: canonical provider events are ingested, stored, and projected; snapshots serve current state; NDJSON event logs aid debugging._
_Checkpoints: capture/revert around turns enables thread rollback — state history is a first-class feature, not an afterthought._
_Confidence: Medium-High_
_Source: https://github.com/pingdotgg/t3code/pull/179_
_Source: https://pyshine.com/T3Code-Minimal-Web-GUI-Coding-Agents/_

### Deployment and Operations Architecture

_Distribution: `npx` quick start, Electron desktop via GitHub releases, iOS/Android store apps — all thin clients over the same local server._
_The local server doubles as the remote server: phone → (SSH tunnel / Tailscale / LAN) → the same port-3773 process. One deployment story for every surface._
_Confidence: High_
_Source: https://github.com/pingdotgg/t3code_
_Source: https://t3codedocs.com/docs/mobile/_

### The Standardization Alternative: Agent Client Protocol (ACP)

A key architectural fork-in-the-road for anyone building this layer today:

- _**ACP** (Zed Industries, Aug 2025) is an open JSON-RPC 2.0-over-stdio standard for editor↔agent integration — "the LSP for coding agents" — adopted by JetBrains, Google, GitHub, and 25+ agents, with `claude-agent-acp` and `codex-acp` adapters and a public agent registry (Jan 2026)._
- _ACP turns the N×M integration matrix into N+M: implement one client, get every ACP agent._
- _T3 Code deliberately chose **native protocols instead** (App Server, Agent SDK) — higher fidelity access to harness-specific features (effort/traits, checkpoints, plugins, subscriptions) at the cost of one adapter per harness. ACP is the lowest-common-denominator counter-position._
_Confidence: High_
_Source: https://zed.dev/acp_
_Source: https://blog.marcnuri.com/agent-client-protocol-acp-introduction_
_Source: https://www.morphllm.com/agent-client-protocol_

## Implementation Approaches and Technology Adoption

### Technology Adoption Strategies

_T3 Code's provider rollout was **adapter-at-a-time**: Codex first (deepest integration, built on the official App Server), then Claude Code (PR #179), then Cursor, OpenCode, and Grok Build. Grok Build launched May 2026 and was integrated within weeks — evidence that once the canonical event contract exists, new harnesses are cheap to absorb._
_User adoption path is deliberately zero-friction: `npx` to run, existing CLI logins for auth, `npx t3 pair` (QR code) for mobile pairing, bring-your-own subscription throughout._
_Confidence: High_
_Source: https://github.com/pingdotgg/t3code/releases_
_Source: https://www.basenor.com/blogs/news/grok-now-works-inside-t3code-for-supergrok-and-x-subscribers_
_Source: https://github.com/pingdotgg/t3code/issues/539_

### Development Workflows and Tooling

_Release engineering: **nightly releases, several per day** (`0.0.32-nightly.YYYYMMDD.build`), all flagged pre-release; self-update with rollback protection; GPG-signed commits; CI with fixture rotation._
_A notable schema-evolution tactic: **forward-compatible config union decoding** — old clients tolerate unknown config variants instead of crashing, letting the config schema grow without lockstep upgrades._
_Confidence: High_
_Source: https://github.com/pingdotgg/t3code/releases_

### Testing and Quality Assurance

_Adapter behavior is tested at the contract level: PR #179 ships tests specifically covering restart and resume patterns (fresh session vs reused `resumeCursor`, model-only changes preserving state)._
_Observability doubles as QA: NDJSON event logging of every provider event gives replayable traces of harness behavior._
_On the Codex side, the recommended practice is **generated, version-pinned protocol schemas**: TypeScript/JSON Schema artifacts are generated from the exact Codex binary in use and must be regenerated after every upgrade to surface protocol breaking changes at compile time. Integrators can also set `experimentalApi: false` to stay on the stable API surface._
_Confidence: High_
_Source: https://github.com/pingdotgg/t3code/pull/179_
_Source: https://developers.openai.com/codex/app-server_
_Source: https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/_

### Deployment and Operations Practices

_Operations are intentionally thin: one local Node process serves every client surface; remote access reuses the same process over SSH loopback forwarding or Tailscale; the Session Reaper and queue-backed workers are the only "ops" machinery, and there is no cloud footprint to maintain._
_The Codex App Server, though still marked experimental in places, is proven at scale — OpenAI's own VS Code extension (tens of thousands of developers) relies on it exclusively, and OpenAI states the protocol is evolved backward-compatibly as a platform surface._
_Confidence: High_
_Source: https://t3codedocs.com/docs/architecture/_
_Source: https://openai.com/index/unlocking-the-codex-harness/_

### Cost, Auth, and Subscription Reality (load-bearing for telar)

_The entire value proposition rides on **subscription reuse instead of metered API keys** — and the policy ground here is actively shifting:_
- _Anthropic introduced a monthly **Agent SDK credit** (effective June 15, 2026): $20 Pro / $100 Max 5X / $200 Max 20X, explicitly covering Agent SDK usage, `claude -p`, **and third-party apps built on the Agent SDK**; exhausted credit falls back to pay-as-you-go API rates if "extra usage" is enabled._
- _Separately, Anthropic **prohibited subscription OAuth tokens in third-party products outside Claude Code and claude.ai** — with a turbulent sequence (ban announced → enforcement paused → third-party agent usage reinstated "with a catch"). The practical reading: third-party Agent SDK apps are sanctioned via the SDK credit path; raw OAuth token reuse is not._
- _Ultracode economics: xhigh reasoning + dynamic orchestration is priced for audits/migrations/adversarial reviews, and explicitly not for everyday edits — surfacing it as an opt-in per-thread trait (as T3 Code does) is the right cost control._
_Confidence: Medium — policy is in flux; sources conflict across months; re-verify before building on it_
_Source: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan_
_Source: https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/_
_Source: https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch_
_Source: https://zed.dev/blog/anthropic-subscription-changes_
_Source: https://claudefa.st/blog/guide/development/agent-sdk-credit_

### Risk Assessment and Mitigation

- _**Harness CLI coupling** (t3code's own stated top risk): mitigated by version-pinned generated schemas, the stable-API capability flag, forward-compatible decoding, and a nightly cadence that absorbs churn in small increments._
- _**Auth-policy risk**: a provider can re-draw the line on subscription usage at any time (Anthropic already did, twice); mitigation is supporting both subscription-credit and API-key auth paths per account._
- _**Early-stage instability**: t3code self-describes as early with breaking changes expected; pin versions when depending on it as a reference._
- _**Protocol divergence**: per-harness native adapters accumulate maintenance; ACP is the standardization hedge if/when fidelity gaps close._
_Confidence: Medium-High_
_Source: https://t3codedocs.com/docs/architecture/_
_Source: https://pingdotgg-t3code.mintlify.app/introduction_

## Technical Research Recommendations

### Implementation Roadmap (telar-shaped)

1. _**Define a `HarnessPort` in `@telar/core`**: a canonical event vocabulary modeled on `ProviderRuntimeEvent` — turn lifecycle, tool execution, approval request/resolve, provider error — as core-owned zod schemas (consistent with telar's rule that persisted-entity schemas live in core)._
2. _**Refactor the existing Agent SDK usage into a `ClaudeHarnessAdapter`** implementing that port. `accountEnv()` stays exactly where it is — adapters receive resolved env per account; the CLIENT-BUNDLE rule is untouched (adapters are server-side core code)._
3. _**Add a `CodexHarnessAdapter`** as a `codex app-server` subprocess speaking newline-delimited JSON-RPC over stdio, with version-pinned generated schemas and `experimentalApi: false`._
4. _**Persist per-thread `{provider, resumeCursor}`** in the loom manifest (atomic-write idiom): model-only changes keep the cursor; provider switches start a fresh harness session against the provider-neutral thread history._
5. _**Route both approval models through the existing permission card**: Claude's `canUseTool`/PreToolUse flow and Codex's `applyPatchApproval`/`execCommandApproval` server→client requests normalize into one approval event — the Human-Accept Moat and the interactive card already model this correctly. Pending approvals as deferreds, cleared fail-closed on restart._
6. _**Expose per-provider option schemas** (versioned, with migrations) in the web UI for effort/thinking/fast-mode traits — ultracode-class settings become a pass-through option value, not new orchestration code in telar._

### Technology Stack Recommendations

- _Stay on Bun + TypeScript; no need for Effect — telar's pure-function control flow with injected seams already provides the determinism Effect gives t3code; queue-backed ordering can be a small core utility._
- _Keep filesystem-backed state (atomic writes) as system of record; add an NDJSON per-thread event journal for adapter observability before considering SQLite._
- _Verifier capability wall generalizes per-adapter: the deny-list of write tools must be enforced in **every** adapter's session options, so a passing verdict stays un-self-issuable on any harness._

### Skill Development Requirements

- _JSON-RPC-over-stdio subprocess management (spawning, framing, backpressure, crash recovery) — new surface relative to telar's current in-process SDK usage._
- _Codex App Server protocol + its schema-generation tooling; ACP literacy as a strategic hedge._

### Success Metrics and KPIs

- _Harness switch is one UI action; thread history survives the switch._
- _Zero provider credentials stored by telar itself (auth remains harness-owned, per account)._
- _Adapter conformance suite (shared contract tests run against both adapters) stays green across harness version bumps._
- _Approval parity: no harness reaches a loom-affecting action without the interactive card; `ready → done` remains human-only on every provider._

---

# From Harness to Control Plane: T3 Code's Harness Invocation Model and What Telar Should Steal

## Executive Summary

T3 Code answers a question the whole industry converged on in 2026: when every vendor ships a capable agent CLI, the differentiating layer is no longer the agent — it is the **control plane** that drives many agents through one coherent interface. Harness engineering is now described as the third phase of AI engineering maturity (after prompt and context engineering), and analyses attribute the majority of enterprise agent failures to harness-layer defects rather than model quality. T3 Code's bet — wrap existing harnesses rather than reimplement them, normalize their native protocols into one canonical event stream, and hold zero credentials of its own — has proven out across five providers in under a year with a team of two primary developers.

The mechanics are directly transferable to telar. The "simple switching" Facundo admired is three specific decisions compounding: (1) a provider-neutral canonical event vocabulary (`ProviderRuntimeEvent`) that stops harness differences at the adapter boundary; (2) persisted per-thread resume cursors that make model changes free and provider changes cheap; (3) per-provider **versioned option schemas** so harness-specific capabilities (effort levels, thinking, fast mode) pass through the UI without new orchestration code — which is all "ultracode from the app" actually is, since ultracode is a Claude Code session setting, not a T3 Code feature.

**Key Technical Findings:**

- Four-layer architecture with hard capability boundaries: UI (no fs/model access) → Node orchestration server → provider adapter (subprocess JSON-RPC or embedded SDK) → model provider via the user's own credentials
- Approval unification is the hardest and most valuable normalization: Codex's server→client RPC approvals and Claude's in-process `canUseTool` callbacks both become deferred-backed approval events, cleared fail-closed on restart
- Determinism is engineered the same way telar's design law prescribes: queue-backed workers for ordering, intelligence only in harness leaves
- The main cost is coupling: t3code names inherited CLI breaking changes as its top stability risk, mitigated by version-pinned generated schemas and stable-API capability flags
- The strategic landscape offers three integration postures: native protocols (t3code — highest fidelity), the ACP standard (N+M instead of N×M), and SDK-level meta-harnesses (Vercel AI SDK v7's HarnessAgent API)

**Technical Recommendations (top level):**

1. Build a core-owned `HarnessPort` with canonical zod event schemas; wrap current Agent SDK usage as the first adapter
2. Add Codex via the App Server protocol with version-pinned generated schemas and `experimentalApi: false`
3. Normalize both approval models through telar's existing permission card — the moat generalizes per-adapter
4. Persist `{provider, resumeCursor}` per thread; treat effort/ultracode as pass-through option values
5. Support both subscription-credit and API-key auth paths per account; re-verify Anthropic's third-party policy before shipping

## Table of Contents

1. Technical Research Introduction and Methodology
2. Technical Landscape and Architecture Analysis
3. Implementation Approaches and Best Practices
4. Technology Stack Evolution and Current Trends
5. Integration and Interoperability Patterns
6. Performance and Scalability Analysis
7. Security and Compliance Considerations
8. Strategic Technical Recommendations (Telar Mapping)
9. Implementation Roadmap and Risk Assessment
10. Future Technical Outlook
11. Research Methodology and Source Verification
12. Appendix: Reference Materials

## 1. Technical Research Introduction and Methodology

### Significance

The 2026 tooling landscape treats the harness — not the model — as the production-quality determinant: harness configuration alone swings benchmarks by multiple percentage points, and "teams that run multiple harnesses will want a single control plane" is now conventional wisdom. T3 Code is the highest-profile open-source implementation of that control plane, making it the right reference architecture for telar's multi-harness ambitions.
_Source: https://www.faros.ai/blog/harness-engineering_
_Source: https://medium.com/@adnanmasood/agent-harness-engineering-the-rise-of-the-ai-control-plane-938ead884b1d_

### Methodology

- **Scope**: t3code deep dive (stack, integration patterns, architecture, implementation practices) + light comparative scan (opencode, Conductor, Amp, ACP), balanced technical/UX, closing telar mapping
- **Sources**: primary first (repo, first-party architecture docs, merged PRs, official protocol docs, vendor announcements), secondary for corroboration; ~14 web searches and 6 page fetches across steps 2–6
- **Verification**: multi-source validation for critical claims; explicit confidence levels on every section; conflicts (e.g., Anthropic auth policy) reported rather than smoothed over
- **Currency**: all data gathered 2026-07-31 against live sources

### Goals and Achievement

**Original goals:** understand harness invocation, Codex/Claude switching, and in-app ultracode — for telar inspiration. **All three achieved**: invocation mechanics documented at protocol level (sections above), switching explained as resume-cursor + canonical-events design, and ultracode demystified as a pass-through Claude Code session setting.

## 2. Technical Landscape and Architecture Analysis

The synthesis of steps 2–4: T3 Code is a **local-first, four-layer control plane** — thin multi-platform clients over WebSocket, a Node orchestration server, per-provider adapters, and the user's own harnesses underneath. Two principles carry the design: *wrap, don't reimplement* (features and auth arrive free; coupling is the accepted price) and *deterministic control plane, intelligent leaves* (queue-backed workers; no LLM decisions in orchestration code). The architecture independently converges on telar's existing design law, which is strong external validation.
_Details: see "Architectural Patterns and Design" above._

## 3. Implementation Approaches and Best Practices

Adapter-at-a-time rollout (Codex → Claude → Cursor/OpenCode/Grok Build) proved the contract absorbs new harnesses in weeks. Engineering practices worth copying: contract-level adapter tests (restart/resume), NDJSON event journals as replayable traces, version-pinned protocol schema generation, forward-compatible config decoding, nightly pre-release cadence.
_Details: see "Implementation Approaches and Technology Adoption" above._

## 4. Technology Stack Evolution and Current Trends

TypeScript/Node monorepo, React+Vite, Effect TS server, SQLite persistence, Electron + native mobile clients. Trend-wise, the category has consolidated on *reuse the user's harness, speak vendor machine protocols*; opencode (165k+ stars) shows the inverse model (harness-as-platform) also thriving.
_Details: see "Technology Stack Analysis" above._

## 5. Integration and Interoperability Patterns

Three viable postures, in fidelity order: **native protocols** (Codex App Server JSON-RPC/stdio + Claude Agent SDK — t3code's choice, and telar's natural fit given existing SDK usage), **ACP** (JSON-RPC standard, 25+ agents, JetBrains/Google/GitHub adoption — the N+M hedge), and **SDK meta-harnesses** (Vercel AI SDK v7 `HarnessAgent`, June 2026 — one programmatic interface over Claude Code/Codex/Pi). The approval-flow normalization is the differentiating engineering work in all three.
_Details: see "Integration Patterns Analysis" above._
_Source: https://www.thetoolnerd.com/p/10-agent-harnesses-every-ai-builder_

## 6. Performance and Scalability Analysis

Scalability here means concurrent sessions, not throughput: session isolation + git worktrees for parallel work, a Session Reaper bounding leaks, queue-backed workers eliminating races, SQLite projections keeping N attached clients cheap, resume cursors avoiding session replay. Switching cost is deliberately asymmetric: model switch ≈ free (cursor preserved); provider switch = new harness session over preserved thread history.

## 7. Security and Compliance Considerations

The credential posture is the headline: **the control plane holds nothing** — auth lives in each harness CLI. Capability boundaries (UI cannot touch fs/models), supervised vs full-access modes, fail-closed approval cleanup, and loopback-only remote access complete the picture. The compliance risk is Anthropic's evolving third-party subscription policy (Agent SDK credits sanctioned; raw OAuth reuse banned→paused→conditionally reinstated) — flagged medium-confidence and re-verify-before-build.
_Details: see "Cost, Auth, and Subscription Reality" above._

## 8. Strategic Technical Recommendations (Telar Mapping)

The consolidated mapping (full detail in "Technical Research Recommendations" above):

| T3 Code concept | Telar landing zone |
| --- | --- |
| `ProviderRuntimeEvent` canonical stream | New `HarnessPort` in `@telar/core` (core-owned zod schemas) |
| `ClaudeCodeAdapter` over Agent SDK | Refactor of existing `engine.ts` Agent SDK usage; `accountEnv()` unchanged |
| Codex App Server subprocess | New `CodexHarnessAdapter` (JSON-RPC/stdio, pinned schemas) |
| Approval deferreds → UI | Existing `PreToolUse` permission card; moat enforced per-adapter |
| Resume cursors per thread/provider | Loom manifest additions via atomic-write idiom |
| `ClaudeTraitsPicker` versioned options | Per-provider option schemas in web UI; ultracode = option value |
| Verifier analogue | Capability wall becomes per-adapter deny-lists — verdicts stay un-self-issuable on every harness |

Competitive angle: telar's moat (structural human-accept, capability-walled verification) is precisely what generic control planes lack — adding multi-harness support without weakening it would be a genuinely differentiated position.

## 9. Implementation Roadmap and Risk Assessment

Phasing: port definition → Claude adapter refactor (behavior-preserving) → Codex adapter → switching UX → trait pass-through. Top risks: harness CLI breaking changes (pin + regenerate schemas; conformance suite), auth-policy drift (dual auth paths), scope creep into reimplementing harness features (resist — pass through instead).
_Details: see "Implementation Roadmap (telar-shaped)" and "Risk Assessment and Mitigation" above._

## 10. Future Technical Outlook

- **Near-term (6–12 mo)**: ACP registry growth and adapter maturity may close the fidelity gap with native protocols; watch `claude-agent-acp` / `codex-acp` feature parity. Anthropic's subscription policy should stabilize around the Agent SDK credit model.
- **Medium-term**: portable agent skills across harnesses and SDK-level meta-harnesses (HarnessAgent) suggest the adapter layer itself may commoditize — the durable value moves up-stack to orchestration guarantees (exactly telar's loom lifecycle) and down-stack to verification integrity.
- **Signal to monitor**: OpenAI evolving the App Server as a backward-compatible platform surface implies vendor machine protocols are becoming stable public APIs — betting on them is getting safer.
_Source: https://www.faros.ai/blog/harness-engineering_
_Source: https://zed.dev/acp_

## 11. Research Methodology and Source Verification

**Primary sources**: pingdotgg/t3code repo + releases + PR #179; t3codedocs.com architecture/remote-access/mobile docs; pingdotgg-t3code.mintlify.app; developers.openai.com Codex App Server docs; openai/codex repo docs; code.claude.com Agent SDK docs; support.claude.com; zed.dev/acp; opencode.ai docs; conductor.build docs; Theo's announcements (x.com).
**Secondary sources**: Better Stack, PyShine, DEV Community, The New Stack, VentureBeat, claudefa.st, Marc Nuri, Morph, basenor, knightli, faros.ai, thetoolnerd, adnanmasood (Medium).
**Search queries used**: 14 distinct queries across discovery, protocol, policy, comparative, and trend dimensions (steps 2–6).
**Confidence framework**: High = primary/official or multi-source corroborated; Medium = secondary-only or in-flux (Effect internals, exact option naming, Anthropic policy state). **Known limitations**: no direct source-code audit of the t3code repo; SQLite/Effect details unverified against code; policy findings dated 2026-07-31 and volatile.

## 12. Appendix: Reference Materials

**Integration posture comparison:**

| Posture | Example | Integrations cost | Fidelity | Switching UX |
| --- | --- | --- | --- | --- |
| Native protocols per harness | T3 Code | N adapters | Full (traits, checkpoints, plugins, subs) | Dropdown, mid-thread |
| Standard protocol | ACP (Zed) | 1 client | Common denominator | Any ACP agent |
| SDK meta-harness | Vercel HarnessAgent | 1 API | SDK-defined | Programmatic |
| Own the harness | Amp | 0 (closed) | Total | None |
| Worktree parallelism | Conductor | Per-harness | n/a (UI-level) | Parallel, not switched |

**Key open-source references**: pingdotgg/t3code (MIT), openai/codex (app-server), sst/opencode, rivet-dev/sandbox-agent, agentclientprotocol registry.

---

## Technical Research Conclusion

**Summary**: T3 Code's harness invocation model is a disciplined ports-and-adapters architecture over vendor machine protocols, with the clever parts concentrated in approval normalization, resume-cursor continuity, and versioned option pass-through. Nothing in it is magic; all of it is portable to telar.

**Strategic impact**: telar can adopt multi-harness switching without touching its two non-negotiable invariants — the Human-Accept Moat and the Verifier capability wall generalize naturally to per-adapter enforcement, and t3code's own architecture independently validates telar's determinism design law.

**Next steps**: (1) re-verify the Anthropic third-party auth policy at implementation time; (2) spike the `HarnessPort` schema against the existing Claude flow; (3) evaluate `codex app-server` hands-on with generated schemas before committing to the adapter; (4) track ACP quarterly as the potential consolidation path.

---

**Technical Research Completion Date:** 2026-07-31
**Research Period:** current comprehensive technical analysis (sources accessed 2026-07-31)
**Source Verification:** all technical claims cited inline with confidence levels
**Technical Confidence Level:** High overall; Medium flagged where noted (policy state, unverified internals)

_This comprehensive technical research document serves as an authoritative technical reference on t3code harness invocation and switching, and provides strategic technical insights for telar's harness-abstraction decisions._
