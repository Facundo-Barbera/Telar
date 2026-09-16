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

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

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
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function engine(): Promise<{ daemon: EngineDaemon; client: EngineClient; post: (route: string) => Promise<Response> }> {
  const daemon = await startEngine({ models: stubModels, engineRoot: home() });
  daemons.push(daemon);
  return {
    daemon,
    client: new EngineClient(daemon.discovery),
    post: (route) =>
      fetch(`http://127.0.0.1:${daemon.discovery.port}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
        body: "{}",
      }),
  };
}

test("the desktop shell can ask the engine to re-probe every project now", async () => {
  const { client, post } = await engine();
  const checkout = root("telar-availability-checkout-");
  await client.registerProject({ id: "project_one", name: "One", root: checkout });

  const first = await post("/v2/projects/reprobe");
  expect(first.status).toBe(200);
  // The first reading of a project is not a transition — there was nothing to
  // change from. See `projectAvailability`.
  expect(await first.json()).toEqual({ projects: 1, changed: 1 });

  const again = await post("/v2/projects/reprobe");
  expect(await again.json()).toEqual({ projects: 1, changed: 0 });
});

test("re-probing is unauthenticated-proof like every other route", async () => {
  const { daemon, client } = await engine();
  await client.registerProject({ id: "project_one", name: "One", root: root("telar-availability-checkout-") });

  const refused = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/projects/reprobe`, { method: "POST" });
  expect(refused.status).toBe(401);
});
