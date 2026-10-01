import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const DURATION_MS = 200;
const EASING = "cubic-bezier(.22,1,.36,1)";
const SWAPPED = "[data-slot=input-group-addon], [data-slot=composer-foot] > *";

const still = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function useArmed(scope: string) {
  const [armedFor, setArmedFor] = useState<string>();
  const armed = armedFor === scope;
  useEffect(() => {
    if (armed) return;
    const frame = requestAnimationFrame(() => setArmedFor(scope));
    return () => cancelAnimationFrame(frame);
  }, [armed, scope]);
  return armed;
}

export function useComposerMotion(box: RefObject<HTMLDivElement | null>, shape: string, scope: string) {
  const armed = useArmed(scope);
  const height = useRef<number | undefined>(undefined);
  const shown = useRef(shape);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    height.current = element.offsetHeight;
    const observer = new ResizeObserver(() => {
      height.current = element.offsetHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);

  useLayoutEffect(() => {
    if (shown.current === shape) return;
    shown.current = shape;
    const element = box.current;
    const from = height.current;
    if (!element) return;
    for (const running of element.getAnimations?.() ?? []) running.cancel();
    const to = element.offsetHeight;
    height.current = to;
    if (!armed || still() || typeof element.animate !== "function") return;
    const timing = { duration: DURATION_MS, easing: EASING };
    if (from !== undefined && from !== to) element.animate([{ height: `${from}px`, overflow: "clip" }, { height: `${to}px`, overflow: "clip" }], timing);
    for (const swapped of element.querySelectorAll<HTMLElement>(SWAPPED)) swapped.animate([{ opacity: 0 }, { opacity: 1 }], timing);
  }, [armed, box, shape]);

  return armed;
}

export function useSwapFade(element: RefObject<HTMLElement | null>, state: string, armed: boolean) {
  const shown = useRef(state);
  useLayoutEffect(() => {
    if (shown.current === state) return;
    shown.current = state;
    const target = element.current;
    if (!armed || !target || still() || typeof target.animate !== "function") return;
    target.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: DURATION_MS, easing: EASING });
  }, [armed, element, state]);
}
