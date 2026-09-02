"use client";

/**
 * The host's look, told to the engine.
 *
 * WHY A BROWSER HAS TO PUBLISH ANYTHING. Every other preference in this product
 * lives in the engine because it is a fact about the machine. Appearance does
 * not: accent, typefaces, text size, translucency, the backdrop and the active
 * theme pair are all in localStorage, because that is where a person configures
 * them and where they must survive a reload with no engine at all. That makes
 * this browser the ONLY thing on the machine that knows what the cockpit looks
 * like — and a paired iOS client, which wants to wear the same customization,
 * has no way to read it. So the cockpit republishes its RESOLVED look, and the
 * engine becomes the one address every device can ask.
 *
 * RESOLVED, NOT REFERENTIAL. The payload carries concrete theme halves rather
 * than theme ids: a custom theme exists only in this browser's storage, and an
 * id the reader cannot look up is worth nothing. `concreteHalf` fills every
 * token, so a client can paint from the blob alone.
 *
 * THE PAIR IS TWO CHOICES, not one. The library lets the light and dark halves
 * come from different themes, so each half is resolved from its own theme —
 * collapsing them to `activeId` would silently drop a deliberate mix.
 *
 * IT RENDERS NOTHING and it FAILS SILENTLY. Publishing is decoration for
 * somebody else's device; an engine that is down, locked, or unpaired must cost
 * this window nothing, least of all a console full of red every two seconds.
 */

import { useEffect } from "react";
import { useAppearance } from "@/lib/appearance";
import { useBackdrop } from "@/lib/backdrop";
import { createEngineApi } from "@/lib/engine/client";
import { concreteHalf, useThemeLibrary } from "@/lib/theme-palettes";

const api = createEngineApi();

/**
 * Long enough that dragging the translucency slider is one publish rather than
 * eighty, short enough that a phone opened right after a change sees it.
 */
const PUBLISH_DEBOUNCE_MS = 2_000;

/**
 * MODULE-LEVEL, not per-mount: React may unmount and remount this in
 * development, and a fingerprint that reset with the component would republish
 * an identical blob on every one. It holds the last payload that actually
 * LANDED, so a failed publish is retried by the next change rather than
 * remembered as done.
 */
let published: string | undefined;

/** The published vocabulary's version. Bumped only if a key's MEANING changes —
 *  added keys need no bump, because readers here are additive-tolerant. */
const APPEARANCE_VERSION = 1;

export function AppearancePublisher(): null {
  const { appearance } = useAppearance();
  const { backdrop } = useBackdrop();
  const { active, themes } = useThemeLibrary();

  useEffect(() => {
    // The stores answer with server defaults during SSR; publishing those would
    // overwrite a real look with a placeholder.
    if (typeof window === "undefined") return;

    const lightTheme = themes.find((theme) => theme.id === active.light) ?? themes[0];
    const darkTheme = themes.find((theme) => theme.id === active.dark) ?? themes[0];
    if (!lightTheme || !darkTheme) return;

    const payload = {
      version: APPEARANCE_VERSION,
      accent: appearance.accent,
      fontSans: appearance.fontSans,
      fontMono: appearance.fontMono,
      fontSize: appearance.fontSize,
      translucent: appearance.translucent,
      translucencyLevel: appearance.translucencyLevel,
      // The KIND only. The resolved layers are a gradient string or a wallpaper
      // data URL — the second would blow past the engine's 64 KB cap on its own,
      // and neither means anything to a client that cannot see this desktop.
      backdrop: backdrop.kind,
      theme: { light: concreteHalf(lightTheme, "light"), dark: concreteHalf(darkTheme, "dark") },
    };

    const fingerprint = JSON.stringify(payload);
    if (fingerprint === published) return;

    const timer = setTimeout(() => {
      void api
        .setAppearance(payload)
        .then(() => {
          published = fingerprint;
        })
        .catch(() => {
          // An engine that is down, locked, or not paired is an ordinary state
          // for this window. The next change tries again.
        });
    }, PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [appearance, backdrop, active, themes]);

  return null;
}
