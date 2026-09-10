/**
 * Presentation-only pacing for streamed text.
 *
 * Providers deliver prose in bursts. Rendering each arrival immediately shows
 * the burst in one frame and then a flat gap, which reads as stuttering.
 *
 * THE SUSTAINED PACE TRACKS THE ESTIMATED ARRIVAL RATE, holding a small
 * RESERVE of unshown text. The first cut of this pacer was deadline-driven —
 * every chunk fully drained within 250ms of its own arrival — and the user's
 * verdict on the packaged build was "way too fast for the input rate": at 5–10
 * chars/s each chunk flashed out at 3–7× the true rate and then the screen sat
 * dead for most of every gap (measured in
 * test-fixtures/streaming-reveal/measure.mjs, which re-prints those numbers).
 * So the deadline is no longer the pace; it is only the BOUND. Each frame:
 *
 *   sustained = arrival × clamp(backlog / reserve, drainSlack.min, drainSlack.max)
 *
 * At steady state backlog ≈ reserve and text moves at the source's own rate;
 * when a burst lands the multiplier tops out at `drainSlack.max` — catch-up is
 * CAPPED at a small multiple of the felt rate instead of overpowering it — and
 * when a gap starves the backlog the multiplier floors at `drainSlack.min`, a
 * crawl that spends the reserve bridging the silence.
 *
 * EVERY CHUNK STILL CARRIES ITS OWN DEADLINE, now as the latency bound: a
 * chunk that arrived at `t` is fully shown by `t + maxLagMs` whatever the
 * estimate got wrong — one shared window reset by each arrival would let a
 * busy stream postpone old text forever. Draining at the worst-case required
 * rate is linear in time, so even the bound-driven path moves smoothly.
 *
 * ARRIVAL RATE IS ADAPTIVE AND STARTS UNKNOWN. It is sampled over real
 * intervals between arrivals, never from one animation frame — a first chunk
 * measured against one 16ms frame reports hundreds of characters per second
 * and drains instantly. Until a second arrival exists, deadlines alone pace it.
 *
 * INVARIANTS. Only prefixes of `target` are rendered; every exit ends at
 * `target`; no chunk outlives its deadline.
 */

export const REVEAL = {
  /**
   * THE BOUND, NOT THE PACE: a chunk is fully shown within this of ITS OWN
   * arrival, however wrong the rate estimate is. Raised from 250ms when the
   * sustained pace moved to arrival-tracking — at 250ms the deadline WAS the
   * pace, and the pace was the burst the user complained about.
   */
  maxLagMs: 1200,
  /** The reserve the pacer holds to bridge chunk gaps, as time at the
   *  arrival rate — the intentional added latency, well under `maxLagMs`. */
  reserveMs: 450,
  /** The reserve floor in characters. Two, not more: at 5 chars/s every
   *  floor character is 200ms of added latency, and the measured mean lag
   *  with a 4-char floor was 815ms against a 450ms target. */
  reserveFloorChars: 2,
  /** How far the sustained rate may deviate from the arrival estimate to
   *  manage the reserve: the floor keeps a crawl through gaps, the cap is
   *  the most catch-up may exceed the felt rate. */
  drainSlack: { min: 0.25, max: 2 },
  /** Weight of the newest interval sample in the arrival estimate. */
  arrivalWeight: 0.3,
} as const;

export type RevealConfig = typeof REVEAL;

/** Text through `end` characters, which arrived at `at`. */
export type Pending = { end: number; at: number };

export type RevealState = {
  /** FRACTIONAL: a whole-character floor per frame is 60 chars/s at 60Hz,
   *  which outruns a 20 chars/s stream and then stalls. */
  shown: number;
  target: number;
  pending: Pending[];
  /** Timestamp of the previous step. */
  last: number;
  /** Timestamp of the previous arrival, for interval sampling. */
  arrivedAt?: number;
  /** Characters per second. Undefined until two arrivals have been seen. */
  arrival?: number;
};

export function revealState(length: number, now = 0): RevealState {
  return { shown: length, target: length, pending: [], last: now };
}

const carry = (state: RevealState) => ({
  ...(state.arrivedAt === undefined ? {} : { arrivedAt: state.arrivedAt }),
  ...(state.arrival === undefined ? {} : { arrival: state.arrival }),
});

/**
 * Pace what is already outstanding up to `now`. Takes no target: idle time
 * belongs to the text that was waiting through it, never to a chunk that has
 * not arrived yet.
 */
export function advanceReveal(state: RevealState, now: number, config: RevealConfig = REVEAL): RevealState {
  const elapsed = Math.max(0, now - state.last);
  const pending = state.pending.filter((chunk) => chunk.end > state.shown);
  if (pending.length === 0) return { shown: state.target, target: state.target, pending: [], last: now, ...carry(state) };

  // An overdue chunk is shown in full — but only THAT chunk. Flushing to the
  // whole target would drag every fresh character out with it.
  let base = state.shown;
  for (const chunk of pending) if (chunk.at + config.maxLagMs - now <= 0) base = Math.max(base, chunk.end);

  // The worst case across the rest: whichever is closest to its own deadline
  // sets the BOUND rate, so a later arrival cannot postpone an earlier one.
  let required = 0;
  for (const chunk of pending) {
    const left = chunk.at + config.maxLagMs - now;
    if (left > 0 && chunk.end > base) required = Math.max(required, ((chunk.end - base) * 1000) / left);
  }
  // The SUSTAINED rate: the arrival estimate, steered by how the backlog
  // compares to the reserve it should hold — see the header. Zero until two
  // arrivals exist; the deadlines pace the opening on their own.
  let sustained = 0;
  if (state.arrival !== undefined) {
    const backlog = state.target - Math.max(base, state.shown);
    const reserve = Math.max(config.reserveFloorChars, (state.arrival * config.reserveMs) / 1000);
    const pressure = Math.min(config.drainSlack.max, Math.max(config.drainSlack.min, backlog / reserve));
    sustained = state.arrival * pressure;
  }
  const rate = Math.max(required, sustained);
  const shown = Math.min(state.target, Math.max(base, state.shown + (rate * elapsed) / 1000));
  return { shown, target: state.target, pending: pending.filter((chunk) => chunk.end > shown), last: now, ...carry(state) };
}

/** Record text that has just arrived. Separate from pacing so the interval
 *  before it is not charged against it. */
export function ingestReveal(state: RevealState, target: number, now: number, config: RevealConfig = REVEAL): RevealState {
  if (target < state.shown) return revealState(target, now);
  if (target <= state.target) return state;
  // Sampled over the real interval between arrivals, so it reflects the source
  // rather than the frame that noticed it.
  let arrival = state.arrival;
  if (state.arrivedAt !== undefined && now > state.arrivedAt) {
    const sample = ((target - state.target) * 1000) / (now - state.arrivedAt);
    arrival = arrival === undefined ? sample : arrival * (1 - config.arrivalWeight) + sample * config.arrivalWeight;
  }
  return {
    shown: state.shown,
    target,
    pending: [...state.pending, { end: target, at: now }],
    last: state.last,
    arrivedAt: now,
    ...(arrival === undefined ? {} : { arrival }),
  };
}

/** Advance to `now`, then take whatever arrived at `now`. Pure: tests drive
 *  the clock. */
export function stepReveal(state: RevealState, target: number, now: number, config: RevealConfig = REVEAL): RevealState {
  if (target < state.shown) return revealState(target, now);
  return ingestReveal(advanceReveal(state, now, config), target, now, config);
}

/** The prefix to render, cut so it never splits a UTF-16 surrogate pair. */
export function revealText(target: string, shown: number): string {
  let end = Math.floor(Math.max(0, shown));
  if (end >= target.length) return target;
  if (end > 0 && /[\uD800-\uDBFF]/.test(target[end - 1]!)) end += 1;
  return target.slice(0, end);
}
