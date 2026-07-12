import { z } from "zod";

// A provider = which agent CLI/backend an account drives. Claude today, Codex
// alongside it; the string keys into PROVIDERS (providers.ts).
export const ProviderId = z.enum(["claude", "codex"]);
export type ProviderId = z.infer<typeof ProviderId>;

// How an account authenticates:
//  - subscription: an interactive login stored in the provider's config dir
//    (CLAUDE_CONFIG_DIR / CODEX_HOME) — rides a Pro/Max/ChatGPT plan.
//  - oauth-token:  a long-lived token env var (e.g. `claude setup-token`),
//    still subscription-billed, headless-friendly for hosting.
//  - api-key:      a provider API key (ANTHROPIC_API_KEY / OPENAI_API_KEY),
//    API-billed — the redistribution-clean path.
export const AuthMode = z.enum(["subscription", "oauth-token", "api-key"]);
export type AuthMode = z.infer<typeof AuthMode>;

// An auth profile = one account for one provider. Selected per project (or per
// run/session) and injected into the agent subprocess env — see accountEnv in
// engine.ts. Fields past `name` are optional so the registry can grow
// incrementally; the provider descriptor maps them to concrete env vars.
export const AccountProfile = z.object({
  name: z.string(), // "personal" | "work" | "codex" | ...
  provider: ProviderId.optional(), // defaults to "claude" when absent
  authMode: AuthMode.optional(), // defaults to "subscription" when absent
  configDir: z.string().optional(), // → provider config dir env, that account logged in
  tokenEnv: z.string().optional(), // env var name holding the token/key (else the secret store)
  displayTier: z.string().optional(), // cosmetic plan label, e.g. "5x" / "20x"
});
export type AccountProfile = z.infer<typeof AccountProfile>;

// --- Per-project MCP servers (docs/runtime-architecture.md §B) — manual-token
// auth, DECOUPLED from the Claude account. telar.yaml is secret-free: an
// env/header value is either a literal string OR a { secret, prefix? } ref
// that NAMES a token in the secret store (resolved by mcp.ts, never here, and
// never off accountEnv — so account-switching can't rotate MCP auth).
export const McpSecretRef = z.object({
  secret: z.string(), // secret key, namespaced at read time to `mcp:<project>:<secret>`
  prefix: z.string().optional(), // literal prefix, e.g. "Bearer " for an Authorization header
});
export type McpSecretRef = z.infer<typeof McpSecretRef>;

export const McpValue = z.union([z.string(), McpSecretRef]);
export type McpValue = z.infer<typeof McpValue>;

// Telar-owned OAuth for an http MCP server (docs/mcp-oauth-design.md §3).
// Optional + additive: absent → today's manual-token behavior is unchanged.
// When present, Telar acts as the OAuth client and auto-injects the managed
// Bearer token; the fields here are only pins/overrides + the tier-3 manual
// (pre-registered) client fallback. Secrets never live in telar.yaml — a
// confidential client's secret is a { secret } ref into the secret store.
export const McpOAuthConfig = z.object({
  type: z.literal("oauth"),
  scopes: z.array(z.string()).optional(),
  clientId: z.string().optional(), // tier-3 manual/pre-registered client id
  clientSecret: McpSecretRef.optional(), // confidential clients only
  authorizationServer: z.string().optional(), // skip PRM discovery, pin this issuer
  redirectPath: z.string().optional(), // default "/api/mcp/oauth/callback"
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfig>;

// `enabled` is an OPTIONAL kill-switch: absent or true keeps the server live
// (today's behavior on every existing manifest); only an explicit `false`
// disables it, so mcp.ts skips it when materializing/refreshing servers.
export const McpServerConfig = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), McpValue).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), McpValue).optional(),
    auth: McpOAuthConfig.optional(),
    enabled: z.boolean().optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const Verdict = z.object({
  ok: z.boolean(),
  summary: z
    .string()
    .describe(
      "A concise 1-3 sentence summary of what you changed and why, in plain prose. Do NOT write an essay, a numbered list of every file, or a play-by-play — the file list goes in files_touched and the timeline is already captured. Markdown is allowed for light emphasis.",
    ),
  files_touched: z.array(z.string()).default([]),
  blocker: z.string().nullable().default(null),
});
export type Verdict = z.infer<typeof Verdict>;

// --- Verifier (QA) agent evidence & verdict schema (docs/verifier-agent.md §6.1) ---

export const EvidenceKind = z.enum([
  "screenshot",
  "a11ySnapshot",
  "console",
  "network",
  "trace",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z.object({
  kind: EvidenceKind,
  // Path under the loom's evidence dir, OR inline text for small blobs
  // (a11ySnapshot / console line). Large binaries (png/trace) are always paths.
  path: z.string().optional(),
  text: z.string().optional(),
  label: z.string().default(""), // e.g. "after submit", "POST /api/save -> 200"
});
export type Evidence = z.infer<typeof Evidence>;

export const CriterionVerdict = z.enum(["pass", "fail", "flaky"]);
export type CriterionVerdict = z.infer<typeof CriterionVerdict>;

export const ReproStep = z.object({
  action: z.string(), // "click", "fill", "navigate", "assert"
  target: z.string(), // role-based description: "button 'Submit'"
  value: z.string().optional(),
  locator: z.string().optional(), // getByRole(...) from browser_generate_locator
});
export type ReproStep = z.infer<typeof ReproStep>;

export const CriterionResult = z.object({
  criterion: z.string(), // the acceptance-criterion text, verbatim
  // M4 (optional, additive) — the stable ContractAssertion.id this criterion
  // judged, when the panel was handed contract assertions carrying ids. Lets
  // the auto-repair guards track failing/passing assertions by STABLE id
  // rather than fuzzy-matching verbatim prose. Absent on legacy reports (they
  // parse unchanged); never load-bearing for any flag-off path.
  assertionId: z.string().optional(),
  verdict: CriterionVerdict,
  observed: z.string(), // what the agent saw ("asserted 'Saved' visible")
  evidence: z.array(Evidence).default([]),
  repro: z.array(ReproStep).default([]), // present on fail; ordered minimal repro
  locators: z.array(z.string()).default([]), // generated role-locators touched (for distillation)
});
export type CriterionResult = z.infer<typeof CriterionResult>;

export const DesignSeverity = z.enum(["blocker", "major", "minor", "nit"]);
export type DesignSeverity = z.infer<typeof DesignSeverity>;

export const DesignCategory = z.enum([
  "visual-consistency",
  "spacing-alignment",
  "hierarchy",
  "responsive",
  "contrast-a11y",
  "affordance",
  "state",
  "copy",
  "other",
]);
export type DesignCategory = z.infer<typeof DesignCategory>;

// A design/UX critique finding — a JUDGED signal, kept SEPARATE from the
// functional per-criterion verdicts. Never gates the run (informational).
export const DesignFinding = z.object({
  severity: DesignSeverity,
  category: DesignCategory,
  title: z.string(),
  detail: z.string(), // what's wrong + why it matters (cite a guideline when given)
  recommendation: z.string().optional(),
  evidence: z.array(Evidence).default([]), // screenshots as a judged signal
});
export type DesignFinding = z.infer<typeof DesignFinding>;

export const VerifierReport = z.object({
  feature: z.string(),
  url: z.string(), // the app URL that was driven
  ok: z.boolean(), // true iff every criterion === "pass"
  summary: z.string(),
  criteria: z.array(CriterionResult).default([]),
  // Session-wide evidence not tied to one criterion (the trace, full console dump).
  sessionEvidence: z.array(Evidence).default([]),
  designFindings: z.array(DesignFinding).default([]),
});
export type VerifierReport = z.infer<typeof VerifierReport>;

export const WorkUnitState = z.enum([
  "queued",
  "scoping",
  "charter-review",
  // M7 — a live-critic loom whose verify needs a running app but the project
  // has NO server recipe: paused awaiting a human Accept/Steer/Reject of the
  // setup agent's proposed servers.yaml (approveEnv). Awaiting-human, like
  // charter-review; NEITHER terminal NOR in-flight. Only reachable when the
  // envReview flag is on — flag-off it is unreachable (byte-identical).
  "env-review",
  "preparing",
  "running",
  "verifying",
  "ready", // verified, awaiting owner acceptance (docs/loom-model.md §A)
  "done",
  "needs-review",
  "blocked", // paused on a missing prerequisite/human decision (docs/loom-model.md §M.7)
  "halted",
  "failed",
  "skipped",
]);
export type WorkUnitState = z.infer<typeof WorkUnitState>;

export const WorkUnit = z.object({
  id: z.string(),
  kind: z.enum(["quickfix", "story", "custom", "verify"]),
  project: z.string(), // project name from the registry
  title: z.string(),
  prompt: z.string(),
  state: WorkUnitState.default("queued"),
  dependsOn: z.array(z.string()).default([]),
  sessionIds: z.array(z.string()).default([]),
  verdict: Verdict.nullable().default(null),
});
export type WorkUnit = z.infer<typeof WorkUnit>;

// exec.yaml / registry entry: everything Telar needs to work on a repo.
export const ProjectManifest = z.object({
  name: z.string(),
  root: z.string(),
  adapter: z.enum(["plain", "bmad"]).default("plain"),
  account: z.string().default("personal"), // AccountProfile.name — routes billing/limits
  // Human-approval policy for a drafted Charter (docs/loom-orchestrator.md §5).
  // "auto" never pauses; "human-required-for-epics" pauses only when the
  // charter weaves (isWoven — has a decomposition) (default — a non-weaving
  // charter stays frictionless); "human-required" always pauses.
  // TODO(P4b): rename "for-epics" policy value — kept as-is here to avoid an
  // on-disk telar.yaml migration; out of scope for this pass.
  charterPolicy: z
    .enum(["auto", "human-required-for-epics", "human-required"])
    .default("human-required-for-epics"),
  baseBranch: z.string().default("main"),
  // M3 — per-loom worktree isolation + consolidation. Default OFF: every code
  // path is byte-identical to pre-M3 when false. On, each child thread builds
  // in its own git worktree forked from baseBranch's pinned SHA, and every
  // done thread's diff folds onto a `telar/<rootId>` review branch (the
  // human-review deliverable — never auto-merged to baseBranch). Also honored
  // via the TELAR_ISOLATE_WORKTREES=1 env override for live-validation runs.
  isolateWorktrees: z.boolean().default(false),
  // M4 — bounded auto-repair of the woven root's integration verify, run
  // against a FROZEN snapshot (worktree @ pinned SHA + ephemeral DB clone).
  // Default OFF: every code path is byte-identical to pre-M4 when false. On,
  // a red ALL-slice integration verdict may trigger a guarded, provably-
  // terminating repair loop (repair-guard.ts) instead of an immediate
  // needs-review demotion. Also honored via TELAR_AUTO_REPAIR=1 for a
  // live-validation run. The one master flag gates the whole frozen-lane
  // pipeline (frozen verify + checkpoints + auto-repair).
  autoRepair: z.boolean().default(false),
  // M5 — own loom execution in a standalone telar-runner process so a web
  // reload/edit doesn't kill in-flight work. Default OFF: flag-off every path
  // is byte-identical (dispatch stays in-process). Honored via TELAR_RUNNER=1.
  outOfProcessRunner: z.boolean().default(false),
  // M5 — a scoped setup agent runs in the `preparing` window (before build
  // children spawn): brings the lane up, authors a missing servers.yaml,
  // verifies the readyCheck. Default OFF (no lane at build time — byte-identical).
  // Honored via TELAR_SETUP_AGENT=1.
  setupAgent: z.boolean().default(false),
  // M6 — wire the (already-built) intra-thread Build fan-out: a thread's build
  // MAY split into N git-worktree-isolated builders over disjoint file pieces.
  // Default OFF: flag-off every path is byte-identical (single builder). Rides
  // on worktree isolation (each piece needs its own tree) — the dispatcher gates
  // fan-out on isolateWorktrees too. Honored via TELAR_BUILD_FANOUT=1. The
  // merged result still passes the SAME gates + one independent Verifier — more
  // builders never changes WHO accepts (moat).
  buildFanout: z.boolean().default(false),
  // M7 — the env-review gate. When a live-critic loom reaches verify with no
  // usable target AND the project has no server recipe, divert it to the
  // `env-review` state (a setup-agent-PROPOSED servers.yaml the human must
  // Accept/Steer/Reject) instead of skipping straight to needs-review. Default
  // OFF: flag-off every path is byte-identical (the divert never fires; the
  // added enum member + state maps are unreachable). Honored via
  // TELAR_ENV_REVIEW=1. The moat holds: approveEnv needs a human `by`, the
  // proposer writes/starts nothing before accept, verify stays read-only, and a
  // green re-verify still lands `ready`, never `done`.
  envReview: z.boolean().default(false),
  // M9 — thread-as-workflow. Execute a thread's build as an N-step DAG
  // (dependsOn) × M agents/step via runThreadWorkflow instead of the single
  // executeLoom attempt loop. Default OFF: flag-off every path is byte-identical
  // (executeLoom is the only reachable builder; the runner is unreferenced). The
  // default template is one `build` step that RE-ENTERS executeLoom, so flag-on
  // with the default template is behaviorally identical to today. Honored via
  // TELAR_THREAD_WORKFLOW=1 for live-validation.
  threadWorkflow: z.boolean().default(false),
  // M9.3 — per-thread LLM step-planner. When on (AND threadWorkflow on), a
  // READ-ONLY LLM call authors the ThreadWorkflow step-graph; degrades to the
  // deterministic template library on any failure/invalid/empty/cyclic graph.
  // Default OFF: templates only, no LLM spend. Honored via TELAR_THREAD_PLANNER=1.
  threadPlanner: z.boolean().default(false),
  // M9.4 — consume Step.check as an OPTIONAL, INFORMATIONAL per-step verify-lens.
  // When on (AND threadWorkflow on), after a step completes with a `check`, run a
  // READ-ONLY informational check of that step's output; on FAIL trigger a BOUNDED
  // step-local repair (existing attempt budget) and, if still failing, HOLD
  // dependents and FAIL THE THREAD CLOSED. A per-step check NEVER promotes the loom
  // (loom-level contract+panel+human stay the only proof) and can only ADD scrutiny,
  // never relax the loom's contract. Default OFF: Step.check ignored, byte-identical.
  // Honored via TELAR_STEP_CHECKS=1.
  stepChecks: z.boolean().default(false),
  // M10.1 — run ONE authoritative whole-verification gate over the COMPOSED
  // WHOLE after weave rollup (regression + completeness), forking the read-only
  // verify from the consolidation branch and verifying the FULL contract.
  // Fail-closed; only KEEPS or DEMOTES a ready loom (never authors "done").
  // Default OFF: no top gate, byte-identical. Honored via TELAR_ORCHESTRATOR_VERIFY=1.
  orchestratorVerify: z.boolean().default(false),
  gates: z
    .array(z.object({ name: z.string(), run: z.string() }))
    .default([]),
  guardrails: z
    .object({
      disallowedTools: z.array(z.string()).default([]),
      protectedPaths: z.array(z.string()).default([]),
    })
    .default({ disallowedTools: [], protectedPaths: [] }),
  urls: z
    .object({
      dev: z.string().optional(),
      preview: z.string().optional(),
      prod: z.string().optional(),
    })
    .optional(),
  designRules: z.string().optional(), // path (relative to root) to a design-guidelines doc the Verifier reads
  // docs/loom-model.md D13 (run initializer): the command that starts this
  // project's own dev server (e.g. "bun run dev"). When a bundle loom's
  // Critic Panel has no usable target (no `url` override, no urls.dev), the
  // executor spins this up on a free port and tears it down after — never a
  // replacement for urls.dev when one is already configured.
  devCommand: z.string().optional(),
  // Per-project MCP servers (docs/runtime-architecture.md §B), keyed by server
  // name. Secret-free references only; tokens are resolved+injected per server
  // by mcp.ts:resolveProjectMcpServers, decoupled from the Claude account.
  mcpServers: z.record(z.string(), McpServerConfig).default({}),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

// Model roles, not model names — deprecation resilience lives here.
export const ModelPolicy = z.object({
  fast: z.string().default("haiku"),
  dev: z.string().default("sonnet"),
  careful: z.string().default("opus"),
  // Optional per-build turn cap override. Absent → the per-kind MAX_TURNS
  // defaults apply. Set high (e.g. 400) in ~/.telar/policy.json to effectively
  // lift the ceiling for early testing without losing the rail entirely.
  maxTurns: z.number().int().positive().optional(),
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;

// M6 — a curated, named preset table a build-fanout piece MAY select by name
// (build-fanout.ts BuildPiece.agent). Telar-side config only — deliberately a
// NARROW capability surface: model / prompt flavor / a tool allow+deny list.
// It OMITS restrictTools, settingSources, and extraMcpServers by construction,
// so a roster entry can never widen a capability wall, turn a wall off, or add
// an MCP server — and it NEVER touches the read-only Verifier/Critic (whose
// AgentOpts are hard-coded constants). Default {} ⇒ no preset ⇒ byte-identical.
export const Roster = z.record(
  z.string(),
  z.object({
    description: z.string(),
    model: z.string().optional(),
    promptPrelude: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
  }),
);
export type Roster = z.infer<typeof Roster>;

// --- The Charter (docs/loom-orchestrator.md §5) — the goal + proof spec for a
// Loom, drafted in Phase 0 scoping. Additive: absent on today's quickfix/
// story/custom/verify looms, which keep behaving exactly as before.

// TODO(P4b): dissolves when the weave goes dynamic (docs/loom-model.md §W) —
// the Verification Contract becomes the proof, not an enumerated strategy.
export const ProofStrategy = z.enum(["quickfix", "bmad-story", "verifier-criteria", "custom"]);
export type ProofStrategy = z.infer<typeof ProofStrategy>;

export const ScopeBoundary = z.object({
  allowedPaths: z.array(z.string()).default([]), // globs; enforced against repair diffs
  forbiddenPaths: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type ScopeBoundary = z.infer<typeof ScopeBoundary>;

export const Budget = z.object({
  maxCostUsd: z.number().optional(),
  maxWallClockHours: z.number().optional(),
  maxParallelThreads: z.number().default(3),
  maxAgents: z.number().default(12), // the concurrency pool — see budget.ts DEFAULT_MAX_AGENTS
  // Reserved critic sub-pool (docs/loom-model.md §M / D11) — carved out of
  // maxAgents so the Critic Panel can't be starved by build fan-out.
  maxCriticAgents: z.number().default(3),
});
export type Budget = z.infer<typeof Budget>;

export const SubGoal = z.object({
  id: z.string(), // "s1"
  title: z.string(),
  detail: z.string(),
  proofStrategy: ProofStrategy,
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  required: z.boolean().default(true),
  status: z.enum(["pending", "ready", "active", "done", "blocked", "failed"]).default("pending"),
});
export type SubGoal = z.infer<typeof SubGoal>;

export const Charter = z.object({
  objective: z.string(),
  proofStrategy: ProofStrategy,
  scope: ScopeBoundary,
  budget: Budget,
  // No `shape` field (docs/loom-model.md §W) — "epic-ness" is not a type.
  // Whether a Charter weaves is derived from `decomposition` — see isWoven.
  decomposition: z.array(SubGoal).default([]), // non-empty iff this charter weaves threads
  version: z.number().default(1),
  approvedBy: z.string().optional(), // "you" | "auto:<policy>"
  scopingSessionId: z.string().optional(), // the drafting session — resumable for takeover
  rationale: z.string().optional(), // structured decomposition reasoning
  singleThread: z.boolean().optional(), // true iff a synthesized weave-of-one (§W); excluded from the epic policy/label sites
});
export type Charter = z.infer<typeof Charter>;

// PURE. docs/loom-model.md §W — "epic-ness" is derived, never declared: a
// woven root is anything with a non-empty decomposition. Structurally typed
// (not `Charter | Loom`) so this has no dependency on looms.ts (avoiding a
// schemas.ts <-> looms.ts import cycle) — it works on a bare Charter OR on a
// Loom, whose decomposition (when it weaves) lives at `.charter.decomposition`.
// A charter that weaves always had a decomposition and one that doesn't never
// did (validateCharter guarantees it), so this is behavior-identical to the
// retired `shape === "epic"` check.
export function isWoven(
  x?: { decomposition?: SubGoal[]; charter?: { decomposition?: SubGoal[] } } | null,
): boolean {
  return (x?.decomposition?.length ?? x?.charter?.decomposition?.length ?? 0) > 0;
}

// PURE. A "weave of one": a loom routed universally through the weaver whose
// decomposition is the deterministic single subgoal synthesized for a plain
// custom loom (NOT a planner-authored epic). isWoven is TRUE for these (routing
// truth — they ARE one-thread orchestrations), but the sites that encode
// "epic-ness" as POLICY/LABEL must exclude them. Marked explicitly via the
// singleThread flag (the dispatcher sets it); never inferred from length.
export function isSingleThreadWeave(
  x?: { singleThread?: boolean; charter?: { singleThread?: boolean } } | null,
): boolean {
  return (x?.singleThread ?? x?.charter?.singleThread) === true;
}

// --- Verification Contract (docs/loom-model.md §M.1, §2) — the falsifiable-
// by-construction proof spec that anchors a Spec Bundle. "Structured" means
// falsifiable, not "valid JSON": every non-live-critic assertion must carry a
// concrete expected value or bundle-file pointer; validateContract enforces
// that at the schema boundary.

export const AssertionType = z.enum([
  "golden-diff",
  "value-equality",
  "schema-match",
  "contains",
  "live-critic",
  // Unit 4 (docs §2): OFFLINE, deterministic checks routed to the gate/command
  // layer BEFORE the panel — passed by exit code, no LLM. Additive; the five
  // above keep their exact current validation and panel routing.
  "command", // a shell command in `expected`; pass = exit 0
  "gate", // a named manifest gate (manifest.gates[].name) in `expected`; pass = that gate's command exits 0
  "db", // a runnable DB command (pg_prove / psql -f …) in `expected`; pass = exit 0. A db needing a LIVE SQL connection (query in `expected` + `observable`) is DEFERRED to the panel / Unit 7.
]);
export type AssertionType = z.infer<typeof AssertionType>;

export const ContractAssertion = z.object({
  id: z.string(),
  subGoalId: z.string().optional(),
  description: z.string(),
  type: AssertionType,
  expected: z.string().optional(),
  expectedFile: z.string().optional(),
  observable: z.string().optional(), // required for "live-critic": what it checks
  blocker: z.boolean().default(true),
});
export type ContractAssertion = z.infer<typeof ContractAssertion>;

export const VerificationContract = z.object({
  version: z.number().default(1),
  assertions: z.array(ContractAssertion).default([]),
  // M1: true when this contract was AUTO-SYNTHESIZED from a loom's prose
  // acceptanceCriteria/prompt (weave-contracts.synthesizeContract), not
  // authored by a human/agent. A synthesized contract is inherently prose
  // (all live-critic) — validateContract skips ONLY the non-live-critic
  // hard-gate floor for it (see below); every other falsifiability rule stays.
  synthesized: z.boolean().optional(),
});
export type VerificationContract = z.infer<typeof VerificationContract>;

// M9 (thread-as-workflow) — a Step's kind. `build`/`migrate` are WRITING steps
// (disjoint-writer partition applies in M9.2); research/design/check fan out
// freely. Additive; only consulted under threadWorkflow (flag-off unreachable).
export const StepKind = z.enum(["research", "design", "build", "migrate", "check"]);
export type StepKind = z.infer<typeof StepKind>;

// M9 — one agent within a Step. Structural SUPERSET of build-fanout.ts BuildPiece
// ({id,title,prompt,allowedPaths,agent?}) so M9.2 can pass Step.agents straight
// into runBuildFanout with zero parallel type. `allowedPaths` is the per-agent
// disjoint-writer partition. Do NOT import BuildPiece here (would invert the
// build-fanout.ts -> schemas.ts dependency); M9.2 re-aligns BuildPiece to this.
export const AgentSpec = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string().default(""),
  allowedPaths: z.array(z.string()).default([]),
  agent: z.string().optional(), // Roster preset name (schemas.ts Roster)
});
export type AgentSpec = z.infer<typeof AgentSpec>;

// M9 — a Step = M agents (parallel) with a place in the thread's DAG. `dependsOn`
// mirrors SubGoal.dependsOn verbatim (:372) so the SAME readiness predicate reused
// from tick applies one altitude down. `partition` governs the M9.2 disjoint-writer
// check ("disjoint-writer") vs free fan-out ("free"); M9.1 default template is "free".
// `check` is the OPTIONAL, informational per-step verify-lens (M9.4) — it can gate
// the next step but NEVER earns `done` (moat: the loom-level contract+panel+human
// remain the only proof). Additive; flag-off unreachable.
export const Step = z.object({
  id: z.string(),
  goal: z.string(),
  kind: StepKind,
  agents: z.array(AgentSpec).default([]),
  partition: z.enum(["disjoint-writer", "free"]).default("free"),
  dependsOn: z.array(z.string()).default([]),
  check: VerificationContract.optional(),
});
export type Step = z.infer<typeof Step>;

// M9 — a thread's workflow: the step DAG runThreadWorkflow schedules. Container
// shape copied from VerificationContract (version + array + infer). Attached to
// the runtime Loom as an additive optional `workflow?` (looms.ts).
export const ThreadWorkflow = z.object({
  version: z.number().default(1),
  steps: z.array(Step).default([]),
});
export type ThreadWorkflow = z.infer<typeof ThreadWorkflow>;

// PURE. Validates a Verification Contract against §M.1's falsifiable-by-
// construction invariant. Returns every violation found (analog of
// validateCharter), not just the first — [] means valid.
//
// `opts.existingFiles` (when supplied by a caller with bundle access, e.g.
// bundle.ts) lets an expectedFile assertion be checked against what's
// actually in the bundle rather than trusting any non-blank string as a
// "concrete pointer" — closing the loophole where a prose sentence in
// `expected` or a dangling `expectedFile` path both pass as falsifiable.
export function validateContract(
  c: VerificationContract,
  opts?: { existingFiles?: Set<string> },
): string[] {
  const errors: string[] = [];
  const assertions = c.assertions ?? [];

  if (!assertions.length) errors.push("contract must have at least one assertion");

  // §M.1's red-team target: an all-live-critic contract is prose judged by
  // prose, with no falsifiable hard gate at all. Mirror §M.3's panel floor
  // ("≥1 adversarial lens always blocks") at the contract level.
  // M1 (D0.1): a SYNTHESIZED contract is derived from prose acceptanceCriteria/
  // prompt — there is nothing falsifiable to turn into a hard gate, so this
  // floor is skipped for it (reproducing today's legacy prose-judged-by-LLM
  // behavior). The floor remains a quality bar for human/agent-AUTHORED
  // contracts, which never set the flag. Every other rule below still applies.
  if (!c.synthesized && assertions.length && assertions.every((a) => a.type === "live-critic")) {
    errors.push("contract must have at least one non-live-critic (hard-gate) assertion");
  }

  for (const a of assertions) {
    if (!a.description || !a.description.trim()) {
      errors.push(`assertion ${a.id} must have a non-empty description`);
    }

    if (a.type === "live-critic") {
      if (!a.observable || !a.observable.trim()) {
        errors.push(`live-critic assertion ${a.id} must name an observable`);
      }
    } else {
      const hasExpected = !!a.expected && !!a.expected.trim();
      const hasExpectedFile = !!a.expectedFile && !!a.expectedFile.trim();
      if (!hasExpected && !hasExpectedFile) {
        errors.push(`assertion ${a.id} is prose-only: needs expected or expectedFile`);
      } else if (hasExpectedFile && opts?.existingFiles && !opts.existingFiles.has(a.expectedFile!.trim())) {
        errors.push(`assertion ${a.id} points at a bundle file that doesn't exist: ${a.expectedFile}`);
      }
    }
  }

  return errors;
}

// PURE. §M.2 loosening detector: returns the ids of assertions LOOSENED
// between oldC and newC — removed outright, downgraded blocker -> non-
// blocker, OR (still a blocker in both) content-weakened: its hard-gate type
// swapped for "live-critic", or its expected/expectedFile pointer changed.
// Editing the yardstick is set_verdict in disguise (§M.2) — text can't tell
// "stricter" from "looser," so ANY content change to a still-blocking
// assertion is treated as loosening-shaped and routed to the co-sign gate,
// erring toward false positives over silent evasion. Tightening
// (non-blocker -> blocker) and unchanged assertions are never flagged.
export function contractLoosenings(oldC: VerificationContract, newC: VerificationContract): string[] {
  const newById = new Map(newC.assertions.map((a) => [a.id, a]));
  const loosened: string[] = [];

  for (const old of oldC.assertions) {
    const updated = newById.get(old.id);
    if (!updated) {
      loosened.push(old.id);
      continue;
    }
    if (old.blocker && !updated.blocker) {
      loosened.push(old.id);
      continue;
    }
    if (updated.blocker) {
      const typeWeakened = old.type !== "live-critic" && updated.type === "live-critic";
      const contentChanged = old.expected !== updated.expected || old.expectedFile !== updated.expectedFile;
      if (typeWeakened || contentChanged) loosened.push(old.id);
    }
  }

  return loosened;
}

// --- Provenance (docs/loom-model.md §M.6) — human-approved origin of a Spec
// Bundle. Settable only by a UI action, never the session agent; startLoom-
// from-bundle rejects a bundle without it.

export const Provenance = z.object({
  sessionId: z.string().optional(),
  approvedBy: z.string(),
  humanApprovedAt: z.number(),
});
export type Provenance = z.infer<typeof Provenance>;

// Throws with a clear message if `p` isn't a valid Provenance — the guard
// startLoom-from-bundle uses to enforce "a Loom can only start from
// human-approved provenance" as a checkable invariant, not a UI convention.
export function assertProvenance(p: unknown): asserts p is Provenance {
  const parsed = Provenance.safeParse(p);
  if (!parsed.success) {
    throw new Error(`invalid provenance: ${parsed.error.message}`);
  }
  if (!parsed.data.approvedBy.trim()) {
    throw new Error("invalid provenance: approvedBy must be non-empty");
  }
  if (!Number.isFinite(parsed.data.humanApprovedAt) || parsed.data.humanApprovedAt <= 0) {
    throw new Error("invalid provenance: humanApprovedAt must be a positive number");
  }
}

// --- The Critic Panel (docs/loom-model.md §4 Layer 2, §M.3-§M.5) — the
// single Verifier is replaced by N independent critic lenses, each grounded
// only in the Spec Bundle + the running app (§M.5 isolation: never the
// builder's Verdict/summary, never another lens's in-flight verdict).

// "adversarial" and "reproduction" are the §M.3 BLOCKER-FLOOR classes: panel
// aggregation (decide()) hardcodes >=1 lens of one of these two as always-
// blocker, in code, never left to manifest/session policy.
export const CriticClass = z.enum([
  "intent",
  "adversarial",
  "reproduction",
  "live-experience",
  "security",
  "performance",
  "data-integrity",
]);
export type CriticClass = z.infer<typeof CriticClass>;

export const CriticFinding = z.object({
  severity: DesignSeverity,
  title: z.string(),
  detail: z.string(),
  recommendation: z.string().optional(),
  assertionId: z.string().optional(), // ties back to a ContractAssertion, when applicable
  evidence: z.array(Evidence).default([]),
});
export type CriticFinding = z.infer<typeof CriticFinding>;

export const CriticVerdict = z.object({
  lens: z.string(), // human label, e.g. "adversarial/edge"
  class: CriticClass,
  blocker: z.boolean(), // is this a must-clear lens (§M.3 floor sets >=1 true)
  ok: z.boolean(), // did this lens find the work acceptable
  summary: z.string(),
  findings: z.array(CriticFinding).default([]),
  evidence: z.array(Evidence).default([]),
});
export type CriticVerdict = z.infer<typeof CriticVerdict>;

// §M.4: panelSize() (the panel's analog of budget.ts:fanoutSize) is fed by
// measurable post-build signals outside planner control — `sizedFrom` is the
// audit trail of the raw signals it saw, never an AI-self-declared label.
// --- Per-project environment lane recipe (docs/verification-environments.md §4).
// servers.yaml is committable + secret-free (mirroring the mcpServers split):
// it declares HOW to stand a project's services up for a lane. This unit is
// schema + loader ONLY — port logic / spawning / supervisor are later Phase-E
// units that consume these fields.

// Where the OS-assigned dynamic port is flowed into the app. No universal
// convention (§4.2), so model the three variants as a key-discriminated union.
// `.strict()` prevents a typo'd variant key from silently passing.
export const PortInject = z.union([
  z.object({ env: z.string() }).strict(), // { env: "PORT" }
  z.object({ arg: z.string() }).strict(), // { arg: "--port {port}" }
  z.object({ file: z.string(), template: z.string().optional() }).strict(), // write chosen port into a file
]);
export type PortInject = z.infer<typeof PortInject>;

// One-shot "is it up yet?" gate (§4.2 — NOT "any response"). Discriminated on kind.
export const ReadyCheck = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), run: z.string() }),
  z.object({ kind: z.literal("http"), path: z.string(), status: z.number().int().default(200) }),
]);
export type ReadyCheck = z.infer<typeof ReadyCheck>;

// Ongoing liveness probe → the supervisor (§4.4). intervalMs distinguishes it
// from the one-shot ReadyCheck.
export const HealthCheck = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), run: z.string(), intervalMs: z.number().int().positive().default(5000) }),
  z.object({
    kind: z.literal("http"),
    path: z.string(),
    status: z.number().int().default(200),
    intervalMs: z.number().int().positive().default(5000),
  }),
]);
export type HealthCheck = z.infer<typeof HealthCheck>;

export const RestartPolicy = z.object({
  onCrash: z.boolean().default(true),
  maxRestarts: z.number().int().nonnegative().default(3),
  backoffMs: z.number().int().nonnegative().default(1000),
});
export type RestartPolicy = z.infer<typeof RestartPolicy>;

export const ServiceConfig = z.object({
  command: z.string(), // required: how to start this service
  portStrategy: z.enum(["fixed", "dynamic"]), // REQUIRED, no default (§10: no silent strategy)
  // Additive (§7): the known port for a `fixed` service — needed when its
  // readyCheck is http (`http://localhost:{port}{path}`) or a peer references
  // it as `{svc.port}`/`{svc.url}`. Ignored for `dynamic` (which is assigned a
  // free port at bring-up). Absent on a fixed service ⇒ port:null/url:null.
  port: z.number().int().positive().optional(),
  portInject: PortInject.optional(), // how the chosen port reaches the app (dynamic)
  readyCheck: ReadyCheck.optional(), // one-shot readiness gate
  healthcheck: HealthCheck.optional(), // ongoing liveness → supervisor
  restartPolicy: RestartPolicy.optional(), // crash handling (supervisor)
  reset: z.string().optional(), // command to return substrate to clean
  dependsOn: z.array(z.string()).default([]), // other service keys this waits on
  // Templated: "{port}", "{db.url}", "http://localhost:{port}". YAML coerces
  // unquoted scalars (PORT: 8080 → number), so accept string|number|boolean and
  // normalize to string rather than reject a natural-looking env block.
  env: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v)),
    )
    .default({}),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

// Driver is LANE-LEVEL (top-level), not per-service (see design). "none" =
// today's static-url path, unchanged. "host-process" is declared here; its
// runtime behavior lands in a later unit.
export const ServersDriver = z.enum(["none", "host-process"]);
export type ServersDriver = z.infer<typeof ServersDriver>;

export const ServersConfig = z.object({
  version: z.number().default(1),
  driver: ServersDriver.default("none"),
  services: z.record(z.string(), ServiceConfig).default({}),
});
export type ServersConfig = z.infer<typeof ServersConfig>;

// The graceful default: parse of {} yields all-defaults. resolveServersConfig
// returns this when servers.yaml is absent → nothing changes today.
export const EMPTY_SERVERS_CONFIG: ServersConfig = ServersConfig.parse({});

export const PanelReport = z.object({
  url: z.string().default(""), // the app URL the panel drove
  critics: z.array(CriticVerdict).default([]),
  sizedFrom: z.record(z.string(), z.number()).optional(),
  // The LensSpec[] the panel was originally sized to run (panel.ts:panelSize
  // / retryLenses) — lets aggregatePanel() detect a blocker lens that
  // crashed/never emitted and silently dropped out of `critics`.
  sized: z.array(z.object({ class: CriticClass, lens: z.string(), blocker: z.boolean() })).optional(),
});
export type PanelReport = z.infer<typeof PanelReport>;
