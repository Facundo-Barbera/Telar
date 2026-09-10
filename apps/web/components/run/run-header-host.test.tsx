/**
 * The header control's stale-answer disposal, driven through the production
 * `createReadGuard` the component itself calls — not a copy — on genuinely
 * deferred promises resolved in the order under test.
 *
 * (This app has no DOM test environment; every component test renders through
 * `react-dom/server`, which runs no effects. So the async rules live in the
 * exported guard the component's only job is to consult.)
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createReadGuard, RunHeaderControl, type ReadGuard } from "./run-header-control";
import { createRunApi, runPath } from "@/lib/run/api";
import type { RunApi } from "@/lib/run/api";
import type { RunConfigurationView, RunStatusAnswer, RunView } from "@/lib/run/types";

const view = (over: Partial<RunView> = {}): RunView => ({
  runId: "run_1",
  projectId: "project_1",
  configId: "config_dev",
  configName: "dev server",
  command: "bun dev",
  worktreePath: "/w",
  cwd: "/w",
  status: "ready",
  readiness: { kind: "none" },
  startedAt: 1,
  env: [],
  ...over,
});
const config = (id: string) => ({ id, name: id }) as unknown as RunConfigurationView;

/** A client whose answers the test releases by hand, in the order it chooses. */
function deferred() {
  const status: Array<(answer: RunStatusAnswer) => void> = [];
  const configs: Array<(answer: { configurations: RunConfigurationView[] }) => void> = [];
  const api = {
    status: () => new Promise<RunStatusAnswer>((resolve) => status.push(resolve)),
    configurations: () => new Promise<{ configurations: RunConfigurationView[] }>((resolve) => configs.push(resolve)),
  } as unknown as RunApi;
  return { api, status, configs };
}

/** The component's own status read, expressed once so every test drives the
 *  same sequence production does. */
function readStatus(guard: ReadGuard, api: RunApi, applied: RunStatusAnswer[]) {
  const token = guard.takeStatus();
  if (!token) return { blocked: true as const, done: Promise.resolve() };
  const done = api
    .status("session_1")
    .then((answer) => {
      if (!guard.stale(token)) applied.push(answer);
    })
    .finally(() => guard.releaseStatus(token));
  return { blocked: false as const, done };
}

function readConfigs(guard: ReadGuard, api: RunApi, applied: RunConfigurationView[][]) {
  const token = guard.open("configs");
  return api.configurations("session_1").then((answer) => {
    if (!guard.stale(token)) applied.push(answer.configurations);
  });
}

describe("the pinned client", () => {
  test("createRunApi sends through the fetcher it was given, and the path names the session", async () => {
    const seen: string[] = [];
    const api = createRunApi(((path: string) => {
      seen.push(path);
      return Promise.resolve(new Response(JSON.stringify({ history: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch);
    await api.status("session_1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("session_1");
    expect(runPath("session_1", "/start")).toContain("session_1");
  });

  test("the pill paints for a host it has no answer from yet", () => {
    const { api } = deferred();
    expect(renderToStaticMarkup(<RunHeaderControl sessionId="s" hostId="host_a" api={api} />)).toContain("Run this project");
    expect(renderToStaticMarkup(<RunHeaderControl sessionId="s" api={api} />)).toContain("Run this project");
  });
});

describe("the status latch is owned by its token", () => {
  test("old status → invalidate → new status → old finally → a third read STAYS blocked", async () => {
    // The exact hole: an unconditional release let the OLD read's `finally`
    // free the latch the NEW read is holding, so a third poll could overlap.
    const guard = createReadGuard();
    const { api, status } = deferred();
    const applied: RunStatusAnswer[] = [];

    const old = readStatus(guard, api, applied); // holds the latch
    expect(old.blocked).toBe(false);
    guard.invalidate(); // a mutation, or unmount
    const fresh = readStatus(guard, api, applied); // takes the latch again
    expect(fresh.blocked).toBe(false);

    // The OLD request settles now — its finally must not free the NEW holder.
    status[0]!({ history: [], sessionWorktreePath: "/old" });
    await old.done;

    expect(readStatus(guard, api, applied).blocked).toBe(true);

    // And only the post-invalidate answer is ever applied.
    status[1]!({ history: [], sessionWorktreePath: "/new" });
    await fresh.done;
    expect(applied).toHaveLength(1);
    expect(applied[0]!.sessionWorktreePath).toBe("/new");

    // With the holder gone, the next read may proceed.
    expect(readStatus(guard, api, applied).blocked).toBe(false);
  });

  test("the latch is released on settle, so an answered read never wedges the pill", async () => {
    const guard = createReadGuard();
    const { api, status } = deferred();
    const applied: RunStatusAnswer[] = [];
    const first = readStatus(guard, api, applied);
    status[0]!({ history: [] });
    await first.done;
    expect(readStatus(guard, api, applied).blocked).toBe(false);
  });

  test("a mutation frees the latch, so the re-read a start needs is never suppressed", () => {
    const guard = createReadGuard();
    const { api } = deferred();
    readStatus(guard, api, []);
    expect(readStatus(guard, api, []).blocked).toBe(true);
    guard.invalidate();
    expect(readStatus(guard, api, []).blocked).toBe(false);
  });

  test("two guards are independent — a new mount is never suppressed by the old one", () => {
    const departed = createReadGuard();
    const { api } = deferred();
    readStatus(departed, api, []);
    expect(readStatus(createReadGuard(), api, []).blocked).toBe(false);
  });
});

describe("reads on one channel order among themselves", () => {
  test("open1 → open2 → response2 → response1: the NEWER list stays", async () => {
    // No mutation between them, so the generation is unchanged — ordering has
    // to come from the channel's own sequence.
    const guard = createReadGuard();
    const { api, configs } = deferred();
    const applied: RunConfigurationView[][] = [];

    const first = readConfigs(guard, api, applied);
    const second = readConfigs(guard, api, applied);

    configs[1]!({ configurations: [config("config_dev"), config("config_new")] });
    await second;
    configs[0]!({ configurations: [config("config_dev")] });
    await first;

    expect(applied).toHaveLength(1);
    expect(applied[0]!.map((entry) => entry.id)).toEqual(["config_dev", "config_new"]);
  });

  test("a configurations read opened BEFORE a save cannot overwrite the list after it", async () => {
    const guard = createReadGuard();
    const { api, configs } = deferred();
    const applied: RunConfigurationView[][] = [];

    const stale = readConfigs(guard, api, applied);
    guard.invalidate(); // the save
    const fresh = readConfigs(guard, api, applied);

    configs[1]!({ configurations: [config("config_dev"), config("config_new")] });
    await fresh;
    configs[0]!({ configurations: [config("config_dev")] });
    await stale;

    expect(applied).toHaveLength(1);
    expect(applied[0]!.map((entry) => entry.id)).toEqual(["config_dev", "config_new"]);
  });

  test("the channels are separate — a status read does not age a configs read", () => {
    const guard = createReadGuard();
    const configsToken = guard.open("configs");
    guard.takeStatus();
    expect(guard.stale(configsToken)).toBe(false);
  });

  test("a status answer from a departed mount is discarded", async () => {
    const guard = createReadGuard();
    const { api, status } = deferred();
    const applied: RunStatusAnswer[] = [];
    const { done } = readStatus(guard, api, applied);
    guard.invalidate(); // unmount
    status[0]!({ active: view(), history: [] });
    await done;
    expect(applied).toEqual([]);
  });
});
