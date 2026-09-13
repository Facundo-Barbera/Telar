/**
 * ONE FIGURE IS ONE CARD (#353).
 *
 * The gallery's whole job is "which figures does this session have", and the
 * defect was that it answered "how many times did anything get drawn" — three
 * passes at one chart read as three charts, each captioned with the execution
 * counter that drew it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { TurnAttachment } from "@telar/engine-client";
import { plotGroupKey, plotLabel, stackPlots } from "./plots-surface";

const plot = (id: string, extra: Partial<TurnAttachment> = {}): TurnAttachment => ({
  id,
  name: `${id}.png`,
  mediaType: "image/png",
  bytes: 1,
  path: `/tmp/${id}.png`,
  tags: ["plot"],
  ...extra,
});

describe("stackPlots", () => {
  test("three passes at one figure are one card with its latest on top", () => {
    // The reported case: the agent re-ran a plot while tuning labels, and the
    // gallery drew exec_6, exec_9 and exec_12 as if they were three charts.
    const stacks = stackPlots([
      plot("a", { title: "Radius vs. period", producer: "ds_plot", createdAt: 1 }),
      plot("b", { title: "Radius vs. period", producer: "ds_plot", createdAt: 3 }),
      plot("c", { title: "Radius vs. period", producer: "ds_plot", createdAt: 2 }),
    ]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.latest.id).toBe("b");
    expect(stacks[0]!.versions.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  test("a re-run cell is the same figure, because the cell is", () => {
    const stacks = stackPlots([plot("a", { producer: "cell_7", createdAt: 1 }), plot("b", { producer: "cell_7", createdAt: 2 })]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.latest.id).toBe("b");
  });

  test("two untitled ds_plot figures are two figures, not two versions of one", () => {
    // The error worth avoiding: a tool name says who drew it, not what it is,
    // and stacking on it would hide one chart behind an unrelated one.
    const stacks = stackPlots([plot("a", { producer: "ds_plot", createdAt: 1 }), plot("b", { producer: "ds_plot", createdAt: 2 })]);
    expect(stacks).toHaveLength(2);
    expect(stacks.map((stack) => stack.versions.length)).toEqual([1, 1]);
  });

  test("differently titled figures stay apart even from the same tool", () => {
    const stacks = stackPlots([
      plot("a", { title: "Mass histogram", producer: "ds_plot", createdAt: 1 }),
      plot("b", { title: "Radius vs. period", producer: "ds_plot", createdAt: 2 }),
    ]);
    expect(stacks.map((stack) => stack.latest.id)).toEqual(["b", "a"]);
  });

  test("a pin belongs to the figure, so drawing it again does not lose it", () => {
    // Pinning an attempt and then re-running the cell must not quietly unpin
    // the figure — the pin was a statement about the chart.
    const stacks = stackPlots([
      plot("old", { producer: "cell_1", createdAt: 1, tags: ["plot", "pinned"] }),
      plot("new", { producer: "cell_1", createdAt: 5 }),
      plot("other", { producer: "cell_2", createdAt: 9 }),
    ]);
    expect(stacks[0]!.latest.id).toBe("new");
    expect(stacks[0]!.pinned).toBe(true);
    // …and it still sorts above a figure drawn more recently.
    expect(stacks[1]!.latest.id).toBe("other");
  });

  test("no timestamps at all still produces one stack per figure", () => {
    // Attachments written before `createdAt` existed. The order is whatever it
    // is; the grouping is the claim.
    const stacks = stackPlots([plot("a", { title: "T" }), plot("b", { title: "T" })]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.versions).toHaveLength(2);
  });
});

describe("plotLabel", () => {
  test("the figure's own title beats what drew it, which beats the filename", () => {
    expect(plotLabel(plot("a", { title: "Radius vs. period", producer: "exec_9" }))).toBe("Radius vs. period");
    expect(plotLabel(plot("a", { producer: "exec_9" }))).toBe("exec_9");
    expect(plotLabel(plot("a"))).toBe("a.png");
    // A title of spaces is not a title.
    expect(plotLabel(plot("a", { title: "   ", producer: "ds_plot" }))).toBe("ds_plot");
  });
});

describe("plotGroupKey", () => {
  test("case and surrounding space do not make a second figure", () => {
    expect(plotGroupKey(plot("a", { title: " Radius " }))).toBe(plotGroupKey(plot("b", { title: "radius" })));
  });
});
