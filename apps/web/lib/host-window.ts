/**
 * Whether this window is the host's, which owns the published look. Loopback catches a
 * browser tab on the machine; the desktop bridge catches the shell on a LAN address.
 * Not a security boundary; the pairing gate is.
 */

import { desktopAppearance } from "./desktop-appearance";

/** `.localhost` resolves to loopback by specification (RFC 6761). IPv6 arrives bracketed
 *  from `location.hostname` on some browsers and bare on others. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function isHostWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (desktopAppearance() !== undefined) return true;
  return isLoopbackHost(window.location.hostname);
}
