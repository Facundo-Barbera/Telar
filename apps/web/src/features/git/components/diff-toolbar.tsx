"use client";

import { ChevronsDownUpIcon, ChevronsUpDownIcon, FolderTreeIcon, PilcrowIcon, WrapTextIcon } from "lucide-react";
import { cn } from "@/ui/utils";
import type { DiffView } from "../hooks/use-diff-view";

/** How this reader draws patches (persisted per person, not per tab), plus one collapse/expand-all button. */
export function DiffToolbar({
  view,
  setView,
  anyOpen,
  onToggleAll,
  expandable,
}: {
  view: DiffView;
  setView: (patch: Partial<DiffView>) => void;
  anyOpen: boolean;
  onToggleAll: () => void;
  expandable: boolean;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
      <div role="radiogroup" aria-label="Diff layout" className="flex items-center rounded-md border border-input p-0.5">
        {(["stacked", "split"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={view.layout === option}
            onClick={() => setView({ layout: option })}
            className={cn(
              "rounded-[0.25rem] px-2 py-0.5 text-2xs capitalize transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              view.layout === option ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <DiffToolbarToggle label="Word wrap" icon={<WrapTextIcon className="size-3.5" />} pressed={view.wrap} onPressedChange={(next) => setView({ wrap: next })} />
      <DiffToolbarToggle
        label="Ignore whitespace"
        icon={<PilcrowIcon className="size-3.5" />}
        pressed={view.ignoreWhitespace}
        onPressedChange={(next) => setView({ ignoreWhitespace: next })}
      />
      <DiffToolbarToggle label="File tree" icon={<FolderTreeIcon className="size-3.5" />} pressed={view.tree} onPressedChange={(next) => setView({ tree: next })} />
      {expandable && (
        <button
          type="button"
          onClick={onToggleAll}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {anyOpen ? <ChevronsDownUpIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5" />}
          {anyOpen ? "Collapse all" : "Expand all"}
        </button>
      )}
    </div>
  );
}

function DiffToolbarToggle({
  label,
  icon,
  pressed,
  onPressedChange,
}: {
  label: string;
  icon: React.ReactNode;
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "flex shrink-0 items-center rounded-md p-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}
