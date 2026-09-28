"use client";

import { Suspense, useEffect, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/ui/sidebar";
import { APP_SIDEBAR_STORAGE_KEY } from "@/ui/sidebar-width";
import { installNavigationMarks, isMeasuredHref, markNavigation, startNavigation } from "@/platform/perf-marks";
import { installPageApi } from "@/features/composer";

const AppSidebar = dynamic(() => import("@/features/sessions/rail/app-sidebar").then((mod) => mod.AppSidebar));

function isSettingsRoute(pathname: string): boolean {
  return pathname === "/settings" || /^\/projects\/[^/]+\/settings(\/|$)/.test(pathname);
}

function isSoloRoute(pathname: string): boolean {
  return /^(?:\/hosts\/[^/]+)?\/projects\/[^/]+\/sessions\/[^/]+\/solo\/?$/.test(pathname);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const settings = isSettingsRoute(pathname);
  const railless = settings || isSoloRoute(pathname);
  useEffect(() => {
    installPageApi();
  }, []);
  useEffect(() => {
    installNavigationMarks();
    if (!isMeasuredHref(pathname)) return;
    startNavigation(pathname, "route");
    markNavigation("commit", pathname);
  }, [pathname]);
  return (
    <SidebarProvider storageKey={APP_SIDEBAR_STORAGE_KEY} className="app-ground bg-sidebar">
      {!railless && (
        <Suspense fallback={null}>
          <AppSidebar />
        </Suspense>
      )}
      <SidebarInset
        className={cn(
          "flex h-dvh min-w-0 flex-col",
          "md:m-[var(--app-island-inset)] md:h-[calc(100dvh-var(--app-island-span))] md:rounded-xl md:shadow-1",
          "md:has-[[data-surfaces]]:bg-transparent md:has-[[data-surfaces]]:shadow-none md:has-[[data-surfaces]]:rounded-none",
          "md:has-[[data-surfaces]]:overflow-visible",
          railless
            ? "md:ml-[var(--app-island-inset)]"
            : "md:ml-0 md:peer-data-[state=collapsed]:ml-[var(--app-island-inset)]",
        )}
      >
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}

function cn(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
