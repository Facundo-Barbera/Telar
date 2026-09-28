/**
 * THE "PLUGINS" TAB — an installed plugin's panel drawn from its blocks.
 *
 *   the blocks    heading, text, key-value, table and log render as the cockpit's own
 *   an action     posts its verb with its input, then redraws the panel
 *   a confirm     declined, nothing is posted
 *   the tab       offered only while an enabled plugin has a panel
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { PluginStatus } from "@telar/engine-client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PluginPanelsSurface } = await import("./plugin-panels-surface");
const { pluginPanelSources } = await import("@/lib/plugins/panels");
const { pluginSurfaces } = await import("@/lib/plugins/registry");

const status = (id: string, panels: { id: string; label: string; verb: string }[], state: PluginStatus["state"] = "ready"): PluginStatus => ({
  meta: { id, api: 1, name: id === "echo" ? "Echo" : id, version: "1", toolPrefixes: [], readTools: [], eventKinds: [], settings: [], panels },
  state,
});

const PANELS = pluginPanelSources([status("echo", [{ id: "jobs", label: "Jobs", verb: "status" }])], ["echo"]);

let cleared = 0;
let posted: { url: string; body: unknown }[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;
const realConfirm = window.confirm;

beforeEach(() => {
  cleared = 0;
  posted = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    posted.push({ url, body });
    if (url.endsWith("/plugins/echo/clear")) {
      cleared += 1;
      return json({ ok: true });
    }
    if (url.endsWith("/plugins/echo/status")) {
      return json({
        blocks: [
          { type: "heading", text: "Jobs" },
          { type: "text", text: `Cleared ${cleared} times` },
          { type: "keyValue", items: [{ key: "Queue", value: 2 }] },
          { type: "table", columns: ["Job", "State"], rows: [["a", "done"], ["b", null]] },
          { type: "log", lines: ["started", "finished"] },
          { type: "chart", points: [] },
          { type: "action", label: "Clear", verb: "clear", input: { all: true }, confirm: "Clear every job?" },
        ],
      });
    }
    return json({});
  }) as typeof fetch;
  window.setTimeout = ((fn: () => void) => {
    queueMicrotask(fn);
    return 0;
  }) as unknown as typeof window.setTimeout;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.setTimeout = realSetTimeout;
  window.confirm = realConfirm;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await Promise.resolve());
};

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<PluginPanelsSurface sessionId="session_one" panels={PANELS} />));
  await flush();
  return { host, done: () => act(() => root.unmount()) };
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label) as HTMLButtonElement;

describe("a panel's blocks", () => {
  test("each kind renders, and one this build does not know is skipped", async () => {
    const { host, done } = await mount();
    expect(posted[0]?.url).toBe("/api/sessions/session_one/plugins/echo/status");
    expect(host.querySelector("h3")?.textContent).toBe("Jobs");
    expect(host.textContent).toContain("Cleared 0 times");
    expect(host.querySelector("dt")?.textContent).toBe("Queue");
    expect(host.querySelector("dd")?.textContent).toBe("2");
    expect([...host.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Job", "State"]);
    expect([...host.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["a", "done", "b", "—"]);
    expect(host.querySelector('[role="log"]')?.textContent).toBe("started\nfinished");
    expect(host.textContent).toContain("Echo · Jobs");
    done();
  });

  test("an action posts its verb with its input, then redraws", async () => {
    window.confirm = () => true;
    const { host, done } = await mount();
    await act(async () => button(host, "Clear").click());
    await flush();
    expect(posted.find((call) => call.url.endsWith("/clear"))?.body).toEqual({ all: true });
    expect(host.textContent).toContain("Cleared 1 times");
    done();
  });

  test("a declined confirm posts nothing", async () => {
    window.confirm = () => false;
    const { host, done } = await mount();
    await act(async () => button(host, "Clear").click());
    await flush();
    expect(cleared).toBe(0);
    done();
  });
});

describe("the tab", () => {
  test("is offered only while an enabled, running plugin has a panel", () => {
    const statuses = [status("echo", [{ id: "jobs", label: "Jobs", verb: "status" }]), status("broken", [{ id: "x", label: "X", verb: "x" }], "failed")];
    expect(pluginPanelSources(statuses, [])).toEqual([]);
    expect(pluginPanelSources(statuses, ["broken"])).toEqual([]);
    expect(pluginPanelSources(statuses, ["echo"]).map((source) => source.panel.id)).toEqual(["jobs"]);
    expect(pluginSurfaces(["latex"], false).map((surface) => surface.id)).toEqual(["latex"]);
    expect(pluginSurfaces(["latex"], true).map((surface) => surface.id)).toEqual(["latex", "plugin-panels"]);
  });
});
