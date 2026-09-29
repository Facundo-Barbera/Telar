import { audioConstraints, audioInputs, matchMicrophone, readMicrophone, writeMicrophone, type AudioInput, type MicrophoneChoice } from "./devices";

type Media = Pick<MediaDevices, "getUserMedia"> & Partial<Pick<MediaDevices, "enumerateDevices">>;

export type OpenedMicrophone = {
  stream: MediaStream;
  fallback?: string;
};

/** Opens the chosen microphone; a changed id is re-found by label, a missing one falls back to the default and says so. */
export async function openMicrophone(
  media: Media,
  choice: MicrophoneChoice | undefined = readMicrophone(),
  remember: (choice: MicrophoneChoice) => void = writeMicrophone,
): Promise<OpenedMicrophone> {
  if (choice === undefined) return { stream: await media.getUserMedia({ audio: true }) };

  const inputs = await listInputs(media);
  const named = inputs.length > 0;
  const found = matchMicrophone(choice, inputs);
  if (named && !found) return fallBack(media, choice);

  const target = found ?? { deviceId: choice.deviceId, label: choice.label };
  try {
    return { stream: await openExact(media, choice, target, remember) };
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  // Before the first grant the list names nothing: the default's grant names it, then look again.
  const fallback = await fallBack(media, choice);
  if (named) return fallback;
  const again = matchMicrophone(choice, await listInputs(media));
  if (!again || again.deviceId === target.deviceId) return fallback;
  for (const track of fallback.stream.getTracks()) track.stop();
  return { stream: await openExact(media, choice, again, remember) };
}

async function openExact(
  media: Media,
  choice: MicrophoneChoice,
  target: AudioInput,
  remember: (choice: MicrophoneChoice) => void,
): Promise<MediaStream> {
  const stream = await media.getUserMedia({ audio: audioConstraints(target) });
  if (target.deviceId !== choice.deviceId) remember({ deviceId: target.deviceId, label: choice.label || target.label });
  return stream;
}

async function fallBack(media: Media, choice: MicrophoneChoice): Promise<OpenedMicrophone> {
  const stream = await media.getUserMedia({ audio: true });
  const name = choice.label || "The chosen microphone";
  return { stream, fallback: `${name} is not connected, so this is recording from the system default.` };
}

async function listInputs(media: Media): Promise<AudioInput[]> {
  try {
    return audioInputs((await media.enumerateDevices?.()) ?? []);
  } catch {
    return [];
  }
}

function missing(cause: unknown): boolean {
  const name = cause instanceof Error ? cause.name : "";
  return name === "OverconstrainedError" || name === "NotFoundError";
}
