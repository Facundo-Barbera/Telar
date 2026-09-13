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
import { ensureTelarGitignore, removeTelarGitignore, TELAR_IGNORE_RULES } from "../src/gitignore";

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

/**
 * The Undo behind the toast. Registering a project now writes these rules
 * WITHOUT asking, so the way back has to be as cheap as the way in — and as
 * careful, because by the time somebody presses Undo the file may have been
 * edited by hand.
 */
describe("removeTelarGitignore", () => {
  test("a write and its undo leave the file exactly as it was found", () => {
    // The whole promise, in one assertion: nothing of the user's is lost, and no
    // blank line is left behind to accumulate over a register/undo/register cycle.
    const before = "node_modules/\ndist/\n";
    const root = scratch(before);
    ensureTelarGitignore(root);
    expect(read(root)).not.toBe(before);
    const result = removeTelarGitignore(root);
    expect(result.removed).toEqual(ALL_RULES);
    expect(read(root)).toBe(before);
  });

  test("a rule somebody wrote themselves, in their own section, survives", () => {
    // Matching rules anywhere in the file would make an undo of TELAR's write
    // delete a line Telar never wrote.
    const root = scratch("# mine\n.telar/\n\n");
    ensureTelarGitignore(root);
    const result = removeTelarGitignore(root);
    // `.telar/` was already covered, so the block never contained it…
    expect(result.removed).toEqual(["telar.yaml", ".telar-worktrees/"]);
    // …and the copy in their section is still there.
    expect(read(root)).toBe("# mine\n.telar/\n");
  });

  test("it stops at the first line that is not one of ours", () => {
    // Somebody appended their own rule under our block. It is not ours to remove,
    // and neither is anything after it.
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
    // It did not create the file it had nothing to remove from.
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
