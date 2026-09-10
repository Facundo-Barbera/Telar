/**
 * A browser fixture for the REAL `useStreamingReveal`, on a controllable clock.
 *
 * Not a test double: it imports the production hook. `performance.now`,
 * `requestAnimationFrame` and `matchMedia` are replaced with deterministic
 * versions BEFORE React mounts, so a frame only happens when this page says so
 * and every run is reproducible.
 */
import { createElement as h, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStreamingReveal } from "../../lib/use-streaming-reveal";

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
      await tick(300);
      check("and lands by its deadline", shown() === 10, `shown ${shown()} of 10`);
    },
  },
  {
    name: "overdue old chunk plus a fresh 800",
    run: async ({ set, tick, skip, shown, check }) => {
      set(long(5));
      await tick(17);
      const old = shown();
      // NO FRAMES: the clock jumps past the 5's deadline while the browser
      // never painted, so those characters are genuinely overdue rather than
      // already finished.
      skip(400);
      check("old chunk still outstanding", old < 5, `shown ${old} of 5 before the jump`);
      set(long(805));
      await settle();
      await tick(17);
      const after = shown();
      check("overdue chunk flushed", after >= 5, `shown ${after}, expected at least 5`);
      check("fresh 800 NOT dragged out with it", after < 805, `shown ${after} of 805`);
      await tick(300);
      check("fresh text lands by its own deadline", shown() === 805, `shown ${shown()} of 805`);
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
      clock += 2000;
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
