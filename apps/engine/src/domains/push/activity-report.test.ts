import { afterEach, describe, expect, test } from "bun:test";
import type http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineClient } from "@telar/engine-client";
import { matchRoute } from "../../platform/http/router";
import { activityReport, tokenFingerprint, type PushRecord } from "./push";
import { pushRoutes } from "./routes";
import { deliverRecord } from "./worker";

const record = (patch: Partial<PushRecord> = {}): PushRecord => ({
  hostId: "12345678-1234-1234-1234-123456789abc", hostName: "Studio", token: "a".repeat(64), pushToStartToken: "b".repeat(64),
  topic: "io.github.novarix.telar", sandbox: false, enabled: false, completions: false, previews: false, liveActivities: true,
  mutedSessions: [], deviceId: "phone", revision: "r1", updatedAt: 0, seen: {}, activitySent: {}, ...patch,
});
const work = { id: "one", title: "Private task", activity: "working", activityAt: 1 };

describe("the report", () => {
  test("names each cause of a missing card", () => {
    expect(activityReport(record({ liveActivities: false })).blocker).toBe("off");
    expect(activityReport(record({ pushToStartToken: undefined })).blocker).toBe("no-start-token");
    expect(activityReport(record())).toEqual({ card: false });
  });

  test("a registered card is a running card", () => {
    const running = record({ card: { token: "c".repeat(64), startedAt: 1 } });
    expect(activityReport(running)).toEqual({ card: true });
  });

  test("every start is recorded with what came back, accepted or refused", async () => {
    let next = (await deliverRecord(record(), [work], async () => ({ status: 200 }), 1000))!;
    expect(activityReport(next).lastStart).toEqual({ at: 1000, status: 200, relay: false, token: tokenFingerprint("b".repeat(64)) });
    expect(tokenFingerprint("b".repeat(64))).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(activityReport(next))).not.toContain("b".repeat(64));
    next = (await deliverRecord(record(), [work], async () => ({ status: 400, reason: "BadDeviceToken" }), 2000))!;
    expect(activityReport(next).lastStart).toMatchObject({ at: 2000, status: 400, reason: "BadDeviceToken", relay: false });
    next = (await deliverRecord(record(), [work], async () => ({ status: 409, relay: true, reason: "not_registered" }), 3000))!;
    expect(activityReport(next).lastStart).toMatchObject({ at: 3000, status: 409, reason: "not_registered", relay: true });
  });
});

describe("to the phone", () => {
  const oldHome = process.env.TELAR_HOME;
  let folder: string | undefined;
  afterEach(() => {
    if (oldHome === undefined) delete process.env.TELAR_HOME; else process.env.TELAR_HOME = oldHome;
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
    delete (globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer;
  });

  test("the registration reply carries the report, so the phone can say why", async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-activity-"));
    process.env.TELAR_HOME = folder;
    (globalThis as { telarMobilePushTimer?: unknown }).telarMobilePushTimer = setTimeout(() => {}, 0);
    const routes = pushRoutes({ client: () => ({}) as EngineClient, pairedDevices: () => [{ id: "phone", name: "Phone", role: "full" }] });
    const { route, params } = matchRoute(routes, "PUT", "/v2/push/devices/phone")!;
    const { deviceId: _, revision: __, updatedAt: ___, seen: ____, activitySent: _____, ...registration } = record({ pushToStartToken: undefined });
    const answer = await route.handle({ body: registration, params, query: new URLSearchParams(), request: {} as http.IncomingMessage, response: {} as http.ServerResponse });
    expect(answer).toEqual({ status: 200, body: { configured: false, activity: { card: false, blocker: "no-start-token" } } });
  });
});
