"use client";

import { useMemo, useState } from "react";
import type { Artifact } from "@telar/engine-client";
import { Maximize2Icon, Minimize2Icon, PanelRightCloseIcon, XIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/ui/context-menu";
import { KeyHint } from "@/features/commands";
import { desktopBrowserBridge } from "@/features/browser";
import { useNativeViewOverlay } from "@/platform/desktop/native-view-overlay";
import { cn } from "@/ui/utils";
import { splitRoster, tabBadge, type TabBadge } from "../folds";
import { useLivePages } from "../hooks/use-live-pages";
import { useTabDrag } from "../hooks/use-tab-drag";
import { browserScopeKey, browserTabId, describePanelTabInstance, NO_PANELS, NO_PLUGINS, openableSurfaces, type BrowserState, type LivePage, type PanelTabItem } from "../model";
import type { RightPanelProps } from "./right-panel";
import { SurfaceChooser } from "./surface-chooser";

type StripProps = { artifacts: ReadonlyMap<string, Artifact> } & Pick<RightPanelProps, "tabs" | "tab" | "sessionId" | "tasks" | "onTabChange" | "onCloseTab" | "onMoveTab" | "onOpenTab" | "onOpenNewTab" | "onOpenBrowser" | "browserStart" | "enabledPlugins" | "pluginPanels" | "onClose"> & {
  browser: BrowserState | undefined;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
};

const CONTROL = "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

function CountBadge({ badge }: { badge: TabBadge }) {
  return (
    <span
      className={cn(
        "ml-auto inline-flex min-w-4 shrink-0 items-center justify-center rounded-full px-1 font-mono text-4xs leading-4",
        badge.failed > 0 ? "bg-destructive/15 text-destructive" : badge.running > 0 ? "bg-primary/15 text-primary" : "bg-muted-foreground/15 text-muted-foreground",
      )}
      title={badge.running > 0 ? `${badge.running} running` : undefined}
    >
      {badge.count}
    </span>
  );
}

/**
 * One tab. The chip is the drag handle; its context menu's trigger is a child row so a grab and a right-press never
 * land on one node. The insert mark is an inset shadow so drag-over never widens the tab.
 */
function TabChip({
  entry,
  strip,
  live,
  duplicate,
  badge,
  drag,
  menu,
}: {
  entry: PanelTabItem;
  strip: StripProps;
  live: readonly LivePage[] | undefined;
  duplicate: boolean;
  badge: TabBadge | undefined;
  drag: ReturnType<typeof useTabDrag>;
  menu: [string | undefined, (id: string | undefined) => void];
}) {
  const { id } = entry;
  const { tabs, onCloseTab, fullscreen, onToggleFullscreen } = strip;
  const on = id === strip.tab;
  const { label, icon: Icon, missing } = describePanelTabInstance(entry, { ...(strip.browser ? { browser: strip.browser } : {}), ...(live ? { live } : {}), duplicate, artifacts: strip.artifacts });
  const insert = drag.insert?.id === id ? drag.insert.side : undefined;
  return (
    <span
      {...drag.handlers(id)}
      className={cn(
        "group/tab relative flex h-7 min-w-0 max-w-44 shrink-0 cursor-grab rounded-md text-xs transition-colors active:cursor-grabbing",
        on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        missing && "opacity-60",
        drag.dragging === id && "opacity-40",
        insert === "before" && "shadow-[inset_2px_0_0_0_var(--color-primary)]",
        insert === "after" && "shadow-[inset_-2px_0_0_0_var(--color-primary)]",
      )}
    >
      <ContextMenu open={menu[0] === id} onOpenChange={(next: boolean) => menu[1](next ? id : undefined)}>
        <ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center px-1.5" />}>
          <button
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`right-panel-${id}`}
            onClick={() => strip.onTabChange(id)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onCloseTab(id);
              }
            }}
            title={label}
            className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
            {badge ? <CountBadge badge={badge} /> : null}
          </button>
          <button
            type="button"
            aria-label={`Close ${label}`}
            onClick={() => onCloseTab(id)}
            className={cn(
              "ml-1 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
              on ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70",
            )}
          >
            <XIcon className="size-3" />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onCloseTab(id)}>Close</ContextMenuItem>
          <ContextMenuItem onClick={() => tabs.filter((other) => other.id !== id).forEach((other) => onCloseTab(other.id))}>Close others</ContextMenuItem>
          <ContextMenuItem onClick={() => tabs.forEach((other) => onCloseTab(other.id))}>Close all</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onToggleFullscreen}>{fullscreen ? "Exit fullscreen" : "Fill the window"}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </span>
  );
}

/** The panel's top bar: the tabs, the "+" chooser, and the panel's own controls. In fullscreen it is the window's titlebar. */
export function TabStrip(strip: StripProps) {
  const { tabs, sessionId, browser, fullscreen, onOpenNewTab, onOpenBrowser, tasks = [], browserStart = { status: "idle" } } = strip;
  const menu = useState<string>();
  useNativeViewOverlay(menu[0] !== undefined);
  const drag = useTabDrag(tabs, strip.onMoveTab);
  const browserScopes = useMemo(
    () => (sessionId ? tabs.filter((entry) => browserTabId(entry.kind) !== undefined).map((entry) => browserScopeKey(sessionId, entry.id)) : []),
    [sessionId, tabs],
  );
  const livePages = useLivePages(browserScopes);
  const duplicated = useMemo(() => {
    const counted = new Map<string, number>();
    for (const entry of tabs) counted.set(entry.kind, (counted.get(entry.kind) ?? 0) + 1);
    return new Set([...counted].filter(([, count]) => count > 1).map(([kind]) => kind));
  }, [tabs]);
  const roster = useMemo(() => splitRoster(tasks), [tasks]);
  const canStartBrowser = Boolean(onOpenBrowser) && (browser?.tabs.length ?? 0) === 0;
  const openable = openableSurfaces(tabs, {
    enabledPlugins: strip.enabledPlugins ?? NO_PLUGINS,
    pluginPanels: strip.pluginPanels ?? NO_PANELS,
    browser,
    desktop: Boolean(desktopBrowserBridge()),
    canOpenNew: onOpenNewTab !== undefined,
  });

  return (
    <div
      className={cn(
        "@container/strip flex h-10 shrink-0 items-center gap-1 border-b border-border px-2 py-0",
        fullscreen && "pl-[max(8px,calc(var(--titlebar-inset)+var(--app-island-inset)))] md:h-[var(--titlebar-band-height)]",
      )}
    >
      <div role="tablist" aria-label="Right panel tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {tabs.map((entry) => (
          <TabChip
            key={entry.id}
            entry={entry}
            strip={strip}
            live={sessionId ? livePages?.get(browserScopeKey(sessionId, entry.id)) : undefined}
            duplicate={duplicated.has(entry.kind)}
            badge={tabBadge(entry.kind, roster)}
            drag={drag}
            menu={menu}
          />
        ))}
        {(openable.length > 0 || canStartBrowser) && (
          <SurfaceChooser
            openable={openable}
            canStartBrowser={canStartBrowser}
            browserStart={browserStart}
            onOpenTab={strip.onOpenTab}
            {...(onOpenNewTab ? { onOpenNewTab } : {})}
            {...(onOpenBrowser ? { onOpenBrowser } : {})}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {tabs.length > 1 && (
          <span className="mr-1 hidden items-center gap-0.5 @2xl/strip:flex">
            <KeyHint command="panel-previous-tab" />
            <KeyHint command="panel-next-tab" />
          </span>
        )}
        <button
          type="button"
          aria-label={fullscreen ? "Exit fullscreen" : "Fill the window"}
          title={fullscreen ? "Exit fullscreen" : "Fill the window"}
          onClick={strip.onToggleFullscreen}
          className={CONTROL}
        >
          {fullscreen ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
        </button>
        <button type="button" aria-label="Close right panel" title="Close right panel" onClick={strip.onClose} className={CONTROL}>
          <PanelRightCloseIcon className="size-4" />
        </button>
        <span className="hidden @lg/strip:contents">
          <KeyHint command="toggle-panel" />
        </span>
      </div>
    </div>
  );
}
