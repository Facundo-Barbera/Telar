import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";
import { webImageOf } from "./web-image";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer): number => {
  let c = ~0;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const typed = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

function heicFixture(directory: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((8 * 3 + 1) * 8, 120);
  for (let y = 0; y < 8; y++) rows[y * 25] = 0;
  const png = path.join(directory, "fixture.png");
  fs.writeFileSync(png, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
  execFileSync("/usr/bin/sips", ["-s", "format", "heic", png, "--out", path.join(directory, "fixture.heic")], { stdio: "ignore" });
  return fs.readFileSync(path.join(directory, "fixture.heic"));
}

test.skipIf(process.platform !== "darwin")("a HEIC attachment is served as JPEG for display and kept as HEIC for download and the agent", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-heic-"));
  roots.push(directory);
  const heic = heicFixture(directory);
  const daemon = await startEngine({ models: stubModels, engineRoot: path.join(directory, "engine"), workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: directory });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  const { attachment } = await client.uploadAttachment("session_one", { name: "pasted.heic", mediaType: "image/heic", data: heic });

  const shown = await client.attachmentBytes("session_one", attachment.id, { display: true });
  expect(shown.contentType).toBe("image/jpeg");
  expect([...shown.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

  const original = await client.attachmentBytes("session_one", attachment.id);
  expect(original.contentType).toBe("image/heic");
  expect(Buffer.compare(Buffer.from(original.data), heic)).toBe(0);

  const forAgent = webImageOf(attachment);
  expect(forAgent.mediaType).toBe("image/jpeg");
  expect([...fs.readFileSync(forAgent.path).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
});

test("an image a browser already draws is displayed and handed to the agent as it is", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-png-"));
  roots.push(directory);
  const daemon = await startEngine({ models: stubModels, engineRoot: directory, workerLeaseMs: 60_000 });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  await client.createSession({ id: "session_one", projectId: "project_one" });

  const { attachment } = await client.uploadAttachment("session_one", { name: "shot.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) });
  const shown = await client.attachmentBytes("session_one", attachment.id, { display: true });
  expect(shown.contentType).toBe("image/png");
  expect([...shown.data]).toEqual([1, 2, 3]);
  expect(webImageOf(attachment)).toEqual(attachment);
});
