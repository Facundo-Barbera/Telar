/**
 * WHICH PLUGIN SECTIONS A PROJECT'S SETTINGS PAGE SHOWS, derived from the
 * engine rather than listed here.
 *
 * The page used to hardcode "Data science" and "LaTeX" in its nav array, so a
 * third feature meant a third entry, a third import and a third conditional.
 * The engine already reports every registered plugin and the sections each one
 * contributes (`EngineHealth.plugins[].meta.settings`), so the nav is a
 * projection of that.
 *
 * TWO SECTIONS KEEP THEIR BESPOKE PANES. Data science and LaTeX shipped with
 * real editors — an environment picker, a toolchain probe — and a generic
 * enable/configure pane would be a downgrade for both. So a contributed section
 * whose id matches one of those renders the pane that already exists, and
 * everything else gets the generic one. That is the whole compatibility rule.
 */
import type { PluginStatus } from "@telar/engine-client";

/** A settings entry a plugin contributed, flattened for the nav. */
export type PluginSectionEntry = {
  /** Unique across plugins: `<pluginId>` for the first section, `<pluginId>:<sectionId>` after. */
  key: string;
  pluginId: string;
  sectionId: string;
  label: string;
  blurb?: string;
  icon?: string;
  scope: "project" | "machine";
  /** The plugin's state, so a failed one can say so instead of pretending. */
  state: PluginStatus["state"];
  error?: string;
};

/**
 * The plugins whose panes are written by hand and must keep rendering.
 *
 * NOT A DENYLIST — these plugins are shown, they simply use their own editor.
 * Removing an id here would silently replace a working environment picker with
 * a checkbox, which is why the mapping is stated rather than inferred.
 */
export const BESPOKE_PLUGIN_PANES: Record<string, string> = {
  "data-science": "data-science",
  latex: "latex",
};

/** Whether this plugin renders its own pane rather than the generic one. */
export function hasBespokePane(pluginId: string): boolean {
  return pluginId in BESPOKE_PLUGIN_PANES;
}

/**
 * Flatten every registered plugin's project-scoped sections into nav entries.
 *
 * MACHINE-SCOPED SECTIONS ARE EXCLUDED HERE. A TeX distribution is a property
 * of the Mac, not of a checkout, and putting it on a project page would invite
 * someone to set it per project and wonder why it followed them.
 */
export function projectPluginSections(plugins: readonly PluginStatus[] | undefined): PluginSectionEntry[] {
  const entries: PluginSectionEntry[] = [];
  for (const status of plugins ?? []) {
    const sections = status.meta.settings.filter((section) => section.scope === "project");
    // A plugin with no declared section still gets one, because a plugin a
    // project can ENABLE must be reachable somewhere to enable it. Falling back
    // to the manifest's own name is better than it being invisible.
    const declared =
      sections.length > 0
        ? sections
        : [{ id: "general", scope: "project" as const, label: status.meta.name, ...(status.meta.blurb ? { blurb: status.meta.blurb } : {}), ...(status.meta.icon ? { icon: status.meta.icon } : {}) }];
    for (const [index, section] of declared.entries()) {
      entries.push({
        key: index === 0 ? status.meta.id : `${status.meta.id}:${section.id}`,
        pluginId: status.meta.id,
        sectionId: section.id,
        label: section.label,
        ...(section.blurb ? { blurb: section.blurb } : {}),
        ...(section.icon ? { icon: section.icon } : {}),
        scope: "project",
        state: status.state,
        ...(status.error ? { error: status.error } : {}),
      });
    }
  }
  return entries;
}

/**
 * THE ENABLE PATCH, in the map's vocabulary.
 *
 * `null` turns a plugin OFF by removing its entry, which is the same spelling
 * `dataScience: null` has always had — "off" as an absence rather than a stored
 * `{enabled:false}` is what stops the registry growing a row for every project
 * that tried a feature once.
 *
 * Settings ride along on enable so a person who configures and enables in one
 * action gets one write, and the plugin validates the blob at the engine.
 */
export function enablePatch(pluginId: string, enabled: boolean, settings?: Record<string, unknown>) {
  return {
    plugins: {
      [pluginId]: enabled ? { enabled: true, ...(settings ? { settings } : {}) } : null,
    },
  };
}
