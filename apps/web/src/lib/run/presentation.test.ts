/**
 * The folds that decide what a human is told. Every test here is about a
 * wrong answer that would cost something real: a green dot over an
 * unattributable check, "Running" over a closed terminal, a password typed
 * into a field that will refuse it only after the round trip.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  draftProblems,
  describeReadiness,
  isOpenTerminal,
  latestOpenTerminal,
  openCount,
  openTerminals,
  recentRuns,
  runSummary,
  statusDetail,
  statusLabel,
  statusTone,
  terminalTitle,
  worktreeLabel,
} from "./presentation";
import type { RunConfigurationDraft, RunStatusAnswer, RunView } from "./types";

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    terminalId: "term_1",
    runId: "term_1",
    projectId: "proj_1",
    sessionId: "sess_1",
    origin: "run",
    title: "web dev",
    configId: "cfg_1",
    configName: "web dev",
    command: "bun run dev",
    worktreePath: "/trees/main",
    cwd: "/trees/main",
    startedAt: 1000,
    status: "running",
    readiness: { kind: "none" },
    env: [],
    ...overrides,
  };
}

const answer = (overrides: Partial<RunStatusAnswer> = {}): RunStatusAnswer => ({ terminals: [], ...overrides });

describe("the session's terminals", () => {
  test("nothing open is nothing to summarise", () => {
    expect(latestOpenTerminal(answer())).toBeUndefined();
    expect(latestOpenTerminal(undefined)).toBeUndefined();
  });

  test("the newest OPEN terminal is summarised, and an ended one is not", () => {
    // The list is newest first; the one that just closed must not stand in
    // for the one still serving.
    const closed = run({ terminalId: "term_2", startedAt: 2000, status: "closed", closedBy: "person" });
    const open = run({ terminalId: "term_1", startedAt: 1000 });
    expect(latestOpenTerminal(answer({ terminals: [closed, open] }))?.terminalId).toBe("term_1");
    expect(isOpenTerminal(closed)).toBe(false);
    expect(isOpenTerminal(open)).toBe(true);
  });
});

/**
 * RUN = A NEW TERMINAL: a session holds a LIST, and pressing a configuration
 * again opens another instance. What the masthead says has to be true of the
 * whole list, not of whichever one happened to be newest.
 */
describe("several instances", () => {
  const first = run({ terminalId: "term_1", title: "web dev", startedAt: 1000, status: "ready" });
  const second = run({ terminalId: "term_2", title: "web dev #2", startedAt: 2000, status: "running" });
  const other = run({ terminalId: "term_3", title: "api", configId: "cfg_api", configName: "api", startedAt: 3000, status: "ready" });
  const ended = run({ terminalId: "term_0", title: "web dev", startedAt: 500, status: "exited", exitCode: 0 });

  test("the open list is oldest first, the order the strip reads in, and drops the ended", () => {
    const list = openTerminals(answer({ terminals: [other, second, ended, first] }));
    expect(list.map((view) => view.terminalId)).toEqual(["term_1", "term_2", "term_3"]);
    expect(openTerminals(undefined)).toEqual([]);
    // A paired Mac on an older engine answers without the list.
    expect(openTerminals({} as RunStatusAnswer)).toEqual([]);
  });

  test("an instance is named by the engine's title, never by a number made up here", () => {
    expect(terminalTitle(second)).toBe("web dev #2");
    // An engine older than titles still names it after its recipe.
    expect(terminalTitle(run({ title: "", configName: "web dev" }))).toBe("web dev");
  });

  test("each configuration knows how many of it are open", () => {
    const open = [first, second, other];
    expect(openCount(open, "cfg_1")).toBe(2);
    expect(openCount(open, "cfg_api")).toBe(1);
    expect(openCount(open, "cfg_none")).toBe(0);
  });

  test("the masthead says Run over nothing, the one's name over one, and a count over several", () => {
    expect(runSummary([])).toEqual({ label: "Run", tone: "idle" });
    expect(runSummary([first])).toEqual({ label: "web dev", tone: "good", detail: "Ready" });
    expect(runSummary([first, other]).label).toBe("2 terminals");
  });

  test("several are green only when every one is — the summary never outranks a chip", () => {
    expect(runSummary([first, other]).tone).toBe("good");
    expect(runSummary([first, second, other]).tone).toBe("working");
  });
});

describe("status", () => {
  test("tone separates failed from a terminal somebody closed", () => {
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("ready")).toBe("good");
    expect(statusTone("exited")).toBe("idle");
    expect(statusTone("closed")).toBe("idle");
  });

  test("an ended terminal is never labelled as still running", () => {
    expect(statusLabel(run({ status: "exited", exitCode: 0 }))).toBe("Exited");
    expect(statusLabel(run({ status: "exited", exitCode: 3 }))).toBe("Exited (3)");
    expect(statusLabel(run({ status: "closed", closedBy: "person" }))).toBe("Closed");
  });

  test("the engine's error is shown as-is — it arrives already redacted", () => {
    expect(statusDetail(run({ status: "failed", error: "spawn failed: «redacted»" }))).toBe("spawn failed: «redacted»");
    expect(statusDetail(run({ status: "exited", signal: "SIGTERM" }))).toBe("Stopped by SIGTERM.");
    expect(statusDetail(run())).toBeUndefined();
  });

  test("a busy port is said, and who closed a terminal is said", () => {
    expect(statusDetail(run({ warning: "port 3000 already answers" }))).toBe("Port 3000 already answers.");
    expect(statusDetail(run({ status: "closed", closedBy: "agent" }))).toBe("Closed by the agent.");
    expect(statusDetail(run({ status: "closed", closedBy: "telar" }))).toBe("Closed by Telar.");
  });
});

describe("describeReadiness", () => {
  test("an unattributable check explains itself instead of showing a dot", () => {
    const reason = "http://localhost:3000 was already answering before this run started.";
    expect(describeReadiness({ kind: "unattributable", reason }, "http://localhost:3000")).toBe(reason);
  });

  test("no check configured says nothing at all", () => {
    expect(describeReadiness({ kind: "none" })).toBeUndefined();
  });

  test("pending names the address being waited on", () => {
    expect(describeReadiness({ kind: "pending" }, "http://localhost:3000")).toContain("localhost:3000");
  });
});

describe("draftProblems", () => {
  const draft = (overrides: Partial<RunConfigurationDraft> = {}): RunConfigurationDraft => ({
    name: "web dev",
    command: "bun run dev",
    ...overrides,
  });

  test("a savable draft has nothing to say", () => {
    expect(draftProblems(draft())).toEqual([]);
  });

  test("a secret shorter than four characters is refused with the reason", () => {
    // Same rule as the engine: a two-character value cannot be scrubbed out of
    // captured output without mangling unrelated text.
    const problems = draftProblems(draft({ env: [{ key: "TOKEN", value: "ab", secret: true }] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.field).toBe("env");
    expect(problems[0]!.message).toContain("4 characters");
  });

  test("the same short value is fine when it is not marked secret", () => {
    expect(draftProblems(draft({ env: [{ key: "MODE", value: "ab" }] }))).toEqual([]);
  });

  test("a multi-line secret is refused", () => {
    const problems = draftProblems(draft({ env: [{ key: "KEY", value: "line one\nline two", secret: true }] }));
    expect(problems.some((problem) => problem.message.includes("line break"))).toBe(true);
  });

  test("a readiness check must be http(s), and an absolute cwd is not relative", () => {
    expect(draftProblems(draft({ readinessUrl: "ftp://localhost" }))[0]!.field).toBe("readinessUrl");
    expect(draftProblems(draft({ readinessUrl: "http://localhost:3000" }))).toEqual([]);
    expect(draftProblems(draft({ cwd: "/etc" }))[0]!.field).toBe("cwd");
    expect(draftProblems(draft({ cwd: "apps/web" }))).toEqual([]);
  });

  test("an unnamed configuration, an empty command and a duplicate variable are all caught", () => {
    expect(draftProblems(draft({ name: "  " }))[0]!.field).toBe("name");
    expect(draftProblems(draft({ command: "" }))[0]!.field).toBe("command");
    const dupes = draftProblems(draft({ env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }));
    expect(dupes.some((problem) => problem.message.includes("twice"))).toBe(true);
  });
});

describe("history", () => {
  test("recent runs are newest first, whatever order they arrived in", () => {
    const answered = answer({
      terminals: [run({ terminalId: "term_old", startedAt: 1 }), run({ terminalId: "term_new", startedAt: 9 })],
    });
    expect(recentRuns(answered).map((entry: RunView) => entry.terminalId)).toEqual(["term_new", "term_old"]);
    expect(recentRuns(answered, 1)).toHaveLength(1);
  });

  test("the worktree label names the tree and its branch", () => {
    expect(worktreeLabel("/trees/feature-a/", "feat/x")).toBe("feature-a (feat/x)");
    expect(worktreeLabel("/trees/main")).toBe("main");
  });
});
