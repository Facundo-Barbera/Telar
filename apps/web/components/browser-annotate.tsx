"use client";

/**
 * ANNOTATE MODE — marking up the page and handing the result to the agent (#474).
 *
 * WHY THERE IS A FROZEN FRAME AT ALL. The desktop shell composites its native
 * `WebContentsView` ABOVE this renderer's DOM, so nothing drawn here can ever
 * be on top of the live page — the same fact `lib/native-view-overlay.ts` was
 * written about. So annotate mode does what that file's rule does, for longer:
 * capture the viewport, take the native view down, and draw on the PICTURE.
 * The page is not live while you are marking it, and that is not a compromise
 * — a page that scrolled under your rectangle would put the rectangle
 * somewhere else.
 *
 * ONE COORDINATE SPACE, THE FRAME'S OWN. The capture arrives at the tab's
 * intrinsic viewport (scale 1, whatever the panel was scaling the page down
 * by), and every mark is stored in those pixels. What the person sees is that
 * frame FITTED into the host, so a pointer position is divided by the fit
 * scale on the way in and multiplied by nothing on the way out. The PNG that
 * goes to the agent is rendered at the frame's own size, so an arrow drawn in
 * a 500px column lands on the same pixel in a 1280px-wide picture.
 *
 * SVG WHILE YOU DRAW, CANVAS ONCE YOU SEND. An SVG layer is crisp at any fit
 * scale, costs nothing to re-render per pointer move and can be read by a
 * screen reader; a canvas is what a PNG comes out of. Drawing the marks twice
 * is the price of both, and `paintMarks` below is the single description each
 * one is drawn from.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRightIcon,
  Loader2Icon,
  MousePointerClickIcon,
  PencilIcon,
  SendIcon,
  SquareIcon,
  TrashIcon,
  TypeIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  addMark,
  annotationTextBlock,
  boxFromDrag,
  captureFileName,
  clearMarks,
  elementAt,
  emptyAnnotation,
  undoMark,
  type Annotation,
  type AnnotationTool,
  type ElementBox,
  type Mark,
  type Point,
} from "@/lib/browser-annotation";
import { cn } from "@/lib/utils";

/** The frozen frame and everything measured on it, as the shell answered. */
export type AnnotateCapture = {
  /** `data:image/png;base64,…` — what the host draws and the canvas re-reads. */
  dataUrl: string;
  url: string;
  title?: string;
  /** The tab's OWN viewport: the frame's size, and the marks' coordinate space. */
  width: number;
  height: number;
  elements: readonly ElementBox[];
};

/** Ink that reads on a light page and a dark one alike. Not a theme token:
 *  this is painted INTO a PNG that leaves the app, where our variables mean
 *  nothing. */
const INK = "#ef4444";
const INK_SOFT = "rgba(239, 68, 68, 0.16)";
const PICK = "#2563eb";
const PICK_SOFT = "rgba(37, 99, 235, 0.14)";

const TOOLS: ReadonlyArray<{ key: AnnotationTool; label: string; hint: string; Icon: typeof SquareIcon }> = [
  { key: "rect", label: "Rectangle", hint: "Drag a box around something", Icon: SquareIcon },
  { key: "arrow", label: "Arrow", hint: "Drag to point at something", Icon: ArrowUpRightIcon },
  { key: "freehand", label: "Freehand", hint: "Draw on the page", Icon: PencilIcon },
  { key: "text", label: "Text", hint: "Click to place a label", Icon: TypeIcon },
  { key: "pick", label: "Pick element", hint: "Hover the page, click to name an element", Icon: MousePointerClickIcon },
];

/** How the frame sits inside the host: scaled down to fit, never up, centred.
 *  The same shape the shell's own `fitViewport` produces for the native view,
 *  which is why a fitted frame lands where the page used to be. */
function fitFrame(frame: { width: number; height: number }, host: { width: number; height: number }) {
  const scale = Math.min(1, host.width / frame.width, host.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { scale, width, height, x: (host.width - width) / 2, y: (host.height - height) / 2 };
}

/**
 * EVERY MARK, ONCE, AS DRAWING INSTRUCTIONS. Both renderers walk this: the SVG
 * one turns each into an element, the canvas one into 2D calls. A mark drawn
 * one way here and another way there is a picture that changes the moment you
 * press Send, which is the bug this shape exists to make impossible.
 */
function arrowHead(from: Point, to: Point): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 14;
  const spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}

/** The marks onto a 2D context at the frame's own scale — the PNG's half. */
function paintMarks(context: CanvasRenderingContext2D, marks: readonly Mark[]): void {
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const mark of marks) {
    context.strokeStyle = mark.kind === "pick" ? PICK : INK;
    context.fillStyle = mark.kind === "pick" ? PICK_SOFT : INK_SOFT;
    context.lineWidth = 3;
    if (mark.kind === "rect") {
      context.fillRect(mark.box.x, mark.box.y, mark.box.width, mark.box.height);
      context.strokeRect(mark.box.x, mark.box.y, mark.box.width, mark.box.height);
    } else if (mark.kind === "pick") {
      const { x, y, width, height } = mark.element;
      context.fillRect(x, y, width, height);
      context.setLineDash([6, 4]);
      context.strokeRect(x, y, width, height);
      context.setLineDash([]);
    } else if (mark.kind === "arrow") {
      const [left, right] = arrowHead(mark.from, mark.to);
      context.beginPath();
      context.moveTo(mark.from.x, mark.from.y);
      context.lineTo(mark.to.x, mark.to.y);
      context.moveTo(left.x, left.y);
      context.lineTo(mark.to.x, mark.to.y);
      context.lineTo(right.x, right.y);
      context.stroke();
    } else if (mark.kind === "freehand") {
      context.beginPath();
      mark.points.forEach((point, at) => (at === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
      context.stroke();
    } else {
      context.font = "600 16px ui-sans-serif, system-ui, sans-serif";
      context.textBaseline = "top";
      const width = context.measureText(mark.text).width;
      context.fillStyle = "rgba(255,255,255,0.92)";
      context.fillRect(mark.at.x - 3, mark.at.y - 2, width + 6, 22);
      context.fillStyle = INK;
      context.fillText(mark.text, mark.at.x, mark.at.y);
    }
  }
}

/** One mark as SVG — the half you draw against. */
function MarkShape({ mark }: { mark: Mark }) {
  if (mark.kind === "rect") {
    return <rect x={mark.box.x} y={mark.box.y} width={mark.box.width} height={mark.box.height} fill={INK_SOFT} stroke={INK} strokeWidth={3} />;
  }
  if (mark.kind === "pick") {
    const { x, y, width, height } = mark.element;
    return <rect x={x} y={y} width={width} height={height} fill={PICK_SOFT} stroke={PICK} strokeWidth={3} strokeDasharray="6 4" />;
  }
  if (mark.kind === "arrow") {
    const [left, right] = arrowHead(mark.from, mark.to);
    return (
      <g fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <line x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} />
        <polyline points={`${left.x},${left.y} ${mark.to.x},${mark.to.y} ${right.x},${right.y}`} />
      </g>
    );
  }
  if (mark.kind === "freehand") {
    return (
      <polyline
        points={mark.points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        stroke={INK}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  return (
    <text x={mark.at.x} y={mark.at.y} dominantBaseline="hanging" fill={INK} fontSize={16} fontWeight={600} paintOrder="stroke" stroke="rgba(255,255,255,0.92)" strokeWidth={4}>
      {mark.text}
    </text>
  );
}

/**
 * THE FRAME, THE MARKS, AND THE ROW OF TOOLS OVER THEM.
 *
 * `onSend` receives a file and the text block that goes with it; what happens
 * to them is the panel's business (the composer's attachment path), not this
 * component's. `onCancel` is Escape, Done, and every way out — the caller puts
 * the native view back, because the caller is what took it down.
 */
export function BrowserAnnotateOverlay({
  capture,
  onCancel,
  onSend,
}: {
  capture: AnnotateCapture;
  onCancel: () => void;
  onSend: (result: { file: File; text: string }) => void | Promise<void>;
}) {
  const [tool, setTool] = useState<AnnotationTool>("rect");
  const [annotation, setAnnotation] = useState<Annotation>(emptyAnnotation);
  const [drag, setDrag] = useState<{ from: Point; to: Point; points: Point[] } | null>(null);
  const [hover, setHover] = useState<ElementBox | null>(null);
  const [label, setLabel] = useState<{ at: Point; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostSize, setHostSize] = useState<{ width: number; height: number }>();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHostSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const frame = useMemo(
    () => fitFrame({ width: capture.width, height: capture.height }, hostSize ?? { width: capture.width, height: capture.height }),
    [capture.width, capture.height, hostSize],
  );

  /** A pointer event in the FRAME's pixels. Everything stored is in these. */
  const pointOf = useCallback(
    (event: React.PointerEvent | React.MouseEvent): Point => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      return {
        x: Math.round((event.clientX - rect.left) / (frame.scale || 1)),
        y: Math.round((event.clientY - rect.top) / (frame.scale || 1)),
      };
    },
    [frame.scale],
  );

  /**
   * ESCAPE LEAVES, and it leaves ONE LAYER AT A TIME: a half-typed label is
   * what Escape cancels while one is open, because losing every mark to the
   * key that dismisses a text box is not what anybody meant by it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (label) setLabel(null);
        else onCancel();
      }
      // The gesture every drawing surface has. Not bound while a label is
      // open: there, ⌘Z belongs to the text field.
      if (!label && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setAnnotation(undoMark);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [label, onCancel]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (label || sending) return;
    const point = pointOf(event);
    if (tool === "pick") {
      const element = elementAt(capture.elements, point);
      if (element) setAnnotation((current) => addMark(current, { kind: "pick", element }));
      return;
    }
    if (tool === "text") {
      setLabel({ at: point, text: "" });
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ from: point, to: point, points: [point] });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const point = pointOf(event);
    if (drag) {
      setDrag((current) => (current ? { ...current, to: point, points: [...current.points, point] } : current));
      return;
    }
    if (tool === "pick") setHover(elementAt(capture.elements, point) ?? null);
  };

  const onPointerUp = () => {
    if (!drag) return;
    const { from, to, points } = drag;
    setDrag(null);
    setAnnotation((current) =>
      addMark(
        current,
        tool === "arrow"
          ? { kind: "arrow", from, to }
          : tool === "freehand"
            ? { kind: "freehand", points }
            : { kind: "rect", box: boxFromDrag(from, to) },
      ),
    );
  };

  /** The marks currently on the frame, plus the one being dragged — so what
   *  you see under the pointer is what you will get when you let go. */
  const drawn: Mark[] = useMemo(() => {
    const marks = [...annotation.marks];
    if (drag) {
      if (tool === "arrow") marks.push({ kind: "arrow", id: "drag", from: drag.from, to: drag.to });
      else if (tool === "freehand") marks.push({ kind: "freehand", id: "drag", points: drag.points });
      else marks.push({ kind: "rect", id: "drag", box: boxFromDrag(drag.from, drag.to) });
    }
    return marks;
  }, [annotation.marks, drag, tool]);

  /**
   * THE PNG. The frame at its own size, the marks painted over it, one blob.
   * A capture the browser cannot decode is reported rather than sent as a
   * blank rectangle — an empty picture with a confident caption is worse than
   * an error.
   */
  const send = async () => {
    setSending(true);
    setFailed(undefined);
    try {
      const image = new Image();
      image.src = capture.dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = capture.width;
      canvas.height = capture.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This view cannot render the annotated picture.");
      context.drawImage(image, 0, 0, capture.width, capture.height);
      paintMarks(context, annotation.marks);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The annotated picture could not be encoded.");
      const file = new File([blob], captureFileName(capture.url, "annotated"), { type: "image/png" });
      await onSend({ file, text: annotationTextBlock(capture, annotation) });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "The annotated picture could not be sent.");
      setSending(false);
    }
  };

  const marked = annotation.marks.length;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background" aria-label="Annotate the page">
      {/* ── the tools ────────────────────────────────────────────────────
          A ROW, not a floating palette: it changes the LAYOUT, which is the
          same reason the device toolbar is a row (lib/native-view-overlay.ts).
          Nothing here has to be on top of anything — the native view is down
          for as long as this component is mounted. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {TOOLS.map(({ key, label: name, hint, Icon }) => (
          <button
            key={key}
            type="button"
            aria-label={name}
            aria-pressed={tool === key}
            title={hint}
            onClick={() => { setTool(key); setHover(null); }}
            className={cn(
              "rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
              tool === key && "bg-muted text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
        <div aria-hidden className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          aria-label="Undo the last mark"
          title="Undo the last mark"
          disabled={marked === 0}
          onClick={() => setAnnotation(undoMark)}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Undo2Icon className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Clear every mark"
          title="Clear every mark"
          disabled={marked === 0}
          onClick={() => setAnnotation(clearMarks)}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <TrashIcon className="size-3.5" />
        </button>
        <span className="ml-auto shrink-0 truncate font-mono text-3xs text-muted-foreground" title={capture.url}>
          {capture.width}×{capture.height}
        </span>
        <Button type="button" size="sm" variant="default" className="h-6 shrink-0 gap-1 px-2 text-2xs" disabled={sending} onClick={() => void send()}>
          {sending ? <Loader2Icon className="size-3 animate-spin" /> : <SendIcon className="size-3" />}
          Send to agent
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-6 shrink-0 gap-1 px-2 text-2xs" onClick={onCancel}>
          <XIcon className="size-3" />
          Done
        </Button>
      </div>
      {failed && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          <span className="min-w-0 flex-1">{failed}</span>
          <button type="button" onClick={() => setFailed(undefined)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-destructive/20">Dismiss</button>
        </div>
      )}
      {/* ── the frozen frame ──────────────────────────────────────────── */}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        <div
          className={cn("absolute touch-none select-none", tool === "pick" ? "cursor-pointer" : "cursor-crosshair")}
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={capture.dataUrl} alt={`Frozen frame of ${capture.url}`} draggable={false} className="pointer-events-none block size-full" />
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full"
            viewBox={`0 0 ${capture.width} ${capture.height}`}
            preserveAspectRatio="none"
          >
            {/* WHAT THE POINTER IS OVER, drawn under the committed marks so a
                picked element stays visible while you hover its neighbour. */}
            {tool === "pick" && hover && (
              <rect x={hover.x} y={hover.y} width={hover.width} height={hover.height} fill={PICK_SOFT} stroke={PICK} strokeWidth={2} />
            )}
            {drawn.map((mark) => (
              <MarkShape key={mark.id} mark={mark} />
            ))}
          </svg>
          {/* THE LABEL BEING TYPED, positioned in the FITTED frame's pixels —
              the only thing in this component that is not in frame space,
              because it is a real DOM input a person is typing into. */}
          {label && (
            <input
              autoFocus
              aria-label="Label text"
              value={label.text}
              placeholder="Label…"
              onChange={(event) => setLabel({ ...label, text: event.target.value })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  setAnnotation((current) => addMark(current, { kind: "text", at: label.at, text: label.text }));
                  setLabel(null);
                }
              }}
              onBlur={() => {
                setAnnotation((current) => addMark(current, { kind: "text", at: label.at, text: label.text }));
                setLabel(null);
              }}
              style={{ left: label.at.x * frame.scale, top: label.at.y * frame.scale }}
              className="absolute z-10 h-6 w-40 rounded-md border border-border bg-background px-1.5 text-2xs outline-none focus:border-ring"
            />
          )}
        </div>
        {/* THE PAGE IS NOT LIVE, and the person has to be told once — a frame
            that does not respond to a click looks broken otherwise. */}
        <p className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-3xs text-muted-foreground">
          {tool === "pick" ? "Click an element to name it for the agent." : "The page is paused while you mark it."}
        </p>
      </div>
    </div>
  );
}
