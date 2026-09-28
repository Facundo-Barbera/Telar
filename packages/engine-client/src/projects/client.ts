import type { EnvMode, ModelSelection } from "../protocol/common";
import type { Project } from "../protocol/entities";
import type { ProjectWorkspaceOverrides, ProjectWorkspaceView, WorkspaceConfig } from "./workspace";
import type { EngineTransport } from "../platform/transport";

const projectPath = (projectId: string) => `/v2/projects/${encodeURIComponent(projectId)}`;

export const projectsClient = {
  listProjects(this: EngineTransport, options: { includeRemoved?: boolean } = {}): Promise<{ projects: Project[] }> {
    return this.request("GET", options.includeRemoved ? "/v2/projects?includeRemoved=1" : "/v2/projects");
  },

  registerProject(this: EngineTransport, input: { id?: string; name: string; root: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects", input);
  },

  cloneProject(this: EngineTransport, input: { url: string; parent: string; name?: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects/clone", input);
  },

  unregisterProject(this: EngineTransport, projectId: string): Promise<{ project: Project; sessions: number }> {
    return this.request("DELETE", projectPath(projectId));
  },

  /** Same id, same settings, same sessions. */
  restoreProject(this: EngineTransport, projectId: string): Promise<{ project: Project }> {
    return this.request("POST", `${projectPath(projectId)}/restore`, {});
  },

  updateProject(
    this: EngineTransport,
    projectId: string,
    patch: {
      name?: string;
      /** One id from `TELAR_ICONS`. */
      iconName?: string | null;
      iconEmoji?: string | null;
      defaultModel?: ModelSelection | null;
      envMode?: EnvMode | null;
      plugins?: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>;
    },
  ): Promise<{ project: Project }> {
    return this.request("PATCH", projectPath(projectId), patch);
  },

  projectIcon(this: EngineTransport, projectId: string, options: { format?: "png" } = {}): Promise<{ data: Uint8Array; contentType: string }> {
    return this.readBytes(`${projectPath(projectId)}/icon${options.format ? `?format=${options.format}` : ""}`);
  },

  projectActivity(this: EngineTransport): Promise<{ projects: { projectId: string; updatedAt: number }[] }> {
    return this.request("GET", "/v2/sessions/activity");
  },

  machineWorkspace(this: EngineTransport): Promise<{ machine: WorkspaceConfig }> {
    return this.request("GET", "/v2/workspace");
  },

  /** Replaces the whole machine layer; the engine answers with what it kept. */
  setMachineWorkspace(this: EngineTransport, machine: WorkspaceConfig): Promise<{ machine: WorkspaceConfig }> {
    return this.request("PUT", "/v2/workspace", { machine });
  },

  projectWorkspace(this: EngineTransport, projectId: string): Promise<{ workspace: ProjectWorkspaceView }> {
    return this.request("GET", `${projectPath(projectId)}/workspace`);
  },

  /** Replaces the project's overrides: absent inherits, `null` turns a field off. */
  setProjectWorkspace(this: EngineTransport, projectId: string, overrides: ProjectWorkspaceOverrides): Promise<{ workspace: ProjectWorkspaceView }> {
    return this.request("PUT", `${projectPath(projectId)}/workspace`, { overrides });
  },
};
