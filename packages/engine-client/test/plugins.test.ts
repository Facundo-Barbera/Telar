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
 *   - disabling writes an absence to BOTH sides, so no reader anywhere can
 *     still see the old settings
 *   - an old engine stripping `plugins` and rewriting the mirror is survivable,
 *     and rolling forward re-migrates to the same state
 */
import { describe, expect, test } from "bun:test";
import {
  applyPluginPatch,
  legacyMirrors,
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

describe("legacy mirrors", () => {
  test("an enabled entry mirrors back to the exact legacy shape", () => {
    const { plugins } = readProjectPlugins({ latex: latexLegacy, dataScience: dsLegacy });
    const mirrors = legacyMirrors(plugins);
    expect(mirrors.latex).toEqual(latexLegacy);
    expect(mirrors.dataScience).toEqual(dsLegacy);
  });

  test("DISABLING WRITES AN ABSENCE TO BOTH SIDES", () => {
    // The mirror must be deleted, not merely left alone. A mirror that is only
    // ever added is the resurrection bug wearing a rollback hat.
    const { plugins } = readProjectPlugins({ latex: latexLegacy, dataScience: dsLegacy });
    const next = applyPluginPatch(plugins, { latex: null });
    const mirrors = legacyMirrors(next);
    expect(mirrors.latex).toBeUndefined();
    expect(mirrors.dataScience).toEqual(dsLegacy);
  });

  test("an explicitly-disabled entry mirrors as `enabled: false`, not as an absence", () => {
    const { plugins } = readProjectPlugins({ latex: latexLegacy });
    const next = applyPluginPatch(plugins, { latex: { enabled: false, settings: { mainFile: "paper.tex" } } });
    expect(legacyMirrors(next).latex).toEqual({ enabled: false, mainFile: "paper.tex" });
  });

  test("the legacy translation round-trips", () => {
    expect(legacyFromPluginConfig(pluginConfigFromLegacy(latexLegacy))).toEqual(latexLegacy);
  });
});

describe("rollback and roll-forward", () => {
  /** What an OLD engine binary does to the registry: `Project` is a plain
   *  `z.object`, so the unknown `plugins` key is stripped on parse and gone on
   *  the next write. The mirror is all that survives. */
  const asOldEngineRewrote = (project: Record<string, unknown>) => {
    const { plugins: _stripped, ...rest } = project;
    return rest;
  };

  test("rolling back keeps the settings, and rolling forward re-migrates to the same map", () => {
    const { plugins } = readProjectPlugins({ latex: latexLegacy, dataScience: dsLegacy });
    const onDisk = { plugins, ...legacyMirrors(plugins) };

    const afterRollback = asOldEngineRewrote(onDisk);
    expect(afterRollback.latex).toEqual(latexLegacy);

    const rolledForward = readProjectPlugins(afterRollback);
    expect(rolledForward.migrated).toBe(false);
    expect(rolledForward.plugins).toEqual(plugins);
  });

  test("A FEATURE DISABLED BEFORE A ROLLBACK STAYS DISABLED AFTER ROLLING FORWARD", () => {
    // The end-to-end statement of the hazard: disable under the new engine,
    // roll back to one that cannot see the map, roll forward again. LaTeX must
    // not come back on.
    const { plugins } = readProjectPlugins({ latex: latexLegacy, dataScience: dsLegacy });
    const disabled = applyPluginPatch(plugins, { latex: null });
    const onDisk = { plugins: disabled, ...legacyMirrors(disabled) };
    expect(onDisk.latex).toBeUndefined();

    const rolledForward = readProjectPlugins(asOldEngineRewrote(onDisk));
    expect(pluginEnabled(rolledForward.plugins, "latex")).toBe(false);
    expect(pluginEnabled(rolledForward.plugins, "data-science")).toBe(true);
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
    // changed. `hello` is the one ADDITION — the proof plugin's prefix, which
    // needs to be declared for its rows to be typed when the gate is on.
    for (const capability of ["browser", "spool", "sessions", "notebook", "ds", "latex", "display"]) {
      expect(TELAR_CAPABILITIES).toContain(capability);
    }
    expect([...TELAR_CAPABILITIES].sort()).toEqual(
      ["browser", "spool", "sessions", "notebook", "ds", "latex", "display", "hello"].sort(),
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

  test("a manifest with no tool prefixes is rejected", () => {
    expect(PluginMeta.safeParse({ ...valid, toolPrefixes: [] }).success).toBe(false);
  });
});
