/**
 * The right panel's sizing constants, ported from the frozen app's
 * lib/right-panel-layout.ts.
 *
 * They live apart from the component so the resize handle, the panel shell and
 * any test can agree on one set of numbers rather than three copies that drift.
 */
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "right-panel";
export const RIGHT_PANEL_DEFAULT_WIDTH = 480;
export const RIGHT_PANEL_MIN_WIDTH = 384;

/**
 * WIDE ENOUGH FOR A DOCUMENT, which some surfaces simply are.
 *
 * 480px is a good column for a list — changed files, sub-agents, issues — and
 * it is the wrong shape for a notebook, a PDF page or a file beside its tree:
 * those have a width the CONTENT decides, and below it they do not get denser,
 * they get unreadable (#357). A Data or Editor tab opening at 480 therefore
 * asked to be dragged wider every single time.
 */
export const RIGHT_PANEL_WIDE_DEFAULT_WIDTH = 720;

/** The kinds whose content sets their width rather than the column doing it. */
const WIDE_KINDS: ReadonlySet<string> = new Set(["data", "editor"]);

/**
 * HOW WIDE THE PANEL OPENS WHEN NOBODY HAS SAID OTHERWISE.
 *
 * A DEFAULT, and only a default: the caller reaches this after a stored width
 * comes back empty, so a panel the person has ever dragged is untouched by it
 * — including one they deliberately made narrow.
 *
 * THE WIDEST THING IN THE STRIP DECIDES. Not the first tab and not the active
 * one: a strip holding a notebook is a strip that needs the room whichever tab
 * is showing, and a rule that read the active tab would make the panel jump
 * every time you switched between two of them.
 */
export function defaultRightPanelWidth(tabs: readonly { kind: string }[]): number {
  return tabs.some((tab) => WIDE_KINDS.has(tab.kind)) ? RIGHT_PANEL_WIDE_DEFAULT_WIDTH : RIGHT_PANEL_DEFAULT_WIDTH;
}

/**
 * How little of the conversation column the panel may leave behind.
 *
 * ONE NUMBER, USED TWICE, and it has to be: it bounds the drag AND it is the
 * `max-width` the panel carries in CSS for when the WINDOW shrinks rather than
 * the handle moving. Those were 480 and 384 respectively, so a window narrow
 * enough to matter resolved them in CSS's favour and the panel went thinner than
 * anything could stop.
 */
export const RIGHT_PANEL_MAIN_MIN_WIDTH = 384;

/**
 * THE SPOOL'S PANEL REMEMBERS ITS OWN WIDTH.
 *
 * A separate key rather than sharing the cockpit's: the two panels hold
 * different things — a diff wants one width, a packet's prose wants another —
 * and one shared number would mean widening to read a brief also widened the
 * surface you were not looking at.
 */
export const SPOOL_PANEL_WIDTH_STORAGE_KEY = "spool-panel";
