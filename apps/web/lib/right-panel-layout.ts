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
