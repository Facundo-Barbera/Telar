/**
 * The command keys, pinned end to end: the shared binding table (imported from
 * `apps/desktop/command-keys.js` — the same physical file `main.js` requires, so
 * this exercises the real cross-app import rather than a copy of it), the focus
 * rule, what each id means in THIS cockpit, and which rows ⌘1..⌘9 count.
 *
 * WHAT THIS WOULD HAVE CAUGHT: nothing. The table, the menu and the bridge were
 * all present and correct; the renderer simply never imported any of it, so the
 * keys did nothing and no test could have known. `useCommandKeys` being mounted
 * is the fact that mattered, and it is verified by driving, not from here.
 */
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  COMMAND_KEY_BINDINGS,
  commandKeyDestination,
  isEditableTarget,
  jumpNumber,
  resolveWebCommandKeyAction,
  type CommandKeyId,
} from "./command-keys";
import { recentSessionsForCommandKeys, sessionHref, type SidebarSession } from "./session-list";

const EXPECTED_IDS: CommandKeyId[] = [
  "new-session",
  "new-tab",
  "jump-1",
  "jump-2",
  "jump-3",
  "jump-4",
  "jump-5",
  "jump-6",
  "jump-7",
  "jump-8",
  "jump-9",
  "settings",
];

const NOW = 1_800_000_000_000;

const row = (id: string, title: string, over: Partial<SidebarSession> = {}): SidebarSession => ({
  id,
  title,
  projectId: "p1",
  activity: "idle",
  createdAt: NOW - 1_000,
  updatedAt: NOW - 1_000,
  archived: false,
  driver: "claude",
  workspacePath: "/repo",
  ...over,
});

describe("the binding table is the one source of truth", () => {
  test("is the exact closed set of ids the app declares, in order", () => {
    // THE CLOSED-LIST GUARD: the one place TypeScript's `CommandKeyId` union is
    // checked against the plain-JS table it describes. Add a binding to
    // command-keys.js without updating both, and this fails.
    expect(COMMAND_KEY_BINDINGS.map((binding) => binding.id)).toEqual(EXPECTED_IDS);
  });

  test("every accelerator uses CommandOrControl, never a hardcoded Cmd or Ctrl", () => {
    // The same table has to work unmodified on a Windows or Linux build.
    for (const binding of COMMAND_KEY_BINDINGS) expect(binding.accelerator.startsWith("CommandOrControl+")).toBe(true);
  });

  test("only the jump bindings carry a jump number, and it matches the id", () => {
    for (const binding of COMMAND_KEY_BINDINGS) expect(binding.jump).toBe(jumpNumber(binding.id as CommandKeyId));
  });
});

describe("the focus rule", () => {
  test("a chord fires from inside a text field, which is the whole point of a chord", () => {
    // The composer holds focus nearly all the time here. A rule that suppressed
    // chords would leave the table with no state in which it could ever fire.
    const composer = { tagName: "TEXTAREA" };
    expect(resolveWebCommandKeyAction({ key: "n", metaKey: true, target: composer })).toBe("new-session");
    expect(resolveWebCommandKeyAction({ key: ",", ctrlKey: true, target: composer })).toBe("settings");
  });

  test("a bare key over an editable surface is suppressed", () => {
    // Nothing in today's table is bare, so this suppresses nothing yet. It is
    // here for the first one: a naked "n" over a field must type an "n".
    expect(resolveWebCommandKeyAction({ key: "n", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  test("an unchorded key that matches nothing is still nothing", () => {
    expect(resolveWebCommandKeyAction({ key: "n" })).toBeNull();
    expect(resolveWebCommandKeyAction({ key: "z", metaKey: true })).toBeNull();
  });
});

describe("what a binding means here", () => {
  test("new session and new tab both target the composer at /", () => {
    // `/` resolves a project and opens its canvas — the same guess the rail's
    // own New conversation button makes, so the key and the button agree.
    expect(commandKeyDestination("new-session", [])).toEqual({ kind: "navigate", href: "/" });
    expect(commandKeyDestination("new-tab", [])).toEqual({ kind: "open-tab", href: "/" });
    expect(commandKeyDestination("settings", [])).toEqual({ kind: "navigate", href: "/settings" });
  });

  test("a jump past the end of the list does nothing rather than something wrong", () => {
    expect(commandKeyDestination("jump-1", ["/a"])).toEqual({ kind: "navigate", href: "/a" });
    expect(commandKeyDestination("jump-2", ["/a"])).toEqual({ kind: "noop" });
    expect(commandKeyDestination("jump-3", ["/a", undefined, "/c"])).toEqual({ kind: "navigate", href: "/c" });
  });
});

describe("what ⌘1..⌘9 count", () => {
  test("pinned rows come first, because that is where the rail draws them", () => {
    const rows = [
      row("s1", "Newest", { createdAt: NOW - 1_000 }),
      row("s2", "Older", { createdAt: NOW - 2_000 }),
      row("s3", "Kept", { createdAt: NOW - 9_000, settledOverride: "active" }),
    ];
    // A ⌘1 that skipped the row sitting at the top of the rail would be a
    // shortcut you have to look at the screen to use.
    expect(recentSessionsForCommandKeys(rows, undefined, NOW).map((session) => session.title)).toEqual(["Kept", "Newest", "Older"]);
  });

  test("shelved rows are not countable — you said you did not want them in front of you", () => {
    const rows = [
      row("s1", "Live"),
      row("s2", "Asleep", { snoozedUntil: NOW + 3_600_000, snoozedAt: NOW - 1_000 }),
      row("s3", "Shelved", { settledOverride: "settled" }),
    ];
    expect(recentSessionsForCommandKeys(rows, undefined, NOW).map((session) => session.title)).toEqual(["Live"]);
  });

  test("never more than nine, whatever the survivor rule pins into view", () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(`s${index}`, `Session ${index}`, { createdAt: NOW - index * 1_000 }));
    // The open session is pinned onto the page past the limit, which is right
    // for rendering and meaningless for indexing — hence the slice.
    const recent = recentSessionsForCommandKeys(rows, "s19", NOW);
    expect(recent).toHaveLength(9);
    expect(sessionHref(recent[0]!)).toBe("/projects/p1/sessions/s0");
  });
});
