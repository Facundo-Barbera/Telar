/**
 * IS THIS WINDOW THE HOST'S?
 *
 * WHY THE QUESTION EXISTS. The cockpit is reachable from more than the machine
 * it runs on: a tailscale'd phone or laptop opens the same app, with the same
 * full-access pairing, and every one of those windows runs the same code. For
 * most of the app that is the whole point — a remote window IS the cockpit. For
 * the two things below it is a bug:
 *
 *   PUBLISHING. The published look is "what the HOST looks like". A remote
 *   browser has its own localStorage and its own taste, so two windows both
 *   publishing means each overwrites the other every couple of seconds, and the
 *   answer a phone reads is whichever one wrote last.
 *
 *   READING. Symmetrically, offering "wear the host's look" inside the host's
 *   own window is offering somebody their own reflection.
 *
 * HOW IT IS DECIDED. Loopback OR the desktop bridge, and both are needed:
 * loopback catches a plain browser tab opened on the machine itself, and the
 * bridge catches the packaged shell, which serves the app over a LAN address in
 * some configurations and is unambiguously the host when it is there at all.
 * Nothing here is a security boundary — the pairing gate is — this only decides
 * which window owns the published look.
 */

import { desktopAppearance } from "./desktop-appearance";

/** `.localhost` is included because the whole TLD resolves to loopback by
 *  specification (RFC 6761), and a dev proxy on `telar.localhost` is still this
 *  machine. IPv6 arrives bracketed from `location.hostname` on some browsers
 *  and bare on others, so both spellings are named. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function isHostWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (desktopAppearance() !== undefined) return true;
  return isLoopbackHost(window.location.hostname);
}
