"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { cn } from "@/ui/utils";
import type { SvgImage } from "../svg-image";
import { cardLayout, fitView, similarSize, zoomAt, type Size, type View } from "../viewport";

const STEP = 1.25;
const NUDGE = 48;

function useBoxSize(ref: React.RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const BUTTON = "inline-flex h-6 min-w-6 items-center justify-center rounded px-1 text-3xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/** Pans by drag, zooms with ⌘/ctrl+wheel or a pinch; in a panel a plain wheel pans, in a card it scrolls the conversation. */
export function SvgViewer({ image, title, minScale, fill, ground }: { image: SvgImage; title: string; minScale: number; fill: boolean; ground?: React.CSSProperties }) {
  const box = useRef<HTMLDivElement>(null);
  const size = useBoxSize(box);
  const card = fill ? undefined : cardLayout(image, size.width, minScale);
  const initial = (): View | undefined => (size.width === 0 ? undefined : fill ? (size.height === 0 ? undefined : fitView(image, size)) : card!.view);
  const [view, setView] = useState<View>();
  const shown = useRef<SvgImage | undefined>(undefined);
  const touched = useRef(false);
  const drag = useRef<{ x: number; y: number; view: View } | undefined>(undefined);

  useEffect(() => {
    if (size.width === 0 || (fill && size.height === 0)) return;
    const before = shown.current;
    shown.current = image;
    const kept = touched.current && before !== undefined && (before.url === image.url || similarSize(before, image));
    touched.current = kept;
    setView((current) => (kept && current ? current : initial()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.url, size.width, size.height, fill]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const zoom = event.ctrlKey || event.metaKey;
      if (!zoom && !fill) return;
      event.preventDefault();
      touched.current = true;
      const rect = element.getBoundingClientRect();
      setView((current) => {
        if (!current) return current;
        if (!zoom) return { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY };
        return zoomAt(current, Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [fill]);

  const centre = { x: size.width / 2, y: (fill ? size.height : (card?.height ?? 0)) / 2 };
  const move = (next: (current: View) => View) => {
    touched.current = true;
    setView((current) => current && next(current));
  };
  const zoom = (factor: number) => move((current) => zoomAt(current, factor, centre));
  const actual = () => move((current) => zoomAt(current, 1 / current.scale, centre));
  const pan = (dx: number, dy: number) => move((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  const fit = () => {
    touched.current = false;
    setView(fill ? initial() : fitView(image, { width: size.width, height: card?.height ?? 0 }, 1, 8));
  };

  const keys: Record<string, () => void> = {
    "+": () => zoom(STEP),
    "=": () => zoom(STEP),
    "-": () => zoom(1 / STEP),
    "0": actual,
    f: fit,
    ArrowLeft: () => pan(NUDGE, 0),
    ArrowRight: () => pan(-NUDGE, 0),
    ArrowUp: () => pan(0, NUDGE),
    ArrowDown: () => pan(0, -NUDGE),
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const action = keys[event.key];
    if (!action || event.target !== box.current) return;
    event.preventDefault();
    action();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !view || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, view };
  };
  const onPointerMove = (event: PointerEvent) => {
    const start = drag.current;
    if (start) move(() => ({ ...start.view, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y }));
  };
  const endDrag = () => {
    drag.current = undefined;
  };

  return (
    <div
      ref={box}
      role="group"
      tabIndex={0}
      aria-label={`${title}. Drag or use the arrow keys to pan, + and − to zoom, 0 for actual size, F to fit.`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={fit}
      className={cn("group/viewer relative cursor-grab touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing", fill && "h-full")}
      style={{ ...ground, ...(fill ? {} : { height: card?.height ?? 0 }) }}
    >
      {view && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.url}
          alt={title}
          draggable={false}
          className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
          style={{ width: image.width, height: image.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      )}
      <div
        className={cn(
          "absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md border border-border bg-background/90 p-0.5 shadow-1 transition-opacity group-hover/viewer:opacity-100 group-focus-within/viewer:opacity-100",
          fill ? "opacity-80" : "opacity-0",
        )}
      >
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / STEP)} className={BUTTON}>
          <MinusIcon className="size-3" />
        </button>
        <span className="w-9 text-center font-mono text-3xs tabular-nums text-muted-foreground">{view ? `${Math.round(view.scale * 100)}%` : ""}</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoom(STEP)} className={BUTTON}>
          <PlusIcon className="size-3" />
        </button>
        <button type="button" onClick={fit} className={BUTTON}>
          Fit
        </button>
        <button type="button" onClick={actual} className={BUTTON}>
          100%
        </button>
      </div>
      {card?.clipped && <p className="pointer-events-none absolute bottom-1.5 left-2 rounded bg-background/90 px-1.5 py-0.5 text-3xs text-muted-foreground">Drag to see the rest, or open it in the panel</p>}
    </div>
  );
}
