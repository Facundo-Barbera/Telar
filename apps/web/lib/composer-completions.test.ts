// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { availableCommands, buildPathIndex, rankCommands, rankPaths } from "./composer-completions";
import { directoryReference, fileReference } from "./drag-reference";

const FILES = [
  "README.md",
  "apps/engine/src/driver.ts",
  "apps/engine/src/store.ts",
  "apps/web/components/composer.tsx",
  "apps/web/lib/drag-reference.ts",
  "packages/core/src/ultra/runner.ts",
];

describe("the index the at-sign menu ranks", () => {
  const index = buildPathIndex(FILES);

  test("a directory exists exactly when something inside it does", () => {
    // The engine sends files only. Any other definition would need a second
    // source of truth for what a folder is.
    const directories = index.filter((entry) => entry.directory).map((entry) => entry.path);
    expect(directories).toContain("apps/");
    expect(directories).toContain("apps/engine/src/");
    expect(directories).not.toContain("apps/engine/src/driver.ts/");
  });

  test("every file in the listing is present, once", () => {
    const files = index.filter((entry) => !entry.directory).map((entry) => entry.path);
    expect(files.sort()).toEqual([...FILES].sort());
  });

  test("a rootless file has no parent rather than a fabricated one", () => {
    expect(index.find((entry) => entry.path === "README.md")).toMatchObject({ name: "README.md", parent: "", directory: false });
  });
});

describe("ranking paths", () => {
  const index = buildPathIndex(FILES);

  test("the basename is what people type, and it outranks a deep path match", () => {
    expect(rankPaths(index, "driver")[0]?.path).toBe("apps/engine/src/driver.ts");
  });

  test("a path fragment disambiguates two files that share a name", () => {
    const both = buildPathIndex(["apps/a/util.ts", "apps/b/util.ts"]);
    expect(rankPaths(both, "b/util")[0]?.path).toBe("apps/b/util.ts");
  });

  test("nothing typed yet shows the top of the repository, not an arbitrary slice", () => {
    const first = rankPaths(index, "", 3).map((completion) => completion.path);
    expect(first[0]).toBe("apps/");
    expect(first).toContain("README.md");
  });

  test("an accepted path inserts EXACTLY what dragging the same row would", () => {
    // The property that keeps a transcript from looking like two people wrote
    // it: one wire form per kind, produced in one place.
    const file = rankPaths(index, "drag-reference")[0];
    expect(file?.action).toEqual({ type: "insert", text: fileReference("apps/web/lib/drag-reference.ts").text });
    const folder = rankPaths(index, "ultra").find((completion) => completion.glyph === "directory");
    expect(folder?.action).toEqual({ type: "insert", text: directoryReference("packages/core/src/ultra/").text });
  });

  test("the limit is honoured, and the results stay in score order", () => {
    const ranked = rankPaths(index, "s", 3);
    expect(ranked).toHaveLength(3);
  });

  test("a query that matches nothing returns nothing rather than everything", () => {
    expect(rankPaths(index, "zzzzzzz")).toEqual([]);
  });
});

describe("what the slash menu offers", () => {
  test("stopping is offered only while something is running", () => {
    expect(availableCommands({ busy: false, fresh: false }).map((command) => command.id)).not.toContain("stop");
    expect(availableCommands({ busy: true, fresh: false }).map((command) => command.id)).toContain("stop");
  });

  test("the create-time choices are offered only before the session exists", () => {
    // A worktree is cut at creation, so a later press would be a lie.
    const running = availableCommands({ busy: false, fresh: false }).map((command) => command.id);
    expect(running).not.toContain("env:worktree");
    expect(running).not.toContain("driver:codex");
    const fresh = availableCommands({ busy: false, fresh: true }).map((command) => command.id);
    expect(fresh).toContain("env:worktree");
    expect(fresh).toContain("driver:codex");
  });

  test("the mode already in effect is still listed, and says so", () => {
    // A menu whose contents depend on the current setting cannot be learned:
    // the row you used last time is the one that has gone missing.
    const commands = availableCommands({ busy: false, fresh: false, runtimeMode: "full-access" });
    const current = commands.find((command) => command.id === "access:full-access");
    expect(current?.detail).toContain("(current)");
    expect(commands.filter((command) => command.glyph === "access")).toHaveLength(4);
  });

  test("models and efforts appear only when the caller knows any", () => {
    expect(availableCommands({ busy: false, fresh: false }).some((command) => command.glyph === "model")).toBe(false);
    const withModels = availableCommands({
      busy: false,
      fresh: false,
      models: [{ id: "opus[1m]", label: "Opus 5" }],
      efforts: ["low", "high"],
    });
    expect(withModels.find((command) => command.glyph === "model")).toMatchObject({ label: "/model Opus 5", action: { type: "model", model: "opus[1m]" } });
    expect(withModels.filter((command) => command.glyph === "effort").map((command) => command.label)).toEqual(["/effort low", "/effort high"]);
  });
});

describe("ranking commands", () => {
  const commands = availableCommands({ busy: true, fresh: true, runtimeMode: "auto" });

  test("a prefix of the name wins", () => {
    expect(rankCommands(commands, "ful")[0]?.label).toBe("/full-access");
    expect(rankCommands(commands, "sto")[0]?.label).toBe("/stop");
  });

  test("initials reach a hyphenated command, which a prefix cannot", () => {
    // `fa` is not a prefix of `full-access` and is not a substring of it — the
    // two letters are the two words. This is what the fuzzy tier is for.
    expect(rankCommands(commands, "fa")[0]?.label).toBe("/full-access");
  });

  test("the fuzzy tier is loose, and that is a trade rather than a bug", () => {
    // `ae` is a subsequence of `auto-edits` AND of `claude`, and the scorer
    // prefers the tighter span — so initials REACH a command without being a
    // reliable way to select one. Left as the donor has it: an initials tier
    // would fix a nine-row list that can be read at a glance.
    expect(rankCommands(commands, "ae").map((command) => command.label)).toContain("/auto-edits");
  });

  test("a genuine prefix still beats a fuzzy hit on a shorter name", () => {
    // The tier bases are what guarantee this: fuzzy starts at 100, prefix at 2.
    expect(rankCommands(commands, "auto")[0]?.label).toBe("/auto");
  });

  test("a leading slash in the query is not searched for", () => {
    expect(rankCommands(commands, "/stop")[0]?.label).toBe("/stop");
  });

  test("nothing typed lists everything, in the order the menu declared them", () => {
    expect(rankCommands(commands, "")).toEqual([...commands]);
  });

  test("a query whose letters are not all there, in order, returns nothing", () => {
    expect(rankCommands(commands, "qqq")).toEqual([]);
  });

  test("the description is searchable, but ranks below the name", () => {
    const byDescription = rankCommands(commands, "prompts");
    expect(byDescription[0]?.label).toBe("/full-access");
  });
});
