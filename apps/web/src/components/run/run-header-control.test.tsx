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
import { latestOpenTerminal, openTerminals, runSummary, statusLabel, statusTone } from "@/lib/run/presentation";
import { RunGlyph } from "@/lib/run/icons";
import type { RunApi } from "@/lib/run/api";
import type { RunConfigurationView, RunStatusAnswer, RunView } from "@/lib/run/types";

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
    start: async (_s: string, configId: string) => (calls.push(`start:${configId}`), view()),
    stop: async (_s: string, terminalId?: string) => (calls.push(`stop:${terminalId}`), view({ status: "closed", closedBy: "person" })),
    restart: async (_s: string, terminalId?: string) => (calls.push(`restart:${terminalId}`), view()),
  } as unknown as RunApi;
  return { api, calls };
}

const render = (api: RunApi) => renderToStaticMarkup(<RunHeaderControl sessionId="session_1" api={api} onWatchOutput={() => {}} />);

describe("the pill", () => {
  test("says Run when nothing is open", () => {
    const { api } = recordingApi({ terminals: [] });
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
  test("a start names only the configuration — there is no takeover to ask for", async () => {
    const { api, calls } = recordingApi({ terminals: [] });
    await api.start("session_1", "config_dev");
    expect(calls).toEqual(["start:config_dev"]);
  });

  test("the pill reads the whole OPEN list, and ignores ones that ended", () => {
    const answer: RunStatusAnswer = {
      terminals: [
        view({ terminalId: "term_3", title: "dev server #2", startedAt: 3 }),
        view({ terminalId: "term_2", status: "closed", closedBy: "person", startedAt: 2 }),
        view(),
      ],
      sessionWorktreePath: "/Users/x/code/telar",
    };
    expect(latestOpenTerminal(answer)?.terminalId).toBe("term_3");
    // Two instances of one recipe are two terminals, and the pill counts both.
    expect(runSummary(openTerminals(answer)).label).toBe("2 terminals");
  });

  test("the first paint names no deployment slot to replace, switch or release", () => {
    const { api } = recordingApi({ terminals: [] });
    const html = render(api);
    for (const word of ["Replace", "Switch", "Release", "Restart"]) expect(html).not.toContain(word);
  });

  test("stop and restart address the terminal by its own id", async () => {
    const { api, calls } = recordingApi({ terminals: [view()] });
    await api.stop("session_1", "term_1");
    await api.restart("session_1", "term_1");
    expect(calls).toEqual(["stop:term_1", "restart:term_1"]);
  });
});
