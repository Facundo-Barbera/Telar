/**
 * THE SETTINGS NAV IS DERIVED, and these are the rules that derivation follows.
 *
 * The page used to hardcode two sections. What replaced it must keep both
 * working exactly as before while making a third arrive without an edit — so
 * every case here is either "the shipped features are unchanged" or "a new one
 * appears on its own".
 */
import { expect, test } from "bun:test";
import type { PluginStatus } from "@telar/engine-client";
import { blockPatch, enablePatch, machineSettingsPatch, projectPluginSections } from "./sections";

const status = (id: string, extra: Partial<PluginStatus["meta"]> = {}, rest: Partial<PluginStatus> = {}): PluginStatus => ({
  meta: {
    id,
    api: 1,
    name: id,
    version: "1.0.0",
    toolPrefixes: [id],
    readTools: [],
    eventKinds: [],
    settings: [],
    ...extra,
  },
  state: "ready",
  ...rest,
});

test("a plugin's project-scoped sections become nav entries", () => {
  const entries = projectPluginSections([
    status("latex", {
      settings: [
        { id: "document", scope: "project", label: "LaTeX", blurb: "The document a compile builds." },
        // MACHINE-SCOPED IS EXCLUDED: a TeX distribution is a property of the
        // Mac, and offering it per project invites setting it once per repo and
        // wondering why it followed you.
        { id: "toolchain", scope: "machine", label: "TeX distribution" },
      ],
    }),
  ]);
  expect(entries.map((entry) => [entry.key, entry.label])).toEqual([["latex", "LaTeX"]]);
  expect(entries[0]?.blurb).toBe("The document a compile builds.");
});

test("a plugin that declares NO section still gets one", () => {
  // A plugin a project can enable must be reachable somewhere to enable it.
  // Falling back to the manifest's own name beats being invisible.
  const entries = projectPluginSections([status("hello", { name: "Hello", blurb: "A proof plugin." })]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ key: "hello", pluginId: "hello", label: "Hello", blurb: "A proof plugin." });
});

test("a plugin's SECOND section gets a qualified key, so two plugins cannot collide", () => {
  const entries = projectPluginSections([
    status("alpha", {
      settings: [
        { id: "one", scope: "project", label: "One" },
        { id: "two", scope: "project", label: "Two" },
      ],
    }),
  ]);
  expect(entries.map((entry) => entry.key)).toEqual(["alpha", "alpha:two"]);
});

test("a FAILED plugin still appears, carrying its reason", () => {
  // A missing section is indistinguishable from a feature that was removed. A
  // present one that says "did not start" is actionable.
  const entries = projectPluginSections([status("latex", {}, { state: "failed", error: "no TeX found" })]);
  expect(entries[0]).toMatchObject({ state: "failed", error: "no TeX found" });
});

test("enabling writes the map entry; disabling REMOVES it", () => {
  // "Off" as an absence rather than a stored `{enabled:false}` is what stops the
  // registry growing a row for every project that tried a feature once.
  expect(enablePatch("hello", true)).toEqual({ plugins: { hello: { enabled: true } } });
  expect(enablePatch("hello", false)).toEqual({ plugins: { hello: null } });
  expect(enablePatch("hello", true, { greeting: "hi" })).toEqual({
    plugins: { hello: { enabled: true, settings: { greeting: "hi" } } },
  });
});

test("a bespoke pane's flat block is written as a map entry, never a legacy key", () => {
  const python = { source: "chosen", path: ".venv/bin/python", resolvedAt: 1 };
  expect(blockPatch("data-science", { enabled: true, python })).toEqual({
    plugins: { "data-science": { enabled: true, settings: { python } } },
  });
  // Off with a kept interpreter stays a stored `{enabled:false}` with its settings.
  expect(blockPatch("data-science", { enabled: false, python })).toEqual({
    plugins: { "data-science": { enabled: false, settings: { python } } },
  });
  expect(blockPatch("latex", { enabled: true })).toEqual({ plugins: { latex: { enabled: true } } });
  expect(blockPatch("latex", null)).toEqual({ plugins: { latex: null } });
});

test("no plugins is an empty nav, not a crash", () => {
  expect(projectPluginSections(undefined)).toEqual([]);
  expect(projectPluginSections([])).toEqual([]);
});

test("saving a Mac-wide default keeps the Mac-wide switch where it was", () => {
  const off = { version: 1, entries: { latex: { enabled: false } } };
  // The bug: every save sent `enabled: true`, re-enabling a plugin this Mac had off.
  expect(machineSettingsPatch(off, "latex", { engine: "xelatex" })).toEqual({
    latex: { enabled: false, settings: { engine: "xelatex" } },
  });
  // No entry means allowed, as the engine reads it.
  expect(machineSettingsPatch(undefined, "data-science", {})).toEqual({ "data-science": { enabled: true, settings: {} } });
});
