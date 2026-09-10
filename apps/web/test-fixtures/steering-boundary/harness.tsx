/**
 * A browser fixture for the REAL `SessionTurn` with text STILL STREAMING
 * across a steering boundary — the regression reported on packaged Dev
 * c4882d80, where typing mid-sentence swept the half-written reply into a
 * collapsed "N steps" fold above the message and it went on growing in there.
 *
 * The turn is driven on a timer the page owns: prose streams a word at a
 * time, a steer lands mid-sentence, more prose streams, a second steer lands.
 * Nothing is mocked but the journal data — the component, its splitter and
 * its seam rules are the production ones.
 *
 * `BEFORE=1 bun build.mjs` bundles the same page with the fix reverted in
 * memory, so the defect can be seen rather than described.
 */
import { createElement as h, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionTurn } from "../../components/session-cockpit";
import type { JournalItem, JournalTurn } from "../../lib/engine/journal";

const base = { runId: "run_1", sessionId: "session_1", startedAt: 1, streamedText: "", openedBy: 0 } as const;

const prose = (id: string, streamedText: string, done: boolean): JournalItem => ({
  ...base,
  id,
  status: done ? "completed" : "inProgress",
  ...(done ? { completedAt: 2 } : {}),
  streamedText,
  detail: { type: "assistant_message", text: done ? streamedText : "" },
});

const steer = (id: string, text: string): JournalItem => ({
  ...base,
  id,
  status: "completed",
  completedAt: 2,
  detail: { type: "user_message", text },
});

const command = (id: string, cmd: string): JournalItem => ({
  ...base,
  id,
  status: "completed",
  completedAt: 2,
  detail: { type: "command_execution", command: { command: cmd }, output: "" } as JournalItem["detail"],
});

const FIRST = "Right — the pacer now tracks the estimated arrival rate and holds a small reserve, so".split(" ");
const SECOND = "Understood, dropping that. The reserve floor is two characters because".split(" ");
const THIRD = "Switching to the bound instead: every chunk is fully shown within its own".split(" ");

/** The script, as a list of steps the timer walks. */
type Step = { at: number; kind: "word"; lane: 0 | 1 | 2 } | { at: number; kind: "steer"; id: string; text: string };
const SCRIPT: Step[] = [];
let clock = 0;
for (let i = 0; i < FIRST.length; i += 1) SCRIPT.push({ at: (clock += 1), kind: "word", lane: 0 });
SCRIPT.push({ at: (clock += 2), kind: "steer", id: "steer_1", text: "wait — say it in one sentence" });
for (let i = 0; i < SECOND.length; i += 1) SCRIPT.push({ at: (clock += 1), kind: "word", lane: 1 });
SCRIPT.push({ at: (clock += 2), kind: "steer", id: "steer_2", text: "and mention the bound" });
for (let i = 0; i < THIRD.length; i += 1) SCRIPT.push({ at: (clock += 1), kind: "word", lane: 2 });

const WORDS = [FIRST, SECOND, THIRD];

function itemsAt(tick: number): JournalItem[] {
  const counts = [0, 0, 0];
  const steers: JournalItem[] = [];
  let laneReached = 0;
  for (const step of SCRIPT) {
    if (step.at > tick) break;
    if (step.kind === "word") {
      counts[step.lane] += 1;
      laneReached = step.lane;
    } else steers.push(steer(step.id, step.text));
  }
  const items: JournalItem[] = [command("cmd_1", "bun test lib/streaming-reveal.test.ts")];
  for (let lane = 0; lane < 3; lane += 1) {
    if (counts[lane] === 0) continue;
    const text = WORDS[lane]!.slice(0, counts[lane]).join(" ");
    // A lane is finished once a later lane has started.
    items.push(prose(`prose_${lane}`, text, lane < laneReached));
    if (steers[lane]) items.push(steers[lane]!);
  }
  return items;
}

const LAST_TICK = SCRIPT.at(-1)!.at;

function Harness() {
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTick((value) => (value >= LAST_TICK ? value : value + 1)), 140);
    return () => window.clearInterval(timer);
  }, [playing]);

  const items = itemsAt(tick);
  const turn: JournalTurn = {
    runId: "run_1",
    origin: "user",
    prompt: "Explain the new streaming pacing",
    state: tick >= LAST_TICK ? "completed" : "running",
    resultText: "",
    items,
    tasks: [],
  };

  const button = (label: string, act: () => void) =>
    h("button", { key: label, className: "rounded-md border border-border px-2 py-1 text-xs hover:bg-accent", onClick: act }, label);

  return h(
    "div",
    { className: "flex min-h-screen flex-col gap-4 bg-background p-8 text-foreground" },
    h("h1", { className: "text-lg font-semibold" }, "Steering boundary fixture — real SessionTurn, text streaming across a steer"),
    h(
      "div",
      { className: "flex flex-wrap gap-2" },
      button(playing ? "pause" : "play", () => setPlaying((value) => !value)),
      button("restart", () => {
        setTick(0);
        setPlaying(true);
      }),
      button("step +1", () => setTick((value) => Math.min(LAST_TICK, value + 1))),
      button("jump to first steer", () => setTick(SCRIPT.findIndex((step) => step.kind === "steer") + 3)),
      button("end", () => setTick(LAST_TICK)),
    ),
    h("div", { className: "font-mono text-xs text-muted-foreground" }, `tick ${tick}/${LAST_TICK} · state ${turn.state} · ${items.length} items`),
    h(
      "div",
      { className: "rounded-lg border border-border p-4" },
      h(SessionTurn, {
        turn,
        requests: [],
        sending: false,
        live: turn.state === "running",
        now: 3,
        onDecide: () => {},
        onRetry: () => {},
      }),
    ),
  );
}

createRoot(document.getElementById("root")!).render(h(StrictMode, null, h(Harness)));
