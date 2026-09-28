"use client";

import { PanelRightOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The masthead control that opens the panel. It fades rather than vanishing so its neighbours keep their places. */
export function RailToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none" style={{ width: open ? 0 : 32, opacity: open ? 0 : 1 }}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Open right panel"
        title="Open right panel"
        tabIndex={open ? -1 : 0}
        onClick={onToggle}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <PanelRightOpenIcon className="size-4" />
      </Button>
    </div>
  );
}
