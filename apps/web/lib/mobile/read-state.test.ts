// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET } from "../../app/api/mobile/read-state/route";
import { decideApiAccess } from "../remote/gate";
import { addDevice, hashToken, mintDeviceToken, type DeviceRole, type RemoteFile } from "../remote/store";
import { emitSessionRead, onSessionRead } from "../session-read-events";
import { clearedSessions, parseReadStateIds, READ_STATE_MAX } from "./read-sync";

const RAW = "tlr_" + "a".repeat(43);
const remote = (role: DeviceRole): RemoteFile => ({
  version: 1, requireAuth: true, devices: [{ id: "dev_1", name: "Phone", tokenHash: hashToken(RAW), createdAt: 1, role }],
});
const ask = (pathname: string, method: string, role: DeviceRole, authorization: string | null) =>
  decideApiAccess({ pathname, method, authorization, deviceCookie: null }, remote(role));

describe("marking a session read from the phone is a paired, full-access call", () => {
  test("the receipt route refuses strangers and observers and admits a full device", () => {
    expect(ask("/api/sessions/s1/read", "POST", "full", null)).toEqual({ allow: false, code: "cockpit_unauthorized" });
    expect(ask("/api/sessions/s1/read", "POST", "full", "Bearer tlr_" + "b".repeat(43))).toEqual({ allow: false, code: "cockpit_unauthorized" });
    // A receipt moves the engine's read state for every device: a write.
    expect(ask("/api/sessions/s1/read", "POST", "observer", `Bearer ${RAW}`)).toEqual({ allow: false, code: "cockpit_forbidden" });
    expect(ask("/api/sessions/s1/read", "POST", "full", `Bearer ${RAW}`)).toEqual({ allow: true, deviceId: "dev_1", role: "full" });
  });
  test("the reconcile read is gated too, and is a GET an observer may make", () => {
    expect(ask("/api/mobile/read-state", "GET", "full", null)).toEqual({ allow: false, code: "cockpit_unauthorized" });
    expect(ask("/api/mobile/read-state", "GET", "observer", `Bearer ${RAW}`)).toEqual({ allow: true, deviceId: "dev_1", role: "observer" });
  });
});

const oldHome = process.env.TELAR_HOME, oldCockpit = process.env.TELAR_COCKPIT;
let folder: string | undefined;
afterEach(() => {
  if (oldHome === undefined) delete process.env.TELAR_HOME; else process.env.TELAR_HOME = oldHome;
  if (oldCockpit === undefined) delete process.env.TELAR_COCKPIT; else process.env.TELAR_COCKPIT = oldCockpit;
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe("the reconcile route", () => {
  test("requires pairing even while the global gate is off, and bounds what it is asked", async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-read-state-"));
    process.env.TELAR_HOME = folder; process.env.TELAR_COCKPIT = "1";
    expect((await GET(new Request("http://localhost/api/mobile/read-state?ids=a"))).status).toBe(401);
    const token = mintDeviceToken(); addDevice("Phone", token);
    const asked = (ids: string) => GET(new Request(`http://localhost/api/mobile/read-state?ids=${ids}`, { headers: { authorization: `Bearer ${token}` } }));
    // Refused before the engine is ever asked.
    expect((await asked("")).status).toBe(400);
    expect((await asked("a,b%2Fc")).status).toBe(400);
    expect((await asked(Array.from({ length: READ_STATE_MAX + 1 }, (_, n) => `s${n}`).join(","))).status).toBe(400);
  });
  test("ids parse to a bounded, de-duplicated list of engine ids", () => {
    expect(parseReadStateIds("a,b,a,,c_1-x")).toEqual(["a", "b", "c_1-x"]);
    expect(parseReadStateIds(null)).toBeUndefined();
    expect(parseReadStateIds("a:b")).toBeUndefined();
  });
  test("answers with the engine's read state: read, gone, never blocked, and keeps what it could not read", async () => {
    const sessions: Record<string, { activity: string; lastTurnSequence?: number; lastReadTurnSequence?: number }> = {
      read: { activity: "idle", lastTurnSequence: 3, lastReadTurnSequence: 3 },
      unread: { activity: "idle", lastTurnSequence: 3, lastReadTurnSequence: 2 },
      waiting: { activity: "blocked", lastTurnSequence: 3, lastReadTurnSequence: 3 },
    };
    const cleared = await clearedSessions(["read", "unread", "waiting", "gone", "broken"], async id => {
      if (id === "broken") throw new Error("engine away");
      return sessions[id];
    });
    expect(cleared).toEqual(["read", "gone"]);
  });
});

describe("the desktop hook", () => {
  test("a read reaches every subscriber, a throwing one included, until it unsubscribes", () => {
    const heard: string[] = [];
    const stop = onSessionRead(id => heard.push(id));
    const stopBroken = onSessionRead(() => { throw new Error("subscriber bug"); });
    emitSessionRead("s1");
    stop(); stopBroken();
    emitSessionRead("s2");
    expect(heard).toEqual(["s1"]);
  });
});
