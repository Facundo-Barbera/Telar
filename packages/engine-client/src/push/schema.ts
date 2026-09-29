export type NotifyOn = "mac" | "iphone" | "both";
export const NOTIFY_ON_VALUES: readonly NotifyOn[] = ["mac", "iphone", "both"];
export const DEFAULT_NOTIFY_ON: NotifyOn = "mac";

export type NotificationSounds = "hilo" | "armonico" | "felt" | "off";
export const NOTIFICATION_SOUNDS_VALUES: readonly NotificationSounds[] = ["hilo", "armonico", "felt", "off"];
export const DEFAULT_NOTIFICATION_SOUNDS: NotificationSounds = "hilo";

export type ActivityReport = {
  card: boolean;
  blocker?: "off" | "no-start-token";
  lastStart?: { at: number; status: number; reason?: string; relay?: boolean; token?: string };
};

export type PushRelayDevice = {
  deviceId: string;
  name?: string;
  paired: boolean;
  topic: string;
  sandbox: boolean;
  enabled: boolean;
  liveActivities: boolean;
  updatedAt: number;
  lastDeliveryAt?: number;
  lastStatus?: number;
  lastReason?: string;
  consecutiveFailures: number;
  parked: boolean;
  transport?: "v2" | "direct" | "none";
  test?: { at: number; status: number; reason?: string; relay: boolean };
  activity?: ActivityReport;
};

export type PushRelayStatus = { configured: boolean; pausedUntil?: number; devices: PushRelayDevice[] };
