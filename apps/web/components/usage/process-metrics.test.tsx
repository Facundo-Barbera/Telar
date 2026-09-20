// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { concerning, formatCpu, formatMemory, formatWindow, RUNAWAY_CPU_PERCENT, type ProcessMetricsSummary } from "@/lib/desktop-metrics";
import { ProcessMetricsView } from "./process-metrics";

/**
 * The Processes section's one job: make the #487 incident legible.
 *
 * The shape under test is a renderer at 96% of a core that is hosting no page —
 * which is what a spinning service worker looks like from inside Electron,
 * because `ProcessMetric.type` has no `serviceWorker` value and the metric
 * carries no origin. Everything else on this surface is arithmetic.
 */

const summary = (overrides: Partial<ProcessMetricsSummary> = {}): ProcessMetricsSummary => ({
  readAt: 1_000,
  windowMs: 2_000,
  totals: { cpuPercent: 104, memoryKb: 900_000, processes: 4 },
  types: [
    { type: "Tab", label: "Renderer", count: 2, cpuPercent: 97, memoryKb: 600_000, pagelessCount: 1 },
    { type: "GPU", label: "GPU", count: 1, cpuPercent: 5, memoryKb: 200_000, pagelessCount: 0 },
    { type: "Browser", label: "Main", count: 1, cpuPercent: 2, memoryKb: 100_000, pagelessCount: 0 },
  ],
  busiest: [
    { pid: 318, type: "Tab", label: "Renderer", cpuPercent: 96, memoryKb: 400_000, hostsPage: false },
    { pid: 42, type: "Tab", label: "Renderer", cpuPercent: 1, memoryKb: 200_000, hostsPage: true },
    { pid: 7, type: "Utility", label: "Utility", cpuPercent: 0.4, memoryKb: 90_000, name: "Network Service" },
  ],
  ...overrides,
});

test("a renderer burning a core with no page is named, with its pid", () => {
  const html = renderToStaticMarkup(<ProcessMetricsView summary={summary()} />);
  expect(html).toContain("A renderer with no page is at 96%");
  expect(html).toContain("pid 318");
  // The per-type row the issue asked for, and the count that carries the find.
  expect(html).toContain("Renderer");
  expect(html).toContain("1 with no page");
});

test("a busy process that IS showing a page is reported as work, not as a runaway", () => {
  const busyPage = summary({
    busiest: [{ pid: 55, type: "Tab", label: "Renderer", cpuPercent: 91, memoryKb: 300_000, hostsPage: true }],
    types: [{ type: "Tab", label: "Renderer", count: 1, cpuPercent: 91, memoryKb: 300_000, pagelessCount: 0 }],
  });
  const html = renderToStaticMarkup(<ProcessMetricsView summary={busyPage} />);
  expect(html).toContain("this is work rather than a runaway");
  expect(html).not.toContain("A renderer with no page");
  // Nothing is page-less, so the column that would say so stays silent rather
  // than printing a zero for the eye to learn to skip.
  expect(html).not.toContain("with no page");
});

test("nothing is flagged before there is a window to have measured it over", () => {
  // One sample is not a rate. Announcing "nothing is busy" a beat before
  // showing a pinned core would be worse than saying nothing.
  const cold = summary({ windowMs: 0, totals: { cpuPercent: 0, memoryKb: 900_000, processes: 4 } });
  expect(concerning(cold)).toEqual([]);
  const html = renderToStaticMarkup(<ProcessMetricsView summary={cold} />);
  expect(html).toContain("no reading yet");
  expect(html).not.toContain("A renderer with no page");
});

test("the threshold is the one the shell kills at", () => {
  // If service-worker-watchdog.js moves HOT_CPU_PERCENT, this page starts
  // flagging at a different number than the shell acts at — which is how a
  // surface quietly stops describing the thing it is next to.
  expect(RUNAWAY_CPU_PERCENT).toBe(80);
  const atThreshold = summary({
    busiest: [{ pid: 9, type: "Tab", label: "Renderer", cpuPercent: 80, memoryKb: 1, hostsPage: false }],
  });
  expect(concerning(atThreshold)).toHaveLength(1);
  const under = summary({
    busiest: [{ pid: 9, type: "Tab", label: "Renderer", cpuPercent: 79.9, memoryKb: 1, hostsPage: false }],
  });
  expect(concerning(under)).toEqual([]);
});

test("figures read as figures, and a fraction of a core is not rounded away to nothing", () => {
  expect(formatCpu(96.4)).toBe("96%");
  expect(formatCpu(0.4)).toBe("<1%");
  expect(formatCpu(0)).toBe("0%");
  expect(formatMemory(400_000)).toBe("391 MB");
  expect(formatMemory(2_200_000)).toBe("2.1 GB");
  expect(formatMemory(0)).toBe("—");
  expect(formatWindow(30_000)).toBe("averaged over 30s");
  expect(formatWindow(0)).toBe("no reading yet");
});

test("a utility process is named by what it is, not by the type it shares with ten others", () => {
  const html = renderToStaticMarkup(<ProcessMetricsView summary={summary()} />);
  // Electron names its utility children; "Utility · pid 7" would send somebody
  // to Activity Monitor to find out which one, which is the trip this surface
  // exists to save.
  expect(html).toContain("Network Service");
});

test("an error is shown rather than an app that looks idle", () => {
  const html = renderToStaticMarkup(<ProcessMetricsView summary={undefined} error="The Telar desktop shell did not answer." />);
  expect(html).toContain("The Telar desktop shell did not answer.");
  // And no totals at all — a dash, never a zero, for a reading that failed.
  expect(html).toContain("—");
});
