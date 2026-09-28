import { describe, expect, test } from "bun:test";
import { functionSpans, limitFailures, lineCount, MAX_FILE_LINES, MAX_FUNCTION_LINES } from "./size-limits.mjs";

const lines = (n) => Array.from({ length: n }, (_, k) => `const v${k} = ${k};`).join("\n") + "\n";
const fn = (name, bodyLines) => `export function ${name}() {\n${Array.from({ length: bodyLines }, (_, k) => `  call(${k});`).join("\n")}\n}\n`;

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

describe("limitFailures", () => {
  test("a file over the limit fails, one at the limit passes", () => {
    expect(limitFailures([{ file: "a.ts", text: lines(MAX_FILE_LINES) }], {})).toEqual([]);
    expect(limitFailures([{ file: "a.ts", text: lines(MAX_FILE_LINES + 1) }], {})).toEqual([`a.ts: ${MAX_FILE_LINES + 1} lines; the limit is ${MAX_FILE_LINES}. Split it.`]);
  });

  test("a function over the limit fails wherever it is, old or new", () => {
    expect(limitFailures([{ file: "a.ts", text: fn("ok", MAX_FUNCTION_LINES - 2) }], {})).toEqual([]);
    expect(limitFailures([{ file: "a.ts", text: fn("big", MAX_FUNCTION_LINES - 1) }], {})).toEqual([
      `a.ts:1: big is ${MAX_FUNCTION_LINES + 1} lines; the limit is ${MAX_FUNCTION_LINES}. Split it.`,
    ]);
  });

  test("a test file's callbacks are exempt from the function limit, not from the file limit", () => {
    const longCallback = `test("x", () => {\n${"  expect(1).toBe(1);\n".repeat(MAX_FUNCTION_LINES)}});\n`;
    expect(limitFailures([{ file: "a.test.ts", text: longCallback }], {})).toEqual([]);
    expect(limitFailures([{ file: "b.electron-test.js", text: longCallback }], {})).toEqual([]);
    expect(limitFailures([{ file: "a.test.ts", text: lines(MAX_FILE_LINES + 1) }], {})).toHaveLength(1);
  });

  test("an allowed file may be over the limits, and fails once it fits so it leaves the list", () => {
    const allowed = { "big.ts": "why" };
    expect(limitFailures([{ file: "big.ts", text: lines(MAX_FILE_LINES + 1) }], allowed)).toEqual([]);
    expect(limitFailures([{ file: "big.ts", text: fn("long", MAX_FUNCTION_LINES) }], allowed)).toEqual([]);
    expect(limitFailures([{ file: "big.ts", text: lines(10) }], allowed)).toEqual([
      "big.ts: now within the limits; remove it from ALLOWED in scripts/size-limits.mjs.",
    ]);
  });

  test("an allowed file that no longer exists fails", () => {
    expect(limitFailures([], { "gone.ts": "why" })).toEqual(["gone.ts: listed in ALLOWED but not tracked; remove it."]);
  });
});
