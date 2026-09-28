/**
 * THE MIGRATION IS THE RISKY PART OF THE PLUGIN HOST, so it gets the tests.
 *
 * Not "does the schema parse" — the interesting properties are the ones a
 * reviewer worried about the rollout would ask about, and each has a named case
 * below:
 *
 *   - a project that predates the map migrates from its legacy blocks
 *   - once the marker is present the map is the WHOLE truth, and a missing
 *     entry is OFF rather than a legacy read (the resurrection bug)
 *   - the legacy blocks an older engine wrote fold into the map with their
 *     settings, a disabled one stays off, and re-running changes nothing
 */
import { describe, expect, test } from "bun:test";
import {
  applyPluginPatch,
  LEGACY_PLUGIN_KEYS,
  migrateLegacyPluginFields,
  pluginBlock,
  pluginConfigFromLegacy,
  legacyFromPluginConfig,
  pluginEnabled,
  pluginSettings,
  PROJECT_PLUGINS_VERSION,
  PluginMeta,
  ProjectPlugins,
  readProjectPlugins,
} from "../src/protocol/plugins";
import { TELAR_CAPABILITIES, parseToolName } from "../src/protocol/tools";

const latexLegacy = { enabled: true, mainFile: "paper.tex", toolchain: { kind: "tectonic" } };
const dsLegacy = { enabled: true, stack: ["pandas"] };

describe("reading the map", () => {
  test("a pre-migration project migrates from its legacy blocks", () => {
    const { plugins, migrated } = readProjectPlugins({ latex: latexLegacy, dataScience: dsLegacy });
    expect(migrated).toBe(false);
    expect(plugins.version).toBe(PROJECT_PLUGINS_VERSION);
    expect(pluginEnabled(plugins, "latex")).toBe(true);
    expect(pluginSettings(plugins, "latex")).toEqual({ mainFile: "paper.tex", toolchain: { kind: "tectonic" } });
    expect(pluginEnabled(plugins, "data-science")).toBe(true);
  });

  test("a project that never opted into anything migrates to an empty map", () => {
    const { plugins, migrated } = readProjectPlugins({});
    expect(migrated).toBe(false);
    expect(plugins.entries).toEqual({});
    expect(pluginEnabled(plugins, "latex")).toBe(false);
  });

  test("legacy `enabled: false` migrates as disabled rather than absent", () => {
    // A stored `{enabled:false}` is a project that turned the feature OFF, not
    // one that never asked. Both read as off; the distinction only matters
    // because dropping the entry would also drop the settings beside it.
    const { plugins } = readProjectPlugins({ latex: { enabled: false, mainFile: "paper.tex" } });
    expect(pluginEnabled(plugins, "latex")).toBe(false);
    expect(pluginSettings(plugins, "latex")).toEqual({ mainFile: "paper.tex" });
  });

  test("THE MARKER WINS ENTIRELY — a missing entry is OFF, never a legacy read", () => {
    // This is the resurrection bug, asserted as absent. The project has a
    // stale, enabled legacy LaTeX block and a migrated map with no LaTeX entry
    // (because somebody turned it off). LaTeX must stay off.
    const { plugins, migrated } = readProjectPlugins({
      plugins: { version: 1, entries: { "data-science": { enabled: true } } },
      latex: latexLegacy,
    });
    expect(migrated).toBe(true);
    expect(pluginEnabled(plugins, "latex")).toBe(false);
    expect(pluginSettings(plugins, "latex")).toEqual({});
  });

  test("a map that disagrees with a legacy block wins on settings too", () => {
    const { plugins } = readProjectPlugins({
      plugins: { version: 1, entries: { latex: { enabled: true, settings: { mainFile: "thesis.tex" } } } },
      latex: latexLegacy,
    });
    expect(pluginSettings(plugins, "latex")).toEqual({ mainFile: "thesis.tex" });
  });

  test("a malformed map falls back to migrating rather than throwing", () => {
    // Corruption should degrade to the pre-migration path, which is recoverable,
    // rather than making the project unreadable.
    const { plugins, migrated } = readProjectPlugins({ plugins: { version: "one" }, latex: latexLegacy });
    expect(migrated).toBe(false);
    expect(pluginEnabled(plugins, "latex")).toBe(true);
  });
});

describe("the legacy translation", () => {
  test("round-trips", () => {
    expect(legacyFromPluginConfig(pluginConfigFromLegacy(latexLegacy))).toEqual(latexLegacy);
  });

  test("names exactly the two plugins that predate the map", () => {
    expect(LEGACY_PLUGIN_KEYS).toEqual({ latex: "latex", "data-science": "dataScience" });
  });
});

describe("folding the legacy blocks into the map", () => {
  test("a legacy-only record folds into the map with its settings, and the keys are dropped", () => {
    const { project, changed } = migrateLegacyPluginFields({ id: "p", latex: latexLegacy, dataScience: dsLegacy });
    expect(changed).toBe(true);
    expect(project).toEqual({
      id: "p",
      plugins: {
        version: PROJECT_PLUGINS_VERSION,
        entries: {
          latex: { enabled: true, settings: { mainFile: "paper.tex", toolchain: { kind: "tectonic" } } },
          "data-science": { enabled: true, settings: { stack: ["pandas"] } },
        },
      },
    });
    expect("latex" in project).toBe(false);
    expect("dataScience" in project).toBe(false);
  });

  test("A DISABLED LEGACY BLOCK STAYS OFF, and keeps its settings", () => {
    const { project } = migrateLegacyPluginFields({ latex: { enabled: false, mainFile: "paper.tex" } });
    const plugins = readProjectPlugins(project).plugins;
    expect(pluginEnabled(plugins, "latex")).toBe(false);
    expect(pluginSettings(plugins, "latex")).toEqual({ mainFile: "paper.tex" });
  });

  test("RE-RUNNING IS A NO-OP", () => {
    const once = migrateLegacyPluginFields({ id: "p", latex: latexLegacy, dataScience: dsLegacy });
    const twice = migrateLegacyPluginFields(once.project);
    expect(twice.changed).toBe(false);
    expect(twice.project).toEqual(once.project);
  });

  test("a record nobody configured is untouched — no empty map is invented", () => {
    const record = { id: "p" };
    const { project, changed } = migrateLegacyPluginFields(record);
    expect(changed).toBe(false);
    expect(project).toEqual({ id: "p" });
  });

  test("an existing map entry wins over a legacy block for the same id", () => {
    const { project, changed } = migrateLegacyPluginFields({
      plugins: { version: 1, entries: { latex: { enabled: true, settings: { mainFile: "thesis.tex" } }, hello: { enabled: true } } },
      latex: latexLegacy,
      dataScience: dsLegacy,
    });
    expect(changed).toBe(true);
    const plugins = readProjectPlugins(project).plugins;
    expect(pluginSettings(plugins, "latex")).toEqual({ mainFile: "thesis.tex" });
    // The id the map did not name is filled from its legacy block, and an
    // unrelated entry survives.
    expect(pluginSettings(plugins, "data-science")).toEqual({ stack: ["pandas"] });
    expect(pluginEnabled(plugins, "hello")).toBe(true);
    expect("latex" in project).toBe(false);
  });
});

describe("a plugin's flat block", () => {
  test("is the entry as `{enabled, ...settings}`", () => {
    const project = { plugins: { version: 1, entries: { latex: { enabled: true, settings: { mainFile: "paper.tex" } } } } };
    expect(pluginBlock(project, "latex")).toEqual({ enabled: true, mainFile: "paper.tex" });
  });

  test("is undefined when the map has no entry, even beside a stale legacy block", () => {
    expect(pluginBlock({ plugins: { version: 1, entries: {} }, latex: latexLegacy }, "latex")).toBeUndefined();
  });

  test("reads an older engine's legacy-only record", () => {
    expect(pluginBlock({ dataScience: dsLegacy }, "data-science")).toEqual(dsLegacy);
  });

  test("an explicitly-disabled entry reads as `enabled: false`, not as an absence", () => {
    const next = applyPluginPatch({ version: 1, entries: {} }, { latex: { enabled: false, settings: { mainFile: "paper.tex" } } });
    expect(pluginBlock({ plugins: next }, "latex")).toEqual({ enabled: false, mainFile: "paper.tex" });
  });
});

describe("patching", () => {
  test("a patch never touches an unnamed plugin", () => {
    const base: ProjectPlugins = { version: 1, entries: { latex: { enabled: true }, hello: { enabled: true } } };
    const next = applyPluginPatch(base, { "data-science": { enabled: true } });
    expect(Object.keys(next.entries).sort()).toEqual(["data-science", "hello", "latex"]);
  });

  test("a patch stamps the current version, so patching a migrated map marks it", () => {
    const next = applyPluginPatch({ version: 1, entries: {} }, { hello: { enabled: true } });
    expect(next.version).toBe(PROJECT_PLUGINS_VERSION);
  });
});

describe("the capability list", () => {
  test("MOVING THE PLUGIN PREFIXES OUT OF `TELAR_CAPABILITIES` TOOK NOTHING AWAY", () => {
    // The refactor's safety claim, pinned: every capability that routed before
    // still routes, so no `startsWith` check, item mapping or approval route
    // changed. Two ADDITIONS: `hello`, the proof plugin's prefix, which needs
    // declaring for its rows to be typed when the gate is on; and `run`, which
    // is CORE rather than a plugin and joins the list in the same change that
    // mounts its toolkit. `spool` LEFT in #501, with the toolkit it named —
    // the same rule read the other way. `prompt` joined in #87 under the same
    // rule as `run`: core, and listed in the change that mounts its wall. So
    // did `terminal`, with the toolkit that opens terminals for an agent.
    for (const capability of ["browser", "sessions", "notebook", "ds", "latex", "display"]) {
      expect(TELAR_CAPABILITIES).toContain(capability);
    }
    expect(TELAR_CAPABILITIES).not.toContain("spool");
    expect([...TELAR_CAPABILITIES].sort()).toEqual(
      ["browser", "sessions", "notebook", "ds", "latex", "display", "run", "terminal", "prompt", "hello"].sort(),
    );
  });

  test("a plugin tool still parses to its capability", () => {
    expect(parseToolName("mcp__telar__latex_compile")).toEqual({
      server: "telar",
      tool: "latex_compile",
      capability: "latex",
    });
  });
});

describe("the manifest schema discriminates", () => {
  const valid = {
    id: "data-science",
    api: 1,
    name: "Data Science",
    version: "1.0.0",
    toolPrefixes: ["ds", "notebook"],
  };

  test("a manifest with two tool prefixes is valid — id and prefix are separate namespaces", () => {
    const parsed = PluginMeta.parse(valid);
    expect(parsed.toolPrefixes).toEqual(["ds", "notebook"]);
    expect(parsed.readTools).toEqual([]);
  });

  test("an id with an underscore is rejected — ids are route segments, not tool prefixes", () => {
    expect(PluginMeta.safeParse({ ...valid, id: "data_science" }).success).toBe(false);
  });

  test("a tool prefix carrying its own underscore is rejected", () => {
    // `ds_` would make the host build `ds__` when it appends the separator.
    expect(PluginMeta.safeParse({ ...valid, toolPrefixes: ["ds_"] }).success).toBe(false);
  });

  test("a manifest with no tool prefixes is accepted", () => {
    // A UI-only external plugin, or a refused manifest, owns no prefix.
    expect(PluginMeta.safeParse({ ...valid, toolPrefixes: [] }).success).toBe(true);
  });
});
