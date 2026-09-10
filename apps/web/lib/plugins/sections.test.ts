/**
 * THE SETTINGS NAV IS DERIVED, and these are the rules that derivation follows.
 *
 * The page used to hardcode two sections. What replaced it must keep both
 * working exactly as before while making a third arrive without an edit — so
 * every case here is either "the shipped features are unchanged" or "a new one
 * appears on its own".
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import type { PluginStatus } from "@telar/engine-client";
import { BESPOKE_PLUGIN_PANES, enablePatch, hasBespokePane, projectPluginSections } from "./sections";

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

test("the two shipped features keep their bespoke panes", () => {
  // The compatibility rule, pinned. Losing an id here would silently replace a
  // working environment picker with a checkbox.
  expect(hasBespokePane("data-science")).toBe(true);
  expect(hasBespokePane("latex")).toBe(true);
  expect(hasBespokePane("hello")).toBe(false);
  expect(Object.keys(BESPOKE_PLUGIN_PANES).sort()).toEqual(["data-science", "latex"]);
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

test("no plugins is an empty nav, not a crash", () => {
  expect(projectPluginSections(undefined)).toEqual([]);
  expect(projectPluginSections([])).toEqual([]);
});
