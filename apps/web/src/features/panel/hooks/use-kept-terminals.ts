import { useState } from "react";
import type { PanelTabItem } from "../model";

/**
 * The Terminal tabs looked at so far, in first-seen order, kept mounted while hidden. Adjusted during
 * render so a newly shown Terminal is in the list on its first render and never moves (which would remount it).
 */
export function useKeptTerminals(tabs: readonly PanelTabItem[], activeTab: PanelTabItem | undefined): readonly string[] {
  const [kept, setKept] = useState<readonly string[]>([]);
  const live = kept.filter((id) => tabs.some((entry) => entry.id === id && entry.kind === "terminal"));
  const wanted = activeTab?.kind === "terminal" && !live.includes(activeTab.id) ? [...live, activeTab.id] : live;
  if (wanted.length !== kept.length || wanted.some((id, at) => kept[at] !== id)) setKept(wanted);
  return wanted;
}
