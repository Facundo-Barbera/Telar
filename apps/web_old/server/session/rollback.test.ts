// THE PLANNER'S REFUSALS ARE THE FEATURE (message-lifecycle STEP 4): every
// case that can be decided from the record alone is decided here, in one
// sentence a human can read — turn 0, nothing-to-remove, anchorless history,
// mixed providers, a kept turn with no tail. The two live plans are pinned
// exactly: Claude forks at the KEPT turn's tail and guards only a
// single-turn drop; Codex is a bare turn count.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import type { TurnAnchor } from "@/lib/store";
import { planRollback } from "./rollback";

const anchor = (over: Partial<TurnAnchor> = {}): TurnAnchor => ({
  startMessage: 0,
  endMessage: 2,
  provider: "claude",
  at: 1,
  ...over,
});

const chatOf = (anchors: TurnAnchor[]) => ({ turns: anchors.length, turnAnchors: anchors });

describe("planRollback", () => {
  const three = [
    anchor({ startMessage: 0, endMessage: 2, prompt: "u-0", tail: "a-0" }),
    anchor({ startMessage: 2, endMessage: 4, prompt: "u-1", tail: "a-1" }),
    anchor({ startMessage: 4, endMessage: 6, prompt: "u-2", tail: "a-2" }),
  ];

  test("removing the last exchange: fork at the kept tail, guard the one dropped prompt", () => {
    expect(planRollback(chatOf(three), 2)).toEqual({
      kind: "claude",
      resumeSessionAt: "a-1",
      resumeDropsTurn: "u-2",
    });
  });

  test("a multi-turn rollback omits the guard — resumeDropsTurn declares ONE turn", () => {
    expect(planRollback(chatOf(three), 1)).toEqual({
      kind: "claude",
      resumeSessionAt: "a-0",
    });
  });

  test("a dropped hidden turn has no prompt: unguarded, by the option's own docs", () => {
    const anchors = [
      anchor({ prompt: "u-0", tail: "a-0" }),
      anchor({ startMessage: 2, endMessage: 3, hidden: true, tail: "a-1" }),
    ];
    expect(planRollback(chatOf(anchors), 1)).toEqual({
      kind: "claude",
      resumeSessionAt: "a-0",
    });
  });

  test("turn 0 is not a target — the first message has no pencil", () => {
    const plan = planRollback(chatOf(three), 0);
    expect(plan.kind).toBe("refused");
  });

  test("nothing after the point → refused, including past-the-end", () => {
    expect(planRollback(chatOf(three), 3).kind).toBe("refused");
    expect(planRollback(chatOf(three), 7).kind).toBe("refused");
    expect(planRollback(chatOf(three), -1).kind).toBe("refused");
    expect(planRollback(chatOf(three), 1.5).kind).toBe("refused");
  });

  test("anchorless or partially-anchored history refuses — no promise a legacy chat can't keep", () => {
    expect(planRollback({ turns: 3, turnAnchors: undefined }, 1).kind).toBe("refused");
    expect(planRollback({ turns: 3, turnAnchors: three.slice(0, 2) }, 1).kind).toBe("refused");
  });

  test("a kept turn with no tail refuses — there is nowhere to fork", () => {
    const anchors = [anchor({ prompt: "u-0" }), anchor({ prompt: "u-1", tail: "a-1" })];
    expect(planRollback(chatOf(anchors), 1).kind).toBe("refused");
  });

  test("an all-Codex range is a bare turn count", () => {
    const anchors = [
      anchor({ provider: "codex" }),
      anchor({ provider: "codex" }),
      anchor({ provider: "codex" }),
    ];
    expect(planRollback(chatOf(anchors), 1)).toEqual({ kind: "codex", numTurns: 2 });
  });

  test("a mixed-provider range refuses in one sentence", () => {
    const anchors = [
      anchor({ prompt: "u-0", tail: "a-0" }),
      anchor({ provider: "codex" }),
      anchor({ prompt: "u-2", tail: "a-2" }),
    ];
    const plan = planRollback(chatOf(anchors), 1);
    expect(plan.kind).toBe("refused");
    expect((plan as { reason: string }).reason).toMatch(/different agents/);
  });
});
