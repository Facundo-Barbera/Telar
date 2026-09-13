// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * THE RAIL'S HEAD IS ONE LINE NOW — a search field with three verbs in a pill at
 * its right, and the project filter folded into the field as a chip.
 *
 * It was two lines: the field with a lone New-conversation button, then a whole
 * second row holding "All projects ▾" and a lone `+`. That row spent a line of a
 * narrow rail on a control most cockpits never change, and it put the two things
 * pressed most on different rows at opposite ends.
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
    // Its menu survives — as the chip's, below — but the ROW does not.
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
    // And the guess it falls back to is the rail's own, not a second idea of
    // "the project at hand" — named in the button's tooltip either way.
    expect(pick.slice(0, 400)).toContain("selectedProject ??");
    expect(header).toContain("`Reveal ${revealProject.name} in Finder`");
  });
});

describe("the project filter is a chip inside the field it narrows", () => {
  test("the chip goes in the field's start slot", () => {
    expect(header).toContain("{...(scopeChip ? { start: scopeChip } : {})}");
  });

  test("it is absent on a cockpit with one project, exactly as the row was", () => {
    // #361: "All projects" and "that one project" select the same rows, so the
    // control would be furniture — and here it would also eat the field's width.
    expect(sidebar).toContain("const scopeChip =\n    pickerTargets.length > 1 ? (");
  });

  test("it carries the whole menu the row carried — scope, per-project settings, clear", () => {
    const chip = sidebar.slice(sidebar.indexOf("const scopeChip ="), sidebar.indexOf("const handleSearchKeyDown"));
    expect(chip).toContain("onClick={() => selectScope()}");
    expect(chip).toContain("onClick={() => selectScope(project.id)}");
    expect(chip).toContain("projectSettingsHref(project.id)");
    expect(chip).toContain("All projects");
  });

  test("unscoped, the chip is two glyphs — a label inside a search box competes with its placeholder", () => {
    const chip = sidebar.slice(sidebar.indexOf("const scopeChip ="), sidebar.indexOf("const handleSearchKeyDown"));
    expect(chip).toContain("{selectedProject && <span className=\"truncate\">{selectedProject.name}</span>}");
  });
});

describe("the shared field grew a start slot without forking", () => {
  test("the chrome moved to the row, so something of unknown width can sit inside", () => {
    // The absolute icon over a full-width Input with a hand-counted pl-7/pr-10
    // works for two things of fixed width and for nothing else; a chip's width
    // is a project's name.
    expect(field).toContain("start ?? <SearchIcon");
    expect(field).not.toContain("pl-7");
    expect(field).not.toContain("pr-10");
  });

  test("a caller that passes neither slot draws what it drew before", () => {
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
