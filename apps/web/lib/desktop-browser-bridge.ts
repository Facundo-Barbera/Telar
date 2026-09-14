/**
 * IS THERE A NATIVE BROWSER TO DRIVE? — four lines, kept away from the 136 kB
 * surface that answers to them (#492).
 *
 * This used to live in `components/browser-live.tsx`, next to the type it
 * returns and the surface that uses it, which is where it reads best and was
 * exactly the wrong place for it: three modules ask this question — the cockpit,
 * the right panel, and `lib/session-links.ts` — and none of them is drawing a
 * browser when they ask. A static import for a `typeof window` check therefore
 * pinned the whole live-browser surface, its annotate overlay and its viewport
 * machinery into the conversation route's first bundle, where `next/dynamic` on
 * `DesktopBrowserSurface` could not shift it: the module was already reachable
 * by a second road.
 *
 * THE TYPE STAYS WHERE IT IS DOCUMENTED. `import type` is erased, so naming
 * `DesktopBrowserBridge` here costs no runtime edge back to that module — the
 * shape is described beside the surface that implements every method of it, and
 * only the probe moved.
 */
import type { DesktopBrowserBridge } from "@/components/browser-live";
import { hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";

/** The shell's bridge, or undefined outside the desktop app. */
export function desktopBrowserBridge(): DesktopBrowserBridge | undefined {
  if (typeof window === "undefined" || hostFromPathname(window.location.pathname) !== LOCAL_HOST_ID) return undefined;
  return (window as unknown as { telarDesktop?: { browser?: DesktopBrowserBridge } }).telarDesktop?.browser;
}
