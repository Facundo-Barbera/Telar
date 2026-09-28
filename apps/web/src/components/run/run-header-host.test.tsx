/**
 * The header control's stale-answer disposal, driven through the production
 * `createReadGuard` the component itself calls — not a copy — on genuinely
 * deferred promises resolved in the order under test.
 *
 * (This app has no DOM test environment; every component test renders through
 * `react-dom/server`, which runs no effects. So the async rules live in the
 * exported guard the component's only job is to consult.)
 *
 * THE STATUS CHANNEL LEFT THIS FILE WITH THE POLL (#890). The guard's latch
 * existed so two overlapping status POLLS could not land out of order; status
 * is now one read followed by a stream, whose frames are ordered by the
 * connection they arrive on and folded by `applyRunStatusEvent` (tested in
 * lib/run/status-stream.test.ts). What is still guarded — and still tested
 * here — is the CONFIGURATIONS list, which is read on mount and on every open
 * and which a save must not be able to overwrite with an older answer.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createReadGuard, RunHeaderControl, type ReadGuard } from "./run-header-control";
import { createRunApi, runPath } from "@/lib/run/api";
import type { RunApi } from "@/lib/run/api";
import type { RunConfigurationView, RunStatusAnswer } from "@/lib/run/types";

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
      return Promise.resolve(new Response(JSON.stringify({ terminals: [] }), { status: 200, headers: { "content-type": "application/json" } }));
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
});
