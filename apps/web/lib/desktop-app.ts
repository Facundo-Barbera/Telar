/**
 * The desktop shell's own lifecycle, as the cockpit may ask for it — a local
 * structural type and an accessor, like `desktop-updates.ts`, because in a
 * browser tab the bridge is never there.
 */
type DesktopApp = { relaunch: () => Promise<void> };

export function desktopApp(): DesktopApp | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as { telarDesktop?: { app?: DesktopApp } }).telarDesktop;
  return bridge?.app;
}
