"use client";
import { useEffect, useState } from "react";
import { revealPrefix } from "./streaming-reveal";

export function useStreamingReveal(target: string, streaming: boolean): string {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (!streaming || shown === target) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const previous = performance.now();
    const frame = requestAnimationFrame((now) => {
      setShown((current) => reduced.matches ? target : revealPrefix(current, target, now - previous));
    });
    return () => cancelAnimationFrame(frame);
  }, [target, streaming, shown]);
  return !streaming || !target.startsWith(shown) ? target : shown;
}
