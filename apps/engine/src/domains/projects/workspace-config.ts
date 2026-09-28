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
import { atomicWrite } from "../../platform/fs/atomic";

const WORKSPACE_PROPOSAL_PATH = path.join(".telar", "workspace.json");

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

function validateWorkspaceConfig(input: unknown): Validated<WorkspaceConfig> {
  const parsed = WorkspaceConfig.safeParse(input ?? {});
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: describe(parsed.error) };
}

function validateProjectOverrides(input: unknown): Validated<ProjectWorkspaceOverrides> {
  const parsed = ProjectWorkspaceOverrides.safeParse(input ?? {});
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: describe(parsed.error) };
}

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

  async view(project: { id: string; root: string }): Promise<ProjectWorkspaceView> {
    const document = this.read();
    const overrides = document.projects[project.id] ?? {};
    const proposal = await readWorkspaceProposal(project.root);
    const { effective, sources } = resolveWorkspace(document.machine, proposal.config, overrides);
    return { projectId: project.id, overrides, machine: document.machine, proposal, effective, sources };
  }
}
