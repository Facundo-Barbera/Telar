import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { forgetModifierPlatform, modifierHeldAfter, modifierHeldSnapshot, subscribeModifierHeld } from "./modifier-held";

describe("the rule, as a fold", () => {
  const field = { tagName: "INPUT" };
  const editor = { isContentEditable: true };
  const body = { tagName: "BODY" };

  test("the platform's OWN command key, not either of them", () => {
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", body)).toBe(true);
    expect(modifierHeldAfter({ type: "keydown", ctrlKey: true }, "other", body)).toBe(true);
    expect(modifierHeldAfter({ type: "keydown", ctrlKey: true }, "mac", body)).toBe(false);
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "other", body)).toBe(false);
  });

  test("a release is a release", () => {
    expect(modifierHeldAfter({ type: "keyup", metaKey: false }, "mac", body)).toBe(false);
  });

  test("nothing is held while a text field or a contenteditable has focus", () => {
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", field)).toBe(false);
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", editor)).toBe(false);
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", { tagName: "TEXTAREA" })).toBe(false);
  });

  test("blur and a hidden tab clear it even with the modifier flag still set", () => {
    expect(modifierHeldAfter({ type: "blur", metaKey: true }, "mac", body)).toBe(false);
    expect(modifierHeldAfter({ type: "visibilitychange", metaKey: true }, "mac", body)).toBe(false);
  });
});

describe("the store, driven", () => {
  let unregister: (() => Promise<void>) | undefined;
  let unsubscribe: (() => void) | undefined;

  const mount = async () => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    unregister = () => GlobalRegistrator.unregister();
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true });
    forgetModifierPlatform();
    const seen: boolean[] = [];
    unsubscribe = subscribeModifierHeld(() => seen.push(modifierHeldSnapshot()));
    return seen;
  };

  afterEach(async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    await unregister?.();
    unregister = undefined;
  });

  const press = (init: KeyboardEventInit & { type: string }) =>
    document.dispatchEvent(new KeyboardEvent(init.type, { bubbles: true, ...init }));

  test("a press over the page sets it, a release clears it", async () => {
    const seen = await mount();
    press({ type: "keydown", key: "Meta", metaKey: true });
    expect(modifierHeldSnapshot()).toBe(true);
    press({ type: "keyup", key: "Meta", metaKey: false });
    expect(modifierHeldSnapshot()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("a repeat of the same state announces nothing", async () => {
    const seen = await mount();
    press({ type: "keydown", key: "Meta", metaKey: true });
    press({ type: "keydown", key: "k", metaKey: true });
    expect(seen).toEqual([true]);
  });

  test("window blur clears it — the ⌘-Tab case, whose keyup never arrives", async () => {
    await mount();
    press({ type: "keydown", key: "Meta", metaKey: true });
    expect(modifierHeldSnapshot()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(modifierHeldSnapshot()).toBe(false);
  });

  test("a hidden tab clears it too", async () => {
    await mount();
    press({ type: "keydown", key: "Meta", metaKey: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(modifierHeldSnapshot()).toBe(false);
  });

  test("focus in a field keeps it down", async () => {
    await mount();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press({ type: "keydown", key: "Meta", metaKey: true });
    expect(modifierHeldSnapshot()).toBe(false);
  });

  test("the last unsubscribe takes the listeners away and resets the state", async () => {
    await mount();
    press({ type: "keydown", key: "Meta", metaKey: true });
    expect(modifierHeldSnapshot()).toBe(true);
    unsubscribe?.();
    unsubscribe = undefined;
    expect(modifierHeldSnapshot()).toBe(false);
    press({ type: "keydown", key: "Meta", metaKey: true });
    expect(modifierHeldSnapshot()).toBe(false);
  });
});
