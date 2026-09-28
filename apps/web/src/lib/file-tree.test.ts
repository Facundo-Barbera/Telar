// Uses paths from this repository: single-child collapse exists for `packages/core/src/loom/...`.
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { ancestorsOf, buildFileTree, directoryPaths, flattenTree, matchFiles, MAX_SEARCH_MATCHES } from "./file-tree";

const shape = (paths: string[], expanded: string[] = []) =>
  flattenTree(buildFileTree(paths), new Set(expanded)).map((row) => `${row.depth}:${row.node.name}`);

describe("buildFileTree", () => {
  test("groups by directory and returns the root's children, not a root row", () => {
    // The panel header already names the workspace.
    const tree = buildFileTree(["README.md", "apps/engine/src/git.ts", "apps/engine/src/files.ts"]);
    expect(tree.map((node) => node.name)).toEqual(["apps/engine/src", "README.md"]);
  });

  test("directories come before files, and case does not sort into its own block", () => {
    // A codepoint sort would put every capitalised name above every lowercase one.
    expect(shape(["package.json", "README.md", "zeta.ts", "Alpha.ts", "src/a.ts"], ["src"])).toEqual([
      "0:src",
      "1:a.ts",
      "0:Alpha.ts",
      "0:package.json",
      "0:README.md",
      "0:zeta.ts",
    ]);
  });

  test("numbers sort naturally, so step-2 comes before step-10", () => {
    expect(shape(["step-10.ts", "step-2.ts"])).toEqual(["0:step-2.ts", "0:step-10.ts"]);
  });
});

describe("single-child collapse", () => {
  test("a chain of directories with one child each becomes one row", () => {
    const tree = buildFileTree(["packages/core/src/loom/steps/run.ts", "packages/core/src/loom/steps/plan.ts"]);
    expect(tree.map((node) => node.name)).toEqual(["packages/core/src/loom/steps"]);
    // The path stays real: expansion state and git status are keyed on it.
    expect(tree[0]!.path).toBe("packages/core/src/loom/steps");
  });

  test("a directory with two children does not collapse", () => {
    expect(buildFileTree(["apps/engine/a.ts", "apps/web/b.ts"]).map((node) => node.name)).toEqual(["apps"]);
  });

  test("a directory holding one directory AND a file does not collapse", () => {
    const tree = buildFileTree(["apps/README.md", "apps/engine/a.ts"]);
    expect(tree.map((node) => node.name)).toEqual(["apps"]);
    expect(tree[0]!.kind === "directory" && tree[0]!.children.map((child) => child.name)).toEqual(["engine", "README.md"]);
  });
});

describe("flattenTree", () => {
  test("only expanded directories contribute their children", () => {
    const paths = ["apps/engine/a.ts", "docs/b.md"];
    expect(shape(paths)).toEqual(["0:apps/engine", "0:docs"]);
    expect(shape(paths, ["docs"])).toEqual(["0:apps/engine", "0:docs", "1:b.md"]);
  });

  test("depth is the nesting depth, so a collapsed chain does not indent six times", () => {
    const rows = flattenTree(buildFileTree(["a/b/c/d.ts"]), new Set(["a/b/c"]));
    expect(rows.map((row) => [row.depth, row.node.name])).toEqual([
      [0, "a/b/c"],
      [1, "d.ts"],
    ]);
  });
});

describe("matchFiles", () => {
  test("matches the whole path, so a directory name brings back its contents", () => {
    const paths = ["apps/engine/src/git.ts", "apps/web/src/lib/format.ts", "README.md"];
    expect(matchFiles(paths, "engine").files).toEqual(["apps/engine/src/git.ts"]);
    expect(matchFiles(paths, "format").files).toEqual(["apps/web/src/lib/format.ts"]);
  });

  test("case-insensitive, and a regex metacharacter is just a character", () => {
    expect(matchFiles(["src/Auth.ts"], "auth").files).toEqual(["src/Auth.ts"]);
    expect(matchFiles(["src/fn(1).ts", "src/a.ts"], "(1)").files).toEqual(["src/fn(1).ts"]);
  });

  test("an empty query keeps everything and is not a match count of zero", () => {
    const paths = ["a.ts", "b.ts"];
    expect(matchFiles(paths, "   ")).toEqual({ files: paths, matches: 2, truncated: false });
  });

  test("capped, with the real total, so the surface can say what it dropped", () => {
    const many = Array.from({ length: MAX_SEARCH_MATCHES + 25 }, (_unused, index) => `src/f${index}.ts`);
    const result = matchFiles(many, "src");
    expect(result.files).toHaveLength(MAX_SEARCH_MATCHES);
    expect(result).toMatchObject({ matches: MAX_SEARCH_MATCHES + 25, truncated: true });
  });
});

describe("directoryPaths and ancestorsOf", () => {
  test("every directory in the tree, which is what a search expands", () => {
    expect(directoryPaths(buildFileTree(["a/b.ts", "a/c/d.ts", "e.ts"]))).toEqual(["a", "a/c"]);
  });

  test("a changed file marks every directory above it", () => {
    expect([...ancestorsOf(["apps/engine/src/git.ts", "README.md"])]).toEqual(["apps", "apps/engine", "apps/engine/src"]);
  });

  test("a path with no directory contributes nothing", () => {
    expect([...ancestorsOf(["README.md"])]).toEqual([]);
  });
});
