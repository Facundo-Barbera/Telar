"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/ui/utils";
import { APP_SIDEBAR_STORAGE_KEY, APP_SIDEBAR_MAIN_MIN_WIDTH, clampSidebarWidth, keepsRoomForMain, setSidebarWidth, SIDEBAR_RESIZE_MIN_WIDTH, useSidebarPrefs } from "@/ui/sidebar-width";
import type { SettingsSection } from "./settings-shell";

export function SettingsPaneList({ sections, active, onSelect }: { sections: SettingsSection[]; active: string; onSelect: (id: string) => void }) {
  const groups = sections.some((s) => s.group)
    ? Array.from(new Set(sections.map((s) => s.group ?? ""))).map((g) => ({
        group: g,
        items: sections.filter((s) => (s.group ?? "") === g),
      }))
    : [{ group: "", items: sections }];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {groups.map(({ group, items }) => (
        <div key={group} className="flex flex-col gap-0.5">
          {group && (
            <div className="px-2 pb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground/60">{group}</div>
          )}
          {items.map((s) => {
            const Icon = s.icon;
            const on = s.id === active;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                  on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", on ? "text-foreground" : "text-muted-foreground/70")} />
                <span className="flex-1 truncate">{s.label}</span>
                {s.count != null && <span className="text-2xs tabular-nums text-muted-foreground/60">{s.count}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function useSettingsNavResize() {
  const prefsWidth = useSidebarPrefs(APP_SIDEBAR_STORAGE_KEY).width ?? SIDEBAR_RESIZE_MIN_WIDTH;
  const [dragWidth, setDragWidth] = useState<number>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const navWidth = dragWidth ?? prefsWidth;

  useEffect(() => {
    if (dragWidth === undefined) return;
    const stop = () => {
      setSidebarWidth(APP_SIDEBAR_STORAGE_KEY, dragWidth);
      setDragWidth(undefined);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const move = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const current = dragWidth;
      const proposed = event.clientX - rect.left;
      const max = Math.max(SIDEBAR_RESIZE_MIN_WIDTH, rect.width - APP_SIDEBAR_MAIN_MIN_WIDTH);
      const next = clampSidebarWidth(proposed, SIDEBAR_RESIZE_MIN_WIDTH, max);
      if (keepsRoomForMain(current, next, rect.width, APP_SIDEBAR_MAIN_MIN_WIDTH)) setDragWidth(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragWidth]);

  const startDrag = () => {
    setDragWidth(navWidth);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return { navWidth, wrapperRef, startDrag };
}
