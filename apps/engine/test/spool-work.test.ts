/**
 * The work registry — the body agent work in the Spool did not have.
 *
 * WHAT THIS SUITE IS ACTUALLY PROTECTING is a guarantee that used to live in a
 * React component: "two clicks are one pass". It was a `busy` boolean, so a
 * reload defeated it, and the expert route's own header admitted as much. The
 * dedupe test below is that guarantee restated somewhere a reload cannot reach.
 *
 * No provider, no daemon, no disk. The registry is deliberately a plain object
 * so its whole contract is readable for free.
 */
import { describe, expect, test } from "bun:test";
import { classifySettle, createWorkRegistry } from "../src/spool/work";
import { stepLabel } from "../src/agent";

const opened = (over: Partial<Parameters<ReturnType<typeof createWorkRegistry>["begin"]>[0]> = {}) => ({
  kind: "expert" as const,
  itemId: "i-1",
  itemTitle: "presupuestos sept no cuadran",
  project: "ozom-gv",
  origin: "you" as const,
  started: "Sat 01:11",
  ...over,
});

describe("the work registry", () => {
  test("opens an entry that reports itself as running", () => {
    const work = createWorkRegistry();
    const { handle, already } = work.begin(opened());

    expect(already).toBeNull();
    const [entry] = work.list();
    expect(entry).toMatchObject({
      id: handle.id,
      kind: "expert",
      itemId: "i-1",
      itemTitle: "presupuestos sept no cuadran",
      project: "ozom-gv",
      origin: "you",
      started: "Sat 01:11",
      state: "running",
    });
  });

  /**
   * THE GUARANTEE THE BUSY BOOLEAN COULD NOT MAKE. A second begin for an item
   * already being read hands back the FIRST entry rather than opening a rival,
   * so the caller can say "this is already happening" instead of paying a
   * second time to find out.
   */
  test("a second pass on the same item returns the running one and opens nothing", () => {
    const work = createWorkRegistry();
    const first = work.begin(opened());
    const second = work.begin(opened());

    expect(second.already).not.toBeNull();
    expect(second.already?.id).toBe(first.handle.id);
    expect(second.handle.id).toBe(first.handle.id);
    expect(work.list()).toHaveLength(1);
  });

  test("a different item opens its own entry", () => {
    const work = createWorkRegistry();
    work.begin(opened());
    work.begin(opened({ itemId: "i-2", itemTitle: "paridad supermetrics vs apis" }));
    expect(work.list()).toHaveLength(2);
  });

  /** Once settled, the item is free again — a pass that finished must not lock
   *  its item out of ever being read a second time. */
  test("a settled item can be started again", () => {
    const work = createWorkRegistry();
    const first = work.begin(opened());
    first.handle.settle({ state: "done", note: "The ozom-gv expert rewrote the brief." });

    const second = work.begin(opened());
    expect(second.already).toBeNull();
    expect(second.handle.id).not.toBe(first.handle.id);
    expect(work.list()).toHaveLength(2);
  });

  test("steps land on the running entry", () => {
    const work = createWorkRegistry();
    const { handle } = work.begin(opened());

    handle.step({ n: 1, label: "Thinking" });
    handle.step({ n: 2, label: "Read reconciliation.ts" });

    expect(work.list()[0]?.step).toEqual({ n: 2, label: "Read reconciliation.ts" });
  });

  /**
   * A finished pass must not keep a step beside it. "Read reconciliation.ts"
   * under a completed result describes a moment that is over, and reads as
   * though the pass were still there.
   */
  test("settling drops the step and records the outcome", () => {
    const work = createWorkRegistry();
    const { handle } = work.begin(opened());
    handle.step({ n: 3, label: "Grep por_conciliar" });

    handle.settle({
      state: "done",
      note: "First pass — the ozom-gv expert had no memory of this project.",
      usage: { tokens: { input: 56, output: 19006, cacheRead: 514653, cacheCreate: 74738 }, costUsd: 0.73 },
    });

    const [entry] = work.list();
    expect(entry?.state).toBe("done");
    expect(entry?.step).toBeUndefined();
    expect(entry?.usage?.costUsd).toBe(0.73);
  });

  /** The idempotence a `finally` depends on: a generic settle after a real one
   *  is a no-op, never an overwrite of the outcome that mattered. */
  test("the first settle wins", () => {
    const work = createWorkRegistry();
    const { handle } = work.begin(opened());

    handle.settle({ state: "refused", note: "This item is floating." });
    handle.settle({ state: "failed", note: "something generic" });

    expect(work.list()[0]).toMatchObject({ state: "refused", note: "This item is floating." });
  });

  test("a step after settling is ignored rather than resurrecting the entry", () => {
    const work = createWorkRegistry();
    const { handle } = work.begin(opened());
    handle.settle({ state: "done", note: "done" });
    handle.step({ n: 9, label: "Read late.ts" });

    expect(work.list()[0]).toMatchObject({ state: "done", step: undefined });
  });

  test("runningFor finds only the live entry for an item", () => {
    const work = createWorkRegistry();
    const { handle } = work.begin(opened());
    expect(work.runningFor("i-1")?.id).toBe(handle.id);
    expect(work.runningFor("i-2")).toBeUndefined();

    handle.settle({ state: "done", note: "done" });
    expect(work.runningFor("i-1")).toBeUndefined();
  });

  /** Handing out the live record would let a caller edit the registry through
   *  the back door — a "done" entry running again in someone else's surface. */
  test("list hands out copies", () => {
    const work = createWorkRegistry();
    work.begin(opened());
    const [entry] = work.list();
    if (entry) entry.state = "failed";
    expect(work.list()[0]?.state).toBe("running");
  });

  describe("cancellation", () => {
    test("aborts the controller and leaves the entry running for the pass to settle", () => {
      const work = createWorkRegistry();
      const abort = new AbortController();
      const { handle } = work.begin({ ...opened(), abort });

      expect(work.cancel(handle.id)).toBe(true);
      expect(abort.signal.aborted).toBe(true);
      /**
       * DELIBERATELY STILL RUNNING. Settling here would race the pass's own
       * unwind and could report a cancellation for a call that had already
       * emitted its result.
       */
      expect(work.list()[0]?.state).toBe("running");
    });

    test("an unknown or settled id is answered false rather than thrown", () => {
      const work = createWorkRegistry();
      const { handle } = work.begin({ ...opened(), abort: new AbortController() });
      handle.settle({ state: "done", note: "done" });

      expect(work.cancel(handle.id)).toBe(false);
      expect(work.cancel("work-nope")).toBe(false);
    });

    test("a pass nobody gave a controller cannot be cancelled, and says so", () => {
      const work = createWorkRegistry();
      const { handle } = work.begin(opened());
      expect(work.cancel(handle.id)).toBe(false);
    });
  });

  /**
   * THE CAP IS ON SETTLED ENTRIES ONLY. A running one evicted to make room is
   * exactly the invisibility this whole file exists to end — so the tail is
   * trimmed and the live work never is, at any count.
   */
  describe("the settled tail", () => {
    test("keeps the most recent settled entries and drops the oldest", () => {
      const work = createWorkRegistry();
      for (let n = 0; n < 25; n += 1) {
        const { handle } = work.begin(opened({ itemId: `i-${n}`, itemTitle: `item ${n}` }));
        handle.settle({ state: "done", note: `note ${n}` });
      }

      const list = work.list();
      expect(list).toHaveLength(20);
      expect(list.at(0)?.itemId).toBe("i-5");
      expect(list.at(-1)?.itemId).toBe("i-24");
    });

    test("never evicts running work, however much has settled", () => {
      const work = createWorkRegistry();
      const live = work.begin(opened({ itemId: "i-live", itemTitle: "the live one" }));
      for (let n = 0; n < 40; n += 1) {
        const { handle } = work.begin(opened({ itemId: `i-${n}`, itemTitle: `item ${n}` }));
        handle.settle({ state: "done", note: `note ${n}` });
      }

      expect(work.find(live.handle.id)?.state).toBe("running");
      expect(work.list().filter((entry) => entry.state === "running")).toHaveLength(1);
    });
  });
});

/**
 * The progress vocabulary, read without a provider.
 *
 * THE GRAMMAR IS THE COCKPIT'S ON PURPOSE — a transcript there reads
 * "Thought · ToolSearch · spool_list_items", so a Spool pass reading files says
 * "Read" and "Grep" in the same voice rather than inventing a second dialect
 * for the same act.
 */
describe("stepLabel", () => {
  const assistant = (content: unknown[]) => ({ type: "assistant", message: { content } });

  test("names the tool, with a short target when there is one", () => {
    expect(stepLabel(assistant([{ type: "tool_use", name: "Read", input: { file_path: "/a/b/reconciliation.ts" } }]))).toBe(
      "Read reconciliation.ts",
    );
    expect(stepLabel(assistant([{ type: "tool_use", name: "Grep", input: { pattern: "por_conciliar" } }]))).toBe(
      "Grep por_conciliar",
    );
  });

  /** The leading directories are the part every sibling call shares, so they
   *  are the part that carries no information. */
  test("reads a path at its tail", () => {
    expect(
      stepLabel(assistant([{ type: "tool_use", name: "Read", input: { path: "packages/module-pd/src/core/reconciliation.ts" } }])),
    ).toBe("Read reconciliation.ts");
  });

  test("drops a target too long to sit in a one-line window", () => {
    expect(stepLabel(assistant([{ type: "tool_use", name: "Grep", input: { pattern: "x".repeat(80) } }]))).toBe("Grep");
  });

  test("names the forced final act for what it means, not for its plumbing", () => {
    expect(stepLabel(assistant([{ type: "tool_use", name: "mcp__out__emit_result", input: {} }]))).toBe(
      "Writing the result",
    );
  });

  test("strips the mcp server prefix from any other tool", () => {
    expect(stepLabel(assistant([{ type: "tool_use", name: "mcp__spool__spool_list_items", input: {} }]))).toBe(
      "spool_list_items",
    );
  });

  /** THAT it reasoned, never what it said: a half-written sentence flickering
   *  in a one-line window reads as a glitch. */
  test("reports prose as thinking without quoting it", () => {
    expect(stepLabel(assistant([{ type: "text", text: "Let me look at the reconciliation flow" }]))).toBe("Thinking");
  });

  test("says nothing about messages that are not the assistant's turn", () => {
    expect(stepLabel({ type: "result", usage: {} })).toBeUndefined();
    expect(stepLabel({ type: "user", message: { content: [{ type: "tool_result" }] } })).toBeUndefined();
    expect(stepLabel(assistant([]))).toBeUndefined();
  });
});

/**
 * `refused` vs `failed` — the honest half of the morning report.
 *
 * FOUND BY DRIVING IT, not by the gate. Stopping a pass from the UI came back
 * `failed`, which put a red triangle on the report for a thing the user chose —
 * and would have tripped the night's consecutive-failure halt after three
 * deliberate stops, reporting "3 items failed in a row" about a night nobody
 * had any trouble with.
 */
describe("classifySettle", () => {
  test("a cancellation is your own decision, not a fault", () => {
    expect(classifySettle("expert:telar-vnext: the call was cancelled; nothing was written.")).toBe("refused");
  });

  test("a floating item is refused, because only a human can unblock it", () => {
    expect(classifySettle('"Call María" is floating — it belongs to no project.')).toBe("refused");
    expect(classifySettle('"My Project" is not a project name this store can address on disk')).toBe("refused");
  });

  test("everything else is a failure, and says so", () => {
    expect(classifySettle("expert:aurora: the model finished without emitting a result")).toBe("failed");
    expect(classifySettle("expert:aurora: the Claude Agent SDK is not available")).toBe("failed");
    expect(classifySettle("expert:aurora: the model emitted a result that does not fit the expected shape")).toBe(
      "failed",
    );
  });
});
