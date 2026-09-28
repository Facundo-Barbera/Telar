"use client";

import { useMemo } from "react";
import type { Look } from "../looks";
import { compositionHalf, MODES, type CompositionMode } from "../composition";
import { composeState } from "../scene-composer";
import { cn } from "@/lib/utils";

function Half({
  look,
  mode,
  className,
}: {
  look: Look;
  mode: CompositionMode;
  className?: string;
}) {
  const half = useMemo(() => compositionHalf(look.composition, mode), [look.composition, mode]);
  const scene = useMemo(() => composeState(look.composition[mode].layers, look.images), [look.composition, look.images, mode]);
  return (
    <span data-half={mode} className={cn("absolute inset-y-0 overflow-hidden", className)} style={{ background: half.background }}>
      {scene && (
        <span className="absolute inset-0" style={{ backgroundImage: scene.image, backgroundSize: "cover", backgroundPosition: "center" }} />
      )}
    </span>
  );
}

export function LookThumb({ look, className }: { look: Look; className?: string }) {
  const dark = useMemo(() => compositionHalf(look.composition, "dark"), [look.composition]);
  return (
    <span className={cn("relative block aspect-video w-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10", className)}>
      {MODES.map((mode) => (
        <Half key={mode} look={look} mode={mode} className={mode === "light" ? "left-0 w-1/2" : "right-0 w-1/2"} />
      ))}
      <span
        className="dark absolute inset-x-[24%] top-[34%] flex h-[32%] items-center overflow-hidden rounded-[3px] shadow-1"
        style={{ background: dark.card, border: `1px solid ${dark.border}` }}
      >
        <span data-accent-line className="ml-1.5 h-[3px] w-[45%] rounded-full" data-accent={look.accent} style={{ background: "var(--primary)" }} />
      </span>
    </span>
  );
}
