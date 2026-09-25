/**
 * THE `workspace` DOCUMENT — how a project's worktrees are prepared.
 *
 * The shapes and the layering rule live in `@telar/engine-client`'s
 * `protocol/workspace.ts`, so the settings pane resolves exactly what the
 * engine does. This module owns the file: `workspace.json` at the store root,
 * holding this Mac's defaults and every project's overrides in one document.
 *
 * NEVER THROWS ON READ. This is consulted when a worktree is cut, and a file
 * somebody hand-edited into nonsense must cost the preference, not the
 * session. Writes validate and refuse instead, so nonsense never gets in
 * through the API.
 *
 * IMPORTS NOTHING FROM `state.ts`, so the worktree path can use it without a
 * cycle; validation failures come back as values and the caller picks the
 * error type.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MACHINE_WORKSPACE,
  ProjectWorkspaceOverrides,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceConfig,
  resolveWorkspace,
  type ProjectWorkspaceView,
  type WorkspaceProposal,
} from "@telar/engine-client";
import { atomicWrite } from "./atomic";

/** Relative to a project's checkout. Tracked, so a repo can propose its own setup. */
export const WORKSPACE_PROPOSAL_PATH = path.join(".telar", "workspace.json");

/** A proposal file bigger than this is not configuration. */
const MAX_PROPOSAL_BYTES = 256 * 1024;

type WorkspaceDocument = {
  machine: WorkspaceConfig;
  projects: Record<string, ProjectWorkspaceOverrides>;
};

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function describe(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return "invalid workspace configuration";
  const where = issue.path.map(String).join(".");
  return where ? `${where}: ${issue.message}` : issue.message;
}

export function validateWorkspaceConfig(input: unknown): Validated<WorkspaceConfig> {
  const parsed = WorkspaceConfig.safeParse(input ?? {});
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: describe(parsed.error) };
}

export function validateProjectOverrides(input: unknown): Validated<ProjectWorkspaceOverrides> {
  const parsed = ProjectWorkspaceOverrides.safeParse(input ?? {});
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: describe(parsed.error) };
}

/**
 * The repo's proposal, read off the event loop — the checkout may sit on a
 * slow disk. Absent is not an error; malformed is, and says why.
 */
export async function readWorkspaceProposal(projectRoot: string): Promise<WorkspaceProposal> {
  const file = path.join(projectRoot, WORKSPACE_PROPOSAL_PATH);
  let text: string;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return { path: file, error: "not a regular file" };
    if (stat.size > MAX_PROPOSAL_BYTES) return { path: file, error: "larger than 256 KB" };
    text = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file };
    return { path: file, error: (error as Error).message };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { path: file, error: `not JSON: ${(error as Error).message}` };
  }
  const checked = validateWorkspaceConfig(json);
  return checked.ok ? { path: file, config: checked.value } : { path: file, error: checked.message };
}

export class WorkspaceConfigStore {
  constructor(private readonly file: string) {}

  private read(): WorkspaceDocument {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return { machine: { ...DEFAULT_MACHINE_WORKSPACE }, projects: {} };
    }
    const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const machine = WorkspaceConfig.safeParse(record.machine ?? {});
    const projects: Record<string, ProjectWorkspaceOverrides> = {};
    // ONE BAD PROJECT ENTRY COSTS THAT PROJECT, not the machine layer or its neighbours.
    for (const [id, value] of Object.entries((record.projects ?? {}) as Record<string, unknown>)) {
      const parsed = ProjectWorkspaceOverrides.safeParse(value);
      if (parsed.success) projects[id] = parsed.data;
    }
    return { machine: machine.success ? machine.data : { ...DEFAULT_MACHINE_WORKSPACE }, projects };
  }

  private write(document: WorkspaceDocument): void {
    atomicWrite(this.file, { version: WORKSPACE_SCHEMA_VERSION, ...document });
  }

  machine(): WorkspaceConfig {
    return this.read().machine;
  }

  setMachine(input: unknown): Validated<WorkspaceConfig> {
    const checked = validateWorkspaceConfig(input);
    if (!checked.ok) return checked;
    this.write({ ...this.read(), machine: checked.value });
    return checked;
  }

  overrides(projectId: string): ProjectWorkspaceOverrides {
    return this.read().projects[projectId] ?? {};
  }

  /** An empty override set removes the entry, so a project that follows the
   *  machine leaves nothing behind in the document. */
  setOverrides(projectId: string, input: unknown): Validated<ProjectWorkspaceOverrides> {
    const checked = validateProjectOverrides(input);
    if (!checked.ok) return checked;
    const document = this.read();
    const projects = { ...document.projects };
    if (Object.keys(checked.value).length === 0) delete projects[projectId];
    else projects[projectId] = checked.value;
    this.write({ ...document, projects });
    return checked;
  }

  /** What a project will actually get, and where each field came from. */
  async view(project: { id: string; root: string }): Promise<ProjectWorkspaceView> {
    const document = this.read();
    const overrides = document.projects[project.id] ?? {};
    const proposal = await readWorkspaceProposal(project.root);
    const { effective, sources } = resolveWorkspace(document.machine, proposal.config, overrides);
    return { projectId: project.id, overrides, machine: document.machine, proposal, effective, sources };
  }
}
