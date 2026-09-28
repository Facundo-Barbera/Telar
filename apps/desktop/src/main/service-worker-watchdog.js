const HOT_CPU_PERCENT = 80;

const HOT_POLLS_TO_KILL = 2;

const POLL_INTERVAL_MS = 30_000;

const RENDERER_TYPES = new Set(["Tab", "Unknown"]);

function processKey(metric) {
  return `${metric.pid}:${metric.creationTime ?? 0}`;
}

function originOfScope(scope) {
  if (typeof scope !== "string" || !scope) return null;
  let url;
  try {
    url = new URL(scope);
  } catch {
    return null;
  }
  if (url.origin && url.origin !== "null") return url.origin;
  return url.host ? `${url.protocol}//${url.host}` : null;
}

function decideTerminations({
  metrics = [],
  liveProcessIds = [],
  workers = [],
  previous = new Map(),
  thresholdPercent = HOT_CPU_PERCENT,
  pollsToKill = HOT_POLLS_TO_KILL,
} = {}) {
  const live = liveProcessIds instanceof Set ? liveProcessIds : new Set(liveProcessIds);

  const candidates = [...new Set(
    workers
      .filter((worker) => worker && !worker.hasLiveTab)
      .map((worker) => originOfScope(worker.scope) || worker.scriptUrl || null)
      .filter(Boolean),
  )].sort();

  const hot = new Map();
  const kill = [];
  const notices = [];
  for (const metric of metrics) {
    if (!metric || !RENDERER_TYPES.has(metric.type)) continue;

    if (live.has(metric.pid)) continue;
    const percent = Number(metric.cpu?.percentCPUUsage);
    if (!Number.isFinite(percent) || percent < thresholdPercent) continue;
    const key = processKey(metric);
    const polls = (previous.get(key)?.polls ?? 0) + 1;
    const record = { key, pid: metric.pid, creationTime: metric.creationTime ?? 0, percent, polls };

    if (polls >= pollsToKill && candidates.length > 0) {
      kill.push({ ...record, origins: candidates });
      notices.push({ ...record, origins: candidates, killed: true });
      continue;
    }

    if (polls >= pollsToKill) notices.push({ ...record, origins: [], killed: false });
    hot.set(key, record);
  }
  return { kill, hot, candidates, notices };
}

function createServiceWorkerWatchdog({
  readMetrics,
  readLiveProcessIds,
  readWorkers,
  terminate,
  log = () => {},

  onNotice = () => {},
  intervalMs = POLL_INTERVAL_MS,
  thresholdPercent = HOT_CPU_PERCENT,
  pollsToKill = HOT_POLLS_TO_KILL,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let previous = new Map();
  let timer = null;

  function poll() {
    let decision;
    try {
      decision = decideTerminations({
        metrics: readMetrics() || [],
        liveProcessIds: readLiveProcessIds() || [],
        workers: readWorkers() || [],
        previous,
        thresholdPercent,
        pollsToKill,
      });
    } catch (error) {
      log("warn", `browser: service-worker watchdog could not read this poll: ${error && error.message ? error.message : error}`);

      return { kill: [], candidates: [], notices: [] };
    }
    previous = decision.hot;
    for (const victim of decision.kill) {
      const where = victim.origins.join(", ");
      try {
        terminate(victim.pid);
        log("warn", `browser: killed runaway renderer pid ${victim.pid} at ${Math.round(victim.percent)}% CPU over ${victim.polls} polls with no live page — service workers running with no tab: ${where}`);
      } catch (error) {
        log("error", `browser: could not kill runaway renderer pid ${victim.pid} (${where}): ${error && error.message ? error.message : error}`);
      }
    }

    for (const orphan of decision.notices) {
      if (orphan.killed || orphan.polls !== pollsToKill) continue;
      log(
        "warn",
        `browser: renderer pid ${orphan.pid} at ${Math.round(orphan.percent)}% CPU over ${orphan.polls} polls with no live page — not killed, no service worker is running without a tab to name it as`,
      );
    }
    try {
      onNotice(decision.notices);
    } catch {
    }
    return decision;
  }

  return {
    poll,
    start() {
      if (timer !== null) return;
      timer = setTimer(poll, intervalMs);

      timer?.unref?.();
    },

    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      previous = new Map();
    },

    hot() {
      return [...previous.values()];
    },
  };
}

module.exports = {
  HOT_CPU_PERCENT,
  originOfScope,
  decideTerminations,
  createServiceWorkerWatchdog,
};
