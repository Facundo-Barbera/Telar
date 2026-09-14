"use client";

/**
 * THE LOOK THUMBNAIL — a look, at a glance, as a tiny Telar.
 *
 * A gallery of names is not a gallery of looks. This paints what the Look
 * actually does: each state's LAYERS over each state's derived canvas, light on
 * the left and dark on the right because a composition is two states, with a
 * MINIATURE PANEL floating on top — a card-coloured rectangle wearing the 3px
 * accent rail from components/ui/panel.tsx. So the tile says three things
 * without a word of copy: the scene, the two canvases, and the accent.
 *
 * IT COMPILES, RATHER THAN READING A STORED PICTURE (#471). A Look used to
 * carry its backdrop's resolved CSS beside the choice, so a thumbnail could
 * just read `backdrop.resolved[mode]`. A composition carries the LAYERS, which
 * is the thing that can differ per state — so the tile runs the same compiler
 * the app does, on that state's stack. One answer to "what does this paint",
 * not a cached second opinion that could disagree with the window.
 */

import { useMemo } from "react";
import type { Look } from "@/lib/looks";
import { compositionHalf, MODES, type CompositionMode } from "@/lib/composition";
import { composeState } from "@/lib/scene-composer";
import { cn } from "@/lib/utils";

/** One half of the tile: the state's scene over the state's canvas. */
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
    <span className={cn("absolute inset-y-0 overflow-hidden", className)} style={{ background: half.background }}>
      {scene && (
        // `cover` for every entry rather than the compiled list: a 56px tile
        // cannot honour a layer positioned at 12% of a window, and trying makes
        // a picture that says nothing about the look.
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
      {/* The mini panel, straddling the seam so it is legible on either half. */}
      <span
        className="absolute inset-x-[18%] top-[30%] flex h-[40%] items-center overflow-hidden rounded-[3px] shadow-1"
        style={{ background: dark.card, border: `1px solid ${dark.border}` }}
      >
        <span className="h-full w-[3px] shrink-0" data-accent={look.accent} style={{ background: "var(--primary)" }} />
        <span className="ml-1 h-[3px] w-[45%] rounded-full" style={{ background: dark.foreground, opacity: 0.55 }} />
      </span>
    </span>
  );
}
