/**
 * #338 — THE PANE READS THE MAP.
 *
 * The engine no longer writes or returns `Project.dataScience`, but a record
 * from an older engine may still carry it. Beside a map it is never a source of
 * truth: a project switched off through the map could carry a legacy block
 * still saying `enabled: true`, and reading it drew an On switch over a plugin
 * the engine refuses to run — the resurrection bug #269 fixed in the cockpit.
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

/** A real interpreter in the settings, so "off" cannot be mistaken for
 *  "nothing was ever configured". */
const PYTHON = { source: "chosen", path: ".venv/bin/python", resolvedAt: 1, manager: "venv" } as const;

/** Loose on purpose: an older engine's record may carry the legacy block. */
const project = (extra: Partial<Project> & { dataScience?: unknown }): Project =>
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
  // whatever a legacy block an older engine sent says.
  const html = render(project({
    plugins: { version: PROJECT_PLUGINS_VERSION, entries: {} },
    dataScience: { enabled: true, python: PYTHON },
  }));
  expect(switchState(html)).toBe("off");
  // Nothing of the legacy block is read — not even its interpreter.
  expect(html).toContain("Off. You can turn it on before the environment exists.");
});

test("a migrated map that enables it turns the switch on", () => {
  const html = render(project({
    plugins: { version: PROJECT_PLUGINS_VERSION, entries: { "data-science": { enabled: true, settings: { python: PYTHON } } } },
  }));
  expect(switchState(html)).toBe("on");
  expect(html).toContain("Sessions get notebook and ds_* tools.");
});

test("an older engine's record with only a legacy block is still read", () => {
  // `readProjectPlugins` folds a record with no map from its legacy block, so a
  // remote pre-map engine's projects are not all shown off.
  const html = render(project({ dataScience: { enabled: true, python: PYTHON } }));
  expect(switchState(html)).toBe("on");
});

test("a map that turns it off keeps the chosen environment", () => {
  const html = render(project({
    plugins: { version: PROJECT_PLUGINS_VERSION, entries: { "data-science": { enabled: false, settings: { python: PYTHON } } } },
  }));
  expect(switchState(html)).toBe("off");
  expect(html).toContain("Off. The chosen environment is kept.");
});

test("a project with neither a map nor a legacy block is off", () => {
  const html = render(project({}));
  expect(switchState(html)).toBe("off");
  expect(html).toContain("Off. You can turn it on before the environment exists.");
});
