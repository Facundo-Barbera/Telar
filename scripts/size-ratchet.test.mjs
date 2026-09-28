import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { functionSpans, lineCount, sizeRatchet } from "./size-ratchet.mjs";

const lines = (n, make = (k) => `const v${k} = ${k};`) => Array.from({ length: n }, (_, k) => make(k)).join("\n") + "\n";
const fn = (name, bodyLines) => `export function ${name}() {\n${lines(bodyLines, (k) => `  call(${k});`)}}\n`;

describe("functionSpans", () => {
  test("names declarations, arrows, methods and callbacks by their call site", () => {
    const source = [
      "function outer() {",
      "  const inner = () => 1;",
      "}",
      "class Box { open() { return 1; } }",
      "const obj = { run: function () { return 2; } };",
      'test("adds", () => 3);',
      "[].map((x) => x);",
    ].join("\n");
    expect(functionSpans("a.ts", source).map((span) => span.name)).toEqual(["outer", "inner", "open", "run", 'test("adds") callback', "[].map callback"]);
  });

  test("measures a span from its first to its last line", () => {
    expect(functionSpans("a.tsx", fn("f", 3))).toEqual([{ name: "f", first: 1, last: 5 }]);
  });

  test("counts lines without the trailing newline", () => {
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
});

describe("sizeRatchet", () => {
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

  function repo(files) {
    const root = mkdtempSync(join(tmpdir(), "size-ratchet-"));
    run(root, "init", "-q", "-b", "main");
    run(root, "config", "user.email", "t@example.com");
    run(root, "config", "user.name", "t");
    mkdirSync(join(root, "apps/engine"), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    run(root, "add", ".");
    run(root, "commit", "-qm", "base");
    run(root, "branch", "base");
    return root;
  }
  const commit = (root, file, text) => {
    writeFileSync(join(root, file), text);
    run(root, "add", ".");
    run(root, "commit", "-qm", "change");
  };

  test("a new file over the limit fails", () => {
    const root = repo({ "apps/engine/a.ts": "export const a = 1;\n" });
    commit(root, "apps/engine/big.ts", lines(801));
    expect(sizeRatchet(root, "base")).toEqual(["apps/engine/big.ts: 801 lines; the limit is 800. Split it."]);
  });

  test("an oversized file may shrink or stay, but not grow", () => {
    const root = repo({ "apps/engine/big.ts": lines(900) });
    commit(root, "apps/engine/big.ts", lines(890));
    expect(sizeRatchet(root, "base")).toEqual([]);
    commit(root, "apps/engine/big.ts", lines(901));
    expect(sizeRatchet(root, "base")).toEqual(["apps/engine/big.ts: grew from 900 to 901 lines, over the 800-line limit. Extract what you changed instead of adding to it."]);
  });

  test("a new function over the limit fails; one at the limit passes", () => {
    const root = repo({ "apps/engine/a.ts": "export const a = 1;\n" });
    commit(root, "apps/engine/f.ts", fn("ok", 148) + fn("long", 149));
    expect(sizeRatchet(root, "base")).toEqual(["apps/engine/f.ts:151: long is 151 lines; the limit is 150. Split it."]);
  });

  test("an untouched long function passes; a long one that grows fails, one that shrinks passes", () => {
    const root = repo({ "apps/engine/f.ts": fn("long", 200) + fn("small", 2) });
    commit(root, "apps/engine/f.ts", fn("long", 200) + fn("small", 3));
    expect(sizeRatchet(root, "base")).toEqual([]);
    commit(root, "apps/engine/f.ts", fn("long", 190) + fn("small", 3));
    expect(sizeRatchet(root, "base")).toEqual([]);
    commit(root, "apps/engine/f.ts", fn("long", 201) + fn("small", 3));
    expect(sizeRatchet(root, "base")).toEqual(["apps/engine/f.ts:1: long grew from 202 to 203 lines, over the 150-line limit. Extract what you changed."]);
  });

  test("a new callback above a long one does not make the long one look new", () => {
    const long = `export const serve = () => handle(async () => {\n${lines(200, (k) => `  call(${k});`)}});\n`;
    const root = repo({ "apps/engine/f.ts": long });
    commit(root, "apps/engine/f.ts", `list.map(() => 1);\n${long}`);
    expect(sizeRatchet(root, "base")).toEqual([]);
  });

  test("a moved file keeps its size history", () => {
    const root = repo({ "apps/engine/big.ts": lines(900) });
    mkdirSync(join(root, "apps/engine/src"));
    renameSync(join(root, "apps/engine/big.ts"), join(root, "apps/engine/src/big.ts"));
    run(root, "add", "-A");
    run(root, "commit", "-qm", "move");
    expect(sizeRatchet(root, "base")).toEqual([]);
  });

  test("main's own growth since the branch point does not fail a change", () => {
    const root = repo({ "apps/engine/a.ts": "export const a = 1;\n" });
    run(root, "checkout", "-qb", "main-moved");
    commit(root, "apps/engine/big.ts", lines(900));
    commit(root, "apps/engine/a.ts", "export const a = 2;\n");
    expect(sizeRatchet(root, "main-moved~1")).toEqual([]);
  });

  test("names a base it cannot find instead of passing", () => {
    expect(sizeRatchet(repo({ "apps/engine/a.ts": "" }), "no-such-ref")[0]).toContain("cannot find the merge base with no-such-ref");
  });
});
