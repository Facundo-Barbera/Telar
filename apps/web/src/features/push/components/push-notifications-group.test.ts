// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { click, flush, mount, stubFetch, installTestDom } from "@/lib/testing/dom";
import { detailLines, deviceLine, NOT_REGISTERED, NOTIFY_ON_LABELS, pausedLine, phoneSummary, PushNotificationsGroup, relayHeadline, testLine, type PushRelayStatus } from "./push-notifications-group";
import { DEFAULT_NOTIFY_ON, NOTIFY_ON_VALUES, type NotifyOn } from "@telar/engine-client";
import { SETTINGS_SEARCH_INDEX } from "@/features/settings/index";

installTestDom();

async function mountPane(status: PushRelayStatus, notifyOn: NotifyOn = "both", saves = true) {
  const calls = stubFetch({
    "GET /api/mobile/relay": () => status,
    "GET /api/mobile/notify": () => ({ notifyOn }),
    "PUT /api/mobile/notify": () => {
      if (!saves) throw new Error("refused");
      return {};
    },
  });
  const { host, unmount } = await mount(createElement(PushNotificationsGroup));
  await flush(() => Boolean(host.textContent));
  return { host, calls, unmount };
}

describe("Notify on", () => {
  test("offers exactly the server's three answers, in the owner's words, default first", () => {
    expect(Object.keys(NOTIFY_ON_LABELS)).toEqual([...NOTIFY_ON_VALUES]);
    expect(Object.values(NOTIFY_ON_LABELS)).toEqual(["This Mac when active", "iPhone only", "Both"]);
    expect(NOTIFY_ON_LABELS[DEFAULT_NOTIFY_ON]).toBe("This Mac when active");
  });

  test("the row shows the stored choice where search points, and reverting writes the default", async () => {
    expect(SETTINGS_SEARCH_INDEX.entries.find((entry) => entry.title === "Notify on")?.id).toBe("settings-row-remote-push-notifications-notify-on");
    for (const saves of [true, false]) {
      const { host, calls, unmount } = await mountPane({ configured: true, devices: [] }, "both", saves);
      expect(host.querySelector('[id$="push-notifications-notify-on"]')?.textContent).toContain("Both");
      await click(host.querySelector('[aria-label="Revert to the default"]')!);
      expect(calls.filter((call) => call.route.startsWith("PUT")).map((call) => call.body)).toEqual([{ notifyOn: "mac" }]);
      // A refused write shows the stored value again, and says so.
      expect(host.textContent).toContain(saves ? "This Mac when active" : "Couldn't save. Try again.");
      expect(host.textContent?.includes("Both")).toBe(!saves);
      unmount();
    }
  });
});

const device = (patch: Partial<PushRelayStatus["devices"][number]> = {}): PushRelayStatus["devices"][number] => ({
  deviceId: "phone", name: "Facundo's iPhone", paired: true, topic: "io.github.novarix.telar", sandbox: false,
  enabled: true, liveActivities: false, updatedAt: 1000, consecutiveFailures: 0, parked: false, transport: "v2", ...patch,
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

  test("a phone that never handed this Mac a key says what finishes it, and nothing else", () => {
    expect(deviceLine(device({ transport: "none", consecutiveFailures: 2, lastStatus: 400 }), 0)).toBe(NOT_REGISTERED);
    expect(NOT_REGISTERED).toBe("This phone hasn't registered for notifications. Open Telar on it to finish.");
    expect(deviceLine(device({ transport: "none", paired: false }), 0)).toContain("no longer paired");
  });
});

describe("the one summary line", () => {
  const status = (...devices: PushRelayStatus["devices"]): PushRelayStatus => ({ configured: true, devices });
  const now = 10 * 3600_000;

  test("counts 0, 1 or n phones", () => {
    expect(phoneSummary(status(), now)).toEqual({ label: "No phone registered yet", ok: true });
    expect(phoneSummary(status(device()), now)).toEqual({ label: "Alerts reach 1 phone", ok: true });
    expect(phoneSummary(status(device(), device({ deviceId: "b" }), device({ deviceId: "c" })), now).label).toBe("Alerts reach 3 phones");
    expect(phoneSummary(status(device({ enabled: false })), now).label).toBe("Alerts are off on your phone");
  });

  test("a failing phone is named in plain words, with no codes", () => {
    const failing = device({ consecutiveFailures: 4, lastStatus: 400, lastReason: "BadDeviceToken" });
    const summary = phoneSummary(status(failing), now);
    expect(summary).toEqual({ label: "Alerts aren't reaching Facundo's iPhone", ok: false });
    expect(phoneSummary(status(failing, device({ ...failing, deviceId: "b" })), now).label).toBe("Alerts aren't reaching 2 phones");
    expect(phoneSummary(status(device({ test: { at: 1, status: 400, reason: "BadDeviceToken", relay: false } })), now).ok).toBe(false);
  });

  test("a Live Activity refusal beside recent deliveries is not a failing phone", () => {
    const busy = device({ consecutiveFailures: 3, lastStatus: 409, lastReason: "not_registered", lastDeliveryAt: now / 1000 - 60 });
    expect(phoneSummary(status(busy), now)).toEqual({ label: "Alerts reach 1 phone", ok: true });
  });

  test("stopped and unpaired registrations are not counted", () => {
    const parked = device({ deviceId: "old", sandbox: true, parked: true, consecutiveFailures: 20, lastStatus: 400 });
    expect(phoneSummary(status(parked, device()), now)).toEqual({ label: "Alerts reach 1 phone", ok: true });
    expect(phoneSummary(status(device({ paired: false })), now).label).toBe("No phone registered yet");
  });

  test("a phone with no key yet is named as unfinished, not as failing", () => {
    expect(phoneSummary(status(device({ transport: "none" })), now)).toEqual({ label: "Facundo's iPhone hasn't finished registering for notifications", ok: false });
    expect(phoneSummary(status(device({ transport: "none" }), device({ deviceId: "b", transport: "none" })), now).label).toBe("2 phones haven't finished registering for notifications");
    // A phone that is failing outranks one that has a step left to do.
    expect(phoneSummary(status(device({ transport: "none" }), device({ deviceId: "b", consecutiveFailures: 2 })), now).label).toBe("Alerts aren't reaching Facundo's iPhone");
  });

  test("details still carry every registration's diagnostics", () => {
    const parked = device({ deviceId: "old", parked: true, consecutiveFailures: 20, lastStatus: 400 });
    const lines = detailLines(status(device(), parked), now);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.name).toContain("stopped");
    expect(lines[1]!.line).toContain("last refused 400");
    expect(lines[1]!.line).toContain("20 failures in a row");
  });
});

describe("the daily budget", () => {
  test("a pause names the time it lifts", () => {
    const at = new Date(2026, 8, 17, 14, 32).getTime();
    expect(pausedLine(at)).toBe(`Push paused until ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  });
});

describe("the header badge", () => {
  test("says whether this Mac can push, and never how it was set up", () => {
    expect(relayHeadline({ configured: true, devices: [] })).toEqual({ label: "Ready", ok: true });
    expect(relayHeadline({ configured: false, devices: [] })).toEqual({ label: "Not ready", ok: false });
  });
});

describe("the pane's copy", () => {
  test("never asks for a relay to be provisioned or a config pasted, and names no vendor", async () => {
    const banned = [/provision/i, /paste/i, /relay host/i, /relay config/i, /\bApple\b/, /APNs/, /Keychain/, /Cloudflare/];
    const failing = [device({ consecutiveFailures: 2 }), device({ deviceId: "b", transport: "none" })];
    for (const status of [{ configured: false, devices: [] }, { configured: true, pausedUntil: Date.now() + 3600_000, devices: failing }]) {
      const { host, unmount } = await mountPane(status);
      const copy = [host.textContent, ...[...host.querySelectorAll("[data-info]")].map((node) => node.getAttribute("data-info"))].join("\n");
      for (const word of banned) expect(copy).not.toMatch(word);
      unmount();
    }
  });
});

describe("the test notification sent after pairing", () => {
  test("reads as working, or as the exact reason, and says whose refusal it was", () => {
    expect(testLine({ at: 1, status: 200, relay: false })).toBe("Working — test notification delivered");
    expect(testLine({ at: 1, status: 400, reason: "BadDeviceToken", relay: false })).toBe("Push service refused the test notification (400 BadDeviceToken)");
    expect(testLine({ at: 1, status: 401, relay: true })).toBe("Relay refused the test notification (401)");
    expect(testLine({ at: 1, status: 0, relay: true })).toBe("Test notification could not reach the relay");
  });

  test("comes first on the phone's line", () => {
    expect(deviceLine(device({ transport: "v2", test: { at: 1, status: 200, relay: false } }), 0).startsWith("Working")).toBe(true);
  });

  test("a sandbox build is not a problem", () => {
    expect(deviceLine(device({ sandbox: true, transport: "v2" }), 0)).not.toContain("sandbox");
    expect(deviceLine(device({ sandbox: true, transport: "direct" }), 0)).not.toContain("sandbox");
  });
});
