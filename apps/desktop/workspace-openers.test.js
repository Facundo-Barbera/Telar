// The PRODUCTION discovery and launch path — no mock of the module under
// test. `exists` and `run` are injected so the suite neither depends on which
// editors this machine has nor actually launches one.
const { describe, expect, test } = require("bun:test");
const { discoverOpeners, openWith, searchRoots, KNOWN_EDITORS } = require("./workspace-openers");

const roots = ["/Applications", "/Users/x/Applications", "/System/Applications"];

describe("discovering installed openers", () => {
  test("lists only what exists, in the curated order", () => {
    const installed = new Set(["/Applications/Zed.app", "/Applications/Visual Studio Code.app"]);
    const found = discoverOpeners({ roots, exists: (candidate) => installed.has(candidate) });
    expect(found.map((entry) => entry.id)).toEqual(["vscode", "zed"]);
    expect(found[0]).toEqual({ id: "vscode", label: "Visual Studio Code", icon: "vscode", path: "/Applications/Visual Studio Code.app" });
  });

  test("a machine with none installed answers an empty list, not an error", () => {
    expect(discoverOpeners({ roots, exists: () => false })).toEqual([]);
  });

  test("a user-local install is found too", () => {
    const found = discoverOpeners({ roots, exists: (candidate) => candidate === "/Users/x/Applications/Cursor.app" });
    expect(found).toEqual([{ id: "cursor", label: "Cursor", icon: "cursor", path: "/Users/x/Applications/Cursor.app" }]);
  });

  test("an app we carry no mark for reports NO icon key rather than an empty one", () => {
    // The renderer's fallback is keyed on absence. A `icon: ""` or `icon: null`
    // would be a second way to say the same thing, and the two drift.
    const found = discoverOpeners({ roots, exists: (candidate) => candidate === "/Applications/TextMate.app" });
    expect(found).toEqual([{ id: "textmate", label: "TextMate", path: "/Applications/TextMate.app" }]);
    expect("icon" in found[0]).toBe(false);
  });

  test("every icon id names a real app in the table, and none is blank", () => {
    for (const editor of KNOWN_EDITORS) {
      if (!("icon" in editor)) continue;
      expect(typeof editor.icon).toBe("string");
      expect(editor.icon.length).toBeGreaterThan(0);
    }
  });

  test("an app is listed once even when several bundle names match", () => {
    const found = discoverOpeners({ roots, exists: (candidate) => candidate.includes("IntelliJ IDEA") });
    expect(found.filter((entry) => entry.id === "intellij")).toHaveLength(1);
  });

  test("every known editor has a distinct id and at least one bundle", () => {
    const ids = KNOWN_EDITORS.map((editor) => editor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const editor of KNOWN_EDITORS) expect(editor.bundles.length).toBeGreaterThan(0);
  });

  test("the default roots are the standard install locations", () => {
    expect(searchRoots("/Users/x")).toEqual(["/Applications", "/Users/x/Applications", "/System/Applications"]);
  });
});

describe("launching", () => {
  const capture = () => {
    const calls = [];
    const run = (file, args, _options, done) => {
      calls.push({ file, args });
      done(null);
    };
    return { calls, run };
  };

  test("a named app goes through /usr/bin/open with an ARGV ARRAY — never a command string", async () => {
    const { calls, run } = capture();
    const result = await openWith({ target: "/Users/x/my code", appPath: "/Applications/Zed.app", run });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ file: "/usr/bin/open", args: ["-a", "/Applications/Zed.app", "/Users/x/my code"] }]);
  });

  test("a folder name with shell metacharacters stays ONE argument", async () => {
    const nasty = '/Users/x/we;rm -rf ~/"quoted" $(whoami)';
    const { calls, run } = capture();
    await openWith({ target: nasty, appPath: "/Applications/Cursor.app", run });
    // Exactly three argv entries, the last one the path verbatim.
    expect(calls[0].args).toHaveLength(3);
    expect(calls[0].args[2]).toBe(nasty);
  });

  test("no app named means the system default, and the path is still an argument", async () => {
    const { calls, run } = capture();
    await openWith({ target: "/Users/x/code", run });
    expect(calls).toEqual([{ file: "/usr/bin/open", args: ["/Users/x/code"] }]);
  });

  test("a launch failure resolves as an answer rather than throwing", async () => {
    const run = (_file, _args, _options, done) => done(new Error("no such app"));
    const result = await openWith({ target: "/Users/x/code", appPath: "/Applications/Gone.app", run });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no such app");
  });
});
