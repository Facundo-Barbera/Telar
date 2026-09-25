// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * THE RAIL'S HEAD IS ONE LINE — a project filter at the head of the search
 * field, two verbs in a pill at its right, and no Reveal in Finder among them.
 *
 * It was two lines: the field with a lone New-conversation button, then a whole
 * second row holding "All projects ▾" and a lone `+`. That row spent a line of a
 * narrow rail on a control most cockpits never change, and it put the two things
 * pressed most on different rows at opposite ends. #395 folded the filter into
 * the field as a chip; #400 removed the filter itself; #470 puts one back in
 * that same place as a SET rather than a scope — "these three projects and not
 * the other eleven" is the question the collapsible groups cannot answer — and
 * takes Reveal in Finder out of the pill, because it acted on a guess at "the
 * project at hand" that the two surfaces which can NAME a folder do not need.
 *
 * PINNED AGAINST SOURCE, like the palette's own keyboard rules: this markup
 * renders inside a sidebar provider with a router, a command registry and four
 * engine reads behind it, and none of the decisions below survive being
 * approximated by a test harness.
 */
/** Comments stripped, like the other source-pinning suites here: prose that
 *  NAMES the thing it removed would otherwise read as the thing still being
 *  there. Same helper as `session/context-menus.test.tsx`. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sidebar = readFileSync(new URL("./app-sidebar.tsx", import.meta.url), "utf8");
const bare = code(sidebar);
const field = code(readFileSync(new URL("./sidebar-search-field.tsx", import.meta.url), "utf8"));
const filter = code(readFileSync(new URL("./sidebar-project-filter.tsx", import.meta.url), "utf8"));

/** The head, from the search field down to the drafts band. */
const header = sidebar.slice(sidebar.indexOf("<SidebarSearchField"), sidebar.indexOf("DRAFTS SIT ABOVE EVERYTHING"));

describe("the rail's header is one row", () => {
  test("the separate All-projects row is gone", () => {
    expect(header).not.toContain('"All projects"');
    expect(header).not.toContain("min-w-0 flex-1\" />}");
  });

  test("two verbs, in one pill, at the field's right", () => {
    const pill = header.slice(header.indexOf("TWO VERBS IN ONE PILL"));
    for (const label of ['aria-label="Add project"', 'aria-label="New conversation"']) {
      expect(pill).toContain(label);
    }
    // One border around the two, not loose glyphs floating beside the field.
    expect(pill).toContain('className="flex shrink-0 items-center gap-0.5 rounded-lg border border-sidebar-border/60 p-0.5"');
  });

  test("each verb is a COMMAND, pressed — not a second implementation of one", () => {
    // #402: a button that reached for the bridge or set the palette's state
    // itself is how a button and its chord come to mean two slightly different
    // things. Both ask the dispatcher the keyboard asks.
    expect(header).toContain('onClick={() => run("add-project")}');
    expect(header).toContain('onClick={() => run("new-conversation")}');
    // And the dispatcher is the rail's own, so "New conversation" still goes
    // through the one place that decides between the palette and a canvas.
    expect(sidebar).toContain("const run = useCommandKeys(jumpRows, {");
    expect(sidebar).toContain('"new-conversation": () => newConversation(),');
    expect(sidebar).toContain('"add-project": () => openPalette("sources"),');
  });
});

describe("Reveal in Finder left the rail's head — #470", () => {
  test("no button, and no bridge read to feed one", () => {
    expect(header).not.toContain('aria-label="Reveal in Finder"');
    expect(header).not.toContain('run("reveal-in-finder")');
    // The whole code path, not just the markup: the shell store, the guess it
    // fed, and the handler that closed over both.
    for (const dead of ["revealBridge", "revealProject", "workspaceOpener", "subscribeNothing", "serverNoBridge"]) {
      expect(bare).not.toContain(dead);
    }
  });

  test("the rail binds the command no more, which is what drops its chord", () => {
    // The palette lists a command only when a mounted component can run it, and
    // the held-⌘ hints read the same registry — so ⌘O outside a conversation now
    // promises nothing rather than a folder nobody chose.
    expect(bare).not.toContain('"reveal-in-finder"');
    // `project-settings` is the same guess and it stays: it navigates inside the
    // app rather than opening something on the machine.
    expect(sidebar).toContain('"project-settings": () => {');
  });

  test("the two surfaces that can NAME a folder still reveal one", () => {
    // Scope of #470 is the header only. A project group's menu and a session's
    // own Reveal button both act on a path they were handed, not on a guess.
    const group = readFileSync(new URL("./session/project-group.tsx", import.meta.url), "utf8");
    expect(group).toContain("Reveal in Finder");
    expect(readFileSync(new URL("./session/open-workspace-button.tsx", import.meta.url), "utf8")).toContain('"reveal-in-finder": () => {');
  });
});

describe("the project filter is back, as a set — #470", () => {
  test("it is the field's leading slot, not a row of its own", () => {
    expect(header).toContain("{...(projectFilterControl ? { start: projectFilterControl } : {})}");
    expect(sidebar).toContain("<SidebarProjectFilter");
  });

  test("absent on a cockpit with one project, like the chip it replaces", () => {
    // "Every project" and "that one project" select the same rows, so the
    // control would be furniture eating the width of the field.
    expect(sidebar).toContain("pickerTargets.length > 1 ? (");
  });

  test("the trigger counts the APPLIED selection, so it cannot disagree with the list", () => {
    // A stored key for a project that has left the registry — or for a paired
    // Mac that is away — names nothing the popover can list. Counting the raw
    // set would badge a filter with no checked row to explain it.
    expect(sidebar).toContain("const projectsShown = appliedProjectFilter(projectFilter.selected, knownProjectKeys);");
    expect(sidebar).toContain("selected={projectsShown}");
  });

  test("the rows are filtered ONCE, before the list is derived", () => {
    // Filtering rows rather than groups is what hides a whole group AND narrows
    // Needs-you and Pinned, which sit outside the groups.
    expect(sidebar).toContain("sessions: filterSessionsToProjects(sessions, projectsShown),");
    // Host-qualified keys: project ids are minted per engine, so a bare id would
    // filter this Mac's project and hide the mini's of the same id.
    expect(sidebar).toContain("projectFilterKey(project.id, project.hostId)");
  });

  test("everything else reads the WHOLE list, deliberately", () => {
    // A filter over the rail is not an instruction about what ⌘K may find, and
    // the poll's cadence follows what is live rather than what is on screen.
    expect(sidebar).toContain("sessions={sessions}");
    expect(sidebar).toContain("const anyLive = sessions.some((session) => session.activity !== \"idle\" && session.activity !== \"waiting\" && session.activity !== \"scheduled\");");
  });

  test("a draft is a row in the rail, so the filter reaches it too", () => {
    expect(sidebar).toContain("projectsShown.size === 0 || projectsShown.has(projectFilterKey(draft.projectId))");
  });

  test("an emptied rail says which emptiness it is", () => {
    // "No sessions yet" over a cockpit full of work is the sentence that makes a
    // reader think they lost something. The arm is reachable again exactly
    // because a filter can now produce it.
    expect(sidebar).toContain('projectsShown.size ? "No sessions in the selected projects" : "No sessions yet"');
  });

  test("nothing checked is every project — there is no All row to press", () => {
    // An empty selection already says it, and a row meaning "uncheck the other
    // eleven" is a second way to spell Clear.
    expect(filter).not.toContain("All projects");
    expect(filter).toContain("Clear");
    expect(filter).toContain("{count > 0 && (");
  });

  test("one checkbox row per project, host-grouped only when there are hosts to group by", () => {
    expect(filter).toContain('role="checkbox"');
    expect(filter).toContain("aria-checked={on}");
    expect(filter).toContain("{hosts.length > 1 && ");
  });
});

describe("the rail always names a row's project", () => {
  test("no flag is left to say otherwise", () => {
    // `showProject` was `!selectedScope`, so with no single scope it is always
    // true and a derived boolean that cannot vary is worse than the literal.
    // #470's filter is a SET, which never makes the name redundant: three
    // projects selected is three names worth saying.
    expect(sidebar).not.toContain("const showProject =");
    expect(sidebar).not.toContain("showProject={showProject}");
    // The prop itself survives on SessionRow: a row INSIDE a project group
    // passes false, because the group header names the project one line up.
    expect(readFileSync(new URL("./session/project-group.tsx", import.meta.url), "utf8")).toContain("showProject={false}");
  });

  test("per-project settings stayed reachable — on the group header's own menu", () => {
    // It lived in the old chip's menu as a gear beside each project name. The
    // group header already carried the same row, which is why the chip could go
    // without taking the verb with it — and why #470's popover is a filter and
    // only a filter.
    const group = readFileSync(new URL("./session/project-group.tsx", import.meta.url), "utf8");
    expect(group).toContain("Project settings");
    expect(group).toContain("onProjectSettings");
    expect(filter).not.toContain("Project settings");
  });
});

describe("the shared field has two slots again, and the leading one replaces the glyph", () => {
  test("the chrome is on the row, not the input — the reason a slot can hold anything", () => {
    // The absolute icon over a full-width Input with a hand-counted pl-7/pr-10
    // works for two things of fixed width and for nothing else.
    expect(field).not.toContain("pl-7");
    expect(field).not.toContain("pr-10");
  });

  test("`start` REPLACES the search glyph rather than sitting beside it", () => {
    // Two marks at the head of one field is one too many, and the field's width
    // belongs to what you are typing.
    expect(field).toContain("{start ?? <SearchIcon");
  });

  test("a caller that passes no slot draws what it drew before", () => {
    // The settings nav passes no `start`; the glyph, the height and the hover
    // treatment are unchanged for it.
    expect(field).toContain("h-8 min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2");
    expect(field).toContain("hover:bg-sidebar-accent/70 focus-within:border-sidebar-border focus-within:bg-sidebar-accent/70");
  });

  test("the field still binds no key of its own", () => {
    // Telar's ⌘K stays Telar's `useCommandKeys` call — it is not smuggled into
    // the shared chrome.
    expect(field).not.toMatch(/onKeyDown|useCommandKeys|metaKey|ctrlKey/);
  });
});
