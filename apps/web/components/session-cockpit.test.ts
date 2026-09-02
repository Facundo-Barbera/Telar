// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { transcriptTasks, turnActivity } from "./transcript";
import { describeTurnState, retryInputForJournalTurn } from "./session-cockpit";

describe("session workspace presentation", () => {
  test("names every durable turn state without relying on colour", () => {
    expect(describeTurnState("queued")).toEqual({ label: "Queued", tone: "active" });
    expect(describeTurnState("claimed")).toEqual({ label: "Claimed", tone: "active" });
    expect(describeTurnState("running")).toEqual({ label: "Streaming", tone: "active" });
    expect(describeTurnState("completed")).toEqual({ label: "Completed", tone: "done" });
    expect(describeTurnState("failed")).toEqual({ label: "Failed", tone: "danger" });
    expect(describeTurnState("stopped")).toEqual({ label: "Stopped", tone: "muted" });
  });

  test("keeps recovery state explicit rather than implying a replay", () => {
    expect(describeTurnState("ambiguous")).toEqual({ label: "Needs recovery decision", tone: "attention" });
    expect(describeTurnState("discarded")).toEqual({ label: "Discarded after recovery decision", tone: "muted" });
  });

  test("retries the durable prompt, never streamed agent output", () => {
    expect(retryInputForJournalTurn({
      runId: "uncertain_run",
      state: "ambiguous",
      prompt: "Review this implementation",
    })).toEqual({ runId: "uncertain_run", state: "ambiguous", input: "Review this implementation" });
  });
});

describe("what a live turn says it is doing", () => {
  const turn = (over: Partial<{ items: unknown[]; tasks: unknown[] }> = {}) =>
    ({ items: [], tasks: [], ...over }) as Parameters<typeof turnActivity>[0];
  const task = (over: Record<string, unknown> = {}) =>
    ({ id: "t", sessionId: "s", runId: "r", kind: "agent", state: "running", startedAt: 1, updatedAt: 1, items: [], ...over }) as never;

  test("a fan-out says how many agents are out, not that the main loop is thinking", () => {
    // "Thinking 43s" beside four sub-agent chips describes the machinery rather
    // than the work: the main loop IS idle, and saying so is the least useful
    // true thing available.
    expect(turnActivity(turn({ tasks: [task(), task({ id: "t2" })] }))).toEqual({
      label: "2 sub-agents working",
      delegated: true,
    });
    expect(turnActivity(turn({ tasks: [task()] })).label).toBe("1 sub-agent working");
  });

  test("a finished sub-agent stops speaking for the turn", () => {
    expect(turnActivity(turn({ tasks: [task({ state: "completed" })] })).label).toBe("Thinking");
  });

  test("background work does not claim the main loop is busy", () => {
    // A watch loop running says nothing about what the agent is doing, and it
    // outlives the turn anyway.
    expect(turnActivity(turn({ tasks: [task({ kind: "background" })] })).label).toBe("Thinking");
  });

  test("a running tool is Working; nothing running is Thinking", () => {
    expect(turnActivity(turn({ items: [{ status: "inProgress" }] })).label).toBe("Working");
    expect(turnActivity(turn({ items: [{ status: "completed" }] })).label).toBe("Thinking");
  });

  test("a backgrounded shell is not a chip in the conversation", () => {
    /**
     * THE BUG THIS PINS: `bun run verify` backgrounded came back in the chat as
     * a bot-icon row titled with the command and "0 steps" — a delegate that
     * appeared never to report. It reports fine; a background shell has no
     * journal items, and the tool call that started it is already a row in this
     * same turn. Its live process belongs on the Processes tab.
     */
    const shell = task({ id: "verify", kind: "background", title: "Run full verify" });
    expect(transcriptTasks([shell, task({ id: "agent" })]).map((t) => t.id)).toEqual(["agent"]);
    expect(transcriptTasks([shell])).toEqual([]);
  });

  test("a warp run survives the filter that drops its background siblings", () => {
    /**
     * A run's own row is `background` because it outlives its turn, but it is
     * the row that says a fan-out happened at all — dropping it would leave its
     * agents as loose chips under no heading. Same rule as `splitRoster`: the
     * kind split happens AFTER the warp fold, never before.
     */
    const run = task({ id: "run", kind: "background", title: "find-flaky-tests", warp: { warpRunId: "run", warpName: "find-flaky-tests" } });
    const child = task({ id: "child", warp: { warpRunId: "run", warpName: "find-flaky-tests" } });
    const shell = task({ id: "tail", kind: "background", title: "tail -f dev.log" });
    expect(transcriptTasks([run, child, shell]).map((t) => t.id)).toEqual(["run", "child"]);
  });

  test("an unrecognised kind stays a chip, matching the contract's denylist", () => {
    // The contract is denylist-shaped on purpose: a provider that renames its
    // agent-flavoured task types must produce an unstyled chip, never an
    // invisible one. Only `background` is filtered.
    expect(transcriptTasks([task({ id: "novel", kind: "local_workflow" })]).map((t) => t.id)).toEqual(["novel"]);
  });

  test("a compaction outranks everything the line could say", () => {
    // While the provider squeezes its memory it is not working on the task,
    // and "Thinking" over that long silence is the read this line prevents.
    expect(
      turnActivity(
        turn({
          items: [{ status: "inProgress", detail: { type: "context_compaction" } }],
          tasks: [task()],
        }),
      ).label,
    ).toBe("Compacting context");
  });
});
