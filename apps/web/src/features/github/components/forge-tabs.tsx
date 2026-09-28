"use client";

import { XIcon, type LucideIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { activateForge, closeForge, forgeNumbersAfter, otherForgeNumbers, showForgeList, type ForgeOpen } from "@/lib/forge-workspace";
import { cn } from "@/lib/utils";
import type { ForgeListKind } from "../model";

function ForgeChip({
  kind,
  number,
  on,
  onActivate,
  onClose,
  onCloseMany,
  forge,
}: {
  kind: ForgeListKind;
  number: number;
  on: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseMany: (numbers: readonly number[]) => void;
  forge: ForgeOpen;
}) {
  return (
    <span
      className={cn(
        "group/forge relative flex h-7 min-w-0 shrink-0 rounded-md text-xs transition-colors",
        on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {/* The trigger must be a painted box, not `display: contents`, or a right-press in the chip's padding misses it. */}
      <ContextMenu>
        <ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center px-1.5" />}>
          <button
            type="button"
            role="tab"
            aria-selected={on}
            onClick={onActivate}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose();
            }}
            title={`${kind === "issues" ? "Issue" : "Pull request"} #${number}`}
            className="flex min-w-0 flex-1 items-center font-mono tabular-nums outline-none"
          >
            #{number}
          </button>
          <button
            type="button"
            aria-label={`Close #${number}`}
            title="Close"
            onClick={onClose}
            className={cn(
              "ml-1 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
              on ? "opacity-70" : "opacity-0 group-hover/forge:opacity-70",
            )}
          >
            <XIcon className="size-3" />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onClose}>Close</ContextMenuItem>
          <ContextMenuItem onClick={() => onCloseMany(otherForgeNumbers(forge, number))}>Close others</ContextMenuItem>
          <ContextMenuItem onClick={() => onCloseMany(forgeNumbersAfter(forge, number))}>Close to the right</ContextMenuItem>
          <ContextMenuItem onClick={() => onCloseMany(forge.numbers)}>Close all</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </span>
  );
}

/** The sub-strip of open details: the list is the first chip and has no ×. */
export function ForgeTabs({ kind, icon: Icon, forge, onChange }: { kind: ForgeListKind; icon: LucideIcon; forge: ForgeOpen; onChange: (next: ForgeOpen) => void }) {
  const detail = forge.at;
  const closeMany = (numbers: readonly number[]) => {
    let next = forge;
    for (const number of numbers) next = closeForge(next, number);
    onChange(next);
  };
  return (
    <div
      role="tablist"
      aria-label={kind === "issues" ? "Open issues" : "Open pull requests"}
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1"
    >
      <button
        type="button"
        role="tab"
        aria-selected={detail === undefined}
        onClick={() => onChange(showForgeList(forge))}
        title={`All ${kind === "issues" ? "issues" : "pull requests"}`}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          detail === undefined ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <Icon className="size-3" />
        {kind === "issues" ? "Issues" : "Pull requests"}
      </button>
      {forge.numbers.map((number) => (
        <ForgeChip
          key={number}
          kind={kind}
          number={number}
          on={number === detail}
          forge={forge}
          onActivate={() => onChange(activateForge(forge, number))}
          onClose={() => onChange(closeForge(forge, number))}
          onCloseMany={closeMany}
        />
      ))}
    </div>
  );
}
