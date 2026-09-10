/**
 * A browser fixture for the REAL `RunPanel`, on a controllable transport.
 *
 * Not a test double of the panel: it imports the production component and hands
 * it an injected `RunApi` whose every call is counted and whose every answer is
 * held until this page releases it. That is what makes the two questions the
 * unit tests cannot reach observable — whether a MOUNTED panel drops answers
 * that arrive after its host changed, and whether it stops polling when the
 * shell hides it.
 *
 * THE PANEL IS DELIBERATELY NOT KEYED HERE. The cockpit keys it by host and
 * session, which would remount it on a host change and hide the very guard
 * under test; this page changes the prop in place instead, so what is exercised
 * is `runIdentity`/`stillOurs` inside the component.
 *
 * EVERY ANSWER IS MARKED WITH ITS HOST (`A-SERVER`, `from-A`), and the verdict
 * strip reads the panel's own DOM: if text belonging to a host the panel is no
 * longer pinned to ever appears, that is a leak, and it says so in red.
 */
import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RunPanel } from "../../components/run/run-panel";
import type { RunApi } from "../../lib/run/api";
import type { RunConfigurationView, RunOutputAnswer, RunStatusAnswer, RunView } from "../../lib/run/types";

const SESSION = "sess_shared";
/** The panel's container, addressed by id so helpers need no ref. */
const PANEL_ID = "run-panel-host";
type Host = "host_a" | "host_b";
const MARK: Record<Host, string> = { host_a: "A", host_b: "B" };

// ── the controllable transport ────────────────────────────────────────────

type Call = { id: number; host: Host; verb: string; state: "held" | "answered" | "dropped" };
let nextId = 1;

/** One parked answer, with the payload it will deliver when released. */
type Parked = { call: Call; deliver: () => void; fail: (reason: string) => void };

type Ledger = {
  calls: Call[];
  parked: Parked[];
  /** Per host+verb counts, which is how "the poll stopped" is seen. */
  counts: Record<string, number>;
  /**
   * A TIMESTAMPED LOG, because a counter alone cannot show a pause. Every
   * request and every visibility change is stamped in ms since the scenario
   * started, so a hidden window is a gap in this list rather than something a
   * reader has to have been watching for.
   */
  log: string[];
  startedAt: number;
};

const ledger: Ledger = { calls: [], parked: [], counts: {}, log: [], startedAt: Date.now() };

const stamp = () => String(Date.now() - ledger.startedAt).padStart(5, " ");
function note(line: string) {
  ledger.log.push(`${stamp()}ms  ${line}`);
  if (ledger.log.length > 40) ledger.log.shift();
}
let notify = () => {};
const announce = () => notify();

function view(host: Host, status: RunView["status"] = "running"): RunView {
  return {
    runId: `run_${MARK[host]}`,
    projectId: "proj_1",
    configId: `cfg_${MARK[host]}`,
    configName: `${MARK[host]}-SERVER`,
    command: `bun run dev --${MARK[host]}`,
    worktreePath: `/trees/${MARK[host]}`,
    cwd: `/trees/${MARK[host]}`,
    startedAt: 1,
    status,
    readiness: { kind: "none" },
    env: [],
    pid: host === "host_a" ? 1111 : 2222,
  };
}

const configs = (host: Host): RunConfigurationView[] => [
  { id: `cfg_${MARK[host]}`, projectId: "proj_1", name: `${MARK[host]}-SERVER`, command: `bun run dev --${MARK[host]}`, createdAt: 1, updatedAt: 1, env: [] },
];

const statusAnswer = (host: Host): RunStatusAnswer => ({ active: view(host), history: [view(host)], sessionWorktreePath: `/trees/${MARK[host]}` });

let outputSeq: Record<Host, number> = { host_a: 0, host_b: 0 };
const outputAnswer = (host: Host, after: number | undefined): RunOutputAnswer => {
  outputSeq[host] += 1;
  return {
    lines: [{ at: Date.now(), stream: "stdout", text: `from-${MARK[host]} line ${outputSeq[host]}` }],
    cursor: (after ?? 0) + 1,
    dropped: 0,
  };
};

/** Hold answers, or let them through immediately. Toggled through
 *  `setHolding` so nothing assigns it from inside a component. */
let holding = false;

function setHolding(on: boolean): void {
  holding = on;
  note(on ? "answers HELD" : "answers immediate");
}

let lastRequestAt = Date.now();

function call<T>(host: Host, verb: string, payload: () => T): Promise<T> {
  lastRequestAt = Date.now();
  const record: Call = { id: nextId++, host, verb, state: "held" };
  ledger.calls.push(record);
  const key = `${MARK[host]}·${verb}`;
  ledger.counts[key] = (ledger.counts[key] ?? 0) + 1;
  note(`→ ${key} #${record.id}${holding ? " (held)" : ""}`);
  announce();
  if (!holding) {
    record.state = "answered";
    return Promise.resolve(payload());
  }
  return new Promise<T>((resolve, reject) => {
    ledger.parked.push({
      call: record,
      deliver: () => {
        record.state = "answered";
        resolve(payload());
        announce();
      },
      fail: (reason) => {
        record.state = "dropped";
        reject(new Error(reason));
        announce();
      },
    });
    announce();
  });
}

/** A `RunApi` pinned to one host, exactly as `hostFetcher` pins the real one. */
function apiFor(host: Host): RunApi {
  return {
    configurations: () => call(host, "configs", () => ({ configurations: configs(host) })),
    createConfiguration: (_s, draft) => call(host, "create", () => ({ ...configs(host)[0]!, name: String(draft.name ?? "new") })),
    updateConfiguration: (_s, _id, patch) => call(host, "update", () => ({ ...configs(host)[0]!, ...(patch as object) }) as RunConfigurationView),
    removeConfiguration: () => call(host, "remove", () => ({ removed: `cfg_${MARK[host]}` })),
    status: () => call(host, "status", () => statusAnswer(host)),
    start: () => call(host, "start", () => view(host, "starting")),
    stop: () => call(host, "stop", () => view(host, "exited")),
    restart: () => call(host, "restart", () => view(host, "starting")),
    release: () => call(host, "release", () => view(host, "unknown")),
    output: (_s, options = {}) => call(host, "output", () => outputAnswer(host, options.after)),
  };
}

const APIS: Record<Host, RunApi> = { host_a: apiFor("host_a"), host_b: apiFor("host_b") };

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function releaseAll() {
  const due = ledger.parked.splice(0);
  note(`release all (${due.length})`);
  for (const entry of due) entry.deliver();
}

function releaseFrom(host: Host) {
  const due = ledger.parked.filter((entry) => entry.call.host === host);
  note(`release ${MARK[host]} (${due.length})`);
  ledger.parked = ledger.parked.filter((entry) => entry.call.host !== host);
  for (const entry of due) entry.deliver();
  announce();
}

// ── the page ──────────────────────────────────────────────────────────────

type Scenario = {
  name: string;
  note: string;
  run: (control: {
    setHost: (host: Host) => void;
    setVisible: (visible: boolean) => void;
    hold: (on: boolean) => void;
    press: (label: string) => boolean;
  }) => Promise<void>;
};

const SCENARIOS: Scenario[] = [
  {
    name: "late status from A lands after the switch to B",
    note: "A's status is parked, the host changes in place, then A answers. Nothing of A's may appear.",
    run: async ({ setHost, hold }) => {
      hold(true);
      setHost("host_a");
      await wait(60);
      setHost("host_b");
      await wait(60);
      releaseFrom("host_a");
      await wait(60);
      releaseFrom("host_b");
      await wait(120);
      hold(false);
    },
  },
  {
    name: "late OUTPUT leg from A lands after the switch",
    note: "A's status answers first so the panel asks A for output; the switch happens while that second leg is in flight.",
    run: async ({ setHost, hold }) => {
      hold(true);
      setHost("host_a");
      await wait(60);
      releaseFrom("host_a"); // status answers → the output leg is asked for
      await wait(60);
      setHost("host_b"); // switch with A's output still parked
      await wait(60);
      releaseFrom("host_a"); // A's output comes back late
      await wait(60);
      releaseFrom("host_b");
      await wait(120);
      hold(false);
    },
  },
  {
    name: "late ACTION completion (Stop) after the switch",
    note: "Stop is pressed on A, parked, the host changes, then the stop completes. It must not clear B's output or publish A's run.",
    run: async ({ setHost, hold, press }) => {
      hold(false);
      setHost("host_a");
      await wait(300);
      hold(true);
      if (!press("Stop")) return;
      await wait(60);
      setHost("host_b");
      await wait(60);
      releaseFrom("host_a");
      await wait(60);
      releaseAll();
      await wait(150);
      hold(false);
    },
  },
  {
    name: "an open config editor does not survive the switch",
    note: "Edit is pressed on A's configuration, then the host changes. A form still holding A's config id would PATCH B with it on save.",
    run: async ({ setHost, hold, press }) => {
      hold(false);
      setHost("host_a");
      await wait(400);
      if (!press("Edit")) return;
      await wait(300);
      setHost("host_b");
      await wait(600);
    },
  },
  {
    name: "hidden panel stops polling; reopening refreshes at once",
    note: "Watch the B·status counter: it climbs while open, freezes while hidden, and jumps the instant it reopens — no waiting out a timer.",
    run: async ({ setHost, setVisible, hold }) => {
      hold(false);
      setHost("host_b");
      await wait(2500);
      setVisible(false);
      await wait(3000);
      setVisible(true);
      await wait(1500);
    },
  },
];

/** Re-render on every request and four times a second, and sample how long it
 *  has been since the last request — a frozen poll is then readable from a
 *  still screenshot rather than only by watching. */
function useLedger(): number {
  const [age, setAge] = useState(0);
  useEffect(() => {
    const sample = () => setAge(Date.now() - lastRequestAt);
    notify = sample;
    const timer = setInterval(sample, 250);
    return () => {
      notify = () => {};
      clearInterval(timer);
    };
  }, []);
  return age;
}

function App() {
  const [host, setHostState] = useState<Host>("host_a");
  const [visible, setVisibleState] = useState(true);
  const setHost = (next: Host) => {
    note(`HOST → ${next}`);
    setHostState(next);
  };
  const setVisible = (next: boolean) => {
    note(next ? "VISIBLE (panel reopened)" : "HIDDEN (kept mounted, zero width)");
    setVisibleState(next);
  };
  const [holdingState, setHoldingState] = useState(false);
  const [running, setRunning] = useState<string>();
  /** Highest foreign-text sighting seen so far, so a leak cannot scroll away. */
  const [leak, setLeak] = useState<string>();
  const idleFor = useLedger();

  // The verdict: does the panel show text belonging to the host it is NOT
  // pinned to? Sampled from the panel's own DOM rather than from our state.
  useEffect(() => {
    const timer = setInterval(() => {
      const text = document.getElementById(PANEL_ID)?.textContent ?? "";
      const foreign = host === "host_a" ? ["B-SERVER", "from-B"] : ["A-SERVER", "from-A"];
      const hit = foreign.find((needle) => text.includes(needle));
      if (hit) setLeak(`saw "${hit}" while pinned to ${host}`);
    }, 100);
    return () => clearInterval(timer);
  }, [host]);

  /** Press one of the panel's own buttons by label. Reached through the DOM id
   *  rather than a ref: a ref may not be read from render scope, and this
   *  helper is handed to a scenario during render. */
  const press = (label: string) => {
    const host = document.getElementById(PANEL_ID);
    const button = Array.from(host?.querySelectorAll("button") ?? []).find((node) => node.textContent?.trim() === label);
    if (!button) return false;
    (button as HTMLButtonElement).click();
    return true;
  };

  const control = {
    setHost,
    setVisible,
    hold: (on: boolean) => {
      setHolding(on);
      setHoldingState(on);
    },
    press,
  };

  const counts = Object.entries(ledger.counts).sort(([a], [b]) => a.localeCompare(b));

  return h(
    "div",
    null,
    h(
      "div",
      { className: "controls" },
      ...SCENARIOS.map((scenario) =>
        h(
          "button",
          {
            key: scenario.name,
            disabled: running !== undefined,
            onClick: () => {
              ledger.calls.length = 0;
              ledger.parked.length = 0;
              ledger.log.length = 0;
              ledger.startedAt = Date.now();
              for (const key of Object.keys(ledger.counts)) delete ledger.counts[key];
              outputSeq = { host_a: 0, host_b: 0 };
              setLeak(undefined);
              setRunning(scenario.name);
              void settle()
                .then(() => scenario.run(control))
                .finally(() => {
                  setHolding(false);
                  setHoldingState(false);
                  setRunning(undefined);
                });
            },
          },
          scenario.name,
        ),
      ),
    ),
    h(
      "div",
      { className: "controls" },
      h("button", { onClick: () => setHost(host === "host_a" ? "host_b" : "host_a") }, `host: ${host} (switch)`),
      h("button", { onClick: () => setVisible(!visible) }, `visible: ${String(visible)} (toggle)`),
      h(
        "button",
        {
          onClick: () => {
            setHolding(!holdingState);
            setHoldingState(!holdingState);
          },
        },
        `answers: ${holdingState ? "HELD" : "immediate"}`,
      ),
      h("button", { onClick: () => releaseAll() }, `release ${ledger.parked.length} parked`),
      h("button", { onClick: () => releaseFrom("host_a") }, "release A only"),
      h("button", { onClick: () => releaseFrom("host_b") }, "release B only"),
    ),
    h(
      "div",
      { className: "meta" },
      running ? `running: ${running}` : "idle",
      " · session ",
      SESSION,
      " (the SAME id on both hosts)",
    ),
    h("div", { className: "meta" }, "requests: ", counts.length ? counts.map(([key, value]) => `${key}=${value}`).join("  ") : "none yet"),
    h("div", { className: "meta" }, `last request ${(idleFor / 1000).toFixed(1)}s ago`),
    h("div", { className: "meta" }, `parked: ${ledger.parked.map((entry) => `${MARK[entry.call.host]}·${entry.call.verb}#${entry.call.id}`).join(", ") || "none"}`),
    h("div", { className: leak ? "verdict bad" : "verdict good" }, leak ? `LEAK: ${leak}` : `no foreign text seen — panel is pinned to ${host}`),
    ...SCENARIOS.filter((scenario) => scenario.name === running).map((scenario) => h("p", { key: scenario.name, className: "note" }, scenario.note)),
    // Newest last, and the block is tall enough for all of them: no scrolling,
    // so a screenshot carries the whole recent history.
    h("pre", { className: "log" }, ledger.log.slice(-16).join("\n") || "no requests yet"),
    h(
      "div",
      { className: "panel", id: PANEL_ID, "data-visible": String(visible) },
      // The real component, host changed IN PLACE — no key, on purpose.
      h(RunPanel, { sessionId: SESSION, hostId: host, visible, api: APIS[host] }),
    ),
  );
}

createRoot(document.getElementById("root")!).render(h(App));
