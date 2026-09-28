// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { desktopMetrics, readProcessMetrics, type ProcessMetricsSummary } from "@/platform/desktop/desktop-metrics";

const sample: ProcessMetricsSummary = {
  readAt: 5,
  windowMs: 2_000,
  totals: { cpuPercent: 96, memoryKb: 1_000, processes: 2 },
  types: [{ type: "Tab", label: "Renderer", count: 1, cpuPercent: 96, memoryKb: 1_000, pagelessCount: 1 }],
  busiest: [{ pid: 318, type: "Tab", label: "Renderer", cpuPercent: 96, memoryKb: 1_000, hostsPage: false }],
};

const realFetch = globalThis.fetch;

// The DOM registration is process-wide, so it is undone after this file.
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as unknown as { telarDesktop?: unknown }).telarDesktop;
});

test("inside the shell it asks the bridge and never touches the network", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response("{}");
  }) as typeof fetch;
  (window as unknown as { telarDesktop?: unknown }).telarDesktop = { metrics: { read: async () => sample } };
  expect(desktopMetrics()).toBeDefined();
  expect(await readProcessMetrics()).toEqual(sample);
  expect(fetched).toBe(0);
});

test("with no bridge it proxies through the cockpit's route", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify(sample), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  expect(await readProcessMetrics()).toEqual(sample);
  expect(asked).toEqual(["/api/desktop/metrics"]);
});

test("a refusal carries the shell's own sentence, not its status code", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "This cockpit is not running inside the Telar desktop app, so it has no processes to report." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await expect(readProcessMetrics()).rejects.toThrow("not running inside the Telar desktop app");
});

test("a refusal with no body still throws rather than resolving to nothing", async () => {
  globalThis.fetch = (async () => new Response("<html>gateway</html>", { status: 502 })) as typeof fetch;
  await expect(readProcessMetrics()).rejects.toThrow("did not answer");
});
