"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { axesOf, fitViewport, resizeByKey, resizeToEdge, stageOf, VIEWPORT_RAIL, type ResizeDirection, type StageRect, type ViewportMode, type ViewportZoom } from "../viewport";

type Size = { width: number; height: number };
type Resize = { onPreview: (size: Size | undefined) => void; onLive: (size: Size) => void; onCommit: (size: Size) => void };

const RAIL_HANDLES: ReadonlyArray<{ direction: ResizeDirection; label: string; cursor: string }> = [
  { direction: "north", label: "top edge", cursor: "cursor-ns-resize" },
  { direction: "south", label: "bottom edge", cursor: "cursor-ns-resize" },
  { direction: "west", label: "left edge", cursor: "cursor-ew-resize" },
  { direction: "east", label: "right edge", cursor: "cursor-ew-resize" },
  { direction: "northwest", label: "top-left corner", cursor: "cursor-nwse-resize" },
  { direction: "southeast", label: "bottom-right corner", cursor: "cursor-nwse-resize" },
  { direction: "northeast", label: "top-right corner", cursor: "cursor-nesw-resize" },
  { direction: "southwest", label: "bottom-left corner", cursor: "cursor-nesw-resize" },
];

const RAIL = "group absolute z-20 touch-none rounded-sm bg-transparent outline-none focus-visible:bg-foreground/10";
const GRIP =
  "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/50 group-hover:bg-foreground/70 group-focus-visible:bg-foreground group-active:bg-foreground";

// One drag at a time. Only a pointerup this component saw commits the dragged size; any other
// ending that already moved the page commits the start size back. Unmounting commits nothing.
function ViewportRails({ viewport, stage, fit, zoom, lockRatio, onPreview, onLive, onCommit }: Resize & { viewport: Size; stage: StageRect; fit: StageRect; zoom: ViewportZoom; lockRatio: boolean }) {
  const dragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragRef.current?.(), []);
  const startDrag = (direction: ResizeDirection, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const host = (target.offsetParent ?? target.parentElement)?.getBoundingClientRect();
    if (!host) return;
    const axes = axesOf(direction);
    const center = { x: host.left + stage.x + stage.width / 2, y: host.top + stage.y + stage.height / 2 };
    const start = { width: viewport.width, height: viewport.height };
    const startFit = fitViewport(start, stage, zoom);
    const outward = (clientX: number, clientY: number) => ({ x: (clientX - center.x) * axes.x, y: (clientY - center.y) * axes.y });
    const grabbed = outward(event.clientX, event.clientY);
    const offset = { x: grabbed.x - startFit.width / 2, y: grabbed.y - startFit.height / 2 };
    let latest = start;
    let sent = start;
    let movedPage = false;
    let frame = 0;
    try { target.setPointerCapture(pointerId); } catch { /* window listeners below still work */ }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const at = outward(moveEvent.clientX, moveEvent.clientY);
      latest = resizeToEdge(start, direction, { x: at.x - offset.x, y: at.y - offset.y }, stage, lockRatio, zoom);
      onPreview(latest);
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          if (latest.width === sent.width && latest.height === sent.height) return;
          sent = latest;
          movedPage = true;
          onLive(latest);
        });
      }
    };
    const cleanup = () => {
      if (dragRef.current === cleanup) dragRef.current = null;
      window.cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("blur", abandon);
      window.removeEventListener("keydown", escape, true);
      target.removeEventListener("lostpointercapture", abandon);
      try { target.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    const abandon = () => {
      cleanup();
      onPreview(undefined);
      if (movedPage) onCommit(start);
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      cleanup();
      onPreview(undefined);
      if (movedPage || latest.width !== start.width || latest.height !== start.height) onCommit(latest);
    };
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      abandon();
    };
    dragRef.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", abandon);
    window.addEventListener("blur", abandon);
    window.addEventListener("keydown", escape, true);
    target.addEventListener("lostpointercapture", abandon);
  };
  const onKey = (direction: ResizeDirection, event: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = resizeByKey(viewport, event.key, event.shiftKey, direction, lockRatio);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onCommit(next);
  };
  const left = stage.x + fit.x;
  const top = stage.y + fit.y;
  const place = (direction: ResizeDirection): React.CSSProperties => {
    const axes = axesOf(direction);
    return {
      left: axes.x < 0 ? left - VIEWPORT_RAIL : axes.x > 0 ? left + fit.width : left,
      top: axes.y < 0 ? top - VIEWPORT_RAIL : axes.y > 0 ? top + fit.height : top,
      width: axes.x ? VIEWPORT_RAIL : fit.width,
      height: axes.y ? VIEWPORT_RAIL : fit.height,
    };
  };
  return (
    <>
      {RAIL_HANDLES.map(({ direction, label, cursor }) => {
        const axes = axesOf(direction);
        const corner = axes.x !== 0 && axes.y !== 0;
        return (
          <button
            key={direction}
            type="button"
            aria-label={`Resize viewport from the ${label}. Use arrow keys.`}
            title="Drag to resize the viewport"
            className={cn(RAIL, cursor, corner && "z-30")}
            style={place(direction)}
            onPointerDown={(event) => startDrag(direction, event)}
            onKeyDown={(event) => onKey(direction, event)}
          >
            <span aria-hidden className={cn(GRIP, corner ? "size-1.5" : axes.x ? "h-8 w-1" : "h-1 w-8")} />
          </button>
        );
      })}
    </>
  );
}

/** The frame, rails and readout around the fitted page, with the same fit arithmetic the shell applies. */
export function DeviceFrame({ viewport, mode, hostSize, zoom, lockRatio, preview, railsKey, ...resize }: Resize & {
  viewport: Size;
  mode: ViewportMode;
  /** A change remounts the rails, which ends a drag without committing. */
  railsKey: string;
  hostSize: Size;
  zoom: ViewportZoom;
  lockRatio: boolean;
  preview: Size | undefined;
}) {
  const stage = stageOf(hostSize);
  const shown = preview ?? viewport;
  const fit = fitViewport(shown, stage, zoom);
  const left = stage.x + fit.x;
  const top = stage.y + fit.y;
  return (
    <>
      <div
        aria-hidden
        className={cn("pointer-events-none absolute rounded-sm ring-1", preview ? "ring-primary/70" : "ring-border/70")}
        style={{ left, top, width: fit.width, height: fit.height, boxShadow: "0 0 0 9999px color-mix(in oklab, var(--muted) 55%, transparent)" }}
      />
      {preview && (
        <span aria-live="polite" className="pointer-events-none absolute z-30 rounded-md bg-foreground px-1.5 py-0.5 font-mono text-3xs text-background" style={{ left: left + 6, top: top + 6 }}>
          {shown.width}×{shown.height}
        </span>
      )}
      {mode === "fixed" && <ViewportRails key={railsKey} viewport={viewport} stage={stage} fit={fit} zoom={zoom} lockRatio={lockRatio} {...resize} />}
    </>
  );
}
