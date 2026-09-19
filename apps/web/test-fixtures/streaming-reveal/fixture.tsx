/**
 * A browser fixture for the REAL `useStreamingReveal`, on a controllable clock.
 *
 * Not a test double: it imports the production hook. `performance.now`,
 * `requestAnimationFrame` and `matchMedia` are replaced with deterministic
 * versions BEFORE React mounts, so a frame only happens when this page says so
 * and every run is reproducible.
 *
 * THE MERGE GATE IS `lib/use-streaming-reveal.dom.test.tsx`, which runs these
 * same paths headless. What this page still has that CI cannot is the TRACE:
 * the slow-input scenario prints chars-per-bucket as a sparkline, and reading
 * it is how "way too fast for the input rate" was diagnosed in the first place.
 * Keep the two in step — a scenario added here that a person must click is a
 * scenario nothing enforces.
 */
import { createElement as h, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStreamingReveal } from "../../lib/use-streaming-reveal";
import { REVEAL } from "../../lib/streaming-reveal";

/** A chunk's hard latency bound, with one frame of slack for the checks. */
const BOUND = REVEAL.maxLagMs + 100;

// ── the controllable clock ────────────────────────────────────────────────
let clock = 0;
let reduced = false;
const listeners = new Set<() => void>();

/**
 * REAL IDS AND REAL CANCELLATION. A no-op `cancelAnimationFrame` leaves
 * callbacks that a browser would have dropped — StrictMode's double effect and
 * every cleanup would then double-step the pacer, so the fixture would measure
 * something the app never does.
 */
let nextFrameId = 1;
const frames = new Map<number, (now: number) => void>();

performance.now = () => clock;
window.requestAnimationFrame = ((callback: (now: number) => void) => {
  const id = nextFrameId++;
  frames.set(id, callback);
  return id;
}) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = ((id: number) => {
  frames.delete(id);
}) as typeof window.cancelAnimationFrame;
window.matchMedia = ((query: string) =>
  ({
    matches: query.includes("reduce") ? reduced : false,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList) as typeof window.matchMedia;

/** Advance the clock by `ms` in 16.7ms frames, running each scheduled frame. */
async function tickBy(ms: number) {
  for (let step = 0; step < ms; step += 16.7) {
    clock += 16.7;
    // Drained before running, so a callback that schedules another does not
    // run twice in one frame.
    const due = [...frames.entries()];
    frames.clear();
    for (const [, frame] of due) frame(clock);
    await settle();
  }
}

/** Advance the clock WITHOUT running callbacks — the browser did not paint.
 *  This is what leaves a chunk genuinely overdue. */
function skip(ms: number) {
  clock += ms;
}

function setReduced(next: boolean) {
  reduced = next;
  for (const listener of listeners) listener();
}

// ── the probe ─────────────────────────────────────────────────────────────
/** Scenarios are ASYNC: every step must wait for React to commit, or the clock
 *  advances against state the hook has not seen yet. */
type Check = { label: string; ok: boolean; detail: string };
type Tools = {
  set: (text: string, live?: boolean) => void;
  tick: (ms: number) => Promise<void>;
  skip: (ms: number) => void;
  /** Rendered length right now, straight off the DOM the hook produced. */
  shown: () => number;
  check: (label: string, ok: boolean, detail: string) => void;
};
type Scenario = { name: string; run: (tools: Tools) => Promise<void> };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const WORD = "the quick brown fox jumps over the lazy dog ";
const long = (n: number) => WORD.repeat(Math.ceil(n / WORD.length)).slice(0, n);

const SCENARIOS: Scenario[] = [
  {
    name: "idle then arrival (1000ms quiet, then 5 chars)",
    run: async ({ set, tick, shown, check }) => {
      set(long(5));
      await tick(300);
      // Quiet, WITH frames running: the pacer is caught up and idle.
      await tick(1000);
      check("caught up before the gap", shown() === 5, `shown ${shown()} of 5`);
      set(long(10));
      // OBSERVED IMMEDIATELY. Waiting first would let a broken immediate flush
      // pass, because the deadline would have arrived anyway.
      await settle();
      const atArrival = shown();
      check("new chunk is not dumped on arrival", atArrival < 10, `shown ${atArrival} of 10 right after commit`);
      await tick(BOUND);
      check("and lands by its bound", shown() === 10, `shown ${shown()} of 10`);
    },
  },
  {
    name: "overdue old chunk plus a fresh 800",
    run: async ({ set, tick, skip, shown, check }) => {
      set(long(5));
      await tick(17);
      const old = shown();
      // NO FRAMES: the clock jumps past the 5's bound while the browser
      // never painted, so those characters are genuinely overdue rather than
      // already finished.
      skip(REVEAL.maxLagMs + 150);
      check("old chunk still outstanding", old < 5, `shown ${old} of 5 before the jump`);
      set(long(805));
      await settle();
      await tick(17);
      const after = shown();
      check("overdue chunk flushed", after >= 5, `shown ${after}, expected at least 5`);
      check("fresh 800 NOT dragged out with it", after < 805, `shown ${after} of 805`);
      await tick(BOUND);
      check("fresh text lands by its own bound", shown() === 805, `shown ${shown()} of 805`);
    },
  },
  {
    name: "SLOW INPUT — 5 chars/s in 800ms chunks, paced to the source",
    run: async ({ set, tick, shown, check }) => {
      // THE PACKAGED-BUILD COMPLAINT, replayed: a slow stream must neither
      // flash each chunk out (the "way too fast" burst) nor sit dead between
      // chunks. Fed for 12s; the trace below is chars revealed per 250ms.
      const trace: number[] = [];
      let text = 0;
      let lastShown = 0;
      let deadStreak = 0;
      let worstDeadStreak = 0;
      let worstBurst = 0;
      for (let t = 0; t < 12_000; t += 200) {
        if (t % 800 === 0) {
          text += 4; // 4 chars every 800ms = 5 chars/s
          set(long(text));
          await settle();
        }
        await tick(200);
        const nowShown = shown();
        const delta = nowShown - lastShown;
        trace.push(delta);
        lastShown = nowShown;
        if (t > 3000) {
          if (delta === 0) {
            deadStreak += 1;
            worstDeadStreak = Math.max(worstDeadStreak, deadStreak);
          } else deadStreak = 0;
          worstBurst = Math.max(worstBurst, delta);
        }
      }
      // At 5 chars/s a character lands every 200ms; whole-character rendering
      // makes single still buckets normal. What must be GONE is the old dead
      // air: chunk flashed out, then 550ms of nothing every cycle.
      check(
        "no sustained stillness once the estimate is warm",
        worstDeadStreak <= 2,
        `longest still run after warmup: ${worstDeadStreak * 200}ms (allowed 400ms)`,
      );
      // 5 chars/s → 1 per 200ms; drainSlack.max caps catch-up at 2×.
      check("no bucket outruns the capped rate", worstBurst <= 3, `worst 200ms bucket revealed ${worstBurst} chars (cap 3)`);
      check("nothing outlives its bound", lastShown >= text - 4, `shown ${lastShown} of ${text} at end of feed`);
      const rows = trace.map((count) => "▁▂▃▄▅▆▇█"[Math.min(7, count)]).join("");
      check(`trace (chars per 200ms): ${rows}`, true, "▁=0 …");
    },
  },
  {
    name: "completion / Stop mid-stream",
    run: async ({ set, tick, shown, check }) => {
      set(long(400));
      await tick(60);
      check("still pacing while live", shown() < 400, `shown ${shown()} of 400`);
      set(long(400), false);
      await settle();
      check("everything, immediately, with no frame", shown() === 400, `shown ${shown()} of 400`);
    },
  },
  {
    name: "reduced motion set BEFORE the first chunk",
    run: async ({ set, shown, check }) => {
      // Honouring the preference after the paint is one frame too late: the
      // commit before it holds the paced prefix, which for a first chunk is
      // nothing at all. Checked with no tick, so only what render itself
      // produced can pass.
      setReduced(true);
      set(long(400));
      await settle();
      check("whole chunk on its own commit, unpaced", shown() === 400, `shown ${shown()} of 400`);
      set(long(900));
      await settle();
      check("and the next one too", shown() === 900, `shown ${shown()} of 900`);
    },
  },
  {
    name: "reduced motion toggled with NO new text",
    run: async ({ set, tick, shown, check }) => {
      set(long(600));
      await tick(60);
      check("pacing before the preference changes", shown() < 600, `shown ${shown()} of 600`);
      setReduced(true);
      await settle();
      check("flushed by the listener, no new text needed", shown() === 600, `shown ${shown()} of 600`);
    },
  },
  {
    name: "surface remount mid-reply",
    run: async ({ set, tick, shown, check }) => {
      set(long(600));
      await tick(60);
      const before = shown();
      check("mid-reply before the remount", before < 600, `shown ${before} of 600`);
      remount();
      await settle();
      check("resumes at the full length, replaying nothing", shown() === 600, `shown ${shown()} of 600`);
    },
  },
  {
    name: "replacement of the SAME length",
    run: async ({ set, tick, shown, check }) => {
      set("the cat sat on the mat");
      await tick(120);
      check("part way through the original", shown() < 22, `shown ${shown()} of 22`);
      set("the cat ate on the mat");
      await settle();
      const text = document.getElementById("shown")?.textContent ?? "";
      check("snapped to the revision, no stale prefix", "the cat ate on the mat".startsWith(text), `rendered ${JSON.stringify(text)}`);
    },
  },
];

let remount = () => undefined as void;

function Probe({ text, live }: { text: string; live: boolean }) {
  const shown = useStreamingReveal(text, live);
  return h(
    "div",
    null,
    h("div", { className: "meta" }, `shown ${shown.length} / ${text.length} · clock ${Math.round(clock)}ms · reduced ${String(reduced)}`),
    h("pre", { id: "shown" }, shown),
  );
}

function App() {
  const [text, setText] = useState("");
  const [live, setLive] = useState(true);
  const [key, setKey] = useState(0);
  const [results, setResults] = useState<{ scenario: string; checks: Check[] }[]>([]);
  useEffect(() => {
    remount = () => setKey((value) => value + 1);
  }, []);

  const play = async (list: Scenario[]) => {
    const collected: { scenario: string; checks: Check[] }[] = [];
    setResults([]);
    for (const scenario of list) {
      // A clean slate: unmount, clear the text, jump well past any deadline.
      skip(2000);
      setReduced(false);
      setKey((value) => value + 1);
      setText("");
      setLive(true);
      await settle();
      const checks: Check[] = [];
      await scenario.run({
        set: (next: string, streaming = true) => {
          setText(next);
          setLive(streaming);
        },
        tick: tickBy,
        skip,
        shown: () => (document.getElementById("shown")?.textContent ?? "").length,
        check: (label, ok, detail) => checks.push({ label, ok, detail }),
      });
      collected.push({ scenario: scenario.name, checks });
      setResults([...collected]);
    }
  };

  const failed = results.flatMap((result) => result.checks).filter((entry) => !entry.ok).length;
  const total = results.flatMap((result) => result.checks).length;
  return h(
    "div",
    null,
    h(
      "div",
      { className: "controls" },
      h("button", { id: "run-all", onClick: () => void play(SCENARIOS) }, "▶ run all scenarios"),
      ...SCENARIOS.map((scenario) => h("button", { key: scenario.name, onClick: () => void play([scenario]) }, scenario.name)),
      h("button", { onClick: () => void tickBy(16.7) }, "+1 frame"),
      h("button", { onClick: () => void tickBy(250) }, "+250ms"),
    ),
    total > 0
      ? h("div", { id: "summary", className: failed ? "fail" : "pass" }, failed ? `${failed} of ${total} checks FAILED` : `all ${total} checks PASS`)
      : null,
    ...results.map((result) =>
      h(
        "div",
        { key: result.scenario, className: "result" },
        h("div", { className: "scenario" }, result.scenario),
        ...result.checks.map((entry) =>
          h("div", { key: entry.label, className: entry.ok ? "pass" : "fail" }, `${entry.ok ? "PASS" : "FAIL"} · ${entry.label} · ${entry.detail}`),
        ),
      ),
    ),
    h(Probe, { key, text, live }),
  );
}

createRoot(document.getElementById("root")!).render(h(StrictMode, null, h(App)));
