/**
 * THE KERNEL PILL TELLS THE TRUTH WHILE SOMETHING IS RUNNING (#356).
 *
 * It read IDLE through a 35-second `ds_scratch` because the Data tab asked
 * once, on mount, and then believed the answer. The kernel announces every
 * transition on the journal; this is the fold that reads them.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { latestKernelState } from "./ds";

const state = (value: string) => ({ type: "kernel.state.changed", state: value });
const other = (type: string) => ({ type });

describe("latestKernelState", () => {
  test("the last transition wins, which is what the pill should say", () => {
    expect(latestKernelState([state("starting"), state("idle"), state("busy")])).toBe("busy");
  });

  test("a run that finished is idle again", () => {
    expect(latestKernelState([state("busy"), state("idle")])).toBe("idle");
  });

  test("events about anything else are not about the kernel", () => {
    // The panel is handed the whole journal; a tool call in flight says nothing
    // about the kernel, and reading one as a state would be worse than silence.
    expect(latestKernelState([state("busy"), other("item.started"), other("turn.completed")])).toBe("busy");
  });

  test("a journal that never mentions the kernel says nothing, rather than 'none'", () => {
    // Not the same claim: a kernel started before this client was listening has
    // its transitions outside the window, and the caller's own read is better
    // than an invented "there is no kernel".
    expect(latestKernelState([])).toBeUndefined();
    expect(latestKernelState([other("turn.started")])).toBeUndefined();
  });

  test("a kernel that died says so", () => {
    expect(latestKernelState([state("busy"), state("dead")])).toBe("dead");
  });
});
