export * from "./schemas";
export * from "./providers";
export * from "./claude-runtime";
// The provider-neutral harness contract: one event vocabulary and one tool
// shape that both the Claude Agent SDK adapter and the Codex app-server
// adapter speak. Exported beside providers.ts because the two are halves of
// one statement — providers.ts says what a harness CAN do, harness-port.ts
// says what it says while doing it.
export * from "./harness-port";
// How much the agent may do on its own — one enum, translated per harness.
// Beside harness-port.ts because they answer adjacent halves of the same
// question: the port says what a harness CAN do, runtime-mode says how much of
// it the human has agreed to let it do without asking.
export * from "./runtime-mode";
export * from "./secrets";
export * from "./mcp";
export * from "./mcp-oauth";
export * from "./accounts";
// Provider DETECTION, which is all Telar does about identity now. There is no
// login driver: the app reads what the machine already has (is the CLI
// installed, which version, which plan is signed in) and never spawns an auth
// flow of its own. `providers.loginArgs` survives as the text of a command we
// tell the user to run themselves — never one we run for them.
export * from "./detect";
// Who is signed in on an account, read from Claude's `.claude.json` profile
// block — a config file, never a credential. See the module header.
export * from "./account-identity";
export * from "./engine";
// AD-17 — the one admission controller for agent() concurrency: the single
// visible process ceiling (TELAR_MAX_AGENTS) and its per-class shares. Exported
// so a surface can render admissionSnapshot() instead of guessing why a fan-out
// is queued; the package exports only ".", so the barrel is this port's only
// route to apps/web.
export * from "./admission";
// AD-14/AD-21 — the one typed, in-process event bus. Every event carries a
// delivery class as a REQUIRED field, and a published name is part of its
// module's port contract: undeclared events are internal and nobody may
// subscribe to them.
export * from "./event-bus";
// AD-9/AD-10/AD-11 — the one session-profile port. Session config is a profile
// resolved BEFORE the route body, never another branch through the handler: a
// new surface adds a profile, it does not add an `if`. The moat sits OUTSIDE
// the profile — no field here can reach hook registration, and toolPolicy is
// intersect-only by its own type — and a capability the provider port does not
// publish is a hard error before the stream opens, never a silent degradation.
// Story 2.2 made that true of the chat route that exists, and added the three
// symbols the migration needed on this side of the boundary: resolveSessionKind
// (the route's own escalation > steerer > planner > project precedence, as an
// ordered fold), sessionRoleFromWire (the one home for "which strings are
// session roles"), and LOOM_AUTO_TOOL_NAMES / ULTRA_AUTO_TOOL_NAMES, which grow
// BASE_ALLOWED_TOOLS to the full auto-run vocabulary so a profile's `allow` can
// name every tool the route grants. A star export, so every one of them travels
// — and the package exports only ".", which makes this barrel the port's only
// route to apps/web.
export * from "./session-profile";
export * from "./manifest";
// AD-18/AD-20 — the one append-only spend ledger and its sole writer. The
// package exports only ".", so the barrel is this port's only route to apps/web.
export * from "./usage-ledger";
export * from "./servers";
export * from "./watches";
export * from "./gates";
export * from "./run-server";
export * from "./supervisor";
export * from "./looms";
export * from "./executor";
export * from "./budget";
// Named (not `export *`) re-export: tick.ts's weaver-level `Decision`
// (schedule/repair/escalate/finish-loom/hold) would otherwise collide with
// executor.ts's leaf-loop `Decision` (retry/verify/etc) in this barrel.
// executor.ts stays untouched, so the ambiguity is resolved here.
// Kept as `OrchestratorDecision` (not `WeaverDecision`) — apps/web imports
// this exported alias (decision-log.tsx); renaming it is a cross-package
// breaking change out of scope for this core-only, behavior-preserving pass.
export type {
  ThreadView,
  LedgerView,
  Decision as OrchestratorDecision,
  Rationale,
  BudgetSnapshot,
  TickResult,
} from "./tick";
export { readySubGoals, readyItems, validateDecision, tick, EST_COST_PER_AGENT } from "./tick";
export * from "./weave";
export * from "./weave-contracts";
// M11.0 — the PURE deliverable signal (pre-flight proceed-and-defer; reused by
// the M11.1 synthesizeContract derivation).
export * from "./deliverable-signal";
export * from "./scoping";
export * from "./requirements";
export * from "./proof-templates";
export * from "./dispatcher";
export * from "./distill";
export * from "./spec-lint";
export * from "./build-fanout";
export * from "./thread-templates";
export * from "./vcs";
export * from "./db-clone";
export * from "./repair-guard";
export * from "./verify-thread";
// M11.2 — the VerificationStrategy union + pure chooser (frozen-lane strategy
// selection; lives here, NOT in schemas.ts, per the M11 contract).
export * from "./verification-strategy";
export * from "./consolidate";
export * from "./bundle";
export * from "./panel";
export * from "./critic";
// M5 — out-of-process runner transport scaffold.
export * from "./runner/transport";
export * from "./runner/http-transport";
export * from "./runner/resolve";
export * from "./runner/ensure";
export * from "./runner/runner-json";
export * from "./runner/lease";
export * from "./runner/liveness";
export * from "./runner/recover";
// AD-5/AD-16 — the session subtree (<TELAR_HOME>/sessions/<id>/) and the
// SESSION lifetime of the one lease primitive. Runtime state only: it does not
// absorb chats.json, and it composes over runner/lease.ts rather than
// reimplementing it.
export * from "./sessions";
export * from "./setup/setup-agent";
// Ultra — deterministic script harness (docs/plans/ultra-harness.md). Additive.
export * from "./ultra";
// AD-5/AD-6/NFR-X-5 — the workspace item store: the one owning module for
// TELAR_HOME/workspace, and the zod schemas for everything it persists. The
// schemas live in workspace/schema.ts rather than in schemas.ts for the same
// reason verification-strategy.ts's do: a subtree with its own owning module
// keeps its shapes beside that module, so the owner and the shape move together.
// The package exports only ".", so this barrel is the port's only route to
// apps/web — which is what lets apps/web/lib/workspace-mcp.ts declare no entity
// schema of its own (NFR-X-5) and reach the store by import rather than by path
// (AC7: a session cannot reach this subtree with file tools, and does not need
// to). Its lane type is `WorkspaceLane`, not `Lane`, because run-server.ts
// already star-exports a `Lane` through this same barrel.
export * from "./workspace";
