"use client";

import { useEffect } from "react";
import type { AppFont, PublishedAppearance } from "@telar/engine-client";
import { ACCENT_COLOURS, LIGHT_PRIMARY_FOREGROUND } from "../accent-colours";
import { useAppearance } from "../appearance";
import { useComposition } from "../composition";
import { createEngineApi } from "@/platform/engine";
import { isHostWindow } from "@/platform/desktop/host-window";
import { captureLook } from "../looks";
import { readTheme, useTheme } from "./theme-provider";

const api = createEngineApi();

const PUBLISH_DEBOUNCE_MS = 2_000;

let published: string | undefined;

const SANS_TAIL = "ui-sans-serif, system-ui, sans-serif";
const MONO_TAIL = "ui-monospace, SFMono-Regular, Menlo, monospace";

type SharedFace = Exclude<AppFont, "geist" | "system" | "custom">;

const FACE_STACKS: Record<SharedFace, string> = {
  inter: `"Inter", ${SANS_TAIL}`,
  "plex-sans": `"IBM Plex Sans", ${SANS_TAIL}`,
  "source-sans": `"Source Sans 3", ${SANS_TAIL}`,
  roboto: `"Roboto", ${SANS_TAIL}`,
  "noto-sans": `"Noto Sans", ${SANS_TAIL}`,
  "space-grotesk": `"Space Grotesk", ${SANS_TAIL}`,
  lato: `"Lato", ${SANS_TAIL}`,
  jetbrains: `"JetBrains Mono", ${MONO_TAIL}`,
  "plex-mono": `"IBM Plex Mono", ${MONO_TAIL}`,
  "fira-code": `"Fira Code", ${MONO_TAIL}`,
  "geist-mono": `"Geist Mono", ${MONO_TAIL}`,
  "source-code-pro": `"Source Code Pro", ${MONO_TAIL}`,
  "roboto-mono": `"Roboto Mono", ${MONO_TAIL}`,
  "cascadia-code": `"Cascadia Code", ${MONO_TAIL}`,
};

const SANS_STACKS: Record<AppFont, string> = {
  ...FACE_STACKS,
  geist: `"Geist", ${SANS_TAIL}`,
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  custom: SANS_TAIL,
};

const MONO_STACKS: Record<AppFont, string> = {
  ...FACE_STACKS,
  geist: `"Geist Mono", ${MONO_TAIL}`,
  system: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  custom: MONO_TAIL,
};

function stack(choice: string, typed: string, fallbacks: string): string {
  if (choice !== "custom") return fallbacks;
  const families = typed
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => (/^(['"]).*\1$/.test(name) || /^[a-zA-Z][a-zA-Z0-9-]*$/.test(name) ? name : `"${name.replaceAll('"', "")}"`));
  return families.length > 0 ? `${families.join(", ")}, ${fallbacks}` : fallbacks;
}

export function AppearancePublisher(): null {
  const { appearance } = useAppearance();
  const { composition, images } = useComposition();
  const { theme } = useTheme();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isHostWindow()) return;

    const accent = ACCENT_COLOURS[appearance.accent];
    const payload: PublishedAppearance = {
      version: 2,
      updatedAtHint: Date.now(),
      scheme: readTheme(),
      translucent: appearance.translucent,
      frost: appearance.frost,
      resolved: {
        accent: {
          name: appearance.accent,
          light: { primary: accent.light, primaryForeground: LIGHT_PRIMARY_FOREGROUND },
          dark: accent.dark,
        },
        fontStacks: {
          sans: stack(appearance.fontSans, appearance.fontSansCustom, SANS_STACKS[appearance.fontSans]),
          mono: stack(appearance.fontMono, appearance.fontMonoCustom, MONO_STACKS[appearance.fontMono]),
        },
      },
      look: { ...captureLook("Published look"), id: "published" },
    };

    const { updatedAtHint: _hint, ...content } = payload;
    const fingerprint = JSON.stringify(content);
    if (fingerprint === published) return;

    const timer = setTimeout(() => {
      void api
        .setAppearance(payload)
        .then(() => {
          published = fingerprint;
        })
        .catch(() => {
        });
    }, PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [appearance, composition, images, theme]);

  return null;
}
