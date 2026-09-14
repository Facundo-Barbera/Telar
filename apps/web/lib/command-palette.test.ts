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
  PALETTE_SUB_PAGES,
  RECENT_CONVERSATION_LIMIT,
  matchActions,
  paletteActions,
  paletteBack,
  paletteRows,
  paletteSections,
  paletteSessionKey,
  recentSessions,
  type PaletteSessionLike,
} from "./command-palette";
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

describe("the three sections", () => {
  const actions = paletteActions(COMMANDS, defaultKeymap(), anything, ["search-sessions"]);

  test("Actions, then Projects, then Recent conversations — always in that order", () => {
    // Fixed rather than ranked: a list that reorders itself under a query is a
    // list you cannot learn the shape of.
    const sections = paletteSections({ actions, targets, sessions, query: "" });
    expect(sections.map((section) => section.id)).toEqual(["actions", "projects", "sessions"]);
    expect(sections.map((section) => section.title)).toEqual(["Actions", "Projects", "Recent conversations"]);
  });

  test("an empty section is not drawn at all", () => {
    // A heading over nothing is a heading that says "you found nothing here",
    // three times, on the way to the one row that matched.
    const sections = paletteSections({ actions, targets, sessions, query: "notes" });
    expect(sections.map((section) => section.id)).toEqual(["projects", "sessions"]);
    expect(paletteSections({ actions, targets, sessions, query: "nothing like this at all" })).toEqual([]);
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
