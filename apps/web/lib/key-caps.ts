"use client";

/**
 * A CHORD AS THE CAPS A READER SEES — and which keyboard they are reading.
 *
 * THIS USED TO LIVE IN `settings/keybindings-page.tsx`, which was the only
 * surface that drew a chord. #401 gives every control bound to one the same
 * caps, in place, while the command modifier is held — so the formatter is now
 * shared by a settings row, a rail row, a menu row and a panel tab, and a
 * settings page is not where four of those should import it from.
 *
 * NOTHING ELSE MOVED WITH IT. The pane keeps its rows, its recorder and its
 * fold; this file is the two questions any of them would ask — "what does this
 * chord look like" and "on whose keyboard".
 */

import { useEffect, useState } from "react";

/**
 * Which key names a reader is looking at. The chords are `CommandOrControl+…`
 * by design (issue #16), so the SAME map reads ⌘ on a Mac and Ctrl on a Windows
 * build — a cap that hardcoded one would be wrong on the other rather than
 * merely unstyled.
 */
export type KeyCapPlatform = "mac" | "other";

/** Modifier glyphs, in the register macOS itself uses on a menu. */
const MAC_GLYPHS: Record<string, string> = {
  commandorcontrol: "⌘",
  command: "⌘",
  cmd: "⌘",
  control: "⌃",
  ctrl: "⌃",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
};

/** The same modifiers spelled out, where there are no glyphs for them. */
const OTHER_NAMES: Record<string, string> = {
  commandorcontrol: "Ctrl",
  command: "Ctrl",
  cmd: "Ctrl",
  control: "Ctrl",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
};

/** Keys whose accelerator token is not what a keyboard has printed on it. */
const KEY_GLYPHS: Record<string, string> = {
  Return: "↩",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Space: "␣",
};

/**
 * A chord as the caps a reader sees, one per key.
 *
 * A SPLIT RATHER THAN A STRING, because the row draws a box per key — "⌘ N" as
 * one cap reads as a key called "⌘ N". A single-character key is upper-cased
 * (`n` → `N`) and anything longer is left as the map wrote it unless it has a
 * glyph, so a future `PageDown` needs no entry here to render.
 *
 * AN UNBOUND COMMAND IS AN EMPTY ARRAY, not a placeholder. "" is a real value in
 * the keymap — deliberately unbound — and every caller draws nothing for it.
 */
export function keyCaps(chord: string, platform: KeyCapPlatform): string[] {
  if (!chord) return [];
  const named = platform === "mac" ? MAC_GLYPHS : OTHER_NAMES;
  return chord
    .split("+")
    .map((part) => named[part.toLowerCase()] ?? KEY_GLYPHS[part] ?? (part.length === 1 ? part.toUpperCase() : part));
}

/**
 * THE SAME CHORD AS ONE STRING, for somewhere a box per key cannot go — a
 * `title` attribute, an accessible name (#588).
 *
 * THE JOIN IS THE PLATFORM'S, not a separator picked once. macOS writes its
 * chords closed up (⇧⌘D) because the glyphs are already distinct; a keyboard
 * with no glyphs needs the plus signs or "CtrlShiftD" is one word.
 *
 * "" FOR AN UNBOUND COMMAND, exactly as `keyCaps` answers an empty array — so
 * the caller writes a tooltip with no chord in it rather than one promising a
 * key that does nothing.
 */
export function keyCapText(chord: string, platform: KeyCapPlatform): string {
  const caps = keyCaps(chord, platform);
  return caps.join(platform === "mac" ? "" : "+");
}

/** Which keyboard this browser is on, read from the agent string. Pure enough to
 *  test: the string comes in, the answer goes out. */
export function keyCapPlatformFor(agent: string): KeyCapPlatform {
  return /mac|iphone|ipad|ipod/i.test(agent) ? "mac" : "other";
}

/**
 * WHICH KEYBOARD, READ AFTER THE FIRST PAINT.
 *
 * The platform is a client fact and these surfaces render on the server first,
 * so seeding from `navigator` would make the two disagree about the same markup
 * — the reason every loader in this app defers a tick. macOS is the default
 * because the desktop shell is a Mac app; a browser on anything else corrects it
 * before the reader has finished reading the row.
 */
export function useKeyCapPlatform(): KeyCapPlatform {
  const [platform, setPlatform] = useState<KeyCapPlatform>("mac");
  useEffect(() => {
    const task = window.setTimeout(() => {
      setPlatform(keyCapPlatformFor(`${navigator.userAgent} ${navigator.platform ?? ""}`));
    }, 0);
    return () => window.clearTimeout(task);
  }, []);
  return platform;
}
