"use client";

// Lane-local, theme-aware shimmer for the chat-lane demos.
//
// WHY THIS EXISTS: the production Shimmer (components/ai-elements/shimmer.tsx)
// sweeps a band of `--color-background` across text painted in
// `--color-muted-foreground`. In a LIGHT panel that band is white, so the label
// fades to near-invisible against the white card as it animates — the shimmer
// reads as washed-out (user-reported, screenshots confirm).
//
// Here the gradient is built from the panel's own foreground/muted-foreground
// tokens: the base is `--muted-foreground` and the moving highlight is the
// stronger `--foreground` — text only ever brightens toward the readable
// foreground, never toward the background. Because both come from the tokens
// that ThemePair overrides inline, it re-themes correctly in light and dark.
//
// NOTE FOR SHIP: production Shimmer needs this same tokenization (swap
// `--color-background` in its sweep for `--foreground`) so it stops washing out
// on light surfaces once the app gains a light theme.

import { cn } from "@/lib/utils";
import type { MotionProps } from "motion/react";
import { motion } from "motion/react";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;

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

export interface ShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: ShimmerProps) => {
  const MotionComponent = getMotionComponent(
    Component as keyof JSX.IntrinsicElements,
  );

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--foreground),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--muted-foreground), var(--muted-foreground))",
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
