import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRemoteStore,
  hashToken,
  matchDevice,
  mintDeviceToken,
  normalisePairingCode,
  PAIRING_MAX_ATTEMPTS,
  RemoteStoreError,
  type RemoteStore,
} from "./store";

const roots: string[] = [];
let store: RemoteStore;

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-remote-"));
  roots.push(home);
  store = createRemoteStore(path.join(home, "remote"));
  return home;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const readRemote = () => store.read();
const writeRemote = (file: Parameters<RemoteStore["write"]>[0]) => store.write(file);
const storePath = () => store.path;
const addDevice = (...args: Parameters<RemoteStore["addDevice"]>) => store.addDevice(...args);
const renameDevice = (id: string, name: string) => store.renameDevice(id, name);
const setDeviceRole = (...args: Parameters<RemoteStore["setDeviceRole"]>) => store.setDeviceRole(...args);
const revokeDevice = (id: string) => store.revokeDevice(id);
const revokeOtherDevices = (id: string) => store.revokeOtherDevices(id);
const touchDevice = (id: string, now: number) => store.touchDevice(id, now);
const mintPairing = (now: number, ttl?: number) => store.mintPairing(now, ttl);
const consumePairing = (raw: string, now: number) => store.consumePairing(raw, now);
const setRequireAuth = (on: boolean) => store.setRequireAuth(on);
const setExposure = (mode: Parameters<RemoteStore["setExposure"]>[0]) => store.setExposure(mode);
const setTailscaleServe = (on: boolean) => store.setTailscaleServe(on);

describe("remote store", () => {
  test("a missing file reads as a FRESH store, which requires pairing", () => {
    freshHome();
    expect(readRemote()).toEqual({ version: 1, requireAuth: true, devices: [] });
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
    const { code } = mintPairing(1000, 600_000);
    expect(consumePairing(code, 2000)).toBe(true);
    expect(consumePairing(code, 2000)).toBe("none-pending");

    const expired = mintPairing(1000, 600_000);
    expect(consumePairing(expired.code, 601_001)).toBe("expired");
  });

  test("minting a new pairing replaces the pending one", () => {
    freshHome();
    const first = mintPairing(1000);
    const second = mintPairing(2000);
    expect(consumePairing(first.code, 3000)).toBe("mismatch");
    expect(consumePairing(second.code, 3000)).toBe(true);
  });

  test("the code is eight digits and pairs however it is spaced", () => {
    freshHome();
    const { code } = mintPairing(1000);
    expect(code).toMatch(/^\d{8}$/);
    expect(normalisePairingCode(`${code.slice(0, 4)} ${code.slice(4)}`)).toBe(code);
    expect(normalisePairingCode(`${code.slice(0, 4)}-${code.slice(4)}`)).toBe(code);
    expect(normalisePairingCode("1234567")).toBeUndefined();
    expect(normalisePairingCode("12345678a")).toBeUndefined();
    expect(consumePairing(`${code.slice(0, 4)} ${code.slice(4)}`, 2000)).toBe(true);
  });

  test("five wrong guesses burn the code, whichever form the guesser tries", () => {
    freshHome();
    const { code } = mintPairing(1000);
    const wrong = code === "00000000" ? "00000001" : "00000000";
    for (let n = 1; n < PAIRING_MAX_ATTEMPTS; n++) {
      expect(consumePairing(n % 2 ? wrong : "tlr_not-it", 2000)).toBe("mismatch");
    }
    expect(consumePairing(wrong, 2000)).toBe("burned");
    expect(consumePairing(code, 2000)).toBe("none-pending");
  });

  test("a pending pairing written by the old build still answers to its long token", () => {
    freshHome();
    const old = mintDeviceToken();
    const file = readRemote();
    file.pairing = { tokenHash: hashToken(old), createdAt: 1000, expiresAt: 601_000 };
    writeRemote(file);
    expect(consumePairing("12345678", 2000)).toBe("mismatch");
    expect(consumePairing(old, 2000)).toBe(true);
  });

  test("tailscale serve is persisted only with pairing on, like exposure", () => {
    freshHome();
    setRequireAuth(false);
    expect(() => setTailscaleServe(true)).toThrow(/pairing/);
    setRequireAuth(true);
    expect(setTailscaleServe(true).tailscaleServe).toBe(true);
    expect(readRemote().tailscaleServe).toBe(true);
    expect(setTailscaleServe(false).tailscaleServe).toBeUndefined();
  });

  test("touchDevice throttles writes and never throws", () => {
    freshHome();
    const raw = mintDeviceToken();
    const device = addDevice("Phone", raw);
    touchDevice(device.id, 100_000);
    expect(readRemote().devices[0].lastSeenAt).toBe(100_000);
    touchDevice(device.id, 130_000);
    expect(readRemote().devices[0].lastSeenAt).toBe(100_000);
    touchDevice(device.id, 170_000);
    expect(readRemote().devices[0].lastSeenAt).toBe(170_000);
    touchDevice("dev_missing", 200_000);
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

  test("an unknown version reads as the OPEN default, unlike a missing file", () => {
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
    expect(readRemote().exposure).toBe("local-only");
  });

  test("a file written before this setting existed reads as loopback", () => {
    freshHome();
    writeRemote({ version: 1, requireAuth: true, devices: [] });
    expect(readRemote().exposure).toBe("local-only");
  });
});
