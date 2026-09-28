export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

/** Measured in the same CSS pixels as the capture (`browser-manager.js` `elementBoxes`). */
export type ElementBox = Box & { role: string; name: string; selector: string };

export type Mark =
  | { kind: "rect"; id: string; box: Box }
  | { kind: "arrow"; id: string; from: Point; to: Point }
  | { kind: "freehand"; id: string; points: readonly Point[] }
  | { kind: "text"; id: string; at: Point; text: string }
  | { kind: "pick"; id: string; element: ElementBox };

export type NewMark =
  | { kind: "rect"; box: Box }
  | { kind: "arrow"; from: Point; to: Point }
  | { kind: "freehand"; points: readonly Point[] }
  | { kind: "text"; at: Point; text: string }
  | { kind: "pick"; element: ElementBox };

export type Annotation = {
  marks: readonly Mark[];
  /** Ids come from this counter, not the list length, so undo-then-draw never reuses a React key. */
  seq: number;
};

export type AnnotatedPage = {
  url: string;
  title?: string;
  width: number;
  height: number;
  fullPage?: boolean;
};

export const ANNOTATION_TOOLS = ["rect", "arrow", "freehand", "text", "pick"] as const;
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

const MIN_DRAG_PX = 4;

export function emptyAnnotation(): Annotation {
  return { marks: [], seq: 0 };
}

function tidy(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Drops zero-area shapes, empty text and an element that is already picked. */
export function addMark(annotation: Annotation, mark: NewMark): Annotation {
  if (mark.kind === "rect" && (mark.box.width < MIN_DRAG_PX || mark.box.height < MIN_DRAG_PX)) return annotation;
  if (mark.kind === "arrow" && Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) < MIN_DRAG_PX) return annotation;
  if (mark.kind === "freehand" && mark.points.length < 2) return annotation;
  if (mark.kind === "text" && !mark.text.trim()) return annotation;
  if (mark.kind === "pick" && annotation.marks.some((held) => held.kind === "pick" && held.element.selector === mark.element.selector)) {
    return annotation;
  }
  const seq = annotation.seq + 1;
  const tidied: NewMark =
    mark.kind === "text"
      ? { ...mark, text: tidy(mark.text, 120) }
      : mark.kind === "pick"
        ? { ...mark, element: { ...mark.element, name: tidy(mark.element.name), role: tidy(mark.element.role, 32) } }
        : mark;
  return { marks: [...annotation.marks, { ...tidied, id: `m${seq}` } as Mark], seq };
}

export function undoMark(annotation: Annotation): Annotation {
  if (annotation.marks.length === 0) return annotation;
  return { ...annotation, marks: annotation.marks.slice(0, -1) };
}

/** Keeps the counter so ids stay unique across a clear. */
export function clearMarks(annotation: Annotation): Annotation {
  return annotation.marks.length === 0 ? annotation : { ...annotation, marks: [] };
}

export function picksOf(annotation: Annotation): readonly ElementBox[] {
  return annotation.marks.flatMap((mark) => (mark.kind === "pick" ? [mark.element] : []));
}

export function boxFromDrag(from: Point, to: Point): Box {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** Expects `boxes` sorted smallest-area first (as `elementBoxes` returns them), so the first hit is innermost. */
export function elementAt(boxes: readonly ElementBox[], point: Point): ElementBox | undefined {
  return boxes.find(
    (box) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height,
  );
}

export function captionFor(page: AnnotatedPage): string {
  const size = `${page.width}×${page.height}`;
  const what = page.fullPage ? "Full-page screenshot" : "Screenshot";
  return `${what} of ${page.url} (${size}).`;
}

export function annotationTextBlock(page: AnnotatedPage, annotation: Annotation): string {
  const picked = picksOf(annotation);
  const caption = `Annotated screenshot of ${page.url} (${page.width}×${page.height}).`;
  if (picked.length === 0) return caption;
  const lines = picked.map((element) => {
    const name = element.name ? ` "${element.name}"` : "";
    return `- ${element.role}${name} — \`${element.selector}\``;
  });
  return [caption, picked.length === 1 ? "Marked element:" : "Marked elements:", ...lines].join("\n");
}

export function captureFileName(url: string, kind: "screenshot" | "annotated"): string {
  let host = "page";
  try {
    host = new URL(url).hostname || "page";
  } catch {
    // file://, about:blank and unparseable input keep the generic name.
  }
  return `${kind}-${host.replace(/[^a-z0-9.-]+/gi, "-")}.png`;
}
