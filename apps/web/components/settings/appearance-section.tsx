"use client";

/**
 * APPEARANCE — the whole look, on one pane.
 *
 * Colour scheme (the original single row), accent, typefaces, and — inside the
 * desktop shell on macOS — window translucency. Every control writes a store
 * that retints the open window immediately: scheme through theme-provider,
 * the rest through lib/appearance.ts; translucency ALSO crosses the bridge to
 * the shell, because the vibrancy layer lives under the page.
 *
 * THE SWATCHES CARRY THE ATTRIBUTE THEY SET. Each accent dot is a span wearing
 * `data-accent`, so its colour comes from the same globals.css blocks that
 * retint the app — there is no second copy of any hue in TypeScript, and a
 * swatch can never disagree with what choosing it does.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { CheckIcon } from "lucide-react";
import { ACCENTS, MAX_TRANSLUCENCY, MIN_TRANSLUCENCY, MONO_FONTS, SANS_FONTS, useAppearance, type Accent, type Frost, type MonoFont, type SansFont } from "@/lib/appearance";
import { desktopAppearance } from "@/lib/desktop-appearance";
import { ThemeControl } from "@/components/theme-control";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";
import { ThemeLibrary } from "./theme-library";

const ACCENT_LABEL: Record<Accent, string> = {
  indigo: "Indigo",
  sky: "Sky",
  sea: "Sea",
  moss: "Moss",
  amber: "Amber",
  rose: "Rose",
  plum: "Plum",
  violet: "Violet",
};

const SANS_LABEL: Record<SansFont, string> = { geist: "Geist", inter: "Inter", system: "System" };
const MONO_LABEL: Record<MonoFont, string> = { geist: "Geist Mono", jetbrains: "JetBrains Mono", system: "System" };

// Same idiom as updates-section.tsx: whether there is a shell at all is an
// external fact, present before React ran, and it never changes.
const subscribeToNothing = () => () => {};
const bridgeIsPresent = () => desktopAppearance() !== undefined;
const noBridgeOnTheServer = () => false;

function AccentSwatches({ value, onChange }: { value: Accent; onChange: (next: Accent) => void }) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Accent colour">
      {ACCENTS.map((accent) => {
        const on = accent === value;
        return (
          <button
            key={accent}
            type="button"
            role="radio"
            aria-checked={on}
            title={ACCENT_LABEL[accent]}
            onClick={() => onChange(accent)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full transition-transform hover:scale-110",
              on && "ring-2 ring-offset-2 ring-offset-card",
            )}
            // The ring reads the swatch's own hue: data-accent on the button
            // retints --primary for this subtree, ring-primary follows.
            data-accent={accent}
            style={{ ["--tw-ring-color" as string]: "var(--primary)" }}
          >
            <span data-accent={accent} className="flex size-5 items-center justify-center rounded-full bg-primary">
              {on && <CheckIcon className="size-3 text-primary-foreground" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance();
  const hasBridge = useSyncExternalStore(subscribeToNothing, bridgeIsPresent, noBridgeOnTheServer);
  // `supported` has to be ASKED (macOS or not), so the row waits for the
  // answer rather than flashing a control that then disappears.
  const [windowSupported, setWindowSupported] = useState(false);

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

  const setTranslucent = (next: boolean) => {
    setAppearance({ translucent: next });
    void desktopAppearance()?.set({ translucent: next });
  };

  const setFrost = (next: Frost) => {
    setAppearance({ frost: next });
    void desktopAppearance()?.set({ frost: next });
  };

  return (
    <>
      <SettingsGroup title="Theme" description="Applied before first paint, and instantly when changed.">
        <Row label="Colour scheme" hint="System follows the OS setting." control={<ThemeControl />} />
        <Row
          label="Accent"
          hint="The colour of everything a person presses — buttons, links, the focus ring."
          control={<AccentSwatches value={appearance.accent} onChange={(accent) => setAppearance({ accent })} />}
        />
      </SettingsGroup>

      <ThemeLibrary />

      <SettingsGroup title="Type">
        <Row
          label="Interface font"
          hint="System uses whatever this machine already renders its UI in."
          control={
            <Select
              value={appearance.fontSans}
              // base-ui renders the RAW value in the trigger unless told the
              // labels; `items` is its own prop for exactly that.
              items={SANS_LABEL}
              onValueChange={(next) => {
                if (typeof next === "string" && (SANS_FONTS as readonly string[]).includes(next)) setAppearance({ fontSans: next as SansFont });
              }}
            >
              <SelectTrigger size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SANS_FONTS.map((font) => (
                  <SelectItem key={font} value={font}>
                    {SANS_LABEL[font]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <Row
          label="Code font"
          hint="Transcripts, diffs, file views and every monospace value."
          control={
            <Select
              value={appearance.fontMono}
              items={MONO_LABEL}
              onValueChange={(next) => {
                if (typeof next === "string" && (MONO_FONTS as readonly string[]).includes(next)) setAppearance({ fontMono: next as MonoFont });
              }}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONO_FONTS.map((font) => (
                  <SelectItem key={font} value={font}>
                    {MONO_LABEL[font]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      {hasBridge && windowSupported && (
        <SettingsGroup title="Window" description="Desktop app only.">
          <ToggleRow
            label="Translucency"
            hint="The desktop shows through the canvas and the sidebar; cards and text stay opaque. Turning it on relaunches Telar — transparent windows need a different compositing mode, decided at launch."
            checked={appearance.translucent}
            onCheckedChange={setTranslucent}
          />
          {appearance.translucent && (
            <Row
              label="Glass"
              hint="Blur is macOS's frosted vibrancy — it brightens what it blurs. Clear shows the desktop crisp, tinted only by the app."
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
          {appearance.translucent && (
            <Row
              label="Strength"
              hint="How much desktop shows through. Applies live."
              control={
                <div className="flex items-center gap-2.5">
                  <input
                    type="range"
                    min={MIN_TRANSLUCENCY}
                    max={MAX_TRANSLUCENCY}
                    step={5}
                    value={appearance.translucencyLevel}
                    onChange={(event) => setAppearance({ translucencyLevel: Number(event.target.value) })}
                    className="w-36 accent-primary"
                    aria-label="Translucency strength"
                  />
                  <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{appearance.translucencyLevel}%</span>
                </div>
              }
            />
          )}
        </SettingsGroup>
      )}
    </>
  );
}
