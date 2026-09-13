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
  test("an app is remembered; a reveal is not, even though it is the default", () => {
    // The button remembers the last app you OPENED the folder in. A reveal is a
    // look — and being what the half does BEFORE you have chosen anything is a
    // different claim from being what you chose.
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    const kindOf = (id: string) => entries.find((entry) => entry.id === id)!;
    expect(remembersOpener(kindOf("zed"))).toBe(true);
    expect(remembersOpener(kindOf(REVEAL_OPENER_ID))).toBe(false);
    expect(remembersOpener(workspaceOpenerEntries({ openers: [] })[0]!)).toBe(false);
  });

  test("a reveal stored by an earlier build hoists and marks nothing", () => {
    // The rule is applied on READ too. Finder is where the half points anyway
    // now, but it must get there as the DEFAULT — an unmarked row in the shell's
    // own order — not as a choice somebody never made.
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: REVEAL_OPENER_ID });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", REVEAL_OPENER_ID]);
    expect(entries.every((entry) => entry.preferred === undefined)).toBe(true);
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: REVEAL_OPENER_ID, kind: "reveal" });
  });

  test("a 'system' remembered by an earlier build names a row that no longer exists", () => {
    // #384 removed "System default". Somebody who last used it has that id in
    // localStorage; the menu must not hoist a phantom row or strand the half.
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: SYSTEM_OPENER_ID });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", REVEAL_OPENER_ID]);
    expect(entries.every((entry) => entry.preferred === undefined)).toBe(true);
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Reveal in Finder");
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

      writePreferredOpener("snapshot_host_a", "vscode", storage);
      expect(notified).toBe(2);
      // The cache follows the write; a stale snapshot here would leave the
      // button naming the app you just stopped using.
      expect(preferredOpenerSnapshot("snapshot_host_a")).toBe("vscode");
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
  test("first run: the shell's own order, then the one that is not an app", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", REVEAL_OPENER_ID]);
    expect(entries.every((entry) => !entry.preferred)).toBe(true);
  });

  test("there is NO system-default row", () => {
    // It was the same gesture as the reveal below it — on a Mac the OS opens a
    // folder in Finder — with the one difference that it could not say so.
    for (const openers of [INSTALLED, []]) {
      expect(workspaceOpenerEntries({ openers }).some((entry) => entry.id === SYSTEM_OPENER_ID)).toBe(false);
    }
  });

  test("revealing is an entry in the same list, not a control beside it", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    const reveal = entries.find((entry) => entry.id === REVEAL_OPENER_ID);
    // ...and it now carries words for the left half, because it IS the left
    // half until an editor is picked.
    expect(reveal).toMatchObject({ kind: "reveal", label: "Reveal in Finder", primaryLabel: "Reveal in Finder" });
  });

  test("the preferred entry is hoisted to the top and marked", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" });
    expect(entries.map((entry) => entry.id)).toEqual(["zed", "vscode", "textmate", REVEAL_OPENER_ID]);
    expect(entries[0]?.preferred).toBe(true);
    // Hoisted, not duplicated.
    expect(entries.filter((entry) => entry.id === "zed")).toHaveLength(1);
    expect(entries.filter((entry) => entry.preferred)).toHaveLength(1);
  });

  test("an editor uninstalled since the last open is simply not applied", () => {
    // The failure this prevents: a button that still says "Open in Cursor" and
    // errors when pressed, for an app that is no longer on the machine.
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "cursor" });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", REVEAL_OPENER_ID]);
    expect(entries.every((entry) => entry.preferred === undefined)).toBe(true);
    // The half goes back to Finder rather than guessing a replacement editor.
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: REVEAL_OPENER_ID });
  });

  test("an installed app carries its brand mark; one we have no mark for carries none", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.find((entry) => entry.id === "vscode")?.icon).toBe("vscode");
    expect(entries.find((entry) => entry.id === "textmate")?.icon).toBeUndefined();
  });

  test("an app is launched by id, and nothing else is", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.find((entry) => entry.id === "zed")?.openerId).toBe("zed");
    expect(entries.find((entry) => entry.id === REVEAL_OPENER_ID)?.openerId).toBeUndefined();
  });

  test("none installed is a row that says so, with the reveal still there", () => {
    const entries = workspaceOpenerEntries({ openers: [] });
    expect(entries.map((entry) => entry.label)).toEqual(["No installed editors found", "Reveal in Finder"]);
    expect(entries[0]?.kind).toBe("empty");
  });

  test("the inert row can never become the remembered choice", () => {
    const entries = workspaceOpenerEntries({ openers: [], preferred: "none" });
    expect(entries[0]?.preferred).toBeUndefined();
    // The half still has something true to say: show me the folder.
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Reveal in Finder");
  });
});

describe("hairlines", () => {
  const separatorsAbove = (entries: { id: string; separatorBefore?: boolean }[]) =>
    entries.filter((entry) => entry.separatorBefore).map((entry) => entry.id);

  test("first run: one line, where the apps give way to the reveal", () => {
    expect(separatorsAbove(workspaceOpenerEntries({ openers: INSTALLED }))).toEqual([REVEAL_OPENER_ID]);
  });

  test("a hoisted app gets a line under it, and the group line stays", () => {
    expect(separatorsAbove(workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" }))).toEqual(["vscode", REVEAL_OPENER_ID]);
  });

  test("the only installed app, hoisted: the two rules want the same line and draw one", () => {
    const entries = workspaceOpenerEntries({ openers: [INSTALLED[0]!], preferred: "vscode" });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", REVEAL_OPENER_ID]);
    expect(separatorsAbove(entries)).toEqual([REVEAL_OPENER_ID]);
  });

  test("the first row never carries a line above it", () => {
    for (const preferred of [undefined, "zed", REVEAL_OPENER_ID]) {
      expect(workspaceOpenerEntries({ openers: INSTALLED, preferred })[0]?.separatorBefore).toBeUndefined();
    }
  });
});

describe("what the left half says", () => {
  test("nothing remembered: Finder, because a guess here launches on one click", () => {
    // It used to guess VS Code, then the first editor installed. Both are a
    // coin toss on a machine with two, and the cost of losing is somebody's
    // folder opening in an application they did not ask for.
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Reveal in Finder");
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: REVEAL_OPENER_ID, icon: REVEAL_OPENER_ID });
  });

  test("no VS Code, and still no guess: the half reveals rather than reaching for Zed", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED.filter((opener) => opener.id !== "vscode") });
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: REVEAL_OPENER_ID });
  });

  test("a default is not a preference: it hoists nothing and is not marked", () => {
    // The list stays in the shell's own order, and no row claims to be the
    // remembered one — the only thing the default decides is the left half.
    const entries = workspaceOpenerEntries({ openers: INSTALLED });
    expect(entries.map((entry) => entry.id)).toEqual(["vscode", "zed", "textmate", REVEAL_OPENER_ID]);
    expect(entries.every((entry) => entry.preferred === undefined)).toBe(true);
  });

  test("what you actually chose beats the default", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" });
    expect(workspaceOpenerPrimary(entries)).toMatchObject({ id: "zed", preferred: true });
    expect(workspaceOpenerPrimaryLabel(entries)).toBe("Open in Zed");
  });

  test("a preference for something uninstalled falls back to Finder, not to 'Open'", () => {
    // The module re-validates on read; the button should still name something
    // it can actually do rather than forgetting how to do anything.
    expect(workspaceOpenerPrimaryLabel(workspaceOpenerEntries({ openers: INSTALLED, preferred: "emacs" }))).toBe("Reveal in Finder");
  });

  test("it names the app, so the button says what pressing it will do", () => {
    expect(workspaceOpenerPrimaryLabel(workspaceOpenerEntries({ openers: INSTALLED, preferred: "vscode" }))).toBe("Open in Visual Studio Code");
  });

  test("no editors at all: still Finder, never a half that cannot name what it does", () => {
    expect(workspaceOpenerPrimary(workspaceOpenerEntries({ openers: [] }))).toMatchObject({ id: REVEAL_OPENER_ID });
    expect(workspaceOpenerPrimaryLabel(workspaceOpenerEntries({ openers: [] }))).toBe("Reveal in Finder");
    // An empty list is the shell's answer not having arrived; there the half
    // reads "Open" and shows the menu.
    expect(workspaceOpenerPrimary([])).toBeUndefined();
    expect(workspaceOpenerPrimaryLabel([])).toBe("Open");
  });
});

describe("the shortcut hint", () => {
  test("it rides the preferred row only — the menu teaches the one you use", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed", shortcut: "⌘⏎" });
    expect(entries[0]).toMatchObject({ id: "zed", shortcut: "⌘⏎" });
    expect(entries.slice(1).every((entry) => entry.shortcut === undefined)).toBe(true);
  });

  test("nothing is passed, so nothing is promised", () => {
    // ⌘O reveals in Finder (lib/commands.ts) but the button does not hand that
    // chord down, and a hint the caller never supplied would be invented.
    const entries = workspaceOpenerEntries({ openers: INSTALLED, preferred: "zed" });
    expect(entries.every((entry) => entry.shortcut === undefined)).toBe(true);
  });

  test("with no preference there is no row to teach it on", () => {
    const entries = workspaceOpenerEntries({ openers: INSTALLED, shortcut: "⌘⏎" });
    expect(entries.every((entry) => entry.shortcut === undefined)).toBe(true);
  });
});
