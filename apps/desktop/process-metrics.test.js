const { describe, expect, test } = require("bun:test");
const {
  BUSIEST_LIMIT,
  cpuRates,
  createProcessMetricsReader,
  labelForType,
  summarizeProcessMetrics,
} = require("./process-metrics");

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

      ["Renderer", 2, 98],
      ["GPU", 1, 8],
      ["Main", 1, 4],
    ]);
    expect(summary.totals).toEqual({ cpuPercent: 110, memoryKb: 400_000, processes: 4 });
    expect(summary.windowMs).toBe(2_000);

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

    expect(summary.busiest[0]).toMatchObject({ pid: 7, label: "Renderer", cpuPercent: 96, hostsPage: false });
    expect(summary.busiest.find((entry) => entry.pid === 2)).toMatchObject({ hostsPage: true });

    const utility = summary.busiest.find((entry) => entry.pid === 4);
    expect(utility.name).toBe("Network Service");
    expect("hostsPage" in utility).toBe(false);
    expect(summary.types.find((entry) => entry.type === "Utility").pagelessCount).toBe(0);
  });

  test("the busiest list is capped and ordered, and ties do not shuffle", () => {
    const metrics = Array.from({ length: BUSIEST_LIMIT + 4 }, (_, index) => metric(index + 1, "Tab", 0));

    const summary = summarizeProcessMetrics({ metrics, rates: new Map(), readAt: 1, windowMs: 1_000 });
    expect(summary.busiest).toHaveLength(BUSIEST_LIMIT);
    expect(summary.busiest.map((entry) => entry.pid)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("the answer has to survive the trip out of the main process", () => {
  test("the summary is structured-cloneable, because both its consumers are across a boundary", () => {
    const summary = summarizeProcessMetrics({
      metrics: [metric(1, "Browser", 0), metric(2, "Tab", 0), metric(3, "Utility", 0, { name: "Network Service" })],
      rates: new Map([["1:1000", 4], ["2:1000", 96]]),
      liveProcessIds: [2],
      readAt: 5_000,
      windowMs: 2_000,
    });

    const cloned = structuredClone(summary);
    expect(cloned).toEqual(summary);

    for (const row of summary.busiest) expect(typeof row.memoryKb).toBe("number");
    for (const entry of summary.types) expect(typeof entry.memoryKb).toBe("number");
  });

  test("a reader's live answer clones too, not just a hand-built fold", () => {
    const { reader, advance } = readerOver([[metric(1, "Tab", 0)], [metric(1, "Tab", 1)]], { minIntervalMs: 0 });
    reader.summary();
    advance(1_000);
    const live = reader.summary();
    expect(structuredClone(live)).toEqual(live);
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
    const series = [];
    for (let poll = 0; poll <= 20; poll += 1) {
      const spike = poll === 10 ? 1 : 0;
      series.push([
        metric(1, "Tab", poll * 2),
        metric(2, "Tab", poll >= 10 ? spike + (poll > 10 ? 1 : 0) : 0),
      ]);
    }
    const { reader, advance } = readerOver(series, { minIntervalMs: 1_000 });

    for (let tick = 0; tick < 15; tick += 1) {
      reader.summary();
      advance(2_000);
    }
    const watchdogView = reader.metricsForWatchdog({ minWindowMs: 25_000 });
    const byPid = new Map(watchdogView.map((entry) => [entry.pid, entry.cpu.percentCPUUsage]));

    expect(Math.round(byPid.get(1))).toBe(100);

    expect(byPid.get(2)).toBeLessThan(10);
  });

  test("with nothing old enough to compare against, the watchdog reads zero rather than a guess", () => {
    const { reader, advance } = readerOver([[metric(1, "Tab", 0, { percent: 99 })], [metric(1, "Tab", 30, { percent: 99 })]]);
    reader.summary();
    advance(3_000);

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
