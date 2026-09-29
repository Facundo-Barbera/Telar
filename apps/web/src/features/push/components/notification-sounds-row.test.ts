import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { NOTIFICATION_SOUNDS_VALUES, type NotificationSounds } from "@telar/engine-client";
import { click, flush, mount, stubFetch, installTestDom } from "@/test/dom";
import { SETTINGS_SEARCH_INDEX } from "@/features/settings";
import { NotificationSoundsRow, previewUrl, SOUND_LABELS } from "./notification-sounds-row";

installTestDom();
const realAudio = globalThis.Audio;
afterEach(() => { globalThis.Audio = realAudio; });

async function mountRow(sounds: NotificationSounds) {
  const calls = stubFetch({ "GET /api/mobile/sounds": () => ({ sounds }), "PUT /api/mobile/sounds": () => ({}) });
  const played: string[] = [];
  globalThis.Audio = class { constructor(readonly src: string) {} play() { played.push(this.src); return Promise.resolve(); } } as unknown as typeof Audio;
  const { host, unmount } = await mount(createElement(NotificationSoundsRow));
  await flush(() => Boolean(host.textContent));
  return { host, calls, played, unmount };
}

describe("Notification sounds", () => {
  test("offers the three sets and Off, and search finds the row", () => {
    expect(NOTIFICATION_SOUNDS_VALUES.map((value) => SOUND_LABELS[value])).toEqual(["Hilo", "Armónico", "Felt", "Off"]);
    expect(SETTINGS_SEARCH_INDEX.entries.find((entry) => entry.title === "Notification sounds")?.id).toBe("settings-row-remote-push-notifications-notification-sounds");
  });

  test("the play button previews the chosen set from a file the cockpit serves", async () => {
    const { host, played, unmount } = await mountRow("felt");
    await click(host.querySelector('[aria-label="Play"]')!);
    expect(played).toEqual(["/sounds/telar-felt-done.wav"]);
    for (const set of ["hilo", "armonico", "felt"] as const) expect(existsSync(path.join(import.meta.dir, "../../../../public", previewUrl(set)))).toBe(true);
    unmount();
  });

  test("Off has nothing to preview, and reverting writes Hilo", async () => {
    const { host, calls, played, unmount } = await mountRow("off");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Play"]')?.disabled).toBe(true);
    await click(host.querySelector('[aria-label="Revert to the default"]')!);
    expect(played).toEqual([]);
    expect(calls.filter((call) => call.route.startsWith("PUT")).map((call) => call.body)).toEqual([{ sounds: "hilo" }]);
    expect(host.textContent).toContain("Hilo");
    unmount();
  });
});
