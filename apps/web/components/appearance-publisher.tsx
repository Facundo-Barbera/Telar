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
 * like — and a paired client, which wants to wear the same customization, has
 * no way to read it. So the cockpit republishes its look, and the engine
 * becomes the one address every device can ask.
 *
 * IT PUBLISHES A WHOLE `Look`, AND THAT IS THE POINT OF THIS FILE NOW. The
 * first version hand-rolled a second, poorer vocabulary — sixteen tokens per
 * half, an accent NAME, and the backdrop's KIND with a comment explaining that
 * the pixels would not fit. So the one thing a reader most wants to wear, the
 * wallpaper, was the one thing that never travelled, and the format drifted
 * from the Look format every time the studio grew. `captureLook` is the same
 * photograph the shelf and the export file take, and it goes over the wire
 * whole; the engine's cap was raised to fit it.
 *
 * WHAT RIDES BESIDE THE LOOK, and why it is beside rather than inside. A Look
 * is TASTE and must stay portable between machines. Three facts are about THIS
 * WINDOW: the colour scheme it is wearing (a Look carries both halves — which
 * one you are looking at is not part of it), and `translucent` / `frost`, which
 * are properties of a macOS desktop window that a Look deliberately refuses to
 * carry (see lib/looks.ts). They are reported so a reader can know; nothing
 * makes a reader apply them.
 *
 * AND THE RESOLVED HALF. `"amber"` and `"geist"` are lookups into THIS app's
 * stylesheet. A client that never loaded globals.css cannot turn them into
 * pixels, so the publisher resolves them: the accent's two tokens per scheme,
 * and real `font-family` stacks with the build-time font variables substituted
 * out. The names travel too — a client that DOES know them can prefer them.
 *
 * ONLY THE HOST PUBLISHES. A tailscale'd browser is the same app with the same
 * pairing and its own localStorage; two of them publishing means each clobbers
 * the other every two seconds and a phone reads whoever wrote last. See
 * lib/host-window.ts for how the question is decided.
 *
 * IT RENDERS NOTHING and it FAILS SILENTLY. Publishing is decoration for
 * somebody else's device; an engine that is down, locked, or unpaired must cost
 * this window nothing, least of all a console full of red every two seconds.
 */

import { useEffect } from "react";
import type { Accent, MonoFont, PublishedAppearance, SansFont } from "@telar/engine-client";
import { useAppearance } from "@/lib/appearance";
import { useBackdrop } from "@/lib/backdrop";
import { createEngineApi } from "@/lib/engine/client";
import { isHostWindow } from "@/lib/host-window";
import { captureLook } from "@/lib/looks";
import { useThemeLibrary } from "@/lib/theme-palettes";
import { readTheme, useTheme } from "@/components/theme-provider";

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

/**
 * THE ACCENT HUES, RESOLVED — the one restatement of app/globals.css's
 * `[data-accent="…"]` blocks.
 *
 * They cannot be READ from the stylesheet: `getComputedStyle` would only ever
 * report the accent this window is wearing, and the published look has to name
 * both schemes of the chosen one. And they cannot be REFERENCED: a client that
 * never loaded globals.css has no `--primary` to look up. So they are copied,
 * once, here — beside the publisher that is their only consumer.
 *
 * KEEP IN STEP WITH globals.css §ACCENTS. The `light` half is that file's
 * `[data-accent=x]` rule and the `dark` half its `.dark[data-accent=x]` rule.
 * Light needs no `--primary-foreground` of its own (the base token is already
 * correct against every accent at L 0.488), so light's foreground is the base
 * palette's value, restated once below.
 */
const LIGHT_PRIMARY_FOREGROUND = "oklch(1 0 0)";

const ACCENT_COLOURS: Record<Accent, { light: string; dark: { primary: string; primaryForeground: string } }> = {
  indigo: { light: "oklch(0.488 0.16 264)", dark: { primary: "oklch(0.68 0.16 264)", primaryForeground: "oklch(0.17 0.04 264)" } },
  sky: { light: "oklch(0.488 0.15 240)", dark: { primary: "oklch(0.68 0.15 240)", primaryForeground: "oklch(0.17 0.04 240)" } },
  sea: { light: "oklch(0.488 0.1 205)", dark: { primary: "oklch(0.68 0.11 205)", primaryForeground: "oklch(0.17 0.04 205)" } },
  moss: { light: "oklch(0.488 0.11 140)", dark: { primary: "oklch(0.68 0.13 140)", primaryForeground: "oklch(0.17 0.04 140)" } },
  amber: { light: "oklch(0.488 0.12 70)", dark: { primary: "oklch(0.68 0.14 70)", primaryForeground: "oklch(0.17 0.04 70)" } },
  rose: { light: "oklch(0.488 0.17 15)", dark: { primary: "oklch(0.68 0.17 15)", primaryForeground: "oklch(0.17 0.04 15)" } },
  plum: { light: "oklch(0.488 0.16 325)", dark: { primary: "oklch(0.68 0.15 325)", primaryForeground: "oklch(0.17 0.04 325)" } },
  violet: { light: "oklch(0.488 0.17 293)", dark: { primary: "oklch(0.68 0.16 293)", primaryForeground: "oklch(0.17 0.04 293)" } },
};

/**
 * THE TYPEFACE STACKS, RESOLVED — globals.css §TYPEFACES, with the build-time
 * font variables substituted out.
 *
 * `var(--font-geist-sans)` is a next/font handle: it names a self-hosted family
 * whose real name only this build knows, and it is meaningless to any client
 * that did not load this page. What a reader can actually use is the FAMILY
 * NAME, so each stack is written with the family spelt out and the same
 * fallbacks globals.css guarantees. A reader without the webfont lands on the
 * fallbacks, which is exactly what a "system" choice already means.
 */
const SANS_STACKS: Record<SansFont, string> = {
  geist: '"Geist", ui-sans-serif, system-ui, sans-serif',
  inter: '"Inter", ui-sans-serif, system-ui, sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  // Replaced below by the reader's own typed family; this is the fallback tail
  // the cockpit appends to it, and the answer when nothing was typed.
  custom: "ui-sans-serif, system-ui, sans-serif",
};

const MONO_STACKS: Record<MonoFont, string> = {
  geist: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  system: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  custom: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

/** A typed family in front of its fallbacks, quoted the way the store quotes it
 *  — and only when the choice is "custom" and something was actually typed. */
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
  const { backdrop } = useBackdrop();
  const { active, themes } = useThemeLibrary();
  // Subscribed rather than read once: changing the scheme is a publishable
  // change, and `readTheme` inside the effect is what actually reads it.
  const { theme } = useTheme();

  useEffect(() => {
    // The stores answer with server defaults during SSR; publishing those would
    // overwrite a real look with a placeholder.
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
      // The whole thing, wallpaper included. `captureLook` mints a fresh id per
      // call, which would defeat the fingerprint below — so the id is pinned to
      // the mailbox itself: there is exactly one published look.
      look: { ...captureLook("Published look"), id: "published" },
    };

    // `updatedAtHint` moves on every render and would defeat the comparison, so
    // the fingerprint is taken over everything else. It is the CONTENT that
    // decides whether a publish is worth making.
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
          // An engine that is down, locked, or not paired is an ordinary state
          // for this window. The next change tries again.
        });
    }, PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [appearance, backdrop, active, themes, theme]);

  return null;
}
