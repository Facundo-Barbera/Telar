/**
 * WHEN THE COMPOSER SAYS THE CONTEXT IS GETTING FULL — issue #587, step 1.
 *
 * ── WHAT WENT WRONG WITH A PROPORTION ALONE ────────────────────────────────
 * This was `contextShare >= 0.75` and nothing else. On a 200k window that is
 * 150,000 tokens, which is roughly where the provider's own compaction fires
 * anyway, so the notice arrived when it was useful. Then the default model
 * became `[1m]` and `contextMax` became 1,000,000 — and the same line silently
 * moved the nudge from ~150k to **750,000**. Nobody changed this file. The only
 * compaction pressure in the product was expressed as a fraction of a window
 * that got five times bigger, and #587's measured sawtooth peaks at 700–740k,
 * just underneath it.
 *
 * ── SO: AN ABSOLUTE BAND AS WELL, AND `OR` RATHER THAN `AND` ───────────────
 * Whichever comes first. The two arms answer different questions and neither
 * subsumes the other:
 *
 *   - the PROPORTION is about the window running out, and it is the one that
 *     matters on a small window, where 250k is unreachable;
 *   - the BAND is about the session being expensive, and it is the one that
 *     matters on a large window, where 75% is most of a million tokens.
 *
 * On a 200k window nothing changes at all: 75% is 150,000 and fires first, so a
 * short conversation and an account with no 1M entitlement see exactly what
 * they saw before. That is the property worth keeping — #587's own rule that
 * the failure mode to avoid is "a scheme tuned to 700k transcripts that
 * compacts a short session and loses context nobody needed to lose", and it is
 * avoided by never expressing the threshold ONLY as a fraction of a window.
 *
 * ── WHY 250,000 ────────────────────────────────────────────────────────────
 * It is above every short-window account's own trigger and below the band the
 * expensive sessions actually live in. An account without 1M entitlement
 * compacts near 167k on its own (the CLI's `window − 20,000 − 13,000` on a
 * 200k window), so a 250k band can never fire first for them — their session is
 * squeezed before it gets there. For a 1M session it lands a long way before
 * the CLI's own ~967k trigger, which is the gap #587 is about.
 *
 * THIS NOTICE IS A SENTENCE, NOT A MECHANISM. It does not compact anything; it
 * tells a person that compacting is now the next thing worth doing. That is why
 * an absolute number is safe here in a way it would not be in a scheme that
 * acted on it: the worst case is a banner somebody dismisses.
 */

/**
 * The absolute band. A token count, not a fraction — see the file header for
 * why the two arms are both needed and why this number is where it is.
 */
export const CONTEXT_NOTICE_TOKENS = 250_000;

/** The proportion arm, unchanged since before #587. */
export const CONTEXT_NOTICE_SHARE = 0.75;

export type ContextUsage = { contextUsed?: number | null; contextMax?: number | null };

/**
 * The share of the window in use, or 0 when the session has not reported one.
 * Zero rather than undefined so a caller cannot accidentally compare against
 * `NaN` and get `false` for every arm at once.
 */
export function contextShareOf(usage: ContextUsage | undefined): number {
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  if (!used || !max || max <= 0) return 0;
  return used / max;
}

/**
 * Is the context full enough to say so? Either arm is enough.
 *
 * Note the order of the guards: a session that reports no usage at all is not
 * "0% full", it is unknown, and an unknown must not fire either arm.
 */
export function contextNoticeDue(usage: ContextUsage | undefined): boolean {
  const used = usage?.contextUsed;
  if (!used || used <= 0) return false;
  return used >= CONTEXT_NOTICE_TOKENS || contextShareOf(usage) >= CONTEXT_NOTICE_SHARE;
}

/** Which arm fired, for the banner's own wording and for tests to assert on. */
export function contextNoticeReason(usage: ContextUsage | undefined): "band" | "share" | undefined {
  if (!contextNoticeDue(usage)) return undefined;
  // The share is named first when both are true: on a window where 75% is past
  // the band, running out is the more urgent of the two facts.
  return contextShareOf(usage) >= CONTEXT_NOTICE_SHARE ? "share" : "band";
}
