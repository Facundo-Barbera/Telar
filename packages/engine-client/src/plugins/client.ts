import type { EngineTransport } from "../platform/transport";
import type { PluginInstallInput, PluginStatus, ProjectPlugins } from "./schema";
import type { DataScienceBootstrap, DataScienceCreateEnvironment, DataScienceEnvironments, DataScienceInstallCommand, DataScienceJob, DataScienceManager, DataSciencePackage, DataSciencePreflight, DataScienceRequirementsSource, DataScienceToolchain, LatexBootstrap, LatexDistributions, LatexJob, LatexPackagesAnswer, LatexToolchain, ManagedTectonic } from "./toolchains";

type JobStarted = Promise<{ jobId: string }>;
type DataScienceInstalled = { packages: DataSciencePackage[]; environment: { manager: DataScienceManager; root: string; python: string; command: DataScienceInstallCommand } };

const project = (projectId: string, tail: string) => `/v2/projects/${encodeURIComponent(projectId)}/${tail}`;
const fresh = (value: boolean) => (value ? "?fresh=1" : "");

export const pluginsClient = {
  machinePlugins(this: EngineTransport): Promise<{ plugins: PluginStatus[]; machine: ProjectPlugins }> {
    return this.request("GET", "/v2/plugins");
  },

  /** Refused with the manifest's problem when the plugin would not load. */
  installPlugin(this: EngineTransport, input: PluginInstallInput): Promise<{ plugin: PluginStatus }> {
    return this.request("POST", "/v2/plugins/installed", input);
  },

  /** A linked plugin is only unlinked. */
  uninstallPlugin(this: EngineTransport, id: string): Promise<{ removed: true }> {
    return this.request("DELETE", `/v2/plugins/installed/${encodeURIComponent(id)}`);
  },

  updateMachinePlugins(
    this: EngineTransport,
    plugins: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>,
  ): Promise<{ machine: ProjectPlugins }> {
    return this.request("PATCH", "/v2/plugins", { plugins });
  },

  dataScienceEnvironments(this: EngineTransport, projectId: string): Promise<DataScienceEnvironments> {
    return this.request("GET", project(projectId, "data-science/environments"));
  },

  /** Poll the job with `dataScienceJob`; its `result` is a `DataScienceCreatedEnvironment`. */
  dataScienceCreateEnvironment(this: EngineTransport, projectId: string, request: DataScienceCreateEnvironment): JobStarted {
    return this.request("POST", project(projectId, "data-science/environments"), request);
  },

  dataSciencePackages(this: EngineTransport, projectId: string): Promise<DataScienceInstalled> {
    return this.request("GET", project(projectId, "data-science/packages"));
  },

  dataScienceInstall(this: EngineTransport, projectId: string, input: { add?: string[]; remove?: string[]; requirements?: DataScienceRequirementsSource }): JobStarted {
    return this.request("POST", project(projectId, "data-science/packages"), input);
  },

  dataScienceBootstrap(this: EngineTransport, request: DataScienceBootstrap): JobStarted {
    return this.request("POST", "/v2/data-science/bootstrap", request);
  },

  dataScienceToolchain(this: EngineTransport, refresh = false): Promise<{ toolchain: DataScienceToolchain }> {
    return this.request("GET", `/v2/data-science/toolchain${fresh(refresh)}`);
  },

  dataScienceJob(this: EngineTransport, jobId: string, after = 0): Promise<{ job: DataScienceJob }> {
    return this.request("GET", `/v2/data-science/jobs/${encodeURIComponent(jobId)}?after=${after}`);
  },

  dataScienceCancelJob(this: EngineTransport, jobId: string): Promise<Record<string, never>> {
    return this.request("DELETE", `/v2/data-science/jobs/${encodeURIComponent(jobId)}`);
  },

  dataScienceProbe(
    this: EngineTransport,
    projectId: string,
    path: string,
  ): Promise<{ probe: DataSciencePreflight & { relativePath?: string; root?: string; manager?: DataScienceManager } }> {
    return this.request("POST", project(projectId, "data-science/probe"), { path });
  },

  /** Spawns `--version` probes: call it from a page, never a poll. */
  latexDistributions(this: EngineTransport, projectId: string): Promise<LatexDistributions> {
    return this.request("GET", project(projectId, "latex/distributions"));
  },

  latexPackages(this: EngineTransport, projectId: string): Promise<LatexPackagesAnswer> {
    return this.request("GET", project(projectId, "latex/packages"));
  },

  /** Refused for tectonic projects. */
  latexInstall(this: EngineTransport, projectId: string, input: { add?: string[]; remove?: string[] }): JobStarted {
    return this.request("POST", project(projectId, "latex/packages"), input);
  },

  latexBootstrap(this: EngineTransport, request: LatexBootstrap): JobStarted {
    return this.request("POST", "/v2/latex/bootstrap", request);
  },

  latexToolchain(this: EngineTransport, refresh = false): Promise<{ toolchain: LatexToolchain }> {
    return this.request("GET", `/v2/latex/toolchain${fresh(refresh)}`);
  },

  managedTectonic(this: EngineTransport): Promise<{ managed: ManagedTectonic }> {
    return this.request("GET", "/v2/latex/managed");
  },

  installManagedTectonic(this: EngineTransport): Promise<{ managed: ManagedTectonic }> {
    return this.request("POST", "/v2/latex/managed", {});
  },

  latexJob(this: EngineTransport, jobId: string, after = 0): Promise<{ job: LatexJob }> {
    return this.request("GET", `/v2/latex/jobs/${encodeURIComponent(jobId)}?after=${after}`);
  },

  latexCancelJob(this: EngineTransport, jobId: string): Promise<Record<string, never>> {
    return this.request("DELETE", `/v2/latex/jobs/${encodeURIComponent(jobId)}`);
  },
};
