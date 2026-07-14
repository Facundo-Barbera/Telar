"use client";

// Lane-local, theme-aware shimmer for the chat-lane demos.
//
// ROOT CAUSE (why the earlier tokenized clip-text fix did NOT hold): the
// previous version painted the label with `background-clip: text; color:
// transparent` and sourced its colour from custom properties INSIDE the
// clipped gradient (var(--foreground) sweeping over var(--muted-foreground)).
// That is a fundamentally different paint path from ordinary text — it ignores
// the element's `color`, so it is NOT driven by the class-based colour
// utilities (`text-muted-foreground` → `color: var(--muted-foreground)`, since
// globals.css declares those tokens with `@theme inline`) that every other
// label in the panel uses. ThemePair's LIGHT panel injects the light token set
// as INLINE custom properties on an ancestor and relies on inheritance; a
// `color:`-based utility re-resolves against that override (which is why the
// plain mono args flip correctly), but the WebKit build the app targets does
// NOT re-resolve the same inherited vars inside a `background-clip: text`
// gradient, so the clipped label keeps painting with stale/washed values.
// Swapping WHICH token the sweep used (fc7d86c) could never fix this: the
// failure is the paint MECHANISM, not the token choice.
//
// FIX: the base label is now ORDINARY solid text coloured with
// `text-muted-foreground` — the exact same class-based mechanism as every
// other label, so it re-themes correctly and stays fully legible at EVERY
// animation phase in BOTH panels. The shimmer is a SECOND, aria-hidden copy in
// `text-foreground` laid exactly on top and revealed only through a moving
// mask band, so it merely BRIGHTENS a travelling stripe. It never subtracts
// from the base, so the label can never wash out.
//
// NOTE FOR SHIP: production Shimmer (components/ai-elements/shimmer.tsx) has
// the same defect for the same reason — it clips text and sweeps
// `var(--color-background)`, which is white on a light surface. It needs this
// same base-text + mask-overlay rework (not merely a token swap) before the
// app gains a light theme, or it will wash out identically.

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
  const MotionSpan = getMotionComponent("span");

  // Width of the bright mask band, scaled to the label length (mirrors the
  // prior behaviour so short labels get a proportionally tighter sweep).
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  // A travelling stripe that is opaque (alpha 1 → reveals the overlay) only in
  // a narrow band and transparent elsewhere. Prefixed + unprefixed for the
  // WebKit build the app targets.
  const maskImage = `linear-gradient(90deg, #0000 calc(50% - var(--shimmer-spread)), #000 50%, #0000 calc(50% + var(--shimmer-spread)))`;

  return (
    // Base label: plain, solid, class-coloured text. Same paint path as every
    // other label in the panel → always legible, re-themes in both panels.
    <Component className={cn("relative inline-block text-muted-foreground", className)}>
      {children}
      {/* Sweep overlay: a brighter copy exactly on top, revealed only through a
          moving mask band. Additive only — it can never dim the base. */}
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
            // Both prefixes read the animated position var below, so the sweep
            // works whether the engine honours the prefixed or unprefixed mask.
            WebkitMaskPosition: "var(--shimmer-x) center",
            maskPosition: "var(--shimmer-x) center",
          } as CSSProperties
        }
        // Motion interpolates the custom property frame-by-frame (typed via the
        // `--` key it accepts); mask-position reads it. Prefixed mask keys are
        // not in Motion's target type, hence the var indirection.
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
