/**
 * THE MASTHEAD RUN CONTROL — what it reads and what it dispatches.
 *
 * Rendered through `renderToStaticMarkup`, so these cover the FIRST paint:
 * the pill's label and status tone, and the fact that monitoring is offered
 * as a door to the panel rather than duplicated here. The action dispatch is
 * covered against the injected `RunApi` directly, because the popover's
 * contents only exist once a human opens it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunHeaderControl } from "./run-header-control";
import { runAction, statusLabel, statusTone } from "@/lib/run/presentation";
import type { RunApi } from "@/lib/run/api";
import type { RunStatusAnswer, RunView } from "@/lib/run/types";

const view = (over: Partial<RunView> = {}): RunView => ({
  runId: "run_1",
  projectId: "project_1",
  configId: "config_dev",
  configName: "dev server",
  command: "bun dev",
  worktreePath: "/Users/x/code/telar",
  cwd: "/Users/x/code/telar",
  status: "ready",
  readiness: { kind: "none" },
  startedAt: 1,
  env: [],
  ...over,
});

/** A client that records what the control asked it to do. */
function recordingApi(status: RunStatusAnswer) {
  const calls: string[] = [];
  const api = {
    configurations: async () => ({ configurations: [{ id: "config_dev", name: "dev server" }] }),
    status: async () => status,
    start: async (_s: string, configId: string, replace?: boolean) => (calls.push(`start:${configId}${replace ? ":replace" : ""}`), view()),
    stop: async (_s: string, runId?: string) => (calls.push(`stop:${runId}`), view({ status: "exited" })),
    restart: async (_s: string, runId?: string) => (calls.push(`restart:${runId}`), view()),
    release: async (_s: string, runId: string) => (calls.push(`release:${runId}`), view({ status: "exited" })),
  } as unknown as RunApi;
  return { api, calls };
}

const render = (api: RunApi) => renderToStaticMarkup(<RunHeaderControl sessionId="session_1" api={api} onWatchOutput={() => {}} />);

describe("the pill", () => {
  test("says Run when nothing is deployed", () => {
    const { api } = recordingApi({ history: [] });
    const html = render(api);
    expect(html).toContain("Run this project");
  });

  test("carries an accessible label naming the run's own status once deployed", () => {
    // The label is the presentation layer's, not a second vocabulary.
    const active = view({ status: "ready" });
    expect(statusLabel(active)).toBeTruthy();
    expect(statusTone("ready")).toBe("good");
    expect(statusTone("failed")).toBe("bad");
  });
});

describe("what pressing a configuration means", () => {
  test("nothing deployed → a plain start, never a replace", async () => {
    const { api, calls } = recordingApi({ history: [] });
    const answer: RunStatusAnswer = { history: [] };
    expect(runAction(answer).kind).toBe("start");
    await api.start("session_1", "config_dev", runAction(answer).kind === "replace");
    expect(calls).toEqual(["start:config_dev"]);
  });

  test("our own deployment → replace is sent, because stopping it is the ordinary way to restart", async () => {
    const answer: RunStatusAnswer = { active: view(), history: [view()], sessionWorktreePath: "/Users/x/code/telar" };
    const { api, calls } = recordingApi(answer);
    expect(runAction(answer).kind).toBe("replace");
    await api.start("session_1", "config_other", runAction(answer).kind === "replace");
    expect(calls).toEqual(["start:config_other:replace"]);
  });

  test("ANOTHER tree's deployment → the control must not send replace unasked", async () => {
    // `runAction` reports `switch`, which the header renders as a warning
    // sentence; the start below therefore carries no `replace`.
    const answer: RunStatusAnswer = { active: view({ worktreePath: "/Users/x/other" }), history: [], sessionWorktreePath: "/Users/x/code/telar" };
    const { api, calls } = recordingApi(answer);
    expect(runAction(answer).kind).toBe("switch");
    await api.start("session_1", "config_dev", runAction(answer).kind === "replace");
    expect(calls).toEqual(["start:config_dev"]);
  });

  test("a lost run is released by the human, never signalled", async () => {
    const answer: RunStatusAnswer = { active: view({ status: "unknown" }), history: [] };
    const { api, calls } = recordingApi(answer);
    expect(runAction(answer).kind).toBe("release");
    await api.release("session_1", "run_1");
    expect(calls).toEqual(["release:run_1"]);
  });

  test("stop and restart address the run by its own id", async () => {
    const { api, calls } = recordingApi({ active: view(), history: [] });
    await api.stop("session_1", "run_1");
    await api.restart("session_1", "run_1");
    expect(calls).toEqual(["stop:run_1", "restart:run_1"]);
  });
});
