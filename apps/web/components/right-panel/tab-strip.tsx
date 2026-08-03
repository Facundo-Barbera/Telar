"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import {
  ActivityIcon,
  FileCode2Icon,
  GitBranchIcon,
  GlobeIcon,
  PlusIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RightPanelTab } from "@/lib/right-panel-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const contextItemClass =
  "flex cursor-default items-center rounded-md px-2 py-1.5 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-40";

function DisabledAddItem({ icon: Icon, label, reason }: {
  icon: typeof FileCode2Icon;
  label: string;
  reason: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DropdownMenuItem
            aria-disabled="true"
            closeOnClick={false}
            onClick={(event) => event.preventDefault()}
            className="opacity-50"
          />
        }
      >
        <Icon />
        {label}
      </TooltipTrigger>
      <TooltipContent side="left">{reason}</TooltipContent>
    </Tooltip>
  );
}

function PanelTab({
  tab,
  active,
  canCloseOthers,
  canCloseRight,
  activityCount,
  activityRunning,
  activityAttention,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
}: {
  tab: RightPanelTab;
  active: boolean;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  activityCount?: number;
  activityRunning?: number;
  activityAttention?: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
}) {
  const Icon =
    tab.kind === "activity"
      ? ActivityIcon
      : tab.kind === "git"
        ? GitBranchIcon
        : GlobeIcon;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        className={cn(
          "group/tab relative flex h-8 min-w-0 max-w-40 shrink-0 items-center rounded-lg px-2 text-xs outline-none transition-colors",
          active
            ? "bg-muted/80 text-foreground shadow-sm ring-1 ring-border/80"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <button
          type="button"
          onClick={onActivate}
          onAuxClick={(event) => {
            if (event.button === 1) onClose();
          }}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{tab.title}</span>
          {tab.kind === "activity" && activityCount != null && activityCount > 0 && (
            <span
              className={cn(
                "ml-auto inline-flex min-w-4 shrink-0 items-center justify-center rounded-full px-1 font-mono text-[9px] leading-4",
                activityAttention
                  ? "bg-destructive/15 text-destructive"
                  : activityRunning
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
              )}
              title={
                activityRunning
                  ? `${activityRunning} running`
                  : `${activityCount} session activities`
              }
            >
              {activityCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          aria-label={`Close ${tab.title}`}
          className={cn(
            "ml-1 rounded-md p-0.5 text-muted-foreground transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
            active ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70",
          )}
        >
          <XIcon className="size-3" />
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className="min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <ContextMenu.Item
              onClick={onClose}
              className={contextItemClass}
            >
              Close
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={onCloseOthers}
              disabled={!canCloseOthers}
              className={contextItemClass}
            >
              Close others
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={onCloseRight}
              disabled={!canCloseRight}
              className={contextItemClass}
            >
              Close tabs to the right
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function TabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onOpenActivity,
  onOpenGit,
  onOpenBrowser,
  activityCount,
  activityRunning,
  activityAttention,
  trailing,
}: {
  tabs: readonly RightPanelTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
  onOpenActivity: () => void;
  onOpenGit: () => void;
  onOpenBrowser: () => void;
  activityCount?: number;
  activityRunning?: number;
  activityAttention?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mx-2 mt-2 flex h-10 shrink-0 items-center gap-1 rounded-xl border border-border bg-background/90 p-1 shadow-sm">
      <div role="tablist" aria-label="Right panel tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {tabs.map((tab, index) => (
          <PanelTab
            key={tab.id}
            tab={tab}
            active={activeTabId === tab.id}
            canCloseOthers={tabs.length > 1}
            canCloseRight={index < tabs.length - 1}
            activityCount={activityCount}
            activityRunning={activityRunning}
            activityAttention={activityAttention}
            onActivate={() => onActivate(tab.id)}
            onClose={() => onClose(tab.id)}
            onCloseOthers={() => onCloseOthers(tab.id)}
            onCloseRight={() => onCloseRight(tab.id)}
          />
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Add panel tab"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onOpenActivity}>
            <ActivityIcon />
            Activity
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenGit}>
            <GitBranchIcon />
            Git
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenBrowser}>
            <GlobeIcon />
            Browser
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DisabledAddItem
            icon={TerminalSquareIcon}
            label="Terminal"
            reason="Terminal hosting is not part of this convergence slice."
          />
          <DisabledAddItem
            icon={FileCode2Icon}
            label="Editor"
            reason="An embedded editor needs a dedicated file-access contract first."
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {trailing}
    </div>
  );
}
