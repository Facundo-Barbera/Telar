"use client";

import type { ReactNode } from "react";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * IS THE MAIN AREA THE LEFT EDGE OF THE WINDOW RIGHT NOW?
 *
 * Which is the same question as "is the rail hidden", asked by the two things
 * that care: the restore trigger below, and anything that has to leave room for
 * the macOS traffic lights. They must not answer it separately — a spacer that
 * disagreed with the trigger about the rail's state would reserve room in the
 * wrong pane, and the lights would sit on top of a control.
 */
export function useMainIsLeftmost(): boolean {
  const { isMobile, open, openMobile } = useSidebar();
  return isMobile ? !openMobile : !open;
}

/**
 * Restore control for the off-canvas app sidebar. It only mounts while the
 * sidebar is hidden, leaving the workspace at true full width.
 *
 * IT DOES NOT CARRY THE TITLEBAR INSET, and briefly did, which was wrong in a
 * way worth writing down: it assumed the header holding this button is the
 * window's left edge whenever the rail is gone. True in the session cockpit —
 * and false in Settings, which has a 240px nav of its OWN to the left of its
 * header. Applied there it inset the wrong pane, so the traffic lights still
 * sat on the Back arrow AND this button drifted into the middle of the header
 * with nothing to its left. The inset belongs to whichever element is actually
 * at x=0; each surface knows which of its own that is, and asks
 * `useMainIsLeftmost` directly.
 */
export function MainSidebarTrigger({
  className,
  fallback = null,
}: {
  className?: string;
  fallback?: ReactNode;
}) {
  const visible = useMainIsLeftmost();

  if (!visible) return fallback;

  return (
    <SidebarTrigger
      aria-label="Show main sidebar"
      title="Show main sidebar"
      className={cn("app-no-drag shrink-0 text-muted-foreground hover:text-foreground", className)}
    />
  );
}
