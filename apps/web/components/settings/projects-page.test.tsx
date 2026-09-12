// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { searchSettings } from "@/lib/settings-search";
import { ProjectConversationRows, ProjectIdentityRows, ProjectPluginRows, ProjectsPage, type ScopedProject } from "./projects-page";

/**
 * THE ONE THING THIS PANE HAS TO GET RIGHT is the difference between its two
 * scopes — a row that stays live at All projects would write somebody's change
 * into a project they never named, and a row that vanished would teach them the
 * setting does not exist. Both states are rendered here, which is why the rows
 * take their project as a prop rather than fetching it.
 *
 * The pane itself fetches on mount, so a static render is its All-projects
 * first paint; what only exists after a click is pinned against source, the way
 * settings-search-nav.test.tsx pins its keyboard.
 */
const source = readFileSync(new URL("./projects-page.tsx", import.meta.url), "utf8");

function project(patch: Partial<ScopedProject> = {}): ScopedProject {
  return {
    id: "project_abc",
    environmentId: "env_abc",
    name: "Telar",
    root: "/Users/someone/code/telar",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  } as ScopedProject;
}

test("at All projects every per-project row is still drawn, and says which choice would answer it", () => {
  const html = renderToStaticMarkup(
    <>
      <ProjectIdentityRows />
      <ProjectConversationRows envMode="local" />
    </>,
  );
  // Present, not hidden.
  expect(html).toContain("Name");
  expect(html).toContain("Icon");
  expect(html).toContain("Default model");
  expect(html).toContain("Where new conversations start");
  // And each one names the step that would make it answer.
  expect(html).toContain("Select a project to see its name.");
  expect(html).toContain("Select a project to see its icon.");
  expect(html).toContain("Select a project to set the model its conversations open on.");
  expect(html).toContain("Select a project to see where its conversations start.");
});

test("an inert row's control is rendered and taken out of reach, never removed", () => {
  const html = renderToStaticMarkup(<ProjectIdentityRows />);
  // `inert` is what Row does with `unavailable` — the control stays in the
  // markup so the reader sees the shape of the setting, and answers nothing.
  expect(html).toContain("inert");
  expect(html).toContain("opacity-50");
});

test("naming a project binds the rows to it and swaps the reason for the real one", () => {
  const html = renderToStaticMarkup(<ProjectIdentityRows project={project()} />);
  expect(html).toContain("Telar");
  expect(html).toContain("/Users/someone/code/telar");
  expect(html).not.toContain("Select a project to see its name.");
  // Still inert, and now for the honest reason: the engine has no rename.
  expect(html).toContain("no rename yet");
});

test("the checkout path appears only once a project is named", () => {
  expect(renderToStaticMarkup(<ProjectIdentityRows />)).not.toContain("Checkout");
  expect(renderToStaticMarkup(<ProjectIdentityRows project={project()} />)).toContain("Checkout");
});

test("the workspace row shows the Mac's standing answer and says where to change it", () => {
  const html = renderToStaticMarkup(<ProjectConversationRows project={project()} envMode="worktree" />);
  expect(html).toContain("Own worktree");
  // aria-pressed is Segmented's selected mark — the row shows the real value
  // rather than an em dash, even though it cannot be set per project.
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("General ▸ Workspace");
});

test("a project on another Mac has read-only plugin switches, and the row says whose", () => {
  const html = renderToStaticMarkup(
    <ProjectPluginRows
      project={project({ hostId: "host_mini", hostName: "mini" })}
      plugins={[
        {
          meta: { id: "latex", name: "LaTeX", settings: [] },
          state: "ready",
        } as never,
      ]}
    />,
  );
  expect(html).toContain("LaTeX");
  expect(html).toContain("Registered on mini");
  expect(html).toContain("inert");
});

test("with no plugins registered the group says so rather than heading empty air", () => {
  const html = renderToStaticMarkup(<ProjectPluginRows plugins={[]} />);
  expect(html).toContain("No plugins registered");
});

test("the pane opens on All projects, so nothing is bound before a reader names one", () => {
  const html = renderToStaticMarkup(<ProjectsPage />);
  expect(html).toContain("All projects");
  expect(html).toContain("Select a project to see its name.");
  // The Danger group belongs to a named project; at this scope there is none.
  expect(html).not.toContain("Remove project from Telar");
});

test("the Mac segmented control appears only when a Mac has been paired", () => {
  // A one-segment control is a button that does nothing, and a cockpit with no
  // paired Mac is the common one.
  expect(source).toContain("{hosts.length > 0 && (");
  expect(renderToStaticMarkup(<ProjectsPage />)).not.toContain("This Mac");
});

test("a remote Mac's registry is read when it is asked for, not on mount", () => {
  expect(source).toContain("if (hostId === LOCAL_HOST_ID || byHost[hostId]) return;");
  // And every read names its host explicitly rather than following the URL.
  expect(source).toContain("createEngineApi(hostFetcher(id))");
});

test("a plugin write goes through the generic arm, for the named project only", () => {
  expect(source).toContain("api.updateProject(project.id, enablePatch(pluginId, next))");
  expect(source).toContain("if (!project) return;");
});

test("?project= opens the pane on one project, read after the first paint", () => {
  // Seeding from window.location in initial state would make the server and the
  // client disagree about the same markup — the reason use-section-from-url.ts
  // defers too.
  expect(source).toContain('new URLSearchParams(window.location.search).get("project")');
});

test("the pane's rows are findable by search before the pane has ever been opened", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  expect(first("project icon")?.pageId).toBe("projects");
  expect(first("unregister")?.title).toBe("Remove project from Telar");
  expect(first("unregister")?.pageId).toBe("projects");
  expect(first("all projects")?.pageId).toBe("projects");
});
