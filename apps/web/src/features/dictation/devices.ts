// Stored in localStorage, not engine state: deviceIds are per browser profile
// and origin, and change when a device is re-plugged.
export type MicrophoneChoice = {
  deviceId: string;
  // For display when the device is absent; never used to match.
  label: string;
};

export type AudioInput = { deviceId: string; label: string };

const KEY = "telar:dictation-microphone:v1";

/** The stored choice, or undefined for the system default. Never throws on a bad stored shape. */
export function readMicrophone(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): MicrophoneChoice | undefined {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { deviceId, label } = parsed as Partial<MicrophoneChoice>;
    // An empty `deviceId` is the system-default option, not a choice.
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
    // A blocked store costs only the preference; dictation still uses the default.
  }
  // Notify even if the write failed: listeners re-read the store rather than trust the value.
  for (const listener of [...listeners]) listener();
}

/**
 * A `useSyncExternalStore` snapshot: cached against the raw string so identity is stable.
 * Read synchronously rather than in an effect, so the picker never flashes "System default".
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

/** A `Set`, so a StrictMode double mount registers once. */
const listeners = new Set<() => void>();

let cached: { raw: string | null; choice: MicrophoneChoice | undefined } | undefined;

/** Also listens to `storage` for other windows; that event skips the writer, hence the direct notify. */
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

/** `ideal` rather than `exact`; `true` when nothing is chosen. */
export function audioConstraints(choice: MicrophoneChoice | undefined): MediaStreamConstraints["audio"] {
  return choice?.deviceId ? { deviceId: { ideal: choice.deviceId } } : true;
}

/**
 * Named audio inputs only: unnamed ones (pre-grant) are dropped, as is the browser's
 * "default" alias, which the picker already offers as its first option.
 */
export function audioInputs(devices: readonly MediaDeviceInfo[]): AudioInput[] {
  return devices
    .filter((device) => device.kind === "audioinput" && device.label !== "" && device.deviceId !== "" && device.deviceId !== "default")
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/** There are inputs and none is named: the pre-grant state. */
export function labelsWithheld(devices: readonly MediaDeviceInfo[]): boolean {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return inputs.length > 0 && inputs.every((device) => device.label === "");
}

export function connected(choice: MicrophoneChoice | undefined, inputs: readonly AudioInput[]): boolean {
  return choice !== undefined && inputs.some((input) => input.deviceId === choice.deviceId);
}

/**
 * Only "gone" is worth a word, named by the stored label. An empty list (pre-grant) is
 * never "gone", or a choice would read as disconnected on every fresh load.
 */
export function microphoneStatus(
  choice: MicrophoneChoice | undefined,
  inputs: readonly AudioInput[],
): { gone: true; label: string } | undefined {
  if (choice === undefined || inputs.length === 0 || connected(choice, inputs)) return undefined;
  return { gone: true, label: choice.label || "The chosen microphone" };
}

/**
 * System default first. A choice the list lacks is always appended, or the `Dropdown` would
 * draw its raw id; it is marked "(not connected)" only when the browser is naming devices.
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
