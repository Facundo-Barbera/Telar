/**
 * THE ANNOTATION MODEL (#474).
 *
 * Pure, so all of it is testable: the marks a person leaves on a frozen frame,
 * the element under the pointer, and the text block "Send to agent" writes.
 * The canvas that DRAWS these lives in the overlay component; nothing here
 * touches one.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  addMark,
  annotationTextBlock,
  boxFromDrag,
  captionFor,
  captureFileName,
  clearMarks,
  elementAt,
  emptyAnnotation,
  picksOf,
  undoMark,
  type ElementBox,
} from "./browser-annotation";

const page = { url: "https://example.com/pricing", title: "Pricing", width: 1280, height: 800 };

const box = (patch: Partial<ElementBox> = {}): ElementBox => ({
  role: "button",
  name: "Save",
  selector: "#save",
  x: 10,
  y: 20,
  width: 80,
  height: 32,
  ...patch,
});

describe("the marks a person leaves", () => {
  test("they go on in order and come off in that order — one undo stack, not one per tool", () => {
    let annotation = emptyAnnotation();
    annotation = addMark(annotation, { kind: "rect", box: { x: 0, y: 0, width: 40, height: 40 } });
    annotation = addMark(annotation, { kind: "pick", element: box() });
    annotation = addMark(annotation, { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 60, y: 60 } });
    expect(annotation.marks.map((mark) => mark.kind)).toEqual(["rect", "pick", "arrow"]);
    // The ARROW comes off, not the last rectangle: undo is chronological.
    expect(undoMark(annotation).marks.map((mark) => mark.kind)).toEqual(["rect", "pick"]);
  });

  test("ids survive an undo followed by another mark", () => {
    let annotation = addMark(emptyAnnotation(), { kind: "rect", box: { x: 0, y: 0, width: 40, height: 40 } });
    const first = annotation.marks[0]!.id;
    annotation = addMark(undoMark(annotation), { kind: "rect", box: { x: 5, y: 5, width: 40, height: 40 } });
    // Derived from the length this would be "m1" twice, and React would carry
    // the removed node's state into the new one.
    expect(annotation.marks[0]!.id).not.toBe(first);
  });

  test("a click that wandered is not a shape, and an empty label is not a label", () => {
    const empty = emptyAnnotation();
    expect(addMark(empty, { kind: "rect", box: { x: 0, y: 0, width: 2, height: 90 } }).marks).toHaveLength(0);
    expect(addMark(empty, { kind: "arrow", from: { x: 10, y: 10 }, to: { x: 12, y: 11 } }).marks).toHaveLength(0);
    expect(addMark(empty, { kind: "freehand", points: [{ x: 1, y: 1 }] }).marks).toHaveLength(0);
    expect(addMark(empty, { kind: "text", at: { x: 1, y: 1 }, text: "   " }).marks).toHaveLength(0);
    // ...and a real one is.
    expect(addMark(empty, { kind: "rect", box: { x: 0, y: 0, width: 40, height: 40 } }).marks).toHaveLength(1);
  });

  test("the same element cannot be picked twice — it would be listed twice", () => {
    let annotation = addMark(emptyAnnotation(), { kind: "pick", element: box() });
    annotation = addMark(annotation, { kind: "pick", element: box({ name: "Save changes" }) });
    expect(picksOf(annotation)).toHaveLength(1);
    // A DIFFERENT element is another pick.
    annotation = addMark(annotation, { kind: "pick", element: box({ selector: "#cancel", name: "Cancel" }) });
    expect(picksOf(annotation).map((element) => element.selector)).toEqual(["#save", "#cancel"]);
  });

  test("a name that is a paragraph is clamped, and its whitespace flattened", () => {
    const annotation = addMark(emptyAnnotation(), { kind: "pick", element: box({ name: `Save\n  the   ${"very ".repeat(40)}thing` }) });
    const name = picksOf(annotation)[0]!.name;
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).not.toContain("\n");
    expect(name.startsWith("Save the very")).toBe(true);
  });

  test("clearing empties the marks and undoing an empty annotation is a no-op", () => {
    const annotation = addMark(emptyAnnotation(), { kind: "rect", box: { x: 0, y: 0, width: 40, height: 40 } });
    expect(clearMarks(annotation).marks).toHaveLength(0);
    const empty = emptyAnnotation();
    expect(undoMark(empty)).toBe(empty);
  });

  test("a drag has positive sides whichever way it was dragged", () => {
    expect(boxFromDrag({ x: 90, y: 70 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 80, height: 50 });
    expect(boxFromDrag({ x: 10, y: 20 }, { x: 90, y: 70 })).toEqual({ x: 10, y: 20, width: 80, height: 50 });
  });
});

describe("what is under the pointer", () => {
  // As the shell hands them back: smallest area first.
  const boxes: ElementBox[] = [
    box({ selector: "#save", x: 10, y: 20, width: 80, height: 32 }),
    box({ role: "toolbar", name: "Actions", selector: ".toolbar", x: 0, y: 10, width: 300, height: 60 }),
    box({ role: "body", name: "", selector: "body", x: 0, y: 0, width: 1280, height: 800 }),
  ];

  test("the innermost element wins, because the list arrives smallest first", () => {
    expect(elementAt(boxes, { x: 40, y: 30 })?.selector).toBe("#save");
    // Inside the toolbar but outside the button.
    expect(elementAt(boxes, { x: 200, y: 30 })?.selector).toBe(".toolbar");
    expect(elementAt(boxes, { x: 900, y: 500 })?.selector).toBe("body");
  });

  test("the edges count as inside, and nothing at all is undefined", () => {
    expect(elementAt(boxes, { x: 10, y: 20 })?.selector).toBe("#save");
    expect(elementAt(boxes, { x: 90, y: 52 })?.selector).toBe("#save");
    expect(elementAt([], { x: 5, y: 5 })).toBeUndefined();
  });
});

describe("what gets written into the message", () => {
  test("a plain screenshot is one line, and it carries the address", () => {
    expect(captionFor(page)).toBe("Screenshot of https://example.com/pricing (1280×800).");
    expect(captionFor({ ...page, fullPage: true })).toBe("Full-page screenshot of https://example.com/pricing (1280×800).");
  });

  test("the block lists every picked element with its role, name and selector", () => {
    let annotation = addMark(emptyAnnotation(), { kind: "pick", element: box() });
    annotation = addMark(annotation, { kind: "pick", element: box({ role: "textbox", name: "Email", selector: "form > input:nth-of-type(2)" }) });
    expect(annotationTextBlock(page, annotation)).toBe(
      [
        "Annotated screenshot of https://example.com/pricing (1280×800).",
        "Marked elements:",
        '- button "Save" — `#save`',
        '- textbox "Email" — `form > input:nth-of-type(2)`',
      ].join("\n"),
    );
  });

  test("one pick reads as one, and a nameless element is not given empty quotes", () => {
    const annotation = addMark(emptyAnnotation(), { kind: "pick", element: box({ role: "img", name: "", selector: "main > img" }) });
    expect(annotationTextBlock(page, annotation)).toBe(
      ["Annotated screenshot of https://example.com/pricing (1280×800).", "Marked element:", "- img — `main > img`"].join("\n"),
    );
  });

  test("marks that are IN the picture are not described in words", () => {
    let annotation = addMark(emptyAnnotation(), { kind: "rect", box: { x: 0, y: 0, width: 40, height: 40 } });
    annotation = addMark(annotation, { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 60, y: 60 } });
    annotation = addMark(annotation, { kind: "text", at: { x: 5, y: 5 }, text: "this one" });
    // Nothing picked: the caption alone, not a heading over an empty list.
    expect(annotationTextBlock(page, annotation)).toBe("Annotated screenshot of https://example.com/pricing (1280×800).");
  });

  test("the viewport is always named, which is the answer for a tab the panel was scaling down", () => {
    expect(annotationTextBlock({ ...page, width: 390, height: 844 }, emptyAnnotation())).toContain("(390×844)");
  });
});

describe("the attachment's name", () => {
  test("it is the host, so a row of screenshots is readable", () => {
    expect(captureFileName("https://example.com/pricing?a=1", "screenshot")).toBe("screenshot-example.com.png");
    expect(captureFileName("https://app.example.co.uk/x", "annotated")).toBe("annotated-app.example.co.uk.png");
  });

  test("something that is not a URL still gets a name", () => {
    expect(captureFileName("about:blank", "screenshot")).toBe("screenshot-page.png");
    expect(captureFileName("", "annotated")).toBe("annotated-page.png");
  });
});
