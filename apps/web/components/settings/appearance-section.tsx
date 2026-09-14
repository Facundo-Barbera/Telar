"use client";

/**
 * APPEARANCE — every control writes what it names, at once.
 *
 * THE ONE RULE, AND IT IS THE SHORT ONE (#471): TOUCH A CONTROL AND THE APP
 * CHANGES. There is no draft, no Apply, no Discard, no undo stack and no
 * masthead. A base, a layer or a hand-set token is a write to the COMPOSITION;
 * an accent, a typeface, a size, the depth and the show-through are a write to
 * the appearance store. Every one of them is the same kind of write Translucency
 * and Glass have always done on this pane, and the same kind every other
 * settings pane in this app does.
 *
 * THE COMPOSER IS THE THEME. This pane used to teach three overlapping ideas —
 * a THEME (a palette you picked), a BACKDROP (a scene you picked separately),
 * and a LOOK (the two saved together) — and the owner's complaint was that
 * they were the same idea wearing three hats: "gradient and theme are different
 * things here. We inject the gradients over the theme, where I always thought
 * that a gradient would be part of a theme. Themes should not exist, there
 * should be default settings for the composer." So there is one thing to edit
 * now, and the page is the order you edit it in:
 *
 *   LOOKS              somewhere whole to start from, including the defaults
 *                      that used to be built-in themes and starters.
 *   COMPOSER           the light/dark switch, the base colour those sixteen
 *                      tokens come from, the layers over it, and — folded away
 *                      — the tokens themselves for overriding what was derived.
 *   TYPE AND SURFACES  the accent, the two faces, their sizes, and the depth.
 *   WINDOW             the colour scheme, translucency and glass. The only
 *                      group that is not part of a look at all.
 *
 * THE LIGHT/DARK SWITCH IS THE WINDOW'S COLOUR SCHEME, and that is deliberate
 * rather than a shortcut. "The window's colour scheme picks which state is
 * showing" — so a composer switch that selected a state WITHOUT moving the
 * window would be editing a state you cannot see, which is the whole failure
 * the direct-apply rebuild set out to end. One control, and the Window group
 * keeps the same one (with `system` as well, which the composer's two-way
 * switch cannot express).
 *
 * AND IT IS A SETTINGS PANE, NOT A STUDIO (#399). Stacked `SettingsGroup` cards
 * with a title and a sentence, exactly like inbox-section.tsx and
 * browser-profiles-section.tsx.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronRightIcon } from "lucide-react";
import { useAppearance, type Frost } from "@/lib/appearance";
import { desktopAppearance } from "@/lib/desktop-appearance";
import { detachFromHost } from "@/lib/host-follow";
import { applyLook, readLooks as readLooksNow, writeLooks, type Look } from "@/lib/looks";
import {
  compositionHalf,
  copyLayersAcross,
  useComposition,
  type CompositionMode,
} from "@/lib/composition";
import { halfFromBase } from "@/lib/palette-from-image";
import { mergeById, readAppearanceHome } from "@/lib/appearance-home";
import { THEME_TOKENS, type ThemeToken } from "@/lib/theme-palettes";
import { ThemeControl } from "@/components/theme-control";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";
import { DepthControl } from "./depth-control";
import { LooksSection } from "./looks-section";
import { GroupStrip } from "./studio/tool-strip";
import { BaseControl, ColourTool, PaletteStrip, ShowThroughRow, TypeTool } from "./studio/tools";
import { LayerStack } from "./studio/layer-stack";

// Same idiom as updates-section.tsx: whether there is a shell at all is an
// external fact, present before React ran, and it never changes.
const subscribeToNothing = () => () => {};
const bridgeIsPresent = () => desktopAppearance() !== undefined;
const noBridgeOnTheServer = () => false;

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance();
  const { composition, images, setBase, setLayers, setOverride, setComposition } = useComposition();

  const hasBridge = useSyncExternalStore(subscribeToNothing, bridgeIsPresent, noBridgeOnTheServer);
  // `supported` has to be ASKED (macOS or not), so the row waits for the
  // answer rather than flashing a control that then disappears.
  const [windowSupported, setWindowSupported] = useState(false);
  const [notice, setNotice] = useState<string>();

  /**
   * WHICH STATE YOU ARE LOOKING AT — and therefore editing.
   *
   * It reads from the theme store (which resolves `system` against the OS and
   * notifies on change), so the answer stays right when evening arrives — and a
   * pane whose whole claim is that the app is the preview must not be showing
   * you a state your window is not wearing.
   */
  const { theme, setTheme } = useTheme();
  const systemIsDark = useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  const mode: CompositionMode = (theme === "system" ? systemIsDark : theme === "dark") ? "dark" : "light";
  const other: CompositionMode = mode === "light" ? "dark" : "light";

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
      if (home.looks.length > 0) writeLooks(mergeById(readLooksNow(), home.looks));
      // NAMED, not swallowed. Someone hunting for a look that never appeared is
      // owed the filename, and this is the only surface that can tell them.
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
    // An arrival, not a subscription.
  }, []);

  const state = composition[mode];
  /** What this state actually paints, and what the base alone would give — the
   *  token rows need both to say which of them is hand-set. */
  const half = useMemo(() => compositionHalf(composition, mode), [composition, mode]);
  const derived = useMemo(() => halfFromBase(state.base, mode), [state.base, mode]);
  const overrideCount = useMemo(() => THEME_TOKENS.filter((token) => state.overrides[token] !== undefined).length, [state.overrides]);

  /**
   * WEAR A WHOLE LOOK — the composition, the accent, the type and the depth, in
   * one write. This is the only thing on the pane that moves more than one
   * axis, which is exactly what a Look is.
   */
  const wear = (look: Look) => {
    // A person choosing a look is the moment a remote window stops following
    // the host's (lib/host-follow.ts). Every write path says so.
    detachFromHost();
    setNotice(applyLook(look, setAppearance));
  };

  /** Every composition write goes through here, for the detach and for the one
   *  message a refused write has to show. */
  const compose = (ok: boolean) => {
    detachFromHost();
    setNotice(ok ? undefined : "That change would not fit in browser storage — its layer images are large.");
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
        title="Composer"
        description="What the app looks like: a base colour the surfaces are derived from, and the layers over it. Light and dark are two states of one composition — the switch says which one you are editing, and the window wears it."
        action={
          <Segmented<CompositionMode>
            value={mode}
            // The switch IS the window's colour scheme — see the file header.
            onChange={(next) => setTheme(next)}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        }
      >
        <Row
          label="Base"
          hint="The app colour. It decides the hue and how colourful the surfaces are; the lightness that keeps text readable is kept underneath."
          control={<BaseControl base={state.base} label={`${mode === "light" ? "Light" : "Dark"} base colour`} onChange={(base) => compose(setBase(mode, base))} />}
        />
        {/* WHAT THE PAIR ACTUALLY LOOKS LIKE, both states at once — including
            the one your window is not wearing, which is the state a base
            control otherwise asks you to choose blind. */}
        <div className="flex gap-2 py-3">
          <PaletteStrip half={compositionHalf(composition, "light")} label="Light" current={mode === "light"} />
          <PaletteStrip half={compositionHalf(composition, "dark")} label="Dark" current={mode === "dark"} />
        </div>

        <LayerStack layers={state.layers} images={images} mode={mode} onChange={(layers, next) => compose(setLayers(mode, layers, next))} />

        <Row
          label="Match the other state"
          hint={`Give ${other} the same layers. It keeps its own base colour — that is the one thing the two states are never the same about.`}
          control={
            <Button size="sm" variant="outline" onClick={() => compose(setComposition(copyLayersAcross(composition, mode)))}>
              Copy to {other}
            </Button>
          }
        />

        {/* THE SIXTEEN TOKENS, FOLDED AWAY. They are the whole truth of what
            paints and still editable — but they are the escape hatch you reach
            for after the base has answered, not the thing that greets you.
            `<details>` rather than state: the browser keeps it, it is
            keyboard-reachable and screen-reader-announced for free, and nothing
            else on the pane needs to know whether it is open. */}
        <details className="group py-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
            Adjust colours
            <span className="font-mono text-4xs tracking-[0.08em] text-muted-foreground/60 uppercase tabular-nums">
              {overrideCount > 0 ? `${overrideCount} set by hand` : THEME_TOKENS.length}
            </span>
          </summary>
          <GroupStrip
            label={`Overriding the ${mode} state`}
            tone={overrideCount > 0 ? "attention" : "none"}
          />
          <p className="pb-1.5 text-xs text-muted-foreground">
            Every colour here follows the base until you set it. Setting one pins it; the arrow at the end of a row hands it back.
          </p>
          <ColourTool
            half={half}
            derived={derived}
            overrides={state.overrides}
            mode={mode}
            onToken={(token: ThemeToken, value) => compose(setOverride(mode, token, value))}
          />
        </details>
      </SettingsGroup>

      <SettingsGroup title="Type and surfaces" description="The accent, the two typefaces, the sizes they run at, and how far surfaces lift off the canvas.">
        <TypeTool appearance={appearance} onChange={setAppearance} />
        {/* DEPTH (#397) is TASTE and travels in a look — see DEPTHS in the
            shared vocabulary — so it sits with the accent and the type rather
            than with the window's own properties. */}
        <DepthControl value={appearance.depth} onChange={(depth) => setAppearance({ depth })} />
      </SettingsGroup>

      {/* THE WINDOW IS NOT A LOOK, so it is last and it says so. None of it
          travels in a Look: the scheme is which state THIS window wears, and
          translucency is a property of the machine — macOS only, stored by the
          shell, and turning it on rebuilds the window. */}
      <SettingsGroup title="Window" description="How this window itself is drawn. None of it travels in a look — it belongs to this machine.">
        <Row
          label="Colour scheme"
          hint="Which state this window wears — and the one the composer above edits."
          control={<ThemeControl />}
        />
        {hasBridge && windowSupported ? (
          <>
            <ToggleRow label="Translucency" hint="Rebuilds the window." checked={appearance.translucent} onCheckedChange={setTranslucent} />
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
        {/* THE ONE MEMBER OF THIS GROUP THAT DOES TRAVEL IN A LOOK. It is how
            much of the composition's layers reach the canvas and the rail, and
            it is also what the desktop shell's own vibrancy reads — one value,
            and this is where search points at it (settings-registry.ts). */}
        <ShowThroughRow level={appearance.translucencyLevel} onChange={(translucencyLevel) => setAppearance({ translucencyLevel })} />
      </SettingsGroup>
    </div>
  );
}
