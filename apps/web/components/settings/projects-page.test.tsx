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
  expect(html).toContain("Select a project to rename it.");
  expect(html).toContain("Select a project to mark it.");
  expect(html).toContain("Select a project to set the model its conversations open on.");
  expect(html).toContain("Select a project to say where its conversations start.");
});

test("an inert row's control is rendered and taken out of reach, never removed", () => {
  const html = renderToStaticMarkup(<ProjectIdentityRows />);
  // `inert` is what Row does with `unavailable` — the control stays in the
  // markup so the reader sees the shape of the setting, and answers nothing.
  expect(html).toContain("inert");
  expect(html).toContain("opacity-50");
});

test("naming a project binds the rows to it and takes the inert reason off", () => {
  const html = renderToStaticMarkup(<ProjectIdentityRows project={project()} />);
  expect(html).toContain("Telar");
  expect(html).toContain("/Users/someone/code/telar");
  expect(html).not.toContain("Select a project to rename it.");
  /**
   * LIVE, NOT INERT — the write path #308 added is what this asserts. The rows
   * were inert at every scope while `PATCH /v2/projects/:id` took plugin
   * switches only; a named project now binds them to a real field.
   */
  expect(html).not.toContain("inert");
  expect(html).toContain('aria-label="Project name"');
  expect(html).toContain('aria-label="Project mark"');
});

test("a project on another Mac keeps every identity row read-only, and says whose", () => {
  // The patch would have to reach that Mac's engine and this pane's api is
  // this one's — the same rule the plugin switches follow.
  const html = renderToStaticMarkup(
    <>
      <ProjectIdentityRows project={project({ hostId: "host_mini", hostName: "mini" })} />
      <ProjectConversationRows project={project({ hostId: "host_mini", hostName: "mini" })} envMode="local" />
    </>,
  );
  expect(html).toContain("Registered on mini");
  expect(html).toContain("inert");
});

test("a chosen mark outranks the checkout's icon, and can be cleared", () => {
  const marked = renderToStaticMarkup(<ProjectIdentityRows project={project({ iconEmoji: "🧵", icon: "etag_abc" })} />);
  // The mark itself, not the engine-served file the derived key points at.
  expect(marked).toContain("🧵");
  expect(marked).not.toContain("etag_abc");
  // And a revert arrow, which is how the stored answer is removed — `null`,
  // rather than an empty string the engine would refuse.
  expect(marked).toContain('aria-label="Revert to the default"');
  // With nothing chosen there is nothing to revert to.
  expect(renderToStaticMarkup(<ProjectIdentityRows project={project()} />)).not.toContain('aria-label="Revert to the default"');
});

test("a project with no workspace answer follows the Mac, and says what it is following", () => {
  const html = renderToStaticMarkup(<ProjectConversationRows project={project()} envMode="worktree" />);
  // The first segment is selected — absence is a CHOICE here, not a blank.
  expect(html).toContain("Follow the Mac");
  expect(html).toContain("Following this Mac, which says each session gets its own checkout");
  expect(html).toContain("General ▸ Workspace");
});

test("a project that pinned an answer states it, whatever the Mac says", () => {
  const html = renderToStaticMarkup(<ProjectConversationRows project={project({ envMode: "local" })} envMode="worktree" />);
  // `renderToStaticMarkup` escapes the apostrophe, so the assertion stops
  // short of it rather than pinning the entity.
  expect(html).toContain("Sessions here share the project");
  expect(html).toContain("checkout, whatever this Mac says");
  expect(html).not.toContain("Following this Mac");
});

test("the checkout path appears only once a project is named", () => {
  expect(renderToStaticMarkup(<ProjectIdentityRows />)).not.toContain("Checkout");
  expect(renderToStaticMarkup(<ProjectIdentityRows project={project()} />)).toContain("Checkout");
});

test("the workspace row offers both per-project answers beside following the Mac", () => {
  const html = renderToStaticMarkup(<ProjectConversationRows project={project()} envMode="worktree" />);
  expect(html).toContain("Project checkout");
  expect(html).toContain("Own worktree");
  // Three segments, exactly one of them pressed: a project either follows the
  // Mac or pins one of the two, and the three are mutually exclusive.
  expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
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
  expect(html).toContain("Select a project to rename it.");
  // The Danger group belongs to a named project; at this scope there is none.
  expect(html).not.toContain("Remove project from Telar");
});

test("the scope select's trigger reads the label, never the value (#318)", () => {
  /**
   * The bug: a bare `<SelectValue />` renders the Select's VALUE when nothing
   * maps it to a label, so the trigger read `__all-projects` at rest and a
   * `project_…` id after a pick — while the list beside it showed the right
   * names the whole time.
   */
  const html = renderToStaticMarkup(<ProjectsPage />);
  // The trigger's own value element, not "the sentinel appears nowhere": base-ui
  // also renders a hidden form input carrying the real value, which is right.
  expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">All projects<');
});

test("an id the registry has not answered for yet still reads as words", () => {
  /**
   * `?project=` is read on the first paint and a remote Mac's registry is a
   * request away, so there is a window where the selected id names no project
   * this pane has. A value-to-label mapping would print the id in exactly that
   * window — which is the bug — so the trigger states the label itself.
   */
  expect(source).toContain('{selected === ALL_PROJECTS ? "All projects" : (project?.name ?? "Select a project")}');
});

test("the scope is a bar above the first card, machine left and project right", () => {
  // Both controls on one line, outside any SettingsGroup — the frame that
  // used to make the picker read as one more setting to configure.
  expect(source).toContain('<div className="mb-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">');
  expect(source).not.toContain('<SettingsGroup title="Scope"');
});

test("the Mac segmented control appears only when a Mac has been paired", () => {
  // A one-segment control is a button that does nothing, and a cockpit with no
  // paired Mac is the common one.
  expect(source).toContain("{hosts.length > 0 && (");
  // The host control's own segment, matched as a whole label rather than as a
  // substring: the workspace row below now says "Mac" too, and a bare
  // `not.toContain("This Mac")` would pass or fail on that row's wording.
  expect(renderToStaticMarkup(<ProjectsPage />)).not.toContain(">This Mac<");
});

test("a write goes to the named project only, and never to one on another Mac", () => {
  // The guard that makes the inert rows above more than cosmetic: a control
  // reached some other way still cannot patch this Mac's registry for a
  // project that does not live in it.
  expect(source).toContain("if (!project || project.hostId) return;");
  // And the row's state advances on the ENGINE's record, never on the patch —
  // a control that moved on the request would show a value it refused.
  expect(source).toContain(".then((answer) => replaceProject(answer.project))");
});

test("clearing a per-project answer writes null, which is what removes it", () => {
  // `null` is a VALUE on this route and the only way back to "follow this
  // Mac"; an empty string or an absent key would mean something else.
  expect(source).toContain('writer?.save("defaultModel", { defaultModel: null })');
  expect(source).toContain("envMode: next === FOLLOW_MAC ? null : (next as EnvMode)");
  expect(source).toContain('iconEmoji: next.trim() === "" ? null : next.trim()');
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

test("a registry of one selects it, rather than opening on an inert pane", () => {
  /**
   * #357: a cockpit with a single registered folder landed on "All projects",
   * so every row was "Select a project to …" behind a picker with one answer.
   *
   * A render-phase adjustment keyed on the engine's OWN answer — `byHost[hostId]`
   * rather than the `?? []` the render uses, whose identity changes every render
   * while the read is still in flight — and only from ALL_PROJECTS, so it can
   * never overwrite a project `?project=` named.
   */
  expect(source).toContain("const answered = byHost[hostId];");
  expect(source).toContain("if (answered?.length === 1 && selected === ALL_PROJECTS) setSelected(answered[0]!.id);");
  // And the filter that leads back there is not offered when it filters nothing.
  expect(source).toContain("{projects.length !== 1 && <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>}");
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
