/**
 * The desktop shell's own lifecycle, as the cockpit may ask for it — a local
 * structural type and an accessor, like `desktop-updates.ts`, because in a
 * browser tab the bridge is never there.
 */
type DesktopApp = {
  relaunch: () => Promise<void>;
  /**
   * A SECOND WINDOW ON A PAGE OF THE APP, from a PATH — the shell resolves it
   * against the asking window's own address and refuses anything off-origin
   * (apps/desktop/window-target.js).
   *
   * Optional, like `workspace.openFile`: a shell packaged before this exists
   * does not carry it, and the menu item that would call it is absent rather
   * than promising something nothing answers.
   */
  openWindow?: (path: string) => Promise<{ ok: boolean; error?: string }>;
};

export function desktopApp(): DesktopApp | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as { telarDesktop?: { app?: DesktopApp } }).telarDesktop;
  return bridge?.app;
}
