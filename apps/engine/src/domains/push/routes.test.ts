import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineClient } from "@telar/engine-client";
import { matchRoute } from "../../platform/http/router";
import type { Route } from "../../platform/http/route";
import { readPushRecords } from "./push";
import { pushRoutes } from "./routes";
import { stopMobilePushWorker } from "./worker";

const oldHome = process.env.TELAR_HOME, oldKey = process.env.TELAR_APNS_KEY_ID;
let folder: string | undefined;
afterEach(() => {
  stopMobilePushWorker();
  if (oldHome === undefined) delete process.env.TELAR_HOME; else process.env.TELAR_HOME = oldHome;
  if (oldKey === undefined) delete process.env.TELAR_APNS_KEY_ID; else process.env.TELAR_APNS_KEY_ID = oldKey;
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});
function setup() {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mobile-route-"));
  process.env.TELAR_HOME = folder; delete process.env.TELAR_APNS_KEY_ID;
  const routes = pushRoutes({ client: () => ({}) as EngineClient, pairedDevices: () => [{ id: "phone", name: "Phone", role: "full" }] });
  return async (method: Route["method"], pathname: string, body: unknown = {}) => {
    const { route, params } = matchRoute(routes, method, pathname)!;
    return route.handle({ body: body as Record<string, unknown>, params, query: new URLSearchParams() });
  };
}
const input = { hostId: "11111111-1111-1111-1111-111111111111", token: "a".repeat(64), topic: "io.github.novarix.telar", sandbox: true, enabled: true, completions: false, previews: false, mutedSessions: [], activities: [] };

describe("paired mobile push registration", () => {
  test("a registration is stored under the device the path names, whatever the body claims", async () => {
    const call = setup();
    expect((await call("PUT", "/v2/push/devices/phone", { ...input, deviceId: "someone-else" })).status).toBe(200);
    expect(readPushRecords().map((r) => r.deviceId)).toEqual(["phone"]);
  });
  test("rejects invalid registrations", async () => {
    const call = setup();
    expect((await call("PUT", "/v2/push/devices/phone", { ...input, topic: "other.app" })).status).toBe(400);
    expect(readPushRecords()).toEqual([]);
  });
});

describe("Notify on, persisted beside the phones", () => {
  test("defaults to This Mac when active, and a valid choice lands in remote/notify-on.json", async () => {
    const call = setup();
    expect((await call("GET", "/v2/push/notify-on")).body).toEqual({ notifyOn: "mac" });
    expect((await call("PUT", "/v2/push/notify-on", { notifyOn: "both" })).status).toBe(200);
    expect((await call("GET", "/v2/push/notify-on")).body).toEqual({ notifyOn: "both" });
    expect(JSON.parse(fs.readFileSync(path.join(folder!, "remote", "notify-on.json"), "utf8"))).toEqual({ notifyOn: "both" });
  });
  test("anything else is refused and changes nothing", async () => {
    const call = setup();
    for (const body of [{ notifyOn: "watch" }, {}]) expect((await call("PUT", "/v2/push/notify-on", body)).status).toBe(400);
    expect((await call("GET", "/v2/push/notify-on")).body).toEqual({ notifyOn: "mac" });
  });
});
