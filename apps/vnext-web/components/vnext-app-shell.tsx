"use client";

import type { ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { APP_SIDEBAR_STORAGE_KEY } from "@/lib/sidebar-width";
import { VNextSidebar } from "./vnext-sidebar";

/**
 * The product shell: a resizable rail and the inset it frames.
 *
 * Both come from the shared Sidebar primitive rather than from a bespoke CSS
 * grid — which is what the cockpit used to do, and why the rail did not match
 * Telar's: no keyboard toggle, no rail drag, no persisted width, no mobile
 * sheet, and a hand-rolled scrim in place of the real one.
 *
 * `h-dvh` on the inset (not `min-h-dvh`) is what makes the transcript scroll
 * INSIDE its own column instead of growing the document — the composer stays
 * pinned to the floor because the column it lives in cannot exceed the viewport.
 */
/**
 * ONE KEY FOR BOTH HALVES. The provider persists collapsed-ness and the rail
 * persists its dragged width, but they write into the SAME localStorage record
 * (see lib/sidebar-width.ts). Handing the provider a different key than the one
 * `VNextSidebar` gives its `resizable` options splits that record in two, and
 * the rail comes back at the default width every reload.
 */
export function VNextAppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider storageKey={APP_SIDEBAR_STORAGE_KEY}>
      <VNextSidebar />
      <SidebarInset className="flex h-dvh min-w-0 flex-col">{children}</SidebarInset>
    </SidebarProvider>
  );
}
