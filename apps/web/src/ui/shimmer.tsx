"use client";

import type { CSSProperties, ElementType } from "react";
import { memo, useMemo } from "react";
import { cn } from "@/ui/utils";

export interface ShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({ children, as: Component = "p", className, duration = 2, spread = 2 }: ShimmerProps) => {
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

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
