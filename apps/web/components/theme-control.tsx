"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { detachFromHost } from "@/lib/host-follow";
import { useTheme, type Theme } from "./theme-provider";

const OPTIONS: Array<{ value: Theme; label: string; icon: typeof SunIcon }> = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  return (
    <Tabs
      value={theme}
      onValueChange={(next) => {
        // A scheme chosen by hand is a customisation: a remote window stops
        // following the host's look from here on (lib/host-follow.ts).
        detachFromHost();
        setTheme(next as Theme);
      }}
    >
      <TabsList>
        {OPTIONS.map((option) => (
          <TabsTrigger key={option.value} value={option.value} className="gap-1.5">
            <option.icon />
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
