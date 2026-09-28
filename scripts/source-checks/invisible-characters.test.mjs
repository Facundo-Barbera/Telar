import { expect, test } from "bun:test";
import { invisibleCharacters } from "./invisible-characters.mjs";

test("a built NUL is found and named, with its line", () => {
  const source = `const a = 1;\nconst key = "a${String.fromCharCode(0)}b";\n`;
  expect(invisibleCharacters(source, "x.ts")).toEqual(["x.ts:2 — U+0000 NUL"]);
});

test("tab, newline and carriage return are the formatter's, not offenders", () => {
  expect(invisibleCharacters("a\tb\r\nc\n", "x.ts")).toEqual([]);
});
