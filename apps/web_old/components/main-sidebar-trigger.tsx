"use client";

import type { ReactNode } from "react";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Header-owned restore control for the off-canvas app sidebar. It only mounts
 * while the sidebar is hidden, leaving the workspace at true full width.
 */
export function MainSidebarTrigger({
  className,
  fallback = null,
}: {
  className?: string;
  fallback?: ReactNode;
}) {
  const { isMobile, open, openMobile } = useSidebar();
  const visible = isMobile ? !openMobile : !open;

  if (!visible) return fallback;

  return (
    <SidebarTrigger
      aria-label="Show main sidebar"
      title="Show main sidebar"
      className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)}
    />
  );
}
