import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startEngine, type EngineDaemon } from "../../../../../../../engine/src/daemon";
import { createHostsStore } from "../../../../../../../engine/src/domains/hosts";
import { GET, POST } from "./route";

const saved = { home: process.env.TELAR_HOME, cockpit: process.env.TELAR_COCKPIT };
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const [name, value] of [["TELAR_HOME", saved.home], ["TELAR_COCKPIT", saved.cockpit]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function cockpitWithAnotherMac(): Promise<{ hostId: string; seen: { authorization: string | null; cookie: string | null }[] }> {
  const seen: { authorization: string | null; cookie: string | null }[] = [];
  const mac = http.createServer((request, response) => {
    seen.push({ authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url!.endsWith("/stream")) return void response.writeHead(200, { "content-type": "text/event-stream" }).end("data: 1\n\n");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: request.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  await new Promise<void>((resolve) => mac.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => mac.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-hosts-pipe-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  const remoteDir = path.join(home, "remote");
  const host = createHostsStore(remoteDir).add({ baseUrl: `http://127.0.0.1:${(mac.address() as { port: number }).port}`, deviceToken: "tlr_remote", name: "mini" });
  const daemon: EngineDaemon = await startEngine({ engineRoot: path.join(home, "engine"), remoteDir });
  cleanups.push(() => daemon.close());
  return { hostId: host.id, seen };
}

const context = (hostId: string, segments: string[]) => ({ params: Promise.resolve({ hostId, path: segments }) });

test("the cockpit reaches another Mac through its own engine, which alone holds that Mac's token", async () => {
  const { hostId, seen } = await cockpitWithAnotherMac();
  const read = await GET(new Request(`http://cockpit.test/api/hosts/${hostId}/projects/a b?x=1`, { headers: { cookie: "telar_device=local" } }), context(hostId, ["projects", "a b"]));
  expect(await read.json()).toEqual({ path: "/api/projects/a%20b?x=1", body: "" });
  expect(read.headers.get("telar-host")).toBe("mini");
  const write = await POST(new Request(`http://cockpit.test/api/hosts/${hostId}/sessions/s1/turns`, { method: "POST", body: "{\"input\":\"hi\"}" }), context(hostId, ["sessions", "s1", "turns"]));
  expect(((await write.json()) as { body: string }).body).toBe("{\"input\":\"hi\"}");
  expect(await (await GET(new Request(`http://cockpit.test/api/hosts/${hostId}/sessions/s1/run/stream`), context(hostId, ["sessions", "s1", "run", "stream"]))).text()).toBe("data: 1\n\n");
  expect(seen.every((s) => s.authorization === "Bearer tlr_remote" && s.cookie === null)).toBe(true);
  expect((await GET(new Request("http://cockpit.test/api/hosts/host_nope/projects"), context("host_nope", ["projects"]))).status).toBe(404);
});
