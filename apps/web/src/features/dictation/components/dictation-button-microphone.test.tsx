import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { audio, installDictationFakes, live, micIn, mounted, noticeTextIn, press, Box } from "./dictation-button-fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  await GlobalRegistrator.unregister();
});

installDictationFakes();

const airpods = { deviceId: "airpods", label: "AirPods Pro" };
const camera = { deviceId: "cam-2", label: "Studio Display Camera" };

let asked: MediaStreamConstraints[] = [];

function plugged(inputs: { deviceId: string; label: string }[]): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => inputs.map((input) => ({ kind: "audioinput", groupId: "", ...input })),
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        asked.push(constraints);
        const wanted = typeof constraints.audio === "object" ? (constraints.audio.deviceId as { exact?: string }).exact : undefined;
        if (wanted !== undefined && !inputs.some((input) => input.deviceId === wanted)) {
          throw Object.assign(new Error("no such device"), { name: "OverconstrainedError" });
        }
        return { getTracks: () => [{ stop: () => {} }] };
      },
    },
  });
}

const choose = (choice: { deviceId: string; label: string }) =>
  window.localStorage.setItem("telar:dictation-microphone:v1", JSON.stringify(choice));

beforeEach(() => {
  asked = [];
  window.localStorage.clear();
});

describe("dictating from the microphone chosen in settings", () => {
  test("opens that microphone by its exact id, once, and the glow reads the same stream", async () => {
    plugged([airpods, camera]);
    choose(camera);
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    live!.open();

    expect(asked).toEqual([{ audio: { deviceId: { exact: "cam-2" } } }]);
    expect(micIn(host).getAttribute("aria-label")).toBe("Stop dictating");
    expect(audio.contexts.length).toBeGreaterThan(0);
    expect(asked).toHaveLength(1);
    expect(noticeTextIn(host)).toBe("");
  });

  test("a chosen microphone that is gone is said over the button, not silently swapped", async () => {
    plugged([airpods]);
    choose(camera);
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    live!.open();

    expect(noticeTextIn(host)).toContain("Studio Display Camera is not connected");
    expect(noticeTextIn(host)).toContain("system default");
    expect(micIn(host).getAttribute("aria-label")).toBe("Stop dictating");
  });
});
