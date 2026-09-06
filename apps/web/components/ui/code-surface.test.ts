/**
 * The fold and the copy are the two promises this surface makes: the fold
 * never loses a line, and copy always has all of them. Asserted on the pure
 * helper and, for the component, on the source — this app has no DOM harness,
 * and "copy receives the whole text" is decidable by reading the file.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_SURFACE_LINES, foldLines } from "./code-surface";

const dir = fileURLToPath(new URL(".", import.meta.url));
const source = fs.readFileSync(path.join(dir, "code-surface.tsx"), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");

describe("foldLines", () => {
  test("short output is untouched and counts its lines", () => {
    expect(foldLines("a\nb")).toEqual({ shown: "a\nb", hidden: 0, total: 2 });
    expect(foldLines("")).toEqual({ shown: "", hidden: 0, total: 1 });
  });

  test("exactly the limit is not folded; one more is", () => {
    const at = Array.from({ length: CODE_SURFACE_LINES }, (_, i) => `l${i}`).join("\n");
    expect(foldLines(at).hidden).toBe(0);
    const over = `${at}\nextra`;
    const folded = foldLines(over);
    expect(folded.hidden).toBe(1);
    expect(folded.total).toBe(CODE_SURFACE_LINES + 1);
    expect(folded.shown.split("\n")).toHaveLength(CODE_SURFACE_LINES);
    expect(folded.shown.endsWith("extra")).toBe(false);
  });

  test("CRLF output keeps its bytes — only \\n splits", () => {
    const text = Array.from({ length: 30 }, (_, i) => `r${i}\r`).join("\n");
    expect(foldLines(text).shown).toContain("\r");
  });
});

describe("CodeSurface source pins", () => {
  test("the copy button receives the whole text, never the folded slice", () => {
    expect(source).toContain("<CopyButton text={text}");
    expect(source).not.toContain("<CopyButton text={folded");
  });

  test("copy is a real button with a label — not a hover-only reveal", () => {
    expect(source).toContain("aria-label={COPY_LABEL[state]}");
    expect(source).not.toMatch(/group-hover\/code:(opacity|visible|flex)/);
  });

  test("a refused clipboard is shown, and the feedback timer dies with the button", () => {
    expect(source).toContain('failed: "Copy failed"');
    expect(source).toContain('() => settle("failed")');
    expect(source).toContain("useEffect(() => () => window.clearTimeout(timer.current), [])");
  });

  test("the fold toggle names both directions and its state", () => {
    expect(source).toContain("aria-expanded={expanded}");
    expect(source).toContain('"Show less"');
    expect(source).toContain("`Show all · ${folded.total} lines`");
  });

  test("source does not wrap unless asked; the frame has no fixed height", () => {
    expect(source).toContain('wrap && "break-words whitespace-pre-wrap"');
    expect(source).not.toMatch(/max-h-\d/);
  });
});
