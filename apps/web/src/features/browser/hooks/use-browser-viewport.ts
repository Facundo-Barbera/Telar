import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { addressRowFitsTools } from "../model";
import type { DesktopBrowserBridge } from "../types";
import { stageOf, type ViewportMode } from "../viewport";

// Read computed: `--radius-xl` is a calc() the browser hands back unresolved, the
// element's own corner is already px under the current Look.
function hostRadius(host: HTMLElement): number {
  const radius = Number.parseFloat(window.getComputedStyle(host).borderBottomLeftRadius);
  return Number.isFinite(radius) ? Math.max(0, Math.round(radius)) : 0;
}

const stageIn = (rect: DOMRect, mode: ViewportMode) => (mode === "fixed" ? stageOf(rect) : { x: 0, y: 0, width: rect.width, height: rect.height });

/**
 * Glues the native view to the host. Fixed viewports reserve rails around the stage.
 * `layoutKey` is anything that moves the host without resizing it; a change republishes.
 */
export function useDesktopBrowserViewport(
  bridge: DesktopBrowserBridge,
  scopeKey: string,
  hostRef: RefObject<HTMLDivElement | null>,
  layoutKey: string,
  mode: ViewportMode,
  overlayRef: RefObject<boolean>,
) {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    let transitionFrame = 0;
    let disposed = false;
    let visibilityRequested = false;
    const applyBounds = async () => {
      const rect = host.getBoundingClientRect();
      const stage = stageIn(rect, mode);
      const radius = mode === "fixed" ? 0 : hostRadius(host);
      await bridge.setBounds(scopeKey, { x: rect.left + stage.x, y: rect.top + stage.y, width: rect.width === 0 ? 0 : stage.width, height: rect.height === 0 ? 0 : stage.height, radius });
      if (disposed) return;
      // A panel mounting mid-animation measures 0×0; latch so the next real size shows the view.
      if (rect.width === 0 || rect.height === 0) {
        visibilityRequested = false;
        return;
      }
      // A menu is open over the panel: the view stays down until it closes.
      if (overlayRef.current) {
        visibilityRequested = false;
        return;
      }
      if (visibilityRequested) return;
      visibilityRequested = true;
      await bridge.setVisible(scopeKey, true);
    };
    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => void applyBounds());
    };
    // The panel drag already paints inside its own frame; another rAF would lag the border.
    const panelResized = () => void applyBounds();
    window.addEventListener("telar:panel-resized", panelResized);
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    // ResizeObserver does not report an ancestor's flex animation, so follow it for 360ms.
    const transitionDeadline = performance.now() + 360;
    const followTransition = () => {
      void applyBounds();
      if (performance.now() < transitionDeadline) transitionFrame = window.requestAnimationFrame(followTransition);
    };
    followTransition();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(transitionFrame);
      observer.disconnect();
      window.removeEventListener("telar:panel-resized", panelResized);
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void bridge.setVisible(scopeKey, false);
    };
  }, [bridge, hostRef, scopeKey, mode, overlayRef]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const stage = stageIn(rect, mode);
      void bridge.setBounds(scopeKey, { x: rect.left + stage.x, y: rect.top + stage.y, width: stage.width, height: stage.height, radius: mode === "fixed" ? 0 : hostRadius(host) });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bridge, hostRef, scopeKey, layoutKey, mode]);
}

// `read` must be a stable module function: it is an effect dependency.
function useObserved<T>(ref: RefObject<HTMLElement | null>, read: (box: DOMRectReadOnly) => T): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setValue(read(entry.contentRect));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, read]);
  return value;
}

const sizeOf = (box: DOMRectReadOnly) => ({ width: box.width, height: box.height });
const fitsTools = (box: DOMRectReadOnly) => addressRowFitsTools(box.width);

export const useHostSize = (hostRef: RefObject<HTMLDivElement | null>) => useObserved(hostRef, sizeOf);

/** Whether the address row is wide enough for the camera and the pen, measured on the row itself. */
export const useAddressRowTools = (rowRef: RefObject<HTMLElement | null>) => useObserved(rowRef, fitsTools) ?? false;
