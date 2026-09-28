"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { detachFromHost } from "../host-follow";
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
        detachFromHost();
        setTheme(next as Theme);
      }}
    >
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
