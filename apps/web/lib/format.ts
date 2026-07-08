// Shared display formatters. One home for the tiny functions every surface
// repeats — relative time, model cost, truncated ids — so pages read as one
// system instead of drifting per-file.

/** Relative "time ago", compact and coarsening as it recedes into the past. */
export function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
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

/** USD cost fixed to four places — the granularity model spend needs. */
export function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** First 8 chars of an id — enough to recognize, short enough to sit inline. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
