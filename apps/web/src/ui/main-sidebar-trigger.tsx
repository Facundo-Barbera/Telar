"use client";

import type { ReactNode } from "react";
import { SidebarTrigger, useSidebar } from "@/ui/sidebar";
import { cn } from "@/ui/utils";

export function useMainIsLeftmost(): boolean {
  const { isMobile, open, openMobile } = useSidebar();
  return isMobile ? !openMobile : !open;
}

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
