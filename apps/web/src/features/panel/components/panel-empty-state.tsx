"use client";

import type { ReactNode } from "react";
import { GlobeIcon, PanelsTopLeftIcon } from "lucide-react";
import { Spinner } from "@/ui/spinner";
import { desktopBrowserBridge } from "@/features/browser";
import type { PluginPanelSource } from "@/features/plugins";
import type { BrowserStartState } from "../folds";
import { browserPanelTab, browserTabLabel, LIVE_BROWSER_TAB, NO_PANELS, NO_PLUGINS, surfacesFor, type BrowserState, type PanelTab } from "../model";

const CARD = "flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60";

function Card({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={CARD}>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        <span className="block truncate font-mono text-3xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function StartBrowser({ onOpenBrowser, browserStart }: { onOpenBrowser: () => void; browserStart: BrowserStartState }) {
  const starting = browserStart.status === "pending";
  return (
    <>
      <button
        type="button"
        onClick={onOpenBrowser}
        disabled={starting}
        aria-busy={starting}
        className="mt-1 flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-progress disabled:hover:bg-transparent"
      >
        {starting ? <Spinner className="size-4 shrink-0 text-muted-foreground" /> : <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">{starting ? "Starting the browser…" : "Open a browser"}</span>
          <span className="block truncate text-2xs text-muted-foreground">
            {browserStart.status === "error" ? "Try again" : "Start this session’s browser"}
          </span>
        </span>
      </button>
      {browserStart.status === "error" && (
        <p role="alert" className="mt-1.5 px-1 text-2xs leading-relaxed text-destructive">
          {browserStart.message}
        </p>
      )}
    </>
  );
}

/** The panel's menu before anything is open: a card per surface, two columns once the panel (not the window) is wide enough. */
export function PanelEmptyState({
  onOpen,
  browser,
  onOpenBrowser,
  browserStart = { status: "idle" },
  enabledPlugins = NO_PLUGINS,
  pluginPanels = NO_PANELS,
}: {
  onOpen: (tab: PanelTab) => void;
  enabledPlugins?: readonly string[];
  pluginPanels?: readonly PluginPanelSource[];
  browser?: BrowserState;
  onOpenBrowser?: () => void;
  browserStart?: BrowserStartState;
}) {
  const pages = browser?.tabs ?? [];
  const globe = <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />;
  return (
    <div className="@container/panel-empty flex h-full flex-col justify-center p-4">
      <div className="mx-auto w-full max-w-sm @[420px]/panel-empty:max-w-2xl">
        <PanelsTopLeftIcon className="mx-auto size-7 text-muted-foreground/40" />
        <h2 className="mt-3 text-center font-heading text-sm font-medium">Open a surface</h2>
        <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground">Choose what to keep beside the conversation.</p>
        <div className="mt-4 grid grid-cols-1 gap-1 @[420px]/panel-empty:grid-cols-2">
          {surfacesFor(enabledPlugins, pluginPanels).map((candidate) => (
            <button key={candidate.id} type="button" onClick={() => onOpen(candidate.id)} className={CARD}>
              <candidate.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{candidate.label}</span>
                <span className="block truncate text-2xs text-muted-foreground">{candidate.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        {onOpenBrowser && pages.length === 0 && <StartBrowser onOpenBrowser={onOpenBrowser} browserStart={browserStart} />}
        {pages.length > 0 && desktopBrowserBridge() && (
          <>
            <p className="mt-5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Browser</p>
            <div className="mt-1.5 flex flex-col gap-1">
              <Card icon={globe} title="Browser" detail={`${pages.length} open page${pages.length === 1 ? "" : "s"}`} onClick={() => onOpen(LIVE_BROWSER_TAB)} />
            </div>
          </>
        )}
        {pages.length > 0 && !desktopBrowserBridge() && (
          <>
            <p className="mt-5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Open pages</p>
            <div className="mt-1.5 flex flex-col gap-1">
              {pages.map((page) => (
                <Card key={page.id} icon={globe} title={browserTabLabel(page)} detail={page.url} onClick={() => onOpen(browserPanelTab(page.id))} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
