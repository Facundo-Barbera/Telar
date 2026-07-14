"use client";

// Browser-notification helper for loom lifecycle events. Fires a Notification
// ONLY when the user enabled notifications, enabled that specific event, AND has
// granted OS permission — the pref check and the permission check both gate every
// fire, so a caller never has to know the current state.
//
// CLIENT-BUNDLE RULE: imports only ui-prefs (a client-safe localStorage store);
// nothing here reaches the Agent SDK or server-only code.

import { getUiPrefs } from "./ui-prefs";

export type LoomNotifyKind = "loom-parked" | "loom-ready";

// Whether the platform supports the Notification API at all.
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// Current OS-level permission, or "unsupported" where the API is absent.
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

// Ask the browser for permission (no-op if already granted/denied). The settings
// master toggle calls this on enable so the denied state can be shown honestly.
export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

// Fire a notification for a loom event if — and only if — the user opted into it
// and granted permission. Silent otherwise; never throws.
export function notifyLoom(
  kind: LoomNotifyKind,
  opts: { title: string; body?: string; url?: string },
): void {
  if (!notificationsSupported()) return;
  const { notifications } = getUiPrefs();
  if (!notifications.enabled) return;
  if (kind === "loom-parked" && !notifications.loomParked) return;
  if (kind === "loom-ready" && !notifications.loomReady) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: `telar-${kind}`, // collapse repeats for the same event kind
    });
    if (opts.url) {
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* construction can throw on some platforms — stay silent */
  }
}
