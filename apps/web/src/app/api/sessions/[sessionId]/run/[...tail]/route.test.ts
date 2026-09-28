// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../../../../../../../engine/src/daemon";
import { GET, POST } from "./route";

const saved = { home: process.env.TELAR_HOME, cockpit: process.env.TELAR_COCKPIT };
let home: string;
let daemon: EngineDaemon;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-run-route-"));
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  daemon = await startEngine({ engineRoot: path.join(home, "engine") });
  const client = new EngineClient(daemon.discovery);
  fs.mkdirSync(path.join(home, "one"));
  await client.registerProject({ id: "project_one", name: "One", root: path.join(home, "one") });
  await client.createSession({ id: "session_one", projectId: "project_one" });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
  for (const [name, value] of [["TELAR_HOME", saved.home], ["TELAR_COCKPIT", saved.cockpit]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const url = (tail: string) => `http://cockpit.test/api/sessions/session_one/run/${tail}`;

describe("the run door", () => {
  test("a verb reaches the engine at the same path and answers with its body", async () => {
    const response = await GET(new Request(url("configs")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configurations: [] });
  });

  test("a tail the engine does not serve is its 404", async () => {
    const response = await POST(new Request(url("nope"), { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  test("a write that names no bytes is refused by the engine", async () => {
    const response = await POST(new Request(url("write"), { method: "POST", body: "{}" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  test("the feed arrives as an event stream, not a buffered body", async () => {
    const abort = new AbortController();
    const response = await GET(new Request(url("stream"), { signal: abort.signal }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const first = await response.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toBe(": open\n\n");
    abort.abort();
  });
});
