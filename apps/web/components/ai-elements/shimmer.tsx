"use client";

import { cn } from "@/lib/utils";
import type { MotionProps } from "motion/react";
import { motion } from "motion/react";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;

// Cache motion components at module level to avoid creating during render
const motionComponentCache = new Map<
  keyof JSX.IntrinsicElements,
  React.ComponentType<MotionHTMLProps>
>();

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

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
  const MotionSpan = getMotionComponent("span");

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
      <MotionSpan
        aria-hidden
        className="pointer-events-none absolute inset-0 text-foreground"
        style={
          {
            "--shimmer-spread": `${dynamicSpread}px`,
            WebkitMaskImage: maskImage,
            maskImage,
            WebkitMaskSize: "250% 100%",
            maskSize: "250% 100%",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "var(--shimmer-x) center",
            maskPosition: "var(--shimmer-x) center",
          } as CSSProperties
        }
        initial={{ "--shimmer-x": "100%" }}
        animate={{ "--shimmer-x": "0%" }}
        transition={{
          duration,
          ease: "linear",
          repeat: Number.POSITIVE_INFINITY,
        }}
      >
        {children}
      </MotionSpan>
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
