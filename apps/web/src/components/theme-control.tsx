"use client";

/**
 * LIGHT, DARK, OR WHAT THE SYSTEM SAYS — a dropdown, not three buttons (#364).
 *
 * It was a `TabsList`: a filled track with a raised thumb, which is a segmented
 * button group wearing a different component's name, and it sat in the studio's
 * toolbar spending three buttons' width on two answers nobody chose. A dropdown
 * states the answer at a fixed width and holds the other two until asked.
 */

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { detachFromHost } from "@/lib/host-follow";
import { useTheme, type Theme } from "./theme-provider";

const OPTIONS: Array<{ value: Theme; label: string; icon: typeof SunIcon }> = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const chosen = OPTIONS.find((option) => option.value === theme) ?? OPTIONS[2]!;
  return (
    <Select
      value={theme}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        // A scheme chosen by hand is a customisation: a remote window stops
        // following the host's look from here on (lib/host-follow.ts).
        detachFromHost();
        setTheme(next as Theme);
      }}
    >
      {/* THE TRIGGER READS THE LABEL, NOT THE VALUE — #318's bug, which a bare
          `<SelectValue />` reintroduces wherever a Select is written by hand. */}
      <SelectTrigger size="sm" className="w-32" aria-label="Colour scheme">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            <chosen.icon className="size-3.5" />
            {chosen.label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex items-center gap-1.5">
              <option.icon className="size-3.5" />
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
