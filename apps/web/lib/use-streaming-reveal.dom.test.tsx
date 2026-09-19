/**
 * THE EFFECT-DRIVEN HALF of `useStreamingReveal`, which nothing in CI ran.
 *
 * `use-streaming-reveal.test.ts` covers first paint through `renderToString`
 * and says so in its own header: no effect ever runs there, no frame is ever
 * scheduled, and it names the rest as a gap. The only thing that exercised the
 * gap was `test-fixtures/streaming-reveal/fixture.tsx`, a page a person has to
 * open and click — so every requirement in #214 that lives in an effect
 * (reduced motion, Stop, the frame loop, a remount mid-reply) was pinned by
 * nothing a merge could fail on. This file is that fixture's scenarios, in a
 * DOM, on a clock it owns.
 *
 * WHAT IS ASSERTED IS WHAT WAS COMMITTED, not what a render returned. A render
 * that React discards is never painted, and the hook adjusts its state during
 * render on purpose — so the probe logs from an effect, which runs once per
 * commit. A value in `log` is a value the reader's screen actually held.
 *
 * NOT StrictMode: its double-invoked effects would schedule two frames per
 * commit and the pacing here is measured in frames.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { REVEAL } from "./streaming-reveal";
import { useStreamingReveal } from "./use-streaming-reveal";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// ── the clock this file owns ──────────────────────────────────────────────
/** A chunk's hard latency bound, with a frame of slack for the assertions. */
const BOUND = REVEAL.maxLagMs + 100;
const FRAME = 16.7;

let clock = 0;
let reduced = false;
const mediaListeners = new Set<() => void>();
let nextFrameId = 1;
const frames = new Map<number, (now: number) => void>();

performance.now = () => clock;
window.requestAnimationFrame = ((callback: (now: number) => void) => {
  const id = nextFrameId++;
  frames.set(id, callback);
  return id;
}) as typeof window.requestAnimationFrame;
// REAL CANCELLATION, or a cleanup leaves a callback the browser would have
// dropped and the pacer double-steps.
window.cancelAnimationFrame = ((id: number) => {
  frames.delete(id);
}) as typeof window.cancelAnimationFrame;
window.matchMedia = ((query: string) =>
  ({
    matches: query.includes("reduce") ? reduced : false,
    media: query,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList) as typeof window.matchMedia;

/** Advance the clock in frames, running each one that was scheduled. */
async function tick(ms: number) {
  for (let step = 0; step < ms; step += FRAME) {
    clock += FRAME;
    // Drained before running, so a callback that schedules another does not
    // run twice in one frame.
    const due = [...frames.values()];
    frames.clear();
    await act(async () => {
      for (const frame of due) frame(clock);
    });
  }
}

/** Advance the clock WITHOUT running callbacks — the browser did not paint.
 *  This is what leaves a chunk genuinely overdue. */
function skip(ms: number) {
  clock += ms;
}

async function setReduced(next: boolean) {
  reduced = next;
  await act(async () => {
    for (const listener of [...mediaListeners]) listener();
  });
}

// ── the probe ─────────────────────────────────────────────────────────────
function Probe({ text, live, log }: { text: string; live: boolean; log: string[] }) {
  const shown = useStreamingReveal(text, live);
  // No dependency array: once per commit, after the hook's own effect. This is
  // the paint, which is the thing #214 is about.
  useEffect(() => {
    log.push(shown);
  });
  return shown;
}

const WORD = "the quick brown fox jumps over the lazy dog ";
const long = (n: number) => WORD.repeat(Math.ceil(n / WORD.length) + 1).slice(0, n);

let roots: Root[] = [];

function mount() {
  const log: string[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  let generation = 0;
  const draw = (text: string, live: boolean) => root.render(<Probe key={generation} text={text} live={live} log={log} />);
  let current = { text: "", live: true };
  act(() => draw("", true));
  return {
    log,
    /** What the reader is looking at right now. */
    shown: () => host.textContent ?? "",
    set: async (text: string, live = true) => {
      current = { text, live };
      await act(async () => draw(text, live));
    },
    /** A surface switch: the same text, a brand-new component. */
    remount: async () => {
      generation += 1;
      await act(async () => draw(current.text, current.live));
    },
  };
}

beforeEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  frames.clear();
  mediaListeners.clear();
  reduced = false;
  // Well past any deadline the previous test left behind.
  clock += 5000;
});

describe("pacing, while it is live", () => {
  test("a chunk is not dumped on arrival, and lands by its own bound", async () => {
    const probe = mount();
    await probe.set(long(400));
    // OBSERVED IMMEDIATELY. Waiting first would let a broken immediate flush
    // pass, because the deadline would have arrived anyway.
    expect(probe.shown().length).toBeLessThan(400);
    await tick(BOUND);
    expect(probe.shown()).toBe(long(400));
  });

  test("only prefixes of the source are ever committed", async () => {
    const probe = mount();
    const text = long(300);
    await probe.set(text);
    await tick(600);
    await probe.set(text + long(200));
    await tick(BOUND);
    for (const painted of probe.log) expect((text + long(200)).startsWith(painted)).toBe(true);
    expect(probe.shown()).toBe(text + long(200));
  });

  test("an overdue chunk flushes itself, not the fresh text behind it", async () => {
    const probe = mount();
    await probe.set(long(5));
    await tick(FRAME);
    expect(probe.shown().length).toBeLessThan(5);
    // NO FRAMES: the clock jumps past the 5's bound while nothing painted, so
    // those characters are genuinely overdue rather than already finished.
    skip(REVEAL.maxLagMs + 150);
    await probe.set(long(805));
    await tick(FRAME);
    expect(probe.shown().length).toBeGreaterThanOrEqual(5);
    expect(probe.shown().length).toBeLessThan(805);
    await tick(BOUND);
    expect(probe.shown()).toBe(long(805));
  });
});

describe("the exits", () => {
  test("completion hands over the whole answer with no frame", async () => {
    const probe = mount();
    await probe.set(long(400));
    await tick(60);
    expect(probe.shown().length).toBeLessThan(400);
    frames.clear();
    await probe.set(long(400), false);
    // No tick: `streaming` going false IS the flush.
    expect(probe.shown()).toBe(long(400));
  });

  test("Stop keeps the text that had arrived, whole", async () => {
    // Stop is completion with a shorter answer: the turn ends at whatever the
    // provider had sent, and that text must be complete on screen at once.
    const probe = mount();
    await probe.set(long(600));
    await tick(60);
    const stopped = long(220);
    frames.clear();
    await probe.set(stopped, false);
    expect(probe.shown()).toBe(stopped);
  });

  test("a replacement of the SAME length leaves no stale prefix", async () => {
    const probe = mount();
    await probe.set("the cat sat on the mat");
    await tick(120);
    await probe.set("the cat ate on the mat");
    for (const painted of probe.log) expect("the cat ate on the mat".startsWith(painted) || "the cat sat on the mat".startsWith(painted)).toBe(true);
    await tick(BOUND);
    expect(probe.shown()).toBe("the cat ate on the mat");
  });
});

describe("navigation continuity", () => {
  test("a remount mid-reply resumes at the full length, replaying nothing", async () => {
    const probe = mount();
    await probe.set(long(600));
    await tick(60);
    expect(probe.shown().length).toBeLessThan(600);
    await probe.remount();
    expect(probe.shown()).toBe(long(600));
  });

  test("and keeps pacing the text that arrives after it", async () => {
    const probe = mount();
    await probe.set(long(600));
    await tick(60);
    await probe.remount();
    await probe.set(long(900));
    expect(probe.shown().length).toBeLessThan(900);
    await tick(BOUND);
    expect(probe.shown()).toBe(long(900));
  });
});

describe("prefers-reduced-motion", () => {
  test("turning reduce on mid-reply flushes, with no new text", async () => {
    const probe = mount();
    await probe.set(long(600));
    await tick(60);
    expect(probe.shown().length).toBeLessThan(600);
    await setReduced(true);
    expect(probe.shown()).toBe(long(600));
  });

  test("turning reduce back off mid-reply does not rewind", async () => {
    // The pace left behind by a flush is at the full length, so resuming
    // cannot un-show text the reader has already read.
    const probe = mount();
    await probe.set(long(600));
    await tick(60);
    await setReduced(true);
    await setReduced(false);
    expect(probe.shown()).toBe(long(600));
    await probe.set(long(700));
    await tick(BOUND);
    expect(probe.shown()).toBe(long(700));
  });
});
