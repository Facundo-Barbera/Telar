"use client";

import { useEffect, useRef, useState } from "react";
import {
  HINT_HOLD_MS,
  isHintModifierKey,
  isMacPlatformString,
  nextHintState,
  type HintSignal,
  type HintState,
} from "@/lib/command-key-hints";

/**
 * The DOM half of the hold-to-reveal command-key hints: translates window
 * events into command-key-hints.ts's signals and runs the one arming timer.
 * All the BEHAVIOR lives in nextHintState — this hook must stay a thin
 * translation layer, because it is the untestable half (no DOM harness in
 * this repo; see command-keys-wiring.test.ts for the structural pin).
 *
 * Returns whether hints should be visible right now. False on the server
 * and at first paint by construction — visibility only ever starts from a
 * live keydown — so there is nothing here for hydration to disagree over.
 */
export function useCommandKeyHints(): boolean {
  const [showing, setShowing] = useState(false);
  const state = useRef<HintState>("idle");

  useEffect(() => {
    let timer: number | null = null;

    const apply = (signal: HintSignal) => {
      const next = nextHintState(state.current, signal);
      if (next === state.current) return;
      // Any transition ends the pending hold: leaving "arming" for either
      // neighbor means the timer is spent or moot. nextHintState already
      // ignores a stale "hold-elapsed", so this clear is hygiene, not the
      // correctness mechanism.
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (next === "arming") {
        timer = window.setTimeout(() => apply("hold-elapsed"), HINT_HOLD_MS);
      }
      state.current = next;
      setShowing(next === "showing");
    };

    const onKeyDown = (event: KeyboardEvent) =>
      apply(isHintModifierKey(event.key) ? "modifier-down" : "other-key");
    const onKeyUp = (event: KeyboardEvent) => {
      if (isHintModifierKey(event.key)) apply("modifier-up");
    };
    // ⌘Tab: the keyup lands in whatever app got focus, never here — without
    // these two, switching away while showing would strand the hints on.
    const onBlur = () => apply("window-away");
    const onVisibility = () => {
      if (document.visibilityState === "hidden") apply("window-away");
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return showing;
}

/** Which modifier glyph this machine's hints should wear. Read once — a
 *  platform does not change under a running page. */
export function useMacPlatform(): boolean {
  const [mac] = useState(
    () =>
      typeof navigator !== "undefined" &&
      isMacPlatformString(navigator.platform || navigator.userAgent),
  );
  return mac;
}
