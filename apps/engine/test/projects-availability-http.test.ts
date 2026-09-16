/**
 * WHAT THE WIRE SAYS ABOUT A PROJECT'S DISK — issue #534.
 *
 * `project-volume.test.ts` pins what the store decides; this file is about what
 * a client can see and do: the re-probe the desktop shell posts when it notices
 * a mount, the `availability` a rail draws its badge from, and the two refusals
 * that keep work from starting on a drive that is not here.
 *
 * Temp homes and temp checkouts throughout — no volume is mounted or unmounted.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";
import { fakeMounts, type FakeMounts } from "./fake-mount";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const drives: FakeMounts[] = [];

const root = (prefix = "telar-availability-"): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

const home = (): string => {
  const directory = root("telar-availability-home-");
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const drive of drives.splice(0)) drive.cleanup();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function engine(volumes?: FakeMounts): Promise<{
  daemon: EngineDaemon;
  client: EngineClient;
  post: (route: string) => Promise<Response>;
  get: (route: string) => Promise<Response>;
}> {
  const daemon = await startEngine({
    models: stubModels,
    engineRoot: home(),
    ...(volumes ? { volumes: volumes.deps } : {}),
  });
  daemons.push(daemon);
  const headers = { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" };
  return {
    daemon,
    client: new EngineClient(daemon.discovery),
    post: (route) => fetch(`http://127.0.0.1:${daemon.discovery.port}${route}`, { method: "POST", headers, body: "{}" }),
    get: (route) => fetch(`http://127.0.0.1:${daemon.discovery.port}${route}`, { headers }),
  };
}

/** A daemon with one project on a drive that can be unplugged. */
async function onADrive(): Promise<{
  client: EngineClient;
  get: (route: string) => Promise<Response>;
  mounts: FakeMounts;
}> {
  const mounts = fakeMounts();
  drives.push(mounts);
  const { client, get } = await engine(mounts);
  const mount = mounts.mount("TelarVR");
  const checkout = path.join(mount, "project");
  fs.mkdirSync(checkout);
  await client.registerProject({ id: "project_one", name: "TelarVR Work", root: checkout });
  return { client, get, mounts };
}

test("the desktop shell can ask the engine to re-probe every project now", async () => {
  const { client, post } = await engine();
  const checkout = root("telar-availability-checkout-");
  await client.registerProject({ id: "project_one", name: "One", root: checkout });

  const first = await post("/v2/projects/reprobe");
  expect(first.status).toBe(200);
  // The first reading of a project is not a transition — there was nothing to
  // change from. See `projectAvailability`.
  expect(await first.json()).toEqual({ projects: 1, changed: 1, recovered: 0 });

  const again = await post("/v2/projects/reprobe");
  expect(await again.json()).toEqual({ projects: 1, changed: 0, recovered: 0 });
});

test("re-probing is unauthenticated-proof like every other route", async () => {
  const { daemon, client } = await engine();
  await client.registerProject({ id: "project_one", name: "One", root: root("telar-availability-checkout-") });

  const refused = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/projects/reprobe`, { method: "POST" });
  expect(refused.status).toBe(401);
});

/* ------------------------------------------------------------------ *
 * What a client can see
 * ------------------------------------------------------------------ */

test("registration stores the drive, and the projects list publishes its availability", async () => {
  const { client, get, mounts } = await onADrive();

  const registered = (await (await get("/v2/projects")).json()) as { projects: Array<{ id: string; volume?: unknown; availability?: string }> };
  expect(registered.projects[0]!.volume).toEqual({ mount: path.join(mounts.mountRoot, "TelarVR"), uuid: mounts.uuidOf("TelarVR") });
  expect(registered.projects[0]!.availability).toBe("available");

  mounts.unmount("TelarVR");
  const away = (await (await get("/v2/projects")).json()) as { projects: Array<{ availability?: string }> };
  expect(away.projects[0]!.availability).toBe("unmounted");
});

test("the rail's one read carries availability, so the badge costs no second request", async () => {
  const { client, get, mounts } = await onADrive();
  await client.createSession({ id: "session_one", projectId: "project_one" });

  const live = (await (await get("/v2/sessions/live")).json()) as { projects: Array<{ id: string; availability?: string }> };
  expect(live.projects.find((project) => project.id === "project_one")?.availability).toBe("available");

  mounts.unmount("TelarVR");
  const away = (await (await get("/v2/sessions/live")).json()) as { projects: Array<{ id: string; availability?: string }> };
  expect(away.projects.find((project) => project.id === "project_one")?.availability).toBe("unmounted");
});

/* ------------------------------------------------------------------ *
 * What a client cannot do
 * ------------------------------------------------------------------ */

test("creating a session on an away project is refused with the drive sentence", async () => {
  const { client, mounts } = await onADrive();
  mounts.unmount("TelarVR");

  await expect(client.createSession({ id: "session_away", projectId: "project_one" })).rejects.toMatchObject({
    code: "conflict",
    message: "The drive holding TelarVR Work is not connected. Plug it back in and this will work again.",
  });
});

test("sending into a session whose drive left is refused with the same sentence", async () => {
  const { client, mounts } = await onADrive();
  const session = await client.createSession({ id: "session_one", projectId: "project_one" });
  await client.registerWorker("worker_one");

  mounts.unmount("TelarVR");
  await expect(client.submitTurn(session.session.id, { runId: "run_one", input: "Hello" })).rejects.toMatchObject({
    code: "conflict",
    message: "The drive holding TelarVR Work is not connected. Plug it back in and this will work again.",
  });
});

test("the drive coming back is all it takes — no re-registration, same project id", async () => {
  const { client, mounts } = await onADrive();
  mounts.unmount("TelarVR");
  await expect(client.createSession({ id: "session_away", projectId: "project_one" })).rejects.toMatchObject({ code: "conflict" });

  mounts.mount("TelarVR");
  fs.mkdirSync(path.join(mounts.mountRoot, "TelarVR", "project"), { recursive: true });
  const session = await client.createSession({ id: "session_back", projectId: "project_one" });
  expect(session.session.projectId).toBe("project_one");
});
