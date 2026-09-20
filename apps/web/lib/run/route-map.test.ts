/**
 * The seam between the cockpit's paths and the engine's verbs.
 *
 * WHAT THIS CATCHES IS DRIFT, and drift here is invisible: the panel asks
 * `/api/sessions/:id/run/output`, a Next route matches a tail, the engine
 * answers through a typed verb — and a tail that stops matching becomes a 404
 * the panel reports as "the run request failed", naming neither half. So every
 * path `runApi` actually builds is driven through the real table below, against
 * a stub client that records which verb was reached with what.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { createRunApi } from "./api";
import { RunRouteRefusal, matchRunRequest, serveRunRequest, type RunEngineVerbs } from "./route-map";

type Reached = { verb: string; args: unknown[] };

function stubClient() {
  const reached: Reached[] = [];
  const verb =
    (name: string) =>
    async (...args: unknown[]) => {
      reached.push({ verb: name, args });
      return {};
    };
  const client = {
    runConfigurations: verb("runConfigurations"),
    createRunConfiguration: verb("createRunConfiguration"),
    updateRunConfiguration: verb("updateRunConfiguration"),
    removeRunConfiguration: verb("removeRunConfiguration"),
    runStatus: verb("runStatus"),
    startRun: verb("startRun"),
    stopRun: verb("stopRun"),
    restartRun: verb("restartRun"),
    releaseRun: verb("releaseRun"),
    runOutput: verb("runOutput"),
    runBytes: verb("runBytes"),
    writeRun: verb("writeRun"),
    resizeRun: verb("resizeRun"),
  } as unknown as RunEngineVerbs;
  return { client, reached };
}

/** Drive one recorded cockpit call through the route table, as Next would. */
async function through(client: RunEngineVerbs, call: { url: string; method?: string; body?: unknown }) {
  const url = new URL(call.url, "http://localhost");
  const match = /^\/api\/sessions\/([^/]+)\/run\/(.+)$/.exec(url.pathname);
  if (!match) throw new Error(`not a run path: ${url.pathname}`);
  return serveRunRequest(client, call.method ?? "GET", {
    sessionId: decodeURIComponent(match[1]!),
    tail: match[2]!.split("/").map((segment) => decodeURIComponent(segment)),
    body: (call.body as Record<string, unknown>) ?? {},
    query: url.searchParams,
  });
}

/** Every call the cockpit can make, recorded off the real `runApi`. */
async function everyCockpitCall() {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const api = createRunApi(fetcher);
  await api.configurations("sess_1");
  await api.createConfiguration("sess_1", { name: "dev", command: "bun run dev", env: [] });
  await api.updateConfiguration("sess_1", "runcfg_1", { command: "bun run dev" });
  await api.removeConfiguration("sess_1", "runcfg_1");
  await api.status("sess_1");
  await api.start("sess_1", "runcfg_1");
  await api.start("sess_1", "runcfg_1", true);
  await api.stop("sess_1");
  await api.stop("sess_1", "run_1");
  await api.restart("sess_1");
  await api.release("sess_1", "run_1");
  await api.output("sess_1");
  await api.output("sess_1", { runId: "run_1", after: 42 });
  await api.bytes("sess_1");
  await api.bytes("sess_1", { runId: "run_1", after: 42 });
  await api.write("sess_1", { runId: "run_1", data: "y\r" });
  await api.resize("sess_1", { runId: "run_1", cols: 120, rows: 30 });
  return calls;
}

describe("the run route table", () => {
  test("serves every path the cockpit builds, and reaches a distinct verb for each", async () => {
    const { client, reached } = stubClient();
    const calls = await everyCockpitCall();
    expect(calls.length).toBe(17);
    for (const call of calls) await through(client, call);
    expect(reached.length).toBe(calls.length);
    // All thirteen verbs exercised — a table missing one would still pass a
    // per-path assertion by falling into a neighbouring entry.
    expect(new Set(reached.map((entry) => entry.verb)).size).toBe(13);
  });

  test("the config id survives the round trip, encoded and back", async () => {
    const { client, reached } = stubClient();
    const api = createRunApi((async (input: string, init?: RequestInit) => {
      await through(client, { url: input, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);
    await api.updateConfiguration("sess_1", "cfg 1", { command: "c" });
    expect(reached[0]).toEqual({ verb: "updateRunConfiguration", args: ["sess_1", "cfg 1", { command: "c" }] });
  });

  test("the output cursor arrives as a number, and a junk one is dropped rather than sent as NaN", async () => {
    const { client, reached } = stubClient();
    await through(client, { url: "/api/sessions/s/run/output?after=42&runId=run_1", method: "GET" });
    expect(reached[0]!.args[1]).toEqual({ runId: "run_1", after: 42 });
    await through(client, { url: "/api/sessions/s/run/output?after=later", method: "GET" });
    expect(reached[1]!.args[1]).toEqual({});
  });

  test("stop and restart default to the project's active run", async () => {
    const { client, reached } = stubClient();
    await through(client, { url: "/api/sessions/s/run/stop", method: "POST", body: {} });
    await through(client, { url: "/api/sessions/s/run/restart", method: "POST", body: { runId: "run_9" } });
    expect(reached[0]!.args).toEqual(["s", undefined]);
    expect(reached[1]!.args).toEqual(["s", "run_9"]);
  });

  test("release refuses without a run id instead of freeing whatever is active", async () => {
    const { client, reached } = stubClient();
    await expect(through(client, { url: "/api/sessions/s/run/release", method: "POST", body: {} })).rejects.toBeInstanceOf(RunRouteRefusal);
    expect(reached).toHaveLength(0);
  });

  test("the byte cursor is read the same way the line cursor is", () => {
    // The two windows share a cursor contract on purpose — one poll shape, one
    // host hop. A byte route that parsed `after` differently would drift
    // invisibly: both answers carry their own cursor, so the poll would still
    // work and would simply re-draw from the top forever.
    const { client, reached } = stubClient();
    return (async () => {
      await through(client, { url: "/api/sessions/s/run/bytes?after=42&runId=run_1", method: "GET" });
      expect(reached[0]).toEqual({ verb: "runBytes", args: ["s", { runId: "run_1", after: 42 }] });
      await through(client, { url: "/api/sessions/s/run/bytes?after=later", method: "GET" });
      expect(reached[1]!.args[1]).toEqual({});
    })();
  });

  test("a write names the bytes it sends, and a resize names a usable geometry", async () => {
    const { client, reached } = stubClient();
    await through(client, { url: "/api/sessions/s/run/write", method: "POST", body: { runId: "run_1", data: "y\r" } });
    expect(reached[0]).toEqual({ verb: "writeRun", args: ["s", { runId: "run_1", data: "y\r" }] });
    // Empty is a legitimate thing to send and must not be confused with absent.
    await through(client, { url: "/api/sessions/s/run/write", method: "POST", body: { data: "" } });
    expect(reached[1]!.args[1]).toEqual({ data: "" });

    await through(client, { url: "/api/sessions/s/run/resize", method: "POST", body: { cols: 120, rows: 30 } });
    expect(reached[2]).toEqual({ verb: "resizeRun", args: ["s", { cols: 120, rows: 30 }] });
  });

  test("a shape this layer can judge is refused here rather than reaching the engine", async () => {
    const { client, reached } = stubClient();
    // No `data` at all: a caller that meant something and sent nothing.
    await expect(through(client, { url: "/api/sessions/s/run/write", method: "POST", body: {} })).rejects.toBeInstanceOf(RunRouteRefusal);
    // A geometry a PTY would read as zero, where every full-screen program
    // draws nothing.
    for (const body of [{ cols: 0, rows: 30 }, { cols: 120, rows: -1 }, { cols: "wide", rows: 30 }, {}]) {
      await expect(through(client, { url: "/api/sessions/s/run/resize", method: "POST", body })).rejects.toBeInstanceOf(RunRouteRefusal);
    }
    expect(reached).toHaveLength(0);
  });

  test("nothing else is a run route, and the method is part of the match", () => {
    expect(matchRunRequest("GET", ["bytes"])).toBeDefined();
    expect(matchRunRequest("POST", ["write"])).toBeDefined();
    expect(matchRunRequest("POST", ["resize"])).toBeDefined();
    // And `/run/output` is STILL a route: retiring it would take `run_output`
    // — an agent tool — with it.
    expect(matchRunRequest("GET", ["output"])).toBeDefined();
    expect(matchRunRequest("POST", ["bytes"])).toBeUndefined();
    expect(matchRunRequest("GET", ["write"])).toBeUndefined();
    expect(matchRunRequest("GET", ["status"])).toBeDefined();
    expect(matchRunRequest("POST", ["status"])).toBeUndefined();
    expect(matchRunRequest("GET", ["start"])).toBeUndefined();
    expect(matchRunRequest("DELETE", ["configs"])).toBeUndefined();
    expect(matchRunRequest("POST", ["configs", "a", "b"])).toBeUndefined();
    expect(matchRunRequest("POST", ["anything-else"])).toBeUndefined();
  });
});
