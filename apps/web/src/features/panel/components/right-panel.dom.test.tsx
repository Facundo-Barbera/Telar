// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { installTestDom, mount, flush, stubFetch } from "@/test/dom";
import { RightPanel } from "./right-panel";
import type { PanelTabItem } from "../model";

installTestDom();

const tab = (kind: string, id = kind): PanelTabItem => ({ id, kind, params: {} }) as PanelTabItem;

function panel(tabs: PanelTabItem[], extra: { hostId?: string; onMoveTab?: (id: string, toIndex: number) => void } = {}) {
  return mount(
    <RightPanel
      sessionId="session_a"
      projectId="project_a"
      tabs={tabs}
      tab={tabs[0]!.id}
      onTabChange={() => {}}
      onOpenTab={() => {}}
      onCloseTab={() => {}}
      onClose={() => {}}
      {...extra}
    />,
  );
}

describe("the Agents surface", () => {
  test("with no sub-agents it still lists the conversations related to this one, asked of its host", async () => {
    const calls = stubFetch({
      "GET /api/hosts/remote_1/sessions/live": () => ({
        sessions: [{ id: "session_b", title: "Helper errand", projectId: "project_a", state: "active", driver: "claude", workspace: { mode: "local", path: "/work" }, activity: "idle", createdAt: 1, updatedAt: 1, startedFrom: { sessionId: "session_a" } }],
      }),
      "GET /api/hosts/remote_1/sessions/session_a/subscriptions": () => ({ subscriptions: [] }),
    });
    const { host } = await panel([tab("agents")], { hostId: "remote_1" });
    await flush(() => host.textContent?.includes("Helper errand") ?? false);
    expect(host.textContent).toContain("Sub-agents appear here as they work");
    expect(host.textContent).toContain("Helper errand");
    expect(calls.map((call) => call.route)).toContain("GET /api/hosts/remote_1/sessions/session_a/subscriptions");
  });
});

describe("the panel's tabs drag to reorder", () => {
  function drag(type: string, target: Element, data: Map<string, string>, clientX = 0) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const dataTransfer = {
      get types() {
        return [...data.keys()];
      },
      setData: (format: string, value: string) => data.set(format, value),
      getData: (format: string) => data.get(format) ?? "",
      effectAllowed: "all",
      dropEffect: "none",
    };
    Object.assign(event, { dataTransfer, clientX });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  async function strip() {
    stubFetch({});
    const moves: [string, number][] = [];
    const { host } = await panel([tab("agents"), tab("processes"), tab("diff")], { onMoveTab: (id, to) => moves.push([id, to]) });
    const chips = [...host.querySelectorAll('[role="tablist"] > span')];
    return { chips, moves };
  }

  test("the chip is the handle, and none of the buttons inside it is", async () => {
    const { chips } = await strip();
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.getAttribute("draggable")).toBe("true");
      expect(chip.querySelectorAll("[draggable]")).toHaveLength(0);
    }
  });

  test("a drop asks for an index in the strip without the carried tab", async () => {
    const { chips, moves } = await strip();
    const data = new Map<string, string>();
    drag("dragstart", chips[0]!, data);
    drag("dragover", chips[2]!, data, 1);
    drag("drop", chips[2]!, data);
    expect(moves).toEqual([["agents", 2]]);

    const back = new Map<string, string>();
    drag("dragstart", chips[2]!, back);
    drag("dragover", chips[0]!, back, -1);
    drag("drop", chips[0]!, back);
    expect(moves.at(-1)).toEqual(["diff", 0]);
  });

  test("dropping a tab on itself moves nothing", async () => {
    const { chips, moves } = await strip();
    const data = new Map<string, string>();
    drag("dragstart", chips[1]!, data);
    drag("drop", chips[1]!, data);
    expect(moves).toEqual([]);
  });
});
