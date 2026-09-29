import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_NOTIFICATION_SOUNDS, DEFAULT_NOTIFY_ON, NOTIFICATION_SOUNDS_VALUES, NOTIFY_ON_VALUES,
  type NotificationSounds, type NotifyOn,
} from "@telar/engine-client";
import { pushFile, type AlertKind } from "./push";

type Pref<T> = { name: string; key: string; values: readonly T[]; fallback: T };
const NOTIFY_ON: Pref<NotifyOn> = { name: "notify-on", key: "notifyOn", values: NOTIFY_ON_VALUES, fallback: DEFAULT_NOTIFY_ON };
const SOUNDS: Pref<NotificationSounds> = { name: "notification-sounds", key: "sounds", values: NOTIFICATION_SOUNDS_VALUES, fallback: DEFAULT_NOTIFICATION_SOUNDS };

const prefFile = (pref: Pref<unknown>) => path.join(path.dirname(pushFile()), `${pref.name}.json`);

function readPref<T>(pref: Pref<T>, file = prefFile(pref)): T {
  try {
    const value = (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)[pref.key];
    return pref.values.includes(value as T) ? (value as T) : pref.fallback;
  } catch { return pref.fallback; }
}

function writePref<T>(pref: Pref<T>, value: T, file = prefFile(pref)): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ [pref.key]: value }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const isNotifyOn = (value: unknown): value is NotifyOn => NOTIFY_ON_VALUES.includes(value as NotifyOn);
export const readNotifyOn = (file?: string) => readPref(NOTIFY_ON, file);
export const writeNotifyOn = (value: NotifyOn, file?: string) => writePref(NOTIFY_ON, value, file);

export const isNotificationSounds = (value: unknown): value is NotificationSounds => NOTIFICATION_SOUNDS_VALUES.includes(value as NotificationSounds);
export const readSounds = (file?: string) => readPref(SOUNDS, file);
export const writeSounds = (value: NotificationSounds, file?: string) => writePref(SOUNDS, value, file);

const SOUND_EVENT: Record<AlertKind, string> = { finished: "done", blocked: "needs", failed: "error" };

/** The bundled file's name without its extension; undefined means silent. */
export function soundFor(sounds: NotificationSounds, kind: AlertKind): string | undefined {
  return sounds === "off" ? undefined : `telar-${sounds}-${SOUND_EVENT[kind]}`;
}
