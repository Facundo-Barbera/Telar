/**
 * Ids for the fixture engine.
 *
 * DETERMINISTIC BY DEFAULT, because every scenario here is evidence and a
 * transcript whose ids change per run cannot be diffed against the last one.
 * Each prefix counts independently from a counter the fixture owns, so a
 * scenario that creates one session always names it `ses_1`.
 */
export function idFactory(): (prefix: string) => string {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}
