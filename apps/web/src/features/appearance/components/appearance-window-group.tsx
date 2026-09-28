"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Appearance, Frost } from "../appearance";
import { desktopAppearance } from "@/platform/desktop/desktop-appearance";
import { Row, Segmented, SettingsGroup, ToggleRow } from "@/features/settings";
import { ThemeControl } from "./theme-control";
import { ShowThroughRow } from "./studio/tools";

const subscribeToNothing = () => () => {};
const bridgeIsPresent = () => desktopAppearance() !== undefined;
const noBridgeOnTheServer = () => false;

export function AppearanceWindowGroup({ appearance, setAppearance }: { appearance: Appearance; setAppearance: (patch: Partial<Appearance>) => void }) {
  const hasBridge = useSyncExternalStore(subscribeToNothing, bridgeIsPresent, noBridgeOnTheServer);
  const [windowSupported, setWindowSupported] = useState(false);

  useEffect(() => {
    if (!hasBridge) return;
    let live = true;
    void desktopAppearance()
      ?.get()
      .then((state) => {
        if (!live) return;
        setWindowSupported(state.supported);
        setAppearance({ translucent: state.translucent, frost: state.frost });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
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
      <ShowThroughRow level={appearance.translucencyLevel} onChange={(translucencyLevel) => setAppearance({ translucencyLevel })} />
    </SettingsGroup>
  );
}
