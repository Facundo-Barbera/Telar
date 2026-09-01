/**
 * The desktop shell's window-appearance bridge, as this cockpit sees it.
 *
 * Same shape and same reasoning as desktop-updates.ts: a local structural type
 * and an accessor, because in a browser tab the bridge is legitimately absent.
 * The renderer's half of translucency (the alpha surfaces) lives in
 * lib/appearance.ts; this is only the vibrancy layer the page cannot create.
 */

export type WindowAppearance = {
  translucent: boolean;
  /** False off macOS — the cockpit hides the control rather than offering a
   *  toggle that cannot do anything. */
  supported: boolean;
};

export type AppearanceBridge = {
  get: () => Promise<WindowAppearance>;
  set: (patch: Partial<Pick<WindowAppearance, "translucent">>) => Promise<WindowAppearance>;
};

export function desktopAppearance(): AppearanceBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { appearance?: AppearanceBridge } }).telarDesktop?.appearance;
}
