/**
 * WHEN THE COMPOSER SAYS THE CONTEXT IS GETTING HEAVY.
 *
 * ONE RULE, AND IT IS A SHARE. The notice is due once the session has used at
 * least `percent` of the model's window, and nothing else fires it. A share
 * rather than a token count because the window is not a constant: the same
 * number has to mean the same thing to an account with 256,000 tokens and to
 * one with 1,000,000, and only a proportion does. 70 is the default, and a
 * login that disagrees says so — `contextNoticePercent` on its provider
 * instance is this same number, per account.
 *
 * THE HISTORY, IN ONE PARAGRAPH. This was `share >= 0.75`; #587 added an
 * absolute band at 250,000 tokens beside it and fired on whichever came first,
 * because a 1M window had silently moved the proportion's trigger from ~150k to
 * 750k. The band is gone. On today's windows a 250,000-token conversation is
 * ordinary use, so the band fired in the middle of every working session — and
 * a banner that is always there is one nobody reads.
 *
 * THIS NOTICE IS A SENTENCE, NOT A MECHANISM. It compacts nothing; it says that
 * compacting is now the next thing worth doing. Which is also why waving it
 * away is cheap, and why the dismiss is kept — see context-notice-dismissal.ts.
 */

/** The share of the window that counts as heavy when a login has not said. */
export const CONTEXT_NOTICE_DEFAULT_PERCENT = 70;

export type ContextUsage = { contextUsed?: number | null; contextMax?: number | null };

/**
 * The share of the window in use, or 0 when the session has not reported one.
 * Zero rather than undefined so a caller cannot accidentally compare against
 * `NaN` and get `false` for a reading that was simply absent.
 */
export function contextShareOf(usage: ContextUsage | undefined): number {
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  if (!used || !max || max <= 0) return 0;
  return used / max;
}

/**
 * Is the context full enough to say so?
 *
 * AN UNKNOWN READING NEVER FIRES, and it costs no guard: `contextShareOf`
 * answers 0 for a session with no `contextUsed` or no `contextMax`, and 0 is
 * below every percentage this accepts. A session that reports nothing is not
 * "0% full", it is unknown — and the two happen to want the same answer.
 */
export function contextNoticeDue(usage: ContextUsage | undefined, percent = CONTEXT_NOTICE_DEFAULT_PERCENT): boolean {
  return contextShareOf(usage) >= percent / 100;
}

/**
 * A stored percentage, or the default.
 *
 * THE ONE DOOR BOTH SURFACES USE — the composer, which must never be handed a
 * threshold that makes the banner unreachable or permanent, and the settings
 * field, which has to show a number even for a login that has never set one.
 * The engine already refuses anything outside 1–100 on the way in; this is
 * about what a cockpit does with a value it did not validate itself, which
 * includes `undefined` for every login that has left the setting alone.
 */
export function normaliseContextNoticePercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CONTEXT_NOTICE_DEFAULT_PERCENT;
  return Math.min(100, Math.max(1, Math.round(value)));
}
