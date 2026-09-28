import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ensureTelarGitignore, removeTelarGitignore, TELAR_IGNORE_RULES } from "./gitignore";

const roots: string[] = [];
function scratch(contents?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "telar-ignore-"));
  roots.push(root);
  if (contents !== undefined) writeFileSync(path.join(root, ".gitignore"), contents);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const read = (root: string) => readFileSync(path.join(root, ".gitignore"), "utf8");
const ALL_RULES = TELAR_IGNORE_RULES.map((entry) => entry.rule);

describe("ensureTelarGitignore", () => {
  test("creates the file when there is none, and says that it did", () => {
    const root = scratch();
    const result = ensureTelarGitignore(root);
    expect(result.created).toBe(true);
    expect(result.added).toEqual(ALL_RULES);
    expect(result.present).toEqual([]);
    expect(read(root)).toBe("# Telar — local state, not for sharing\ntelar.yaml\n.telar/\n.telar-worktrees/\n");
  });

  test("KEEPS what was already there — it appends, it does not rewrite", () => {
    const root = scratch("node_modules/\ndist/\n");
    ensureTelarGitignore(root);
    const contents = read(root);
    expect(contents.startsWith("node_modules/\ndist/\n")).toBe(true);
    expect(contents).toContain(".telar/");
  });

  test("a file with no trailing newline does not get a rule welded onto its last line", () => {
    const root = scratch("dist/");
    ensureTelarGitignore(root);
    expect(read(root).split("\n")).toContain("dist/");
    expect(read(root)).not.toContain("dist/#");
  });

  test("every spelling of a rule already counts as that rule", () => {
    for (const spelling of [".telar/", ".telar", "/.telar/", "/.telar"]) {
      const root = scratch(`${spelling}\ntelar.yaml\n.telar-worktrees/\n`);
      const result = ensureTelarGitignore(root);
      expect(result.added).toEqual([]);
      expect(result.present).toEqual(ALL_RULES);
      expect(read(root)).toBe(`${spelling}\ntelar.yaml\n.telar-worktrees/\n`);
    }
  });

  test("pressing it twice adds nothing the second time", () => {
    const root = scratch();
    ensureTelarGitignore(root);
    const before = read(root);
    const again = ensureTelarGitignore(root);
    expect(again.added).toEqual([]);
    expect(again.present).toEqual(ALL_RULES);
    expect(again.created).toBe(false);
    expect(read(root)).toBe(before);
  });

  test("a COMMENT mentioning Telar is not a rule", () => {
    const root = scratch("# telar.yaml lives here\n# .telar/\n");
    expect(ensureTelarGitignore(root).added).toEqual(ALL_RULES);
  });

  test("only what is missing is added", () => {
    const root = scratch("telar.yaml\n");
    const result = ensureTelarGitignore(root);
    expect(result.present).toEqual(["telar.yaml"]);
    expect(result.added).toEqual([".telar/", ".telar-worktrees/"]);
  });

  test("the answer names the file it touched", () => {
    const root = scratch();
    const result = ensureTelarGitignore(root);
    expect(result.path).toBe(path.join(root, ".gitignore"));
    expect(existsSync(result.path)).toBe(true);
  });
});

describe("removeTelarGitignore", () => {
  test("a write and its undo leave the file exactly as it was found", () => {
    const before = "node_modules/\ndist/\n";
    const root = scratch(before);
    ensureTelarGitignore(root);
    expect(read(root)).not.toBe(before);
    const result = removeTelarGitignore(root);
    expect(result.removed).toEqual(ALL_RULES);
    expect(read(root)).toBe(before);
  });

  test("a rule somebody wrote themselves, in their own section, survives", () => {
    const root = scratch("# mine\n.telar/\n\n");
    ensureTelarGitignore(root);
    const result = removeTelarGitignore(root);
    expect(result.removed).toEqual(["telar.yaml", ".telar-worktrees/"]);
    expect(read(root)).toBe("# mine\n.telar/\n");
  });

  test("it stops at the first line that is not one of ours", () => {
    const root = scratch();
    ensureTelarGitignore(root);
    writeFileSync(path.join(root, ".gitignore"), `${read(root)}secrets.env\n`);
    expect(removeTelarGitignore(root).removed).toEqual(ALL_RULES);
    expect(read(root)).toBe("secrets.env\n");
  });

  test("no header, or no file at all, is an answer rather than a failure", () => {
    const untouched = scratch("dist/\n");
    expect(removeTelarGitignore(untouched).removed).toEqual([]);
    expect(read(untouched)).toBe("dist/\n");

    const empty = scratch();
    const result = removeTelarGitignore(empty);
    expect(result.removed).toEqual([]);
    expect(result.path).toBe(path.join(empty, ".gitignore"));
    expect(existsSync(result.path)).toBe(false);
  });

  test("undoing twice is not an error and removes nothing the second time", () => {
    const root = scratch("dist/\n");
    ensureTelarGitignore(root);
    removeTelarGitignore(root);
    expect(removeTelarGitignore(root).removed).toEqual([]);
    expect(read(root)).toBe("dist/\n");
  });
});
