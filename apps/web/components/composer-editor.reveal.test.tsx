/**
 * THE CARET STAYS IN VIEW AFTER EVERY WRITE — a dictated phrase, a paste, a
 * programmatic insert, a Shift+Enter.
 *
 * The box is its own scroll container, and every one of those writes is one
 * the browser does not scroll for (see `revealCaret`). Happy DOM has no layout,
 * so the geometry is seated by hand: the box reports a scroll height taller
 * than its client height, `scrollTop` is recorded rather than clamped, and a
 * test that needs a measurable caret stubs the rects it would read.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ComposerEditor } = await import("./composer-editor");
type Handle = import("./composer-editor").ComposerEditorHandle;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const rangeRect = Range.prototype.getBoundingClientRect;
let host: HTMLDivElement;
let root: Root;
let box: HTMLElement;
let scrolls: number[];
let editor: ReturnType<typeof createRef<Handle>>;

/** A box that has overflowed: 400px of content in 192px of view. */
function overflow(element: HTMLElement, scrollHeight = 400, clientHeight = 192): void {
  let top = 0;
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
      scrolls.push(value);
    },
  });
}

beforeEach(async () => {
  scrolls = [];
  editor = createRef<Handle>();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ComposerEditor ref={editor} value="" onChange={() => {}} />);
  });
  box = host.querySelector<HTMLElement>("[data-slot=composer-editor]")!;
  overflow(box);
});

afterEach(async () => {
  Range.prototype.getBoundingClientRect = rangeRect;
  await act(async () => root.unmount());
  host.remove();
});

describe("a write the browser did not make still scrolls the box to the caret", () => {
  test("insertAtCaret at the end, where nothing can measure the caret, goes to the bottom", async () => {
    await act(async () => {
      editor.current!.insertAtCaret("a long dictated sentence that wraps past the last line");
    });
    expect(scrolls.at(-1)).toBe(400);
  });

  test("a dictation revision (replaceRange) scrolls by exactly the overflow — block: nearest", async () => {
    // The box's content edge starts at 0 and has 12px/8px padding; the caret is
    // drawn at 250–274, so the smallest move that shows it is 274 - (192 - 8).
    box.style.paddingTop = "12px";
    box.style.paddingBottom = "8px";
    box.getBoundingClientRect = () => new DOMRect(0, 0, 300, 192);
    Range.prototype.getBoundingClientRect = () => new DOMRect(40, 250, 0, 24);
    await act(async () => {
      editor.current!.replaceRange(0, 0, "hello there");
    });
    expect(scrolls.at(-1)).toBe(274 - (192 - 8));
  });

  test("a caret already in view does not move the box", async () => {
    box.getBoundingClientRect = () => new DOMRect(0, 0, 300, 192);
    Range.prototype.getBoundingClientRect = () => new DOMRect(40, 60, 0, 24);
    await act(async () => {
      editor.current!.insertAtCaret("hi");
    });
    expect(scrolls).toEqual([]);
  });

  test("a box that has not overflowed is left alone", async () => {
    overflow(box, 100, 192);
    await act(async () => {
      editor.current!.insertAtCaret("hi");
    });
    expect(scrolls).toEqual([]);
  });
});

describe("Shift+Enter scrolls the new line into view", () => {
  test("the line break the browser inserts is followed by a scroll to the caret", async () => {
    const doc = document as unknown as { execCommand: (command: string) => boolean };
    const execCommand = doc.execCommand;
    const commands: string[] = [];
    // Happy DOM does not implement editing commands; stand in for Chromium's
    // insertLineBreak with the DOM it produces, caret after the break.
    doc.execCommand = (command: string) => {
      commands.push(command);
      box.replaceChildren(document.createTextNode("line one"), document.createElement("br"), document.createTextNode(""));
      const range = document.createRange();
      range.setStart(box.lastChild!, 0);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      return true;
    };
    try {
      box.focus();
      await act(async () => {
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
      });
    } finally {
      doc.execCommand = execCommand;
    }
    expect(commands).toEqual(["insertLineBreak"]);
    expect(scrolls.at(-1)).toBe(400);
  });
});
