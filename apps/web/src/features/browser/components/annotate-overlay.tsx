"use client";

import { useRef } from "react";
import { ArrowUpRightIcon, Loader2Icon, MousePointerClickIcon, PencilIcon, SendIcon, SquareIcon, TrashIcon, TypeIcon, Undo2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clearMarks, undoMark, type AnnotationTool, type ElementBox } from "../annotation";
import { useAnnotation } from "../hooks/use-annotation";
import { MarkShape, PICK, PICK_SOFT } from "./annotate-marks";

export type AnnotateCapture = {
  dataUrl: string;
  url: string;
  title?: string;
  /** The tab's own viewport: the frame's size and the marks' coordinate space. */
  width: number;
  height: number;
  elements: readonly ElementBox[];
};

const TOOLS: ReadonlyArray<{ key: AnnotationTool; label: string; hint: string; Icon: typeof SquareIcon }> = [
  { key: "rect", label: "Rectangle", hint: "Drag a box around something", Icon: SquareIcon },
  { key: "arrow", label: "Arrow", hint: "Drag to point at something", Icon: ArrowUpRightIcon },
  { key: "freehand", label: "Freehand", hint: "Draw on the page", Icon: PencilIcon },
  { key: "text", label: "Text", hint: "Click to place a label", Icon: TypeIcon },
  { key: "pick", label: "Pick element", hint: "Hover the page, click to name an element", Icon: MousePointerClickIcon },
];

const TOOL_BUTTON = "rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground";

function AnnotateToolbar({ a, capture, onCancel }: { a: ReturnType<typeof useAnnotation>; capture: AnnotateCapture; onCancel: () => void }) {
  const marked = a.annotation.marks.length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
      {TOOLS.map(({ key, label: name, hint, Icon }) => (
        <button
          key={key}
          type="button"
          aria-label={name}
          aria-pressed={a.tool === key}
          title={hint}
          onClick={() => { a.setTool(key); a.setHover(null); }}
          className={cn(TOOL_BUTTON, a.tool === key && "bg-muted text-foreground")}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
      <div aria-hidden className="mx-1 h-4 w-px bg-border" />
      <button type="button" aria-label="Undo the last mark" title="Undo the last mark" disabled={marked === 0} onClick={() => a.setAnnotation(undoMark)} className={cn(TOOL_BUTTON, "disabled:opacity-40")}>
        <Undo2Icon className="size-3.5" />
      </button>
      <button type="button" aria-label="Clear every mark" title="Clear every mark" disabled={marked === 0} onClick={() => a.setAnnotation(clearMarks)} className={cn(TOOL_BUTTON, "disabled:opacity-40")}>
        <TrashIcon className="size-3.5" />
      </button>
      <span className="ml-auto shrink-0 truncate font-mono text-3xs text-muted-foreground" title={capture.url}>
        {capture.width}×{capture.height}
      </span>
      <Button type="button" size="sm" variant="default" className="h-6 shrink-0 gap-1 px-2 text-2xs" disabled={a.sending} onClick={() => void a.send()}>
        {a.sending ? <Loader2Icon className="size-3 animate-spin" /> : <SendIcon className="size-3" />}
        Send to agent
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-6 shrink-0 gap-1 px-2 text-2xs" onClick={onCancel}>
        <XIcon className="size-3" />
        Done
      </Button>
    </div>
  );
}

/** The frozen frame with the marks and a row of tools over it. The native view is down while this is mounted. */
export function BrowserAnnotateOverlay({ capture, onCancel, onSend }: { capture: AnnotateCapture; onCancel: () => void; onSend: (result: { file: File; text: string }) => void | Promise<void> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const a = useAnnotation(hostRef, capture, onCancel, onSend);
  const { tool, hover, label, frame } = a;
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background" aria-label="Annotate the page">
      <AnnotateToolbar a={a} capture={capture} onCancel={onCancel} />
      {a.failed && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          <span className="min-w-0 flex-1">{a.failed}</span>
          <button type="button" onClick={() => a.setFailed(undefined)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-destructive/20">Dismiss</button>
        </div>
      )}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        <div
          className={cn("absolute touch-none select-none", tool === "pick" ? "cursor-pointer" : "cursor-crosshair")}
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
          onPointerDown={a.onPointerDown}
          onPointerMove={a.onPointerMove}
          onPointerUp={a.onPointerUp}
          onPointerLeave={() => a.setHover(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={capture.dataUrl} alt={`Frozen frame of ${capture.url}`} draggable={false} className="pointer-events-none block size-full" />
          <svg aria-hidden className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${capture.width} ${capture.height}`} preserveAspectRatio="none">
            {tool === "pick" && hover && <rect x={hover.x} y={hover.y} width={hover.width} height={hover.height} fill={PICK_SOFT} stroke={PICK} strokeWidth={2} />}
            {a.drawn.map((mark) => (
              <MarkShape key={mark.id} mark={mark} />
            ))}
          </svg>
          {label && (
            <input
              autoFocus
              aria-label="Label text"
              value={label.text}
              placeholder="Label…"
              onChange={(event) => a.setLabel({ ...label, text: event.target.value })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") a.commitLabel(label.at, label.text);
              }}
              onBlur={() => a.commitLabel(label.at, label.text)}
              style={{ left: label.at.x * frame.scale, top: label.at.y * frame.scale }}
              className="absolute z-10 h-6 w-40 rounded-md border border-border bg-background px-1.5 text-2xs outline-none focus:border-ring"
            />
          )}
        </div>
        <p className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-3xs text-muted-foreground">
          {tool === "pick" ? "Click an element to name it for the agent." : "The page is paused while you mark it."}
        </p>
      </div>
    </div>
  );
}
