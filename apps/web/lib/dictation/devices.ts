/**
 * WHICH MICROPHONE, AND WHY THE ANSWER LIVES ON THIS DEVICE (#643).
 *
 * Dictation took whatever the OS handed it as default input. On a Mac with a
 * headset, an interface, a webcam mic and the built-in, that is a coin toss, and
 * the only way to change it was to change the system default — for every app at
 * once.
 *
 * ── NOT ENGINE STATE, WHICH IS THE ONE DEPARTURE FROM THE PANE AROUND IT ─────
 * Everything else on the Dictation pane is a fact about the MAC and is stored
 * with its engine state: the provider, the key, the language, the vocabulary —
 * one answer that the desktop shell, a browser tab and a paired phone all read.
 * A microphone is not that. The headset is plugged into ONE machine, the ids
 * below are minted per browser profile and per origin, and a phone has no
 * `deviceId` vocabulary at all. Stored with the engine, a choice made here would
 * arrive on the phone as a hash naming nothing, and the phone would overwrite it
 * with a hash naming nothing back.
 *
 * So it is `localStorage`, deliberately: per browser profile, per origin, never
 * replicated. `lib/model-favorites.ts` describes the inverse move for the
 * inverse reason — a star that had to mean the same thing everywhere.
 *
 * ── THE ID IS NOT AN IDENTITY, SO THE LABEL IS STORED BESIDE IT ─────────────
 * `deviceId` is stable for one origin in one profile and meaningless outside it,
 * and it changes when a device is re-plugged into another port. A pane holding
 * only the id can say nothing useful when the device is absent — it would draw a
 * 64-character hash, or silently show "Default" as though nobody had chosen. The
 * label is what makes "AirPods Pro — not connected, using the system default" a
 * sentence, so both halves are kept and the label is never used for MATCHING.
 *
 * ── AND THE CONSTRAINT IS `ideal`, NEVER `exact` ────────────────────────────
 * `exact` makes an unplugged headset an `OverconstrainedError`: the press fails,
 * no audio, a sentence about a constraint. `ideal` degrades to whatever the OS
 * has, which is what a person who walked away from their desk wants — and the
 * pane says so on the row rather than letting it be a silent substitution.
 *
 * ── LABELS ARE EMPTY UNTIL A GRANT, AND THAT IS HANDLED RATHER THAN SHOWN ───
 * Before the first microphone grant `enumerateDevices` answers one entry per
 * input with `label: ""` — the count leaks, the names do not. A picker rendering
 * those is a list of blanks. `audioInputs` drops them and `labelsWithheld` is
 * how the pane knows to say why the list is short instead.
 */

/** The microphone somebody chose, as it is stored. */
export type MicrophoneChoice = {
  /** The browser's own id for the input. Per-origin, per-profile, and not an
   *  identity — see the header. */
  deviceId: string;
  /** What it was called when it was chosen, for the sentence the pane says when
   *  the id matches nothing now. Never used to match. */
  label: string;
};

/** One input the browser is willing to name. */
export type AudioInput = { deviceId: string; label: string };

/** Per browser profile, per origin. `:v1` so a change of shape can retire the
 *  stored value rather than mis-reading it. */
const KEY = "telar:dictation-microphone:v1";

/**
 * What is stored, or nothing — and nothing means the system default, which is
 * also what every Mac answers until somebody chooses.
 *
 * NEVER THROWS AND NEVER TRUSTS THE SHAPE. This is a key a person can edit in
 * devtools and a key an older build may have written; a bad value costs the
 * choice, never the dictation.
 */
export function readMicrophone(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): MicrophoneChoice | undefined {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { deviceId, label } = parsed as Partial<MicrophoneChoice>;
    // AN EMPTY `deviceId` IS NOT A CHOICE. It is what the system-default option
    // carries, and storing it would be a stored answer of "no answer".
    if (typeof deviceId !== "string" || deviceId === "") return undefined;
    return { deviceId, label: typeof label === "string" ? label : "" };
  } catch {
    return undefined;
  }
}

/** Store a choice, or clear it back to the system default. */
export function writeMicrophone(
  choice: MicrophoneChoice | undefined,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage(),
): void {
  try {
    if (choice === undefined || choice.deviceId === "") storage?.removeItem(KEY);
    else storage?.setItem(KEY, JSON.stringify(choice));
  } catch {
    // A full or blocked store costs the preference for this session and nothing
    // else — the dictation still runs on the system default.
  }
  // AFTER THE WRITE, WHETHER OR NOT IT LANDED. Every listener re-reads the store
  // rather than being handed the value, so a refused write tells the picker to
  // show what is actually there — the same rule every row on this pane follows
  // with the engine.
  for (const listener of [...listeners]) listener();
}

/**
 * THE STORED CHOICE, AS A SNAPSHOT `useSyncExternalStore` CAN HOLD — and why the
 * pane reads it this way rather than loading it in an effect.
 *
 * `readMicrophone` builds a fresh object per call, which `useSyncExternalStore`
 * would take for a new value on every render and loop forever. So the parsed
 * answer is cached against the RAW string it was parsed from: same text, same
 * object identity, and a write of any kind produces a different text.
 *
 * WHY NOT AN EFFECT. The first cut of the picker loaded this in one, deferred a
 * tick to avoid setting state from an effect body — and that tick is a real bug,
 * not just a slower path. The microphone section mounts only once the engine has
 * answered with a provider, so its own deferred read lands two renders after the
 * pane's, and until it does the row shows "System default" over a choice somebody
 * made. A person watching would see the picker flick from Default to their
 * headset; CI saw the render in between and failed on it, which is the honest way
 * to find out. Reading `localStorage` is synchronous, so nothing is gained by
 * waiting: this is the same `useSyncExternalStore` answer `use-dictation.ts`
 * gives for `supported`, for the same reason — a question about `window`,
 * answered without a cascade and without a render that states the wrong thing.
 */
export function microphoneSnapshot(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): MicrophoneChoice | undefined {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  if (cached === undefined || cached.raw !== raw) cached = { raw, choice: readMicrophone(storage) };
  return cached.choice;
}

/** Whoever is drawing the picker. A `Set` so a double-mounted component (dev
 *  StrictMode) does not register twice. */
const listeners = new Set<() => void>();

/** The parsed answer, held against the text it came from — see
 *  `microphoneSnapshot`. */
let cached: { raw: string | null; choice: MicrophoneChoice | undefined } | undefined;

/**
 * Be told when the choice changes.
 *
 * `storage` AS WELL AS OUR OWN WRITES, because this key is per browser profile
 * and a person may have Settings open in two windows of it. The event does not
 * fire in the window that wrote, which is exactly why `writeMicrophone` notifies
 * directly as well.
 */
export function subscribeMicrophone(listener: () => void): () => void {
  listeners.add(listener);
  const fromAnotherWindow = (event: StorageEvent): void => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener("storage", fromAnotherWindow);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromAnotherWindow);
  };
}

/**
 * The `audio` half of the `getUserMedia` constraints for a choice.
 *
 * `ideal` RATHER THAN `exact` — see the header. `true` when nobody has chosen,
 * which is the constraint this hook opened with before the picker existed, so an
 * unchosen microphone behaves exactly as it always did.
 */
export function audioConstraints(choice: MicrophoneChoice | undefined): MediaStreamConstraints["audio"] {
  return choice?.deviceId ? { deviceId: { ideal: choice.deviceId } } : true;
}

/**
 * The inputs worth putting in a picker: audio, and named.
 *
 * THE UNNAMED ONES ARE DROPPED rather than rendered as blanks or as "Microphone
 * 2" — a browser that has not granted the microphone yet reports every input
 * with an empty label, and a list of three identical blank rows is a control
 * that cannot be used. `labelsWithheld` is what says so in words instead.
 *
 * AND SO IS THE BROWSER'S OWN "default" PSEUDO-DEVICE, which is not a microphone
 * but an alias for whatever the OS has chosen — the picker already offers that
 * as its first option, and a second copy of it under the name "Default —
 * MacBook Pro Microphone" is two rows meaning one thing.
 */
export function audioInputs(devices: readonly MediaDeviceInfo[]): AudioInput[] {
  return devices
    .filter((device) => device.kind === "audioinput" && device.label !== "" && device.deviceId !== "" && device.deviceId !== "default")
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/**
 * Whether the browser is withholding the names — there are inputs, and none of
 * them is named. That is the pre-grant state, and it is the reason the pane
 * offers the system default and a sentence rather than an empty list.
 */
export function labelsWithheld(devices: readonly MediaDeviceInfo[]): boolean {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return inputs.length > 0 && inputs.every((device) => device.label === "");
}

/** Whether the stored choice is one of the inputs the browser can see now. A
 *  headset unplugged since it was chosen is not. */
export function connected(choice: MicrophoneChoice | undefined, inputs: readonly AudioInput[]): boolean {
  return choice !== undefined && inputs.some((input) => input.deviceId === choice.deviceId);
}

/**
 * WHAT THE ROW SAYS ABOUT ITS OWN STATE, or nothing when there is nothing to
 * say.
 *
 * Three cases and only the third is a word on the row: nobody has chosen; the
 * chosen device is here; the chosen device is gone. The last one names the thing
 * by the label it had — "AirPods Pro" — because the id it is missing by is a
 * hash that would tell the reader nothing.
 *
 * THE LIST BEING EMPTY IS NOT "GONE". Before a grant the browser names nothing
 * at all, so a choice made after an earlier grant would read as disconnected on
 * every fresh load. Silence there is the honest answer; the pane says why the
 * list is short separately.
 */
export function microphoneStatus(
  choice: MicrophoneChoice | undefined,
  inputs: readonly AudioInput[],
): { gone: true; label: string } | undefined {
  if (choice === undefined || inputs.length === 0 || connected(choice, inputs)) return undefined;
  return { gone: true, label: choice.label || "The chosen microphone" };
}

/**
 * The options for the picker, system default first.
 *
 * THE DEFAULT IS A MEMBER RATHER THAN AN ABSENT CHOICE, which is the provider
 * row's own reasoning: "nobody has chosen" and "chosen: the system default" are
 * the same state, and one name for it means the control never holds an empty
 * value.
 *
 * A CHOICE THE LIST DOES NOT CONTAIN IS APPENDED TO IT, ALWAYS — and this is
 * load-bearing twice over. Dropping it would move the control to "System
 * default" and show a choice nobody made, forgetting the headset the moment it
 * was unplugged. It would also leave the trigger rendering a VALUE no option
 * maps, which is #318's bug: a `Dropdown` with no matching option draws the raw
 * string, so the row would read as a 64-character hash.
 *
 * NAMED "(not connected)" ONLY WHEN THE BROWSER IS NAMING DEVICES AT ALL. With
 * an empty list nothing is known to be absent — that is the pre-grant state, not
 * an unplugged headset — so the stored name stands on its own there.
 */
export function microphoneOptions(
  choice: MicrophoneChoice | undefined,
  inputs: readonly AudioInput[],
): { value: string; label: string }[] {
  const options = [{ value: "", label: "System default" }, ...inputs.map((input) => ({ value: input.deviceId, label: input.label }))];
  if (choice !== undefined && !connected(choice, inputs)) {
    const name = choice.label || "Chosen microphone";
    options.push({ value: choice.deviceId, label: inputs.length === 0 ? name : `${name} (not connected)` });
  }
  return options;
}

function safeStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
