"use client";

// Appearance — theme mode (System / Light / Dark). A real, immediate preference:
// changing it re-themes the whole shell at once via ThemeProvider (which toggles
// the `.dark` class on <html>), persisted through the shared ui-prefs store and
// synced across tabs. Nothing here writes telar.yaml/.telar or any engine env —
// it is a pure UI preference (Loom Doctrine).

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useUiPrefs, setUiPrefs, type ThemeMode } from "@/lib/ui-prefs";
import { SettingsGroup, Row, Segmented } from "./settings-shell";

export function AppearanceSettings() {
  const { theme } = useUiPrefs();
  return (
    <SettingsGroup
      title="Theme"
      description="Applies instantly across the whole app and is remembered on this device."
    >
      <Row
        label="Theme mode"
        hint="System follows your operating-system light/dark setting."
        control={
          <Segmented<ThemeMode>
            value={theme}
            onChange={(v) => setUiPrefs({ theme: v })}
            options={[
              { value: "system", label: <><MonitorIcon className="size-3.5" />System</> },
              { value: "light", label: <><SunIcon className="size-3.5" />Light</> },
              { value: "dark", label: <><MoonIcon className="size-3.5" />Dark</> },
            ]}
          />
        }
      />
    </SettingsGroup>
  );
}
