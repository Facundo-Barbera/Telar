import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { setChord } from "@/features/commands";
import { installDictationFakes, live, tracks, tokenCalls, knobs, results, Box, mounted, micIn, draftOf, press, chord, focusBox } from "./dictation-button-fakes";

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

describe("the chord and the button are one toggle", () => {
  test("⌘D starts the dictation the button is drawing, and the button says so", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);

    expect(await chord()).toBe(true);
    live!.open();
    expect(button.getAttribute("aria-label")).toBe("Stop dictating");

    live!.say(results("spoken from the keyboard", true));
    expect(draftOf(host)).toBe("spoken from the keyboard ");
  });

  test("started with the chord, stopped with the button", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await chord();
    live!.open();
    const socket = live!;

    await press(button);
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    expect(socket.frames).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(socket.readyState).toBe(3);
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("started with the button, stopped with the chord", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();
    const socket = live!;

    expect(await chord()).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Dictate");
    expect(socket.readyState).toBe(3);
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  test("it fires with the caret in the message box, which is where it is pressed from", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    const editable = host.querySelector('[data-slot="composer-editor"]');
    expect(await chord(editable)).toBe(true);
    live!.open();
    expect(micIn(host).getAttribute("aria-label")).toBe("Stop dictating");
  });

  test("a second press while it is still starting stops it, exactly as the button does", async () => {
    const host = await mounted(<Box kind="session" />);
    await press(micIn(host));
    expect(await chord()).toBe(true);
    expect(micIn(host).getAttribute("aria-label")).toBe("Dictate");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });
});

describe("the chord refuses wherever the button does", () => {
  test("nothing on a Mac where dictation is off — no command, no microphone", async () => {
    knobs.provider = "off";
    const host = await mounted(<Box kind="session" />);
    expect(await chord()).toBe(false);
    expect(tokenCalls).toBe(0);
    expect(live).toBeUndefined();
    expect(host.querySelector('button[aria-label="Dictate"]')).toBeNull();
  });

  test("it never opens a microphone where the browser cannot record", async () => {
    delete (globalThis as unknown as Record<string, unknown>).MediaRecorder;
    await mounted(<Box kind="session" />);
    await chord();
    expect(tokenCalls).toBe(0);
    expect(live).toBeUndefined();
  });

  test("nothing on a screen with no message box on it", async () => {
    expect(await chord()).toBe(false);
  });
});

describe("the tooltip names the chord that is actually bound", () => {
  test("it reads the keymap, and says the same key the chord fires on", async () => {
    const host = await mounted(<Box kind="session" />);
    expect(micIn(host).getAttribute("title")).toBe("Dictate (⌘D) — speak into the message box");
  });

  test("and it says so while listening too, because that press is the one that stops it", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();
    expect(button.getAttribute("title")).toBe("Stop dictating (⌘D)");
  });

  test("a rebind moves the tooltip with it", async () => {
    const host = await mounted(<Box kind="session" />);
    await act(async () => {
      setChord("toggle-dictation", "CommandOrControl+Shift+M");
    });
    expect(micIn(host).getAttribute("title")).toBe("Dictate (⌘⇧M) — speak into the message box");
    expect(await chord()).toBe(false);
    expect(tokenCalls).toBe(0);
  });

  test("an unbound Dictate promises no key at all", async () => {
    const host = await mounted(<Box kind="session" />);
    await act(async () => {
      setChord("toggle-dictation", "");
    });
    expect(micIn(host).getAttribute("title")).toBe("Dictate — speak into the message box");
    await press(micIn(host));
    expect(tokenCalls).toBe(1);
  });
});
