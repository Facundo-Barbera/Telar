/**
 * The rule: an edit changes the lines somebody edited, and nothing else about
 * the file.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { detectNewline, withNewline } from "./line-endings";

describe("detectNewline", () => {
  test("a CRLF file is CRLF", () => {
    expect(detectNewline("alpha = 1\r\nbeta = 2\r\ngamma = 3\r\n")).toBe("\r\n");
  });

  test("an LF file is LF", () => {
    expect(detectNewline("alpha = 1\nbeta = 2\n")).toBe("\n");
  });

  test("no line breaks at all is LF, because there is nothing to convert", () => {
    expect(detectNewline("one line, no ending")).toBe("\n");
    expect(detectNewline("")).toBe("\n");
  });

  test("a majority decides a mixed file", () => {
    // The distinction is already lost by the time the text reaches the editor
    // (the textarea normalises it), so the honest choice is to leave a
    // consistent file as consistent as it was.
    expect(detectNewline("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectNewline("a\r\nb\nc\n")).toBe("\n");
  });

  test("a lone CR is not a line ending", () => {
    // Classic-Mac line endings are not CRLF and are not what this is about.
    expect(detectNewline("a\rb\rc")).toBe("\n");
  });
});

describe("withNewline", () => {
  test("LF text goes back to disk as CRLF", () => {
    // THE BUG. The textarea can only ever hand back LF, so the carriage returns
    // have to be put back on the way out or one keystroke rewrites every line.
    expect(withNewline("alpha = 1\nbeta = 2\n", "\r\n")).toBe("alpha = 1\r\nbeta = 2\r\n");
  });

  test("converting twice is converting once", () => {
    const once = withNewline("a\nb\n", "\r\n");
    expect(withNewline(once, "\r\n")).toBe(once);
    expect(once).toBe("a\r\nb\r\n");
  });

  test("an LF file is left exactly alone", () => {
    const text = "a\nb\nc";
    expect(withNewline(text, "\n")).toBe(text);
  });

  test("CRLF text asked for LF loses the carriage returns", () => {
    expect(withNewline("a\r\nb\r\n", "\n")).toBe("a\nb\n");
  });

  test("a lone CR is content, not a line ending, and survives either way", () => {
    expect(withNewline("a\rb\nc", "\r\n")).toBe("a\rb\r\nc");
    expect(withNewline("a\rb\nc", "\n")).toBe("a\rb\nc");
  });

  test("the round trip a save makes is lossless", () => {
    // Read (CRLF bytes) → textarea (LF) → write (CRLF bytes again).
    const disk = "alpha = 1\r\nbeta = 2\r\ngamma = 3\r\n";
    const shown = disk.replace(/\r\n/g, "\n");
    expect(withNewline(shown, detectNewline(disk))).toBe(disk);
  });
});
