import { useLayoutEffect, useRef, type RefObject } from "react";

const DURATION_MS = 200;
const EASING = "cubic-bezier(.22,1,.36,1)";

const still = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function useRouteSwap(shell: RefObject<HTMLElement | null>, settings: boolean) {
  const shown = useRef(settings);
  useLayoutEffect(() => {
    if (shown.current === settings) return;
    shown.current = settings;
    const element = shell.current;
    if (!element) return;
    if (!still() && typeof element.animate === "function") {
      element.animate([{ opacity: 0, transform: "scale(.985)" }, { opacity: 1, transform: "none" }], { duration: DURATION_MS, easing: EASING });
    }
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      element.querySelector<HTMLElement>(settings ? 'nav button[aria-current="page"]' : "#turn-prompt")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [settings, shell]);
}
