import { afterEach, describe, expect, test } from "bun:test";
import { markComposerActive, registerComposer, type ComposerEntry } from "@/features/composer";
import { activeDictation, registerDictation, toggleActiveDictation } from "./registry";

function stubComposer(id: string): ComposerEntry {
  const refused = { ok: false as const, reason: "not a real composer" };
  return {
    id,
    kind: "session",
    draft: () => "",
    focused: () => false,
    insert: () => refused,
    replace: () => refused,
    dictating: () => {},
    caretRect: () => undefined,
    submit: () => refused,
  };
}

function mount(token: string): { unmount: () => void; pressed: () => number; unregisterDictation: () => void } {
  let pressed = 0;
  const offComposer = registerComposer(token, stubComposer(token));
  const offDictation = registerDictation(token, { toggle: () => (pressed += 1) });
  return {
    unmount: () => {
      offDictation();
      offComposer();
    },
    pressed: () => pressed,
    unregisterDictation: offDictation,
  };
}

const live: (() => void)[] = [];

afterEach(() => {
  for (const unmount of live.splice(0)) unmount();
});

describe("the chord reaches the composer being typed into", () => {
  test("the only composer on screen is the answer, focused or not", () => {
    const only = mount("session-box");
    live.push(only.unmount);
    toggleActiveDictation();
    expect(only.pressed()).toBe(1);
  });

  test("with two mounted, the most recently focused one gets it", () => {
    const session = mount("session-box");
    const other = mount("other-box");
    live.push(session.unmount, other.unmount);

    markComposerActive("other-box");
    toggleActiveDictation();
    expect(other.pressed()).toBe(1);
    expect(session.pressed()).toBe(0);

    markComposerActive("session-box");
    toggleActiveDictation();
    expect(session.pressed()).toBe(1);
    expect(other.pressed()).toBe(1);
  });

  test("two mounted and nothing focused is no answer, not a guess", () => {
    const session = mount("session-box");
    const other = mount("other-box");
    live.push(session.unmount, other.unmount);
    expect(activeDictation()).toBeUndefined();
    toggleActiveDictation();
    expect(session.pressed()).toBe(0);
    expect(other.pressed()).toBe(0);
  });
});

describe("a chord with nothing to toggle is silent", () => {
  test("no composer on screen at all", () => {
    expect(activeDictation()).toBeUndefined();
    expect(() => toggleActiveDictation()).not.toThrow();
  });

  test("a composer whose dictation is unavailable — the Mac where it is switched off", () => {
    const box = mount("session-box");
    live.push(box.unmount);
    box.unregisterDictation();
    markComposerActive("session-box");
    expect(activeDictation()).toBeUndefined();
    toggleActiveDictation();
    expect(box.pressed()).toBe(0);
  });

  test("an unmounted composer takes its dictation with it", () => {
    const box = mount("session-box");
    markComposerActive("session-box");
    box.unmount();
    expect(activeDictation()).toBeUndefined();
  });
});

describe("re-registering under one token", () => {
  test("the live toggle wins, and the old registration's cleanup does not drop it", () => {
    // React runs the previous effect's cleanup after the new registration, so cleanup must not drop it.
    const offComposer = registerComposer("session-box", stubComposer("session-box"));
    live.push(offComposer);
    let first = 0;
    let second = 0;
    const offFirst = registerDictation("session-box", { toggle: () => (first += 1) });
    live.push(registerDictation("session-box", { toggle: () => (second += 1) }));
    offFirst();

    toggleActiveDictation();
    expect(second).toBe(1);
    expect(first).toBe(0);
  });
});
