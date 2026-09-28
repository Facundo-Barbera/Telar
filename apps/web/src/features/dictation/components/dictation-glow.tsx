"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { DictationPhase } from "../hooks/use-dictation";
import { createLevelMeter, glowLevel } from "../level";

/** Wraps `children` in the dictation glow; `stream` drives `--dictation-level` without re-rendering. Styles live in globals.css. */
export function DictationGlow({ phase, stream, children }: { phase: DictationPhase; stream?: MediaStream | undefined; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element || !stream || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let level = 0;
    const meter = createLevelMeter(
      stream,
      (heard) => {
        level = glowLevel(level, heard);
        element.style.setProperty("--dictation-level", level.toFixed(3));
      },
      { everyFrame: true },
    );
    return () => {
      meter.stop();
      element.style.removeProperty("--dictation-level");
    };
  }, [stream]);

  return (
    <div ref={frame} className="relative z-[1]">
      <span aria-hidden data-phase={phase} className="dictation-glow dictation-glow-halo" />
      {children}
      <span aria-hidden data-phase={phase} className="dictation-glow dictation-glow-ring" />
    </div>
  );
}
