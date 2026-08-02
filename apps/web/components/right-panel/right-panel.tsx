"use client";

import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { GitTab } from "@/components/projects/git-tab";
import { useRightPanelStore } from "@/lib/right-panel-store";
import { BrowserSurface } from "./browser-surface";
import { PanelEmptyState } from "./panel-empty-state";
import { TabStrip } from "./tab-strip";

export const RIGHT_PANEL_WIDE_ONLY_CLASS = "hidden min-[1440px]:flex";

export function RightPanel({ project, scopeKey }: { project: string; scopeKey: string }) {
  const panel = useRightPanelStore(scopeKey);
  const activeTab = panel.session.tabs.find((tab) => tab.id === panel.session.activeTabId);

  if (!panel.session.open) {
    return (
      <aside
        aria-label="Right panel"
        data-collapse-below="1440px"
        className={`${RIGHT_PANEL_WIDE_ONLY_CLASS} w-10 shrink-0 flex-col items-center border-l border-border bg-muted/10 py-2`}
      >
        <button
          type="button"
          onClick={() => panel.setOpen(true)}
          aria-label="Open right panel"
          title="Open right panel"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpenIcon className="size-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Right panel"
      data-collapse-below="1440px"
      className={`${RIGHT_PANEL_WIDE_ONLY_CLASS} w-[26rem] min-w-80 shrink-0 flex-col border-l border-border bg-background`}
    >
      <TabStrip
        tabs={panel.session.tabs}
        activeTabId={panel.session.activeTabId}
        onActivate={panel.activate}
        onClose={panel.close}
        onCloseOthers={panel.closeOthers}
        onCloseRight={panel.closeRight}
        onOpenGit={panel.openGit}
        onOpenBrowser={() => panel.openBrowser()}
        trailing={
          <button
            type="button"
            onClick={() => panel.setOpen(false)}
            aria-label="Collapse right panel"
            title="Collapse right panel"
            className="flex size-9 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {!activeTab ? (
          <PanelEmptyState onOpenBrowser={() => panel.openBrowser()} />
        ) : activeTab.kind === "git" ? (
          <GitTab name={project} />
        ) : (
          <BrowserSurface title={activeTab.title} url={activeTab.url} />
        )}
      </div>
    </aside>
  );
}
