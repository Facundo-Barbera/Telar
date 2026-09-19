/**
 * THE MICROPHONE PICKER'S FOUR AWKWARD STATES (#643).
 *
 * None of them needs a microphone, and each of them is a way the naive version
 * lies to the reader: a list of blanks before the first grant, a stored hash
 * where a name should be, a choice silently forgotten when a headset is
 * unplugged, and an `exact` constraint that fails the press instead of falling
 * back. The store is a `Map` standing in for `localStorage`, so the persistence
 * rules are checked without a DOM.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  audioConstraints,
  audioInputs,
  connected,
  labelsWithheld,
  microphoneOptions,
  microphoneSnapshot,
  microphoneStatus,
  readMicrophone,
  writeMicrophone,
} from "./devices";

/** `localStorage`, as much of it as this module touches. */
function store(initial?: Record<string, string>) {
  const held = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
    read: () => held,
  };
}

/** A `MediaDeviceInfo` as much as this module reads one. */
const device = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo =>
  ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;

describe("what the browser hands over, turned into a list worth showing", () => {
  test("outputs are dropped, and so is the `default` alias the picker already offers", () => {
    const inputs = audioInputs([
      device("audioinput", "default", "Default — MacBook Pro Microphone"),
      device("audioinput", "abc123", "MacBook Pro Microphone"),
      device("audiooutput", "out1", "MacBook Pro Speakers"),
      device("videoinput", "cam1", "FaceTime HD Camera"),
    ]);
    // The alias and the device it points at would otherwise be two rows meaning
    // one thing, above a "System default" option that is a third.
    expect(inputs).toEqual([{ deviceId: "abc123", label: "MacBook Pro Microphone" }]);
  });

  test("an unnamed input is dropped rather than rendered as a blank row", () => {
    // THE PRE-GRANT STATE. `enumerateDevices` reports one entry per input with
    // an empty label — the count leaks, the names do not — and three identical
    // blank rows is a control nobody can use.
    const devices = [device("audioinput", "a", ""), device("audioinput", "b", "")];
    expect(audioInputs(devices)).toEqual([]);
    expect(labelsWithheld(devices)).toBe(true);
  });

  test("and 'withheld' is not the same as 'no microphones'", () => {
    // Nothing at all is not a permission problem, and saying it was would send
    // somebody to a browser dialog that will not help.
    expect(labelsWithheld([])).toBe(false);
    expect(labelsWithheld([device("audioinput", "a", "Named")])).toBe(false);
  });
});

describe("the constraint degrades rather than failing", () => {
  test("a choice rides as `ideal`, never `exact`", () => {
    // `exact` is an OverconstrainedError when the headset is in a bag: the press
    // fails outright. `ideal` records on whatever is actually there.
    expect(audioConstraints({ deviceId: "abc123", label: "AirPods Pro" })).toEqual({ deviceId: { ideal: "abc123" } });
  });

  test("and no choice is the plain `true` this hook always opened with", () => {
    expect(audioConstraints(undefined)).toBe(true);
    // An empty id is the system-default option's value, not a device.
    expect(audioConstraints({ deviceId: "", label: "" })).toBe(true);
  });
});

describe("a choice survives the device going away", () => {
  const inputs = [{ deviceId: "built-in", label: "MacBook Pro Microphone" }];
  const gone = { deviceId: "airpods", label: "AirPods Pro" };

  test("the row says so by NAME, because the id is a hash that says nothing", () => {
    expect(connected(gone, inputs)).toBe(false);
    expect(microphoneStatus(gone, inputs)).toEqual({ gone: true, label: "AirPods Pro" });
  });

  test("it stays in the list, so the control does not show a choice nobody made", () => {
    const options = microphoneOptions(gone, inputs);
    expect(options[0]).toEqual({ value: "", label: "System default" });
    expect(options.at(-1)).toEqual({ value: "airpods", label: "AirPods Pro (not connected)" });
    // AND THE VALUE IS IN THE LIST, which is #318's bug: a `Dropdown` whose
    // value matches no option renders the raw string — a 64-character hash where
    // a device name belongs.
    expect(options.some((option) => option.value === gone.deviceId)).toBe(true);
  });

  test("an empty list is not evidence of anything, so nothing is claimed", () => {
    // Before the first grant the browser names nothing at all. Calling the
    // chosen device disconnected there would mark every fresh page load as a
    // fault.
    expect(microphoneStatus(gone, [])).toBeUndefined();
    // The option is still appended — the trigger has to have something to draw —
    // just without the claim.
    expect(microphoneOptions(gone, []).at(-1)).toEqual({ value: "airpods", label: "AirPods Pro" });
  });

  test("and a connected choice earns no word on the row at all", () => {
    expect(microphoneStatus(inputs[0], inputs)).toBeUndefined();
    expect(microphoneStatus(undefined, inputs)).toBeUndefined();
  });
});

describe("what is stored, and what is refused", () => {
  test("the label is kept beside the id — that is what makes the sentence possible", () => {
    const held = store();
    writeMicrophone({ deviceId: "airpods", label: "AirPods Pro" }, held);
    expect(readMicrophone(held)).toEqual({ deviceId: "airpods", label: "AirPods Pro" });
  });

  test("the system default is a removal, not a stored answer of 'no answer'", () => {
    const held = store();
    writeMicrophone({ deviceId: "airpods", label: "AirPods Pro" }, held);
    writeMicrophone(undefined, held);
    expect(readMicrophone(held)).toBeUndefined();
    expect(held.read().size).toBe(0);
    // And the empty id the default option carries is the same thing.
    writeMicrophone({ deviceId: "", label: "" }, held);
    expect(held.read().size).toBe(0);
  });

  test("a shape from devtools or an older build costs the choice and nothing else", () => {
    for (const raw of ["not json", "null", "[]", '{"deviceId":42}', '{"label":"only a label"}', '{"deviceId":""}']) {
      expect(readMicrophone(store({ "telar:dictation-microphone:v1": raw }))).toBeUndefined();
    }
  });

  test("a missing label reads as empty rather than as undefined, so the pane can still name it", () => {
    // The row falls back to "Chosen microphone" on an empty label; `undefined`
    // there would be `undefined` printed into a sentence.
    expect(readMicrophone(store({ "telar:dictation-microphone:v1": '{"deviceId":"abc"}' }))).toEqual({ deviceId: "abc", label: "" });
    expect(microphoneOptions({ deviceId: "abc", label: "" }, [{ deviceId: "x", label: "X" }]).at(-1)).toEqual({
      value: "abc",
      label: "Chosen microphone (not connected)",
    });
  });

  test("no storage at all is not a crash — a browser tab with storage blocked still dictates", () => {
    expect(readMicrophone(undefined)).toBeUndefined();
    expect(() => writeMicrophone({ deviceId: "a", label: "A" }, undefined)).not.toThrow();
  });
});

/**
 * THE SNAPSHOT, AND THE RENDER THAT SAID THE WRONG THING (#643).
 *
 * The picker first loaded the stored choice in an effect, deferred a tick. That
 * tick is a real defect and not merely a slower path: the microphone section
 * mounts only once the engine has answered with a provider, so its deferred read
 * lands two renders after the pane's — and in between, the row states "System
 * default" over a choice somebody made. CI rendered exactly that intermediate
 * state and failed on it.
 *
 * `localStorage` is synchronous, so the fix is to read it synchronously. The only
 * thing that makes `useSyncExternalStore` safe over a parser is a stable
 * identity, which is what these pin.
 */
describe("read synchronously, and the same object until the text changes", () => {
  test("two reads of one stored value are the SAME object, or React would loop forever", () => {
    const held = store({ "telar:dictation-microphone:v1": '{"deviceId":"airpods","label":"AirPods Pro"}' });
    const first = microphoneSnapshot(held);
    expect(microphoneSnapshot(held)).toBe(first);
    expect(first).toEqual({ deviceId: "airpods", label: "AirPods Pro" });
  });

  test("and a different value is a different object, or the picker would never update", () => {
    const held = store();
    expect(microphoneSnapshot(held)).toBeUndefined();
    writeMicrophone({ deviceId: "built-in", label: "MacBook Pro Microphone" }, held);
    expect(microphoneSnapshot(held)).toEqual({ deviceId: "built-in", label: "MacBook Pro Microphone" });
    writeMicrophone(undefined, held);
    expect(microphoneSnapshot(held)).toBeUndefined();
  });

  test("a value written by another window is picked up, not served from the cache", () => {
    // The `storage` event carries no value this module trusts — the snapshot
    // re-reads the text every call and only the PARSE is cached.
    const held = store();
    microphoneSnapshot(held);
    held.read().set("telar:dictation-microphone:v1", '{"deviceId":"usb","label":"Scarlett Solo"}');
    expect(microphoneSnapshot(held)).toEqual({ deviceId: "usb", label: "Scarlett Solo" });
  });

  test("a storage that throws answers the system default rather than taking the pane down", () => {
    // Safari in a private window with a cross-origin frame on the page. A
    // preference is not worth a blank settings pane.
    const hostile = {
      getItem: () => {
        throw new Error("The operation is insecure.");
      },
    };
    expect(microphoneSnapshot(hostile)).toBeUndefined();
  });
});
