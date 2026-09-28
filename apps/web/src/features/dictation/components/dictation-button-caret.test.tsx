// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { installDictationFakes, live, knobs, results, Box, mounted, micIn, draftOf, press, pill, dimmed, focusBox } from "./dictation-button-fakes";

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

describe("the badge at the caret", () => {
  test("it is not there until the microphone is actually open", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    expect(pill()).toBeNull();

    const button = micIn(host);
    await press(button);
    expect(pill()).toBeNull();

    live!.open();
    expect(pill()).not.toBeNull();
  });

  test("and it goes away when dictation stops", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    const button = micIn(host);
    await press(button);
    live!.open();
    expect(pill()).not.toBeNull();

    await press(button);
    expect(pill()).toBeNull();
  });

  test("it says which language is being transcribed", async () => {
    knobs.language = "es";
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    expect(pill()?.textContent).toContain("ES");
  });

  test("`multi` says AUTO, which is what the picker calls it", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    expect(pill()?.textContent).toContain("AUTO");
    expect(pill()?.textContent).not.toContain("MULTI");
  });

  test("it follows the caret as words land", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    const before = pill()?.style.left;

    knobs.caretAt = { x: 260, y: 400 };
    live!.say(results("fix the failing", false));

    const after = pill()?.style.left;
    expect(after).not.toBe(before);
    expect(Number.parseFloat(after ?? "")).toBeGreaterThan(Number.parseFloat(before ?? ""));
  });

  test("it is not a control: no pointer events, and nothing for a screen reader", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    expect(pill()?.getAttribute("aria-hidden")).toBe("true");
    expect(pill()?.className).toContain("pointer-events-none");
  });

  test("it is drawn outside the composer, never inside the editable", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();
    const editable = host.querySelector('[data-slot="composer-editor"]');
    expect(editable).not.toBeNull();
    expect(editable?.contains(pill())).toBe(false);
    expect(host.contains(pill())).toBe(false);
  });
});

describe("the words still being revised", () => {
  test("the unconfirmed run is drawn dimmer, and settles when the phrase does", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();

    live!.say(results("fix the failing", false));
    expect(dimmed()?.textContent).toBe("fix the failing");

    live!.say(results("fix the failing test", false));
    expect(dimmed()?.textContent).toBe("fix the failing test");

    live!.say(results("fix the failing test", true));
    expect(dimmed()).toBeNull();
    expect(draftOf(host)).toBe("fix the failing test ");
  });

  test("the draft is the same string with the dim on it or without it", async () => {
    const host = await mounted(<Box kind="session" />);
    focusBox(host);
    await press(micIn(host));
    live!.open();

    live!.say(results("hello there", false));
    expect(draftOf(host)).toBe("hello there ");
    expect(dimmed()).not.toBeNull();
  });

  test("stopping mid-guess leaves the words and takes the dim off them", async () => {
    const host = await mounted(<Box kind="session" />);
    const button = micIn(host);
    await press(button);
    live!.open();

    live!.say(results("half a sentence", false));
    expect(dimmed()).not.toBeNull();

    await press(button);
    expect(draftOf(host)).toBe("half a sentence ");
    expect(dimmed()).toBeNull();
  });

  test("the caret is tinted while the microphone is open, and only then", async () => {
    const host = await mounted(<Box kind="session" />);
    const editable = () => host.querySelector('[data-slot="composer-editor"]');
    expect(editable()?.hasAttribute("data-dictating")).toBe(false);

    const button = micIn(host);
    await press(button);
    live!.open();
    expect(editable()?.hasAttribute("data-dictating")).toBe(true);

    await press(button);
    expect(editable()?.hasAttribute("data-dictating")).toBe(false);
  });
});
