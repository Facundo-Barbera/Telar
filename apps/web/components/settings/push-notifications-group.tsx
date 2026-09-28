"use client";

/**
 * PUSH NOTIFICATIONS, IN REMOTE ACCESS — issue #579.
 *
 * ── THE FAILURE THIS PANE EXISTS TO END ─────────────────────────────────────
 * Notifications on the owner's phone never arrived, and nothing on the Mac
 * said why. So this group answers two questions in the order somebody asks
 * them: can this Mac push, and is each phone actually being reached.
 *
 * ── STATUS ONLY, NOTHING TO PROVISION ───────────────────────────────────────
 * A phone registers itself with the relay and hands this Mac its own send key
 * when it pairs, so there is nothing to set up here and never will be. What
 * the pane shows instead is the proof: the test alert sent straight after
 * pairing, reported as "working" or the exact reason. A phone that has not
 * handed over a key yet is told apart from a failing one. No credential is
 * shown or stored in state; the route sends none.
 *
 * ── ONE SETTING: "NOTIFY ON" ────────────────────────────────────────────────
 * With the Mac's own banners on, every alert could arrive on both devices. The
 * row picks which one; the rule itself is `notifyRoute` (lib/mobile/desktop.ts).
 */

import { useEffect, useState } from "react";
import { BellIcon, SmartphoneIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtAgo } from "@/lib/format";
import type { ActivityReport } from "@/lib/mobile/push";
import type { NotifyOn } from "@/lib/mobile/desktop";
import { Dropdown, Row, SettingsGroup } from "./settings-shell";

export interface PushRelayStatus {
  /** The worker's own gate. False here means this Mac sends nothing. */
  configured: boolean;
  /** Milliseconds. This Mac is past the relay's daily budget and sends nothing
   *  until then — the relay's own `Retry-After`, honoured (#584). */
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
    /** The last send's status and Apple's own word for it (#584). */
    lastStatus?: number;
    lastReason?: string;
    consecutiveFailures: number;
    /** Twenty consecutive failures: stopped until the phone registers again. */
    parked: boolean;
    /** v2: the phone registered itself and gave this Mac a key. direct: this
     *  Mac's own developer key. none: neither, so nothing is sent to it. */
    transport?: "v2" | "direct" | "none";
    /** The test alert sent when this phone gave this Mac its current key. */
    test?: { at: number; status: number; reason?: string; relay: boolean };
    /** Why this phone has, or has not, got an automatic Live Activity. */
    activity?: ActivityReport;
  }>;
}

/** What the header badge says, in the words a person would use about it. */
export function relayHeadline(status: PushRelayStatus): { label: string; ok: boolean } {
  return status.configured ? { label: "Ready", ok: true } : { label: "Not ready", ok: false };
}

/** A phone that registered without handing this Mac a key: sent nothing, and
 *  not failing either — it has a step left to do. */
export const NOT_REGISTERED = "This phone hasn't registered for notifications. Open Telar on it to finish.";

/**
 * What a phone's row says about whether it is actually being reached.
 *
 * REGISTERED IS NOT REACHED, and the distinction is the whole reason this
 * column exists: a phone that registered months ago and has never been pushed
 * to looks identical to a working one until you ask when it last took
 * something.
 */
export function deviceLine(device: PushRelayStatus["devices"][number], now = Date.now()): string {
  // NOTHING IS SENT TO IT, so delivery history would only read as a fault.
  if (device.transport === "none") return device.paired ? NOT_REGISTERED : `${NOT_REGISTERED} · no longer paired — will be dropped`;
  const parts: string[] = [];
  if (device.test) parts.push(testLine(device.test));
  parts.push(device.enabled ? "Alerts on" : "Alerts off");
  if (device.liveActivities) {
    const activity = device.activity ? activityLine(device.activity) : undefined;
    parts.push(activity ? `Live Activities: ${activity}` : "Live Activities");
  }
  parts.push(device.lastDeliveryAt ? `last delivery ${fmtAgo(device.lastDeliveryAt * 1000, now)}` : "never delivered to");
  // WHY IT IS FAILING, NOT JUST THAT IT IS. The reason is the difference
  // between "this phone's token is dead" and "the relay had a bad minute".
  if (device.lastStatus !== undefined && device.lastStatus !== 200) {
    parts.push(device.lastReason ? `last refused ${device.lastStatus} ${device.lastReason}` : `last refused ${device.lastStatus}`);
  }
  if (device.consecutiveFailures > 0) parts.push(`${device.consecutiveFailures} failure${device.consecutiveFailures === 1 ? "" : "s"} in a row`);
  if (device.parked) parts.push("stopped until this phone registers again — open Telar on it");
  if (!device.paired) parts.push("no longer paired — will be dropped");
  return parts.join(" · ");
}

const TEST_OK = "Working — test notification delivered";

/**
 * WHAT THE TEST ALERT SENT AFTER PAIRING CAME BACK WITH — "working", or the
 * exact reason. A refusal by the relay is told apart from one by Apple: the
 * first is about this pairing, the second about the phone.
 */
export function testLine(test: NonNullable<PushRelayStatus["devices"][number]["test"]>): string {
  if (test.status === 200 && !test.relay) return TEST_OK;
  const said = test.reason ? `${test.status} ${test.reason}` : String(test.status);
  if (test.relay) return test.status === 0 ? "Test notification could not reach the relay" : `Relay refused the test notification (${said})`;
  return `Push service refused the test notification (${said})`;
}

/**
 * THE AUTOMATIC LIVE ACTIVITY, IN ONE PHRASE. The case worth naming is a start
 * Apple accepted with no card afterwards: iOS dropped it, which is otherwise
 * indistinguishable from success on this side.
 */
export function activityLine(report: ActivityReport): string | undefined {
  if (report.card) return "card running";
  if (report.blocker === "no-start-token") return "no push-to-start token from this phone yet";
  if (report.blocker === "gave-up") return "gave up after 3 starts that never appeared; retries when work next starts";
  const start = report.lastStart;
  if (!start) return undefined;
  if (start.status === 200 && !start.relay) return "the last start was accepted, but no card appeared on the phone";
  const said = start.reason ? `${start.status} ${start.reason}` : String(start.status);
  return start.relay ? `relay refused the last start (${said})` : `push service refused the last start (${said})`;
}

/** "Push paused until 14:32" — the relay's daily budget, in the words somebody
 *  looking at a phone that is not ringing would use. */
export function pausedLine(pausedUntil: number): string {
  return `Push paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

type Device = PushRelayStatus["devices"][number];

/** A delivery this recent means alerts are getting through, whatever a Live
 *  Activity or a single refused send has counted against the record since. */
const REACHED_WITHIN_MS = 60 * 60 * 1000;

/** Stopped until the phone registers again, or no longer paired: sent nothing,
 *  and the worker drops it. Never counted in the summary. */
function isStale(device: Device): boolean {
  return device.parked || !device.paired;
}

/** Alerts are not getting through: sends are failing with no recent delivery,
 *  or the test notification sent after pairing was refused and nothing has landed since. */
function isFailing(device: Device, now = Date.now()): boolean {
  if (device.transport === "none") return false;
  const reached = device.lastDeliveryAt !== undefined && now - device.lastDeliveryAt * 1000 < REACHED_WITHIN_MS;
  if (device.consecutiveFailures > 0 && !reached) return true;
  return device.test !== undefined && testLine(device.test) !== TEST_OK && device.lastDeliveryAt === undefined;
}

const phones = (n: number) => `${n} phone${n === 1 ? "" : "s"}`;

/**
 * THE WHOLE PANE IN ONE LINE. Only live phones count; stopped registrations
 * stay in the details, where the diagnostics are.
 */
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

/** Every registration and its full diagnostic line, stale ones included and marked. */
export function detailLines(status: PushRelayStatus, now = Date.now()): Array<{ key: string; name: string; line: string }> {
  return status.devices.map((device) => ({
    key: `${device.deviceId}:${device.topic}`,
    name: `${device.name ?? "Unnamed device"}${isStale(device) ? " (stopped, removed automatically)" : ""}`,
    line: deviceLine(device, now),
  }));
}

/**
 * "NOTIFY ON", in the order a person weighs it. The values are the server's
 * (`NotifyOn`, lib/mobile/desktop.ts); only the type crosses, because that
 * module reads the store and must not be bundled into the page.
 */
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
        // A Mac that did not answer leaves the pane as it was; Settings does not
        // fail to load over a status read.
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
      // The stored value is the state: a refused write shows it again, and says so.
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
