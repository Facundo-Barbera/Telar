import { describe, expect, test } from "bun:test";
import { processToReveal, stillWorking } from "./background-presence";

const shell = (id: string, state: "running" | "completed" | "waiting" = "running") => ({ id, kind: "background" as const, state });
const agent = (id: string) => ({ id, kind: "agent" as const, backgrounded: true, state: "running" as const });

describe("processToReveal", () => {
  test("one running process opens its row", () => {
    expect(processToReveal([shell("a")])).toBe("a");
  });

  test("several running tasks open none", () => {
    expect(processToReveal([shell("a"), shell("b")])).toBeUndefined();
    expect(processToReveal([shell("a"), agent("b")])).toBeUndefined();
  });

  test("finished or paused tasks do not count toward the one", () => {
    expect(processToReveal([shell("a"), shell("b", "completed"), shell("c", "waiting")])).toBe("a");
  });

  test("a lone backgrounded sub-agent has no Processes row to open", () => {
    expect(processToReveal([agent("a")])).toBeUndefined();
  });

  test("nothing running opens none", () => {
    expect(processToReveal([])).toBeUndefined();
  });
});

describe("stillWorking", () => {
  test("counts what the banner counts", () => {
    expect(stillWorking([shell("a"), agent("b"), shell("c", "completed"), { ...shell("d"), ambient: true }]).map((t) => t.id)).toEqual(["a", "b"]);
  });
});
