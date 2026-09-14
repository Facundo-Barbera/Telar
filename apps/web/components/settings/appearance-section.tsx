"use client";

/**
 * APPEARANCE — every control writes what it names, at once.
 *
 * THE ONE RULE, AND IT IS THE SHORT ONE NOW (#471):
 *
 *   TOUCH A CONTROL AND THE APP CHANGES. There is no draft, no Apply, no
 *   Discard, no undo stack and no masthead. A theme pick is `setHalf`; a token
 *   is `editActiveHalf`; an accent, a typeface, a size, the depth and the
 *   show-through are `setAppearance`; a backdrop is `wearBackdrop`. Every one
 *   of them is the same kind of write Translucency and Glass have always done
 *   on this pane, and the same kind every other settings pane in this app does.
 *
 * WHAT THE DRAFT COST. The pane held a whole `Look` nobody was wearing, painted
 * it onto the document to simulate wearing it, wrote it through to storage so
 * it survived navigation, kept a coalescing undo history of it, and gated the
 * one button that made it true. That machinery existed to answer a question the
 * settings grammar does not ask anywhere else — "is this saved?" — and it
 * answered it with a sticky bar of state chips above five groups of controls.
 * Removing it removed the question.
 *
 * SO WHAT HAPPENED TO THE THINGS THE MASTHEAD CARRIED?
 *
 *   The NAME FIELD named a draft. A card on the shelf is what has a name now,
 *   and it is renamed on its own row.
 *   SAVE LOOK moved into the Looks group, as a plain button beside the shelf it
 *   adds to (looks-section.tsx). It photographs the live stores, which is what
 *   saving means when there is nothing pending.
 *   The COLOUR SCHEME moved into Window, where it belongs: which half this
 *   window wears is a fact about the window, not part of a look. It is also the
 *   half every colour control on this pane edits — the palette rows, the
 *   gradient editor and the theme orbs all follow it, because a theme has two
 *   halves precisely so the answer can differ.
 *   UNDO is gone with the history. Nothing here destroys anything that is not
 *   one click from being put back: the shelf keeps whole looks, the library
 *   keeps whole palettes, and both are one click from being worn again.
 *
 * AND IT IS A SETTINGS PANE, NOT A STUDIO (#399). Stacked `SettingsGroup` cards
 * with a title and a sentence, exactly like inbox-section.tsx and
 * browser-profiles-section.tsx, in the order the work reads: start from
 * something whole, then its colour, then its scene, then its type — and last
 * the window itself, which is the only group that is not part of a look at all.
 *
 * WHO DRAWS WHICH GROUP. Looks and Backdrop own their own `SettingsGroup`, the
 * way every self-contained section on this shell does — their group action (the
 * Save and import buttons, the scene picker) is theirs, and lifting it here
 * would mean lifting a file input's ref with it. Colour is composed HERE
 * because it is two components in one group (the palette rows and the library
 * they come from), and Type and Window are plain groups of rows.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAppearance, type Frost } from "@/lib/appearance";
import { desktopAppearance } from "@/lib/desktop-appearance";
import { detachFromHost } from "@/lib/host-follow";
import {
  applyLook,
  currentLookBackdrop,
  wearBackdrop,
  readLooks as readLooksNow,
  writeLooks,
  type Look,
  type LookBackdrop,
} from "@/lib/looks";
import { useBackdrop } from "@/lib/backdrop";
import type { StudioMode } from "@/lib/studio-draft";
import { mergeById, readAppearanceHome } from "@/lib/appearance-home";
import { concreteHalf, THEME_TOKENS, useThemeLibrary, type ThemeDefinition, type ThemeToken } from "@/lib/theme-palettes";
import { ThemeControl } from "@/components/theme-control";
import { useTheme } from "@/components/theme-provider";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";
import { DepthControl } from "./depth-control";
import { LooksSection } from "./looks-section";
import { ThemeLibrary } from "./theme-library";
import { BackdropTool } from "./studio/backdrop-tool";
import { GroupStrip } from "./studio/tool-strip";
import { ColourTool, ShowThroughRow, TypeTool } from "./studio/tools";

// Same idiom as updates-section.tsx: whether there is a shell at all is an
// external fact, present before React ran, and it never changes.
const subscribeToNothing = () => () => {};
const bridgeIsPresent = () => desktopAppearance() !== undefined;
const noBridgeOnTheServer = () => false;

/** Nothing under the app, for the one render that happens before the stores can
 *  be read — the backdrop's payloads live in localStorage. */
const NO_BACKDROP: LookBackdrop = { kind: "none" };

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance();
  const themeLibrary = useThemeLibrary();
  const { active, themes, setActive, setHalf, addCustom, editActiveHalf, saveCustom } = themeLibrary;
  const { backdrop } = useBackdrop();

  const hasBridge = useSyncExternalStore(subscribeToNothing, bridgeIsPresent, noBridgeOnTheServer);
  // `supported` has to be ASKED (macOS or not), so the row waits for the
  // answer rather than flashing a control that then disappears.
  const [windowSupported, setWindowSupported] = useState(false);
  const [notice, setNotice] = useState<string>();

  const mounted = useSyncExternalStore(subscribeToNothing, () => true, () => false);

  /**
   * WHICH HALF YOU ARE LOOKING AT — and therefore editing.
   *
   * The scheme IS the half selector. It reads from the theme store (which
   * resolves `system` against the OS and notifies on change), so the answer
   * stays right when evening arrives — and a pane whose whole claim is that the
   * app is the preview must not be showing you a half your window is not
   * wearing.
   */
  const { theme } = useTheme();
  const systemIsDark = useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  const mode: StudioMode = (theme === "system" ? systemIsDark : theme === "dark") ? "dark" : "light";

  useEffect(() => {
    if (!hasBridge) return;
    let live = true;
    void desktopAppearance()
      ?.get()
      .then((state) => {
        if (!live) return;
        setWindowSupported(state.supported);
        // The shell's copy wins on entry: it is what the window was actually
        // built with, and a stale localStorage copy must not disagree.
        setAppearance({ translucent: state.translucent, frost: state.frost });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // setAppearance is stable; run once per bridge discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBridge]);

  /**
   * PULL WHAT THE FILES SAY, ONCE, ON ARRIVAL.
   *
   * The appearance home is the record and localStorage is the pre-paint cache
   * (lib/appearance-home.ts). Anything written there by another author — a
   * person with an editor, or a config session — is invisible until something
   * reads it, and the moment this pane opens is when it matters. Merged, never
   * replaced: an id in both takes the file's copy, an id in only one survives.
   *
   * A machine with no engine reads an empty home and nothing moves, which is
   * exactly what a cache with an absent source should do.
   */
  const [homeNotice, setHomeNotice] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    void readAppearanceHome(abort.signal).then((home) => {
      if (abort.signal.aborted) return;
      for (const theme of home.themes) saveCustom(theme);
      if (home.looks.length > 0) {
        const merged = mergeById(readLooksNow(), home.looks);
        writeLooks(merged);
      }
      // NAMED, not swallowed. Someone hunting for a theme that never appeared
      // is owed the filename, and this is the only surface that can tell them.
      if (home.unreadable.length > 0) {
        const [first] = home.unreadable;
        setHomeNotice(
          home.unreadable.length === 1
            ? `${first!.file} could not be read — ${first!.reason}.`
            : `${home.unreadable.length} files in the appearance folder could not be read; the first is ${first!.file}.`,
        );
      }
    });
    return () => abort.abort();
    // saveCustom is stable; this is an arrival, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * THE BACKDROP, COLLAPSED INTO THE ONE SHAPE ITS EDITORS SPEAK.
   *
   * The live backdrop is four storage keys (the choice, the resolved layers, an
   * image, a scene); a `LookBackdrop` is all of them in one self-contained
   * value, which is what the editors take and hand back. Re-read whenever the
   * choice moves — `backdrop` is the store's own snapshot and changes exactly
   * when something wrote it, including a Look worn from its card.
   */
  const backdropValue = useMemo(
    () => (mounted ? currentLookBackdrop() : NO_BACKDROP),
    // The snapshot IS the dependency even though the capture reads storage: it
    // is a stable identity from its own store. The rule can only see it unread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, backdrop],
  );

  /** The palette this window has on, on the half in front of you — concrete,
   *  because the identity theme's halves are deliberately empty. */
  const half = useMemo(() => {
    const worn = themes.find((entry) => entry.id === active[mode]) ?? themes[0]!;
    return concreteHalf(worn, mode);
  }, [themes, active, mode]);

  /** The name of the palette on each half, for the strip — one theme, or a
   *  pair mixed from two. */
  const paletteSource = themes.find((entry) => entry.id === active[mode])?.label ?? "Telar";

  /**
   * WEAR A WHOLE LOOK — the palette, the scene, the accent, the type and the
   * depth, in one write. This is the only thing on the pane that moves more
   * than one axis, which is exactly what a Look is.
   */
  const wear = (look: Look) => {
    // A person choosing a look is the moment a remote window stops following
    // the host's (lib/host-follow.ts). Every wear path says so.
    detachFromHost();
    setNotice(applyLook(look, themeLibrary, setAppearance));
  };

  const wearScene = (next: LookBackdrop) => {
    detachFromHost();
    setNotice(wearBackdrop(next));
  };

  const wearTheme = (next: ThemeDefinition) => {
    detachFromHost();
    setActive(next.id);
  };

  const wearThemeHalf = (side: StudioMode, next: ThemeDefinition) => {
    detachFromHost();
    setHalf(side, next.id);
  };

  /** A palette read out of a picture: into the library, then worn. No third
   *  road to a colour — a theme is where a palette lives (#471). */
  const wearImagePalette = (built: Omit<ThemeDefinition, "id">) => {
    detachFromHost();
    setActive(addCustom(built).id);
  };

  const editToken = (token: ThemeToken, value: string) => {
    detachFromHost();
    editActiveHalf(mode, { [token]: value });
  };

  /** Replace the other half with a copy of the one in front of you. */
  const copyHalf = () => {
    detachFromHost();
    const other: StudioMode = mode === "light" ? "dark" : "light";
    editActiveHalf(other, Object.fromEntries(THEME_TOKENS.map((token) => [token, half[token]])));
  };

  const setTranslucent = (next: boolean) => {
    setAppearance({ translucent: next });
    void desktopAppearance()?.set({ translucent: next });
  };

  const setFrost = (next: Frost) => {
    setAppearance({ frost: next });
    void desktopAppearance()?.set({ frost: next });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && <p className="mb-3 text-xs text-warning">{notice}</p>}
      {homeNotice && <p className="mb-3 text-xs text-warning">{homeNotice}</p>}

      <LooksSection onWear={wear} />

      <SettingsGroup
        title="Colour"
        description="The sixteen tokens this window paints with, and the library a palette comes from."
      >
        {/* The strip NAMES the palette. Sixteen anonymous colour rows could not
            say whether you were editing Ember or something that exists nowhere
            but this window. */}
        <GroupStrip label={`Palette · ${mode} · ${paletteSource}`} count={THEME_TOKENS.length} />
        <ColourTool half={half} mode={mode} onToken={editToken} onCopyHalf={copyHalf} />
        <ThemeLibrary onWear={wearTheme} onWearHalf={wearThemeHalf} />
      </SettingsGroup>

      <BackdropTool
        value={backdropValue}
        mode={mode}
        onChange={wearScene}
        onThemeHalves={wearImagePalette}
        footer={
          <ShowThroughRow
            anchor="settings-row-appearance-backdrop-show-through"
            level={appearance.translucencyLevel}
            onChange={(translucencyLevel) => setAppearance({ translucencyLevel })}
          />
        }
      />

      <SettingsGroup title="Type" description="The accent, the two typefaces, and the sizes they run at.">
        <TypeTool appearance={appearance} onChange={setAppearance} />
      </SettingsGroup>

      {/* THE WINDOW IS NOT A LOOK, so it is last and it says so. None of it
          travels in a Look: the scheme is which half THIS window wears, and
          translucency is a property of the machine — macOS only, stored by the
          shell, and turning it on rebuilds the window.

          HOW MUCH SHOWS THROUGH IS HERE TOO, though it is the one member of
          this group that DOES travel in a Look — it also lives with the
          backdrop it thins. One value, two honest homes; the anchor is this
          one's, and the backdrop's copy is stamped by hand. */}
      <SettingsGroup
        title="Window"
        description="How this window itself is drawn. None of it travels in a look — it belongs to this machine."
      >
        <Row
          label="Colour scheme"
          hint="Which half this window wears — and the half every colour control above edits."
          control={<ThemeControl />}
        />
        {hasBridge && windowSupported ? (
          <>
            <ToggleRow
              label="Translucency"
              hint="Rebuilds the window."
              checked={appearance.translucent}
              onCheckedChange={setTranslucent}
            />
            {appearance.translucent && (
              <Row
                label="Glass"
                control={
                  <Segmented<Frost>
                    value={appearance.frost}
                    onChange={setFrost}
                    options={[
                      { value: "blur", label: "Blur" },
                      { value: "clear", label: "Clear" },
                    ]}
                  />
                }
              />
            )}
          </>
        ) : (
          <p className="py-3 text-xs text-muted-foreground">Translucency needs the macOS desktop app.</p>
        )}
        <ShowThroughRow level={appearance.translucencyLevel} onChange={(translucencyLevel) => setAppearance({ translucencyLevel })} />
        {/* DEPTH (#397): a property of this window's drawing, like everything
            else in this group; the control itself lives in depth-control.tsx. */}
        <DepthControl value={appearance.depth} onChange={(depth) => setAppearance({ depth })} />
      </SettingsGroup>
    </div>
  );
}
