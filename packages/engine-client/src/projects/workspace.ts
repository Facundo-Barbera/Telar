import { z } from "zod";

export const WORKSPACE_SCHEMA_VERSION = 1;

/** A variable name a shell would accept, so a typo is refused at the door
 *  rather than exported as something no process can read. */
export const WorkspaceEnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name");

export const WorkspaceRelativePath = z
  .string()
  .min(1)
  .refine((value) => !/^([/\\~]|[A-Za-z]:)/.test(value), "must be relative to the worktree")
  .refine((value) => !value.split(/[/\\]/).includes(".."), "must stay inside the worktree")
  .refine((value) => !value.includes("\0"), "must not contain a NUL byte");

export const WorkspaceSetup = z.object({
  /** Run in the new worktree, in the background, with `env` and the ports. */
  command: z.string().min(1),
  /** `true` holds the session's first turn until the command finishes. */
  blocking: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
});
export type WorkspaceSetup = z.infer<typeof WorkspaceSetup>;

export const WorkspacePorts = z.object({
  /** One stable port per name, exported under that name (`PORT`, `WEB_PORT`, …). */
  names: z.array(WorkspaceEnvName).min(1).max(16),
  /** Where this project's range starts; derived from the path when absent. */
  base: z.number().int().min(1024).max(65000).optional(),
});
export type WorkspacePorts = z.infer<typeof WorkspacePorts>;

export const WorkspaceSeed = z.object({
  /** Copied from the main checkout by copy-on-write clone when absent here. */
  paths: z.array(WorkspaceRelativePath).max(32),
});
export type WorkspaceSeed = z.infer<typeof WorkspaceSeed>;

export const WorkspaceArtifact = z.object({
  /** May carry `*` in a segment: `apps/ios/DerivedData-*`. */
  path: WorkspaceRelativePath,
  /** The command that rebuilds it, shown beside the row. Never run by Telar. */
  regen: z.string().optional(),
});
export type WorkspaceArtifact = z.infer<typeof WorkspaceArtifact>;

export const WorkspaceConfig = z.object({
  setup: WorkspaceSetup.optional(),
  env: z.record(WorkspaceEnvName, z.string()).optional(),
  ports: WorkspacePorts.optional(),
  seedDependencies: WorkspaceSeed.optional(),
  artifacts: z.array(WorkspaceArtifact).max(64).optional(),
  /** Reserved for the execution policy; accepted and stored, read by nothing yet. */
  execution: z.unknown().optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const WORKSPACE_FIELDS = ["setup", "env", "ports", "seedDependencies", "artifacts", "execution"] as const;
export type WorkspaceField = (typeof WORKSPACE_FIELDS)[number];

/** A project's overrides: absent inherits, `null` is off, a value replaces. */
export const ProjectWorkspaceOverrides = z.object({
  setup: WorkspaceSetup.nullable().optional(),
  env: z.record(WorkspaceEnvName, z.string()).nullable().optional(),
  ports: WorkspacePorts.nullable().optional(),
  seedDependencies: WorkspaceSeed.nullable().optional(),
  artifacts: z.array(WorkspaceArtifact).max(64).nullable().optional(),
  execution: z.unknown().optional(),
});
export type ProjectWorkspaceOverrides = z.infer<typeof ProjectWorkspaceOverrides>;

/** Where an effective field came from — what the settings pane shows beside it. */
export const WorkspaceSource = z.enum(["machine", "proposed", "project", "off"]);
export type WorkspaceSource = z.infer<typeof WorkspaceSource>;

/**
 * The repo's `.telar/workspace.json`, as read. `error` rather than a throw: a
 * malformed file in somebody's branch must cost the proposal, not the session.
 */
export const WorkspaceProposal = z.object({
  path: z.string(),
  config: WorkspaceConfig.optional(),
  error: z.string().optional(),
});
export type WorkspaceProposal = z.infer<typeof WorkspaceProposal>;

export const ProjectWorkspaceView = z.object({
  projectId: z.string(),
  overrides: ProjectWorkspaceOverrides,
  machine: WorkspaceConfig,
  proposal: WorkspaceProposal,
  effective: WorkspaceConfig,
  sources: z.partialRecord(z.enum(WORKSPACE_FIELDS), WorkspaceSource),
});
export type ProjectWorkspaceView = z.infer<typeof ProjectWorkspaceView>;

/** What a store nobody configured answers. Empty: a machine default is a
 *  choice somebody makes, not one Telar makes for every repo on the Mac. */
export const DEFAULT_MACHINE_WORKSPACE: WorkspaceConfig = {};

export function resolveWorkspace(
  machine: WorkspaceConfig,
  proposed: WorkspaceConfig | undefined,
  overrides: ProjectWorkspaceOverrides,
): { effective: WorkspaceConfig; sources: Partial<Record<WorkspaceField, WorkspaceSource>> } {
  const effective: Record<string, unknown> = {};
  const sources: Partial<Record<WorkspaceField, WorkspaceSource>> = {};
  for (const field of WORKSPACE_FIELDS) {
    const own = overrides[field];
    if (own === null) {
      sources[field] = "off";
      continue;
    }
    if (field === "env") {
      const layers = [machine.env, proposed?.env, own as Record<string, string> | undefined];
      const merged = Object.assign({}, ...layers.filter(Boolean)) as Record<string, string>;
      if (Object.keys(merged).length === 0) continue;
      effective.env = merged;
      sources.env = own !== undefined ? "project" : proposed?.env ? "proposed" : "machine";
      continue;
    }
    const [value, source] =
      own !== undefined
        ? [own, "project" as const]
        : proposed?.[field] !== undefined
          ? [proposed[field], "proposed" as const]
          : [machine[field], "machine" as const];
    if (value === undefined) continue;
    effective[field] = value;
    sources[field] = source;
  }
  return { effective: effective as WorkspaceConfig, sources };
}
