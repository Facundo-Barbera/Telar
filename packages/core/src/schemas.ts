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

export const Verdict = z.object({
  ok: z.boolean(),
  summary: z.string(),
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
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

// Model roles, not model names — deprecation resilience lives here.
export const ModelPolicy = z.object({
  fast: z.string().default("haiku"),
  dev: z.string().default("sonnet"),
  careful: z.string().default("opus"),
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;

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
  maxAgents: z.number().default(12), // the concurrency pool
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
});
export type VerificationContract = z.infer<typeof VerificationContract>;

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
  if (assertions.length && assertions.every((a) => a.type === "live-critic")) {
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
