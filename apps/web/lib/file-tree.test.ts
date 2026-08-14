/**
 * The tree's shape, sort, collapse and search — every decision the engine
 * deliberately does not make.
 *
 * Pinned against paths from THIS repository, because the reason single-child
 * collapse exists is `packages/core/src/loom/...` and a fixture of `a/b/c` does
 * not show whether it earns its keep.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { ancestorsOf, buildFileTree, directoryPaths, flattenTree, matchFiles, MAX_SEARCH_MATCHES } from "./file-tree";

/** The rendered shape, as `depth:label` — the only thing a reader of these tests
 *  actually cares about. */
const shape = (paths: string[], expanded: string[] = []) =>
  flattenTree(buildFileTree(paths), new Set(expanded)).map((row) => `${row.depth}:${row.node.name}`);

describe("buildFileTree", () => {
  test("groups by directory and returns the root's children, not a root row", () => {
    // A row naming the workspace would be one click of overhead on every visit,
    // and the panel header already names it.
    const tree = buildFileTree(["README.md", "apps/engine/src/git.ts", "apps/engine/src/files.ts"]);
    expect(tree.map((node) => node.name)).toEqual(["apps/engine/src", "README.md"]);
  });

  test("directories come before files, and case does not sort into its own block", () => {
    // A codepoint sort puts every capitalised name above every lowercase one, so
    // `README.md` ends up nowhere near `package.json`.
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
    // The reason this exists: six rows and six clicks to reach the one directory
    // that has anything in it.
    const tree = buildFileTree(["packages/core/src/loom/steps/run.ts", "packages/core/src/loom/steps/plan.ts"]);
    expect(tree.map((node) => node.name)).toEqual(["packages/core/src/loom/steps"]);
    // The PATH stays real — it is what the expansion state and the git status
    // lookup are keyed on.
    expect(tree[0]!.path).toBe("packages/core/src/loom/steps");
  });

  test("a directory with two children does not collapse", () => {
    expect(buildFileTree(["apps/engine/a.ts", "apps/web/b.ts"]).map((node) => node.name)).toEqual(["apps"]);
  });

  test("a directory holding one directory AND a file does not collapse", () => {
    // The file would become unreachable, which is the bug this guards.
    const tree = buildFileTree(["apps/README.md", "apps/engine/a.ts"]);
    expect(tree.map((node) => node.name)).toEqual(["apps"]);
    expect(tree[0]!.kind === "directory" && tree[0]!.children.map((child) => child.name)).toEqual(["engine", "README.md"]);
  });
});

describe("flattenTree", () => {
  test("only expanded directories contribute their children", () => {
    // One level open is the default, which for a rootless tree means: nothing
    // expanded, top-level rows visible.
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
    // Typing `engine` should find `apps/engine/**`, which matching on filenames
    // alone would not.
    const paths = ["apps/engine/src/git.ts", "apps/web/lib/format.ts", "README.md"];
    expect(matchFiles(paths, "engine").files).toEqual(["apps/engine/src/git.ts"]);
    expect(matchFiles(paths, "format").files).toEqual(["apps/web/lib/format.ts"]);
  });

  test("case-insensitive, and a regex metacharacter is just a character", () => {
    // Somebody typing `(` is looking for a file with a bracket in its name, not
    // asking for an error state.
    expect(matchFiles(["src/Auth.ts"], "auth").files).toEqual(["src/Auth.ts"]);
    expect(matchFiles(["src/fn(1).ts", "src/a.ts"], "(1)").files).toEqual(["src/fn(1).ts"]);
  });

  test("an empty query keeps everything and is not a match count of zero", () => {
    const paths = ["a.ts", "b.ts"];
    expect(matchFiles(paths, "   ")).toEqual({ files: paths, matches: 2, truncated: false });
  });

  test("capped, with the real total, so the surface can say what it dropped", () => {
    // A silently truncated search reads as "there are only 400 of these".
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
    // So a collapsed `apps/` can still say something inside it is dirty.
    expect([...ancestorsOf(["apps/engine/src/git.ts", "README.md"])]).toEqual(["apps", "apps/engine", "apps/engine/src"]);
  });

  test("a path with no directory contributes nothing", () => {
    expect([...ancestorsOf(["README.md"])]).toEqual([]);
  });
});
