/**
 * WHICH DICTATION A CHORD REACHES (#588).
 *
 * The claim under test is the one the sibling registry exists for: "the active
 * composer" is answered ONCE, by `lib/composer-registry.ts`, and this map is
 * read with that answer. A second notion of active here would put ⌘D on a box
 * the person is not typing into — silently, and only on the screens where two
 * composers are mounted.
 *
 * `components/dictation-button.test.tsx` holds the other half: that the chord
 * and the button really are one microphone. This is the seam between them.
 */
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import { markComposerActive, registerComposer, type ComposerEntry } from "@/lib/composer-registry";
import { activeDictation, registerDictation, toggleActiveDictation } from "./registry";

/** A composer that is only ever asked which one it is. Every write refuses,
 *  because nothing here writes. */
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

/** Mount a composer and its dictation, and hand back the unmount plus a counter
 *  the toggle bumps. */
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

beforeEach(() => {
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
    // The session screen and the Agent screen are different routes, so this is
    // rare — but it is exactly the case a registry keyed any other way would
    // get wrong, and get wrong invisibly.
    const session = mount("session-box");
    const agent = mount("agent-box");
    live.push(session.unmount, agent.unmount);

    markComposerActive("agent-box");
    toggleActiveDictation();
    expect(agent.pressed()).toBe(1);
    expect(session.pressed()).toBe(0);

    // Focus moves, and so does the chord — the composer registry's answer, not
    // a second copy of it that could disagree.
    markComposerActive("session-box");
    toggleActiveDictation();
    expect(session.pressed()).toBe(1);
    expect(agent.pressed()).toBe(1);
  });

  test("two mounted and nothing focused is no answer, not a guess", () => {
    const session = mount("session-box");
    const agent = mount("agent-box");
    live.push(session.unmount, agent.unmount);
    expect(activeDictation()).toBeUndefined();
    toggleActiveDictation();
    expect(session.pressed()).toBe(0);
    expect(agent.pressed()).toBe(0);
  });
});

describe("a chord with nothing to toggle is silent", () => {
  test("no composer on screen at all", () => {
    expect(activeDictation()).toBeUndefined();
    expect(() => toggleActiveDictation()).not.toThrow();
  });

  test("a composer whose dictation is unavailable — the Mac where it is switched off", () => {
    // The composer is mounted and active; it simply never registered a
    // dictation, which is what `useComposerDictation` does when the provider is
    // `off` or the browser cannot record. The chord finds nothing, exactly as
    // the reader finds no button.
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
    // `toggle` closes over the phase, so it changes identity every time the
    // dictation starts or stops — React runs the PREVIOUS effect's cleanup
    // after the new one has registered, and an unconditional delete there would
    // leave the chord with nothing to press for the rest of the dictation.
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
