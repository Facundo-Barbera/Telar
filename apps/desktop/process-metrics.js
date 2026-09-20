/**
 * WHAT THIS APP'S PROCESSES ARE DOING RIGHT NOW — issue #488, part 4 of #487.
 *
 * #487's watchdog kills a renderer that burns a core with no page and writes a
 * line to the shell log. Both of those happen where nobody is looking: the kill
 * is silent by design and the log is a file. The incident itself was found with
 * Activity Monitor and `sample`, an hour in, and the whole point of this module
 * is that the NEXT one is legible from inside the app.
 *
 * ONE SAMPLER, AND THAT IS THE LOAD-BEARING DECISION HERE.
 * `ProcessMetric.cpu.percentCPUUsage` is documented as "percentage of CPU used
 * since the last call to the API that returned this object" — the baseline is
 * per API, not per caller, so two independent callers of `app.getAppMetrics()`
 * silently steal each other's window. A UI polling every two seconds would
 * therefore have quietly turned the watchdog's thirty-second average into a
 * two-second one, making it fire on bursts it was explicitly designed to sit
 * through (`service-worker-watchdog.js`: "one poll is a spike… two is a loop").
 * That is a way to break a landed kill path by adding a read-only page to it,
 * so there is exactly one caller of `app.getAppMetrics()` in the shell and both
 * consumers read its samples.
 *
 * RATES COME FROM `cumulativeCPUUsage`, NOT `percentCPUUsage`. Cumulative CPU
 * seconds since process start is an ABSOLUTE reading, so a rate computed from
 * two of them is over a window the caller chose rather than over whatever gap
 * happened to fall between two calls. That is what lets `metricsForWatchdog`
 * keep its thirty-second window while the page in front of somebody refreshes
 * every two seconds. The field is optional in Electron's own typings, so a
 * platform that omits it falls back to `percentCPUUsage` — noisier, and the
 * reason the answer carries the window it was measured over instead of
 * implying one.
 *
 * KEYED BY pid AND creationTime, like the watchdog and for the same reason: a
 * recycled pid must not inherit the dead process's CPU seconds, which would
 * read as a huge negative or a huge positive depending on which way it went.
 *
 * Pure — no electron, injected clock and reader — so every state below is
 * reachable in process-metrics.test.js in microseconds.
 */

/** What Electron's process types are called in a sentence a person reads.
 *  `Tab` is Chromium's name for any renderer, including the service-worker
 *  ones that have no tab at all (#487), so it is NOT called "Tab" here. */
const PROCESS_TYPE_LABEL = {
  Browser: "Main",
  Tab: "Renderer",
  GPU: "GPU",
  Utility: "Utility",
  Zygote: "Zygote",
  "Sandbox helper": "Sandbox helper",
  "Pepper Plugin": "Plugin",
  "Pepper Plugin Broker": "Plugin broker",
  Unknown: "Unknown",
};

/** The `ProcessMetric.type` values that host web content — the same set the
 *  watchdog decides on, because "a renderer with no page" is only a meaningful
 *  sentence about these. */
const RENDERER_TYPES = new Set(["Tab", "Unknown"]);

/** How many processes the busiest list names. Enough to show a runaway and its
 *  neighbours; not so many that the section becomes a process table nobody
 *  reads. */
const BUSIEST_LIMIT = 6;

/** How long one `app.getAppMetrics()` answer is reused. A page refreshing
 *  faster than this gets the same sample rather than a fresh call — which is
 *  the throttle that keeps a mounted UI from calling the API in a tight loop. */
const MIN_SAMPLE_INTERVAL_MS = 1_000;

/** How far back samples are kept, so a caller can ask for a window that long.
 *  Comfortably over the watchdog's thirty seconds. */
const HISTORY_MS = 180_000;

function processKey(metric) {
  return `${metric.pid}:${metric.creationTime ?? 0}`;
}

function labelForType(type) {
  return PROCESS_TYPE_LABEL[type] || (typeof type === "string" && type ? type : "Unknown");
}

/**
 * The kilobytes a process has pinned in physical RAM, or 0 for a metric that
 * did not report it. `workingSetSize` is already in KB (Electron's MemoryInfo).
 *
 * NOT CALLED `memoryKb`, and that is a scar rather than a style choice: it was,
 * and the fold below built its rows with the shorthand `{ memoryKb }` while the
 * local holding the value was called `memory`. The shorthand resolved to THIS
 * FUNCTION, so every row carried a function where a number belonged — which
 * structured clone refuses outright, so the IPC bridge threw and the whole
 * surface was dead inside the shell. Nothing caught it until a real Electron
 * tried to serialise the payload. A name that cannot collide with the field it
 * computes is the cheap half of not repeating that.
 */
function memoryKbOf(metric) {
  const value = Number(metric?.memory?.workingSetSize);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function indexByKey(metrics) {
  const byKey = new Map();
  for (const metric of metrics || []) {
    if (!metric || !Number.isFinite(Number(metric.pid))) continue;
    byKey.set(processKey(metric), metric);
  }
  return byKey;
}

/**
 * Per-process CPU as a percentage of ONE core (so two busy cores read 200),
 * measured between two samples.
 *
 * `elapsedMs` is wall time between them. Cumulative CPU seconds are preferred;
 * a process that reports none — or one that is NEW since the baseline, and so
 * has nothing to subtract — falls back to its own `percentCPUUsage`, whose
 * window is whatever gap the API last saw.
 */
function cpuRates({ before, after, elapsedMs }) {
  const baseline = before instanceof Map ? before : indexByKey(before);
  const rates = new Map();
  for (const metric of after || []) {
    if (!metric || !Number.isFinite(Number(metric.pid))) continue;
    const key = processKey(metric);
    const previous = baseline.get(key);
    const beforeSeconds = Number(previous?.cpu?.cumulativeCPUUsage);
    const afterSeconds = Number(metric.cpu?.cumulativeCPUUsage);
    if (
      elapsedMs > 0 &&
      Number.isFinite(beforeSeconds) &&
      Number.isFinite(afterSeconds) &&
      afterSeconds >= beforeSeconds
    ) {
      rates.set(key, ((afterSeconds - beforeSeconds) * 1000 * 100) / elapsedMs);
      continue;
    }
    const reported = Number(metric.cpu?.percentCPUUsage);
    rates.set(key, Number.isFinite(reported) && reported > 0 ? reported : 0);
  }
  return rates;
}

/**
 * ONE POLL, FOLDED FOR SOMEBODY LOOKING AT IT.
 *
 * `liveProcessIds` are the OS pids hosting a WebContents anybody can see — the
 * shell's windows, its tabs, its DevTools views. A renderer that is not one of
 * them is showing nothing, which is exactly the thing #487 turned out to be and
 * exactly the thing per-type totals alone would hide: nine renderers at 96% and
 * nine renderers of which ONE is at 96% with no page are the same row otherwise.
 *
 * `null` THERE MEANS NOBODY COULD ANSWER, and it is not the same as an empty
 * list. An empty list says every renderer is showing nothing — the strongest
 * claim this fold can make — so a failed reading that defaulted to it would
 * accuse the whole app of being the incident.
 *
 * Returns per-type totals (what the issue asked for), the busiest individual
 * processes (what makes a runaway nameable), and the window the CPU figures
 * were averaged over — absent windows are reported, never implied.
 */
function summarizeProcessMetrics({ metrics = [], rates = new Map(), liveProcessIds = null, readAt = 0, windowMs = 0 } = {}) {
  const live = liveProcessIds === null || liveProcessIds === undefined
    ? null
    : liveProcessIds instanceof Set
      ? liveProcessIds
      : new Set(liveProcessIds);
  const types = new Map();
  const processes = [];
  let totalCpuPercent = 0;
  let totalMemoryKb = 0;

  for (const metric of metrics) {
    if (!metric || !Number.isFinite(Number(metric.pid))) continue;
    const key = processKey(metric);
    const type = typeof metric.type === "string" && metric.type ? metric.type : "Unknown";
    const cpuPercent = Number(rates.get(key)) || 0;
    const memory = memoryKbOf(metric);
    // "Hosts a page" is only a claim we can make about renderers. For a GPU or
    // a utility process it is not false, it is meaningless, and a column of
    // "no page" against the network service would read as an accusation.
    const hostsPage = live !== null && RENDERER_TYPES.has(type) ? live.has(metric.pid) : undefined;

    totalCpuPercent += cpuPercent;
    totalMemoryKb += memory;
    const bucket = types.get(type) || { type, label: labelForType(type), count: 0, cpuPercent: 0, memoryKb: 0, pagelessCount: 0 };
    bucket.count += 1;
    bucket.cpuPercent += cpuPercent;
    bucket.memoryKb += memory;
    if (hostsPage === false) bucket.pagelessCount += 1;
    types.set(type, bucket);

    processes.push({
      pid: metric.pid,
      type,
      label: labelForType(type),
      cpuPercent,
      memoryKb: memory,
      ...(typeof metric.name === "string" && metric.name ? { name: metric.name } : {}),
      ...(typeof metric.serviceName === "string" && metric.serviceName ? { serviceName: metric.serviceName } : {}),
      ...(hostsPage === undefined ? {} : { hostsPage }),
    });
  }

  // Busiest first, and ties broken by pid so two idle processes do not swap
  // places every second in front of somebody trying to read them.
  const byCpu = (a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid;
  return {
    readAt,
    windowMs,
    totals: {
      cpuPercent: totalCpuPercent,
      memoryKb: totalMemoryKb,
      processes: processes.length,
    },
    types: [...types.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || a.label.localeCompare(b.label)),
    busiest: [...processes].sort(byCpu).slice(0, BUSIEST_LIMIT),
  };
}

/**
 * THE SHELL'S ONE CALLER OF `app.getAppMetrics()`.
 *
 * `readMetrics` and `readLiveProcessIds` are the shell's readings; `now` is
 * injectable so the tests can stand a minute of samples up in no time at all.
 *
 * A METRICS READ THAT THROWS PROPAGATES, deliberately. Both consumers already
 * answer over a boundary that carries failure — an IPC invoke that rejects, an
 * HTTP route that 400s — and a summary that swallowed the error would have to
 * report an app with no processes in it, which is a lie rather than a gap. The
 * one reading that IS swallowed is `readLiveProcessIds`, because losing it
 * costs one column and not the answer.
 */
function createProcessMetricsReader({
  readMetrics,
  readLiveProcessIds = () => null,
  now = Date.now,
  minIntervalMs = MIN_SAMPLE_INTERVAL_MS,
  historyMs = HISTORY_MS,
} = {}) {
  /** `{ at, metrics, byKey }`, oldest first. */
  const samples = [];

  function sample() {
    const at = now();
    const newest = samples[samples.length - 1];
    // THE THROTTLE IS WHY A PAGE MAY POLL FREELY. Reusing the last answer costs
    // nothing and, more to the point, does not move the API's own baseline.
    if (newest && at - newest.at < minIntervalMs) return newest;
    const metrics = readMetrics() || [];
    const taken = { at, metrics, byKey: indexByKey(metrics) };
    samples.push(taken);
    while (samples.length > 2 && at - samples[0].at > historyMs) samples.shift();
    return taken;
  }

  /** The newest sample at least `minWindowMs` older than `taken`, or undefined
   *  when nothing goes back that far yet. */
  function baselineFor(taken, minWindowMs) {
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const candidate = samples[index];
      if (candidate === taken) continue;
      if (taken.at - candidate.at >= minWindowMs) return candidate;
    }
    return undefined;
  }

  return {
    /**
     * What a person is shown: per-type totals over the shortest window there
     * is, which is the most responsive honest answer. `windowMs: 0` means there
     * is no baseline yet — one sample cannot be a rate, and reporting 0% would
     * claim an idle app rather than an unmeasured one.
     */
    summary({ minWindowMs = 0 } = {}) {
      const taken = sample();
      const previous = baselineFor(taken, minWindowMs);
      const windowMs = previous ? taken.at - previous.at : 0;
      let liveProcessIds = null;
      try {
        liveProcessIds = readLiveProcessIds() || [];
      } catch {
        // One reading's worth of blindness about which renderers hold a page —
        // reported as UNKNOWN rather than as "none of them do", which is the
        // difference between a missing column and an app-wide accusation.
      }
      return summarizeProcessMetrics({
        metrics: taken.metrics,
        rates: previous ? cpuRates({ before: previous.byKey, after: taken.metrics, elapsedMs: windowMs }) : new Map(),
        liveProcessIds,
        readAt: taken.at,
        windowMs,
      });
    },

    /**
     * THE WATCHDOG'S READING, shaped exactly like `app.getAppMetrics()` so
     * `service-worker-watchdog.js` needs no knowledge of any of this — its
     * decision logic is #487's and is not touched here.
     *
     * The CPU figure is rewritten to a rate over AT LEAST `minWindowMs`, which
     * is what preserves "sustained for two polls" now that a page may be
     * sampling in between. With no baseline that old yet, every process reads
     * 0 — cold, and so not a kill — which is the same thing Electron's own
     * "first call returns 0" already did.
     */
    metricsForWatchdog({ minWindowMs = 25_000 } = {}) {
      const taken = sample();
      const previous = baselineFor(taken, minWindowMs);
      if (!previous) return taken.metrics.map((metric) => ({ ...metric, cpu: { ...metric.cpu, percentCPUUsage: 0 } }));
      const rates = cpuRates({ before: previous.byKey, after: taken.metrics, elapsedMs: taken.at - previous.at });
      return taken.metrics.map((metric) => ({
        ...metric,
        cpu: { ...metric.cpu, percentCPUUsage: Number(rates.get(processKey(metric))) || 0 },
      }));
    },

    /** How many samples are held. Diagnostics only. */
    depth() {
      return samples.length;
    },
  };
}

module.exports = {
  BUSIEST_LIMIT,
  HISTORY_MS,
  MIN_SAMPLE_INTERVAL_MS,
  PROCESS_TYPE_LABEL,
  RENDERER_TYPES,
  cpuRates,
  createProcessMetricsReader,
  labelForType,
  summarizeProcessMetrics,
};
