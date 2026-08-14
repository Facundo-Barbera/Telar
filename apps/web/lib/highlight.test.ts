/**
 * The highlighter, against the real Shiki.
 *
 * Not mocked, because the two things worth pinning are both facts about the
 * library rather than about our code: that `defaultColor: false` really does hand
 * back BOTH themes per token (the whole reason light/dark works without a
 * re-render), and that every refusal path returns plain text rather than throwing
 * inside a panel.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { highlight, MAX_HIGHLIGHT_BYTES } from "./highlight";

describe("highlight", () => {
  test("tokenises, and every token carries both themes", () => {
    // The dual-theme custom properties ARE the feature: globals.css switches
    // between them on `.dark`, so an open file repaints on a theme change without
    // this app tokenising it again.
    return highlight("const a: number = 1;\nconst b = a;\n", "typescript").then((lines) => {
      expect(lines).toBeDefined();
      // Three lines: two of code and the empty one after the trailing newline.
      expect(lines).toHaveLength(3);
      const first = lines![0]!;
      expect(first.map((token) => token.text).join("")).toBe("const a: number = 1;");
      for (const token of first) {
        expect(token.style["--shiki-light"], token.text).toBeDefined();
        expect(token.style["--shiki-dark"], token.text).toBeDefined();
      }
      // And the two themes genuinely differ, or one of them is not being applied.
      expect(first[0]!.style["--shiki-light"]).not.toBe(first[0]!.style["--shiki-dark"]);
    });
  });

  test("no language means no highlighting, not an error", async () => {
    // The kind table returns no `lang` for a format with no grammar worth a
    // chunk download, and the viewer draws plain text for it.
    expect(await highlight("hello", undefined)).toBeUndefined();
  });

  test("a language Shiki does not ship degrades to plain text", async () => {
    // Checked against the bundle rather than tried: an unknown id throws inside
    // the loader, and a typo in the kind table must not take the panel with it.
    expect(await highlight("hello", "not-a-real-language")).toBeUndefined();
  });

  test("a file too large to be worth tokenising is left alone", async () => {
    // Past the cap this would block the window for longer than reading it takes,
    // for content nobody scrolls to.
    const huge = "const a = 1;\n".repeat(Math.ceil(MAX_HIGHLIGHT_BYTES / 12) + 1);
    expect(huge.length).toBeGreaterThan(MAX_HIGHLIGHT_BYTES);
    expect(await highlight(huge, "typescript")).toBeUndefined();
  });
});
