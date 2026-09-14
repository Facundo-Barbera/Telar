/**
 * #338 — THE PANE READS THE MAP, NOT THE MIRROR.
 *
 * `Project.dataScience` is kept beside the plugin map for ONE reader: an older
 * engine binary, so a rollback keeps your settings. It is not a source of
 * truth, and a project switched off through the map keeps a mirror still
 * saying `enabled: true`. This pane read that mirror, so its switch said On
 * over a plugin the engine refuses to run — the same resurrection bug #269
 * fixed in the cockpit, found again on the settings page.
 *
 * RENDERED RATHER THAN SCANNED: the claim is what the person sees on the
 * switch, and the source could go on calling the right helper while the value
 * it produced never reached the control.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PROJECT_PLUGINS_VERSION, type Project } from "@telar/engine-client";

/** The pane pushes to the canvas from "Ask agent to set up" and nowhere else.
 *  Stubbed for the reason `project-group.rows.test.tsx` gives. */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { DataScienceSection } = await import("./data-science-section");

/** A real interpreter in the legacy block, so "off" cannot be mistaken for
 *  "nothing was ever configured". */
const PYTHON = { source: "chosen", path: ".venv/bin/python", resolvedAt: 1, manager: "venv" } as const;

const project = (extra: Partial<Project>): Project =>
  ({ id: "project_1", name: "Telar", path: "/tmp/telar", ...extra }) as Project;

const render = (value: Project) => renderToStaticMarkup(<DataScienceSection project={value} onChange={() => {}} />);

/** The Enabled switch is the pane's only one until a form is opened, so its
 *  state can be read off the markup without hunting for the element. */
const switchState = (html: string): string => {
  expect(html).toContain('aria-label="Enable data science for this project"');
  expect(html.split('role="switch"')).toHaveLength(2);
  return html.includes('aria-checked="true"') ? "on" : "off";
};

test("a migrated map that disables it wins over a stale legacy enabled:true", () => {
  // The marker is present and carries NO data-science entry: the map says off,
  // whatever the mirror an old engine can still read says.
  const html = render(project({
    plugins: { version: PROJECT_PLUGINS_VERSION, entries: {} },
    dataScience: { enabled: true, python: PYTHON },
  }));
  expect(switchState(html)).toBe("off");
  // And the row says which "off" this is — the environment is kept, not lost.
  expect(html).toContain("Off. The chosen environment is kept.");
});

test("a migrated map that enables it turns the switch on", () => {
  const html = render(project({
    plugins: { version: PROJECT_PLUGINS_VERSION, entries: { "data-science": { enabled: true, settings: { python: PYTHON } } } },
    dataScience: { enabled: true, python: PYTHON },
  }));
  expect(switchState(html)).toBe("on");
  expect(html).toContain("Sessions get notebook and ds_* tools.");
});

test("a project that predates the map still reads from its legacy block", () => {
  // `readProjectPlugins` migrates an unmigrated project from the mirror, so the
  // fix must not turn every pre-map project off. See PROJECT_PLUGINS_VERSION.
  const html = render(project({ dataScience: { enabled: true, python: PYTHON } }));
  expect(switchState(html)).toBe("on");
});

test("a project with neither a map nor a legacy block is off", () => {
  const html = render(project({}));
  expect(switchState(html)).toBe("off");
  expect(html).toContain("Off. You can turn it on before the environment exists.");
});
