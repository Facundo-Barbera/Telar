"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { clampSidebarWidth, setSidebarWidth } from "@/lib/sidebar-width";
import { RIGHT_PANEL_MAIN_MIN_WIDTH, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_WIDTH_STORAGE_KEY } from "../layout";

type Drag = {
  pointerId: number;
  startWidth: number;
  startX: number;
  width: number;
  raf: number | null;
  pendingWidth: number;
};

/**
 * The panel's left edge. Deltas are inverted (the panel grows leftwards), and painting writes the
 * inline style through a rAF so a drag does not re-render the panel and its surfaces.
 */
export function RightPanelResizeHandle({ panelRef }: { panelRef: RefObject<HTMLElement | null> }) {
  const dragRef = useRef<Drag | null>(null);

  const maxWidth = useCallback(() => {
    const available = panelRef.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(RIGHT_PANEL_MIN_WIDTH, available - RIGHT_PANEL_MAIN_MIN_WIDTH);
  }, [panelRef]);

  const paint = useCallback(
    (drag: Drag) => {
      const width = clampSidebarWidth(drag.pendingWidth, RIGHT_PANEL_MIN_WIDTH, maxWidth());
      drag.width = width;
      panelRef.current?.style.setProperty("--right-panel-width", `${width}px`);
      // The native browser view is composited above the DOM; announcing lets it republish bounds in this frame.
      window.dispatchEvent(new Event("telar:panel-resized"));
    },
    [maxWidth, panelRef],
  );

  const finish = useCallback(
    (pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      if (drag.raf !== null) window.cancelAnimationFrame(drag.raf);
      paint(drag);
      dragRef.current = null;
      setSidebarWidth(RIGHT_PANEL_WIDTH_STORAGE_KEY, drag.width);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [paint],
  );

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.raf != null) window.cancelAnimationFrame(drag.raf);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );

  return (
    <button
      type="button"
      aria-label="Resize right panel"
      title="Drag to resize right panel"
      className="absolute inset-y-0 -left-2 z-20 block w-4 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerDown={(event) => {
        if (event.button !== 0 || !panelRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        const width = panelRef.current.getBoundingClientRect().width;
        dragRef.current = { pointerId: event.pointerId, startWidth: width, startX: event.clientX, width, raf: null, pendingWidth: width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.pendingWidth = drag.startWidth + drag.startX - event.clientX;
        if (drag.raf !== null) return;
        drag.raf = window.requestAnimationFrame(() => {
          const current = dragRef.current;
          if (!current) return;
          current.raf = null;
          paint(current);
        });
      }}
      onPointerUp={(event) => finish(event.pointerId)}
      onPointerCancel={(event) => finish(event.pointerId)}
      onKeyDown={(event) => {
        if (!panelRef.current || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? 16 : -16;
        const width = clampSidebarWidth(panelRef.current.getBoundingClientRect().width + delta, RIGHT_PANEL_MIN_WIDTH, maxWidth());
        panelRef.current.style.setProperty("--right-panel-width", `${width}px`);
        setSidebarWidth(RIGHT_PANEL_WIDTH_STORAGE_KEY, width);
      }}
    />
  );
}
