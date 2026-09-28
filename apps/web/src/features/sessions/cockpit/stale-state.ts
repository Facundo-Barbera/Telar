
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
  /** When the last successful read landed, for content that was live. */
  lastLiveAt?: number;
};

export function decideStale({ code, hasContent, cachedAt, lastLiveAt }: StaleInput): number | undefined {
  if (!hasContent || !code || !UNREACHABLE.has(code)) return undefined;
  const at = Math.max(cachedAt ?? 0, lastLiveAt ?? 0);
  return at === 0 ? undefined : at;
}
