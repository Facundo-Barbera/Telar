import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedLines, commentLines, commentRatchet, countFailures, newCommentRuns } from "./comment-ratchet.mjs";

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

describe("countFailures", () => {
  test("fails only a rise over the merge base", () => {
    expect(countFailures({ a: 30, b: 21, c: 5, d: 8 }, { a: 30, b: 20, d: 9 })).toEqual([
      "b: this change adds 1 comment lines (20 → 21). Delete comments rather than adding them.",
      "c: this change adds 5 comment lines (0 → 5). Delete comments rather than adding them.",
    ]);
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
    run(root, "add", ".");
    run(root, "commit", "-qm", "base");
    run(root, "branch", "base");
    return root;
  }

  test("passes an unchanged tree", () => {
    expect(commentRatchet(repo(), "base")).toEqual([]);
  });

  test("fails a new long comment and the count it raises", () => {
    const root = repo();
    const essay = Array.from({ length: 7 }, (_, k) => `// line ${k}`).join("\n");
    writeFileSync(join(root, "apps/engine/b.ts"), `${essay}\nexport const x = 1;\n`);
    run(root, "add", ".");
    run(root, "commit", "-qm", "essay");
    const failures = commentRatchet(root, "base");
    expect(failures).toContain("apps/engine: this change adds 7 comment lines (1 → 8). Delete comments rather than adding them.");
    expect(failures).toContain("apps/engine/b.ts:1-7: a new 7-line comment. The limit is 6; AGENTS.md allows 3.");
  });

  test("moving a file carries its comments without counting them as new", () => {
    const root = repo();
    const essay = Array.from({ length: 7 }, (_, k) => `// line ${k}`).join("\n");
    writeFileSync(join(root, "apps/engine/old.ts"), `${essay}\nexport const x = 1;\n`);
    run(root, "add", ".");
    run(root, "commit", "-qm", "essay");
    run(root, "branch", "-f", "base");
    mkdirSync(join(root, "apps/engine/src"));
    run(root, "mv", "apps/engine/old.ts", "apps/engine/src/new.ts");
    run(root, "commit", "-qm", "move");
    expect(commentRatchet(root, "base")).toEqual([]);
  });

  test("deleting code and comments passes", () => {
    const root = repo();
    writeFileSync(join(root, "apps/engine/a.ts"), "const a = 1;\n");
    expect(commentRatchet(root, "base")).toEqual([]);
  });

  test("one added comment line fails", () => {
    const root = repo();
    writeFileSync(join(root, "apps/engine/a.ts"), "// one\n// two\nconst a = 1;\n");
    run(root, "commit", "-qam", "more");
    expect(commentRatchet(root, "base")).toEqual(["apps/engine: this change adds 1 comment lines (1 → 2). Delete comments rather than adding them."]);
  });

  test("comments main added since the branch point do not fail a change that adds none", () => {
    const root = repo();
    run(root, "checkout", "-qb", "main-moved");
    writeFileSync(join(root, "apps/engine/c.ts"), "// main's own\nexport const c = 1;\n");
    run(root, "add", ".");
    run(root, "commit", "-qm", "main moved");
    writeFileSync(join(root, "apps/engine/a.ts"), "// one\nconst a = 1;\n");
    run(root, "commit", "-qam", "pr: code only");
    expect(commentRatchet(root, "main-moved~1")).toEqual([]);
  });

  test("names a base it cannot find instead of passing", () => {
    expect(commentRatchet(repo(), "no-such-ref")[0]).toContain("cannot find the merge base with no-such-ref");
  });
});
