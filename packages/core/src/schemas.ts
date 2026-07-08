import { z } from "zod";

// An auth profile = one Claude account. Selected per project (or per run) and
// injected into the agent subprocess env — see engine.ts.
export const AccountProfile = z.object({
  name: z.string(), // "personal" | "work" | ...
  configDir: z.string().optional(), // CLAUDE_CONFIG_DIR with that account logged in
  oauthTokenEnv: z.string().optional(), // env var name holding a `claude setup-token` token
});
export type AccountProfile = z.infer<typeof AccountProfile>;

export const Verdict = z.object({
  ok: z.boolean(),
  summary: z.string(),
  files_touched: z.array(z.string()).default([]),
  blocker: z.string().nullable().default(null),
});
export type Verdict = z.infer<typeof Verdict>;

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
  kind: z.enum(["quickfix", "story", "custom"]),
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
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

// Model roles, not model names — deprecation resilience lives here.
export const ModelPolicy = z.object({
  fast: z.string().default("haiku"),
  dev: z.string().default("sonnet"),
  careful: z.string().default("opus"),
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;
