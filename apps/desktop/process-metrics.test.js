const { describe, expect, test } = require("bun:test");
const {
  BUSIEST_LIMIT,
  cpuRates,
  createProcessMetricsReader,
  labelForType,
  summarizeProcessMetrics,
} = require("./process-metrics");

/**
 * The per-process-type surface (#488) and, more importantly, the reason it does
 * not break the kill path it sits beside (#487).
 *
 * `percentCPUUsage` is documented as an average since the last call to
 * `app.getAppMetrics()` — the baseline belongs to the API, not to the caller —
 * so a page polling every two seconds would have shortened the watchdog's
 * thirty-second window without either side saying anything. The tests that
 * matter most here are the ones that pin that window open.
 */

/** A `ProcessMetric` with cumulative CPU seconds, which is what real rates are
 *  computed from. */
function metric(pid, type, cpuSeconds, { creationTime = 1_000, memoryKb = 100_000, percent, name } = {}) {
  return {
    pid,
    type,
    creationTime,
    cpu: {
      cumulativeCPUUsage: cpuSeconds,
      ...(percent === undefined ? {} : { percentCPUUsage: percent }),
    },
    memory: { workingSetSize: memoryKb },
    ...(name ? { name } : {}),
  };
}

/** A reader over a scripted series of polls, with a clock the test drives. */
function readerOver(series, { minIntervalMs = 1_000, liveProcessIds = [] } = {}) {
  let clock = 0;
  let index = 0;
  const reader = createProcessMetricsReader({
    readMetrics: () => series[Math.min(index++, series.length - 1)],
    readLiveProcessIds: () => liveProcessIds,
    now: () => clock,
    minIntervalMs,
  });
  return { reader, advance: (ms) => (clock += ms), at: () => clock, polls: () => index };
}

describe("folding one poll for somebody looking at it", () => {
  test("totals are per process type, and a renderer is never called a tab", () => {
    const summary = summarizeProcessMetrics({
      metrics: [metric(1, "Browser", 0), metric(2, "Tab", 0), metric(3, "Tab", 0), metric(4, "GPU", 0)],
      rates: new Map([["1:1000", 4], ["2:1000", 96], ["3:1000", 2], ["4:1000", 8]]),
      liveProcessIds: [2, 3],
      readAt: 5_000,
      windowMs: 2_000,
    });
    expect(summary.types.map((entry) => [entry.label, entry.count, entry.cpuPercent])).toEqual([
      // Busiest type first: the row a person came to read is the top one.
      ["Renderer", 2, 98],
      ["GPU", 1, 8],
      ["Main", 1, 4],
    ]);
    expect(summary.totals).toEqual({ cpuPercent: 110, memoryKb: 400_000, processes: 4 });
    expect(summary.windowMs).toBe(2_000);
    // Chromium calls every renderer a "Tab", including the service-worker ones
    // that have no tab at all — which is the exact confusion #487 lived in.
    expect(labelForType("Tab")).toBe("Renderer");
  });

  test("a renderer hosting no page is counted and named; other process types are not accused of it", () => {
    const summary = summarizeProcessMetrics({
      metrics: [metric(1, "Browser", 0), metric(2, "Tab", 0), metric(7, "Tab", 0), metric(4, "Utility", 0, { name: "Network Service" })],
      rates: new Map([["7:1000", 96], ["2:1000", 3], ["1:1000", 2], ["4:1000", 1]]),
      liveProcessIds: [2],
      readAt: 5_000,
      windowMs: 30_000,
    });
    const renderers = summary.types.find((entry) => entry.type === "Tab");
    expect(renderers.pagelessCount).toBe(1);
    // The busiest process IS the page-less one, which is the whole signal.
    expect(summary.busiest[0]).toMatchObject({ pid: 7, label: "Renderer", cpuPercent: 96, hostsPage: false });
    expect(summary.busiest.find((entry) => entry.pid === 2)).toMatchObject({ hostsPage: true });
    // "Has no page" about the network service would read as an accusation; it
    // is not false, it is meaningless, so the field is absent.
    const utility = summary.busiest.find((entry) => entry.pid === 4);
    expect(utility.name).toBe("Network Service");
    expect("hostsPage" in utility).toBe(false);
    expect(summary.types.find((entry) => entry.type === "Utility").pagelessCount).toBe(0);
  });

  test("the busiest list is capped and ordered, and ties do not shuffle", () => {
    const metrics = Array.from({ length: BUSIEST_LIMIT + 4 }, (_, index) => metric(index + 1, "Tab", 0));
    // Every process idle: the tie-break is the pid, so two consecutive reads of
    // an idle app do not reorder in front of somebody trying to read it.
    const summary = summarizeProcessMetrics({ metrics, rates: new Map(), readAt: 1, windowMs: 1_000 });
    expect(summary.busiest).toHaveLength(BUSIEST_LIMIT);
    expect(summary.busiest.map((entry) => entry.pid)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("rates come from cumulative CPU seconds", () => {
  test("a core fully used for the whole window reads as 100", () => {
    const rates = cpuRates({
      before: [metric(1, "Tab", 10)],
      after: [metric(1, "Tab", 12)],
      elapsedMs: 2_000,
    });
    expect(rates.get("1:1000")).toBe(100);
  });

  test("a pid that came back with a new creation time starts from its own reading, not the dead process's", () => {
    const rates = cpuRates({
      before: [metric(1, "Tab", 900, { creationTime: 1_000 })],
      after: [metric(1, "Tab", 1, { creationTime: 9_000, percent: 7 })],
      elapsedMs: 1_000,
    });
    // Subtracting 900 from 1 would have reported a violently negative rate; the
    // key includes creationTime, so the new process has no baseline and falls
    // back to what it reported about itself.
    expect(rates.get("1:9000")).toBe(7);
  });

  test("a process that reports no cumulative figure falls back to percentCPUUsage", () => {
    const bare = { pid: 5, type: "GPU", creationTime: 1_000, cpu: { percentCPUUsage: 42 }, memory: {} };
    const rates = cpuRates({ before: [bare], after: [bare], elapsedMs: 1_000 });
    expect(rates.get("5:1000")).toBe(42);
  });
});

describe("one sampler, so the page cannot shorten the watchdog's window (#487)", () => {
  test("the watchdog still averages over thirty seconds while a page polls every two", () => {
    // A renderer burning one core the whole time, and a second that spikes for
    // exactly one two-second gap. Cumulative seconds advance by wall time for
    // the first; the second does one second of work and then stops.
    const series = [];
    for (let poll = 0; poll <= 20; poll += 1) {
      const spike = poll === 10 ? 1 : 0;
      series.push([
        metric(1, "Tab", poll * 2),
        metric(2, "Tab", poll >= 10 ? spike + (poll > 10 ? 1 : 0) : 0),
      ]);
    }
    const { reader, advance } = readerOver(series, { minIntervalMs: 1_000 });

    // The page polls every two seconds for a minute.
    for (let tick = 0; tick < 15; tick += 1) {
      reader.summary();
      advance(2_000);
    }
    const watchdogView = reader.metricsForWatchdog({ minWindowMs: 25_000 });
    const byPid = new Map(watchdogView.map((entry) => [entry.pid, entry.cpu.percentCPUUsage]));
    // Sustained: one core, over the whole thirty-second window.
    expect(Math.round(byPid.get(1))).toBe(100);
    // The spike did one CPU-second inside that window, which over ~28s is a
    // few percent — nowhere near the 80% the watchdog kills at. Read over the
    // two-second gap it happened in, it would have been 50% or more.
    expect(byPid.get(2)).toBeLessThan(10);
  });

  test("with nothing old enough to compare against, the watchdog reads zero rather than a guess", () => {
    const { reader, advance } = readerOver([[metric(1, "Tab", 0, { percent: 99 })], [metric(1, "Tab", 30, { percent: 99 })]]);
    reader.summary();
    advance(3_000);
    // Three seconds in, no baseline is twenty-five seconds old. Electron's own
    // API answers 0 on its first call for the same reason; a cold sampler must
    // not hand the kill path a number it cannot stand behind.
    expect(reader.metricsForWatchdog({ minWindowMs: 25_000 }).map((entry) => entry.cpu.percentCPUUsage)).toEqual([0]);
  });

  test("the watchdog's answer keeps the shape app.getAppMetrics() has", () => {
    const { reader, advance } = readerOver([
      [metric(1, "Tab", 0, { name: "renderer" })],
      [metric(1, "Tab", 30, { name: "renderer" })],
    ]);
    reader.summary();
    advance(30_000);
    const [entry] = reader.metricsForWatchdog({ minWindowMs: 25_000 });
    expect(entry).toMatchObject({ pid: 1, type: "Tab", creationTime: 1_000, name: "renderer" });
    expect(entry.cpu.cumulativeCPUUsage).toBe(30);
    expect(Math.round(entry.cpu.percentCPUUsage)).toBe(100);
  });
});

describe("the sampler itself", () => {
  test("reads the API at most once per interval, however often it is asked", () => {
    const { reader, advance, polls } = readerOver(
      [[metric(1, "Tab", 0)], [metric(1, "Tab", 1)], [metric(1, "Tab", 2)]],
      { minIntervalMs: 1_000 },
    );
    reader.summary();
    reader.summary();
    reader.metricsForWatchdog();
    expect(polls()).toBe(1);
    advance(1_000);
    reader.summary();
    expect(polls()).toBe(2);
  });

  test("one sample is not a rate, and says so instead of reporting an idle app", () => {
    const { reader } = readerOver([[metric(1, "Tab", 0, { percent: 96 })]]);
    const first = reader.summary();
    expect(first.windowMs).toBe(0);
    // No baseline means no rate — NOT 0%, which would read as "this app is
    // doing nothing" at the exact moment somebody opened the page to find out.
    expect(first.totals.cpuPercent).toBe(0);
    expect(first.types[0]).toMatchObject({ label: "Renderer", count: 1 });
  });

  test("old samples are dropped, but never the last two", () => {
    const { reader, advance } = readerOver([[metric(1, "Tab", 0)]], { minIntervalMs: 0 });
    for (let tick = 0; tick < 5; tick += 1) {
      reader.summary();
      advance(100_000);
    }
    expect(reader.depth()).toBe(2);
  });

  test("a live-pid reading that throws costs the page column and not the answer", () => {
    let clock = 0;
    const reader = createProcessMetricsReader({
      readMetrics: () => [metric(1, "Tab", clock / 1_000)],
      readLiveProcessIds: () => {
        throw new Error("no window would answer");
      },
      now: () => clock,
    });
    reader.summary();
    clock = 2_000;
    const summary = reader.summary();
    expect(summary.totals.processes).toBe(1);
    expect(Math.round(summary.totals.cpuPercent)).toBe(100);
    // AND NOT "every renderer has no page", which is what defaulting the
    // unreadable list to an empty one would have claimed — the loudest thing
    // this surface can say, asserted from a reading that failed.
    expect(summary.types[0].pagelessCount).toBe(0);
    expect("hostsPage" in summary.busiest[0]).toBe(false);
  });

  test("an empty live-pid list is a claim, and an unreadable one is not", () => {
    const known = summarizeProcessMetrics({ metrics: [metric(1, "Tab", 0)], liveProcessIds: [] });
    expect(known.busiest[0].hostsPage).toBe(false);
    expect(known.types[0].pagelessCount).toBe(1);
    const unknown = summarizeProcessMetrics({ metrics: [metric(1, "Tab", 0)], liveProcessIds: null });
    expect("hostsPage" in unknown.busiest[0]).toBe(false);
    expect(unknown.types[0].pagelessCount).toBe(0);
  });
});
