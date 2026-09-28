/**
 * Kept apart from `components/browser-live.tsx` so a `typeof window` check does
 * not pull the whole live-browser surface into the route's first bundle.
 */
import type { DesktopBrowserBridge } from "@/features/browser";
import { hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";

export function desktopBrowserBridge(): DesktopBrowserBridge | undefined {
  if (typeof window === "undefined" || hostFromPathname(window.location.pathname) !== LOCAL_HOST_ID) return undefined;
  return (window as unknown as { telarDesktop?: { browser?: DesktopBrowserBridge } }).telarDesktop?.browser;
}
