/**
 * THE PLUGIN HOST'S SERIALIZABLE HALF — metadata and per-project configuration,
 * and NOTHING EXECUTABLE. Everything in this file can be written to
 * `projects.json`, sent over the wire, decoded by a phone, or one day read out
 * of a folder somebody dropped into `~/.telar/plugins`. The executable half —
 * zod schemas for settings, capability factories, lifecycle hooks, React
 * components — lives in `apps/engine/src/plugins/contract.ts` and never crosses
 * a wire.
 *
 * THE SPLIT IS THE WHOLE POINT. Bundled plugins are trusted in-process code and
 * this file does not pretend otherwise: nothing here is a sandbox, and a
 * bundled plugin's engine module can do anything the daemon can. What the split
 * buys is that the day external installation ships, the manifest ON DISK is
 * exactly `PluginMeta` — unchanged — and only the module-loading half is new.
 *
 * ── WHY A MAP AND NOT MORE FIELDS ON `Project` ──────────────────────────────
 * `Project` grew `dataScience` and then `latex`, each a bespoke optional block
 * with its own patch arm in `updateProject`. A third would have been a third
 * arm. `ProjectPlugins` is the last one: a versioned map from plugin id to
 * `{enabled, settings}`, where `settings` is opaque here and validated by the
 * plugin that owns it.
 */
import { z } from "zod";

/**
 * The contract revision a plugin is written against. ONE number, checked at
 * registration: a plugin declaring an api the host does not implement fails to
 * register rather than half-working.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * A plugin id is a route segment, a config key and a settings-page key. It is
 * NOT a tool prefix — see `toolPrefixes` — and the two namespaces are kept
 * apart deliberately: Data Science is one plugin (`data-science`) that owns two
 * shipped tool prefixes (`ds_`, `notebook_`), and renaming either tool to match
 * the id would split every remembered approval.
 */
export const PluginId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "a plugin id is lowercase letters, digits and dashes, starting with a letter");
export type PluginId = z.infer<typeof PluginId>;

/**
 * A tool prefix, without its trailing underscore. `latex` means the plugin owns
 * every tool called `latex_*`. Prefixes are GLOBALLY UNIQUE across registered
 * plugins and are asserted so at registration — two plugins claiming `ds` would
 * make `parseToolName` ambiguous and route approvals to whichever registered
 * first.
 */
export const PluginToolPrefix = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9]*$/, "a tool prefix is lowercase letters and digits, starting with a letter");

/**
 * Where a plugin's settings page hangs. `project` is the common case — the
 * per-project drawer beside "Data science" today. `machine` is for the things
 * that are properties of the Mac rather than the checkout (a TeX distribution,
 * a Python install), which today live on the same page and confuse people.
 */
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

/**
 * EVERYTHING THE HOST NEEDS TO KNOW ABOUT A PLUGIN WITHOUT RUNNING IT.
 *
 * `readTools` deserves its own sentence, because it is the field most likely to
 * be misread as a grant. IT IS NOT ONE. A plugin naming a tool here is making a
 * CLAIM that the tool only reads; the host's own policy decides whether that
 * claim is honoured (see `apps/engine/src/plugins/policy.ts`). A plugin cannot
 * widen its own authority by editing its manifest, which is precisely the
 * property that has to hold before external plugins are conceivable.
 */
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
  /** Tool prefixes this plugin owns, without trailing underscores. */
  toolPrefixes: z.array(PluginToolPrefix).min(1),
  /**
   * Tools this plugin CLAIMS are pure reads. A claim, not a grant — the host
   * ratifies. Names are unqualified (`latex_status`, not `mcp__telar__…`).
   */
  readTools: z.array(z.string().min(1)).default([]),
  /** Journal event kinds this plugin emits, inside the `plugin.event` envelope. */
  eventKinds: z.array(z.string().min(1)).default([]),
  /**
   * The directory under `sessions/<id>/` this plugin keeps per-session state
   * in. DELIBERATELY INDEPENDENT OF `id`: Data Science keeps `sessions/<id>/ds/`
   * and always will, because moving a live user's files to match a new naming
   * scheme is a migration nobody asked for.
   */
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
});
export type PluginMeta = z.infer<typeof PluginMeta>;

/** What a plugin's runtime is doing, as the health document reports it. */
export const PluginRuntimeState = z.enum(["ready", "failed", "disposed"]);
export type PluginRuntimeState = z.infer<typeof PluginRuntimeState>;

/**
 * One plugin as `GET /v2/health` and the settings page see it. Additive on
 * every client: the phone's `EngineHealth` decodes three known keys and ignores
 * this one entirely, which is exactly the tolerance we want while there is no
 * mobile plugin surface.
 */
export const PluginStatus = z.object({
  meta: PluginMeta,
  state: PluginRuntimeState,
  /** Present when `state` is `failed` — the sentence a human should read. */
  error: z.string().optional(),
  /** How long `init` took, so a slow plugin is visible before it is a bug report. */
  initMs: z.number().optional(),
});
export type PluginStatus = z.infer<typeof PluginStatus>;

// ── per-project configuration ───────────────────────────────────────────────

/**
 * One plugin's per-project state. `settings` is OPAQUE HERE and validated by
 * the plugin's own zod schema at the host boundary — the protocol deliberately
 * does not know what a LaTeX toolchain choice looks like, which is what lets a
 * plugin change its own settings shape without touching this file.
 */
export const PluginConfig = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type PluginConfig = z.infer<typeof PluginConfig>;

/**
 * THE MAP, AND ITS DURABLE MARKER.
 *
 * `version` is not decoration and not a schema version to bump casually: its
 * PRESENCE is the fact that this project has been migrated, and that fact is
 * what makes the map authoritative. Once it is there:
 *
 *   - the map is the WHOLE truth. A plugin absent from `entries` is OFF.
 *   - legacy `Project.latex` / `Project.dataScience` are never read again.
 *
 * That second rule is the one that kills the resurrection bug. A one-time copy
 * plus a "fall back to legacy when the entry is missing" read looks harmless
 * and is not: disabling LaTeX deletes the map entry, the next read falls back
 * to the stale legacy block, and the feature turns itself back on.
 */
export const PROJECT_PLUGINS_VERSION = 1;

export const ProjectPlugins = z.object({
  version: z.number().int().min(1),
  entries: z.record(PluginId, PluginConfig),
});
export type ProjectPlugins = z.infer<typeof ProjectPlugins>;

/**
 * WHICH PLUGINS STILL WRITE A LEGACY MIRROR, and why this is a list rather than
 * a date.
 *
 * While an id is in here, every write to the map ALSO writes the matching
 * `Project.latex` / `Project.dataScience` block, in the same atomic write. The
 * mirror exists for exactly one reader: an OLDER engine binary. `Project` is a
 * plain `z.object`, so an old engine parsing this registry strips the unknown
 * `plugins` key and, on its next write, drops it — leaving only the mirror. A
 * user who rolls back a nightly therefore keeps their LaTeX and Data Science
 * settings, and rolling forward re-migrates from the mirror.
 *
 * REMOVING AN ID FROM THIS LIST IS A DELIBERATE COMPATIBILITY DECISION, not
 * something that happens on a schedule. It says: we no longer support rolling
 * back to an engine that predates the plugin map. Until somebody decides that
 * out loud, the mirrors stay.
 */
export const MIRRORED_PLUGINS = ["latex", "data-science"] as const;
export type MirroredPlugin = (typeof MIRRORED_PLUGINS)[number];

/**
 * EVERY TOOL PREFIX A BUNDLED PLUGIN OWNS, declared in the protocol rather than
 * discovered from the registry — and the reason is that three consumers need to
 * know it in places the registry cannot reach.
 *
 * `parseToolName` maps a tool to its capability so an approval card and a
 * timeline row can be typed; that function runs in the web app and its answer is
 * decoded by a phone. Neither has a plugin host. If the prefix list were built
 * at daemon startup, the cockpit would have to be TOLD the list before it could
 * render a `latex_compile` row — and until it was, every plugin tool would fall
 * into the anonymous `mcp_tool_call` bucket, which is the exact defect
 * `tools.ts` was written to fix.
 *
 * So the list is data, it lives in the serializable half, and the HOST ASSERTS
 * AGAINST IT at startup: a registered plugin whose prefix is missing here fails
 * loudly rather than quietly losing its typed display.
 *
 * WHAT THIS COSTS, said plainly: a plugin installed from a folder cannot appear
 * here, so its tools would render as generic MCP calls. That is a real limit of
 * the bundled milestone, not something the map solves, and closing it needs a
 * registration path from daemon to client that does not exist yet.
 */
export const BUNDLED_PLUGIN_TOOL_PREFIXES = ["ds", "notebook", "latex", "hello"] as const;

/** The legacy `Project` key each mirrored plugin shadows. */
export const LEGACY_PLUGIN_KEYS: Record<MirroredPlugin, "latex" | "dataScience"> = {
  latex: "latex",
  "data-science": "dataScience",
};

/**
 * A legacy block is `{enabled, ...settings}` flattened; the map keeps `enabled`
 * and `settings` apart. These two functions are the only translation, stated
 * once so the read and the write cannot drift.
 */
export function pluginConfigFromLegacy(legacy: Record<string, unknown>): PluginConfig {
  const { enabled, ...rest } = legacy;
  const settings = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  return {
    enabled: enabled === true,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

export function legacyFromPluginConfig(config: PluginConfig): Record<string, unknown> {
  return { enabled: config.enabled, ...(config.settings ?? {}) };
}

/**
 * THE ONE READ PATH. Given a project record as it sits on disk — which may be
 * pre-migration, migrated, or a migrated one an old engine stripped — answer
 * what the plugin map IS.
 *
 * `migrated` tells the caller whether the answer came from the marker or from
 * legacy fields, which is what `updateProject` uses to decide it must write the
 * marker back on the next write.
 */
export function readProjectPlugins(project: {
  plugins?: unknown;
  latex?: unknown;
  dataScience?: unknown;
}): { plugins: ProjectPlugins; migrated: boolean } {
  const parsed = ProjectPlugins.safeParse(project.plugins);
  // THE MARKER WINS ENTIRELY. No per-key fallback to legacy: see the comment on
  // PROJECT_PLUGINS_VERSION for why a fallback resurrects disabled features.
  if (parsed.success) return { plugins: parsed.data, migrated: true };

  const entries: Record<string, PluginConfig> = {};
  for (const id of MIRRORED_PLUGINS) {
    const legacy = project[LEGACY_PLUGIN_KEYS[id]];
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      entries[id] = pluginConfigFromLegacy(legacy as Record<string, unknown>);
    }
  }
  return { plugins: { version: PROJECT_PLUGINS_VERSION, entries }, migrated: false };
}

/**
 * The legacy blocks a given map implies — INCLUDING THE ABSENCES. A plugin with
 * no entry yields `undefined`, and the caller must DELETE the legacy key rather
 * than leave it: a mirror that is only ever added is the resurrection bug with
 * extra steps.
 */
export function legacyMirrors(plugins: ProjectPlugins): Record<"latex" | "dataScience", Record<string, unknown> | undefined> {
  const mirrors = { latex: undefined, dataScience: undefined } as Record<
    "latex" | "dataScience",
    Record<string, unknown> | undefined
  >;
  for (const id of MIRRORED_PLUGINS) {
    const config = plugins.entries[id];
    mirrors[LEGACY_PLUGIN_KEYS[id]] = config ? legacyFromPluginConfig(config) : undefined;
  }
  return mirrors;
}

/** Whether a project has a plugin switched on. The single question every gate asks. */
export function pluginEnabled(plugins: ProjectPlugins, id: string): boolean {
  return plugins.entries[id]?.enabled === true;
}

/** A plugin's settings blob, or `{}`. Still unvalidated — the host does that. */
export function pluginSettings(plugins: ProjectPlugins, id: string): Record<string, unknown> {
  return plugins.entries[id]?.settings ?? {};
}

/**
 * One patch to the map, as `updateProject` applies it. `null` DELETES the entry
 * — the same spelling `dataScience: null` has today, kept because "off" being
 * an absence rather than a stored `{enabled:false}` is what stops the registry
 * growing a row for every project that tried a feature once.
 */
export type PluginPatch = Record<string, PluginConfig | null>;

export function applyPluginPatch(plugins: ProjectPlugins, patch: PluginPatch): ProjectPlugins {
  const entries = { ...plugins.entries };
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) delete entries[id];
    else entries[id] = config;
  }
  return { version: PROJECT_PLUGINS_VERSION, entries };
}
