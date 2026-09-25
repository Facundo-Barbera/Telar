// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deviceLine, NOTIFY_ON_LABELS, pausedLine, relayHeadline, testLine, type PushRelayStatus } from "./push-notifications-group";
import { DEFAULT_NOTIFY_ON, NOTIFY_ON_VALUES } from "@/lib/mobile/desktop";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";

describe("Notify on", () => {
  test("offers exactly the server's three answers, in the owner's words, default first", () => {
    expect(Object.keys(NOTIFY_ON_LABELS)).toEqual([...NOTIFY_ON_VALUES]);
    expect(Object.values(NOTIFY_ON_LABELS)).toEqual(["This Mac when active", "iPhone only", "Both"]);
    expect(NOTIFY_ON_LABELS[DEFAULT_NOTIFY_ON]).toBe("This Mac when active");
  });

  test("the row is on the Push notifications group and search finds it there", () => {
    const source = readFileSync(new URL("./push-notifications-group.tsx", import.meta.url), "utf8");
    expect(source).toContain('label="Notify on"');
    expect(source).toContain('fetch("/api/mobile/notify"');
    expect(SETTINGS_SEARCH_INDEX.entries.find((entry) => entry.title === "Notify on")?.id).toBe("settings-row-remote-push-notifications-notify-on");
  });
});

/**
 * WHAT THE PANE SAYS ABOUT A PHONE THAT IS NOT RINGING — issues #579 and #584.
 *
 * The line is the whole diagnosis. Before #584 it could say "3 recent failures"
 * about a phone whose token Apple had permanently rejected 627 times, which
 * reads as a bad week rather than as something to act on.
 */
const device = (patch: Partial<PushRelayStatus["devices"][number]> = {}): PushRelayStatus["devices"][number] => ({
  deviceId: "phone", name: "Facundo's iPhone", paired: true, topic: "com.telar.mobile", sandbox: false,
  enabled: true, liveActivities: false, updatedAt: 1000, consecutiveFailures: 0, parked: false, mine: true, ...patch,
});

describe("a phone's line", () => {
  test("a working phone reads as one", () => {
    // `lastDeliveryAt` is seconds, as the record stores it; the line renders ms.
    expect(deviceLine(device({ lastDeliveryAt: 1 }), 61_000)).toBe("Alerts on · last delivery 1m ago");
  });

  test("a rejected token names the status and Apple's own reason", () => {
    const line = deviceLine(device({ lastStatus: 400, lastReason: "BadDeviceToken", consecutiveFailures: 3 }), 0);
    expect(line).toContain("last refused 400 BadDeviceToken");
    expect(line).toContain("3 failures in a row");
  });

  test("a status with no reason still says what it was", () => {
    expect(deviceLine(device({ lastStatus: 503 }), 0)).toContain("last refused 503");
  });

  test("a successful last send is not reported as a refusal", () => {
    expect(deviceLine(device({ lastStatus: 200, lastDeliveryAt: 1 }), 0)).not.toContain("refused");
  });

  test("a parked phone says what un-parks it, because it is a thing to do", () => {
    expect(deviceLine(device({ parked: true, consecutiveFailures: 20 }), 0)).toContain("open Telar on it");
  });

  test("another Mac's phone is not this Mac's fault, and says so first", () => {
    expect(deviceLine(device({ mine: false }), 0).startsWith("registered against another Mac")).toBe(true);
  });
});

describe("the daily budget", () => {
  test("a pause names the time it lifts", () => {
    const at = new Date(2026, 8, 17, 14, 32).getTime();
    expect(pausedLine(at)).toBe(`Push paused until ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    expect(pausedLine(at)).toContain("Push paused until");
  });
});

describe("the header badge", () => {
  test("says which of the two ways this Mac can push, or that it cannot", () => {
    const status = (patch: Partial<PushRelayStatus>): PushRelayStatus => ({ configured: true, relay: true, sandbox: false, devices: [], ...patch });
    expect(relayHeadline(status({}))).toEqual({ label: "Relay configured", ok: true });
    expect(relayHeadline(status({ relay: false }))).toEqual({ label: "APNs key configured", ok: true });
    expect(relayHeadline(status({ configured: false }))).toEqual({ label: "Not configured", ok: false });
    // A phone that registered itself needs nothing provisioned on this Mac.
    expect(relayHeadline(status({ relay: false, v2: true }))).toEqual({ label: "Ready", ok: true });
  });
});

describe("the test notification sent after pairing", () => {
  test("reads as working, or as the exact reason, and says whose refusal it was", () => {
    expect(testLine({ at: 1, status: 200, relay: false })).toBe("Working — test notification delivered");
    expect(testLine({ at: 1, status: 400, reason: "BadDeviceToken", relay: false })).toBe("Apple refused the test notification (400 BadDeviceToken)");
    expect(testLine({ at: 1, status: 401, relay: true })).toBe("Relay refused the test notification (401)");
    expect(testLine({ at: 1, status: 0, relay: true })).toBe("Test notification could not reach the relay");
  });

  test("comes first on the phone's line", () => {
    expect(deviceLine(device({ transport: "v2", test: { at: 1, status: 200, relay: false } }), 0).startsWith("Working")).toBe(true);
  });

  test("a sandbox build is only a problem on v1", () => {
    expect(deviceLine(device({ sandbox: true, transport: "v2" }), 0)).not.toContain("sandbox");
    expect(deviceLine(device({ sandbox: true, transport: "v1" }), 0)).toContain("sandbox build");
  });
});
