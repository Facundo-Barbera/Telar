/**
 * WHEN A FAILED READ IS A BANNER RATHER THAN AN ERROR CARD.
 *
 * The cockpit is a big component and this is a rule, not a rendering: an
 * engine that stopped answering while a transcript is on screen must not
 * replace that transcript with "Engine unavailable" — the conversation was
 * true a moment ago and is still the most useful thing the window can show.
 * Any OTHER failure is still an error, because it says something about the
 * request rather than about the reachability of the machine.
 *
 * Pure so the rule can be read and tested without a browser; the cockpit only
 * decides what to draw with the answer.
 */

/** The two codes that mean "the machine, not the request" — the same pair
 *  `SessionProblem` reads to title itself "Engine unavailable". */
const UNREACHABLE = new Set(["engine_unavailable", "engine_locked"]);

export type StaleInput = {
  /** The failed read's engine code, when it had one. */
  code?: string;
  /** Is a snapshot — cached or live — already on screen? Nothing to keep
   *  otherwise, and a bare window with a quiet banner tells you nothing. */
  hasContent: boolean;
  /** `savedAt` of the recorded snapshot being shown, if it is one. */
  cachedAt?: number;
  /** When the last successful read landed, for content that WAS live. */
  lastLiveAt?: number;
};

/**
 * The moment the content on screen was last known true, or `undefined` when
 * this failure should be reported as an error like any other.
 *
 * The NEWER of the two stamps: a screen that opened on a recording and then
 * hydrated is dated by the hydrate, not by the photograph it replaced.
 */
export function decideStale({ code, hasContent, cachedAt, lastLiveAt }: StaleInput): number | undefined {
  if (!hasContent || !code || !UNREACHABLE.has(code)) return undefined;
  const at = Math.max(cachedAt ?? 0, lastLiveAt ?? 0);
  return at === 0 ? undefined : at;
}
