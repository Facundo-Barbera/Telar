import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { audio, installDictationFakes, knobs, live, micIn, mounted, press, Box } from "./dictation-button-fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  await GlobalRegistrator.unregister();
});

installDictationFakes();

const pending = new Map<number, FrameRequestCallback>();
const realFrame = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
beforeEach(() => {
  let next = 0;
  globalThis.requestAnimationFrame = (callback) => {
    next += 1;
    pending.set(next, callback);
    return next;
  };
  globalThis.cancelAnimationFrame = (id) => void pending.delete(id);
});
afterEach(() => {
  pending.clear();
  globalThis.requestAnimationFrame = realFrame.request;
  globalThis.cancelAnimationFrame = realFrame.cancel;
});

function frames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) callback(0);
  }
}

const glowOf = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>(".dictation-glow-ring")!.parentElement!;
const level = (host: HTMLElement): number => Number(glowOf(host).style.getPropertyValue("--dictation-level") || "NaN");

async function listening(): Promise<HTMLElement> {
  const host = await mounted(<Box kind="session" />);
  await press(micIn(host));
  live!.open();
  return host;
}

describe("the composer's dictation control", () => {
  test("sits between the context ring and send, with nothing dictation-related on the left", async () => {
    const host = await mounted(<Box kind="session" />);
    const buttons = [...host.querySelectorAll("button")];
    const ring = buttons.findIndex((button) => button.getAttribute("aria-label")?.startsWith("Context window"));
    const mic = buttons.indexOf(micIn(host));
    const send = buttons.findIndex((button) => button.getAttribute("aria-label") === "Send");

    expect(ring).toBeGreaterThanOrEqual(0);
    expect(mic).toBe(ring + 1);
    expect(send).toBe(mic + 1);
    expect(host.textContent).not.toContain("Listening");
  });
});

describe("the dictation glow follows the voice", () => {
  test("wraps the message box, while the strip under it steps aside until dictation stops", async () => {
    const host = await listening();
    const foot = host.querySelector<HTMLElement>('[data-slot="composer-foot"]')!;
    expect(glowOf(host).querySelector('[data-slot="composer-editor"]')).not.toBeNull();
    expect(glowOf(host).contains(foot)).toBe(false);
    expect(host.querySelector(".dictation-glow-ring")!.getAttribute("data-phase")).toBe("listening");
    expect(foot.hasAttribute("inert")).toBe(true);

    await press(micIn(host));
    expect(foot.hasAttribute("inert")).toBe(false);
  });

  test("stays calm in silence and rises while the person speaks", async () => {
    const host = await listening();
    audio.amplitude = 0.0005;
    frames(30);
    expect(level(host)).toBe(0);

    audio.amplitude = 0.1;
    frames(30);
    expect(level(host)).toBeGreaterThan(0.5);

    audio.amplitude = 0;
    frames(60);
    expect(level(host)).toBeLessThan(0.1);
  });

  test("stopping releases the audio nodes and drops the level", async () => {
    const host = await listening();
    audio.amplitude = 0.1;
    frames(5);
    await press(micIn(host));

    expect(audio.contexts.length).toBe(1);
    expect(audio.contexts[0]!.closed).toBe(true);
    expect(glowOf(host).style.getPropertyValue("--dictation-level")).toBe("");
    expect(pending.size).toBe(0);
  });

  test("under reduced motion the glow stays static and no meter opens", async () => {
    knobs.reducedMotion = true;
    const host = await listening();
    frames(5);
    expect(audio.contexts.length).toBe(0);
    expect(glowOf(host).style.getPropertyValue("--dictation-level")).toBe("");
  });
});
