"use client";

/**
 * THE PALETTE'S ONE DOOR ONTO THE SETTINGS STORES (issue #479).
 *
 * The Quick settings rows apply immediately, through exactly the stores the
 * Settings pane writes — the colour scheme's own store
 * (components/theme-provider.tsx), the appearance store (lib/appearance.ts),
 * the Looks shelf and `applyLook` (lib/looks.ts), the theme library that a worn
 * Look installs into (lib/theme-palettes.ts), and the shell's vibrancy bridge
 * (lib/desktop-appearance.ts). Nothing is reimplemented here: a quick row and
 * the pane's own control are the same write, or the two would drift.
 *
 * WHY IT IS ONE FILE, AND DELIBERATELY THIN. #471 reworks Appearance to direct
 * apply and may rename these stores. Every setter the palette needs is behind
 * this module, so that rebase is this file and nothing else — the palette's
 * fold (lib/command-palette.ts) knows only a `QuickSettingsState` of plain
 * strings and numbers, and the dialog knows only the rows and `apply`.
 *
 * WHAT IT IS NOT. It holds no state of its own and caches nothing: every value
 * is read live from the store that owns it, so a row's readout is the truth at
 * the moment the list was built rather than a copy taken when the palette
 * opened.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme, type Theme } from "@/components/theme-provider";
import {
  ACCENTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useAppearance,
  type Accent,
} from "@/lib/appearance";
import { desktopAppearance } from "@/lib/desktop-appearance";
import { applyLook, lookThemeId, useLooks, type Look } from "@/lib/looks";
import { useThemeLibrary } from "@/lib/theme-palettes";
import { quickSettings, type PaletteQuickSetting, type QuickSettingId } from "@/lib/command-palette";
import { runCommand } from "@/lib/commands";

/**
 * The eight accents, named for a reader.
 *
 * Spelled here rather than imported from the studio's tools.tsx, which keeps
 * its copy private: that file is a settings pane full of draft-editing
 * machinery, and importing a component module for one label map would drag all
 * of it into the palette's bundle. Eight strings are cheaper than that
 * coupling — and when #471 renames the vocabulary, this is already the file
 * that moves.
 */
export const ACCENT_LABELS: Record<Accent, string> = {
  indigo: "Indigo",
  sky: "Sky",
  sea: "Sea",
  moss: "Moss",
  amber: "Amber",
  rose: "Rose",
  plum: "Plum",
  violet: "Violet",
};

/** Light → Dark → System → Light. A cycle rather than three rows: the scheme is
 *  one setting with three values, and three rows of which two are always wrong
 *  is a section pretending to be a menu. */
const SCHEME_CYCLE: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };

export type QuickSettings = {
  /** The rows to draw, in the fold's fixed order. */
  rows: PaletteQuickSetting[];
  /** The shelf, for the Looks page. */
  looks: Look[];
  /** Which Look is being worn, or undefined — so its row can show a tick. */
  wornLookId: string | undefined;
  accent: Accent;
  /**
   * Run a row that applies in place. The two rows that are doors
   * ("quick-look", "quick-accent") are walked by the dialog and never reach
   * this. Returns a message when part of the change could not be made.
   */
  apply: (id: QuickSettingId) => string | undefined;
  /** Wear one Look from the page. Same return: a Look is worth wearing without
   *  its wallpaper, and the message says what was dropped. */
  wearLook: (look: Look) => string | undefined;
  setAccent: (accent: Accent) => void;
};

export function useQuickSettings({ railOpen }: { railOpen: boolean }): QuickSettings {
  const { theme, setTheme } = useTheme();
  const { appearance, setAppearance } = useAppearance();
  const { activeId, themes, saveCustom, setActive } = useThemeLibrary();
  const looks = useLooks();

  /**
   * TRANSLUCENCY HAS TO BE ASKED, not assumed from the bridge's presence: it is
   * macOS-only, and a Windows or Linux shell answers `supported: false`. The
   * row is absent until the answer arrives, which is the same stance the
   * Appearance pane takes — better a row that appears a beat late than one that
   * is there and then is not.
   */
  const [translucency, setTranslucency] = useState(false);
  useEffect(() => {
    const bridge = desktopAppearance();
    if (!bridge) return;
    let live = true;
    void bridge
      .get()
      .then((state) => live && setTranslucency(state.supported))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /** The Look being worn, when the library's active theme is one a Look
   *  installed. Anything else — a hand-edited palette, a starter theme — is
   *  honestly not a Look, and the row says nothing rather than guessing. */
  const worn = looks.find((look) => lookThemeId(look) === activeId);

  const rows = useMemo(
    () =>
      quickSettings({
        scheme: theme,
        look: worn?.label ?? "",
        accent: ACCENT_LABELS[appearance.accent],
        fontSize: appearance.fontSize,
        translucent: appearance.translucent,
        translucency,
        railOpen,
      }),
    [theme, worn?.label, appearance.accent, appearance.fontSize, appearance.translucent, translucency, railOpen],
  );

  const wearLook = useCallback(
    (look: Look) => applyLook(look, { saveCustom, setActive, themes }, setAppearance),
    [saveCustom, setActive, themes, setAppearance],
  );

  const setAccent = useCallback((accent: Accent) => setAppearance({ accent }), [setAppearance]);

  const apply = useCallback(
    (id: QuickSettingId): string | undefined => {
      switch (id) {
        case "quick-colour-scheme":
          setTheme(SCHEME_CYCLE[theme]);
          return undefined;
        case "quick-font-size-smaller":
          setAppearance({ fontSize: Math.max(MIN_FONT_SIZE, appearance.fontSize - 1) });
          return undefined;
        case "quick-font-size-larger":
          setAppearance({ fontSize: Math.min(MAX_FONT_SIZE, appearance.fontSize + 1) });
          return undefined;
        case "quick-translucency": {
          // BOTH HALVES, as the pane does it: the renderer's alpha surfaces
          // come from the store, and the vibrancy layer the page cannot create
          // comes from the shell.
          const next = !appearance.translucent;
          setAppearance({ translucent: next });
          void desktopAppearance()?.set({ translucent: next });
          return undefined;
        }
        case "quick-rail":
          // THE COMMAND, not a second implementation of it. The rail binds
          // `toggle-rail` while it is mounted, and this row is that command
          // wearing a readout — see PALETTE_QUICK_COMMANDS.
          runCommand("toggle-rail");
          return undefined;
        // The two doors are walked by the dialog; they never apply in place.
        case "quick-look":
        case "quick-accent":
          return undefined;
      }
    },
    [theme, setTheme, appearance.fontSize, appearance.translucent, setAppearance],
  );

  return {
    rows,
    looks,
    wornLookId: worn?.id,
    accent: appearance.accent,
    apply,
    wearLook,
    setAccent,
  };
}

export { ACCENTS, type Accent };
