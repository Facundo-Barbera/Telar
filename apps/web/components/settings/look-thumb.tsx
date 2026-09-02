"use client";

/**
 * THE LOOK THUMBNAIL — a look, at a glance, as a tiny Telar.
 *
 * A shelf of names is not a shelf of looks. This paints what the Look actually
 * does: its backdrop (or its bare canvas, when it brings none), light on the
 * left and dark on the right because a Look is a pair, with a MINIATURE PANEL
 * floating on top — a card-coloured rectangle wearing the 3px accent rail from
 * components/ui/panel.tsx. So the tile says three things without a word of
 * copy: the scene, the two canvases, and the accent.
 */

import type { Look, LookBackdrop } from "@/lib/looks";
import { cn } from "@/lib/utils";

/** What paints behind the app in one half — the scene if there is one, and
 *  otherwise nothing, so the caller falls back to that half's canvas. */
function sceneCss(backdrop: LookBackdrop, mode: "light" | "dark"): string | undefined {
  if (backdrop.kind === "none") return undefined;
  // A data URL from the draft; `url("…")` because base64 can carry no quote.
  if (backdrop.kind === "image") return `url("${backdrop.image}")`;
  return backdrop.resolved[mode];
}

/** One half of the tile: the scene over the canvas, with a mini panel on it. */
function Half({ look, mode, className }: { look: Look; mode: "light" | "dark"; className?: string }) {
  const half = look.theme[mode];
  const scene = sceneCss(look.backdrop, mode);
  return (
    <span className={cn("absolute inset-y-0 overflow-hidden", className)} style={{ background: half.background }}>
      {scene && <span className="absolute inset-0" style={{ backgroundImage: scene, backgroundSize: "cover", backgroundPosition: "center" }} />}
    </span>
  );
}

export function LookThumb({ look, className }: { look: Look; className?: string }) {
  return (
    <span className={cn("relative block aspect-video w-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10", className)}>
      <Half look={look} mode="light" className="left-0 w-1/2" />
      <Half look={look} mode="dark" className="right-0 w-1/2" />
      {/* The mini panel, straddling the seam so it is legible on either half. */}
      <span
        className="absolute inset-x-[18%] top-[30%] flex h-[40%] items-center overflow-hidden rounded-[3px] shadow-sm"
        style={{ background: look.theme.dark.card, border: `1px solid ${look.theme.dark.border}` }}
      >
        <span className="h-full w-[3px] shrink-0" data-accent={look.accent} style={{ background: "var(--primary)" }} />
        <span className="ml-1 h-[3px] w-[45%] rounded-full" style={{ background: look.theme.dark.foreground, opacity: 0.55 }} />
      </span>
    </span>
  );
}
