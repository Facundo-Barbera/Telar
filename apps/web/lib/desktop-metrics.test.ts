// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { desktopMetrics, readProcessMetrics, type ProcessMetricsSummary } from "@/lib/desktop-metrics";

/**
 * WHICH DOOR THE COCKPIT GOES THROUGH, and that it goes through only one.
 *
 * Inside the desktop shell the preload bridge is one IPC hop and keeps working
 * when the cockpit's own server is what is wedged — which, on a page whose job
 * is to show you a wedged app, is not a hypothetical. Everywhere else there is
 * no bridge and the route proxies to the shell's loopback control server.
 * Choosing wrong is invisible until the day it matters, so it is pinned here.
 */

const sample: ProcessMetricsSummary = {
  readAt: 5,
  windowMs: 2_000,
  totals: { cpuPercent: 96, memoryKb: 1_000, processes: 2 },
  types: [{ type: "Tab", label: "Renderer", count: 1, cpuPercent: 96, memoryKb: 1_000, pagelessCount: 1 }],
  busiest: [{ pid: 318, type: "Tab", label: "Renderer", cpuPercent: 96, memoryKb: 1_000, hostsPage: false }],
};

const realFetch = globalThis.fetch;

// `desktopMetrics()` is a question about `window`, so this file is one of the
// few that needs a DOM. Registered here and handed back afterwards — the
// registration is process-wide, and the file it would break is the NEXT one.
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
  // A reader who is told "503" learns nothing they can act on; the route and
  // the shell both write a sentence, and it survives the whole way up.
  await expect(readProcessMetrics()).rejects.toThrow("not running inside the Telar desktop app");
});

test("a refusal with no body still throws rather than resolving to nothing", async () => {
  globalThis.fetch = (async () => new Response("<html>gateway</html>", { status: 502 })) as typeof fetch;
  // Resolving here would hand the page `undefined` and draw an app with no
  // processes in it, which is a lie rather than a gap.
  await expect(readProcessMetrics()).rejects.toThrow("did not answer");
});
