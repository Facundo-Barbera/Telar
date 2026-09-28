// @ts-expect-error bun:test is the test runner
import { describe, expect, test } from "bun:test";
import { REVEAL, revealState, revealText, stepReveal, type RevealState } from "./streaming-reveal";

/**
 * A fake clock over RENDERED characters. `state.shown` is fractional and always
 * "moves"; what a reader experiences is `revealText`, so that is what counts.
 */
type Frame = { at: number; target: number; seen: number };

function run(arrivals: { at: number; grew: number }[], until: number, step = 16.7): { frames: Frame[]; state: RevealState } {
  let state = revealState(0, 0);
  let target = 0;
  const frames: Frame[] = [];
  for (let now = step; now <= until; now += step) {
    for (const arrival of arrivals) if (arrival.at > now - step && arrival.at <= now) target += arrival.grew;
    state = stepReveal(state, target, now);
    frames.push({ at: now, target, seen: revealText("x".repeat(target), state.shown).length });
  }
  return { frames, state };
}

/** The oldest character still unshown at each frame, in ms of age. */
function worstAge(arrivals: { at: number; grew: number }[], frames: Frame[]): number {
  let worst = 0;
  for (const frame of frames) {
    let end = 0;
    for (const arrival of arrivals) {
      if (arrival.at > frame.at) break;
      end += arrival.grew;
      if (end > frame.seen) {
        worst = Math.max(worst, frame.at - arrival.at);
        break;
      }
    }
  }
  return worst;
}

describe("adaptive reveal pacing", () => {
  test("5 characters every 250ms is spread across a window, not drained in a frame", () => {
    // THE REPORTED STUTTER, MEASURED. The old pacing rendered [5,5,5,…]: the
    // whole burst on frame one, then a flat quarter second.
    const arrivals = Array.from({ length: 8 }, (_, index) => ({ at: index * 250 + 1, grew: 5 }));
    const { frames } = run(arrivals, 2600);
    const first = frames.slice(0, 15);
    expect(first[2]!.seen).toBeLessThan(5);
    expect(first[9]!.seen).toBeLessThan(5);
    // The opening chunk is fully out by its own bound.
    expect(frames.find((frame) => frame.at >= 1 + REVEAL.maxLagMs)!.seen).toBeGreaterThanOrEqual(5);
  });

  test("the sustained pace TRACKS a slow stream instead of bursting past it", () => {
    // THE PACKAGED-BUILD COMPLAINT: "way too fast for the input rate". At a
    // steady 10 chars/s, once the estimate has warmed up, no 100ms window may
    // reveal more than drainSlack.max × the source rate — catch-up is capped,
    // never a flash of a whole chunk.
    const arrivals = Array.from({ length: 20 }, (_, index) => ({ at: index * 600 + 1, grew: 6 }));
    const { frames } = run(arrivals, 12_600);
    const warm = frames.filter((frame) => frame.at > 3000);
    for (let i = 0; i < warm.length; i += 1) {
      const windowEnd = warm[i]!.at + 100;
      const within = warm.filter((frame) => frame.at >= warm[i]!.at && frame.at <= windowEnd);
      const revealed = within.at(-1)!.seen - warm[i]!.seen;
      expect(revealed).toBeLessThanOrEqual(Math.ceil((10 * REVEAL.drainSlack.max * 100) / 1000) + 1);
    }
  });

  test("the reserve keeps text moving through a chunk gap", () => {
    // Between arrivals the old pacer had already drained everything and the
    // screen sat dead. Now a warmed-up pacer holds a reserve and spends it:
    // inside a 600ms gap there is still visible movement.
    const arrivals = Array.from({ length: 20 }, (_, index) => ({ at: index * 600 + 1, grew: 6 }));
    const { frames } = run(arrivals, 12_000);
    const gapStart = 6001 + 50; // just after the 11th chunk landed
    const gapEnd = 6601 - 50; // just before the 12th
    const inGap = frames.filter((frame) => frame.at >= gapStart && frame.at <= gapEnd);
    expect(inGap.at(-1)!.seen).toBeGreaterThan(inGap[0]!.seen);
  });

  test("continuous arrival for seconds: no character waits longer than maxLag", () => {
    // THE CONTRACT. A later chunk must never postpone an earlier one, which is
    // what one shared window reset per arrival would allow.
    const arrivals = Array.from({ length: 60 }, (_, index) => ({ at: index * 100 + 1, grew: 12 }));
    const { frames } = run(arrivals, 6000 + REVEAL.maxLagMs + 100);
    expect(worstAge(arrivals, frames)).toBeLessThanOrEqual(REVEAL.maxLagMs + 17);
    expect(frames.at(-1)!.seen).toBe(720);
  });

  test("a large burst followed by a trickle: neither starves the other", () => {
    const arrivals = [{ at: 1, grew: 800 }, ...Array.from({ length: 20 }, (_, index) => ({ at: 300 + index * 120, grew: 3 }))];
    const { frames } = run(arrivals, 2580 + REVEAL.maxLagMs + 100);
    expect(frames[0]!.seen).toBeLessThan(800);
    expect(worstAge(arrivals, frames)).toBeLessThanOrEqual(REVEAL.maxLagMs + 17);
    expect(frames.at(-1)!.seen).toBe(860);
  });

  test("a chunk keeps its own deadline while newer text keeps arriving", () => {
    // 5 characters, then a steady stream. The first five must still be shown
    // within their own window rather than pushed along by the newcomers.
    const arrivals = [{ at: 1, grew: 5 }, ...Array.from({ length: 30 }, (_, index) => ({ at: 20 + index * 20, grew: 4 }))];
    const { frames } = run(arrivals, 1 + REVEAL.maxLagMs + 400);
    const byDeadline = frames.find((frame) => frame.at >= 1 + REVEAL.maxLagMs)!;
    expect(byDeadline.seen).toBeGreaterThanOrEqual(5);
  });

  test("idle time is not charged to a chunk that had not arrived yet", () => {
    // Caught up, a second of silence, then five characters. That second
    // belonged to nothing outstanding; spending it on the new chunk shows the
    // whole thing instantly — which is what the hook does on idle→arrival.
    const state = stepReveal(revealState(5, 0), 10, 1000);
    expect(state.shown).toBeLessThan(10);
  });

  test("an overdue chunk flushes itself, not the fresh text behind it", () => {
    // Five characters past their deadline, and 800 that arrived this instant.
    // Flushing to the whole target drags the new 800 out with the old 5.
    const late = REVEAL.maxLagMs + 10;
    const state = stepReveal({ shown: 0, target: 5, pending: [{ end: 5, at: 0 }], last: late - 60 }, 805, late);
    expect(state.shown).toBeGreaterThanOrEqual(5);
    expect(state.shown).toBeLessThan(805);
  });

  test("the first chunk is not paced from one frame's delta", () => {
    // Measuring 5 characters against 16ms reports 300/s and drains instantly.
    const { frames } = run([{ at: 1, grew: 5 }], 60);
    expect(frames[0]!.seen).toBeLessThan(5);
  });

  test("pacing follows the clock, not the frame count", () => {
    /**
     * A mid-window sample differs slightly between refresh rates because the
     * same continuous curve is being stepped at different resolutions. Drift
     * would be systematic and would GROW as the step shrinks; discretization
     * shrinks. Both must also finish together, which is the part a reader sees.
     */
    const at = (step: number, until: number) => run([{ at: 1, grew: 100 }], until, step).frames.at(-1)!.seen;
    const coarse = Math.abs(at(16.7, 200) - at(8.3, 200));
    const fine = Math.abs(at(8.3, 200) - at(4.15, 200));
    expect(fine).toBeLessThanOrEqual(coarse);
    const done = 1 + REVEAL.maxLagMs + 20;
    expect(at(16.7, done)).toBe(100);
    expect(at(8.3, done)).toBe(100);
    expect(at(4.15, done)).toBe(100);
  });

  test("a backgrounded tab returns showing everything, not animating it", () => {
    let state = stepReveal(revealState(0, 0), 5000, 16);
    state = stepReveal(state, 5000, 30_000);
    expect(state.shown).toBe(5000);
  });

  test("a shorter replacement restarts rather than rewinds", () => {
    const state = stepReveal({ shown: 400, target: 400, pending: [{ end: 400, at: 0 }], last: 0 }, 12, 16);
    expect(state.shown).toBe(12);
    expect(state.target).toBe(12);
    expect(state.pending).toEqual([]);
  });

  test("only prefixes are ever rendered, and the last one is everything", () => {
    const source = "The quick brown fox jumps over the lazy dog.";
    let state = revealState(0, 0);
    for (let now = 16.7; now < 16.7 + REVEAL.maxLagMs + 40; now += 16.7) {
      state = stepReveal(state, source.length, now);
      expect(source.startsWith(revealText(source, state.shown))).toBe(true);
    }
    expect(revealText(source, state.shown)).toBe(source);
  });

  test("an emoji is never cut in half, at any position", () => {
    const source = "hi 👋🏽 there";
    for (let shown = 0; shown <= source.length; shown += 1) {
      const text = revealText(source, shown);
      expect(/[\uD800-\uDBFF]$/.test(text)).toBe(false);
      expect(source.startsWith(text)).toBe(true);
    }
  });
});
