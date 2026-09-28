import fs from "node:fs";
import {
  applyPluginPatch,
  DataScienceConfig as DataScienceConfigSchema,
  LatexConfig as LatexConfigSchema,
  machineAllows,
  machineSettings,
  pluginBlock,
  pluginEffectivelyEnabled,
  PROJECT_PLUGINS_VERSION,
  ProjectPlugins as ProjectPluginsSchema,
  readProjectPlugins,
  type DataScienceConfig,
  type LatexConfig,
  type PluginPatch,
  type Project,
  type ProjectPlugins,
  type Session,
} from "@telar/engine-client";
import { resolvePythonPath } from "./data-science/python-env";
import { toolchainStatus, type Toolchain } from "./data-science/toolchain";
import type { ResolvedLatex } from "./latex/compile";
import { ManagedTectonic, type ManagedTectonicStatus } from "./latex/managed";
import { latexToolchainStatus, type LatexToolchain } from "./latex/toolchain";
import type { Kernel } from "../../platform/kernel";
import { DataScienceMachineSettings as DataScienceMachineSettingsSchema } from "./data-science/plugin";
import { LatexMachineSettings as LatexMachineSettingsSchema } from "./latex/plugin";
import { workspaceRootOf } from "../sessions";

const TOOLCHAIN_CACHE_MS = 5_000;

// Read from the plugin map only; settings that no longer parse are dropped, and the switch survives.
function typedPluginBlock<T>(project: Project, id: string, schema: { safeParse(value: unknown): { success: boolean; data?: T } }): T | undefined {
  const block = pluginBlock(project, id);
  if (!block) return undefined;
  const parsed = schema.safeParse(block);
  return parsed.success ? parsed.data : schema.safeParse({ enabled: block.enabled === true }).data;
}
export const dataScienceBlock = (project: Project): DataScienceConfig | undefined => typedPluginBlock(project, "data-science", DataScienceConfigSchema);
export const latexBlock = (project: Project): LatexConfig | undefined => typedPluginBlock(project, "latex", LatexConfigSchema);

type ToolchainDeps = { getProject: (projectId: string) => Project };

/**
 * The Mac's plugin ceiling, which interpreter and TeX toolchain a session
 * resolves to, the toolchain probes behind the Plugins pane, and Telar's own
 * Tectonic. Disabling a plugin for the Mac never touches a project's settings.
 */
export class PluginToolchains {
  private dsToolchainCache?: { until: number; value: Promise<Toolchain> };
  private latexToolchainCache?: { until: number; value: Promise<LatexToolchain> };
  private managedInstall?: ManagedTectonic;

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: ToolchainDeps,
  ) {}

  /** An absent file allows everything, so a Mac that predates it keeps its plugins. */
  machine(): ProjectPlugins {
    const parsed = ProjectPluginsSchema.safeParse(this.kernel.readDocument(this.kernel.paths.machinePlugins));
    return parsed.success ? parsed.data : { version: PROJECT_PLUGINS_VERSION, entries: {} };
  }

  updateMachine(patch: PluginPatch): ProjectPlugins {
    const next = applyPluginPatch(this.machine(), patch);
    this.kernel.writeDocument(this.kernel.paths.machinePlugins, next);
    return structuredClone(next);
  }

  runs(project: Project, id: string): boolean {
    return pluginEffectivelyEnabled(this.machine(), readProjectPlugins(project).plugins, id);
  }

  /** The plugin ids a session's project turned on, under the Mac's ceiling; a worker builds its walls from this. */
  enabledIds(session: Session): string[] {
    const project = this.projectOf(session);
    if (!project) return [];
    const machine = this.machine();
    return Object.entries(readProjectPlugins(project).plugins.entries)
      .filter(([id, config]) => config.enabled && machineAllows(machine, id))
      .map(([id]) => id)
      .sort();
  }

  /**
   * The interpreter a session runs on: the project's own (a relative path
   * resolves against the session's tree, never the project root's), else the
   * Mac's absolute default. Nothing when off, or the file isn't there.
   */
  resolveDataScience(session: Session): { pythonPath: string } | undefined {
    const project = this.projectOf(session);
    const config = project && dataScienceBlock(project);
    if (!config?.enabled || !machineAllows(this.machine(), "data-science")) return undefined;
    const machineDefault = DataScienceMachineSettingsSchema.safeParse(machineSettings(this.machine(), "data-science"));
    const chosen = config.python?.path ?? (machineDefault.success ? machineDefault.data.python : undefined);
    if (!chosen) return undefined;
    const pythonPath = resolvePythonPath(workspaceRootOf(session), chosen);
    if (!fs.existsSync(pythonPath)) return undefined;
    return { pythonPath };
  }

  /**
   * The TeX toolchain a session compiles with: the project's choice, then the
   * Mac's default, then Telar's managed Tectonic. Each must exist on disk;
   * `mainFile` resolves against the session's own tree when compiling.
   */
  resolveLatex(session: Session): ResolvedLatex | undefined {
    const project = this.projectOf(session);
    const config = project && latexBlock(project);
    if (!config?.enabled || !machineAllows(this.machine(), "latex")) return undefined;
    const machine = LatexMachineSettingsSchema.safeParse(machineSettings(this.machine(), "latex"));
    const machineDefaults = machine.success ? machine.data : {};
    for (const choice of [config.toolchain, machineDefaults.toolchain]) {
      if (!choice) continue;
      const binPath = choice.kind === "managed" ? this.managed().found()?.path : choice.path;
      if (!binPath || !fs.existsSync(binPath)) continue;
      const engine = choice.engine ?? machineDefaults.engine;
      return {
        kind: choice.kind === "managed" ? "tectonic" : (choice.kind as ResolvedLatex["kind"]),
        binPath,
        ...(engine ? { engine: engine as ResolvedLatex["engine"] } : {}),
        ...(config.mainFile ? { mainFile: config.mainFile } : {}),
        ...(machineDefaults.autoInstallPackages ? { autoInstallPackages: true } : {}),
      };
    }
    const managed = this.managed().found();
    if (!managed) return undefined;
    return { kind: "tectonic", binPath: managed.path, ...(config.mainFile ? { mainFile: config.mainFile } : {}) };
  }

  /** uv, conda, Homebrew and the Pythons they see; cached briefly because each answer is several spawns. */
  dataScienceToolchain(fresh = false): Promise<Toolchain> {
    if (!fresh && this.dsToolchainCache && this.kernel.now() < this.dsToolchainCache.until) return this.dsToolchainCache.value;
    const value = toolchainStatus();
    this.dsToolchainCache = { until: this.kernel.now() + TOOLCHAIN_CACHE_MS, value };
    void value.catch(() => { this.dsToolchainCache = undefined; });
    return value;
  }

  forgetDataScienceToolchain(): void {
    this.dsToolchainCache = undefined;
  }

  /** The managed Tectonic's status rides outside the cache: it is one `stat` and changes when a download finishes. */
  latexToolchain(fresh = false): Promise<LatexToolchain> {
    if (fresh || !this.latexToolchainCache || this.kernel.now() >= this.latexToolchainCache.until) {
      const value = latexToolchainStatus();
      this.latexToolchainCache = { until: this.kernel.now() + TOOLCHAIN_CACHE_MS, value };
      void value.catch(() => { this.latexToolchainCache = undefined; });
    }
    return this.latexToolchainCache.value.then((toolchain) => ({ ...toolchain, managed: this.managedStatus() }));
  }

  forgetLatexToolchain(): void {
    this.latexToolchainCache = undefined;
  }

  managedStatus(): ManagedTectonicStatus {
    return this.managed().status();
  }

  /** Idempotent; the toolchain cache is dropped so the next probe reports the new binary. */
  async installManaged(): Promise<ManagedTectonicStatus> {
    const status = await this.managed().install();
    this.latexToolchainCache = undefined;
    return status;
  }

  // One instance: the single-flight install and its last error are shared by every request.
  private managed(): ManagedTectonic {
    this.managedInstall ??= new ManagedTectonic({ root: this.kernel.paths.root });
    return this.managedInstall;
  }

  private projectOf(session: Session): Project | undefined {
    if (!session.projectId) return undefined;
    try {
      return this.deps.getProject(session.projectId);
    } catch {
      return undefined;
    }
  }
}
