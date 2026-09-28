import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as projectsGet, POST as projectsPost } from "@/app/api/projects/route";
import { GET as eventsGet } from "@/app/api/sessions/[sessionId]/events/route";
import { GET as liveGet } from "@/app/api/sessions/live/route";
import { GET as fsGet } from "@/app/api/fs/route";
import { GET as aboutGet } from "@/app/api/about/route";
import { GET as aboutIconGet } from "@/app/api/about/icon/route";
import { GET as notifyGet, PUT as notifyPut } from "@/app/api/mobile/notify/route";
import { POST as discardPost } from "@/app/api/sessions/[sessionId]/turns/[runId]/discard/route";
import { EngineClient } from "@telar/engine-client";
import { engineRootFromWebEnv } from "@/platform/engine/server";
import { startEngine, type EngineDaemon } from "../../../../engine/src/daemon";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(() => {
  return Promise.all(daemons.splice(0).reverse().map((daemon) => daemon.close())).then(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
    else process.env.TELAR_HOME = savedTelarHome;
    if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
    else process.env.TELAR_COCKPIT = savedTelarCockpit;
  });
});

describe("engine route adapters", () => {
  test("reports a typed unavailable engine instead of consulting a legacy store", async () => {
    delete process.env.TELAR_HOME;
    process.env.TELAR_COCKPIT = "1";
    const response = await projectsGet(new Request("http://localhost/api/projects"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "engine_unavailable", message: "Set an absolute TELAR_HOME for the engine before opening the cockpit." },
    });
    const live = await liveGet(new Request("http://localhost/api/sessions/live"));
    expect(live.status).toBe(503);
    expect((await live.json()).error.code).toBe("engine_unavailable");
  });

  test("the web adapter refuses engine access outside the dedicated launcher", () => {
    expect(() => engineRootFromWebEnv({ TELAR_HOME: "/tmp/vnext", TELAR_COCKPIT: "" })).toThrow(
      "ordinary web mode cannot access engine state",
    );
  });

  test("the web adapter refuses a legacy home even when the launcher flag is forged", () => {
    expect(() => engineRootFromWebEnv({ TELAR_HOME: path.join(os.homedir(), ".telar-dev"), TELAR_COCKPIT: "1" })).toThrow(
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

  test("the live list carries every project's sessions, and the rail's arrangement", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-route-"));
    roots.push(home);
    process.env.TELAR_HOME = home;
    process.env.TELAR_COCKPIT = "1";
    const daemon = await startEngine({ engineRoot: path.join(home, "engine") });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    for (const name of ["one", "two"]) fs.mkdirSync(path.join(home, name));
    await client.registerProject({ id: "project_one", name: "One", root: path.join(home, "one") });
    await client.registerProject({ id: "project_two", name: "Two", root: path.join(home, "two") });
    await client.createSession({ id: "session_plain", projectId: "project_one" });
    await client.createSession({ id: "session_other", projectId: "project_two" });

    // THE ARRANGEMENT RIDES THE RAIL'S OWN READ (#306). This is how a drop made
    // on the phone reaches a browser tab: the rail polls this route anyway, so
    // propagation costs no second request and no connection of its own.
    await client.setSidebarLayout({ projectOrder: ["project_two", "project_one"] });
    await client.setSidebarLayout({ pinnedOrder: ["session_plain"] });
    await client.setSidebarLayout({ mode: "flat" });

    const response = await liveGet(new Request("http://cockpit.test/api/sessions/live"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(["session_other", "session_plain"]);
    expect(body.projects.map((p: { id: string }) => p.id).sort()).toEqual(["project_one", "project_two"]);
    expect(body.layout).toEqual({
      projectOrder: ["project_two", "project_one"],
      sessionOrder: {},
      pinnedOrder: ["session_plain"],
      mode: "flat",
    });
  });

  test("the live list is the engine's answer, with full projects and its conditional reads", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-route-"));
    roots.push(home);
    process.env.TELAR_HOME = home;
    process.env.TELAR_COCKPIT = "1";
    const daemon = await startEngine({ engineRoot: path.join(home, "engine") });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    fs.mkdirSync(path.join(home, "one"));
    await client.registerProject({ id: "project_one", name: "One", root: path.join(home, "one") });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    const first = await liveGet(new Request("http://cockpit.test/api/sessions/live"));
    const etag = first.headers.get("etag");
    const body = await first.json();
    expect(body.projects).toEqual((await client.listProjects()).projects);
    expect(etag).toBeTruthy();

    const unchanged = await liveGet(new Request("http://cockpit.test/api/sessions/live", { headers: { "if-none-match": etag! } }));
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(await unchanged.text()).toBe("");

    const since = await liveGet(new Request(`http://cockpit.test/api/sessions/live?since=${body.revision}`));
    expect(await since.json()).toEqual({ revision: body.revision, unchanged: true, daemonId: body.daemonId });

    const wide = await liveGet(new Request(`http://cockpit.test/api/sessions/live?all=1&since=${body.revision}`));
    expect((await wide.json()).sessions.map((s: { id: string }) => s.id)).toEqual(["session_one"]);
  });

  /**
   * ISSUE #316. The engine folds every session's assignments onto this list so
   * the rail learns who is working for whom without a history read per row —
   * and this adapter dropped the field on the floor. `result.assignments` was
   * therefore undefined for every LOCAL row, which is not a missing badge but a
   * silently empty `relatedWork`: nothing was ever `active` or `review`, so the
   * elbow tree (#324) drew each delegate as a sibling of its coordinator.
   */
  test("the folder listing is the engine's, refusals included", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-route-"));
    roots.push(home);
    process.env.TELAR_HOME = home;
    process.env.TELAR_COCKPIT = "1";
    daemons.push(await startEngine({ engineRoot: path.join(home, "engine") }));

    const outside = await fsGet(new Request(`http://cockpit.test/api/fs?path=${encodeURIComponent(home)}&ignored=1`));
    expect(outside.status).toBe(400);
    expect((await outside.json()).error.code).toBe("invalid_request");
  });

  test("the live list carries who each session is working for", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-route-"));
    roots.push(home);
    process.env.TELAR_HOME = home;
    process.env.TELAR_COCKPIT = "1";
    // A turn is only claimable once the engine knows which model runs it.
    fs.mkdirSync(path.join(home, "engine"), { recursive: true });
    fs.writeFileSync(path.join(home, "engine", "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
    const daemon = await startEngine({ engineRoot: path.join(home, "engine") });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: home });
    await client.createSession({ id: "session_coord", projectId: "project_one" });
    await client.createSession({ id: "session_worker", projectId: "project_one" });

    // The coordinator has to be MID-TURN to hand work over: `proof` is the
    // sending turn's own claim, which is what lets the engine stamp the sender
    // from the queue rather than from anything a model typed.
    await client.registerWorker("worker_one");
    await client.submitTurn("session_coord", { runId: "run_coord", input: "Delegate the web fixes" });
    const claim = (await client.claimTurn("worker_one", 1)).claim!;
    await client.markTurnRunning(claim.sessionId, claim.turn.runId, claim.turn.claim!.token);
    const proof = { sessionId: "session_coord", runId: "run_coord", claimToken: claim.turn.claim!.token };
    await client.submitAgentTurn("session_worker", { intent: "task", runId: "run_task", input: "Fix #316", proof });

    const body = await (await liveGet(new Request("http://cockpit.test/api/sessions/live"))).json();
    expect(body.assignments.session_worker).toMatchObject([
      { taskRunId: "run_task", fromSessionId: "session_coord", runId: "run_task" },
    ]);
    // Outstanding, which is the whole distinction `relatedWork` draws on.
    expect(body.assignments.session_worker[0].outcome).toBeUndefined();
  });

  test("keeps the legacy discard endpoint harmless after boot stops interrupted work", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-route-"));
    roots.push(home);
    process.env.TELAR_HOME = home;
    process.env.TELAR_COCKPIT = "1";
    // The SAME subdirectory `engineRootFromWebEnv` composes from TELAR_HOME. A
    // route that reads one directory while the daemon writes another answers
    // 503 for every call, and this test is the only thing that would notice.
    // This fixture starts with a provider default already learned by the engine.
    fs.mkdirSync(path.join(home, "engine"), { recursive: true });
    fs.writeFileSync(path.join(home, "engine", "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
    const daemon = await startEngine({ engineRoot: path.join(home, "engine") });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: home });
    await client.createSession({ id: "session_one", projectId: "project_one" });
    await client.registerWorker("worker_one");
    await client.submitTurn("session_one", { runId: "uncertain_run", input: "Hello" });
    const claim = (await client.claimTurn("worker_one", 1)).claim!;
    await client.markTurnRunning(claim.sessionId, claim.turn.runId, claim.turn.claim!.token);
    daemon.store.recover();

    const response = await discardPost(new Request("http://telar.local/api/sessions/session_one/turns/uncertain_run/discard", { method: "POST" }), {
      params: Promise.resolve({ sessionId: "session_one", runId: "uncertain_run" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
    expect((await client.session("session_one")).turns[0]?.state).toBe("stopped");
    await expect(client.submitTurn("session_one", { runId: "fresh_run", input: "Hello" })).resolves.toMatchObject({
      replayed: false,
      turn: { runId: "fresh_run", state: "queued" },
    });
  });
});

test("about and its icon are the engine's, bytes included", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-route-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  const daemon = await startEngine({ engineRoot: path.join(home, "engine") });
  daemons.push(daemon);

  const about = await (await aboutGet(new Request("http://cockpit.test/api/about"))).json();
  expect(about).toMatchObject({ channel: "dev", stateRoot: expect.stringContaining(path.basename(home)) });
  expect(about.iconUrl).toMatch(/^\/api\/about\/icon\?v=/);

  const icon = await aboutIconGet(new Request(`http://cockpit.test${about.iconUrl}`));
  expect(icon.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await icon.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test("which device is notified is the engine's setting", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-route-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  daemons.push(await startEngine({ engineRoot: path.join(home, "engine") }));

  expect(await (await notifyGet(new Request("http://cockpit.test/api/mobile/notify"))).json()).toEqual({ notifyOn: "mac" });
  const put = (notifyOn: unknown) =>
    notifyPut(new Request("http://cockpit.test/api/mobile/notify", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notifyOn }) }));
  expect(await (await put("both")).json()).toEqual({ notifyOn: "both" });
  expect((await put("pager")).status).toBe(400);
  expect(await (await notifyGet(new Request("http://cockpit.test/api/mobile/notify"))).json()).toEqual({ notifyOn: "both" });
});
