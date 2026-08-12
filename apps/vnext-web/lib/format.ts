// Shared display formatters. One home for the tiny functions every surface
// repeats — relative time, model cost, truncated ids — so pages read as one
// system instead of drifting per-file.

/** Relative "time ago", compact and coarsening as it recedes into the past. */
export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/**
 * `fmtCost` USED TO LIVE HERE and money is no longer a unit this cockpit
 * reports.
 *
 * The engine still carries `UsageSnapshot.costUsd` — it is the provider's own
 * figure and throwing it away would be lossy — but a price shown beside a turn
 * invites a comparison it cannot support: only some providers report one, a
 * subscription seat has no per-turn price at all, and a session that reported
 * nothing rendered as `$0.0000`, which reads as free rather than as unknown.
 * TOKENS are reported by every provider, are the thing that actually runs out,
 * and are what a human can act on. `fmtTokens` is the unit everywhere.
 */

/** First 8 chars of an id — enough to recognize, short enough to sit inline. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Compact token-count formatter: 1_234 -> "1.2k", 1_234_567 -> "1.2M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
