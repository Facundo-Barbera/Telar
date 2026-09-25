/**
 * The fixture's scripted run engine and desktop workspace bridge, as a MODULE
 * that owns its own mutable state — the harness only calls its functions and
 * reads through `subscribe`/`snapshot`, so no component assigns across the
 * module boundary (react-hooks/immutability).
 */
import type { RunApi } from "../../lib/run/api";
import type { RunStatusAnswer, RunView } from "../../lib/run/types";
import type { WorkspaceOpenBridge } from "../../lib/workspace-open";

/** `empty` is the Setup case: a project with no saved recipe at all, which is
 *  the only scenario where the masthead offers a button that is not "Run". */
export type Scenario = "idle" | "empty" | "ready" | "two" | "busy" | "failed";

export const calls: string[] = [];
const watchers = new Set<() => void>();
const state = { scenario: "idle" as Scenario, hostId: "local" as string | undefined };

const OURS = "/Users/x/code/telar";

const view = (over: Partial<RunView> = {}): RunView => ({
  terminalId: "term_1",
  runId: "term_1",
  projectId: "project_1",
  sessionId: "session_1",
  origin: "run",
  title: "dev server",
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
      return { terminals: [view()], sessionWorktreePath: OURS };
    case "two":
      return {
        terminals: [view({ terminalId: "term_2", runId: "term_2", title: "dev server #2", startedAt: 2 }), view()],
        sessionWorktreePath: OURS,
      };
    case "busy":
      return {
        terminals: [view({ status: "running", warning: "port 3000 already answers, so something else may be serving http://localhost:3000; this terminal was opened anyway" })],
        sessionWorktreePath: OURS,
      };
    case "failed":
      return { terminals: [view({ status: "failed", error: "exited with code 1" })], sessionWorktreePath: OURS };
    default:
      return { terminals: [], sessionWorktreePath: OURS };
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
    // Three iconed recipes, one of them deliberately WITHOUT an icon: the
    // default glyph beside two chosen ones is a state a reader has to be able
    // to recognise, same as the openers list below.
    if (state.scenario === "empty") return { configurations: [] };
    return {
      configurations: [
        { id: "config_dev", name: "dev server", icon: "globe" },
        { id: "config_api", name: "api", icon: "server" },
        { id: "config_test", name: "test watcher" },
      ],
    };
  },
  status: async () => answer(),
  start: async (_sessionId: string, configId: string) => {
    record(`start:${configId}`);
    state.scenario = "ready";
    return view({ configId });
  },
  stop: async (_sessionId: string, terminalId?: string) => {
    record(`stop:${terminalId}`);
    state.scenario = "idle";
    return view({ status: "closed", closedBy: "person" });
  },
  restart: async (_sessionId: string, terminalId?: string) => {
    record(`restart:${terminalId}`);
    return view();
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
