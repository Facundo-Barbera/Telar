"use client";

import { useEffect, useState } from "react";

export type KeyCapPlatform = "mac" | "other";

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

const KEY_GLYPHS: Record<string, string> = {
  Return: "↩",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Space: "␣",
};

export function keyCaps(chord: string, platform: KeyCapPlatform): string[] {
  if (!chord) return [];
  const named = platform === "mac" ? MAC_GLYPHS : OTHER_NAMES;
  return chord
    .split("+")
    .map((part) => named[part.toLowerCase()] ?? KEY_GLYPHS[part] ?? (part.length === 1 ? part.toUpperCase() : part));
}

export function keyCapText(chord: string, platform: KeyCapPlatform): string {
  const caps = keyCaps(chord, platform);
  return caps.join(platform === "mac" ? "" : "+");
}

export function keyCapPlatformFor(agent: string): KeyCapPlatform {
  return /mac|iphone|ipad|ipod/i.test(agent) ? "mac" : "other";
}

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
