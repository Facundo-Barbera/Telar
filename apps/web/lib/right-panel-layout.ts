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

/**
 * THE ORCHESTRATOR'S PROGRAM/LEDGER PANEL — `/looms/[projectId]`.
 *
 * Its own remembered width, for the same reason the Spool's panel has one: the
 * Program is a column of short rows and the cockpit's panel is sized for a
 * diff, so one shared number would mean widening to read a diff also widened
 * the Program you were not looking at.
 *
 * IT DEFAULTS TO THE COCKPIT PANEL'S *FLOOR*, NOT ITS DEFAULT, and that is the
 * whole fix: the orchestrator already spends a rail on its looms before the
 * conversation gets a pixel, so a panel that opens at `RIGHT_PANEL_DEFAULT_WIDTH`
 * leaves the centre — the reason the page exists — narrower than itself.
 */
export const PROGRAM_PANEL_WIDTH_STORAGE_KEY = "loom-program-panel";
export const PROGRAM_PANEL_DEFAULT_WIDTH = RIGHT_PANEL_MIN_WIDTH;

/**
 * Below this WINDOW width the loom rail, the conversation and the Program
 * cannot all hold their floors at once, so the Program starts closed rather
 * than crushing the conversation to a vertical ribbon of single words.
 *
 * The arithmetic, and why it is not a guess: the app shell's rail is 16rem, the
 * loom rail is ~210px, the conversation's floor is `RIGHT_PANEL_MAIN_MIN_WIDTH`
 * and the panel's is `RIGHT_PANEL_MIN_WIDTH` — 1234px, rounded to the 1280 the
 * cockpit already calls narrow so the two surfaces fold at the same place.
 */
export const LOOM_NARROW_WINDOW = 1280;
