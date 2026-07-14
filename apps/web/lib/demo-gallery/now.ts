// One frozen clock for the whole demo gallery.
//
// WHY THIS EXISTS: fixtures store timestamps as `NOW - offset` and components
// render ages as `now - ts` ("8m ago", the Today/This-week buckets). If those
// two `now`s are read from the wall clock (`Date.now()`) they are captured at
// DIFFERENT instants on the server (SSR) and in the browser (hydration) — and on
// a quiet dev server the server-side module clock can be minutes stale before a
// recompile. The server-rendered age text then disagrees with the client's,
// React throws "Hydration failed", regenerates the tree, and the demo stage
// paints EMPTY. Anchoring every SSR-path age computation to one shared, constant
// epoch makes server and client agree by construction, so the stage always
// paints. Post-mount replay clocks (setInterval ticks, elapsed durations that
// cancel their own absolute base) may keep the real `Date.now()` — they never
// contribute to the first render.
export const DEMO_NOW = new Date("2026-07-14T09:30:00Z").getTime();

// Deterministic "time ago" — a copy of @/lib/format's fmtAgo with the wall clock
// swapped for DEMO_NOW. The product formatter reads Date.now() (correct in the
// live app, fatal for a hydrated demo), so the gallery uses this one instead.
export function fmtAgo(ts: number): string {
  const s = Math.floor((DEMO_NOW - ts) / 1000);
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

// fmtCost has no clock dependency; re-exported so gallery surfaces keep a single
// import site alongside the deterministic fmtAgo.
export { fmtCost } from "@/lib/format";
