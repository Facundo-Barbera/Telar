/**
 * THE SETTINGS PANES ARE A LOOKUP, and these are the rules it keeps: the two
 * shipped features resolve to the editors they always had, and a plugin with
 * no entry falls back to the generic pane rather than to nothing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PROJECT_PLUGINS_VERSION, type PluginStatus, type Project } from "@telar/engine-client";

/** The bespoke panes read the router on render. Stubbed as in `data-science-section.test.tsx`. */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { machineBlocksFor, projectPaneFor, SETTINGS_PANES } = await import("./settings-panes");
const { DataScienceSection } = await import("@/components/settings/data-science-section");
const { DataSciencePackagesRow } = await import("@/components/settings/data-science-machine-settings");
const { LatexSection } = await import("@/components/settings/latex-section");
const { LatexDistributionSettings } = await import("@/components/settings/latex-machine-settings");
const { ProjectPluginPanes } = await import("@/components/settings/projects-page");

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

const status = (id: string, name: string): PluginStatus =>
  ({ meta: { id, name, settings: [{ id: "general", scope: "project", label: name }] }, state: "ready" }) as never;

const enabledFor = (...ids: string[]): Project =>
  ({
    id: "project_1",
    name: "Telar",
    root: "/tmp/telar",
    plugins: { version: PROJECT_PLUGINS_VERSION, entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) },
  }) as unknown as Project;

test("an enabled plugin with a pane draws it; one without draws the generic pane", () => {
  const plugins = [status("data-science", "Data science"), status("hello", "Hello")];
  const html = renderToStaticMarkup(
    <ProjectPluginPanes project={enabledFor("data-science", "hello")} plugins={plugins} onChange={() => {}} />,
  );
  // Data science's own editor, not the generic switch.
  expect(html).toContain('aria-label="Enable data science for this project"');
  expect(html).not.toContain('aria-label="Data science enabled"');
  // `hello` gets the generic pane.
  expect(html).toContain('aria-label="Hello enabled"');
});

test("a plugin with a pane that is OFF for the project still gets the generic pane", () => {
  const html = renderToStaticMarkup(
    <ProjectPluginPanes project={enabledFor()} plugins={[status("data-science", "Data science")]} onChange={() => {}} />,
  );
  expect(html).toContain('aria-label="Data science enabled"');
  expect(html).not.toContain('aria-label="Enable data science for this project"');
});
