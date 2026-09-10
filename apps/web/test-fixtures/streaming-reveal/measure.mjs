/**
 * Measure the reveal pacer against realistic arrival schedules — the numbers
 * behind the pacing choice, re-runnable before and after a change.
 *
 *   bun apps/web/test-fixtures/streaming-reveal/measure.mjs
 *
 * Scenarios: steady 5/10/20 chars-per-second streams chunked at realistic
 * gaps, plus a bursty schedule (double chunk, long silence). The pacer is
 * stepped at 60Hz between arrivals, exactly as the hook drives it.
 *
 * Metrics per scenario, over the streaming window (first arrival → last chunk
 * fully rendered):
 *   - starved%  — fraction of frames with NO visible movement while the
 *                 stream is still active (the dead air the user reads as
 *                 stutter). Split into starvedEmpty (nothing left to show —
 *                 the pacer outran the stream) and starvedHeld (text in hand,
 *                 pacer chose stillness).
 *   - burst     — the maximum characters revealed inside any 100ms window,
 *                 as a multiple of the scenario's true arrival rate ("felt
 *                 speed" of the fastest moment).
 *   - lag       — per-character delay from arrival to render: mean / p95 /
 *                 max (the added latency the pacing buys its smoothness with).
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { revealState, stepReveal, advanceReveal } = await import(pathToFileURL(path.join(here, "..", "..", "lib", "streaming-reveal.ts")).href);

const FRAME = 1000 / 60;

/** chunks: [{ at, size }] — a schedule of arrivals. */
function simulate(chunks) {
  const end = chunks.at(-1).at;
  let state = revealState(0, 0);
  let target = 0;
  let next = 0;
  const renderAt = []; // renderAt[i] = when character i became visible
  const arrivalAt = [];
  for (const chunk of chunks) for (let i = 0; i < chunk.size; i += 1) arrivalAt.push(chunk.at);
  let frames = 0;
  let starvedEmpty = 0;
  let starvedHeld = 0;
  const reveals = []; // { at, count } per frame
  for (let t = 0; renderAt.length < arrivalAt.length; t += FRAME) {
    if (t > end + 60_000) throw new Error("pacer never finished");
    const before = Math.floor(state.shown);
    while (next < chunks.length && chunks[next].at <= t) {
      target += chunks[next].size;
      state = stepReveal(state, target, t);
      next += 1;
    }
    state = advanceReveal(state, t);
    const shown = Math.min(Math.floor(state.shown), target);
    for (let i = before; i < shown; i += 1) renderAt[i] = t;
    if (t >= chunks[0].at && t <= end) {
      frames += 1;
      if (shown === before) {
        if (before >= target) starvedEmpty += 1;
        else starvedHeld += 1;
      }
    }
    if (shown > before) reveals.push({ at: t, count: shown - before });
  }
  // burst: max chars in any 100ms sliding window
  let burst = 0;
  for (let i = 0; i < reveals.length; i += 1) {
    let sum = 0;
    for (let j = i; j < reveals.length && reveals[j].at - reveals[i].at <= 100; j += 1) sum += reveals[j].count;
    burst = Math.max(burst, sum);
  }
  // The longest visual stillness between two reveals while streaming. Text
  // moves in whole characters, so the floor of this is the source's own
  // inter-character interval — report both and read the ratio.
  let maxGap = 0;
  for (let i = 1; i < reveals.length; i += 1) maxGap = Math.max(maxGap, reveals[i].at - reveals[i - 1].at);
  const lags = arrivalAt.map((at, i) => renderAt[i] - at).sort((a, b) => a - b);
  const mean = lags.reduce((sum, lag) => sum + lag, 0) / lags.length;
  return {
    starvedEmptyPct: Math.round((100 * starvedEmpty) / frames),
    starvedHeldPct: Math.round((100 * starvedHeld) / frames),
    maxGapMs: Math.round(maxGap),
    burstPer100ms: burst,
    lagMeanMs: Math.round(mean),
    lagP95Ms: Math.round(lags[Math.floor(lags.length * 0.95)]),
    lagMaxMs: Math.round(lags.at(-1)),
  };
}

/** A steady stream: `cps` chars/s delivered in chunks every `gapMs`. */
const steady = (cps, gapMs, seconds) => {
  const chunks = [];
  for (let t = 0; t < seconds * 1000; t += gapMs) chunks.push({ at: t, size: Math.max(1, Math.round((cps * gapMs) / 1000)) });
  return chunks;
};

/** Bursty: two chunks back-to-back, then a long pause — worst felt case. */
const bursty = (cps, seconds) => {
  const chunks = [];
  for (let t = 0; t < seconds * 1000; t += 1500) {
    chunks.push({ at: t, size: Math.round(cps * 1.2) });
    chunks.push({ at: t + 120, size: Math.round(cps * 0.3) });
  }
  return chunks;
};

const scenarios = {
  "steady 5cps, 800ms chunks": { chunks: steady(5, 800, 20), cps: 5 },
  "steady 10cps, 600ms chunks": { chunks: steady(10, 600, 20), cps: 10 },
  "steady 20cps, 400ms chunks": { chunks: steady(20, 400, 20), cps: 20 },
  "bursty 10cps, 1.5s cycle": { chunks: bursty(10, 20), cps: 10 },
  "fast 80cps, 250ms chunks": { chunks: steady(80, 250, 10), cps: 80 },
};

console.log(`${"scenario".padEnd(30)} starvedEmpty maxGap (ideal)  burst/100ms (×rate)  lag mean/p95/max ms`);
for (const [name, { chunks, cps }] of Object.entries(scenarios)) {
  const m = simulate(chunks);
  const burstRatio = (m.burstPer100ms / (cps / 10)).toFixed(1);
  const ideal = Math.round(1000 / cps);
  console.log(
    `${name.padEnd(30)} ${String(m.starvedEmptyPct + "%").padEnd(12)} ${`${m.maxGapMs} (${ideal})`.padEnd(15)} ${String(m.burstPer100ms).padEnd(4)} (${burstRatio}×)`.padEnd(78) +
      ` ${m.lagMeanMs}/${m.lagP95Ms}/${m.lagMaxMs}`,
  );
}
