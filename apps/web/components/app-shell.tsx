"use client";

import { useEffect, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { APP_SIDEBAR_STORAGE_KEY } from "@/lib/sidebar-width";
import { installNavigationMarks, isMeasuredHref, markNavigation, startNavigation } from "@/lib/perf-marks";
import { installPageApi } from "@/lib/page-api";

/**
 * THE RAIL IS A SEPARATE CHUNK, because this file is in the ROOT LAYOUT and the
 * rail is the largest thing in the app (#492).
 *
 * A static import here put `app-sidebar.tsx` — and the command palette and the
 * project palette it pulls in behind it — into the one bundle every route in the
 * cockpit loads, INCLUDING the routes three lines below that decide not to draw
 * it. Settings paid for a rail it renders `false` for; so did `/pair`, and the
 * not-found page. That is the "even an empty page takes a long time" in #490,
 * measured: `scripts/route-bytes.mjs` reads it off a build.
 *
 * SERVER RENDERING IS KEPT (no `ssr: false`). The rail is real chrome, not a
 * widget behind a click: a settings route never asks for this chunk at all, and
 * a cockpit route asks for it in the same payload that renders it, so the split
 * costs that route nothing it can see. `ssr: false` would have bought a little
 * more and paid for it with a frame of missing rail on every conversation.
 */
const AppSidebar = dynamic(() => import("./app-sidebar").then((mod) => mod.AppSidebar));

/**
 * SETTINGS SCREENS CARRY NO APP RAIL. They bring a full-height side-nav of
 * their own (`SettingsShell`), and two rails side by side read as two apps.
 * The settings nav's Back arrow is the one road out, so nothing the app rail
 * offers is needed while you are here. The provider still mounts — the inset
 * and the session surfaces' sidebar hooks read its context — the RAIL is what
 * stays home.
 */
function isSettingsRoute(pathname: string): boolean {
  return pathname === "/settings" || /^\/projects\/[^/]+\/settings(\/|$)/.test(pathname);
}

/**
 * The product shell: a resizable rail and the inset it frames, BOTH AS
 * ISLANDS. The wrapper is the ground (`bg-sidebar`); the rail is the
 * primitive's `floating` variant (an 8px-padded, ring-bordered card), and the
 * inset gets the matching margin, radius and border so the two read as one
 * pair of cards on one ground. On a phone the rail is a sheet and the inset
 * fills the viewport — the `md:` prefix is what keeps that.
 *
 * `h-dvh` on the inset (not `min-h-dvh`) is what makes the transcript scroll
 * INSIDE its own column instead of growing the document — the composer stays
 * pinned to the floor because the column it lives in cannot exceed the viewport.
 * With the 8px margins that becomes `calc(100dvh - 1rem)`.
 *
 * ONE KEY FOR BOTH HALVES. The provider persists collapsed-ness and the rail
 * persists its dragged width, but they write into the SAME localStorage record
 * (see lib/sidebar-width.ts).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const settings = isSettingsRoute(pathname);
  /**
   * THE CLOCK, FITTED WHERE EVERY ROUTE PASSES (#492).
   *
   * This is the one client component the whole cockpit renders, which makes it
   * the only place `window.telarNavTimings()` can be promised from — a packaged
   * build opened straight onto Settings used to have no reader at all, because
   * the two components that fitted one (the front door, the cockpit) are not on
   * that screen. See lib/perf-marks.ts.
   *
   * BOTH CALLS ARE IDEMPOTENT AND THAT IS THE POINT. `startNavigation` keeps
   * the earlier stamp when a press already began this opening, so a cold load
   * gets a clock without a click losing its own; and child effects run before
   * parent ones, so on a conversation the cockpit's `commit` — the same commit,
   * measured by the component that knows what landed in it — is still the one
   * recorded, and this is a no-op.
   */
  /**
   * `window.telar`, FITTED IN THE SAME PLACE AND FOR THE SAME REASON (#548).
   *
   * An external client — the Quest cockpit, which runs this app in a WebView
   * and can only run JavaScript in the page — has to find the three calls
   * whatever route the window opened on, and on EVERY host: this is the web
   * app, not the desktop shell, so gating it on `window.telarDesktop` would
   * hide it from the one client that asked for it. Idempotent, so mounting
   * this shell again costs nothing. See lib/page-api.ts.
   */
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
    // `app-ground`: the wrapper is the GROUND — solid `bg-sidebar` in an
    // opaque window, transparent under the translucent shell so the body's
    // single wash shows through (globals.css). The islands paint on top of it.
    <SidebarProvider storageKey={APP_SIDEBAR_STORAGE_KEY} className="app-ground bg-sidebar">
      {!settings && <AppSidebar />}
      <SidebarInset
        className={cn(
          "flex h-dvh min-w-0 flex-col",
          // The island: margin on every side, `ml-0` beside the rail because the
          // rail's own padding already holds the gap; back to `ml-2` once the
          // rail is collapsed away.
          // Rounded like the rail, but NO BORDER: a hairline on this edge reads
          // as a divider between the two islands. The shadow alone lifts the
          // card, the same treatment the primitive's own `inset` variant uses.
          // `--app-island-inset`, NOT `m-2`: the spacing scale is rem, and this
          // gutter is measured against the traffic lights (globals.css).
          "md:m-[var(--app-island-inset)] md:h-[calc(100dvh-var(--app-island-span))] md:rounded-xl md:shadow-1",
          // A SCREEN MADE OF SEVERAL SURFACES draws its own cards: the cockpit
          // marks its <main data-surfaces> and this inset becomes the ground
          // between them instead of one card around them. Every other route
          // keeps the single island above.
          "md:has-[[data-surfaces]]:bg-transparent md:has-[[data-surfaces]]:shadow-none md:has-[[data-surfaces]]:rounded-none",
          // The inset itself must not clip either, or the cards' rings lose
          // their outer edge against the gutter.
          "md:has-[[data-surfaces]]:overflow-visible",
          settings
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
