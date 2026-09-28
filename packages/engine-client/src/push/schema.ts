export type NotifyOn = "mac" | "iphone" | "both";
export const NOTIFY_ON_VALUES: readonly NotifyOn[] = ["mac", "iphone", "both"];
export const DEFAULT_NOTIFY_ON: NotifyOn = "mac";

export type ActivityReport = {
  card: boolean;
  blocker?: "off" | "no-start-token" | "gave-up";
  lastStart?: { at: number; status: number; reason?: string; relay?: boolean; token?: string };
};
