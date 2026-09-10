// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { failedCount } from "./transcript";

/**
 * A collapsed run reports HOW MUCH failed, not merely that something did (#206).
 *
 * The summary used to turn entirely destructive on one failure — chevron, step
 * count and all — so ten steps with two bad commands read exactly like ten bad
 * commands. The reader's question at a collapsed run is how much of it went
 * wrong, and a boolean cannot answer that.
 */
describe("failed counts in a collapsed run", () => {
  const row = (id: string, status: string, type = "command_execution") => ({ id, status, detail: { type } }) as never;
  const agentRow = (id: string, taskId: string) => ({ id, status: "completed", detail: { type: "task", taskId } }) as never;

  test("counts the failures rather than answering yes or no", () => {
    const rows = [row("a", "completed"), row("b", "failed"), row("c", "completed"), row("d", "failed")];
    expect(failedCount(rows, [])).toBe(2);
  });

  test("a clean run counts nothing, so nothing is drawn", () => {
    expect(failedCount([row("a", "completed"), row("b", "completed")], [])).toBe(0);
  });

  test("a declined tool is not a failure — a human said no", () => {
    // `declined` is its own status precisely because nothing went wrong, and a
    // red tally on an approval the reader themself refused is the same lie in
    // miniature.
    expect(failedCount([row("a", "declined"), row("b", "completed")], [])).toBe(0);
  });

  test("a failed sub-agent counts, because its row is its only trace here", () => {
    // The work it failed at lives inside the agent, so this row is all the run
    // has to say about it.
    const tasks = [{ id: "t1", state: "failed" }, { id: "t2", state: "completed" }] as never[];
    expect(failedCount([agentRow("r1", "t1"), agentRow("r2", "t2"), row("c", "completed")], tasks)).toBe(1);
  });

  test("a sub-agent row whose task is unknown is not counted as failed", () => {
    // A task the fold has not met yet is not evidence of anything; guessing
    // would put a red tally on work that may well have succeeded.
    expect(failedCount([agentRow("r1", "missing")], [])).toBe(0);
  });
});
