/** The desktop shell's lifecycle bridge; absent in a browser tab. */
type DesktopApp = {
  relaunch: () => Promise<void>;
  /**
   * Opens a second window on an app path; the shell refuses anything off-origin.
   * Optional: older shells do not carry it.
   */
  openWindow?: (path: string) => Promise<{ ok: boolean; error?: string }>;
};

export function desktopApp(): DesktopApp | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as { telarDesktop?: { app?: DesktopApp } }).telarDesktop;
  return bridge?.app;
}
