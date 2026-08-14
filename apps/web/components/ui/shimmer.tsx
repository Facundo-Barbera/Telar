"use client";

import type { CSSProperties, ElementType } from "react";
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * A travelling highlight, in plain CSS.
 *
 * NO ANIMATION LIBRARY, ON PURPOSE. The sweep is the `telar-shimmer` keyframe in
 * globals.css. This is on the transcript's critical path — every running tool
 * row and the working indicator mount one — so pulling a physics-capable
 * animation runtime in for a linear mask translation would put hundreds of
 * kilobytes into the initial client graph of every session route.
 *
 * MASK-BASED, NOT `bg-clip-text`. The base label is ORDINARY solid
 * class-coloured text on the same paint path every other label uses, so it
 * re-themes correctly and stays fully legible at every phase of the animation.
 * The shimmer is a SECOND, aria-hidden copy in `text-foreground` laid exactly on
 * top and revealed only through a moving band, so it can only ever BRIGHTEN a
 * travelling stripe — it can never wash the base out, which is what a
 * background-clip sweep does the moment the app gains a light surface.
 */
export interface ShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({ children, as: Component = "p", className, duration = 2, spread = 2 }: ShimmerProps) => {
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  // Opaque (revealing the overlay) only in a narrow band, transparent elsewhere.
  const maskImage =
    "linear-gradient(90deg, #0000 calc(50% - var(--shimmer-spread)), #000 50%, #0000 calc(50% + var(--shimmer-spread)))";

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
            // Parked where the keyframe starts, so a reduced-motion user — for
            // whom the animation never runs — sees the mask OFF the text rather
            // than frozen mid-sweep across it.
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
