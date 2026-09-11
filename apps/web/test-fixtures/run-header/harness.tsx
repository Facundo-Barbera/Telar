/**
 * A browser fixture for the masthead's TRAILING CLUSTER, all real components:
 * `RunHeaderControl` on a scripted `RunApi`, `OpenWorkspaceButton` on a
 * scripted desktop workspace bridge, the pinned summary, and the panel toggle.
 *
 * Every button below changes what the scripted engine reports, so the states
 * a reader has to recognise — nothing deployed, ours running, ANOTHER tree's
 * deployment, a lost run — can each be opened and pressed. The ledger records
 * exactly what reached the client, which is how "start did not silently send
 * replace" is read off the outside rather than asserted.
 *
 * THE WHOLE CLUSTER, NOT THE TWO NEW CONTROLS, because the thing being judged
 * is now whether they read as one family — which cannot be seen one component
 * at a time. The row is rendered at two widths for the same reason: the header
 * gives up the session TITLE before it gives up these, so the question a
 * screenshot has to answer is what the cluster costs the title at 900px.
 */
import { createElement as h, StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { bridge, calls, setHost, setScenario, snapshot, subscribe, type Scenario } from "./scripted-run";
import { RunHeaderControl } from "../../components/run/run-header-control";
import { OpenWorkspaceButton } from "../../components/session/open-workspace-button";
import { WorkspaceInspector } from "../../components/session/workspace-inspector";
import { RailToggle } from "../../components/right-panel";

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

/** The wide case, and the one where the title is genuinely under pressure. */
const WIDTHS = [1200, 900];

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
    // The masthead at two widths, each the real row: a title that gives up
    // space on the left, the cluster holding its size on the right.
    ...WIDTHS.map((width) =>
      h(
        "div",
        { key: width, className: "flex flex-col gap-1" },
        h("p", { className: "font-mono text-[0.625rem] text-muted-foreground" }, `${width}px`),
        h(
          "div",
          {
            style: { width },
            // The masthead's own classes (session-cockpit.tsx): translucent over
            // a blur, which is the background these buttons have to read on.
            className: "flex items-center gap-2 overflow-hidden rounded-lg bg-background/65 py-1.5 pr-4 pl-4 ring-1 ring-border backdrop-blur",
          },
          h(
            "div",
            { className: "mr-1 flex min-w-0 flex-1 items-center gap-2 text-sm" },
            h("span", { className: "shrink-0 truncate text-muted-foreground" }, "telar"),
            h("span", { className: "text-border" }, "/"),
            h("span", { className: "truncate font-semibold" }, "header buttons: Run, Open and Copy read as buttons"),
          ),
          h(
            "div",
            { className: "ml-auto flex shrink-0 items-center gap-2" },
            h(RunHeaderControl, {
              sessionId: "session_1",
              api: bridge,
              onWatchOutput: () => setWatched((value) => value + 1),
            }),
            h(OpenWorkspaceButton, { path: "/Users/x/code/telar", hostId, hostLabel: hostId === "local" ? undefined : "mac.lan" }),
            h(WorkspaceInspector, { projectId: "project_1", projectName: "telar", tasks: [], onOpenPanel: () => {} }),
            h(RailToggle, { open: false, onToggle: () => {} }),
          ),
        ),
      ),
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
