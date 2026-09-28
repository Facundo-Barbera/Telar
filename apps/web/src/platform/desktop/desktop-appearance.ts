type WindowAppearance = {
  translucent: boolean;
  frost: "blur" | "clear";
  supported: boolean;
};

export type AppearanceBridge = {
  get: () => Promise<WindowAppearance>;
  set: (patch: Partial<Pick<WindowAppearance, "translucent" | "frost">>) => Promise<WindowAppearance>;
};

export function desktopAppearance(): AppearanceBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { appearance?: AppearanceBridge } }).telarDesktop?.appearance;
}
