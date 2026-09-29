/**
 * THE SETTINGS PANES ARE A LOOKUP, and these are the rules it keeps: the two
 * shipped features resolve to the editors they always had, and a plugin with
 * no entry falls back to the generic pane rather than to nothing.
 */
import { expect, mock, test } from "bun:test";

/** The bespoke panes read the router on render. Stubbed as in `data-science-section.test.tsx`. */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { machineBlocksFor, projectPaneFor, SETTINGS_PANES } = await import("./settings-panes");
const { DataScienceSection } = await import("../data-science/data-science-section");
const { DataSciencePackagesRow } = await import("../data-science/machine-settings");
const { LatexSection } = await import("../latex/latex-section");
const { LatexDistributionSettings } = await import("../latex/machine-settings");

test("the two shipped features keep only what the generated pane cannot draw", () => {
  expect(projectPaneFor("data-science")).toBe(DataScienceSection);
  // The Mac scope is generated; each adds the one block its schema cannot express.
  expect(machineBlocksFor("data-science")).toEqual({ machineRows: DataSciencePackagesRow });
  expect(projectPaneFor("latex")).toBe(LatexSection);
  expect(machineBlocksFor("latex")).toEqual({ machineGroups: LatexDistributionSettings });
  // Losing an id here would silently replace a working editor with a checkbox.
  expect(Object.keys(SETTINGS_PANES).sort()).toEqual(["data-science", "latex"]);
});

test("a plugin with no entry resolves to none — including an inherited key", () => {
  expect(projectPaneFor("hello")).toBeUndefined();
  expect(machineBlocksFor("hello")).toEqual({});
  expect(projectPaneFor("constructor")).toBeUndefined();
});
