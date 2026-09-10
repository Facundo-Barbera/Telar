/**
 * A browser fixture for the two NEW masthead controls, both real components:
 * `RunHeaderControl` on a scripted `RunApi`, and `OpenWorkspaceButton` on a
 * scripted desktop workspace bridge.
 *
 * Every button below changes what the scripted engine reports, so the states
 * a reader has to recognise — nothing deployed, ours running, ANOTHER tree's
 * deployment, a lost run — can each be opened and pressed. The ledger records
 * exactly what reached the client, which is how "start did not silently send
 * replace" is read off the outside rather than asserted.
 */
import { createElement as h, StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { bridge, calls, setHost, setScenario, snapshot, subscribe, type Scenario } from "./scripted-run";
import { RunHeaderControl } from "../../components/run/run-header-control";
import { OpenWorkspaceButton } from "../../components/session/open-workspace-button";

const SCENARIOS: { name: string; scenario: Scenario }[] = [
  { name: "nothing deployed", scenario: "idle" },
  { name: "ours, ready", scenario: "ready" },
  { name: "ours, starting", scenario: "starting" },
  { name: "ANOTHER tree", scenario: "foreign" },
  { name: "lost run", scenario: "lost" },
  { name: "failed", scenario: "failed" },
];

const HOSTS: { name: string; hostId: string | undefined }[] = [
  { name: "local session", hostId: "local" },
  { name: "REMOTE session", hostId: "host_mac_lan" },
];

function Harness() {
  const ledger = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [watched, setWatched] = useState(0);
  const [hostId, setHostId] = useState<string | undefined>("local");

  const button = (name: string, act: () => void) =>
    h("button", { key: name, className: "rounded-md border border-border px-2 py-1 text-xs hover:bg-accent", onClick: act }, name);

  return h(
    "div",
    { className: "flex min-h-screen flex-col gap-4 bg-background p-8 text-foreground" },
    h("h1", { className: "text-lg font-semibold" }, "Masthead run + open-with fixture — real components, scripted engine"),
    h("div", { className: "flex flex-wrap gap-2" }, ...SCENARIOS.map((entry) => button(entry.name, () => setScenario(entry.scenario)))),
    h(
      "div",
      { className: "flex flex-wrap gap-2" },
      ...HOSTS.map((entry) =>
        button(entry.name, () => {
          setHost(entry.hostId);
          setHostId(entry.hostId);
        }),
      ),
    ),
    // The masthead's trailing cluster, at its real size.
    h(
      "div",
      { className: "flex items-center justify-end gap-2 rounded-lg border border-border bg-background px-4 py-2" },
      h(RunHeaderControl, {
        sessionId: "session_1",
        api: bridge,
        onWatchOutput: () => setWatched((value) => value + 1),
      }),
      h(OpenWorkspaceButton, { path: "/Users/x/code/telar", hostId, hostLabel: hostId === "local" ? undefined : "mac.lan" }),
    ),
    h(
      "div",
      { className: "max-w-3xl font-mono text-xs text-muted-foreground" },
      `panel opened ${watched}× · ${ledger}`,
    ),
    h(
      "p",
      { className: "max-w-2xl text-xs text-muted-foreground" },
      "“Watch output” and “Configure” hand off to the right panel — this fixture counts the hand-off rather than rendering a second copy of the monitor.",
    ),
    h("div", { className: "hidden" }, calls.length),
  );
}

createRoot(document.getElementById("root")!).render(h(StrictMode, null, h(Harness)));
