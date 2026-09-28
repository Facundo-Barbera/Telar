"use client";

import { useEffect, useState } from "react";
import { BellIcon, SmartphoneIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtAgo } from "@/lib/format";
import type { ActivityReport, NotifyOn } from "@telar/engine-client";
import { Dropdown, Row, SettingsGroup } from "@/features/settings";

export interface PushRelayStatus {
  configured: boolean;
  pausedUntil?: number;
  devices: Array<{
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
  }>;
}

export function relayHeadline(status: PushRelayStatus): { label: string; ok: boolean } {
  return status.configured ? { label: "Ready", ok: true } : { label: "Not ready", ok: false };
}

export const NOT_REGISTERED = "This phone hasn't registered for notifications. Open Telar on it to finish.";

export function deviceLine(device: PushRelayStatus["devices"][number], now = Date.now()): string {
  if (device.transport === "none") return device.paired ? NOT_REGISTERED : `${NOT_REGISTERED} · no longer paired — will be dropped`;
  const parts: string[] = [];
  if (device.test) parts.push(testLine(device.test));
  parts.push(device.enabled ? "Alerts on" : "Alerts off");
  if (device.liveActivities) {
    const activity = device.activity ? activityLine(device.activity) : undefined;
    parts.push(activity ? `Live Activities: ${activity}` : "Live Activities");
  }
  parts.push(device.lastDeliveryAt ? `last delivery ${fmtAgo(device.lastDeliveryAt * 1000, now)}` : "never delivered to");
  if (device.lastStatus !== undefined && device.lastStatus !== 200) {
    parts.push(device.lastReason ? `last refused ${device.lastStatus} ${device.lastReason}` : `last refused ${device.lastStatus}`);
  }
  if (device.consecutiveFailures > 0) parts.push(`${device.consecutiveFailures} failure${device.consecutiveFailures === 1 ? "" : "s"} in a row`);
  if (device.parked) parts.push("stopped until this phone registers again — open Telar on it");
  if (!device.paired) parts.push("no longer paired — will be dropped");
  return parts.join(" · ");
}

const TEST_OK = "Working — test notification delivered";

export function testLine(test: NonNullable<PushRelayStatus["devices"][number]["test"]>): string {
  if (test.status === 200 && !test.relay) return TEST_OK;
  const said = test.reason ? `${test.status} ${test.reason}` : String(test.status);
  if (test.relay) return test.status === 0 ? "Test notification could not reach the relay" : `Relay refused the test notification (${said})`;
  return `Push service refused the test notification (${said})`;
}

function activityLine(report: ActivityReport): string | undefined {
  if (report.card) return "card running";
  if (report.blocker === "no-start-token") return "no push-to-start token from this phone yet";
  if (report.blocker === "gave-up") return "gave up after 3 starts that never appeared; retries when work next starts";
  const start = report.lastStart;
  if (!start) return undefined;
  if (start.status === 200 && !start.relay) return "the last start was accepted, but no card appeared on the phone";
  const said = start.reason ? `${start.status} ${start.reason}` : String(start.status);
  return start.relay ? `relay refused the last start (${said})` : `push service refused the last start (${said})`;
}

export function pausedLine(pausedUntil: number): string {
  return `Push paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

type Device = PushRelayStatus["devices"][number];

const REACHED_WITHIN_MS = 60 * 60 * 1000;

function isStale(device: Device): boolean {
  return device.parked || !device.paired;
}

function isFailing(device: Device, now = Date.now()): boolean {
  if (device.transport === "none") return false;
  const reached = device.lastDeliveryAt !== undefined && now - device.lastDeliveryAt * 1000 < REACHED_WITHIN_MS;
  if (device.consecutiveFailures > 0 && !reached) return true;
  return device.test !== undefined && testLine(device.test) !== TEST_OK && device.lastDeliveryAt === undefined;
}

const phones = (n: number) => `${n} phone${n === 1 ? "" : "s"}`;

export function phoneSummary(status: PushRelayStatus, now = Date.now()): { label: string; ok: boolean } {
  const live = status.devices.filter((device) => !isStale(device));
  const failing = live.filter((device) => isFailing(device, now));
  if (failing.length === 1) return { label: `Alerts aren't reaching ${failing[0]!.name ?? "your phone"}`, ok: false };
  if (failing.length > 1) return { label: `Alerts aren't reaching ${phones(failing.length)}`, ok: false };
  const unregistered = live.filter((device) => device.transport === "none");
  if (unregistered.length === 1) return { label: `${unregistered[0]!.name ?? "Your phone"} hasn't finished registering for notifications`, ok: false };
  if (unregistered.length > 1) return { label: `${phones(unregistered.length)} haven't finished registering for notifications`, ok: false };
  const on = live.filter((device) => device.enabled).length;
  if (on > 0) return { label: `Alerts reach ${phones(on)}`, ok: true };
  if (live.length > 0) return { label: `Alerts are off on ${live.length === 1 ? "your phone" : phones(live.length)}`, ok: true };
  return { label: "No phone registered yet", ok: true };
}

export function detailLines(status: PushRelayStatus, now = Date.now()): Array<{ key: string; name: string; line: string }> {
  return status.devices.map((device) => ({
    key: `${device.deviceId}:${device.topic}`,
    name: `${device.name ?? "Unnamed device"}${isStale(device) ? " (stopped, removed automatically)" : ""}`,
    line: deviceLine(device, now),
  }));
}

export const NOTIFY_ON_LABELS: Record<NotifyOn, string> = {
  mac: "This Mac when active",
  iphone: "iPhone only",
  both: "Both",
};

export function PushNotificationsGroup() {
  const [status, setStatus] = useState<PushRelayStatus>();
  const [notifyOn, setNotifyOn] = useState<NotifyOn>();
  const [notifyError, setNotifyError] = useState<string>();

  useEffect(() => {
    const task = window.setTimeout(async () => {
      try {
        const [relay, notify] = await Promise.all([
          fetch("/api/mobile/relay", { cache: "no-store" }),
          fetch("/api/mobile/notify", { cache: "no-store" }),
        ]);
        if (relay.ok) setStatus((await relay.json()) as PushRelayStatus);
        if (notify.ok) setNotifyOn(((await notify.json()) as { notifyOn: NotifyOn }).notifyOn);
      } catch {
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const saveNotifyOn = async (next: NotifyOn) => {
    const before = notifyOn;
    setNotifyOn(next);
    setNotifyError(undefined);
    try {
      const response = await fetch("/api/mobile/notify", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notifyOn: next }) });
      if (!response.ok) throw new Error();
    } catch {
      setNotifyOn(before);
      setNotifyError("Couldn't save. Try again.");
    }
  };

  if (!status) return null;
  const headline = relayHeadline(status);
  const summary = phoneSummary(status);
  const details = detailLines(status);

  return (
    <SettingsGroup
      title="Push notifications"
      description="Whether this Mac's alerts reach your phone."
      action={<Badge variant={headline.ok ? "outline" : "destructive"}>{headline.label}</Badge>}
    >
      {notifyOn && (
        <Row
          label="Notify on"
          icon={BellIcon}
          hint="Which device each alert goes to."
          info="Each alert goes to one device: this Mac while you're using it, your iPhone once you step away. A session you're looking at alerts neither."
          {...(notifyError ? { error: notifyError } : {})}
          {...(notifyOn === "mac" ? {} : { onRevert: () => void saveNotifyOn("mac") })}
          control={
            <Dropdown
              value={notifyOn}
              onChange={(next) => void saveNotifyOn(next)}
              options={(Object.keys(NOTIFY_ON_LABELS) as NotifyOn[]).map((value) => ({ value, label: NOTIFY_ON_LABELS[value] }))}
              className="w-48"
              label="Notify on"
            />
          }
        />
      )}
      {!status.configured && (
        <Row
          label="No phone can be reached yet"
          icon={BellIcon}
          hint="Pair a phone and allow notifications when it asks."
          info="There is nothing to set up on this Mac. The phone registers itself, and a test notification confirms it here."
          control={null}
        />
      )}
      {status.pausedUntil !== undefined && (
        <Row
          label={pausedLine(status.pausedUntil)}
          icon={BellIcon}
          hint="Alerts resume on their own."
          info="This Mac has spent the relay's daily budget, so nothing is sent until it resets. If it happens every day, something is sending far more than it should."
          control={null}
        />
      )}
      <Row
        id="push-phones"
        label={summary.label}
        icon={SmartphoneIcon}
        {...(summary.ok ? {} : { hint: "Open Telar on the phone to register it." })}
        info="A paired phone registers when it first asks for notification permission. A registration that stops working is removed automatically, and the phone registers again the next time Telar opens on it."
        control={null}
      >
        {details.length > 0 && (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
            <ul className="mt-1.5 space-y-1.5">
              {details.map((detail) => (
                <li key={detail.key}>
                  <span className="text-foreground">{detail.name}</span>
                  <br />
                  {detail.line}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Row>
    </SettingsGroup>
  );
}
