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
import { headerMode, RunHeaderControl } from "./run-header-control";
import { RunConfigEditor } from "./run-config-editor";
import { runAction, statusLabel, statusTone } from "@/lib/run/presentation";
import { RunGlyph } from "@/lib/run/icons";
import type { RunApi } from "@/lib/run/api";
import type { RunConfigurationView, RunStatusAnswer, RunView } from "@/lib/run/types";

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

describe("the empty state", () => {
  const config = (over: Partial<RunConfigurationView> = {}): RunConfigurationView =>
    ({ id: "config_dev", name: "dev server", ...over }) as RunConfigurationView;

  test("no saved configuration and nothing deployed is the one setup case", () => {
    expect(headerMode([], undefined)).toBe("setup");
  });

  test("a list not read yet is unknown, not empty", () => {
    // Offering the form over a project that turns out to have three recipes is
    // worse than a moment of the ordinary menu.
    expect(headerMode(undefined, undefined)).toBe("run");
  });

  test("a live run wins over an empty list", () => {
    // Its recipe was deleted mid-flight; the deployment is still the thing a
    // human needs to see and stop, so the button must open the menu.
    expect(headerMode([], view())).toBe("run");
  });

  test("any saved configuration is enough to leave the setup case", () => {
    expect(headerMode([config()], undefined)).toBe("run");
  });

  test("the setup case opens the editor, which paints the form rather than a menu", () => {
    // What the button opens INTO. `renderToStaticMarkup` runs no effects, so
    // the popover's own contents cannot be rendered here (see
    // run-header-host.test.tsx); the form it opens can.
    const html = renderToStaticMarkup(<RunConfigEditor onSave={() => {}} onCancel={() => {}} />);
    expect(html).toContain("Command");
    expect(html).toContain('aria-label="Icon"');
    // The picker offers the closed set, each one named.
    expect(html).toContain('aria-label="Server"');
    expect(html).toContain('aria-label="Database"');
    // `play` opens chosen, so a new configuration always has an icon.
    expect(html).toContain('role="radio" aria-checked="true" aria-label="Play"');
    // And it opens QUIET: the first paint of a blank form used to carry its
    // own complaint about being blank.
    expect(html).not.toContain("Give this configuration a name.");
  });
});

describe("an iconed row", () => {
  test("a configuration's own glyph is what its row draws, and it differs per icon", () => {
    const server = renderToStaticMarkup(<RunGlyph icon="server" className="size-3.5 shrink-0" />);
    const unset = renderToStaticMarkup(<RunGlyph className="size-3.5 shrink-0" />);
    expect(server).toContain("<svg");
    // A configuration that never chose one still draws the default, so a row
    // is never a name with a hole in front of it.
    expect(unset).toContain("<svg");
    expect(server).not.toBe(unset);
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
