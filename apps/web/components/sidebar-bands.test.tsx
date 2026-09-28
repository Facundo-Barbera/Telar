// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { installTestDom } from "@/lib/testing/dom";
import { liveRow, mountRail, project, stubRail } from "@/lib/testing/rail";

installTestDom();

async function railWith(sessions: unknown[], extra: Record<string, unknown> = {}) {
  stubRail(() => ({ body: { projects: [project("p1", "One")], sessions, ...extra } }));
  const host = await mountRail();
  return {
    host,
    scroll: host.querySelector("#sidebar-session-results")!,
    band: (label: string) => host.querySelector(`[role="group"][aria-label="${label}"]`),
    rowTitled: (title: string) => [...host.querySelectorAll("*")].find((node) => node.childElementCount === 0 && node.textContent === title),
  };
}

const follows = (first: Node, second: Node) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("pinned scrolls with the rail", () => {
  test("the pinned band is inside the scrolling list, above every project group", async () => {
    const rail = await railWith([liveRow("plain"), liveRow("kept", { settledOverride: "active" })]);
    const pinned = rail.band("Pinned")!;
    expect(rail.scroll.contains(pinned)).toBe(true);
    expect(pinned.textContent).toContain("Title kept");
    expect(pinned.textContent).not.toContain("Title plain");
    const plain = rail.rowTitled("Title plain")!;
    expect(rail.scroll.contains(plain)).toBe(true);
    expect(follows(pinned, plain)).toBe(true);
  });

  test('"Needs you" stays above the scroll, outside it', async () => {
    const rail = await railWith([liveRow("plain"), liveRow("blocked", { activity: "blocked" })]);
    const attention = rail.band("Needs you")!;
    expect(attention.textContent).toContain("Title blocked");
    expect(rail.scroll.contains(attention)).toBe(false);
    expect(follows(attention, rail.scroll)).toBe(true);
  });
});

describe("the rail draws no tree", () => {
  test("a delegate of a pinned coordinator draws in its own project, not under the coordinator", async () => {
    const rail = await railWith([liveRow("coordinator", { settledOverride: "active" }), liveRow("worker")], {
      assignments: { worker: [{ taskRunId: "run_task", fromSessionId: "coordinator", runId: "run_task" }] },
    });
    const pinned = rail.band("Pinned")!;
    expect(pinned.textContent).toContain("Title coordinator");
    expect(pinned.textContent).not.toContain("Title worker");
    const worker = rail.rowTitled("Title worker")!;
    expect(rail.scroll.contains(worker)).toBe(true);
    expect(follows(pinned, worker)).toBe(true);
  });
});
