// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addDevice, mintDeviceToken, revokeDevice, setDeviceRole } from "../remote/store";
import { GET, PUT } from "../../app/api/mobile/push/route";
import { readPushRecords } from "./push";

const oldHome = process.env.TELAR_HOME, oldCockpit = process.env.TELAR_COCKPIT, oldKey = process.env.TELAR_APNS_KEY_ID;
let folder: string | undefined;
afterEach(() => {
  if (oldHome === undefined) delete process.env.TELAR_HOME; else process.env.TELAR_HOME = oldHome;
  if (oldCockpit === undefined) delete process.env.TELAR_COCKPIT; else process.env.TELAR_COCKPIT = oldCockpit;
  if (oldKey === undefined) delete process.env.TELAR_APNS_KEY_ID; else process.env.TELAR_APNS_KEY_ID = oldKey;
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});
function setup() {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-mobile-route-"));
  process.env.TELAR_HOME = folder; process.env.TELAR_COCKPIT = "1"; delete process.env.TELAR_APNS_KEY_ID;
}
const input = { hostId: "11111111-1111-1111-1111-111111111111", token: "a".repeat(64), topic: "com.telar.mobile", sandbox: true, enabled: true, completions: false, previews: false, mutedSessions: [], activities: [] };
function request(token?: string, body: unknown = input) {
  return new Request("http://localhost/api/mobile/push", { method: "PUT", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("paired mobile push registration", () => {
  test("requires pairing even when the global gate is off", async () => {
    setup(); expect((await PUT(request())).status).toBe(401);
    expect(GET(new Request("http://localhost/api/mobile/push")).status).toBe(401);
  });
  test("cannot register for another device or keep writing after revocation", async () => {
    setup(); const token = mintDeviceToken(); const device = addDevice("Phone", token);
    expect((await PUT(request(token, { ...input, deviceId: "someone-else" }))).status).toBe(200);
    expect(readPushRecords()[0].deviceId).toBe(device.id);
    revokeDevice(device.id);
    expect((await PUT(request(token))).status).toBe(401);
  });
  test("observer cannot enable push or bypass the role gate", async () => {
    // A SECOND FULL DEVICE, because a fresh store requires pairing now (#357)
    // and the store refuses to demote the last full one. That refusal is the
    // right behaviour and has its own test; what this one needs is an observer.
    setup(); addDevice("Mac", mintDeviceToken());
    const token = mintDeviceToken(); const device = addDevice("Viewer", token); setDeviceRole(device.id, "observer");
    expect((await PUT(request(token))).status).toBe(403);
  });
  test("rejects invalid registrations and bounds streamed bodies", async () => {
    setup(); const token = mintDeviceToken(); addDevice("Phone", token);
    expect((await PUT(request(token, { ...input, topic: "other.app" }))).status).toBe(400);
    expect((await PUT(request(token, { padding: "x".repeat(40000) }))).status).toBe(413);
    expect(readPushRecords()).toEqual([]);
  });
});
