
import { desktopAppearance } from "@/platform/desktop/desktop-appearance";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function isHostWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (desktopAppearance() !== undefined) return true;
  return isLoopbackHost(window.location.hostname);
}
