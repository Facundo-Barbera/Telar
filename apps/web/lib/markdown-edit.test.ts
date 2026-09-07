/**
 * The markdown toolbar's arithmetic. Every case is a (text, selection, button)
 * triple, which is the whole surface — the component only ferries these values
 * to and from a textarea.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { applyMarkdownEdit } from "./markdown-edit";

describe("inline wraps", () => {
  test("wraps a selection and keeps it selected — the second press finds it", () => {
    const first = applyMarkdownEdit("make this bold", 5, 9, "bold");
    expect(first.text).toBe("make **this** bold");
    expect(first.text.slice(first.selectionStart, first.selectionEnd)).toBe("this");
    // The toggle: same selection, same button, original text back.
    const second = applyMarkdownEdit(first.text, first.selectionStart, first.selectionEnd, "bold");
    expect(second.text).toBe("make this bold");
  });

  test("unwraps when the markers are inside the selection too", () => {
    const edit = applyMarkdownEdit("a **bold** word", 2, 10, "bold");
    expect(edit.text).toBe("a bold word");
    expect(edit.text.slice(edit.selectionStart, edit.selectionEnd)).toBe("bold");
  });

  test("an empty selection inserts a placeholder, selected so typing replaces it", () => {
    const edit = applyMarkdownEdit("start ", 6, 6, "italic");
    expect(edit.text).toBe("start _italic text_");
    expect(edit.text.slice(edit.selectionStart, edit.selectionEnd)).toBe("italic text");
  });

  test("code and strike carry their own markers", () => {
    expect(applyMarkdownEdit("run ls now", 4, 6, "code").text).toBe("run `ls` now");
    expect(applyMarkdownEdit("old plan", 0, 3, "strike").text).toBe("~~old~~ plan");
  });
});

describe("line operations", () => {
  test("a caret means the whole line it sits in", () => {
    const edit = applyMarkdownEdit("first line\nsecond line", 13, 13, "bullet");
    expect(edit.text).toBe("first line\n- second line");
  });

  test("a multi-line selection prefixes every line, and toggles back off", () => {
    const on = applyMarkdownEdit("a\nb\nc", 0, 5, "quote");
    expect(on.text).toBe("> a\n> b\n> c");
    const off = applyMarkdownEdit(on.text, on.selectionStart, on.selectionEnd, "quote");
    expect(off.text).toBe("a\nb\nc");
  });

  test("a mixed block becomes uniform rather than half-stripped", () => {
    const edit = applyMarkdownEdit("- done\ntodo", 0, 11, "bullet");
    expect(edit.text).toBe("- - done\n- todo");
  });

  test("heading replaces an existing level instead of stacking", () => {
    expect(applyMarkdownEdit("# Title", 0, 7, "heading").text).toBe("## Title");
    expect(applyMarkdownEdit("plain", 0, 5, "heading").text).toBe("## plain");
    // And toggles off from its own level.
    expect(applyMarkdownEdit("## Title", 0, 8, "heading").text).toBe("Title");
  });

  test("blank lines inside the selection are left alone", () => {
    const edit = applyMarkdownEdit("a\n\nb", 0, 4, "bullet");
    expect(edit.text).toBe("- a\n\n- b");
  });
});

describe("link", () => {
  test("a selection becomes the label and the url is what stays selected", () => {
    const edit = applyMarkdownEdit("see the docs here", 8, 12, "link");
    expect(edit.text).toBe("see the [docs](url) here");
    expect(edit.text.slice(edit.selectionStart, edit.selectionEnd)).toBe("url");
  });

  test("no selection gets a placeholder label", () => {
    const edit = applyMarkdownEdit("", 0, 0, "link");
    expect(edit.text).toBe("[link text](url)");
    expect(edit.text.slice(edit.selectionStart, edit.selectionEnd)).toBe("url");
  });
});

describe("selection clamping", () => {
  test("out-of-range selections are clamped rather than thrown on", () => {
    const edit = applyMarkdownEdit("ab", 1, 99, "bold");
    expect(edit.text).toBe("a**b**");
  });
});
