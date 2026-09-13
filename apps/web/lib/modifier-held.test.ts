/**
 * THE HOLD-⌘ STATE — issue #401.
 *
 * Two halves, tested two ways. `modifierHeldAfter` is the whole rule as a pure
 * fold, so every branch (the platform's own modifier, the focus rule, the two
 * ways a hold is abandoned) is an assertion with no DOM in it. The store around
 * it is driven through real listeners, because what it promises is exactly the
 * thing a fold cannot: that ⌘-Tabbing away does not leave the rail wearing its
 * numbers until something else happens to clear them.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { modifierHeldAfter, modifierHeldSnapshot, subscribeModifierHeld } from "./modifier-held";

describe("the rule, as a fold", () => {
  const field = { tagName: "INPUT" };
  const editor = { isContentEditable: true };
  const body = { tagName: "BODY" };

  test("the platform's OWN command key, not either of them", () => {
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", body)).toBe(true);
    expect(modifierHeldAfter({ type: "keydown", ctrlKey: true }, "other", body)).toBe(true);
    // ⌃ on a Mac is a different modifier with its own bindings; lighting the
    // hints on it would promise chords the keymap does not hold.
    expect(modifierHeldAfter({ type: "keydown", ctrlKey: true }, "mac", body)).toBe(false);
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "other", body)).toBe(false);
  });

  test("a release is a release", () => {
    expect(modifierHeldAfter({ type: "keyup", metaKey: false }, "mac", body)).toBe(false);
  });

  test("nothing is held while a text field or a contenteditable has focus", () => {
    // The composer holds focus nearly all the time here, and ⌘C/⌘V/⌘A over it
    // are the commonest chords anybody presses. Flashing every hint in the
    // window on each of them would make this a flicker rather than an
    // affordance.
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", field)).toBe(false);
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", editor)).toBe(false);
    expect(modifierHeldAfter({ type: "keydown", metaKey: true }, "mac", { tagName: "TEXTAREA" })).toBe(false);
  });

  test("blur and a hidden tab clear it even with the modifier flag still set", () => {
    // ⌘-Tab is a chord whose release this page never sees: focus leaves on the
    // Tab and the ⌘-up is delivered to whatever you switched to.
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
    // A Mac agent, so `metaKey` is the modifier under test. Read once and
    // cached by the module, which is why it is seated before the first press.
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true });
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
    // Announced both times, and only when it actually changed.
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
    // Reset rather than frozen: the next surface to mount a hint must not
    // inherit a hold from whatever was true when the last one went away.
    expect(modifierHeldSnapshot()).toBe(false);
    press({ type: "keydown", key: "Meta", metaKey: true });
    expect(modifierHeldSnapshot()).toBe(false);
  });
});
