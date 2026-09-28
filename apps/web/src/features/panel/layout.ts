import { PLUGIN_SURFACES } from "@/features/plugins";

export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "right-panel";
export const RIGHT_PANEL_DEFAULT_WIDTH = 480;
export const RIGHT_PANEL_MIN_WIDTH = 384;

/** For surfaces whose content sets their width (a notebook, a file beside its tree). */
export const RIGHT_PANEL_WIDE_DEFAULT_WIDTH = 720;

/** The kinds whose content sets their width rather than the column doing it:
 *  the Editor, and any plugin surface that declares itself `wide` (Data). */
const isWide = (kind: string) => kind === "editor" || PLUGIN_SURFACES.some((surface) => surface.wide && surface.id === kind);

/** Only a default, behind a stored width; the widest kind in the strip decides so switching tabs never jumps. */
export function defaultRightPanelWidth(tabs: readonly { kind: string }[]): number {
  return tabs.some((tab) => isWide(tab.kind)) ? RIGHT_PANEL_WIDE_DEFAULT_WIDTH : RIGHT_PANEL_DEFAULT_WIDTH;
}

/** Bounds both the drag and the CSS `max-width` the panel carries when the window shrinks. */
export const RIGHT_PANEL_MAIN_MIN_WIDTH = 384;
