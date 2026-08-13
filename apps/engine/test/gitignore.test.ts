/**
 * Appending Telar's rules to somebody's `.gitignore`.
 *
 * This writes into a file the user owns and did not name, so every test here is
 * about NOT DAMAGING IT: not duplicating a rule they already wrote, not welding a
 * line onto their last one, not replacing their file, and not claiming to have done
 * something when it did nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ensureTelarGitignore, TELAR_IGNORE_RULES } from "../src/gitignore";

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
    // Creating a `.gitignore` in a repository that had none is a bigger thing than
    // adding two lines to one that did, which is why `created` is its own field.
    const root = scratch();
    const result = ensureTelarGitignore(root);
    expect(result.created).toBe(true);
    expect(result.added).toEqual(ALL_RULES);
    expect(result.present).toEqual([]);
    expect(read(root)).toBe("# Telar — local state, not for sharing\ntelar.yaml\n.telar/\n.telar-worktrees/\n");
  });

  test("KEEPS what was already there — it appends, it does not rewrite", () => {
    // The failure this prevents is the worst one available: replacing a file full
    // of somebody's rules with three of ours.
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
    // `.telar/`, `.telar`, `/.telar/` and `/.telar` all ignore the same directory.
    // Without this, a `.gitignore` grows the same rule four times in four hands.
    for (const spelling of [".telar/", ".telar", "/.telar/", "/.telar"]) {
      const root = scratch(`${spelling}\ntelar.yaml\n.telar-worktrees/\n`);
      const result = ensureTelarGitignore(root);
      expect(result.added).toEqual([]);
      expect(result.present).toEqual(ALL_RULES);
      // And nothing was written: the file is byte-identical.
      expect(read(root)).toBe(`${spelling}\ntelar.yaml\n.telar-worktrees/\n`);
    }
  });

  test("pressing it twice adds nothing the second time", () => {
    // The success case that looks like a no-op, which is why `present` is reported
    // rather than an empty result.
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
    // Treating `# telar stuff` as a match would leave the repository unignored
    // while reporting success.
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
    // So a surface can say where the rules went rather than "somewhere in your repo".
    const root = scratch();
    const result = ensureTelarGitignore(root);
    expect(result.path).toBe(path.join(root, ".gitignore"));
    expect(existsSync(result.path)).toBe(true);
  });
});
