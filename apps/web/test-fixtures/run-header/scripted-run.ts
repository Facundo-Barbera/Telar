/**
 * The fixture's scripted run engine and desktop workspace bridge, as a MODULE
 * that owns its own mutable state — the harness only calls its functions and
 * reads through `subscribe`/`snapshot`, so no component assigns across the
 * module boundary (react-hooks/immutability).
 */
import type { RunApi } from "../../lib/run/api";
import type { RunStatusAnswer, RunView } from "../../lib/run/types";
import type { WorkspaceOpenBridge } from "../../lib/workspace-open";

export type Scenario = "idle" | "ready" | "starting" | "foreign" | "lost" | "failed";

export const calls: string[] = [];
const watchers = new Set<() => void>();
const state = { scenario: "idle" as Scenario, hostId: "local" as string | undefined };

const OURS = "/Users/x/code/telar";

const view = (over: Partial<RunView> = {}): RunView => ({
  runId: "run_1",
  projectId: "project_1",
  configId: "config_dev",
  configName: "dev server",
  command: "bun dev",
  worktreePath: OURS,
  cwd: OURS,
  status: "ready",
  readiness: { kind: "none" },
  readinessUrl: "http://localhost:3000",
  startedAt: 1,
  env: [],
  ...over,
});

function answer(): RunStatusAnswer {
  switch (state.scenario) {
    case "ready":
      return { active: view(), history: [view()], sessionWorktreePath: OURS };
    case "starting":
      return { active: view({ status: "starting" }), history: [], sessionWorktreePath: OURS };
    case "foreign":
      return { active: view({ worktreePath: "/Users/x/other-checkout" }), history: [], sessionWorktreePath: OURS };
    case "lost":
      return { active: view({ status: "unknown" }), history: [], sessionWorktreePath: OURS };
    case "failed":
      return { active: view({ status: "failed", error: "exited with code 1" }), history: [], sessionWorktreePath: OURS };
    default:
      return { history: [], sessionWorktreePath: OURS };
  }
}

let ledger = render();
function render(): string {
  return `scenario=${state.scenario} host=${state.hostId ?? "(none)"} · calls: ${calls.join(", ") || "(none)"}`;
}
function changed() {
  ledger = render();
  for (const watcher of watchers) watcher();
}
function record(call: string) {
  calls.push(call);
  changed();
}

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}
export function snapshot(): string {
  return ledger;
}
export function setScenario(scenario: Scenario): void {
  state.scenario = scenario;
  changed();
}
export function setHost(hostId: string | undefined): void {
  state.hostId = hostId;
  changed();
}

export const bridge = {
  configurations: async () => {
    record("configurations");
    return { configurations: [{ id: "config_dev", name: "dev server" }, { id: "config_test", name: "test watcher" }] };
  },
  status: async () => answer(),
  start: async (_sessionId: string, configId: string, replace?: boolean) => {
    record(`start:${configId}${replace ? " REPLACE" : ""}`);
    state.scenario = "ready";
    return view({ configId });
  },
  stop: async (_sessionId: string, runId?: string) => {
    record(`stop:${runId}`);
    state.scenario = "idle";
    return view({ status: "exited" });
  },
  restart: async (_sessionId: string, runId?: string) => {
    record(`restart:${runId}`);
    return view();
  },
  release: async (_sessionId: string, runId: string) => {
    record(`release:${runId}`);
    state.scenario = "idle";
    return view({ status: "exited" });
  },
} as unknown as RunApi;

/** The desktop workspace bridge, seated where `workspaceOpener()` looks. */
const workspace: WorkspaceOpenBridge = {
  // Three apps, one of them deliberately WITHOUT an icon id: the fallback glyph
  // is a state a reader has to be able to recognise, same as the rest.
  openers: async () => {
    record("workspace.openers");
    return {
      openers: [
        { id: "vscode", label: "Visual Studio Code", icon: "vscode", path: "/Applications/Visual Studio Code.app" },
        { id: "zed", label: "Zed", icon: "zed", path: "/Applications/Zed.app" },
        { id: "textmate", label: "TextMate", path: "/Applications/TextMate.app" },
      ],
    };
  },
  open: async (path, openerId) => {
    record(`workspace.open:${openerId ?? "default"}:${path}`);
    return { ok: true };
  },
  reveal: async (path) => {
    record(`workspace.reveal:${path}`);
    return { ok: true };
  },
};
(window as unknown as { telarDesktop: { workspace: WorkspaceOpenBridge } }).telarDesktop = { workspace };
