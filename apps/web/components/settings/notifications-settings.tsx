"use client";

// Notifications — browser (OS) notifications for the two loom lifecycle events
// actually reachable in the client today: a loom parking (needs you) and a loom
// going ready to accept. session-loom.tsx fires them on the real state
// transition (only when the tab is hidden/unfocused). A master toggle gates the
// per-event toggles; enabling requests OS permission and the denied/unsupported
// states are shown honestly with how to fix them.
//
// Loom Doctrine: a UI preference only — no engine env, no telar.yaml/.telar.
// CLIENT-BUNDLE RULE: imports only ui-prefs + the notify helper (both client-safe).

import { useEffect, useState } from "react";
import { BellIcon, BellOffIcon } from "lucide-react";
import { useUiPrefs, setUiPrefs } from "@/lib/ui-prefs";
import {
  notificationPermission,
  requestNotificationPermission,
} from "@/lib/notify";
import { SettingsGroup, ToggleRow, Row } from "./settings-shell";
import { Button } from "@/components/ui/button";

type Perm = NotificationPermission | "unsupported";

export function NotificationsSettings() {
  const { notifications } = useUiPrefs();
  // Permission is read client-side after mount (SSR has no Notification API);
  // "loading" until then so we never flash a wrong denied/granted state.
  const [perm, setPerm] = useState<Perm | "loading">("loading");
  useEffect(() => setPerm(notificationPermission()), []);

  const supported = perm !== "unsupported" && perm !== "loading";
  const denied = perm === "denied";

  // Enabling the master toggle requests OS permission on first turn-on. We keep
  // the pref enabled even if the grant is pending/denied — the denied banner
  // then tells the user how to fix it, rather than silently reverting.
  const setMaster = async (on: boolean) => {
    setUiPrefs((p) => ({ ...p, notifications: { ...p.notifications, enabled: on } }));
    if (on && perm === "default") {
      setPerm(await requestNotificationPermission());
    }
  };

  const setEvent = (key: "loomParked" | "loomReady", on: boolean) =>
    setUiPrefs((p) => ({ ...p, notifications: { ...p.notifications, [key]: on } }));

  if (perm === "unsupported") {
    return (
      <SettingsGroup title="Browser notifications">
        <Row
          icon={BellOffIcon}
          label="Not supported"
          hint="This browser doesn't expose the Notification API, so desktop alerts are unavailable here."
        />
      </SettingsGroup>
    );
  }

  return (
    <>
      <SettingsGroup
        title="Browser notifications"
        description="Desktop alerts for loom events — delivered only while this tab is in the background, so you're never pinged about a loom you're already watching."
      >
        <ToggleRow
          icon={notifications.enabled ? BellIcon : BellOffIcon}
          label="Enable notifications"
          hint="Turn on desktop alerts. Your browser will ask for permission the first time."
          checked={notifications.enabled}
          onCheckedChange={setMaster}
        />
        {denied && (
          <Row
            label={<span className="text-destructive">Permission blocked</span>}
            hint="Your browser is blocking notifications for this site. Allow them in the site settings (the icon next to the address bar), then reload."
          />
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Notify me when"
        description="Only events with a live source in the app are listed. Human touch-points that don't yet stream to the browser are omitted rather than shown as dead switches."
      >
        <ToggleRow
          label="A loom needs you"
          hint="It parked — blocked, failed, or halted — and is waiting on you."
          checked={notifications.loomParked}
          onCheckedChange={(v) => setEvent("loomParked", v)}
        />
        <ToggleRow
          label="A loom is ready to accept"
          hint="It reached ready / needs-review. ready → done is always yours to press."
          checked={notifications.loomReady}
          onCheckedChange={(v) => setEvent("loomReady", v)}
        />
      </SettingsGroup>

      {supported && perm === "default" && notifications.enabled && (
        <div className="px-1">
          <Button variant="outline" size="sm" onClick={() => void requestNotificationPermission().then(setPerm)}>
            <BellIcon /> Grant permission
          </Button>
        </div>
      )}
    </>
  );
}
