/** Presentation only: never used for persisted text or journal cursors. */
export function revealPrefix(shown: string, target: string, elapsedMs: number): string {
  if (!target.startsWith(shown)) return target;
  const backlog = target.length - shown.length;
  let end = Math.min(target.length, shown.length + Math.max(1, Math.ceil(Math.max(80, backlog * 6) * Math.min(elapsedMs, 100) / 1000)));
  // Do not render half of a UTF-16 surrogate pair.
  if (end < target.length && /[\uD800-\uDBFF]/.test(target[end - 1]!)) end += 1;
  return target.slice(0, end);
}
