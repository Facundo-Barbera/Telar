"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo, useMemo } from "react";

// NO ANIMATION LIBRARY HERE, ON PURPOSE. The sweep below is a plain CSS
// keyframe (`telar-shimmer`, in app/globals.css). This component is imported by
// nine modules, two of them — working-indicator.tsx and tool-step.tsx — on the
// transcript's critical path, so importing `motion/react` for it put 685KB of
// unminified animation runtime into the initial client graph of every
// transcript route in dev. Keep it dependency-free; if this ever needs real
// spring physics, lazy-load that variant rather than importing it here.

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

// Mask-based shimmer (see the chat-lane demo's root-cause note): the base label
// is ORDINARY solid class-coloured text (`text-muted-foreground`) — the same
// paint path every other label uses, so it re-themes correctly and stays fully
// legible at every animation phase. The shimmer is a SECOND, aria-hidden copy
// in `text-foreground` laid exactly on top and revealed only through a moving
// mask band, so it merely BRIGHTENS a travelling stripe and can never wash the
// base out. This replaces the earlier `bg-clip-text` + `var(--color-background)`
// sweep, which WebKit does not re-resolve against inherited tokens and which
// painted white-on-white the instant the app gains any light surface.
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  // A travelling stripe that is opaque (reveals the overlay) only in a narrow
  // band and transparent elsewhere. Prefixed + unprefixed for WebKit.
  const maskImage = `linear-gradient(90deg, #0000 calc(50% - var(--shimmer-spread)), #000 50%, #0000 calc(50% + var(--shimmer-spread)))`;

  return (
    <Component className={cn("relative inline-block text-muted-foreground", className)}>
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 text-foreground motion-safe:animate-[telar-shimmer_var(--shimmer-duration)_linear_infinite]"
        style={
          {
            "--shimmer-spread": `${dynamicSpread}px`,
            "--shimmer-duration": `${duration}s`,
            WebkitMaskImage: maskImage,
            maskImage,
            WebkitMaskSize: "250% 100%",
            maskSize: "250% 100%",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            // Start where the keyframe starts, so a reduced-motion user (for
            // whom the animation never runs) sees the mask parked off the text
            // rather than frozen mid-sweep across it.
            WebkitMaskPosition: "100% center",
            maskPosition: "100% center",
          } as CSSProperties
        }
      >
        {children}
      </span>
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
