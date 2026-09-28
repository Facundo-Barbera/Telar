// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { installDictationFakes, live, tracks, tokenCalls, knobs, Box, mounted, press, chord, unavailableMicIn, noticeTextIn } from "./dictation-button-fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  // React's scheduler reads `window.event` in a queued task; unregistering first throws.
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  await GlobalRegistrator.unregister();
});

installDictationFakes();

describe("whether there is a mic button at all", () => {
  test("no button on a Mac where dictation is off — which is every Mac by default", async () => {
    knobs.provider = "off";
    const host = await mounted(<Box kind="session" />);
    expect(host.querySelector('button[aria-label="Dictate"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Stop dictating"]')).toBeNull();
  });

  test("nothing is even asked for while it is off", async () => {
    knobs.provider = "off";
    await mounted(<Box kind="session" />);
    expect(tokenCalls).toBe(0);
  });

  test("it appears once a provider is chosen", async () => {
    const host = await mounted(<Box kind="session" />);
    expect(host.querySelector('button[aria-label="Dictate"]')).not.toBeNull();
  });
});

describe("a page that cannot be granted a microphone says so", () => {
  beforeEach(() => {
    knobs.secure = false;
    // Off a secure context the browser has no `mediaDevices` at all.
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
  });

  test("the button is drawn, and drawn unavailable", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = unavailableMicIn(host);
    // Not `disabled`: that swallows the click, and the click is how the reason is shown.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  test("the tooltip carries the whole sentence, including the way out", async () => {
    const host = await mounted(<Box kind="session" />);
    const title = unavailableMicIn(host).getAttribute("title") ?? "";
    expect(title).toContain("not a secure context");
    expect(title).toContain("127.0.0.1");
    expect(title).toContain("tunnel");
  });

  test("pressing it says why, where the refusal is already drawn", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(unavailableMicIn(host));
    expect(noticeTextIn(host)).toContain("not a secure context");
  });

  test("and the chord says the same thing, rather than doing nothing", async () => {
    const host = await mounted(<Box kind="session" />);
    expect(await chord()).toBe(true);
    expect(noticeTextIn(host)).toContain("not a secure context");
  });

  test("saying why costs no token and opens no socket", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(unavailableMicIn(host));
    await chord();
    expect(tokenCalls).toBe(0);
    expect(live).toBeUndefined();
    expect(tracks).toHaveLength(0);
  });

  test("a second press is a second refusal, not a repeat of the first", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = unavailableMicIn(host);
    await press(button);
    const first = noticeTextIn(host);
    expect(first).toContain("not a secure context");
    await press(button);
    expect(noticeTextIn(host)).toBe(first);
  });

  test("still nothing at all where nobody asked for dictation", async () => {
    knobs.provider = "off";
    const host = await mounted(<Box kind="session" />);
    expect(host.querySelector('button[aria-label="Dictation unavailable here"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Dictate"]')).toBeNull();
    expect(await chord()).toBe(false);
  });
});

describe("a secure page whose browser still cannot record", () => {
  test("it is told about its browser, not sent to fix a connection that is fine", async () => {
    delete (globalThis as unknown as Record<string, unknown>).MediaRecorder;
    const host = await mounted(<Box kind="session" />);
    const title = unavailableMicIn(host).getAttribute("title") ?? "";
    expect(title).toContain("cannot record audio");
    expect(title).not.toContain("secure context");
  });
});
