// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  clampIndex,
  completion,
  directoryField,
  directoryKey,
  edited,
  expandTilde,
  foldHome,
  rememberedDirectoryKey,
  type DirectoryBrowserState,
} from "./directory-browser";
import type { DirectoryEntry } from "@telar/engine-client";

const HOME = "/Users/someone";

const entry = (name: string, extra: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  name,
  path: `${HOME}/code/${name}`,
  git: false,
  hidden: name.startsWith("."),
  ...extra,
});

function at(overrides: Partial<DirectoryBrowserState> = {}): DirectoryBrowserState {
  const path = overrides.path ?? `${HOME}/code`;
  return {
    field: directoryField(path, HOME),
    path,
    parent: HOME,
    home: HOME,
    entries: [entry("telar"), entry("telegraph"), entry("notes")],
    index: 0,
    hidden: false,
    ...overrides,
  };
}

describe("paths", () => {
  test("~ expands, and nothing at all is home", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
    expect(expandTilde("~/", HOME)).toBe(HOME);
    expect(expandTilde("", HOME)).toBe(HOME);
    expect(expandTilde("~/code/telar", HOME)).toBe(`${HOME}/code/telar`);
    expect(expandTilde("~/code/", HOME)).toBe(`${HOME}/code`);
    expect(expandTilde("/tmp/x/", HOME)).toBe("/tmp/x");
    expect(expandTilde("~root/x", HOME)).toBe("~root/x");
  });

  test("the field folds home, and only on a real prefix", () => {
    expect(foldHome(HOME, HOME)).toBe("~");
    expect(foldHome(`${HOME}/code`, HOME)).toBe("~/code");
    expect(foldHome("/Users/someone-else/code", HOME)).toBe("/Users/someone-else/code");
  });

  test("the field ends in a separator, so typing continues inside the folder", () => {
    expect(directoryField(`${HOME}/code`, HOME)).toBe("~/code/");
    expect(directoryField(HOME, HOME)).toBe("~/");
    expect(directoryField("/Volumes/Backup", HOME)).toBe("/Volumes/Backup/");
  });

  test("edited is the test for whether the field is still the breadcrumb", () => {
    expect(edited(at())).toBe(false);
    expect(edited(at({ field: "~/code/tel" }))).toBe(true);
    // Deleting back to the breadcrumb restores the up gesture.
    expect(edited(at({ field: "~/code/" }))).toBe(false);
  });

  test("the highlight stays inside a list that changed size under it", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(-1);
  });

  test("the remembered directory is per host, because the paths are another Mac's", () => {
    expect(rememberedDirectoryKey(undefined)).toBe("telar.directory-browser.local");
    expect(rememberedDirectoryKey("local")).toBe("telar.directory-browser.local");
    expect(rememberedDirectoryKey("host_mini")).toBe("telar.directory-browser.host_mini");
  });
});

describe("completion", () => {
  test("a unique match completes and descends", () => {
    expect(completion(at({ field: "~/code/n" }))).toBe("~/code/notes/");
  });

  test("several matches complete as far as they agree — the shell behaviour", () => {
    expect(completion(at({ field: "~/code/t" }))).toBe("~/code/tel");
    expect(completion(at({ field: "~/code/tel" }))).toBeUndefined();
    expect(completion(at({ field: "~/code/tela" }))).toBe("~/code/telar/");
  });

  test("case is not a filter, and the typed characters are never rewritten", () => {
    expect(completion(at({ field: "~/code/NOT" }))).toBe("~/code/notes/");
  });

  test("nothing to complete: no match, no seed, or a directory that is not this one", () => {
    expect(completion(at({ field: "~/code/zz" }))).toBeUndefined();
    expect(completion(at({ field: "~/code/" }))).toBeUndefined();
    // Entries are this directory's; completing elsewhere would need a second listing.
    expect(completion(at({ field: "~/elsewhere/t" }))).toBeUndefined();
    expect(completion(at({ field: "telar" }))).toBeUndefined();
  });
});

describe("directoryKey", () => {
  test("the arrows wrap over the listing", () => {
    expect(directoryKey(at(), { key: "ArrowDown" })).toEqual({ type: "move", index: 1 });
    expect(directoryKey(at({ index: 2 }), { key: "ArrowDown" })).toEqual({ type: "move", index: 0 });
    expect(directoryKey(at(), { key: "ArrowUp" })).toEqual({ type: "move", index: 2 });
    expect(directoryKey(at({ entries: [] }), { key: "ArrowDown" })).toEqual({ type: "none" });
  });

  test("Enter descends into the highlighted row", () => {
    expect(directoryKey(at({ index: 2 }), { key: "Enter" })).toEqual({ type: "open", path: `${HOME}/code/notes` });
    expect(directoryKey(at({ entries: [] }), { key: "Enter" })).toEqual({ type: "none" });
  });

  test("Enter goes where the FIELD says once somebody has typed in it", () => {
    expect(directoryKey(at({ field: "~/code/telar" }), { key: "Enter" })).toEqual({
      type: "open",
      path: `${HOME}/code/telar`,
    });
    expect(directoryKey(at({ field: "/Volumes/Backup" }), { key: "Enter" })).toEqual({
      type: "open",
      path: "/Volumes/Backup",
    });
  });

  test("Backspace goes up — but is a text key while somebody is typing", () => {
    expect(directoryKey(at(), { key: "Backspace" })).toEqual({ type: "open", path: HOME });
    expect(directoryKey(at({ field: "~/code/tel" }), { key: "Backspace" })).toEqual({ type: "none" });
    expect(directoryKey(at({ parent: null }), { key: "Backspace" })).toEqual({ type: "none" });
  });

  test("⌘Enter takes the directory you are IN, not the row you are ON", () => {
    expect(directoryKey(at({ index: 1 }), { key: "Enter", meta: true })).toEqual({
      type: "submit",
      path: `${HOME}/code`,
    });
    // ^Enter too: a browser tab may not be on a Mac.
    expect(directoryKey(at(), { key: "Enter", ctrl: true })).toEqual({ type: "submit", path: `${HOME}/code` });
    expect(directoryKey(at({ field: "~/code/tel" }), { key: "Enter", meta: true })).toEqual({
      type: "submit",
      path: `${HOME}/code`,
    });
  });

  test("⌘. toggles dotfolders, and a bare . does not", () => {
    expect(directoryKey(at(), { key: ".", meta: true })).toEqual({ type: "hidden", hidden: true });
    expect(directoryKey(at({ hidden: true }), { key: ".", meta: true })).toEqual({ type: "hidden", hidden: false });
    expect(directoryKey(at(), { key: "." })).toEqual({ type: "none" });
  });

  test("Tab completes, and says nothing when there is nothing to complete", () => {
    expect(directoryKey(at({ field: "~/code/n" }), { key: "Tab" })).toEqual({ type: "complete", field: "~/code/notes/" });
    expect(directoryKey(at({ field: "~/code/zz" }), { key: "Tab" })).toEqual({ type: "none" });
  });

  test("an ordinary character is not this component's business", () => {
    expect(directoryKey(at(), { key: "t" })).toEqual({ type: "none" });
    expect(directoryKey(at(), { key: "Escape" })).toEqual({ type: "none" });
  });
});
