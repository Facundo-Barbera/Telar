import { describe, expect, test } from "bun:test";
import { onlyCommentsChanged } from "./comment-token-check";

describe("onlyCommentsChanged", () => {
  const before = [
    "/** Explains f. */",
    "export function f(a: number) {",
    "  // inline note",
    "  const url = `https://x.test/${a} // not a comment`;",
    "  return /\\/\\/+/.test(url) ? a : 0; /* trailing */",
    "}",
  ].join("\n");

  test("accepts removing every comment", () => {
    const after = "export function f(a: number) {\n  const url = `https://x.test/${a} // not a comment`;\n  return /\\/\\/+/.test(url) ? a : 0;\n}\n";
    expect(onlyCommentsChanged("a.ts", before, after)).toBe(true);
  });

  test("rejects a change inside a template that looks like a comment", () => {
    expect(onlyCommentsChanged("a.ts", before, before.replace("// not a comment", ""))).toBe(false);
  });

  test("rejects a code change", () => {
    expect(onlyCommentsChanged("a.ts", before, before.replace("? a : 0", "? 0 : a"))).toBe(false);
  });

  test("reads JSX comments in tsx", () => {
    const tsx = "export const A = () => (\n  <div>\n    {/* note */}\n    hi\n  </div>\n);\n";
    expect(onlyCommentsChanged("a.tsx", tsx, tsx.replace("{/* note */}", "{}"))).toBe(true);
    expect(onlyCommentsChanged("a.tsx", tsx, tsx.replace("hi", "ho"))).toBe(false);
  });
});
