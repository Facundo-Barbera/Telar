"use client";

import { useEffect, useState } from "react";
import { BellRingIcon, PlayIcon, Volume2Icon } from "lucide-react";
import { DEFAULT_NOTIFICATION_SOUNDS, NOTIFICATION_SOUNDS_VALUES, type NotificationSounds } from "@telar/engine-client";
import { Button } from "@/ui/button";
import { Dropdown, Row } from "@/features/settings";
import { notificationSounds, setNotificationSounds } from "../api";

export const SOUND_LABELS: Record<NotificationSounds, string> = { hilo: "Hilo", armonico: "Armónico", felt: "Felt", off: "Off" };

export const previewUrl = (sounds: Exclude<NotificationSounds, "off">) => `/sounds/telar-${sounds}-done.wav`;

type TestNotification = (sounds: NotificationSounds) => Promise<{ ok: boolean }>;

const desktopTest = (): TestNotification | undefined =>
  typeof window === "undefined" ? undefined : (window as { telarDesktop?: { notifications?: { test?: TestNotification } } }).telarDesktop?.notifications?.test;

export function NotificationSoundsRow() {
  const [sounds, setSounds] = useState<NotificationSounds>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    notificationSounds().then(({ sounds }) => setSounds(sounds), () => undefined);
  }, []);

  const save = async (next: NotificationSounds) => {
    const before = sounds;
    setSounds(next);
    setError(undefined);
    try {
      await setNotificationSounds(next);
    } catch {
      setSounds(before);
      setError("Couldn't save. Try again.");
    }
  };

  if (!sounds) return null;
  const test = desktopTest();
  return (
    <Row
      label="Notification sounds"
      icon={Volume2Icon}
      hint="The sound this Mac's alerts play."
      info={`Your iPhone has its own choice, in its notification settings.${test ? " Test sends a real notification, so Focus and your Mac's sound settings apply." : ""}`}
      {...(error ? { error } : {})}
      {...(sounds === DEFAULT_NOTIFICATION_SOUNDS ? {} : { onRevert: () => void save(DEFAULT_NOTIFICATION_SOUNDS) })}
      control={
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Play"
            disabled={sounds === "off"}
            onClick={() => sounds !== "off" && void new Audio(previewUrl(sounds)).play().catch(() => undefined)}
          >
            <PlayIcon />
          </Button>
          {test && (
            <Button variant="ghost" size="icon-sm" aria-label="Test" title="Send a test notification" disabled={sounds === "off"} onClick={() => void test(sounds).catch(() => undefined)}>
              <BellRingIcon />
            </Button>
          )}
          <Dropdown
            value={sounds}
            onChange={(next) => void save(next)}
            options={NOTIFICATION_SOUNDS_VALUES.map((value) => ({ value, label: SOUND_LABELS[value] }))}
            className="w-48"
            label="Notification sounds"
          />
        </div>
      }
    />
  );
}
