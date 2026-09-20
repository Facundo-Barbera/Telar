/**
 * THE PALETTE'S FOLD — sections, ordering, what a query keeps, the recency cut
 * and the back rule (issue #402).
 *
 * Everything here is the part that has no DOM in it, which is deliberately most
 * of the feature: what the dialog draws is a list, and a list is a function of
 * three inputs and a string. The dialog's own keyboard is pinned against source
 * in `components/command-palette.test.tsx`, as the project palette's is.
 */
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { NewConversationTarget } from "@/components/project-palette";
import {
  PALETTE_QUICK_COMMANDS,
  PALETTE_SUB_PAGES,
  RECENT_CONVERSATION_LIMIT,
  matchActions,
  matchQuick,
  paletteActions,
  paletteBack,
  paletteRows,
  paletteSections,
  paletteSessionKey,
  quickSettings,
  recentSessions,
  type PaletteSessionLike,
  type QuickSettingsState,
} from "./command-palette";
import { COMMAND_ICONS, GROUP_ICONS, commandIcon, iconByName } from "./command-icons";
import { COMMANDS, defaultKeymap, mergeKeymap, type CommandId } from "./commands";

const targets: NewConversationTarget[] = [
  { id: "project_a", name: "Telar", root: "/Users/someone/code/telar" },
  { id: "project_b", name: "Notes", root: "/Users/someone/code/notes" },
  { id: "project_c", name: "Telar", hostId: "host_mini", hostName: "mini" },
];

const session = (id: string, title: string, updatedAt: number, rest: Partial<PaletteSessionLike> = {}): PaletteSessionLike => ({
  id,
  title,
  updatedAt,
  ...rest,
});

const sessions: PaletteSessionLike[] = [
  session("s1", "Rename the rail", 5, { projectName: "Telar" }),
  session("s2", "Port the palette", 9, { projectName: "Telar" }),
  session("s3", "Write the notes", 7, { projectName: "Notes" }),
  session("s4", "Pair the mini", 3, { projectName: "Telar", hostId: "host_mini", hostName: "mini" }),
];

/** Everything runs, which is the fixture for the fold's own rules — what the
 *  live palette actually asks is pinned separately below. */
const anything = () => true;

/** The live stores, as the fold sees them. A desktop cockpit on the defaults,
 *  so every row that can exist does — each test then moves the one member it
 *  is about. */
const state = (over: Partial<QuickSettingsState> = {}): QuickSettingsState => ({
  scheme: "dark",
  look: "",
  accent: "Indigo",
  fontSize: 16,
  translucent: false,
  translucency: true,
  railOpen: true,
  ...over,
});

describe("the Actions section is the registry, filtered", () => {
  test("a command nothing can run is not a row", () => {
    // THE "NO DEAD ROWS" RULE. A palette listing a verb that does nothing when
    // pressed is worse than a shorter palette — and this is also what keeps a
    // command shipped ahead of its surface (`search-project-contents`) out of
    // the list rather than in it, inert.
    const runnable = (id: CommandId) => id === "settings";
    expect(paletteActions(COMMANDS, defaultKeymap(), runnable).map((action) => action.id)).toEqual(["settings"]);
  });

  test("the nine jumps are never actions", () => {
    // Their whole subject is the recent list this palette already draws
    // underneath, so listing them would be that section again, as verbs.
    const ids = paletteActions(COMMANDS, defaultKeymap(), anything).map((action) => action.id);
    expect(ids.filter((id) => id.startsWith("jump-"))).toEqual([]);
  });

  test("the command that opened the palette is not a row in it", () => {
    const ids = paletteActions(COMMANDS, defaultKeymap(), anything, ["search-sessions"]).map((action) => action.id);
    expect(ids).not.toContain("search-sessions");
    expect(ids).toContain("add-project");
  });

  test("a command whose row moved to Quick settings leaves Actions entirely", () => {
    // #479: Toggle Rail is one verb, and listing it in both sections would be
    // the palette offering it twice — once with the state beside it and once
    // without.
    expect(PALETTE_QUICK_COMMANDS).toEqual(["toggle-rail"]);
    const ids = paletteActions(COMMANDS, defaultKeymap(), anything, ["search-sessions", ...PALETTE_QUICK_COMMANDS]).map(
      (action) => action.id,
    );
    expect(ids).not.toContain("toggle-rail");
    // It is still a real registry command, with its chord and its menu place.
    expect(COMMANDS.some((command) => command.id === "toggle-rail")).toBe(true);
  });

  test("each row carries the chord it is bound to NOW, not the one it shipped with", () => {
    const rebound = mergeKeymap({ "add-project": "CommandOrControl+Shift+A" });
    const actions = paletteActions(COMMANDS, rebound, anything);
    expect(actions.find((action) => action.id === "add-project")?.chord).toBe("CommandOrControl+Shift+A");
    // An unbound command is "" — the row simply draws no caps.
    expect(actions.find((action) => action.id === "appearance")?.chord).toBe("");
  });

  test("the two doors are marked as doors, and they are the project palette's pages", () => {
    const actions = paletteActions(COMMANDS, defaultKeymap(), anything);
    expect(actions.find((action) => action.id === "new-conversation-in")?.page).toBe("projects");
    expect(actions.find((action) => action.id === "add-project")?.page).toBe("sources");
    // Everything else runs and the dialog is done.
    expect(actions.find((action) => action.id === "settings")?.page).toBeUndefined();
    expect(PALETTE_SUB_PAGES["new-conversation-in"]).toBe("projects");
  });

  test("an action is found by what it says and by what it is called", () => {
    const actions = paletteActions(COMMANDS, defaultKeymap(), anything);
    expect(matchActions(actions, "add project").map((action) => action.id)).toEqual(["add-project"]);
    // The id is what somebody reads off the keybindings pane.
    expect(matchActions(actions, "go-to-file").map((action) => action.id)).toEqual(["go-to-file"]);
    // Case is not a filter, and a blank query is everything.
    expect(matchActions(actions, "APPEARANCE").map((action) => action.id)).toEqual(["appearance"]);
    expect(matchActions(actions, "   ").length).toBe(actions.length);
    expect(matchActions(actions, "nothing like this")).toEqual([]);
  });
});

describe("the Quick settings rows", () => {
  test("always in this order, whatever the stores say", () => {
    // The same rule as the sections: a list that reshuffles itself is a list
    // nobody can learn. What the state changes is which rows EXIST and what
    // they read, never where a row sits among the others.
    expect(quickSettings(state()).map((row) => row.id)).toEqual([
      "quick-colour-scheme",
      "quick-look",
      "quick-accent",
      "quick-font-size-smaller",
      "quick-font-size-larger",
      "quick-translucency",
      "quick-rail",
    ]);
  });

  test("a row reads back what it is set to right now", () => {
    // This is the whole difference between a knob and a guess: you can see the
    // state you are about to change.
    const rows = (over: Partial<QuickSettingsState> = {}) =>
      Object.fromEntries(quickSettings(state(over)).map((row) => [row.id, row.value]));
    expect(rows()["quick-colour-scheme"]).toBe("Dark");
    expect(rows({ scheme: "light" })["quick-colour-scheme"]).toBe("Light");
    expect(rows({ scheme: "system" })["quick-colour-scheme"]).toBe("System");
    expect(rows({ accent: "Moss" })["quick-accent"]).toBe("Moss");
    expect(rows({ fontSize: 15 })["quick-font-size-larger"]).toBe("15 px");
    expect(rows({ translucent: true })["quick-translucency"]).toBe("On");
    expect(rows()["quick-translucency"]).toBe("Off");
    expect(rows()["quick-rail"]).toBe("Shown");
    expect(rows({ railOpen: false })["quick-rail"]).toBe("Hidden");
  });

  test("the Look row names the look being worn, and says nothing when none is", () => {
    // A hand-edited palette is honestly not a Look, and a row that named one
    // anyway would be the readout lying about the state beside it.
    expect(quickSettings(state({ look: "Dusk" })).find((row) => row.id === "quick-look")?.value).toBe("Dusk");
    expect(quickSettings(state()).find((row) => row.id === "quick-look")?.value).toBe("");
  });

  test("the two doors are doors; everything else applies in place", () => {
    const pages = Object.fromEntries(quickSettings(state()).map((row) => [row.id, row.page]));
    expect(pages["quick-look"]).toBe("looks");
    expect(pages["quick-accent"]).toBe("accent");
    expect(pages["quick-colour-scheme"]).toBeUndefined();
    expect(pages["quick-rail"]).toBeUndefined();
  });

  test("a row that cannot move is not drawn", () => {
    // At 18px there is no larger. Offering the step anyway would be the
    // palette promising something it will silently clamp away — the same "no
    // dead rows" rule the Actions section runs on.
    const ids = (fontSize: number) => quickSettings(state({ fontSize })).map((row) => row.id);
    expect(ids(18)).not.toContain("quick-font-size-larger");
    expect(ids(18)).toContain("quick-font-size-smaller");
    expect(ids(13)).not.toContain("quick-font-size-smaller");
    expect(ids(13)).toContain("quick-font-size-larger");
  });

  test("translucency is absent in a browser tab, not drawn dead", () => {
    // It is macOS-and-the-shell only. A row that cannot do its thing is worse
    // than a shorter list.
    expect(quickSettings(state({ translucency: false })).map((row) => row.id)).not.toContain("quick-translucency");
  });

  test("a row is found by what it says, what it is called, and what it is SET TO", () => {
    const rows = quickSettings(state({ scheme: "dark" }));
    expect(matchQuick(rows, "accent").map((row) => row.id)).toEqual(["quick-accent"]);
    expect(matchQuick(rows, "quick-rail").map((row) => row.id)).toEqual(["quick-rail"]);
    // Somebody looking for the setting they can SEE: the scheme reads "Dark".
    expect(matchQuick(rows, "dark").map((row) => row.id)).toEqual(["quick-colour-scheme"]);
    expect(matchQuick(rows, "text size").map((row) => row.id)).toEqual([
      "quick-font-size-smaller",
      "quick-font-size-larger",
    ]);
    expect(matchQuick(rows, "   ").length).toBe(rows.length);
    expect(matchQuick(rows, "nothing like this")).toEqual([]);
  });
});

describe("a glyph per command, not one per group", () => {
  test("every command in the registry names an icon this map has", () => {
    // The test the icon field exists FOR: a command added to the shared table
    // with a name nothing resolves would draw its group's glyph and look
    // broken beside the ones that picked — so the miss is caught here rather
    // than in the palette.
    const unmapped = COMMANDS.filter((command) => !COMMAND_ICONS[command.icon]).map((command) => command.id);
    expect(unmapped).toEqual([]);
  });

  test("the palette's own quick rows name icons the same map has", () => {
    const unmapped = quickSettings(state())
      .filter((row) => !COMMAND_ICONS[row.icon])
      .map((row) => row.id);
    expect(unmapped).toEqual([]);
  });

  test("distinct commands get distinct glyphs, which is the point of the field", () => {
    // Nine jumps share one — the digit is all that separates them and the
    // palette never lists them — so they are folded out before counting.
    const icons = COMMANDS.filter((command) => !command.jump).map((command) => command.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  test("an unknown name falls back to the group's glyph rather than nothing", () => {
    // What keeps the registry free to grow without this file.
    expect(iconByName("no-such-icon")).toBeUndefined();
    expect(commandIcon("open-diff")).toBe(COMMAND_ICONS["git-compare"]);
    expect(commandIcon("not-a-command" as CommandId)).toBe(GROUP_ICONS.Application);
  });
});

describe("the recent conversations", () => {
  test("most recent first, and eight of them", () => {
    expect(RECENT_CONVERSATION_LIMIT).toBe(8);
    expect(recentSessions(sessions, "").map((row) => row.id)).toEqual(["s2", "s3", "s1", "s4"]);
    expect(recentSessions(sessions, "", 2).map((row) => row.id)).toEqual(["s2", "s3"]);
  });

  test("searched before it is cut, so the ninth-oldest is reachable by typing", () => {
    // Cutting first would mean a query could only ever find the eight most
    // recent — and the one you are trying to get back to is usually older than
    // that, which is why you are typing.
    const many = Array.from({ length: 20 }, (_, index) => session(`s${index}`, index === 19 ? "the old one" : "noise", 100 - index));
    expect(recentSessions(many, "old").map((row) => row.id)).toEqual(["s19"]);
  });

  test("it matches the project and the Mac, because the row says both", () => {
    expect(recentSessions(sessions, "notes").map((row) => row.id)).toEqual(["s3"]);
    expect(recentSessions(sessions, "mini").map((row) => row.id)).toEqual(["s4"]);
  });

  test("a row's key carries its Mac, since two Macs can mint one session id", () => {
    expect(paletteSessionKey(sessions[0]!)).toBe("s1");
    expect(paletteSessionKey(sessions[3]!)).toBe("host_mini:s4");
  });
});

describe("the four sections", () => {
  const actions = paletteActions(COMMANDS, defaultKeymap(), anything, ["search-sessions"]);
  const quick = quickSettings(state());

  test("Actions, Quick settings, Projects, Recent conversations — always in that order", () => {
    // Fixed rather than ranked: a list that reorders itself under a query is a
    // list you cannot learn the shape of. Quick settings sits under Actions —
    // a knob is more specific than a verb and less specific than a place.
    const sections = paletteSections({ actions, quick, targets, sessions, query: "" });
    expect(sections.map((section) => section.id)).toEqual(["actions", "quick", "projects", "sessions"]);
    expect(sections.map((section) => section.title)).toEqual([
      "Actions",
      "Quick settings",
      "Projects",
      "Recent conversations",
    ]);
  });

  test("an empty section is not drawn at all", () => {
    // A heading over nothing is a heading that says "you found nothing here",
    // four times, on the way to the one row that matched.
    const sections = paletteSections({ actions, quick, targets, sessions, query: "notes" });
    expect(sections.map((section) => section.id)).toEqual(["projects", "sessions"]);
    expect(paletteSections({ actions, quick, targets, sessions, query: "nothing like this at all" })).toEqual([]);
  });

  test("a palette handed no quick rows has no Quick settings heading", () => {
    // The server, and any test that does not care: the section is absent
    // rather than an empty heading, by the same rule as the other three.
    const sections = paletteSections({ actions, targets, sessions, query: "" });
    expect(sections.map((section) => section.id)).toEqual(["actions", "projects", "sessions"]);
  });

  test("a quick row is a row the arrows walk, carrying its readout", () => {
    const rows = paletteRows(paletteSections({ actions, quick, targets, sessions, query: "colour scheme" }));
    expect(rows.map((row) => row.kind)).toEqual(["quick"]);
    expect(rows[0]).toMatchObject({ kind: "quick", key: "quick-colour-scheme", value: "Dark" });
  });

  test("one query, three kinds of answer", () => {
    const sections = paletteSections({ actions, targets, sessions, query: "telar" });
    const rows = paletteRows(sections);
    expect(rows.filter((row) => row.kind === "project").length).toBe(2);
    // Two conversations name Telar as their project; the third is on the mini.
    expect(rows.filter((row) => row.kind === "session").map((row) => (row.kind === "session" ? row.session.id : "")))
      .toEqual(["s2", "s1", "s4"]);
  });

  test("the flat list is what an index into the palette means", () => {
    const sections = paletteSections({ actions, targets, sessions, query: "" });
    const rows = paletteRows(sections);
    expect(rows.length).toBe(sections.reduce((total, section) => total + section.rows.length, 0));
    // The arrows walk every row of every section, in the order they are drawn.
    expect(rows[0]?.kind).toBe("action");
    expect(rows[rows.length - 1]?.kind).toBe("session");
  });

  test("the recent cut applies to the section, not to the whole palette", () => {
    const many = Array.from({ length: 20 }, (_, index) => session(`s${index}`, `conversation ${index}`, index));
    const sections = paletteSections({ actions, targets, sessions: many, query: "" });
    expect(sections.find((section) => section.id === "sessions")?.rows.length).toBe(RECENT_CONVERSATION_LIMIT);
  });
});

describe("where Backspace goes", () => {
  test("nowhere at all while there is something to delete", () => {
    // The field is the dialog's title, so Backspace is a text key first.
    expect(paletteBack("sources", "gith", "projects")).toBeUndefined();
    expect(paletteBack("projects", "x", "projects")).toBeUndefined();
  });

  test("Sources walks to Projects before it leaves the pages", () => {
    expect(paletteBack("sources", "", "projects")).toBe("projects");
  });

  test("a page that was itself the door leaves the pages", () => {
    // Opened straight onto Sources from the command palette: back is the
    // palette's own list, not a page the reader never saw.
    expect(paletteBack("sources", "", "sources")).toBe("root");
    expect(paletteBack("projects", "", "projects")).toBe("root");
  });

  test("the standalone palette's Sources always has a back, because its root is Projects", () => {
    // Both doors converge on Projects and it is a legitimate place to arrive at
    // from either — which is what the palette passes when there is nowhere
    // further to go than these two pages.
    expect(paletteBack("sources", "", "projects")).toBe("projects");
  });
});
