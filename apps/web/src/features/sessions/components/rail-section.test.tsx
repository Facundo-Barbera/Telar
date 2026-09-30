import { expect, test } from "bun:test";
import { flush, installTestDom, mount, press } from "@/test/dom";
import { liveRow, mountRail, project, stubRail } from "@/test/rail";
import { RailSection } from "./rail-section";

installTestDom();

function stubLayout(mode: "grouped" | "flat") {
  const patches: unknown[] = [];
  let layout = { mode };
  stubRail(() => ({ body: { projects: [project("p1", "One"), project("p2", "Two")], sessions: [liveRow("a"), liveRow("b", { projectId: "p2" })] } }));
  const railFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input), "http://localhost").pathname !== "/api/sidebar-layout") return railFetch(input, init);
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      layout = { ...layout, ...patch };
    }
    return Response.json({ layout });
  }) as typeof fetch;
  return patches;
}

const toggle = () => document.querySelector<HTMLElement>('[aria-label="Group sessions by project"]')!;
const projectHeads = (host: HTMLElement) => host.querySelectorAll('[aria-label^="New conversation in "]').length;

test("turning grouping off in settings flattens the rail, and back on regroups it", async () => {
  const patches = stubLayout("grouped");
  const rail = await mountRail();
  await mount(<RailSection />);
  await flush();
  expect(projectHeads(rail)).toBe(2);
  expect(toggle().getAttribute("aria-checked")).toBe("true");

  await press(toggle());
  await flush();
  expect(patches).toEqual([{ mode: "flat" }]);
  expect(projectHeads(rail)).toBe(0);
  expect(rail.textContent).toContain("Title a");
  expect(rail.textContent).toContain("Title b");

  await press(toggle());
  await flush();
  expect(patches).toEqual([{ mode: "flat" }, { mode: "grouped" }]);
  expect(projectHeads(rail)).toBe(2);
});

test("the rail header no longer offers a grouping switch", async () => {
  stubLayout("flat");
  const rail = await mountRail();
  expect(rail.querySelector('[aria-label="Group by"]')).toBeNull();
  expect(rail.textContent).not.toContain("Group by");
  expect(projectHeads(rail)).toBe(0);
});
