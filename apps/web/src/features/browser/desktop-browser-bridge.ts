import type { DesktopBrowserBridge } from "./types";
import { hostFromPathname, LOCAL_HOST_ID } from "@/platform/engine/host-client";

export function desktopBrowserBridge(): DesktopBrowserBridge | undefined {
  if (typeof window === "undefined" || hostFromPathname(window.location.pathname) !== LOCAL_HOST_ID) return undefined;
  return (window as unknown as { telarDesktop?: { browser?: DesktopBrowserBridge } }).telarDesktop?.browser;
}
