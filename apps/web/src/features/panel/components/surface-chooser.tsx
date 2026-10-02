"use client";

import { useRef, useState } from "react";
import { GlobeIcon, PlusIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import type { BrowserStartState } from "../folds";
import type { OpenableSurface, PanelTab } from "../model";
import type { PanelTabParams } from "../tabs";

/** The "+" menu. A kind already in the strip is here only because a second one is a different thing, so it opens another. */
export function SurfaceChooser({
  openable,
  canStartBrowser,
  browserStart,
  onOpenTab,
  onOpenNewTab,
  onOpenBrowser,
}: {
  openable: readonly OpenableSurface[];
  canStartBrowser: boolean;
  browserStart: BrowserStartState;
  onOpenTab: (tab: PanelTab) => void;
  onOpenNewTab?: (tab: PanelTab, params?: PanelTabParams) => void;
  onOpenBrowser?: () => void;
}) {
  const [open, setOpen] = useState(false);
  /**
   * The primitive defers its toggle to a rAF, which an occluded renderer (the native browser view) may never run.
   * So the mouse press decides and the click applies; `undefined` leaves a keyboard activation to the primitive.
   */
  const press = useRef<boolean>(undefined);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        onMouseDown={() => {
          press.current = !open;
        }}
        onClick={() => {
          const wanted = press.current;
          press.current = undefined;
          if (wanted !== undefined) setOpen(wanted);
        }}
        render={
          <button type="button" aria-label="Open a surface" title="Open a surface"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground">
            <PlusIcon className="size-4" />
          </button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={6} className="w-48">
        {openable.map((candidate) => (
          <DropdownMenuItem
            key={candidate.id}
            onClick={() => (candidate.another && onOpenNewTab ? onOpenNewTab(candidate.id) : onOpenTab(candidate.id))}
          >
            <candidate.icon className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{candidate.another && onOpenNewTab ? `New ${candidate.label}` : candidate.label}</span>
          </DropdownMenuItem>
        ))}
        {canStartBrowser && (
          <DropdownMenuItem disabled={browserStart.status === "pending"} onClick={() => onOpenBrowser?.()}>
            <GlobeIcon className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{browserStart.status === "pending" ? "Starting the browser…" : "Open a browser"}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
