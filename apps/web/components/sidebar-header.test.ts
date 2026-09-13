// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * THE RAIL'S HEAD IS ONE LINE NOW — a search field with three verbs in a pill at
 * its right, and NO project filter anywhere in it.
 *
 * It was two lines: the field with a lone New-conversation button, then a whole
 * second row holding "All projects ▾" and a lone `+`. That row spent a line of a
 * narrow rail on a control most cockpits never change, and it put the two things
 * pressed most on different rows at opposite ends. #395 folded the filter into
 * the field as a chip; #400 removed the filter itself — the collapsible project
 * groups already answer "fewer rows", so both the row and the chip were
 * furniture around a control the rail does not need.
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
const field = code(readFileSync(new URL("./sidebar-search-field.tsx", import.meta.url), "utf8"));

/** The head, from the search field down to the drafts band. */
const header = sidebar.slice(sidebar.indexOf("<SidebarSearchField"), sidebar.indexOf("DRAFTS SIT ABOVE EVERYTHING"));

describe("the rail's header is one row", () => {
  test("the separate All-projects row is gone", () => {
    expect(header).not.toContain('"All projects"');
    expect(header).not.toContain("min-w-0 flex-1\" />}");
  });

  test("three verbs, in one pill, at the field's right", () => {
    const pill = header.slice(header.indexOf("THREE VERBS IN ONE PILL"));
    for (const label of ['aria-label="Reveal in Finder"', 'aria-label="Add project"', 'aria-label="New conversation"']) {
      expect(pill).toContain(label);
    }
    // One border around the three, not three glyphs floating beside the field.
    expect(pill).toContain('className="flex shrink-0 items-center gap-0.5 rounded-lg border border-sidebar-border/60 p-0.5"');
  });

  test("each verb is the control it already was, not a second implementation", () => {
    // Add project opens the palette's Sources page — the same page the rail's
    // empty-space menu opens, so `chooseDirectory` still has one caller.
    expect(header).toContain('onClick={() => openPalette("sources")}');
    // New conversation still goes through the one place that decides between
    // the palette and a canvas.
    expect(header).toContain("onClick={newConversation}");
    expect(sidebar).toContain('"new-conversation": () => newConversation(),');
  });
});

describe("Reveal in Finder", () => {
  test("it is absent in a browser tab, and disabled only when nothing is chosen", () => {
    // A greyed Finder button in a tab would be the platform explained forever —
    // the rule `workspaceOpenBlocker` states and `project-group.tsx` follows.
    expect(header).toContain("{revealBridge && (");
    expect(header).toContain("disabled={!revealProject}");
  });

  test("the shell is read through a store, so the first client render matches the markup", () => {
    // `workspaceOpener()` answers undefined on the server and an object in the
    // shell; reading it during render would hydrate into a mismatch.
    expect(sidebar).toContain("useSyncExternalStore(subscribeNothing, workspaceOpener, serverNoBridge)");
    // Module constants, because the store compares them by identity.
    expect(sidebar).toContain("const subscribeNothing = () => () => {};");
  });

  test("it reveals THIS Mac's project, never a paired Mac's same-named path", () => {
    const pick = sidebar.slice(sidebar.indexOf("const revealProject = (() => {"));
    expect(pick.slice(0, 400)).toContain("!composerTarget.hostId");
    expect(header).toContain("`Reveal ${revealProject.name} in Finder`");
  });

  test("the guess is the rail's OWN, with no scoped project ahead of it", () => {
    // #400: the chip that set a scope is gone, so "the project at hand" has
    // exactly one meaning here — the one `New conversation` already acts on.
    const pick = sidebar.slice(sidebar.indexOf("const revealProject = (() => {"));
    expect(pick.slice(0, 400)).not.toContain("selectedProject");
  });
});

describe("there is no project filter in the rail — #400", () => {
  /** The chip and every code path it was the only way to reach. The rail's
   *  collapsible project groups are the "fewer rows" control now. */
  test("the chip, its menu and its state are gone from the source", () => {
    for (const dead of ["scopeChip", "selectScope", "selectedScope", "selectedProject", "setScope", "Filter by project"]) {
      expect(sidebar).not.toContain(dead);
    }
  });

  test("nothing is handed to a leading slot the field no longer has", () => {
    expect(header).not.toContain("start:");
    expect(header).not.toContain("start=");
  });

  test("the rail always names a row's project, with no flag left to say otherwise", () => {
    // `showProject` was `!selectedScope`, so with no scope it is always true and
    // a derived boolean that cannot vary is worse than the literal.
    expect(sidebar).not.toContain("const showProject =");
    expect(sidebar).not.toContain("showProject={showProject}");
    // The prop itself survives on SessionRow: a row INSIDE a project group
    // passes false, because the group header names the project one line up.
    expect(readFileSync(new URL("./session/project-group.tsx", import.meta.url), "utf8")).toContain("showProject={false}");
  });

  test("the empty rail has one answer, not a scoped one", () => {
    // Below the header slice, in the list's own empty state: the third arm read
    // "No sessions in this project" and nothing could put the rail in it.
    expect(sidebar).toContain('title={query ? "No sessions found" : "No sessions yet"}');
  });

  test("per-project settings stayed reachable — on the group header's own menu", () => {
    // It lived in the chip's menu as a gear beside each project name. The group
    // header already carried the same row, which is why the chip could go
    // without taking the verb with it.
    const group = readFileSync(new URL("./session/project-group.tsx", import.meta.url), "utf8");
    expect(group).toContain("Project settings");
    expect(group).toContain("onProjectSettings");
  });
});

describe("the shared field has one slot, and it is the trailing one", () => {
  test("the chrome is on the row, not the input — the reason a slot can hold anything", () => {
    // The absolute icon over a full-width Input with a hand-counted pl-7/pr-10
    // works for two things of fixed width and for nothing else.
    expect(field).not.toContain("pl-7");
    expect(field).not.toContain("pr-10");
  });

  test("the leading slot went with the chip that was its only caller", () => {
    // #400. The glyph is unconditional again; no rail passes a `start`.
    expect(field).toContain("<SearchIcon");
    expect(field).not.toContain("start");
  });

  test("a caller that passes no slot draws what it drew before", () => {
    // The Spool's rail and the settings nav pass no `start`; the glyph, the
    // height and the hover treatment are unchanged for them.
    expect(field).toContain("h-8 min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2");
    expect(field).toContain("hover:bg-sidebar-accent/70 focus-within:border-sidebar-border focus-within:bg-sidebar-accent/70");
  });

  test("the field still binds no key of its own", () => {
    // Telar's ⌘K stays Telar's `useCommandKeys` call; the Spool's field opens on
    // focus. Neither is smuggled into the shared chrome.
    expect(field).not.toMatch(/onKeyDown|useCommandKeys|metaKey|ctrlKey/);
  });
});
