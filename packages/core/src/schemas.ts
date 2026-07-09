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
  // Path under the run's evidence dir, OR inline text for small blobs
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
  "preparing",
  "running",
  "verifying",
  "done",
  "needs-review",
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
