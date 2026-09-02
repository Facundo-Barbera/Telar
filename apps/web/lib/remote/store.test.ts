// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addDevice,
  consumePairing,
  hashToken,
  matchDevice,
  mintDeviceToken,
  mintPairing,
  readRemote,
  remoteHome,
  renameDevice,
  revokeDevice,
  revokeOtherDevices,
  RemoteStoreError,
  setDeviceRole,
  setExposure,
  setRequireAuth,
  storePath,
  writeRemote,
  touchDevice,
} from "./store";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;
const roots: string[] = [];

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-remote-"));
  roots.push(home);
  process.env.TELAR_HOME = home;
  process.env.TELAR_COCKPIT = "1";
  return home;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = savedTelarHome;
  if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
  else process.env.TELAR_COCKPIT = savedTelarCockpit;
});

describe("remote store", () => {
  test("a missing file reads as the open default", () => {
    freshHome();
    expect(readRemote()).toEqual({ version: 1, requireAuth: false, devices: [] });
  });

  test("writes are atomic and leave no temp files behind", () => {
    freshHome();
    setRequireAuth(true);
    const dir = path.dirname(storePath());
    expect(fs.readdirSync(dir)).toEqual(["remote.json"]);
    expect(readRemote().requireAuth).toBe(true);
  });

  test("device tokens have the documented shape and never touch disk raw", () => {
    freshHome();
    const raw = mintDeviceToken();
    expect(raw).toMatch(/^tlr_[A-Za-z0-9_-]{43}$/);
    addDevice("Phone", raw);
    const bytes = fs.readFileSync(storePath(), "utf8");
    expect(bytes.includes(raw)).toBe(false);
    expect(bytes.includes(hashToken(raw))).toBe(true);
  });

  test("matchDevice accepts the right token and rejects a near miss", () => {
    freshHome();
    const raw = mintDeviceToken();
    const device = addDevice("Phone", raw);
    expect(matchDevice(readRemote(), raw)?.id).toBe(device.id);
    expect(matchDevice(readRemote(), raw.slice(0, -1) + (raw.endsWith("a") ? "b" : "a"))).toBeUndefined();
  });

  test("revoking removes the device and its access", () => {
    freshHome();
    const raw = mintDeviceToken();
    const device = addDevice("Phone", raw);
    expect(revokeDevice(device.id)).toBe(true);
    expect(matchDevice(readRemote(), raw)).toBeUndefined();
    expect(revokeDevice(device.id)).toBe(false);
  });

  test("pairing is one-time and expires", () => {
    freshHome();
    const { token } = mintPairing(1000, 600_000);
    // Replay: first consume wins, second meets an empty slot.
    expect(consumePairing(token, 2000)).toBe(true);
    expect(consumePairing(token, 2000)).toBe("none-pending");

    const expired = mintPairing(1000, 600_000);
    expect(consumePairing(expired.token, 601_001)).toBe("expired");
  });

  test("minting a new pairing replaces the pending one", () => {
    freshHome();
    const first = mintPairing(1000);
    const second = mintPairing(2000);
    expect(consumePairing(first.token, 3000)).toBe("mismatch");
    expect(consumePairing(second.token, 3000)).toBe(true);
  });

  test("touchDevice throttles writes and never throws", () => {
    freshHome();
    const raw = mintDeviceToken();
    const device = addDevice("Phone", raw);
    touchDevice(device.id, 100_000);
    expect(readRemote().devices[0].lastSeenAt).toBe(100_000);
    touchDevice(device.id, 130_000); // under the 60s throttle
    expect(readRemote().devices[0].lastSeenAt).toBe(100_000);
    touchDevice(device.id, 170_000);
    expect(readRemote().devices[0].lastSeenAt).toBe(170_000);
    touchDevice("dev_missing", 200_000); // no-op, no throw
  });

  test("remoteHome applies the launcher discipline", () => {
    delete process.env.TELAR_COCKPIT;
    process.env.TELAR_HOME = "/tmp/telar-x";
    expect(() => remoteHome()).toThrow(RemoteStoreError);

    process.env.TELAR_COCKPIT = "1";
    process.env.TELAR_HOME = "relative/home";
    expect(() => remoteHome()).toThrow("absolute TELAR_HOME");

    process.env.TELAR_HOME = path.join(os.homedir(), ".telar-dev");
    expect(() => remoteHome()).toThrow("legacy");
  });

  test("a file written before roles existed reads every device as full", () => {
    freshHome();
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(
      storePath(),
      JSON.stringify({
        version: 1,
        requireAuth: true,
        devices: [{ id: "dev_old", name: "Old phone", tokenHash: "ab".repeat(32), createdAt: 1 }],
      }),
    );
    const device = readRemote().devices[0];
    expect(device.role).toBe("full");
    expect(device.platform).toBeUndefined();
  });

  test("addDevice records platform and defaults to full", () => {
    freshHome();
    const device = addDevice("Phone", mintDeviceToken(), { platform: "ios" });
    expect(device.role).toBe("full");
    expect(device.platform).toBe("ios");
    expect(readRemote().devices[0].platform).toBe("ios");
  });

  test("renameDevice trims, floors and caps the name", () => {
    freshHome();
    const device = addDevice("Phone", mintDeviceToken());
    expect(renameDevice(device.id, "  Facundo's iPhone  ")?.name).toBe("Facundo's iPhone");
    expect(renameDevice(device.id, "   ")?.name).toBe("Unnamed device");
    expect(renameDevice(device.id, "x".repeat(100))?.name).toBe("x".repeat(64));
    expect(renameDevice("dev_missing", "Ghost")).toBeUndefined();
  });

  test("setDeviceRole round-trips, and refuses to demote the last full device while the gate is on", () => {
    freshHome();
    const phone = addDevice("Phone", mintDeviceToken());
    const browser = addDevice("Browser", mintDeviceToken());
    setRequireAuth(true);
    expect(setDeviceRole(browser.id, "observer")?.role).toBe("observer");
    expect(() => setDeviceRole(phone.id, "observer")).toThrow(RemoteStoreError);
    // With the gate off the demotion is harmless and allowed.
    setRequireAuth(false);
    expect(setDeviceRole(phone.id, "observer")?.role).toBe("observer");
    expect(setDeviceRole(phone.id, "full")?.role).toBe("full");
  });

  test("revokeOtherDevices keeps exactly the named device", () => {
    freshHome();
    const keep = addDevice("Phone", mintDeviceToken());
    addDevice("Browser", mintDeviceToken());
    addDevice("Old laptop", mintDeviceToken());
    expect(revokeOtherDevices(keep.id)).toBe(2);
    expect(readRemote().devices.map((device) => device.id)).toEqual([keep.id]);
    expect(revokeOtherDevices(keep.id)).toBe(0);
  });

  test("an unknown version reads as the open default rather than crashing", () => {
    freshHome();
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify({ version: 99, requireAuth: true, devices: [{}] }));
    expect(readRemote()).toEqual({ version: 1, requireAuth: false, devices: [] });
  });
});

describe("where the socket listens", () => {
  test("widening is refused while the gate is off", () => {
    freshHome();
    setRequireAuth(false);
    // Binding every interface with no gate would publish an unauthenticated
    // cockpit onto whatever network this machine is attached to.
    expect(() => setExposure("network-accessible")).toThrow();
    expect(readRemote().exposure).toBe("local-only");
  });

  test("turning the gate off closes the socket too", () => {
    freshHome();
    setRequireAuth(true);
    setExposure("network-accessible");
    expect(readRemote().exposure).toBe("network-accessible");
    setRequireAuth(false);
    expect(readRemote().exposure).toBe("local-only");
  });

  test("anything but the widening value reads as loopback", () => {
    freshHome();
    writeRemote({ version: 1, requireAuth: true, devices: [], exposure: "wide-open" as never });
    // A hand-edited or corrupted field cannot quietly open the socket.
    expect(readRemote().exposure).toBe("local-only");
  });

  test("a file written before this setting existed reads as loopback", () => {
    freshHome();
    writeRemote({ version: 1, requireAuth: true, devices: [] });
    expect(readRemote().exposure).toBe("local-only");
  });
});
