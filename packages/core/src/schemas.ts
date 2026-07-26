import { z } from "zod";
import { isRunnableShape } from "./runnable-shape";

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

// The states a loom cannot leave on its own — resume/re-draft are the only
// ways forward. Single source of truth for every "is it over?" check
// (dispatcher cancel/boot-sweep, the MCP layer's session-slot logic).
export const TERMINAL_WORK_UNIT_STATES: ReadonlySet<WorkUnitState> = new Set([
  "done",
  "halted",
  "failed",
  "skipped",
]);
export const isTerminalWorkUnitState = (s: WorkUnitState): boolean =>
  TERMINAL_WORK_UNIT_STATES.has(s);

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
  // M11.0/M11.2 (adaptive-verification.md §8 "conversational-escalation" bullets)
  // — the human-answered STRATEGY answer: a verification command (`bun test`,
  // an eval script encoding its threshold in the exit code) whose exit status
  // proves the deliverable WITHOUT standing a server up. Persisted by
  // answerBlocked when the strategy-derived park asks a library/CLI/DS
  // deliverable for one (never by any autonomous path), then consumed in two
  // places, both fail-closed: isLaneViable (the pre-flight proceeds — a future
  // loom never re-asks) and the M11.2 artifact-time establishment
  // (runIntegrationVerify runs it as a deterministic gate over the frozen
  // worktree). NEVER fed to the M5 devCommand auto-spin — it is not a server.
  verifyCommand: z.string().optional(),
  // M4 — the template database the frozen-lane verify clones from (a project
  // FACT, not a behavior switch). When declared, the engine uses the real
  // LiveDbCloner to CREATE DATABASE … TEMPLATE <templateDb> an ephemeral clone
  // for the read-only integration verify; absent, the NullDbCloner runs (no
  // clone; the lane inherits the ambient DATABASE_URL). Never implicit — the
  // human declares it, exactly like baseBranch/devCommand.
  templateDb: z.string().optional(),
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

// M11.1 (additive, optional everywhere) — a charter-authored PER-CRITERION
// proof hint: the concrete runnable whose exit code settles ONE
// acceptanceCriteria line ("prints usage on --help" → `node cli.js --help`;
// "accuracy ≥ 0.9 on the holdout" → `python eval.py --min-acc 0.9`). Authored
// by the LLM charter proposer (draftCharter, flag-gated guidance) or a human —
// NEVER derived from prose by a keyword scan. synthesizeContract HONORS a hint
// structurally by emitting {type:"command", expected: run} for the exactly-
// matching criterion — a live-critic → command TIGHTENING (the direction
// contractLoosenings never flags); a criterion without a hint keeps today's
// routing. `criterion` must equal the acceptanceCriteria text verbatim
// (trimmed) — a dangling hint simply never matches, fail-safe.
export const ProofHint = z
  .object({
    criterion: z.string(), // the exact acceptanceCriteria line this hint proves
    run: z.string(), // runnable whose exit code (0 = pass) settles the criterion
  })
  // M11 (docs/m11-discuss-iteration.md, finding 2a). EMIT-TIME shape guard: a
  // PRESENT `run` that is not an executable shell command — a JS expression
  // (`parse('1.2.3') === {...}`) or prose — is rejected here, at the schema
  // boundary the proposer's charter parses through, so garbage never reaches
  // synthesizeContract's hint→command tightening. Additive and flag-off byte-
  // identical: an absent proofHints array is untouched, and a BLANK run
  // (whitespace) stays valid because collectProofHints already drops it (a blank
  // hint is inert, not an error — no existing charter/test regresses). Only a
  // present, NON-blank, non-runnable-shaped run is flagged. Defense-in-depth with
  // collectProofHints' runtime drop (weave-contracts.ts) — one at author time,
  // one at consumption.
  .superRefine((h, ctx) => {
    if (h.run.trim() && !isRunnableShape(h.run)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run"],
        message: `proofHint run must be an executable shell command, not prose or a JS expression: ${JSON.stringify(h.run)}`,
      });
    }
  });
export type ProofHint = z.infer<typeof ProofHint>;

export const SubGoal = z.object({
  id: z.string(), // "s1"
  title: z.string(),
  detail: z.string(),
  proofStrategy: ProofStrategy,
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  required: z.boolean().default(true),
  status: z.enum(["pending", "ready", "active", "done", "blocked", "failed"]).default("pending"),
  // M11.1 — optional per-criterion proof hints for THIS SubGoal's criteria.
  // Absent everywhere today (additive); consumed by the modality derivation.
  proofHints: z.array(ProofHint).optional(),
});
export type SubGoal = z.infer<typeof SubGoal>;

// D3 (docs/deflag-cut-plan.md APPROVED DECISION D3; docs/PRINCIPLES.md §20-32,§62)
// — the orchestrator's ENVIRONMENT-COMPREHENSION FACT record. At scoping, while
// the orchestrator already reads the project, it maps what VERIFICATION will
// need (a dev server, env vars, a database, credentials) into this record on the
// Charter. It is a FACT, never a gate: the build starts regardless of what is
// missing; a missing requirement blocks ONLY the verify step (mediated at need).
// The deterministic RAILS (requirements.ts) key off `classification`.
export const RequirementKind = z.enum(["env-var", "secret", "dev-server", "database", "port"]);
export type RequirementKind = z.infer<typeof RequirementKind>;

// The heuristic-asking rail (D3): `human-only` requirements (secrets/credentials
// = certain dead-ends) MAY be offered up-front for optional answering;
// `maybe-resolvable` (ports/stubs/ephemeral) are NEVER asked — the orchestrator
// mediates them at need; `greenfield-unknown` requirements proceed-and-defer.
export const RequirementClass = z.enum(["human-only", "maybe-resolvable", "greenfield-unknown"]);
export type RequirementClass = z.infer<typeof RequirementClass>;

export const EnvRequirement = z.object({
  // Stable key — an env-var NAME (DATABASE_URL, STRIPE_KEY), a service label
  // ("dev-server"), etc. Drives never-ask-twice de-dup + persistence routing.
  name: z.string(),
  kind: RequirementKind,
  classification: RequirementClass,
  detail: z.string().optional(), // human-facing "why verification needs this"
  // True once the fact is already resolvable from a persisted tier (a secret in
  // ~/.telar/credentials.json, or a fact in telar.yaml / the project env). A
  // satisfied requirement is NEVER re-offered — the never-ask-twice guarantee.
  satisfied: z.boolean().default(false),
  source: z.string().optional(), // where detection saw it (.env.example, servers.yaml, …)
});
export type EnvRequirement = z.infer<typeof EnvRequirement>;

export const RequirementsRecord = z.object({
  requirements: z.array(EnvRequirement).default([]),
  detectedAt: z.number().optional(),
});
export type RequirementsRecord = z.infer<typeof RequirementsRecord>;

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
  // M11.1 — optional charter-level per-criterion proof hints (for the root's
  // own acceptanceCriteria / a non-decomposing charter). Additive; consumed
  // by the modality derivation. Per-SubGoal hints live on SubGoal.
  proofHints: z.array(ProofHint).optional(),
  // D3 — the eager-detection ENVIRONMENT-COMPREHENSION fact record
  // (requirements.ts). Additive; absent on a charter scoped before D3 or with
  // nothing detected. Consumed by the mediation rung when repairing the lane.
  requirements: RequirementsRecord.optional(),
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
  // M10.5 — objective-vs-human-judgment marker, ORTHOGONAL to `type` (modality)
  // and `blocker` (must-clear-vs-advisory). Opt-in and ABSENT everywhere today.
  // A subjective criterion is carried as a normal `type:"live-critic"` assertion
  // (so validateContract's observable rule still applies) that ADDITIONALLY sets
  // subjective:true — AUTHORED per-criterion by the LLM charter proposer, never a
  // deterministic keyword scan. ONLY an assertion
  // that explicitly carries subjective:true is pulled out of the autonomous panel
  // into the human-judged accept bucket; its absence keeps a criterion
  // objective/fail-closed (default-to-objective).
  subjective: z.boolean().optional(),
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
// freely. Additive; consulted by every thread's workflow.
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

    // M10.5 defense-in-depth: a subjective criterion is carried ONLY as a
    // type:"live-critic" assertion (docs §3.6). Reject subjective:true on any
    // other type so an out-of-place marker is a CONTRACT ERROR — it must never
    // ride on a command/gate/db assertion (which would be the only way a
    // subjective marker could reach the deterministic slice; routeAssertions
    // already refuses to pull it out of that slice, this closes the door earlier).
    if (a.subjective === true && a.type !== "live-critic") {
      errors.push(`assertion ${a.id} sets subjective:true but is type "${a.type}" — subjective criteria must be type "live-critic"`);
    }

    if (a.type === "live-critic") {
      if (!a.observable || !a.observable.trim()) {
        errors.push(`live-critic assertion ${a.id} must name an observable`);
      }
    } else {
      // M11 (finding 6) — FIELD SEMANTICS. `observable` is the live-critic's
      // "what it checks" field (see ContractAssertion above); the gate layer
      // (executor.runContractGates) reads ONLY `expected` for a command/gate and
      // ignores `observable` entirely. In run #3 the planner inverted the fields
      // — it authored the RUNNABLE in `observable` ("bun test") and PROSE in
      // `expected` ("exit code 0") — so the real command went unused and the prose
      // was executed. Rather than silently guess which field the runnable is in
      // (which would give `observable` a dual meaning and require the gate layer
      // to read it), REJECT a non-blank `observable` on a command/gate at author
      // time with a message naming the right field, so the planner fixes it
      // in-session (this flows through writeContract → propose_contract). SCOPE
      // EXCLUDES `db`: a deferred db legitimately pairs expected SQL + observable
      // (schemas.ts db comment). Only a NON-BLANK observable is rejected — every
      // existing command/gate fixture leaves it undefined, so flag-off/byte-
      // identical (this is a schema guard, always-on like the :697 command rule).
      if ((a.type === "command" || a.type === "gate") && a.observable && a.observable.trim()) {
        errors.push(`command/gate assertion ${a.id} carries an observable ("${a.observable}") — observable is only valid on live-critic; put the runnable/gate-name in \`expected\``);
      }
      const hasExpected = !!a.expected && !!a.expected.trim();
      const hasExpectedFile = !!a.expectedFile && !!a.expectedFile.trim();
      if (!hasExpected && !hasExpectedFile) {
        errors.push(`assertion ${a.id} is prose-only: needs expected or expectedFile`);
      } else if (hasExpectedFile && opts?.existingFiles && !opts.existingFiles.has(a.expectedFile!.trim())) {
        errors.push(`assertion ${a.id} points at a bundle file that doesn't exist: ${a.expectedFile}`);
      } else if (a.type === "command" && hasExpected && !isRunnableShape(a.expected!)) {
        // M11 (finding 2a) — a `command` runs its `expected` verbatim through
        // sh -c (executor.runContractGates), so a PROSE / JS-expression expected
        // is unrunnable-by-construction and burns repair attempts on a gate no
        // builder can fix. Reject it at author time (propose_contract flows here
        // via bundle.writeContract → validateContract, so this covers the tool
        // transitively). SCOPED TO `command` ONLY: a `gate` expected is a manifest-
        // gate NAME (validated by lookup at runtime, not a runnable), and a `db`
        // expected is legitimately SQL-shaped (prose-like by nature) — neither is
        // sh -c'd raw the way a command is, so neither is shape-checked here. The
        // predicate is conservative (accepts anything ambiguous), so no existing
        // runnable command expected regresses — flag-off byte-identical.
        errors.push(`command assertion ${a.id} has a non-runnable expected (prose or a JS expression, not an executable shell command): ${a.expected}`);
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
  // M10.5 — an ADVISORY UX/design lens. Sized in ONLY under the UX-relevance
  // signal, ALWAYS blocker:false (stamped from the LensSpec, not
  // the agent's self-report), and NOT a §M.3 floor class — provably non-gating on
  // every aggregatePanel path (blocker:false defeats the failing-blocker path, it
  // cannot satisfy the floor, and aggregatePanel excludes class:"aesthetic" from
  // its blocker-severity finding sweep). It can nudge but never flip a verdict.
  "aesthetic",
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

// ── The spend ledger's record (AD-18) ───────────────────────────────────────
// One append-only line per agent call in $TELAR_HOME/usage.ndjson. There is
// exactly one ledger and exactly one writer (usage-ledger.ts, AD-20).
//
// Owner attribution (ownerKind + ownerId) and idempotency (entryKey) are both
// ADDITIVE: every field carries a default, so a line written before either
// existed parses clean, counts toward every total, and never throws (AD-7
// tolerant readers — zod also strips unknown keys rather than rejecting them).
//
// The "session" default is LOAD-BEARING, not a placeholder: it is what makes a
// pre-attribution record still fold into the session-scoped projections, which
// is precisely what "an un-attributed historical record still counts toward
// totals" requires. The "" entryKey default is load-bearing in the same way —
// it is what keeps every record already on disk folding exactly as it folded
// before the field existed.
//
// NOTE: cost LANGUAGE (USD on Claude, tokens on Codex) is a property of the
// PROJECTION, never of this record. No currency/unit field belongs here.
export const UsageOwnerKind = z.enum(["session", "loom", "ultra"]);
export type UsageOwnerKind = z.infer<typeof UsageOwnerKind>;

export const UsageEntry = z.object({
  ts: z.number(),
  account: z.string().default("unknown"),
  model: z.string().default(""),
  sessionId: z.string().default(""),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  cacheCreateTokens: z.number().default(0),
  costUsd: z.number().default(0),
  ownerKind: UsageOwnerKind.default("session"),
  ownerId: z.string().default(""),
  // A stable GLOBAL name for ONE billable event.
  //
  // THE RULE, and it is structural: a billing key is a UNIQUE ID MINTED AT THE
  // MOMENT THE MONEY IS SPENT, carried on the record that spent it, and never
  // re-derived from position, order or count. Three earlier cuts of this field
  // derived it from something countable (an attempts[] index; that index plus
  // startedAt; a per-ordinal settle count re-derived from the journal) and
  // every one opened a SILENT money-loss path, because a count collides when
  // two writers meet and regresses when the file it is counted from is
  // truncated or torn. A collision under a countable key annihilates a real
  // billing with no row to reconcile it by.
  //
  // The two producers, as measured:
  //   `attempt:<loomId>:<AttemptRecord.id>` — weave.ts attemptKey. The id is a
  //     crypto.randomUUID() minted by executor.ts when the attempt is created.
  //     LEGACY FALLBACK, for records written before the field existed: an
  //     attempt with no usable id keys on `attempt:<loomId>:<index>:<startedAt>`
  //     (or the bare `attempt:<loomId>:<index>` with no finite startedAt). That
  //     is the old, countable shape, kept ONLY so a loom.json already on disk
  //     folds exactly as it always did — a historical attempt is frozen, so the
  //     collision the shape permits cannot be reached by anything still growing.
  //   `ultra:<runId>:<ordinal>:<JournalRecord.settleId>` — ultra/storage.ts.
  //     runId and ordinal are human-readable provenance only; the minted
  //     settleId is what makes it unique, and a replay reads that id back OFF
  //     the journal record it is replaying rather than re-deriving it. A record
  //     predating the field falls back to the old count-derived key.
  //
  // usage-ledger.ts folds a non-empty key AT MOST ONCE, so honestly
  // re-recording the same event (a mediation re-settle, a resume that re-runs a
  // child already `done` on disk, two processes appending concurrently) writes
  // a line that changes no total. The log stays append-only: the duplicate row
  // is never removed, it simply stops counting — and, the corollary that logUsage
  // now enforces, it is never SUPPRESSED either. Idempotence lives in the fold;
  // a write withheld to enforce it would destroy the one row a human could use
  // to notice a loss. An over-count is visible and arguable, an under-count
  // silently un-binds maxCostUsd.
  //
  // WHY NOT reuse sessionId as the key: two legacy chat turns in one session
  // share a sessionId, so keying on it would fold away half of every
  // historical session's spend (a direct AC5 violation); normalize() already
  // defaults ownerId from it; and weave.ts deliberately writes sessionId: ""
  // to keep loom rows out of the session-scoped projections.
  //
  // "" means UN-KEYED — fold every occurrence — which is the pre-existing
  // behavior of every record already on disk.
  entryKey: z.string().default(""),
});
export type UsageEntry = z.infer<typeof UsageEntry>;
