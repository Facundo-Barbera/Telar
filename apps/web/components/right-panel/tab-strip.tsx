"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import {
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
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
}: {
  tab: RightPanelTab;
  active: boolean;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
}) {
  const Icon = tab.kind === "git" ? GitBranchIcon : GlobeIcon;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        className={cn(
          "group/tab relative flex h-9 min-w-0 max-w-40 shrink-0 items-center border-r border-border px-2 text-xs outline-none transition-colors",
          active
            ? "bg-background text-foreground"
            : "bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
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
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{tab.title}</span>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          aria-label={`Close ${tab.title}`}
          className={cn(
            "ml-1 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100",
            active ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70",
          )}
        >
          <XIcon className="size-3" />
        </button>
        {active && <span className="absolute inset-x-0 bottom-0 h-px bg-primary" />}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className="min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <ContextMenu.Item onClick={onClose} className={contextItemClass}>
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
  onOpenGit,
  onOpenBrowser,
  trailing,
}: {
  tabs: readonly RightPanelTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseRight: (tabId: string) => void;
  onOpenGit: () => void;
  onOpenBrowser: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-muted/20">
      <div role="tablist" aria-label="Right panel tabs" className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab, index) => (
          <PanelTab
            key={tab.id}
            tab={tab}
            active={activeTabId === tab.id}
            canCloseOthers={tabs.length > 1}
            canCloseRight={index < tabs.length - 1}
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
              className="flex size-9 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
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
