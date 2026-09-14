/**
 * WHAT A PERSON MARKED ON A PAGE, AND WHAT THAT SAYS TO AN AGENT (#474).
 *
 * The overlay draws on a FROZEN FRAME — the native `WebContentsView`
 * composites above this renderer's DOM, so annotate mode captures the
 * viewport, hides the view and draws on the picture. Everything in this file
 * is about that picture's coordinate space and nothing about canvases: it is
 * pure so `bun test` can have all of it, the way `prompt-stash.ts` is pure and
 * `stash-images.ts` (which reaches for a canvas) is not.
 *
 * ONE ORDERED LIST, NOT A LIST PER TOOL. Undo is the gesture people actually
 * press, and "undo the last thing I did" is unanswerable across four
 * independent stacks — a rectangle, an arrow and an element pick have to come
 * off in the order they went on.
 *
 * THE TEXT BLOCK IS THE POINT OF THE ELEMENT PICK. A rectangle drawn round a
 * button tells an agent where to look; `button "Save" — #save` tells it what
 * to act on. The picture and the block are sent together and neither replaces
 * the other: the block is what survives being read by a model that is bad at
 * pictures, and the picture is what survives a selector going stale.
 */

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

/** One element the shell measured on the frozen frame, in the SAME CSS pixels
 *  the capture is in (`browser-manager.js` `elementBoxes`). */
export type ElementBox = Box & { role: string; name: string; selector: string };

export type Mark =
  | { kind: "rect"; id: string; box: Box }
  | { kind: "arrow"; id: string; from: Point; to: Point }
  | { kind: "freehand"; id: string; points: readonly Point[] }
  | { kind: "text"; id: string; at: Point; text: string }
  | { kind: "pick"; id: string; element: ElementBox };

/** What a mark is BEFORE it has an id — what a gesture produces. */
export type NewMark =
  | { kind: "rect"; box: Box }
  | { kind: "arrow"; from: Point; to: Point }
  | { kind: "freehand"; points: readonly Point[] }
  | { kind: "text"; at: Point; text: string }
  | { kind: "pick"; element: ElementBox };

export type Annotation = {
  marks: readonly Mark[];
  /** Ids are handed out from here rather than derived from the length, so
   *  undoing and drawing again cannot mint an id React has already keyed a
   *  node with. */
  seq: number;
};

/** The page the marks are about — the caption's whole content. */
export type AnnotatedPage = {
  url: string;
  title?: string;
  /** The tab's OWN viewport. Sent at scale 1 and named here, which is the
   *  issue's answer for a fixed-viewport tab the panel was scaling down. */
  width: number;
  height: number;
  fullPage?: boolean;
};

export const ANNOTATION_TOOLS = ["rect", "arrow", "freehand", "text", "pick"] as const;
export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

/** A drag this short is a CLICK that wandered, not a shape. Below it a
 *  rectangle or an arrow is dropped rather than left on the frame as a
 *  speck nobody can select to remove. */
export const MIN_DRAG_PX = 4;

export function emptyAnnotation(): Annotation {
  return { marks: [], seq: 0 };
}

/** Collapse whitespace and clamp, so one element's accessible name cannot be
 *  a paragraph in the middle of the block. */
function tidy(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * ADDING IS WHERE THE RULES LIVE, because every caller is a pointer handler
 * and none of them should be deciding what counts.
 *
 * A ZERO-AREA SHAPE IS NOT ADDED. An empty text label is not added. And an
 * element ALREADY PICKED is not added twice — you cannot pick a button more
 * than once, and a second entry would put it in the text block twice.
 */
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

/** The last thing added comes off — across every tool, which is why there is
 *  one list. Undoing an empty annotation is the same annotation. */
export function undoMark(annotation: Annotation): Annotation {
  if (annotation.marks.length === 0) return annotation;
  return { ...annotation, marks: annotation.marks.slice(0, -1) };
}

/** Everything off, the counter kept: ids stay unique across a clear. */
export function clearMarks(annotation: Annotation): Annotation {
  return annotation.marks.length === 0 ? annotation : { ...annotation, marks: [] };
}

export function picksOf(annotation: Annotation): readonly ElementBox[] {
  return annotation.marks.flatMap((mark) => (mark.kind === "pick" ? [mark.element] : []));
}

/** A drag, whichever way it was dragged, as a box with positive sides. */
export function boxFromDrag(from: Point, to: Point): Box {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/**
 * WHAT IS UNDER THE POINTER. The shell hands these back smallest-area first
 * (`elementBoxes`), so the FIRST box containing the point is the innermost
 * element — the button, not the toolbar around it, not the `<body>` around
 * that. Sorting here too would be doing the same work twice; containment is
 * all this has to decide.
 */
export function elementAt(boxes: readonly ElementBox[], point: Point): ElementBox | undefined {
  return boxes.find(
    (box) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height,
  );
}

/**
 * THE ONE-LINE CAPTION a plain screenshot rides into the composer with. The
 * URL is the whole point — a picture of a page with no address is a picture
 * an agent cannot go look at itself.
 */
export function captionFor(page: AnnotatedPage): string {
  const size = `${page.width}×${page.height}`;
  const what = page.fullPage ? "Full-page screenshot" : "Screenshot";
  return `${what} of ${page.url} (${size}).`;
}

/**
 * WHAT "SEND TO AGENT" PUTS IN THE MESSAGE beside the annotated picture.
 *
 * The caption, then the picked elements — role, accessible name, selector —
 * one per line. Nothing about the rectangles and arrows: they are IN the
 * picture, and a line saying "there is a red rectangle at 412,88" tells a
 * reader looking at the same picture nothing it does not already have.
 *
 * WITH NOTHING PICKED IT IS JUST THE CAPTION, not a heading over an empty
 * list. Drawing an arrow at something and sending it is a complete gesture.
 */
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

/**
 * A FILE NAME A PERSON CAN READ IN THE COMPOSER'S CHIP. The host, because
 * that is what tells two screenshots apart in a row of them; the rest is
 * dropped rather than encoded, since a path with slashes in it is not a name.
 */
export function captureFileName(url: string, kind: "screenshot" | "annotated"): string {
  let host = "page";
  try {
    host = new URL(url).hostname || "page";
  } catch {
    // A file:// path, about:blank, or something typed that never parsed: the
    // generic name is still a name, and the caption carries the address.
  }
  return `${kind}-${host.replace(/[^a-z0-9.-]+/gi, "-")}.png`;
}
