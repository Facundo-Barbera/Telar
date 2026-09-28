"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronRightIcon } from "lucide-react";
import { accentPrimary } from "../accent-colours";
import { detachFromHost, useFollowNotice } from "../host-follow";
import { useTheme } from "./theme-provider";
import { useAppearance } from "../appearance";
import { applyLook, readLooks as readLooksNow, writeLooks, type Look } from "../looks";
import {
  compositionHalf,
  copyLayersAcross,
  useComposition,
  type CompositionMode,
} from "../composition";
import { halfFromBase } from "../palette-from-image";
import { mergeById, readAppearanceHome } from "../appearance-home";
import { THEME_TOKENS, type ThemeToken } from "../theme-palettes";
import { Button } from "@/ui/button";
import { Row, SettingsGroup } from "@/features/settings";
import { DepthControl } from "./depth-control";
import { LooksSection } from "./looks-section";
import { GroupStrip } from "./studio/tool-strip";
import { BaseControl, ColourTool, PaletteStrip, TypeTool } from "./studio/tools";
import { LayerStack } from "./studio/layer-stack";
import { AppearanceWindowGroup } from "./appearance-window-group";

function useAppearanceHomeNotice(): string | undefined {
  const [homeNotice, setHomeNotice] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    void readAppearanceHome().then((home) => {
      if (abort.signal.aborted) return;
      if (home.looks.length > 0) writeLooks(mergeById(readLooksNow(), home.looks));
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
  }, []);
  return homeNotice;
}

export function AppearanceSection() {
  const { appearance, setAppearance } = useAppearance();
  const { composition, images, setBase, setLayers, setOverride, setComposition } = useComposition();
  const [notice, setNotice] = useState<string>();
  const followNotice = useFollowNotice();
  const homeNotice = useAppearanceHomeNotice();

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
  const mode: CompositionMode = (theme === "system" ? systemIsDark : theme === "dark") ? "dark" : "light";
  const other: CompositionMode = mode === "light" ? "dark" : "light";

  const state = composition[mode];
  const half = useMemo(() => compositionHalf(composition, mode), [composition, mode]);
  const derived = useMemo(() => halfFromBase(state.base, mode), [state.base, mode]);
  const overrideCount = useMemo(() => THEME_TOKENS.filter((token) => state.overrides[token] !== undefined).length, [state.overrides]);

  const wear = (look: Look) => {
    detachFromHost();
    setNotice(applyLook(look, setAppearance));
  };

  const compose = (ok: boolean) => {
    detachFromHost();
    setNotice(ok ? undefined : "That change would not fit in browser storage — its layer images are large.");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && <p className="mb-3 text-xs text-warning">{notice}</p>}
      {homeNotice && <p className="mb-3 text-xs text-warning">{homeNotice}</p>}
      {followNotice && <p className="mb-3 text-xs text-warning">{followNotice}</p>}

      <LooksSection onWear={wear} />

      <SettingsGroup
        title="Composer"
        description="What the app looks like: a base colour the surfaces are derived from, and the layers over it. Light and dark are two states of one composition — you edit the one the window wears, set under Window below."
      >
        <Row
          label="Base"
          hint="The app colour. It decides the hue and how colourful the surfaces are; the lightness that keeps text readable is kept underneath."
          control={<BaseControl base={state.base} label={`${mode === "light" ? "Light" : "Dark"} base colour`} onChange={(base) => compose(setBase(mode, base))} />}
        />
        <div className="flex gap-2 py-3">
          <PaletteStrip half={compositionHalf(composition, "light")} label="Light" current={mode === "light"} />
          <PaletteStrip half={compositionHalf(composition, "dark")} label="Dark" current={mode === "dark"} />
        </div>

        <LayerStack
          layers={state.layers}
          images={images}
          mode={mode}
          colours={{ light: composition.light.base, dark: composition.dark.base, accent: accentPrimary(appearance.accent, mode) }}
          onChange={(layers, next) => compose(setLayers(mode, layers, next))}
        />

        <Row
          label="Match the other state"
          hint={`Give ${other} the same layers. It keeps its own base colour — that is the one thing the two states are never the same about.`}
          control={
            <Button size="sm" variant="outline" onClick={() => compose(setComposition(copyLayersAcross(composition, mode)))}>
              Copy to {other}
            </Button>
          }
        />

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
        <DepthControl value={appearance.depth} onChange={(depth) => setAppearance({ depth })} />
      </SettingsGroup>

      <AppearanceWindowGroup appearance={appearance} setAppearance={setAppearance} />
    </div>
  );
}
