import { z } from "zod";

export const PLUGIN_API_VERSION = 1;

export const PluginId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "a plugin id is lowercase letters, digits and dashes, starting with a letter");
export type PluginId = z.infer<typeof PluginId>;

export const PluginToolPrefix = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9]*$/, "a tool prefix is lowercase letters and digits, starting with a letter");

export const PluginSettingsScope = z.enum(["project", "machine"]);
export type PluginSettingsScope = z.infer<typeof PluginSettingsScope>;

export const PluginSettingsSection = z.object({
  /** Unique within the plugin. Becomes part of the surface's key. */
  id: z.string().min(1).max(64),
  scope: PluginSettingsScope,
  label: z.string().min(1).max(80),
  /** One line under the label. */
  blurb: z.string().max(200).optional(),
  /** Lucide icon name, resolved by the web registry. Unknown names fall back. */
  icon: z.string().min(1).max(64).optional(),
});
export type PluginSettingsSection = z.infer<typeof PluginSettingsSection>;

/** A session verb, as the generic door spells it: `status`, `jobs-refresh`. */
const PluginSessionVerb = z.string().regex(/^[a-z][a-z0-9-]*$/, "a verb is lowercase letters, digits and dashes");

export const PluginPanel = z.strictObject({
  /** Unique within the plugin. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),
  label: z.string().min(1).max(40),
  /** The session verb that answers with a `PluginPanelView`. */
  verb: PluginSessionVerb,
});
export type PluginPanel = z.infer<typeof PluginPanel>;

const Cell = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const PluginPanelBlock = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("heading"), text: z.string().min(1).max(200) }),
  /** Plain text, or Markdown when `markdown` is set. */
  z.strictObject({ type: z.literal("text"), text: z.string().max(20_000), markdown: z.boolean().optional() }),
  z.strictObject({
    type: z.literal("keyValue"),
    items: z.array(z.strictObject({ key: z.string().min(1).max(200), value: Cell })).max(100),
  }),
  z.strictObject({
    type: z.literal("table"),
    columns: z.array(z.string().max(200)).min(1).max(20),
    rows: z.array(z.array(Cell).max(20)).max(500),
  }),
  /** The tail of something, oldest line first, drawn monospaced. */
  z.strictObject({ type: z.literal("log"), lines: z.array(z.string().max(2000)).max(500) }),
  /**
   * A button that calls one of the plugin's session verbs with `input`, then
   * redraws the panel. `confirm` is the sentence asked before it runs.
   */
  z.strictObject({
    type: z.literal("action"),
    label: z.string().min(1).max(40),
    verb: PluginSessionVerb,
    input: z.record(z.string(), z.unknown()).optional(),
    confirm: z.string().min(1).max(200).optional(),
  }),
]);
export type PluginPanelBlock = z.infer<typeof PluginPanelBlock>;

export function parsePluginPanelView(value: unknown): { blocks: PluginPanelBlock[]; skipped: number } {
  const raw = (value as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(raw)) return { blocks: [], skipped: 0 };
  const blocks: PluginPanelBlock[] = [];
  for (const candidate of raw.slice(0, 200)) {
    const parsed = PluginPanelBlock.safeParse(candidate);
    if (parsed.success) blocks.push(parsed.data);
  }
  return { blocks, skipped: raw.length - blocks.length };
}

export const PluginMeta = z.object({
  id: PluginId,
  /** The contract revision this plugin is written against. */
  api: z.number().int().min(1),
  /** What a human calls it. */
  name: z.string().min(1).max(80),
  /** The plugin's own version, for display and for support questions. */
  version: z.string().min(1).max(32),
  blurb: z.string().max(300).optional(),
  icon: z.string().min(1).max(64).optional(),
  toolPrefixes: z.array(PluginToolPrefix),
  readTools: z.array(z.string().min(1)).default([]),
  briefing: z.string().min(1).max(2000).optional(),
  /** Journal event kinds this plugin emits, inside the `plugin.event` envelope. */
  eventKinds: z.array(z.string().min(1)).default([]),
  sessionStateDir: z.string().min(1).max(64).optional(),
  /** A `.gitignore` rule the plugin wants in projects that enable it. */
  gitignore: z
    .object({
      rule: z.string().min(1),
      why: z.string().min(1),
      alreadyCovered: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  settings: z.array(PluginSettingsSection).default([]),
  /** Panel surfaces drawn from blocks (external plugins). Absent for bundled ones, which ship components. */
  panels: z.array(PluginPanel).optional(),
});
export type PluginMeta = z.infer<typeof PluginMeta>;

export const ExternalPluginTool = z.strictObject({
  /** Must start with the manifest's `toolPrefix` and an underscore. */
  name: z.string().regex(/^[a-z][a-z0-9]*_[a-z0-9_]+$/, "a tool name is <prefix>_<name>, lowercase"),
  description: z.string().min(1).max(2000),
  /** The arguments, as a JSON Schema object. */
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
});
export type ExternalPluginTool = z.infer<typeof ExternalPluginTool>;

/** A route key as the host's scoped tables spell it: `"GET status"`, `"POST jobs/:id"`. */
const ExternalRouteKey = z.string().regex(/^(GET|POST|DELETE) [a-z][a-z0-9-]*(\/(:?[a-z][a-z0-9-]*))*$/, "a route is '<METHOD> <path>'");

export const ExternalPluginManifest = z
  .strictObject({
    id: PluginId,
    api: z.literal(PLUGIN_API_VERSION),
    name: z.string().min(1).max(80),
    version: z.string().min(1).max(32),
    description: z.string().max(300).optional(),
    icon: z.string().min(1).max(64).optional(),
    /** argv. A first element starting with `./` is resolved inside the plugin's folder. */
    command: z.array(z.string().min(1)).min(1),
    /** Required once the plugin declares a tool. */
    toolPrefix: PluginToolPrefix.optional(),
    tools: z.array(ExternalPluginTool).max(64).default([]),
    /** The paragraph a session is told while the plugin is on. */
    briefing: z.string().min(1).max(2000).optional(),
    settingsSchema: z.record(z.string(), z.unknown()).optional(),
    machineSettingsSchema: z.record(z.string(), z.unknown()).optional(),
    routes: z
      .strictObject({
        session: z.array(PluginSessionVerb).default([]),
        project: z.array(ExternalRouteKey).default([]),
        machine: z.array(ExternalRouteKey).default([]),
      })
      .default({ session: [], project: [], machine: [] }),
    /** Panel surfaces, each drawn from a declared session verb. */
    panels: z.array(PluginPanel).max(8).default([]),
  })
  .superRefine((manifest, context) => {
    if (manifest.tools.length > 0 && !manifest.toolPrefix) {
      context.addIssue({ code: "custom", path: ["toolPrefix"], message: "a plugin that declares tools needs a toolPrefix" });
    }
    for (const [index, tool] of manifest.tools.entries()) {
      if (manifest.toolPrefix && !tool.name.startsWith(`${manifest.toolPrefix}_`)) {
        context.addIssue({ code: "custom", path: ["tools", index, "name"], message: `must start with "${manifest.toolPrefix}_"` });
      }
    }
    if (new Set(manifest.tools.map((tool) => tool.name)).size !== manifest.tools.length) {
      context.addIssue({ code: "custom", path: ["tools"], message: "two tools share a name" });
    }
    // `tool` is the verb a tool call travels under; a route may not shadow it.
    if (manifest.routes.session.includes("tool")) {
      context.addIssue({ code: "custom", path: ["routes", "session"], message: '"tool" is reserved' });
    }
    for (const [index, panel] of manifest.panels.entries()) {
      if (!manifest.routes.session.includes(panel.verb)) {
        context.addIssue({ code: "custom", path: ["panels", index, "verb"], message: `"${panel.verb}" is not a declared session route` });
      }
    }
    if (new Set(manifest.panels.map((panel) => panel.id)).size !== manifest.panels.length) {
      context.addIssue({ code: "custom", path: ["panels"], message: "two panels share an id" });
    }
  });
export type ExternalPluginManifest = z.infer<typeof ExternalPluginManifest>;

/** What a plugin's runtime is doing, as the health document reports it. */
export const PluginRuntimeState = z.enum(["ready", "failed", "disposed"]);
export type PluginRuntimeState = z.infer<typeof PluginRuntimeState>;

export const PluginStatus = z.object({
  meta: PluginMeta,
  state: PluginRuntimeState,
  /** Present when `state` is `failed` — the sentence a human should read. */
  error: z.string().optional(),
  /** How long `init` took, so a slow plugin is visible before it is a bug report. */
  initMs: z.number().optional(),
  settingsSchema: z.record(z.string(), z.unknown()).optional(),
  machineSettingsSchema: z.record(z.string(), z.unknown()).optional(),
  installed: z.object({ linked: z.boolean() }).optional(),
});
export type PluginStatus = z.infer<typeof PluginStatus>;

/** Install a plugin from a folder on this Mac: copied in, or linked to where it is. */
export const PluginInstallInput = z.strictObject({
  path: z.string().min(1),
  mode: z.enum(["copy", "link"]).default("copy"),
});
export type PluginInstallInput = z.input<typeof PluginInstallInput>;

// ── per-project configuration ───────────────────────────────────────────────

export const PluginConfig = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type PluginConfig = z.infer<typeof PluginConfig>;

export const PROJECT_PLUGINS_VERSION = 1;

export const ProjectPlugins = z.object({
  version: z.number().int().min(1),
  entries: z.record(PluginId, PluginConfig),
});
export type ProjectPlugins = z.infer<typeof ProjectPlugins>;

export const LEGACY_PLUGIN_KEYS = {
  latex: "latex",
  "data-science": "dataScience",
} as const satisfies Record<string, "latex" | "dataScience">;

export const BUNDLED_PLUGIN_TOOL_PREFIXES = ["ds", "notebook", "latex", "hello"] as const;

export function pluginConfigFromLegacy(legacy: Record<string, unknown>): PluginConfig {
  const { enabled, ...rest } = legacy;
  const settings = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  return {
    enabled: enabled === true,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

export function legacyFromPluginConfig(config: PluginConfig): Record<string, unknown> {
  return { enabled: config.enabled, ...config.settings };
}

export function readProjectPlugins(project: {
  plugins?: unknown;
  latex?: unknown;
  dataScience?: unknown;
}): { plugins: ProjectPlugins; migrated: boolean } {
  const parsed = ProjectPlugins.safeParse(project.plugins);
  if (parsed.success) return { plugins: parsed.data, migrated: true };

  const entries: Record<string, PluginConfig> = {};
  for (const [id, key] of Object.entries(LEGACY_PLUGIN_KEYS)) {
    const legacy = project[key];
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      entries[id] = pluginConfigFromLegacy(legacy as Record<string, unknown>);
    }
  }
  return { plugins: { version: PROJECT_PLUGINS_VERSION, entries }, migrated: false };
}

export function migrateLegacyPluginFields(project: Record<string, unknown>): { project: Record<string, unknown>; changed: boolean } {
  const legacyKeys = Object.values(LEGACY_PLUGIN_KEYS).filter((key) => project[key] !== undefined);
  if (legacyKeys.length === 0) return { project, changed: false };
  const current = ProjectPlugins.safeParse(project.plugins);
  const entries: Record<string, PluginConfig> = current.success ? { ...current.data.entries } : {};
  for (const [id, key] of Object.entries(LEGACY_PLUGIN_KEYS)) {
    const legacy = project[key];
    if (entries[id] !== undefined || !legacy || typeof legacy !== "object" || Array.isArray(legacy)) continue;
    entries[id] = pluginConfigFromLegacy(legacy as Record<string, unknown>);
  }
  const { latex: _latex, dataScience: _dataScience, ...rest } = project;
  void _latex;
  void _dataScience;
  return { project: { ...rest, plugins: { version: PROJECT_PLUGINS_VERSION, entries } }, changed: true };
}

/**
 * A plugin's entry as one flat block — `{enabled, ...settings}`, the shape the
 * Data Science and LaTeX settings panes and resolvers read. `undefined` when
 * the project has no entry for it (which means off).
 */
export function pluginBlock(project: { plugins?: unknown; latex?: unknown; dataScience?: unknown }, id: string): Record<string, unknown> | undefined {
  const config = readProjectPlugins(project).plugins.entries[id];
  return config ? legacyFromPluginConfig(config) : undefined;
}

/** Whether a project has a plugin switched on. The single question every gate asks. */
export function pluginEnabled(plugins: ProjectPlugins, id: string): boolean {
  return plugins.entries[id]?.enabled === true;
}

/** A plugin's settings blob, or `{}`. Still unvalidated — the host does that. */
export function pluginSettings(plugins: ProjectPlugins, id: string): Record<string, unknown> {
  return plugins.entries[id]?.settings ?? {};
}

export type PluginPatch = Record<string, PluginConfig | null>;

export function applyPluginPatch(plugins: ProjectPlugins, patch: PluginPatch): ProjectPlugins {
  const entries = { ...plugins.entries };
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) delete entries[id];
    else entries[id] = config;
  }
  return { version: PROJECT_PLUGINS_VERSION, entries };
}

// ── machine-wide configuration ──────────────────────────────────────────────

export const MachinePlugins = ProjectPlugins;
export type MachinePlugins = ProjectPlugins;

export function machineAllows(machine: ProjectPlugins | undefined, id: string): boolean {
  const entry = machine?.entries[id];
  return entry === undefined ? true : entry.enabled;
}

/** What actually runs: the machine allows it and the project asked for it. */
export function pluginEffectivelyEnabled(
  machine: ProjectPlugins | undefined,
  project: ProjectPlugins,
  id: string,
): boolean {
  return machineAllows(machine, id) && pluginEnabled(project, id);
}

export function machineSettings(machine: ProjectPlugins | undefined, id: string): Record<string, unknown> {
  return machine?.entries[id]?.settings ?? {};
}

// ── the bundled plugins' machine settings, for clients ──────────────────────

/** What latexmk drives when nothing more specific said. Tectonic ignores it. */
export const PluginLatexEngine = z.enum(["pdflatex", "lualatex", "xelatex"]);
export type PluginLatexEngine = z.infer<typeof PluginLatexEngine>;

/**
 * A distribution choice, as a machine default. `managed` is Telar's own
 * Tectonic and carries no path — see `LatexToolchainKind` for why naming the
 * intent beats storing a versioned path that goes stale on the next bump.
 */
export const PluginLatexDistribution = z.object({
  kind: z.enum(["tectonic", "texlive", "managed"]),
  path: z.string().min(1).optional(),
  engine: PluginLatexEngine.optional(),
});
export type PluginLatexDistribution = z.infer<typeof PluginLatexDistribution>;

export const PluginLatexDistributionWrite = PluginLatexDistribution.refine(
  (choice) => choice.kind === "managed" || (choice.path !== undefined && choice.path.length > 0),
  { message: "a tectonic or texlive distribution needs the path it lives at", path: ["path"] },
);

const latexMachineFields = {
  /** Which TeX install compiles here when the project has not chosen one. */
  toolchain: PluginLatexDistribution.optional(),
  /**
   * The engine a TeX Live compile runs. Tectonic is XeTeX inside and ignores it.
   * The `.meta()` here and below is the cockpit's generated settings row.
   */
  engine: PluginLatexEngine.optional().meta({
    title: "Default engine",
    description: "What latexmk drives on a TeX Live install. Tectonic is XeTeX inside and ignores it.",
    icon: "settings",
    labels: { pdflatex: "pdfLaTeX", lualatex: "LuaLaTeX", xelatex: "XeLaTeX" },
  }),
  autoInstallPackages: z.boolean().optional().meta({
    title: "Install missing packages automatically",
    description:
      "When a TeX Live compile fails on a package it does not have, install it with tlmgr and compile once more. Tectonic already fetches packages by itself.",
    icon: "package-plus",
  }),
};

const dataScienceMachineFields = {
  python: z.string().min(1).optional().meta({
    title: "Default Python",
    description: "The interpreter a project with none of its own runs its kernel on.",
    info: "An absolute path: a Mac-wide default cannot be relative to a checkout.",
    widget: "path",
    icon: "flask-conical",
  }),
  packages: z.array(z.string().min(1).max(200)).max(200).optional(),
};

export const PLUGIN_PACKAGE_REQUIREMENT =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,\s-]+\])?\s*((?:[<>=!~]=?|===)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:[<>=!~]=?|===)\s*[A-Za-z0-9.*+!_-]+)*)?$/;

export const LatexMachineSettings = z.object(latexMachineFields);
export type LatexMachineSettings = z.infer<typeof LatexMachineSettings>;

export const DataScienceMachineSettings = z.object(dataScienceMachineFields);
export type DataScienceMachineSettings = z.infer<typeof DataScienceMachineSettings>;

/** What a write is checked against. Strict, and per-kind about the path. */
export const LatexMachineSettingsWrite = z.strictObject({
  ...latexMachineFields,
  toolchain: PluginLatexDistributionWrite.optional(),
});
export const DataScienceMachineSettingsWrite = z.strictObject({
  ...dataScienceMachineFields,
  packages: z.array(z.string().min(1).max(200).regex(PLUGIN_PACKAGE_REQUIREMENT, "not a package requirement")).max(200).optional(),
});

/** The LaTeX defaults this Mac carries, read out of the opaque blob. */
export function latexMachineSettings(machine: ProjectPlugins | undefined): LatexMachineSettings {
  const parsed = LatexMachineSettings.safeParse(machineSettings(machine, "latex"));
  return parsed.success ? parsed.data : {};
}

/** The data-science defaults this Mac carries, read out of the opaque blob. */
export function dataScienceMachineSettings(machine: ProjectPlugins | undefined): DataScienceMachineSettings {
  const parsed = DataScienceMachineSettings.safeParse(machineSettings(machine, "data-science"));
  return parsed.success ? parsed.data : {};
}
