import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { GET } from "./route";
import { startEngine, type EngineDaemon } from "../../../../../../../engine/src/daemon";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = savedTelarHome;
  if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
  else process.env.TELAR_COCKPIT = savedTelarCockpit;
});

async function projectWithSvgIcon() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-icon-route-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  const checkout = path.join(home, "one");
  fs.mkdirSync(path.join(checkout, ".telar"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".telar", "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`);
  const daemon = await startEngine({ engineRoot: path.join(home, "engine") });
  daemons.push(daemon);
  await new EngineClient(daemon.discovery).registerProject({ id: "project_one", name: "One", root: checkout });
}

const get = (query: string) =>
  GET(new Request(`http://telar.local/api/projects/project_one/icon${query}`), { params: Promise.resolve({ projectId: "project_one" }) });

test("serves the icon as the engine found it by default", async () => {
  await projectWithSvgIcon();
  const response = await get("?v=abc");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
});

test.skipIf(process.platform !== "darwin")("forwards format=png to the engine", async () => {
  await projectWithSvgIcon();
  const response = await get("?v=abc&format=png");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
});
