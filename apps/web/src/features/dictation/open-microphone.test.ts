import { describe, expect, test } from "bun:test";
import type { MicrophoneChoice } from "./devices";
import { openMicrophone } from "./open-microphone";

type Plugged = { deviceId: string; label: string };

function mediaWith(plugged: Plugged[], { named = true }: { named?: boolean } = {}) {
  const opened: (string | "default")[] = [];
  let granted = named;
  const media = {
    enumerateDevices: async () =>
      plugged.map(({ deviceId, label }) => ({ kind: "audioinput", deviceId, label: granted ? label : "", groupId: "" }) as MediaDeviceInfo),
    getUserMedia: async ({ audio }: MediaStreamConstraints) => {
      const wanted = typeof audio === "object" ? (audio.deviceId as { exact?: string }).exact : undefined;
      if (wanted !== undefined && !plugged.some((input) => input.deviceId === wanted)) {
        throw Object.assign(new Error("no such device"), { name: "OverconstrainedError" });
      }
      granted = true;
      const device = wanted ?? "default";
      opened.push(device);
      const track = { device, stopped: false, stop: () => void (track.stopped = true) };
      return { device, getTracks: () => [track] } as unknown as MediaStream;
    },
  };
  return { media, opened };
}

const camera = { deviceId: "cam-2", label: "Studio Display Camera" };
const airpods = { deviceId: "airpods", label: "AirPods Pro" };

function remembered() {
  const stored: MicrophoneChoice[] = [];
  return { stored, remember: (choice: MicrophoneChoice) => void stored.push(choice) };
}

describe("the chosen microphone, and no other", () => {
  test("is opened by its exact id, even when the system default is another device", async () => {
    const { media, opened } = mediaWith([airpods, camera]);
    const { stored, remember } = remembered();
    const got = await openMicrophone(media, camera, remember);
    expect(opened).toEqual(["cam-2"]);
    expect(got.fallback).toBeUndefined();
    expect(stored).toEqual([]);
  });

  test("a changed id is re-found by its name and stored", async () => {
    const { media, opened } = mediaWith([airpods, camera]);
    const { stored, remember } = remembered();
    const got = await openMicrophone(media, { deviceId: "cam-old", label: camera.label }, remember);
    expect(opened).toEqual(["cam-2"]);
    expect(got.fallback).toBeUndefined();
    expect(stored).toEqual([{ deviceId: "cam-2", label: camera.label }]);
  });

  test("a missing microphone opens the default and says so by name", async () => {
    const { media, opened } = mediaWith([airpods]);
    const got = await openMicrophone(media, camera, remembered().remember);
    expect(opened).toEqual(["default"]);
    expect(got.fallback).toBe("Studio Display Camera is not connected, so this is recording from the system default.");
  });

  test("a name two inputs share is not a match", async () => {
    const { media, opened } = mediaWith([airpods, { deviceId: "a", label: "USB Mic" }, { deviceId: "b", label: "USB Mic" }]);
    const got = await openMicrophone(media, { deviceId: "gone", label: "USB Mic" }, remembered().remember);
    expect(opened).toEqual(["default"]);
    expect(got.fallback).toContain("USB Mic is not connected");
  });

  test("no choice is the system default, with nothing to say", async () => {
    const { media, opened } = mediaWith([airpods, camera]);
    const got = await openMicrophone(media, undefined, remembered().remember);
    expect(opened).toEqual(["default"]);
    expect(got.fallback).toBeUndefined();
  });
});

describe("before the first grant, when the browser names nothing", () => {
  test("the stored id is tried first", async () => {
    const { media, opened } = mediaWith([airpods, camera], { named: false });
    await openMicrophone(media, camera, remembered().remember);
    expect(opened).toEqual(["cam-2"]);
  });

  test("a stale id is re-found by name once the grant names the inputs, and the default is released", async () => {
    const { media, opened } = mediaWith([airpods, camera], { named: false });
    const { stored, remember } = remembered();
    const got = await openMicrophone(media, { deviceId: "cam-old", label: camera.label }, remember);
    expect(opened).toEqual(["default", "cam-2"]);
    expect((got.stream as unknown as { device: string }).device).toBe("cam-2");
    expect(got.fallback).toBeUndefined();
    expect(stored).toEqual([{ deviceId: "cam-2", label: camera.label }]);
  });

  test("and a device that is really gone keeps the default, said out loud", async () => {
    const { media, opened } = mediaWith([airpods], { named: false });
    const got = await openMicrophone(media, camera, remembered().remember);
    expect(opened).toEqual(["default"]);
    expect(got.fallback).toContain("Studio Display Camera is not connected");
  });
});

test("a refusal that is not about the device is not papered over with the default", async () => {
  const media = {
    enumerateDevices: async () => [],
    getUserMedia: async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    },
  };
  await expect(openMicrophone(media, camera, remembered().remember)).rejects.toMatchObject({ name: "NotAllowedError" });
});
