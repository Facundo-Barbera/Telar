type WindowAppearance = {
  translucent: boolean;
  /** "blur" is macOS vibrancy; "clear" is no effect view behind the page's own wash. */
  frost: "blur" | "clear";
  /** False off macOS. */
  supported: boolean;
};

export type AppearanceBridge = {
  get: () => Promise<WindowAppearance>;
  set: (patch: Partial<Pick<WindowAppearance, "translucent" | "frost">>) => Promise<WindowAppearance>;
};

/** Undefined in a plain browser tab, where the desktop bridge is absent. */
export function desktopAppearance(): AppearanceBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { appearance?: AppearanceBridge } }).telarDesktop?.appearance;
}
