type DesktopApp = {
  relaunch: () => Promise<void>;
  openWindow?: (path: string) => Promise<{ ok: boolean; error?: string }>;
};

export function desktopApp(): DesktopApp | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as { telarDesktop?: { app?: DesktopApp } }).telarDesktop;
  return bridge?.app;
}
