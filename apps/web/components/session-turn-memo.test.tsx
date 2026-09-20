/**
 * #498 — A TURN THAT DID NOT CHANGE DOES NOT RE-RENDER.
 *
 * THE CASE THIS IS ABOUT. The cockpit tails once a second, and every
 * queue-changing event brings a companion snapshot whose rows are fresh objects
 * off `JSON.parse`. The projector rebuilds each turn from those, so the ten
 * mounted turns were handed new-but-identical `JournalTurn` objects — plus a
 * fresh `requests` array and fresh inline callbacks — and React re-rendered all
 * ten. One turn had changed; the whole conversation paid.
 *
 * HOW A RENDER IS COUNTED. `SessionTurn` is memoised on what it DRAWS, and
 * `prompt` is deliberately outside that comparison: a turn's input is written
 * once and never rewritten, and the `runId` key means the comparator only ever
 * sees one turn against a later reading of itself. That makes `prompt` the one
 * prop the body reads and the comparator does not — so a getter on it counts
 * renders of the body exactly, with nothing stubbed and no component replaced.
 *
 * The probe goes on the INCOMING turn, never the mounted one: a bail-out leaves
 * the old object rendering, so a getter on it could not tell the two apart.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Item, Turn } from "@telar/engine-client";
import { projectJournal, type JournalTurn } from "@/lib/engine/journal";
import { SessionTurn } from "./session-cockpit";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const STARTED = 1_700_000_000_000;
const row: Turn = {
  runId: "run_1",
  sessionId: "s1",
  sequence: 1,
  input: "Please look at the failing test",
  state: "completed",
  acceptedAt: STARTED,
  updatedAt: STARTED,
  resultText: "Fixed it.",
};

const said = (text: string, status: Item["status"] = "completed"): Item => ({
  runId: "run_1",
  sessionId: "s1",
  id: "item_1",
  status,
  startedAt: STARTED,
  ...(status === "completed" ? { completedAt: STARTED } : {}),
  detail: { type: "assistant_message", text },
});

/**
 * A turn folded from FRESH rows, the way a companion snapshot produces one:
 * every object new, every value the same unless this call changed it.
 */
function fold(items: Item[] = [said("Looking now.")], state: Turn["state"] = "completed"): JournalTurn {
  return projectJournal(
    [structuredClone({ ...row, state })],
    structuredClone(items),
    [],
  )[0]!;
}

/** Counts the body's reads of `prompt` — one render is two of them, so the
 *  assertions below only ever ask whether the count MOVED. */
function watched(turn: JournalTurn): { turn: JournalTurn; reads: () => number } {
  let reads = 0;
  const value = turn.prompt;
  Object.defineProperty(turn, "prompt", {
    get() {
      reads += 1;
      return value;
    },
    configurable: true,
    enumerable: true,
  });
  return { turn, reads: () => reads };
}

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

/**
 * The cockpit's call site, with everything it rebuilds on every render: a fresh
 * `requests` array and a fresh arrow per gesture.
 */
const turnElement = (turn: JournalTurn, live = false) => (
  <SessionTurn
    turn={turn}
    live={live}
    requests={[]}
    sending={false}
    onOpenAgent={() => {}}
    onOpenTab={() => {}}
    onInsert={() => {}}
    onOpenFile={() => {}}
    onDecide={() => {}}
    onRetry={() => {}}
  />
);

/** Mount one turn and hand back a re-render that counts what it costs. */
async function mount(turn: JournalTurn) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(turnElement(turn));
  });
  return {
    host,
    /** Hand the mounted turn a later reading of itself. Answers whether the
     *  body rendered again. */
    async offer(next: JournalTurn, live = false): Promise<boolean> {
      const probe = watched(next);
      await act(async () => {
        root.render(turnElement(probe.turn, live));
      });
      return probe.reads() > 0;
    },
  };
}

describe("a settled turn under the cockpit's once-a-second tail", () => {
  test("does not re-render for a snapshot that rebuilt it unchanged", async () => {
    const mounted = await mount(fold());
    expect(await mounted.offer(fold())).toBe(false);
    // …and again, because the snapshot arrives repeatedly on a busy session.
    expect(await mounted.offer(fold())).toBe(false);
    expect(mounted.host.textContent).toContain("Looking now.");
  });

  test("does re-render when the text it draws actually grew", async () => {
    const mounted = await mount(fold());
    expect(await mounted.offer(fold([said("Looking now. Found it.")]))).toBe(true);
    expect(mounted.host.textContent).toContain("Found it.");
  });

  test("does re-render when a row it drew has closed", async () => {
    const mounted = await mount(fold([said("Working", "inProgress")]));
    expect(await mounted.offer(fold([said("Working", "completed")]))).toBe(true);
  });

  test("does re-render when a row was added", async () => {
    const mounted = await mount(fold());
    const grown = fold([said("Looking now."), { ...said("And now this."), id: "item_2" }]);
    expect(await mounted.offer(grown)).toBe(true);
  });

  test("does re-render when the turn's state moved", async () => {
    const mounted = await mount(fold(undefined, "running"));
    expect(await mounted.offer(fold(undefined, "failed"))).toBe(true);
  });

  test("does re-render when it becomes the live turn", async () => {
    const mounted = await mount(fold(undefined, "running"));
    expect(await mounted.offer(fold(undefined, "running"), true)).toBe(true);
  });

  test("an OPEN row is never assumed unchanged — its detail can move under a fixed status", async () => {
    // A browser step advancing to a new URL, a command growing its preview:
    // the status stays `inProgress` and the picture changes. The comparator
    // refuses to reuse such a row rather than compare every detail field.
    const browsing = (url: string): Item => ({
      runId: "run_1",
      sessionId: "s1",
      id: "item_b",
      status: "inProgress",
      startedAt: STARTED,
      detail: { type: "browser_action", call: { name: "navigate", input: { url } }, url },
    });
    const mounted = await mount(fold([browsing("https://example.com/one")]));
    expect(await mounted.offer(fold([browsing("https://example.com/two")]))).toBe(true);
  });
});
