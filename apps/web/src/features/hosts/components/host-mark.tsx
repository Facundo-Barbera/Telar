"use client";

import { createContext, useContext } from "react";
import { MonitorIcon } from "lucide-react";
import { monogramHue, monogramInitial } from "@/ui/monogram";

/** Whether more than one host is connected; the mark only tells hosts apart. */
export const HostMarksShown = createContext(false);

export function HostMark({ hostId, hostName, size = 12 }: { hostId: string | undefined; hostName: string | undefined; size?: number }) {
  const shown = useContext(HostMarksShown);
  if (!shown) return null;
  const label = hostId ? `On ${hostName ?? "another computer"}` : "On this computer";
  const box = { width: size, height: size };
  if (!hostId) {
    return (
      <span role="img" aria-label={label} title={label} style={box} className="flex shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-foreground/60">
        <MonitorIcon style={{ width: size * 0.66, height: size * 0.66 }} />
      </span>
    );
  }
  const hue = monogramHue(hostId);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ ...box, fontSize: Math.max(7, Math.round(size * 0.62)), backgroundColor: `hsl(${hue} 55% 50% / 0.3)`, color: `hsl(${hue} 55% 36%)` }}
      className="flex shrink-0 items-center justify-center rounded-full font-semibold leading-none dark:brightness-150"
    >
      {monogramInitial(hostName ?? "?")}
    </span>
  );
}
