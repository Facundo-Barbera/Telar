import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_FILE, addedLines, commentLines, commentRatchet, countFindings, newCommentRuns } from "./comment-ratchet.mjs";

const linesOf = (source, language = "js") => [...commentLines(source, language)].sort((a, b) => a - b);

describe("commentLines", () => {
  test("counts line and block comments, not code", () => {
    const source = ["const a = 1; // trailing", "", "/**", " * doc", " */", "call();", "// own line"].join("\n");
    expect(linesOf(source)).toEqual([1, 3, 4, 5, 7]);
  });

  test("ignores comment markers inside strings, templates and regexes", () => {
    const source = [
      'const url = "https://example.com";',
      "const t = `a // b ${x /* c */ ? 1 : 2} /* d */`;",
      "const r = /\\/\\/[/*]/g;",
      "const q = a / b / c;",
      "const s = 'it''s';",
    ].join("\n");
    expect(linesOf(source)).toEqual([2]);
  });

  test("a regex after return is not a comment", () => {
    expect(linesOf("function f() {\n  return /\\/*x/.test(s);\n}")).toEqual([]);
  });

  test("blank lines inside a block comment are not comment lines", () => {
    expect(linesOf("/* one\n\n   two */\nx();")).toEqual([1, 3]);
  });

  test("swift nests block comments and has no single-quoted strings", () => {
    const source = ['let s = "don\'t // no"', "/* outer /* inner */ still */", "let x = 1"].join("\n");
    expect(linesOf(source, "swift")).toEqual([2]);
    expect(linesOf('let t = """\n// inside\n"""\n// after', "swift")).toEqual([4]);
  });

  test("css has only block comments", () => {
    expect(linesOf('a { background: url("//cdn/x.png"); }\n/* note */', "css")).toEqual([2]);
  });
});

describe("addedLines", () => {
  test("reads added ranges from a zero-context diff", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,0 +2,3 @@",
      "@@ -9 +12 @@",
      "@@ -20,2 +24,0 @@",
      "diff --git a/gone.ts b/gone.ts",
      "+++ /dev/null",
    ].join("\n");
    expect([...addedLines(diff).get("x.ts")]).toEqual([2, 3, 4, 12]);
    expect(addedLines(diff).has("gone.ts")).toBe(false);
  });
});

describe("newCommentRuns", () => {
  const comments = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);

  test("flags a run of added comment lines over the limit", () => {
    expect(newCommentRuns(comments, new Set([1, 2, 3, 4, 5, 6, 7]))).toEqual([[1, 7]]);
  });

  test("allows a run at the limit, and edits inside an old block", () => {
    expect(newCommentRuns(comments, new Set([1, 2, 3, 4, 5, 6]))).toEqual([]);
    expect(newCommentRuns(comments, new Set([4]))).toEqual([]);
  });

  test("code lines and gaps break a run", () => {
    expect(newCommentRuns(comments, new Set([4, 5, 6, 7, 8, 9, 10, 11]))).toEqual([]);
  });
});

describe("countFindings", () => {
  test("fails above the baseline or without one, and notes a drop", () => {
    const { failures, notices } = countFindings({ a: 30, b: 21, c: 5, d: 9 }, { a: 30, b: 20, d: 10 });
    expect(failures).toEqual([
      "b: 21 comment lines, above its baseline of 20. Delete comments rather than raising the baseline.",
      "c: no baseline in scripts/comment-baseline.json. Run `bun run comments:baseline`.",
    ]);
    expect(notices).toEqual(["d: 9 comment lines, below its baseline of 10. Run `bun run comments:baseline` to lock that in."]);
  });
});

describe("commentRatchet", () => {
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function repo() {
    const root = mkdtempSync(join(tmpdir(), "comment-ratchet-"));
    run(root, "init", "-q", "-b", "main");
    run(root, "config", "user.email", "t@example.com");
    run(root, "config", "user.name", "t");
    mkdirSync(join(root, "apps/engine"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "apps/engine/a.ts"), "// one\nconst a = 1;\nconst b = 2;\nconst c = 3;\n");
    writeFileSync(join(root, BASELINE_FILE), JSON.stringify({ "apps/engine": 1 }));
    run(root, "add", ".");
    run(root, "commit", "-qm", "base");
    run(root, "branch", "base");
    return root;
  }

  test("passes a tree at its baseline", () => {
    expect(commentRatchet(repo(), "base")).toEqual({ failures: [], notices: [] });
  });

  test("fails a new long comment and the count it raises", () => {
    const root = repo();
    const essay = Array.from({ length: 7 }, (_, k) => `// line ${k}`).join("\n");
    writeFileSync(join(root, "apps/engine/b.ts"), `${essay}\nexport const x = 1;\n`);
    run(root, "add", ".");
    run(root, "commit", "-qm", "essay");
    const { failures } = commentRatchet(root, "base");
    expect(failures.some((f) => f.startsWith("apps/engine: 8 comment lines, above its baseline of 1"))).toBe(true);
    expect(failures).toContain("apps/engine/b.ts:1-7: a new 7-line comment. The limit is 6; AGENTS.md allows 3.");
  });

  test("deleting code alone passes, and deleting a comment is a notice", () => {
    const root = repo();
    writeFileSync(join(root, "apps/engine/a.ts"), "const a = 1;\n");
    expect(commentRatchet(root, "base").failures).toEqual([]);
    expect(commentRatchet(root, "base").notices).toEqual(["apps/engine: 0 comment lines, below its baseline of 1. Run `bun run comments:baseline` to lock that in."]);
  });

  test("names a base it cannot find instead of passing", () => {
    expect(commentRatchet(repo(), "no-such-ref").failures[0]).toContain("cannot find the merge base with no-such-ref");
  });
});
