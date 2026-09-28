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

const RENDERER_TYPES = new Set(["Tab", "Unknown"]);

const BUSIEST_LIMIT = 6;

const MIN_SAMPLE_INTERVAL_MS = 1_000;

const HISTORY_MS = 180_000;

function processKey(metric) {
  return `${metric.pid}:${metric.creationTime ?? 0}`;
}

function labelForType(type) {
  return PROCESS_TYPE_LABEL[type] || (typeof type === "string" && type ? type : "Unknown");
}

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

function createProcessMetricsReader({
  readMetrics,
  readLiveProcessIds = () => null,
  now = Date.now,
  minIntervalMs = MIN_SAMPLE_INTERVAL_MS,
  historyMs = HISTORY_MS,
} = {}) {
  const samples = [];

  function sample() {
    const at = now();
    const newest = samples[samples.length - 1];

    if (newest && at - newest.at < minIntervalMs) return newest;
    const metrics = readMetrics() || [];
    const taken = { at, metrics, byKey: indexByKey(metrics) };
    samples.push(taken);
    while (samples.length > 2 && at - samples[0].at > historyMs) samples.shift();
    return taken;
  }

  function baselineFor(taken, minWindowMs) {
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const candidate = samples[index];
      if (candidate === taken) continue;
      if (taken.at - candidate.at >= minWindowMs) return candidate;
    }
    return undefined;
  }

  return {
    summary({ minWindowMs = 0 } = {}) {
      const taken = sample();
      const previous = baselineFor(taken, minWindowMs);
      const windowMs = previous ? taken.at - previous.at : 0;
      let liveProcessIds = null;
      try {
        liveProcessIds = readLiveProcessIds() || [];
      } catch {
      }
      return summarizeProcessMetrics({
        metrics: taken.metrics,
        rates: previous ? cpuRates({ before: previous.byKey, after: taken.metrics, elapsedMs: windowMs }) : new Map(),
        liveProcessIds,
        readAt: taken.at,
        windowMs,
      });
    },

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

    depth() {
      return samples.length;
    },
  };
}

module.exports = {
  BUSIEST_LIMIT,
  cpuRates,
  createProcessMetricsReader,
  labelForType,
  summarizeProcessMetrics,
};
