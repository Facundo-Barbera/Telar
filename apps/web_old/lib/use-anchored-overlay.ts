"use client";

// Shared "round-4" overlay positioning for the heartbeat-bar pills (cost + CTX)
// and anything else that floats an anchored card. The bug it fixes: an
// `absolute right-0 top-full` card is laid out relative to its pill, so a wide
// card near the viewport's right edge (or under the sub-agent rail) spills past
// the screen with no way to clamp it. This hook floats the card `position:fixed`
// with coordinates MEASURED from the anchor's getBoundingClientRect on open and
// recomputed on scroll/resize — then clamps it into the viewport with an 8px
// margin and flips it above the anchor when there's no room below. Zero reflow:
// the card is out of flow, so opening it never nudges the bar.
//
// SSR-safe: coords start null (both server + first client paint agree on the
// off-screen placeholder), then a layout effect measures client-side.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type OverlayAlign = "start" | "end";

export interface AnchoredOverlay<
  A extends HTMLElement = HTMLElement,
  F extends HTMLElement = HTMLElement,
> {
  anchorRef: React.RefObject<A | null>;
  floatRef: React.RefObject<F | null>;
  /** Ready-to-spread style for the floating card (position:fixed + coords). */
  style: React.CSSProperties;
  /** True once measured — drive the card's opacity off this to avoid a flash. */
  ready: boolean;
}

const MARGIN = 8; // viewport inset kept on every side
const GAP = 6; // space between the anchor and the card

/**
 * Anchor a floating card to `anchorRef`, opened when `open` is true.
 * `align` picks which of the card's edges tracks the anchor before clamping:
 *   - "end"  (default): card's right edge aligns to the anchor's right edge
 *   - "start": card's left edge aligns to the anchor's left edge
 * Either way the result is clamped into the viewport, so a card that would
 * spill simply slides back in; vertically it drops below the anchor and flips
 * above when the bottom would overflow.
 */
export function useAnchoredOverlay<
  A extends HTMLElement = HTMLElement,
  F extends HTMLElement = HTMLElement,
>(open: boolean, align: OverlayAlign = "end"): AnchoredOverlay<A, F> {
  const anchorRef = useRef<A | null>(null);
  const floatRef = useRef<F | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null,
  );

  useIsoLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      const card = floatRef.current;
      if (!anchor || !card) return;
      const a = anchor.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left = align === "end" ? a.right - c.width : a.left;
      left = Math.min(Math.max(left, MARGIN), vw - c.width - MARGIN);

      // Default below the anchor; flip above when the bottom would overflow and
      // there's more room up top.
      let top = a.bottom + GAP;
      const below = vh - a.bottom - GAP;
      const above = a.top - GAP;
      if (c.height > below && above > below) top = a.top - GAP - c.height;
      top = Math.min(Math.max(top, MARGIN), vh - c.height - MARGIN);

      setCoords({ left, top });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true); // capture: any scroll container
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, align]);

  return {
    anchorRef,
    floatRef,
    ready: coords !== null,
    style: {
      position: "fixed",
      left: coords ? coords.left : -9999,
      top: coords ? coords.top : -9999,
    },
  };
}
