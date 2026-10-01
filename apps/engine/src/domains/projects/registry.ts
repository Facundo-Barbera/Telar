import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  applyPluginPatch,
  DataScienceConfig as DataScienceConfigSchema,
  LatexConfig as LatexConfigSchema,
  pluginConfigFromLegacy,
  Project as ProjectSchema,
  readProjectPlugins,
  type DataScienceConfig,
  type EnvMode,
  type LatexConfig,
  type ModelSelection,
  type PluginPatch,
  type Project,
} from "@telar/engine-client";
import { assertId, assertStateVersion, EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";
import { volumeForRoot, volumeForRootAsync, type VolumeDeps, type VolumeIdentity } from "../../platform/fs/volumes";
import { ensureTelarGitignore } from "../git";
import type { ProjectIcon } from "../appearance";
import type { ProjectProbes } from "./probes";

export type ProjectRegistryDocument = { version: typeof STATE_VERSION; projects: Project[] };

export type ProjectPatch = {
  name?: string;
  iconName?: string | null;
  iconEmoji?: string | null;
  defaultModel?: ModelSelection | null;
  envMode?: EnvMode | null;
  dataScience?: DataScienceConfig | null;
  latex?: LatexConfig | null;
  plugins?: PluginPatch;
};

function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new EngineStateError("invalid_request", `${label} must be an absolute path`);
}

function parseRegistry(value: unknown): ProjectRegistryDocument {
  assertStateVersion(value, "project registry");
  const projects = ProjectSchema.array().safeParse((value as { projects?: unknown }).projects);
  if (!projects.success) throw new EngineStateError("invalid_request", "invalid project registry");
  for (const project of projects.data) assertAbsolutePath(project.root, "project root");
  return { version: STATE_VERSION, projects: projects.data };
}

type RegistryDeps = {
  probes: ProjectProbes;
  volumes: VolumeDeps;
  sessionsOf: (projectId: string) => string[];
  hasWorkInFlight: (sessionId: string) => boolean;
};

/**
 * The registered projects. Removal leaves a tombstone (`removedAt`) rather than
 * deleting the row, because sessions, MCP servers and browser profiles outlive
 * a registration by id; registering the same folder again restores it.
 */
export class ProjectRegistry {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: RegistryDeps,
  ) {}

  /** The parsed document, or an empty one when none was written. */
  read(): ProjectRegistryDocument {
    const stored = this.kernel.readDocument(this.kernel.paths.projects);
    return stored === undefined ? { version: STATE_VERSION, projects: [] } : parseRegistry(stored);
  }

  write(registry: ProjectRegistryDocument): void {
    this.kernel.writeDocument(this.kernel.paths.projects, registry);
  }

  /** Removed projects are excluded unless asked for, and are never probed. */
  list(options: { includeRemoved?: boolean } = {}): Project[] {
    const stored = this.kernel.readDocument(this.kernel.paths.projects);
    if (stored === undefined) return [];
    return structuredClone(parseRegistry(stored).projects)
      .filter((project) => options.includeRemoved || project.removedAt === undefined)
      .map((project) => {
        if (project.removedAt !== undefined) return project;
        // The metadata read probes, so availability is asked after it rather than beside it.
        const metadata = this.deps.probes.metadata(project);
        return { ...project, ...metadata, availability: this.deps.probes.availability(project) };
      });
  }

  get(projectId: string): Project {
    assertId(projectId, "project id");
    const stored = this.kernel.readDocument(this.kernel.paths.projects);
    const project = stored === undefined ? undefined : parseRegistry(stored).projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    return structuredClone(project);
  }

  /** Registers a folder; one a removed project had restores that project, same id. The disk's volume is recorded here, once. */
  /** Refuses new work on a removed project or an unplugged drive; reads stay open. A missing folder is the worker's to refuse. */
  assertAvailable(projectId: string): void {
    const project = this.get(projectId);
    if (project.removedAt !== undefined) {
      throw new EngineStateError("conflict", "this project was removed from Telar; restore it to start work on it again");
    }
    if (this.deps.probes.availability(project) === "unmounted") {
      throw new EngineStateError("conflict", `The drive holding ${project.name} is not connected. Plug it back in and this will work again.`);
    }
  }

  /** The icon's bytes-on-disk; refuses when the project has none rather than guessing. */
  async iconFile(projectId: string): Promise<ProjectIcon> {
    const icon = await this.deps.probes.icon(this.get(projectId));
    if (!icon) throw new EngineStateError("not_found", "this project has no icon");
    return icon;
  }

  register(input: { id?: string; name: string; root: string }): Project {
    if (input.id !== undefined) assertId(input.id, "project id");
    if (typeof input.name !== "string" || input.name.trim() === "") throw new EngineStateError("invalid_request", "project name must be non-empty");
    assertAbsolutePath(input.root, "project root");
    let projectRoot: string;
    let directory: boolean;
    try {
      projectRoot = fs.realpathSync.native(input.root);
      directory = fs.statSync(projectRoot).isDirectory();
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new EngineStateError("invalid_request", "project root must be an existing directory");
      throw new EngineStateError(
        "invalid_request",
        `project root could not be read${code ? ` (${code})` : ""}: check that Telar is allowed into that folder, and for a cloud folder that its sync app is running`,
      );
    }
    if (!directory) throw new EngineStateError("invalid_request", "project root must be an existing directory");
    const parsed = this.read();
    const id = input.id ?? `project_${crypto.randomUUID().replaceAll("-", "")}`;
    const volume = volumeForRoot(projectRoot, this.deps.volumes);
    const tombstone = parsed.projects.find((project) => project.root === projectRoot && project.removedAt !== undefined);
    if (tombstone && (input.id === undefined || input.id === tombstone.id)) {
      delete tombstone.removedAt;
      tombstone.name = input.name.trim();
      tombstone.updatedAt = this.kernel.now();
      // What the disk says now wins over what was put away.
      if (volume === undefined) delete tombstone.volume;
      else tombstone.volume = volume;
      this.write(parsed);
      this.deps.probes.forget(tombstone.id);
      this.recordVolumeLater(tombstone.id, projectRoot, volume);
      return structuredClone(tombstone);
    }
    const existing = parsed.projects.find((project) => project.id === id || project.root === projectRoot);
    if (existing) {
      if (existing.id === id && existing.root === projectRoot && existing.removedAt === undefined) return structuredClone(existing);
      throw new EngineStateError("conflict", "project id or root is already registered");
    }
    const at = this.kernel.now();
    const project: Project = {
      id,
      environmentId: "local",
      name: input.name.trim(),
      root: projectRoot,
      createdAt: at,
      updatedAt: at,
      ...(volume === undefined ? {} : { volume }),
    };
    parsed.projects.push(project);
    this.write(parsed);
    this.deps.probes.forget(id);
    this.recordVolumeLater(id, projectRoot, volume);
    return structuredClone(project);
  }

  private recordVolumeLater(projectId: string, root: string, known: VolumeIdentity | undefined): void {
    if (known !== undefined) return;
    void volumeForRootAsync(root, this.deps.volumes).then((volume) => {
      if (volume === undefined) return;
      const parsed = this.read();
      const project = parsed.projects.find((candidate) => candidate.id === projectId);
      if (!project || project.root !== root || project.volume !== undefined) return;
      project.volume = volume;
      this.write(parsed);
      this.deps.probes.forgetAvailability(projectId);
    }).catch(() => undefined);
  }

  /** Puts a project away; refused while any of its sessions has work in flight. Nothing on disk is touched. */
  unregister(projectId: string): { project: Project; sessions: number } {
    assertId(projectId, "project id");
    const parsed = this.read();
    const project = parsed.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    if (project.removedAt !== undefined) throw new EngineStateError("conflict", "this project is already removed");
    const sessions = this.deps.sessionsOf(projectId);
    const busy = sessions.filter((sessionId) => this.deps.hasWorkInFlight(sessionId));
    if (busy.length > 0) {
      throw new EngineStateError(
        "conflict",
        `this project has ${busy.length === 1 ? "a session with work in flight" : `${busy.length} sessions with work in flight`} — let them finish or stop them first`,
      );
    }
    project.removedAt = this.kernel.now();
    project.updatedAt = project.removedAt;
    this.write(parsed);
    this.deps.probes.forget(projectId);
    return { project: structuredClone(project), sessions: sessions.length };
  }

  restore(projectId: string): Project {
    assertId(projectId, "project id");
    const parsed = this.read();
    const project = parsed.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new EngineStateError("not_found", "project does not exist");
    if (project.removedAt === undefined) return structuredClone(project);
    delete project.removedAt;
    project.updatedAt = this.kernel.now();
    this.write(parsed);
    this.deps.probes.forget(projectId);
    return structuredClone(project);
  }

  /**
   * Changes a project's name, icon, defaults and plugins; never its root. `null`
   * removes a stored answer. A removed project's settings are frozen. The legacy
   * `dataScience`/`latex` keys are accepted only as plugin patches.
   */
  update(projectId: string, patch: ProjectPatch): Project {
    assertId(projectId, "project id");
    const parsed = this.read();
    const index = parsed.projects.findIndex((candidate) => candidate.id === projectId);
    if (index < 0) throw new EngineStateError("not_found", "project does not exist");
    const current = parsed.projects[index]!;
    if (current.removedAt !== undefined) throw new EngineStateError("conflict", "this project was removed from Telar; restore it to change its settings");
    const next: Project = { ...current, updatedAt: this.kernel.now() };
    if (patch.name !== undefined) {
      const name = typeof patch.name === "string" ? patch.name.trim() : "";
      if (name === "") throw new EngineStateError("invalid_request", "project name must be non-empty");
      if (name.length > 200) throw new EngineStateError("invalid_request", "project name is too long");
      next.name = name;
    }
    // One picked icon: naming either kind clears the other.
    if (patch.iconName === null) delete next.iconName;
    else if (patch.iconName !== undefined) {
      const glyph = ProjectSchema.shape.iconName.safeParse(typeof patch.iconName === "string" ? patch.iconName.trim() : patch.iconName);
      if (!glyph.success || glyph.data === undefined) throw new EngineStateError("invalid_request", "project icon must be an icon name");
      next.iconName = glyph.data;
      delete next.iconEmoji;
    }
    if (patch.iconEmoji === null) delete next.iconEmoji;
    else if (patch.iconEmoji !== undefined) {
      const mark = ProjectSchema.shape.iconEmoji.safeParse(typeof patch.iconEmoji === "string" ? patch.iconEmoji.trim() : patch.iconEmoji);
      if (!mark.success || mark.data === undefined) throw new EngineStateError("invalid_request", "project icon must be a short mark");
      next.iconEmoji = mark.data;
      delete next.iconName;
    }
    if (patch.defaultModel === null) delete next.defaultModel;
    else if (patch.defaultModel !== undefined) {
      const model = ProjectSchema.shape.defaultModel.safeParse(patch.defaultModel);
      if (!model.success || model.data === undefined) throw new EngineStateError("invalid_request", "default model selection is invalid");
      next.defaultModel = model.data;
    }
    if (patch.envMode === null) delete next.envMode;
    else if (patch.envMode !== undefined) {
      const mode = ProjectSchema.shape.envMode.safeParse(patch.envMode);
      if (!mode.success || mode.data === undefined) throw new EngineStateError("invalid_request", "workspace mode must be local or worktree");
      next.envMode = mode.data;
    }
    const fromLegacy: PluginPatch = {};
    if (patch.dataScience !== undefined) {
      if (patch.dataScience === null) fromLegacy["data-science"] = null;
      else {
        const config = DataScienceConfigSchema.safeParse(patch.dataScience);
        if (!config.success) throw new EngineStateError("invalid_request", "data science configuration is invalid");
        fromLegacy["data-science"] = pluginConfigFromLegacy(config.data);
      }
    }
    if (patch.latex !== undefined) {
      if (patch.latex === null) fromLegacy.latex = null;
      else {
        const config = LatexConfigSchema.safeParse(patch.latex);
        if (!config.success) throw new EngineStateError("invalid_request", "LaTeX configuration is invalid");
        fromLegacy.latex = pluginConfigFromLegacy(config.data);
      }
    }
    const pluginPatch: PluginPatch = { ...fromLegacy, ...patch.plugins };
    if (Object.keys(pluginPatch).length > 0) {
      next.plugins = applyPluginPatch(readProjectPlugins(next).plugins, pluginPatch);
      if (pluginPatch.latex?.enabled) {
        try {
          ensureTelarGitignore(next.root, [{ rule: ".telar/latex/", alreadyCovered: [".telar/", ".telar", "/.telar/", ".telar/latex/"], why: "LaTeX aux files from Telar's compiles" }]);
        } catch { /* not a repo, or unwritable — compiles still work */ }
      }
    }
    delete (next as Record<string, unknown>).dataScience;
    delete (next as Record<string, unknown>).latex;
    parsed.projects[index] = next;
    this.write(parsed);
    return structuredClone(next);
  }
}
