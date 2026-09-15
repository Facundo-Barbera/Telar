/**
 * The seam every Telar toolkit is built on. Lifted out of the first toolkit and
 * `sessions-tools/tools.ts`, where the same four lines were duplicated so that
 * neither imported the provider SDK — a rule this file keeps: nothing here
 * touches the SDK, so a unit test drives any toolkit with a fake factory.
 *
 * ── EVERY JSON ANSWER IS BOUNDED, AND THE BOUND IS HERE (#515) ──────────────
 * A tool answer is not output: it is the caller's CONTEXT WINDOW, spent. One
 * `sessions_list` used a 256k agent's whole context — 142 KB for 334 rows,
 * because the wall folded every row the store called live and no number
 * anywhere said stop.
 *
 * Each toolkit bounds its own answer with the shape it knows: a page of events,
 * a count of turns, a preview instead of a body. Those are the real fix, and a
 * shaped bound beats a truncation every time. `bounded` is what sits UNDER all
 * of them, so a toolkit that forgets — or a store that grows a field nobody
 * measured — cannot put an unbounded string in a model's context. It is a
 * backstop, not the design: a tool that regularly trips it is a tool whose own
 * paging is missing.
 *
 * THE TRUNCATION IS MARKED AND COUNTED, never silent. Clipped JSON does not
 * parse, and a caller that cannot tell "this is all of it" from "this is what
 * fit" will report the first ten minutes of a session as its whole life. The
 * marker says how much is missing so the caller knows to narrow its ask.
 */
export type ToolFactory = (
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
) => unknown;

/**
 * The backstop budget, in characters, for one tool answer.
 *
 * Chosen against what the shaped bounds already produce: a full `sessions_read`
 * page is ~12 KB, a 50-row `sessions_list` ~4 KB. 16k leaves every well-shaped
 * answer untouched and still refuses the 142 KB one, which is what a backstop
 * is for. A toolkit with a good reason for more passes its own `max`.
 */
export const MAX_ANSWER_CHARS = 16_000;

/**
 * One answer, clamped to a character budget and MARKED where it was clamped.
 *
 * Returns the text unchanged when it fits — the ordinary case, and the one that
 * must cost nothing.
 */
export function bounded(text: string, max: number = MAX_ANSWER_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters not shown]`;
}

/**
 * AS MANY ROWS AS FIT, AND HOW MANY THERE WERE — the shaped bound every list
 * on these walls uses, so there is one of it rather than five.
 *
 * TWO NUMBERS, WHICHEVER IS REACHED FIRST, for the reason a page of events
 * needs both: a count alone lets fifty rows carrying a megabyte through, and a
 * byte budget alone will happily return four thousand tiny ones. A row is
 * mostly free text somebody typed, so neither number can be trusted on its own.
 *
 * THE FIRST ROW ALWAYS GOES THROUGH, whatever it costs. A page of nothing with
 * a cursor that never advances is a caller that can never finish.
 *
 * `measure` MATCHES HOW THE ANSWER IS WRITTEN — `json` pretty-prints at two
 * spaces, and sizing against compact JSON understated every budget by about a
 * third.
 */
export function fillWithin<T, R>(items: readonly T[], shape: (item: T) => R, options: { limit: number; chars: number }): { rows: R[]; shown: number } {
  const rows: R[] = [];
  let chars = 0;
  for (const item of items) {
    if (rows.length >= options.limit) break;
    const row = shape(item);
    const size = JSON.stringify(row, null, 2)?.length ?? 0;
    if (rows.length > 0 && chars + size > options.chars) break;
    rows.push(row);
    chars += size;
  }
  return { rows, shown: rows.length };
}

export const ok = (text: string) => ({ content: [{ type: "text", text }] });
export const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
/** A JSON answer, always bounded. `max` raises or lowers the backstop for one
 *  toolkit that has measured its own shape and wants a different number. */
export const json = (value: unknown, max?: number) => ok(bounded(JSON.stringify(value, null, 2) ?? "null", max));
export const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));
