const { describe, expect, test } = require("bun:test");
const {
  HOT_CPU_PERCENT,
  originOfScope,
  decideTerminations,
  createServiceWorkerWatchdog,
} = require("./service-worker-watchdog");

/** The incident's own shape: a renderer with no page, at 100% of a core. */
const runaway = (pid = 318, percent = 100) => ({ pid, type: "Tab", creationTime: 1_000, cpu: { percentCPUUsage: percent } });
const idle = (pid, percent = 0.4) => ({ pid, type: "Tab", creationTime: 1_000, cpu: { percentCPUUsage: percent } });

const worker = (scope, hasLiveTab = false) => ({
  partition: "persist:telar-project-f43a04",
  scope,
  scriptUrl: `${scope}sw.js`,
  versionId: 7,
  hasLiveTab,
});

describe("what a poll decides (#487)", () => {
  test("hot twice with no tab on any running worker's origin → kill, naming the candidates", () => {
    const workers = [worker("https://github.com/"), worker("https://www.youtube.com/")];
    const first = decideTerminations({ metrics: [runaway()], workers });
    expect(first.kill).toEqual([]);
    const second = decideTerminations({ metrics: [runaway()], workers, previous: first.hot });
    expect(second.kill).toHaveLength(1);
    expect(second.kill[0]).toMatchObject({ pid: 318, percent: 100, polls: 2 });
    expect(second.kill[0].origins).toEqual(["https://github.com", "https://www.youtube.com"]);
    // A killed process starts cold rather than being killed again next poll.
    expect(second.hot).toEqual(new Map());
  });

  test("hot once → wait, and carry the heat", () => {
    const first = decideTerminations({ metrics: [runaway()], workers: [worker("https://github.com/")] });
    expect(first.kill).toEqual([]);
    expect(first.hot.size).toBe(1);
    expect([...first.hot.values()][0]).toMatchObject({ pid: 318, polls: 1 });
  });

  test("hot but hosting a live page → left alone, however long it stays hot", () => {
    const workers = [worker("https://github.com/")];
    let previous = new Map();
    for (let poll = 0; poll < 5; poll += 1) {
      const decision = decideTerminations({ metrics: [runaway()], liveProcessIds: [318], workers, previous });
      expect(decision.kill).toEqual([]);
      expect(decision.hot.size).toBe(0); // never even counted as hot
      previous = decision.hot;
    }
  });

  test("hot twice while every running worker's origin still has a tab → left alone", () => {
    const workers = [worker("https://github.com/", true), worker("https://www.youtube.com/", true)];
    const first = decideTerminations({ metrics: [runaway()], workers });
    const second = decideTerminations({ metrics: [runaway()], workers, previous: first.hot });
    expect(second.candidates).toEqual([]);
    expect(second.kill).toEqual([]);
    // The heat is still carried: a tab closing next poll acts immediately.
    expect(second.hot.size).toBe(1);
    const third = decideTerminations({ metrics: [runaway()], workers: [worker("https://github.com/")], previous: second.hot });
    expect(third.kill).toHaveLength(1);
    expect(third.kill[0].polls).toBe(3);
  });

  test("a quiet renderer is never a candidate, and neither is a hot non-renderer", () => {
    const workers = [worker("https://github.com/")];
    const first = decideTerminations({ metrics: [idle(318)], workers });
    expect(first.hot.size).toBe(0);
    const gpu = { pid: 9, type: "GPU", creationTime: 1, cpu: { percentCPUUsage: 140 } };
    const browser = { pid: 1, type: "Browser", creationTime: 1, cpu: { percentCPUUsage: 99 } };
    const utility = { pid: 4, type: "Utility", creationTime: 1, cpu: { percentCPUUsage: 99 } };
    const second = decideTerminations({ metrics: [gpu, browser, utility], workers });
    expect(second.hot.size).toBe(0);
    expect(second.kill).toEqual([]);
  });

  test("a reused pid starts cold — heat belongs to a process, not a number", () => {
    const workers = [worker("https://github.com/")];
    const first = decideTerminations({ metrics: [runaway()], workers });
    const reborn = { ...runaway(), creationTime: 2_000 };
    const second = decideTerminations({ metrics: [reborn], workers, previous: first.hot });
    expect(second.kill).toEqual([]);
    expect([...second.hot.values()][0]).toMatchObject({ polls: 1, creationTime: 2_000 });
  });

  test("a metric with no usable CPU reading is not treated as hot", () => {
    const workers = [worker("https://github.com/")];
    const metrics = [
      { pid: 5, type: "Tab", creationTime: 1, cpu: {} },
      { pid: 6, type: "Tab", creationTime: 1 },
      { pid: 7, type: "Tab", creationTime: 1, cpu: { percentCPUUsage: Number.NaN } },
    ];
    expect(decideTerminations({ metrics, workers }).hot.size).toBe(0);
  });

  test("the threshold is the documented one, and it is a floor not a ceiling", () => {
    const workers = [worker("https://github.com/")];
    const at = decideTerminations({ metrics: [runaway(318, HOT_CPU_PERCENT)], workers });
    expect(at.hot.size).toBe(1);
    const under = decideTerminations({ metrics: [runaway(318, HOT_CPU_PERCENT - 0.1)], workers });
    expect(under.hot.size).toBe(0);
  });

  test("the extension's own worker is named as a candidate like any other", () => {
    const workers = [worker("chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/")];
    const first = decideTerminations({ metrics: [runaway()], workers });
    const second = decideTerminations({ metrics: [runaway()], workers, previous: first.hot });
    expect(second.kill[0].origins).toEqual(["chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa"]);
  });
});

describe("a scope's origin", () => {
  test("is the origin, and an unparseable scope answers null rather than guessing", () => {
    expect(originOfScope("https://github.com/assets/")).toBe("https://github.com");
    expect(originOfScope("chrome-extension://abc/")).toBe("chrome-extension://abc");
    expect(originOfScope("not a url")).toBeNull();
    expect(originOfScope("")).toBeNull();
    expect(originOfScope(undefined)).toBeNull();
  });
});

describe("the poll loop", () => {
  function harness(overrides = {}) {
    const killed = [];
    const lines = [];
    let metrics = [runaway()];
    let liveProcessIds = [];
    let workers = [worker("https://github.com/")];
    const watchdog = createServiceWorkerWatchdog({
      readMetrics: () => metrics,
      readLiveProcessIds: () => liveProcessIds,
      readWorkers: () => workers,
      terminate: (pid) => killed.push(pid),
      log: (level, message) => lines.push(`${level} ${message}`),
      setTimer: () => null,
      clearTimer: () => {},
      ...overrides,
    });
    return {
      watchdog,
      killed,
      lines,
      set metrics(next) { metrics = next; },
      set liveProcessIds(next) { liveProcessIds = next; },
      set workers(next) { workers = next; },
    };
  }

  test("kills on the second hot poll and logs the pid, the load and the candidate origins", () => {
    const h = harness();
    h.watchdog.poll();
    expect(h.killed).toEqual([]);
    expect(h.watchdog.hot()).toHaveLength(1);
    h.watchdog.poll();
    expect(h.killed).toEqual([318]);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("warn");
    expect(h.lines[0]).toContain("pid 318");
    expect(h.lines[0]).toContain("100% CPU");
    expect(h.lines[0]).toContain("https://github.com");
  });

  test("a kill that throws is logged, not raised", () => {
    const h = harness({ terminate: () => { throw new Error("ESRCH"); } });
    h.watchdog.poll();
    expect(() => h.watchdog.poll()).not.toThrow();
    expect(h.lines.at(-1)).toContain("error");
    expect(h.lines.at(-1)).toContain("ESRCH");
  });

  test("a reading that throws costs the poll, not the watchdog", () => {
    let fail = true;
    const h = harness({ readMetrics: () => { if (fail) throw new Error("no metrics"); return [runaway()]; } });
    expect(h.watchdog.poll().kill).toEqual([]);
    expect(h.lines.at(-1)).toContain("could not read this poll");
    fail = false;
    h.watchdog.poll();
    h.watchdog.poll();
    expect(h.killed).toEqual([318]);
  });

  test("start is idempotent and the timer never holds the app open", () => {
    let created = 0;
    let cleared = 0;
    let unrefs = 0;
    const h = harness({
      setTimer: () => { created += 1; return { unref: () => { unrefs += 1; } }; },
      clearTimer: () => { cleared += 1; },
    });
    h.watchdog.start();
    h.watchdog.start();
    expect(created).toBe(1);
    expect(unrefs).toBe(1);
    h.watchdog.stop();
    h.watchdog.stop();
    expect(cleared).toBe(1);
  });

  test("stopping forgets the heat, so a restart does not kill on its first poll", () => {
    const h = harness();
    h.watchdog.poll();
    h.watchdog.stop();
    h.watchdog.poll();
    expect(h.killed).toEqual([]);
  });
});
