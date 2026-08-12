// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as projectsGet, POST as projectsPost } from "@/app/api/projects/route";
import { GET as eventsGet } from "@/app/api/sessions/[sessionId]/events/route";
import { POST as discardPost } from "@/app/api/sessions/[sessionId]/turns/[runId]/discard/route";
import { EngineClient } from "@telar/engine-client";
import { vnextRootFromWebEnv } from "@/lib/vnext/engine-server";
import { startEngine, type EngineDaemon } from "../../../engine/src/daemon";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarVnext = process.env.TELAR_VNEXT;
const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(() => {
  return Promise.all(daemons.splice(0).reverse().map((daemon) => daemon.close())).then(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
    else process.env.TELAR_HOME = savedTelarHome;
    if (savedTelarVnext === undefined) delete process.env.TELAR_VNEXT;
    else process.env.TELAR_VNEXT = savedTelarVnext;
  });
});

describe("vNext route adapters", () => {
  test("reports a typed unavailable engine instead of consulting a legacy store", async () => {
    delete process.env.TELAR_HOME;
    process.env.TELAR_VNEXT = "1";
    const response = await projectsGet();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "engine_unavailable", message: "Set an absolute TELAR_HOME for the vNext engine before opening the cockpit." },
    });
  });

  test("the web adapter refuses vNext access outside the dedicated launcher", () => {
    expect(() => vnextRootFromWebEnv({ TELAR_HOME: "/tmp/vnext", TELAR_VNEXT: "" })).toThrow(
      "ordinary web mode cannot access vNext state",
    );
  });

  test("the web adapter refuses a legacy home even when the vNext flag is forged", () => {
    expect(() => vnextRootFromWebEnv({ TELAR_HOME: path.join(os.homedir(), ".telar-dev"), TELAR_VNEXT: "1" })).toThrow(
      "must not point at legacy Telar state",
    );
  });

  test("rejects malformed command input before it reaches the engine", async () => {
    const response = await projectsPost(new Request("http://telar.local/api/projects", { method: "POST", body: "not json" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  test("validates a journal cursor in the thin adapter", async () => {
    const response = await eventsGet(new Request("http://telar.local/api/sessions/session_a/events?after=not-a-cursor"), { params: Promise.resolve({ sessionId: "session_a" }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  test("proxies an explicit discard decision to the authenticated engine without submitting a replay", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-vnext-web-route-"));
    roots.push(home);
    process.env.TELAR_HOME = home;
    process.env.TELAR_VNEXT = "1";
    const daemon = await startEngine({ vnextRoot: path.join(home, "vnext") });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: home });
    await client.createSession({ id: "session_one", projectId: "project_one" });
    await client.registerWorker("worker_one");
    await client.submitTurn("session_one", { runId: "uncertain_run", text: "Hello" });
    const claim = (await client.claimTurn("worker_one")).claim!;
    await client.markTurnRunning(claim.sessionId, claim.turn.runId, claim.turn.claim!.token);
    daemon.store.recover();

    const response = await discardPost(new Request("http://telar.local/api/sessions/session_one/turns/uncertain_run/discard", { method: "POST" }), {
      params: Promise.resolve({ sessionId: "session_one", runId: "uncertain_run" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ turn: { runId: "uncertain_run", state: "discarded" } });
    await expect(client.submitTurn("session_one", { runId: "fresh_run", text: "Hello" })).resolves.toMatchObject({
      replayed: false,
      turn: { runId: "fresh_run", state: "queued" },
    });
  });
});
