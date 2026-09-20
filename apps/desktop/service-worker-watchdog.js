/**
 * THE RUNAWAY RENDERER'S CLOCK — the testable half of the fix for issue #487.
 *
 * WHAT HAPPENED. On nightly .9 a `Telar Helper (Renderer)` launched with
 * `--service-worker-preload` sat at 100% of one core for fifty minutes with no
 * tab, no window and no visible page. Every busy sample was inside V8's
 * optimising compiler, so it was a JS loop being re-optimised rather than I/O.
 * `kill -9` on that one renderer dropped the app from ~190% CPU to ~60%
 * instantly and nothing visible changed — a service worker whose pages had all
 * been closed half an hour earlier, still running, because that is what
 * service workers do.
 *
 * WHAT ELECTRON 43 ACTUALLY GIVES US, which is less than the issue assumed:
 *
 *   · `app.getAppMetrics()` reports per-process CPU, but `ProcessMetric.type`
 *     has no `serviceWorker` value — the union is Browser/Tab/Utility/Zygote/
 *     Sandbox helper/GPU/Pepper Plugin/Unknown. A service-worker renderer
 *     reports as `Tab`, and the metric carries no origin and no URL.
 *   · `ServiceWorkerInfo.renderProcessId` is Chromium's VIRTUAL id (the one
 *     `webContents.getProcessId()` uses), documented as "not an OS level PID".
 *     A service-worker-only process hosts no WebContents, so there is nothing
 *     to join it to a `getAppMetrics()` pid through.
 *   · `session.serviceWorkers` has getAllRunning, getInfoFromVersionID,
 *     getWorkerFromVersionID and startWorkerForScope. There is no stopWorker
 *     and no stopAllWorkers.
 *
 * SO THE SIGNAL IS "AN ORPHAN RENDERER", NOT "THIS ORIGIN'S WORKER". What can
 * be established exactly is which OS pids host a live WebContents — every tab,
 * window and DevTools view the shell owns. A renderer-type process that is
 * NOT one of those is hosting no page anybody can see, and a renderer hosting
 * no page has no business burning a core. That is the whole decision.
 *
 * IT REFUSES TO GUESS THE ORIGIN, AND SAYS SO. The running-worker inventory is
 * carried through to the log so the line names the candidates — the origins
 * with a running worker and no live tab — rather than asserting one. And it
 * will not kill at all while no such candidate exists: a hot orphan with every
 * worker's origin still on screen is something else, and something else is not
 * ours to kill.
 *
 * TWO CONSECUTIVE POLLS, keyed by pid AND creationTime so a recycled pid never
 * inherits the last one's heat. Terminating a service worker is not a loss:
 * MV3 workers are designed to be killed when idle and restarted on the next
 * event, which is exactly what Chrome itself does after thirty seconds.
 *
 * Everything here is pure — no electron, injectable clock — so the states that
 * take an hour in life take microseconds in service-worker-watchdog.test.js.
 * main.js owns the consequences (reading the metrics, killing the pid, writing
 * the line).
 */

/** A renderer at or above this much of one core is not idling. The incident
 *  sat at 100 for fifty minutes; a page doing real work peaks well below this
 *  and, more to the point, a page has a live WebContents and never reaches
 *  this decision at all. */
const HOT_CPU_PERCENT = 80;

/** How many consecutive polls a process must stay hot before it is killed.
 *  One poll is a spike — a worker waking for a push, a cache sweep. Two is a
 *  loop. */
const HOT_POLLS_TO_KILL = 2;

/** Every thirty seconds, so two polls is a minute of sustained burn before
 *  anything dies. */
const POLL_INTERVAL_MS = 30_000;

/** The `ProcessMetric.type` values that host web content. A service-worker
 *  renderer reports as `Tab`; `Unknown` is included because a renderer
 *  Chromium could not classify is still a renderer. */
const RENDERER_TYPES = new Set(["Tab", "Unknown"]);

/** A pid is the same process across polls only if it was created at the same
 *  moment — pids are reused, and a reused one must start cold. */
function processKey(metric) {
  return `${metric.pid}:${metric.creationTime ?? 0}`;
}

/**
 * The origin a worker's scope belongs to, or null for a scope that will not
 * parse. Worker scopes are absolute URLs.
 *
 * `URL.origin` IS NOT ENOUGH: `chrome-extension:` is not one of the WHATWG
 * "special" schemes, so `new URL("chrome-extension://abc/").origin` is the
 * literal string "null" — and a log line reading "service workers running with
 * no tab: null" names nothing. Scheme and host are composed by hand for those.
 */
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

/**
 * WHAT TO KILL RIGHT NOW, given one poll's readings.
 *
 *   · `metrics`  — `app.getAppMetrics()`, or anything shaped like it.
 *   · `liveProcessIds` — the OS pids hosting a live WebContents. Anything in
 *     here is somebody's page and is never a candidate, however hot it is.
 *   · `workers`  — every running service worker the shell knows about:
 *     `{ partition, scope, scriptUrl, versionId, hasLiveTab }`. `hasLiveTab`
 *     is the caller's answer to "is a tab of this origin open in this
 *     partition", because only the manager knows its tabs.
 *   · `previous` — the `hot` map this function returned last poll.
 *
 * Returns `{ kill, hot, candidates, notices }`: the processes to terminate (each
 * with the origins that could have been it), the heat to carry into the next
 * poll, the candidate origins the decision was made against, and — issue #787 —
 * what a person would want to be told about this poll.
 *
 * `notices` IS THE SAME EVIDENCE, NOT A SECOND OPINION. It is derived from the
 * decision already being made here rather than from a second threshold, so
 * there is nothing extra to compute, nothing to tune apart, and no way for the
 * thing a person is shown to disagree with the thing that gets killed.
 *
 * IT COVERS THE KILL THIS FUNCTION REFUSES, which is the case #787 names as the
 * worst one: with no candidate origin to name, a sustained-hot page-less
 * renderer is deliberately NOT killed — so it can persist indefinitely, and
 * before this it did so with nothing said anywhere. That notice carries
 * `killed: false` and an empty `origins`.
 */
function decideTerminations({
  metrics = [],
  liveProcessIds = [],
  workers = [],
  previous = new Map(),
  thresholdPercent = HOT_CPU_PERCENT,
  pollsToKill = HOT_POLLS_TO_KILL,
} = {}) {
  const live = liveProcessIds instanceof Set ? liveProcessIds : new Set(liveProcessIds);
  // The origins with a worker running and no page of their own on screen —
  // what a hot orphan renderer could plausibly BE. Ordered and de-duplicated
  // so the log line is stable between polls.
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
    // A renderer with a page in it is the person's page. Not ours.
    if (live.has(metric.pid)) continue;
    const percent = Number(metric.cpu?.percentCPUUsage);
    if (!Number.isFinite(percent) || percent < thresholdPercent) continue;
    const key = processKey(metric);
    const polls = (previous.get(key)?.polls ?? 0) + 1;
    const record = { key, pid: metric.pid, creationTime: metric.creationTime ?? 0, percent, polls };
    // NOTHING TO NAME IT AS MEANS NOTHING TO KILL. Heat is still carried, so
    // a candidate appearing next poll acts on a process already known hot.
    if (polls >= pollsToKill && candidates.length > 0) {
      kill.push({ ...record, origins: candidates });
      notices.push({ ...record, origins: candidates, killed: true });
      continue; // killed processes start cold if their pid comes back
    }
    /**
     * SUSTAINED, PAGE-LESS, AND STAYING. Same evidence, and the kill above
     * refused it only because no origin could be named. A notice every poll
     * rather than once, deliberately: what a person is shown is the CURRENT
     * state of the app, so a surface that went quiet while the core was still
     * burning would be worse than one that never spoke.
     */
    if (polls >= pollsToKill) notices.push({ ...record, origins: [], killed: false });
    hot.set(key, record);
  }
  return { kill, hot, candidates, notices };
}

/**
 * The poll loop around `decideTerminations`. Everything it touches is
 * injected: `readMetrics` (app.getAppMetrics), `readLiveProcessIds`,
 * `readWorkers`, `terminate` (process.kill), `log`, and the timers.
 *
 * A POLL THAT THROWS IS A POLL THAT DID NOT HAPPEN, never a dead watchdog:
 * every reading is the shell's, and a shell that cannot answer one of them is
 * a browser missing a diagnostic rather than a browser that stops working.
 */
function createServiceWorkerWatchdog({
  readMetrics,
  readLiveProcessIds,
  readWorkers,
  terminate,
  log = () => {},
  /**
   * WHAT THIS POLL WOULD TELL SOMEBODY — issue #787. Called once per poll with
   * the poll's `notices`, INCLUDING THE EMPTY ARRAY: "nothing is hot" is the
   * answer that takes an indicator back down, and a callback that only fired on
   * trouble would leave one lit after the trouble ended.
   *
   * It never affects the kill. A throw is swallowed for `poll`'s own reason —
   * a shell that cannot draw a warning is a browser missing a diagnostic, not a
   * browser whose watchdog stops working.
   */
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
      // A POLL THAT DID NOT HAPPEN SAYS NOTHING, rather than saying "all clear".
      // Reporting an empty list here would clear a warning on the strength of a
      // reading that failed — the one direction this surface must not get wrong.
      return { kill: [], candidates: [], notices: [] };
    }
    previous = decision.hot;
    for (const victim of decision.kill) {
      // THE ORIGINS ARE CANDIDATES, NOT AN IDENTIFICATION. Electron gives a
      // service-worker renderer no origin (see the header); one of these was
      // it.
      const where = victim.origins.join(", ");
      try {
        terminate(victim.pid);
        log("warn", `browser: killed runaway renderer pid ${victim.pid} at ${Math.round(victim.percent)}% CPU over ${victim.polls} polls with no live page — service workers running with no tab: ${where}`);
      } catch (error) {
        log("error", `browser: could not kill runaway renderer pid ${victim.pid} (${where}): ${error && error.message ? error.message : error}`);
      }
    }
    /**
     * AND THE ONE LINE THAT NEVER REACHED A PERSON — issue #787. The kill is
     * silent by design and the log is a file; both of the incidents behind #487
     * and #488 were found with Activity Monitor, fifty minutes and an hour in.
     * This is the same decision, handed to whoever wants to draw it.
     */
    for (const orphan of decision.notices) {
      // ONCE PER PROCESS, not once per poll. The notices carry a persistent
      // orphan every poll on purpose — a live indicator must not go quiet while
      // the core is still burning — but a log line repeating itself every
      // thirty seconds for an hour is how a log stops being read.
      if (orphan.killed || orphan.polls !== pollsToKill) continue;
      log(
        "warn",
        `browser: renderer pid ${orphan.pid} at ${Math.round(orphan.percent)}% CPU over ${orphan.polls} polls with no live page — not killed, no service worker is running without a tab to name it as`,
      );
    }
    try {
      onNotice(decision.notices);
    } catch {
      /* drawing a warning must never be the reason the watchdog stops */
    }
    return decision;
  }

  return {
    poll,
    start() {
      if (timer !== null) return;
      timer = setTimer(poll, intervalMs);
      // A watchdog must never be the reason the app stays alive.
      timer?.unref?.();
    },
    /** Stop polling and forget the heat. The heat goes UNCONDITIONALLY, even
     *  if no timer was ever armed: a watchdog that was told to stop must not
     *  kill something on the strength of a poll from before it was. */
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      previous = new Map();
    },
    /** What the last poll is carrying into the next one. Diagnostics only. */
    hot() {
      return [...previous.values()];
    },
  };
}

module.exports = {
  HOT_CPU_PERCENT,
  HOT_POLLS_TO_KILL,
  POLL_INTERVAL_MS,
  RENDERER_TYPES,
  originOfScope,
  decideTerminations,
  createServiceWorkerWatchdog,
};
