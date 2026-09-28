import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function engine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-remote-routes-"));
  roots.push(home);
  const daemon = await startEngine({ models: stubModels, engineRoot: path.join(home, "engine") });
  daemons.push(daemon);
  const call = async (method: string, route: string, body?: unknown, token = daemon.discovery.token) => {
    const response = await fetch(`http://127.0.0.1:${daemon.discovery.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const pair = async (name = "Phone") => {
    const { body } = await call("POST", "/v2/remote/pairing");
    return (await call("POST", "/v2/remote/pair", { code: body.code, name, identity: { kind: "phone" } })).body;
  };
  return { call, pair, file: path.join(home, "remote", "remote.json") };
}

test("every remote route answers only to the engine token", async () => {
  const { call } = await engine();
  for (const [method, route] of [["GET", "/v2/ping"], ["GET", "/v2/remote"], ["POST", "/v2/remote/pairing"], ["POST", "/v2/remote/pair"]] as const) {
    expect((await call(method, route, method === "GET" ? undefined : {}, "wrong")).status).toBe(401);
  }
});

test("a pairing code is eight digits, pairs once, and only its hash reaches the file", async () => {
  const { call, file } = await engine();
  const { body: minted } = await call("POST", "/v2/remote/pairing");
  expect(minted.code).toMatch(/^\d{8}$/);
  expect(minted.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

  const spaced = `${minted.code.slice(0, 4)} ${minted.code.slice(4)}`;
  const paired = await call("POST", "/v2/remote/pair", { code: spaced, name: "Phone", platform: "ios" });
  expect(paired.status).toBe(200);
  expect(paired.body.deviceToken).toMatch(/^tlr_/);

  const replay = await call("POST", "/v2/remote/pair", { code: minted.code, name: "Again" });
  expect(replay).toMatchObject({ status: 401, body: { error: { code: "cockpit_unauthorized", reason: "none-pending" } } });

  const stored = fs.readFileSync(file, "utf8");
  expect(stored.includes(minted.code)).toBe(false);
  expect(stored.includes(paired.body.deviceToken)).toBe(false);
});

test("the fifth wrong guess burns the code", async () => {
  const { call } = await engine();
  const { body: minted } = await call("POST", "/v2/remote/pairing");
  const wrong = minted.code === "00000000" ? "00000001" : "00000000";
  for (let attempt = 1; attempt < 5; attempt++) {
    expect((await call("POST", "/v2/remote/pair", { code: wrong })).body.error.reason).toBe("mismatch");
  }
  expect((await call("POST", "/v2/remote/pair", { code: wrong })).body.error.reason).toBe("burned");
  expect((await call("POST", "/v2/remote/pair", { code: minted.code })).body.error.reason).toBe("none-pending");
});

test("the status lists devices without token material", async () => {
  const { call, pair } = await engine();
  await pair();
  await call("POST", "/v2/remote/pairing");
  const status = await call("GET", "/v2/remote");
  expect(status.body.requireAuth).toBe(true);
  expect(status.body.devices.map((device: { name: string }) => device.name)).toEqual(["Phone"]);
  expect(status.body.pairing.expiresAt).toBeGreaterThan(Date.now());
  expect(JSON.stringify(status.body)).not.toMatch(/tokenHash|tlr_/);
});

test("the last full device cannot be demoted while pairing is required", async () => {
  const { call, pair } = await engine();
  const phone = await pair("Phone");
  const laptop = await pair("Laptop");
  expect((await call("PATCH", `/v2/remote/devices/${laptop.deviceId}`, { role: "observer" })).body.device.role).toBe("observer");
  const last = await call("PATCH", `/v2/remote/devices/${phone.deviceId}`, { role: "observer" });
  expect(last).toMatchObject({ status: 409, body: { error: { code: "cockpit_last_full_device" } } });
  expect((await call("PATCH", `/v2/remote/devices/${phone.deviceId}`, { name: "  The phone  " })).body.device.name).toBe("The phone");
  expect((await call("PATCH", "/v2/remote/devices/dev_missing", { name: "Ghost" })).status).toBe(404);
});

test("revoking others keeps exactly the named device, and revoking one removes it", async () => {
  const { call, pair } = await engine();
  const keep = await pair("Keep");
  await pair("Old");
  const other = await pair("Other");
  expect((await call("DELETE", `/v2/remote/devices/${other.deviceId}`)).status).toBe(200);
  expect((await call("DELETE", `/v2/remote/devices?keep=${keep.deviceId}`)).body.revoked).toBe(1);
  expect((await call("GET", "/v2/remote")).body.devices.map((device: { id: string }) => device.id)).toEqual([keep.deviceId]);
});

test("network exposure needs pairing on, and turning pairing off closes it", async () => {
  const { call } = await engine();
  expect((await call("PATCH", "/v2/remote", { exposure: "network-accessible" })).body.exposure).toBe("network-accessible");
  expect((await call("PATCH", "/v2/remote", { requireAuth: false })).body.requireAuth).toBe(false);
  expect((await call("GET", "/v2/remote")).body.exposure).toBe("local-only");
  expect((await call("PATCH", "/v2/remote", { exposure: "network-accessible" })).status).toBe(400);

  const on = await call("PATCH", "/v2/remote", { requireAuth: true, device: { name: "This Mac", identity: { kind: "desktop" } } });
  expect(on.body).toMatchObject({ requireAuth: true, device: { name: "This Mac" } });
  expect(on.body.deviceToken).toMatch(/^tlr_/);
});

test("a device's last-seen stamp is written by the engine", async () => {
  const { call, pair } = await engine();
  const phone = await pair();
  await call("POST", `/v2/remote/devices/${phone.deviceId}/seen`, {});
  expect((await call("GET", "/v2/remote")).body.devices[0].lastSeenAt).toBeGreaterThan(0);
});
