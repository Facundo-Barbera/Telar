/**
 * CLASS STRINGS THAT MORE THAN ONE COMPONENT HAS TO AGREE ON.
 *
 * A treatment only belongs here once a second file needs the SAME one and the
 * two drifting apart would be visible. Everything else stays inline, where it
 * is read next to the thing it styles.
 */

/**
 * THE SECTION CAPTION — the small grey word above a group of rows.
 *
 * Three rails declared this identically. None of them was wrong; they
 * were three copies of one decision, kept in step by a test that asserted the
 * strings matched. That test pinned the duplication rather than removing it —
 * it could only fail AFTER a rail had already drifted, and the fix it asked
 * for was to paste the string a fourth time.
 *
 * `text-3xs` (10px), semibold, uppercase, tracking-wider is the newer of the two
 * section-caption treatments this app has shipped; the rail's band labels used
 * to sit at 11px, regular weight, sentence case — a difference between two
 * "small grey word beside a rule" treatments with no reason beyond having been
 * written on different days.
 *
 * `text-sidebar-foreground/45` is deliberate and not interchangeable with
 * `text-muted-foreground`: a caption on the rail is measured against
 * `--sidebar`, not the canvas. A caption on a canvas surface is a different
 * object and keeps its own string.
 */
export const CAPTION =
  "text-3xs font-semibold uppercase tracking-wider text-sidebar-foreground/45";
