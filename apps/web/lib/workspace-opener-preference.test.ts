/**
 * The three decisions behind the split "Open" button — what it remembers, what
 * it offers, and what its left half promises — checked without a browser, a
 * desktop shell or a React tree.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  preferredOpenerSnapshot,
  readPreferredOpener,
  remembersOpener,
  REVEAL_OPENER_ID,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  SYSTEM_OPENER_ID,
  workspaceOpenerEntries,
  workspaceOpenerPreferenceKey,
  workspaceOpenerPrimary,
  workspaceOpenerPrimaryLabel,
  writePreferredOpener,
  type OpenerLike,
} from "./workspace-opener-preference";

const INSTALLED: OpenerLike[] = [
  { id: "vscode", label: "Visual Studio Code", icon: "vscode", path: "/Applications/Visual Studio Code.app" },
  { id: "zed", label: "Zed", icon: "zed", path: "/Applications/Zed.app" },
  { id: "textmate", label: "TextMate", path: "/Applications/TextMate.app" },
];

/** A `Storage` that is just an object, so a test can read what was written. */
function fakeStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

describe("remembering the app", () => {
  test("the key carries the machine, because an opener id only means something on one", () => {
    expect(workspaceOpenerPreferenceKey("host_mac_lan")).toBe("telar:workspace-opener:v1:host_mac_lan");
    // No host named is this machine — the only one whose apps can be listed.
    expect(workspaceOpenerPreferenceKey()).toBe("telar:workspace-opener:v1:local");
    expect(workspaceOpenerPreferenceKey("local")).toBe("telar:workspace-opener:v1:local");
    expect(workspaceOpenerPreferenceKey("")).toBe("telar:workspace-opener:v1:local");
  });

  test("two machines remember separately", () => {
    const storage = fakeStorage();
    writePreferredOpener("local", "zed", storage);
    writePreferredOpener("host_mac_lan", "vscode", storage);
    expect(readPreferredOpener("local", storage)).toBe("zed");
    expect(readPreferredOpener("host_mac_lan", storage)).toBe("vscode");
  });

  test("nothing remembered reads as undefined, not as an empty string", () => {
    expect(readPreferredOpener("local", fakeStorage())).toBeUndefined();
    // A blank value is somebody's devtools, not a choice.
    expect(readPreferredOpener("local", fakeStorage({ "telar:workspace-opener:v1:local": "" }))).toBeUndefined();
  });

  test("a storage that throws costs the shortcut and nothing else", () => {
    // Safari in private mode, or a full quota. The folder still opens; the
    // button just goes back to asking.
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readPreferredOpener("local", hostile)).toBeUndefined();
    expect(() => writePreferredOpener("local", "zed", hostile)).not.toThrow();
  });

  test("no storage at all (server render) is not an error", () => {
    expect(readPreferredOpener("local", undefined)).toBeUndefined();
    expect(() => writePreferredOpener("local", "zed", undefined)).not.toThrow();
  });
});

describe("what an open teaches the button", () => {
  test("an app and the system default are remembered; a reveal is not", () => {
    // The button remembers the last app you OPENED the folder in. A reveal is
    // a look — you wanted to see where the folder lives — and a primary button
    // reading "Reveal in Finder" after one glance has drawn the wrong lesson.
    // The system default IS an open, and is remembered like any app.
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    const kindOf = (id: string) => entries.find((entry) => entry.id === id)!;
    expect(remembersOpener(kindOf("zed"))).toBe(true);
    expect(remembersOpener(kindOf(SYSTEM_OPENER_ID))).toBe(true);
    expect(remembersOpener(kindOf(REVEAL_OPENER_ID))).toBe(false);
    expect(remembersOpener(workspaceOpenerEntries({ openers: [] })[0]!)).toBe(false);
  });

  test("a reveal stored by an earlier build is ignored rather than pinned forever", () => {
    // The rule is applied on READ too, so nobody is left with a button that
    // reveals because a previous version remembered a glance.
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: REVEAL_OPENER_ID });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", SYSTEM_OPENER_ID, REVEAL_OPENER_ID]);
    expect(entries.every((entry) => entry.preferred === undefined)).toBe(true);
    // It falls through to the ordinary default, so the half opens an editor
    // rather than ever reaching for Finder.
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: "vscode", kind: "opener" });
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Open in Visual Studio Code");
  });

  test("the system default still reaches the left half", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: SYSTEM_OPENER_ID });
    expect(entries[0]).toMatchObject({ id: SYSTEM_OPENER_ID, preferred: true });
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Open in the default app");
  });
});

describe("the store the button reads through", () => {
  test("the server renders no preference, so the first client render can agree with it", () => {
    expect(serverPreferredOpenerSnapshot()).toBeUndefined();
  });

  test("an open notifies subscribers and changes that machine's snapshot only", () => {
    const storage = fakeStorage();
    let notified = 0;
    const unsubscribe = subscribePreferredOpener(() => void (notified += 1));
    try {
      writePreferredOpener("snapshot_host_a", "zed", storage);
      expect(notified).toBe(1);
      expect(preferredOpenerSnapshot("snapshot_host_a")).toBe("zed");
      // The other Mac is untouched — one cached answer per machine.
      expect(preferredOpenerSnapshot("snapshot_host_b")).toBeUndefined();

      writePreferredOpener("snapshot_host_a", SYSTEM_OPENER_ID, storage);
      expect(notified).toBe(2);
      // The cache follows the write; a stale snapshot here would leave the
      // button naming the app you just stopped using.
      expect(preferredOpenerSnapshot("snapshot_host_a")).toBe(SYSTEM_OPENER_ID);
    } finally {
      unsubscribe();
    }
  });

  test("unsubscribing stops the notices", () => {
    let notified = 0;
    subscribePreferredOpener(() => void (notified += 1))();
    writePreferredOpener("snapshot_host_c", "zed", fakeStorage());
    expect(notified).toBe(0);
  });
});

describe("the list", () => {
  test("first run: the shell's own order, then the two that are not apps", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", SYSTEM_OPENER_ID, REVEAL_OPENER_ID]);
    expect(entries.every((entry) => !entry.preferred)).toBe(true);
  });

  test("revealing is an entry in the same list, not a control beside it", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    const reveal = entries.find((entry) => entry.id === REVEAL_OPENER_ID);
    expect(reveal).toMatchObject({ kind: "reveal", label: "Reveal in Finder" });
    // ...and it is the one entry that can never BE the left half, so it carries
    // no label for that half either.
    expect(reveal?.primaryLabel).toBeUndefined();
  });

  test("the preferred entry is hoisted to the top and marked", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" });
    expect(entries.map((entry) => entry.id)).toEqual(["zed", "vscode", "textmate", SYSTEM_OPENER_ID, REVEAL_OPENER_ID]);
    expect(entries[0]?.preferred).toBe(true);
    // Hoisted, not duplicated.
    expect(entries.filter((entry) => entry.id === "zed")).toHaveLength(1);
    expect(entries.filter((entry) => entry.preferred)).toHaveLength(1);
  });

  test("an editor uninstalled since the last open is simply not applied", () => {
    // The failure this prevents: a button that still says "Open in Cursor" and
    // errors when pressed, for an app that is no longer on the machine.
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "cursor" });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", SYSTEM_OPENER_ID, REVEAL_OPENER_ID]);
    expect(entries.every((entry) => entry.preferred === undefined)).toBe(true);
    // The half names something installed instead — never the app that is gone.
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: "vscode" });
  });

  test("an installed app carries its brand mark; one we have no mark for carries none", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.find((entry) => entry.id === "vscode")?.icon).toBe("vscode");
    expect(entries.find((entry) => entry.id === "textmate")?.icon).toBeUndefined();
  });

  test("an app is launched by id, and nothing else is", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.find((entry) => entry.id === "zed")?.openerId).toBe("zed");
    expect(entries.find((entry) => entry.id === SYSTEM_OPENER_ID)?.openerId).toBeUndefined();
    expect(entries.find((entry) => entry.id === REVEAL_OPENER_ID)?.openerId).toBeUndefined();
  });

  test("none installed is a row that says so, with the two fallbacks still there", () => {
    const entries = workspaceOpenerEntries({ openers: [] });
    expect(entries.map((entry) => entry.label)).toEqual(["No installed editors found", "System default", "Reveal in Finder"]);
    expect(entries[0]?.kind).toBe("empty");
  });

  test("the inert row can never become the remembered choice", () => {
    const entries = workspaceOpenerEntries({ openers: [], preferred: "none" });
    expect(entries[0]?.preferred).toBeUndefined();
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Open");
  });
});

describe("hairlines", () => {
  const separatorsAbove = (entries: { id: string; separatorBefore?: boolean }[]) =>
    entries.filter((entry) => entry.separatorBefore).map((entry) => entry.id);

  test("first run: one line, where the apps give way to the not-apps", () => {
    expect(separatorsAbove(workspaceOpenerEntries({ openers: INSTALLED }))).toEqual([SYSTEM_OPENER_ID]);
  });

  test("a hoisted app gets a line under it, and the group line stays", () => {
    expect(separatorsAbove(workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" }))).toEqual(["vscode", SYSTEM_OPENER_ID]);
  });

  test("the only installed app, hoisted: the two rules want the same line and draw one", () => {
    const entries = workspaceOpenerEntries({ openers: [INSTALLED[0]!], preferred: "vscode" });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", SYSTEM_OPENER_ID, REVEAL_OPENER_ID]);
    expect(separatorsAbove(entries)).toEqual([SYSTEM_OPENER_ID]);
  });

  test("the system default hoisted leaves the reveal alone below the apps", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: SYSTEM_OPENER_ID });
    expect(entries.map((entry) => entry.id)).toEqual([SYSTEM_OPENER_ID, "vscode", "zed", "textmate", REVEAL_OPENER_ID]);
    expect(separatorsAbove(entries)).toEqual(["vscode", REVEAL_OPENER_ID]);
  });

  test("the first row never carries a line above it", () => {
    for (const preferred of [undefined, "zed", SYSTEM_OPENER_ID, REVEAL_OPENER_ID]) {
      expect(workspaceOpenerEntries({ openers: INSTALLED, preferred })[0]?.separatorBefore).toBeUndefined();
    }
  });
});

describe("what the left half says", () => {
  test("nothing remembered: VS Code, because that is the answer most people would have given", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Open in Visual Studio Code");
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: "vscode", icon: "vscode" });
  });

  test("no VS Code: the first editor the machine does have, in the shell's order", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED.filter((opener) => opener.id !== "vscode") });
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: "zed" });
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Open in Zed");
  });

  test("a default is not a preference: it hoists nothing and is not marked", () => {
    // The list stays in the shell's own order, and no row claims to be the
    // remembered one — the only thing the default decides is the left half.
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", SYSTEM_OPENER_ID, REVEAL_OPENER_ID]);
    expect(entries.every((entry) => entry.preferred === undefined)).toBe(true);
  });

  test("what you actually chose beats the default", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" });
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: "zed", preferred: true });
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Open in Zed");
  });

  test("a preference for something uninstalled falls back to the default, not to 'Open'", () => {
    // The module re-validates on read; the button should still offer the best
    // guess it has rather than forgetting how to open anything.
    expect(workspaceOpenerPrimaryLabel(workspaceOpenerEntries({ openers: INSTALLED, preferred: "emacs" }))).toBe("Open in Visual Studio Code");
  });

  test("it names the app, so the button says what pressing it will do", () => {
    expect(workspaceOpenerPrimaryLabel(workspaceOpenerEntries({ openers: INSTALLED, preferred: "vscode" }))).toBe("Open in Visual Studio Code");
    expect(workspaceOpenerPrimaryLabel(workspaceOpenerEntries({ openers: INSTALLED, preferred: SYSTEM_OPENER_ID }))).toBe("Open in the default app");
  });

  test("no editors at all: 'Open', and the menu rather than a guess", () => {
    // The system default and the reveal are in the list and are deliberately
    // not guessed into — see workspaceOpenerPrimary.
    expect(workspaceOpenerPrimary(workspaceOpenerEntries({ openers: [] }))).toBeUndefined();
    expect(workspaceOpenerPrimaryLabel(workspaceOpenerEntries({ openers: [] }))).toBe("Open");
    expect(workspaceOpenerPrimaryLabel([])).toBe("Open");
  });
});

describe("the shortcut hint", () => {
  test("it rides the preferred row only — the menu teaches the one you use", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed", shortcut: "⌘⏎" });
    expect(entries[0]).toMatchObject({ id: "zed", shortcut: "⌘⏎" });
    expect(entries.slice(1).every((entry) => entry.shortcut === undefined)).toBe(true);
  });

  test("nothing is bound, so nothing is promised", () => {
    // Telar binds no chord to opening a workspace today (lib/command-keys.ts),
    // and a hint for a key that does nothing is worse than no hint.
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" });
    expect(entries.every((entry) => entry.shortcut === undefined)).toBe(true);
  });

  test("with no preference there is no row to teach it on", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, shortcut: "⌘⏎" });
    expect(entries.every((entry) => entry.shortcut === undefined)).toBe(true);
  });
});
