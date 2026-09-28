import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function projectWithIcon(file: string, bytes: Buffer) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-icon-route-"));
  roots.push(directory);
  const checkout = path.join(directory, "checkout");
  fs.mkdirSync(path.join(checkout, ".telar"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".telar", file), bytes);
  const daemon = await startEngine({ models: stubModels, engineRoot: path.join(directory, "engine") });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  const { project } = await client.registerProject({ name: "p", root: checkout });
  return { client, projectId: project.id };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`);

test("a PNG icon is served as-is whether or not PNG was asked for", async () => {
  const { client, projectId } = await projectWithIcon("icon.png", PNG);
  const asked = await client.projectIcon(projectId, { format: "png" });
  expect(asked.contentType).toBe("image/png");
  expect(Buffer.from(asked.data)).toEqual(PNG);
});

test("an SVG icon is served as SVG unless PNG is asked for", async () => {
  const { client, projectId } = await projectWithIcon("icon.svg", SVG);
  const plain = await client.projectIcon(projectId);
  expect(plain.contentType).toBe("image/svg+xml");
  expect(Buffer.from(plain.data)).toEqual(SVG);
});

test.skipIf(process.platform !== "darwin")("an SVG icon asked for as PNG comes back as a bounded PNG", async () => {
  const { client, projectId } = await projectWithIcon("icon.svg", SVG);
  const png = await client.projectIcon(projectId, { format: "png" });
  expect(png.contentType).toBe("image/png");
  const data = Buffer.from(png.data);
  expect(data.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
  expect(data.readUInt32BE(16)).toBe(128);
  expect(data.readUInt32BE(20)).toBe(128);
});
