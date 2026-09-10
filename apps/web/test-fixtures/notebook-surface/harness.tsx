/**
 * The REAL `NotebookSurface`, against a controllable engine.
 *
 * The screenshot that started this showed an existing notebook offered as
 * "No notebook here yet · Create" because its read had 404'd on a missing
 * plugin route. Classification is unit-tested next door; this renders the
 * actual component and reads the verdict off the DOM, because what went wrong
 * was what a person SAW.
 *
 * Every answer comes from the switchable engine below — no live app, no store.
 */
import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TurnState } from "@telar/engine-client";
import { NotebookSurface } from "../../components/session/notebook-surface";

const PATH = "demos/exoplanet/exoplanet_transit_demo.ipynb";
const SURFACE_ID = "notebook-host";

/** What the next `notebook/read` will do. */
type Mode = "route404" | "missing" | "ok" | "unavailable";
let mode: Mode = "route404";
const calls: string[] = [];
let notify = () => {};

/** An existing notebook, the one the reader had selected. */
const NOTEBOOK = {
  path: PATH,
  sha256: "abc123",
  cellCount: 2,
  cells: [
    { id: "cell_one", cellType: "markdown", source: "# Exoplanet transit demo", outputs: [] },
    { id: "cell_two", cellType: "code", source: "import numpy as np\nprint('transit depth', 0.012)", outputs: [{ kind: "text", text: "transit depth 0.012" }] },
  ],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, code: string, message: string) => json(status, { error: { code, message } });

(globalThis as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url, "http://fixture");
  const pathname = url.pathname;
  calls.push(pathname);
  notify();
  if (pathname.endsWith("/ds/kernel")) return json(200, { state: "idle", python: "/usr/bin/python3" });
  if (pathname.endsWith("/ds/notebook/read")) {
    // The four answers a read can give, as the engine words them.
    if (mode === "ok") return json(200, NOTEBOOK);
    if (mode === "missing") return refuse(404, "not_found", "no such file in this workspace");
    if (mode === "unavailable") return refuse(503, "engine_unavailable", "The cockpit cannot reach its local adapter.");
    return refuse(404, "not_found", "no data-science method notebook/read");
  }
  if (pathname.endsWith("/ds/notebook/edit")) return json(200, NOTEBOOK);
  return json(200, {});
}) as unknown as typeof fetch;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every change of what the surface shows, with when and after how many reads. */
const transitions: string[] = [];
const started = Date.now();
let last = "";
setInterval(() => {
  const host = document.getElementById(SURFACE_ID);
  if (!host) return;
  const now = line("").trim();
  if (now === last) return;
  last = now;
  transitions.push(`+${String(Date.now() - started).padStart(5)}ms  reads=${calls.filter((each) => each.endsWith("notebook/read")).length}  ${now}`);
  notify();
}, 50);

/** What the surface is showing, read off its own DOM. */
function verdict() {
  const host = document.getElementById(SURFACE_ID);
  const text = host?.textContent ?? "";
  const buttons = Array.from(host?.querySelectorAll("button") ?? []).map((button) => (button.textContent ?? "").trim());
  return {
    offersCreate: buttons.some((label) => label.startsWith("Create")),
    offersRetry: buttons.some((label) => label === "Retry"),
    saysMissing: text.includes("No notebook here yet"),
    // Two shapes for one verdict: the empty panel when nothing is open, and a
    // banner above the cells when a re-read failed over an open notebook.
    saysUnreadable: text.includes("Could not read this notebook") || (text.includes("Exoplanet transit demo") && buttons.includes("Retry")),
    saysLoading: text.includes("opening…") || text.includes("reading…"),
    showsCells: text.includes("Exoplanet transit demo"),
    engineSentence: /no data-science method notebook\/read/.test(text)
      ? "no data-science method notebook/read"
      : /cannot reach its local adapter/.test(text)
        ? "cannot reach its local adapter"
        : "",
  };
}

type Controls = {
  log: (line: string) => void;
  remount: () => void;
  /** Flip `active` — what the real cockpit does when a turn ends, and the
   *  component's own trigger for re-reading an open notebook. */
  reread: () => void;
};
type Scenario = { name: string; note: string; run: (controls: Controls) => Promise<void> };

const line = (label: string) => {
  const seen = verdict();
  return `${label.padEnd(34)} create=${seen.offersCreate ? "YES" : "no "}  retry=${seen.offersRetry ? "yes" : "no "}  ${
    seen.showsCells ? "cells" : seen.saysMissing ? "“no notebook here yet”" : seen.saysUnreadable ? "“could not read”" : seen.saysLoading ? "loading" : "?"
  }${seen.engineSentence ? `  — “${seen.engineSentence}”` : ""}`;
};

const SCENARIOS: Scenario[] = [
  {
    name: "1 · route 404 on an existing notebook",
    note: "The live failure: the read 404s because the plugin has no notebook route. The file is there. Create must NOT be offered, the engine's sentence must be shown, and Retry must be.",
    run: async ({ log, remount }) => {
      mode = "route404";
      remount();
      await wait(400);
      log(line("route 404"));
      const seen = verdict();
      log(seen.offersCreate ? "LEAK: Create offered over an unread file" : "no Create — correct");
      log(seen.offersRetry && seen.saysUnreadable ? "reads as a read failure, with Retry — correct" : "MISSING: expected “could not read” + Retry");
    },
  },
  {
    name: "2 · the same notebook after the route fix (Retry)",
    note: "The route is fixed and the reader presses Retry: the existing notebook must open, with its cells.",
    run: async ({ log, remount }) => {
      mode = "route404";
      remount();
      await wait(400);
      log(line("before the fix"));
      mode = "ok";
      const host = document.getElementById(SURFACE_ID);
      const retry = Array.from(host?.querySelectorAll("button") ?? []).find((button) => (button.textContent ?? "").trim() === "Retry");
      retry?.click();
      await wait(400);
      log(line("after Retry"));
      log(verdict().showsCells ? "the existing notebook opened — correct" : "FAILED: cells did not render");
    },
  },
  {
    name: "3 · a genuinely missing file",
    note: "The engine's own “no such file in this workspace”. This is the ONE case that may offer Create.",
    run: async ({ log, remount }) => {
      mode = "missing";
      remount();
      await wait(400);
      log(line("missing file"));
      const seen = verdict();
      log(seen.offersCreate && seen.saysMissing ? "Create offered — correct, the file is absent" : "FAILED: expected the create panel");
    },
  },
  {
    name: "4 · the engine is away",
    note: "Not a 404 at all. Still a read failure with Retry, never an offer to create.",
    run: async ({ log, remount }) => {
      mode = "unavailable";
      remount();
      await wait(400);
      log(line("engine unavailable"));
      log(verdict().offersCreate ? "LEAK: Create offered while the engine is away" : "no Create — correct");
    },
  },
  {
    name: "5 \u00b7 a re-read fails with the notebook already open",
    note: "The cells the reader is looking at must stay, under a banner with Retry \u2014 a failed question about a file does not empty it.",
    run: async ({ log, remount, reread }) => {
      mode = "ok";
      remount();
      await wait(400);
      log(line("opened"));
      // Not a remount: the component re-reads when `active` changes, which is
      // the path a reader actually takes (a turn ends, the notebook refreshes).
      mode = "route404";
      reread();
      await wait(400);
      log(line("after a failed re-read"));
      const seen = verdict();
      log(seen.showsCells ? "the cells stayed \u2014 correct" : "LOST: the notebook was thrown away on a failed re-read");
      log(seen.offersCreate ? "LEAK: Create offered over an open notebook" : "no Create \u2014 correct");
      log(seen.saysUnreadable ? "the failure is shown over the cells \u2014 correct" : "SILENT: the reader is not told the re-read failed");
      // The state must also SETTLE this way: a later read must not quietly
      // empty the panel behind the reader.
      for (const at of [1000, 2000, 3000]) {
        await wait(at === 1000 ? 600 : 1000);
        log(line(`still, at ${at}ms`));
      }
    },
  },
];

function App() {
  const [generation, setGeneration] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState<string>();
  const [active, setActive] = useState<TurnState>("completed");
  const [, bump] = useState(0);
  useEffect(() => {
    notify = () => bump((value) => value + 1);
    return () => {
      notify = () => {};
    };
  }, []);

  const log = (text: string) => setLines((current) => [...current, text]);
  const remount = () => setGeneration((value) => value + 1);
  // A turn ending is the real trigger: `active` goes running \u2192 completed and
  // the surface re-reads the file the turn may have written.
  const reread = () => setActive((state) => (state === "running" ? "completed" : "running"));

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
              calls.length = 0;
              setLines([]);
              setRunning(scenario.name);
              void scenario.run({ log, remount, reread }).finally(() => setRunning(undefined));
            },
          },
          scenario.name,
        ),
      ),
    ),
    h(
      "div",
      { className: "controls" },
      ...(["route404", "missing", "ok", "unavailable"] as Mode[]).map((each) =>
        h(
          "button",
          {
            key: each,
            // Arm the next read WITHOUT remounting, so an already-open notebook
            // can be made to fail its re-read the way a live one would.
            onClick: () => {
              mode = each;
              bump((value) => value + 1);
            },
          },
          `read → ${each}`,
        ),
      ),
      h("button", { onClick: remount }, "remount"),
      h("button", { onClick: reread }, "re-read (flip active)"),
    ),
    h("div", { className: "meta" }, `next read: ${mode} · active=${active} · ${PATH}`),
    // ALWAYS RENDERED, even when empty: these children are unkeyed, so adding or
    // removing one here shifts the surface's position and React remounts it —
    // which would silently reset the very state each scenario is watching.
    h("p", { className: "note" }, SCENARIOS.find((scenario) => scenario.name === running)?.note ?? "\u00a0"),
    h("pre", { className: "log" }, lines.join("\n") || "no scenario run yet"),
    h("pre", { className: "log" }, `transitions:\n${transitions.slice(-10).join("\n") || "none"}`),
    h(
      "div",
      { className: "surface", id: SURFACE_ID },
      h(NotebookSurface, { key: generation, path: PATH, sessionId: "session_nb", hostId: "local", active }),
    ),
  );
}

createRoot(document.getElementById("root")!).render(h(App));
