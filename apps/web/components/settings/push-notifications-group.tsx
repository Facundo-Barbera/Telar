"use client";

/**
 * PUSH NOTIFICATIONS, IN REMOTE ACCESS — issue #579.
 *
 * ── THE FAILURE THIS PANE EXISTS TO END ─────────────────────────────────────
 * Notifications on the owner's phone never arrived, and nothing anywhere said
 * why. The chain is: the cockpit's worker refuses to start without a relay
 * credential in this Mac's Keychain; `PUT /api/mobile/push` answers
 * `{ configured: false }`; and the only surface that reported that was a status
 * line under a toggle on the phone. Nothing on the MAC — the machine that owns
 * the missing credential and is the only place it can be written — mentioned
 * push at all.
 *
 * So this group answers two questions in the order somebody asks them: can
 * this Mac push, and is each phone actually being reached.
 *
 * ── STATUS ONLY, NOTHING TO PASTE ───────────────────────────────────────────
 * With relay v2 a phone registers itself and hands this Mac its own send key
 * when it pairs, so there is nothing to provision here. What the pane adds
 * instead is the proof: the test alert sent straight after pairing, reported
 * as "working" or Apple's exact reason. No credential is shown or stored in
 * state; the route sends none.
 */

import { useEffect, useState } from "react";
import { BellIcon, SmartphoneIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fmtAgo } from "@/lib/format";
import { Row, SettingsGroup } from "./settings-shell";

export interface PushRelayStatus {
  /** The worker's own gate. False here means this Mac sends nothing. */
  configured: boolean;
  /** Whether a relay is what makes it configured, as opposed to a local APNs
   *  key — the two are provisioned in different places. */
  relay: boolean;
  /** Some phone registered itself with relay v2: nothing to provision here. */
  v2?: boolean;
  /** Whether a DEBUG build's `sandbox: true` registration could ever be
   *  delivered to. The available Apple key is production-only. */
  sandbox: boolean;
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
    /** Whether THIS Mac is the one that serves it. A record registered against
     *  another Mac is left alone rather than sent twice (#584). */
    mine: boolean;
    /** v2: the phone registered itself and gave this Mac a key. v1: this Mac's own relay. */
    transport?: "v1" | "v2";
    /** The test alert sent when this phone gave this Mac its current key. */
    test?: { at: number; status: number; reason?: string; relay: boolean };
  }>;
}

/** What the header badge says, in the words a person would use about it. */
export function relayHeadline(status: PushRelayStatus): { label: string; ok: boolean } {
  if (!status.configured) return { label: "Not configured", ok: false };
  if (status.v2) return { label: "Ready", ok: true };
  return { label: status.relay ? "Relay configured" : "APNs key configured", ok: true };
}

/**
 * What a phone's row says about whether it is actually being reached.
 *
 * REGISTERED IS NOT REACHED, and the distinction is the whole reason this
 * column exists: a phone that registered months ago and has never been pushed
 * to looks identical to a working one until you ask when it last took
 * something.
 */
export function deviceLine(device: PushRelayStatus["devices"][number], now = Date.now()): string {
  const parts: string[] = [];
  // ANOTHER MAC'S PHONE IS NOT THIS MAC'S PROBLEM, and saying so first stops the
  // rest of the line being read as a fault here (#584).
  if (!device.mine) parts.push("registered against another Mac — served from there");
  if (device.test) parts.push(testLine(device.test));
  parts.push(device.enabled ? "Alerts on" : "Alerts off");
  if (device.liveActivities) parts.push("Live Activities");
  // A DEBUG BUILD REGISTERS SANDBOX and can never be delivered to through the
  // relay, which is worth saying beside a phone that shows up and never rings.
  if (device.sandbox && device.transport !== "v2") parts.push("sandbox build — update the phone app to reach it");
  parts.push(device.lastDeliveryAt ? `last delivery ${fmtAgo(device.lastDeliveryAt * 1000, now)}` : "never delivered to");
  // WHY IT IS FAILING, NOT JUST THAT IT IS. Apple's reason is the difference
  // between "this phone's token is dead" and "the relay had a bad minute".
  if (device.lastStatus !== undefined && device.lastStatus !== 200) {
    parts.push(device.lastReason ? `last refused ${device.lastStatus} ${device.lastReason}` : `last refused ${device.lastStatus}`);
  }
  if (device.consecutiveFailures > 0) parts.push(`${device.consecutiveFailures} failure${device.consecutiveFailures === 1 ? "" : "s"} in a row`);
  if (device.parked) parts.push("stopped until this phone registers again — open Telar on it");
  if (!device.paired) parts.push("no longer paired — will be dropped");
  return parts.join(" · ");
}

/**
 * WHAT THE TEST ALERT SENT AFTER PAIRING CAME BACK WITH — "working", or the
 * exact reason. A refusal by the relay is told apart from one by Apple: the
 * first is about this pairing, the second about the phone.
 */
export function testLine(test: NonNullable<PushRelayStatus["devices"][number]["test"]>): string {
  if (test.status === 200 && !test.relay) return "Working — test notification delivered";
  const said = test.reason ? `${test.status} ${test.reason}` : String(test.status);
  if (test.relay) return test.status === 0 ? "Test notification could not reach the relay" : `Relay refused the test notification (${said})`;
  return `Apple refused the test notification (${said})`;
}

/** "Push paused until 14:32" — the relay's daily budget, in the words somebody
 *  looking at a phone that is not ringing would use. */
export function pausedLine(pausedUntil: number): string {
  return `Push paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function PushNotificationsGroup() {
  const [status, setStatus] = useState<PushRelayStatus>();

  useEffect(() => {
    const task = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/mobile/relay", { cache: "no-store" });
        if (response.ok) setStatus((await response.json()) as PushRelayStatus);
      } catch {
        // A Mac that did not answer leaves the pane as it was; Settings does not
        // fail to load over a status read.
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  if (!status) return null;
  const headline = relayHeadline(status);

  return (
    <SettingsGroup
      title="Push notifications"
      description="Whether this Mac can send alerts to your phones, and whether each one is actually being reached."
      action={<Badge variant={headline.ok ? "outline" : "destructive"}>{headline.label}</Badge>}
    >
      {!status.configured && (
        <Row
          label="No phone can be reached yet"
          icon={BellIcon}
          hint="There is nothing to set up on this Mac. Pair a phone and allow notifications when it asks; it registers itself and a test notification confirms it here."
          control={null}
        />
      )}
      {status.pausedUntil !== undefined && (
        <Row
          label={pausedLine(status.pausedUntil)}
          icon={BellIcon}
          hint="This Mac has spent the relay's daily budget, so nothing is sent until it resets. Alerts resume on their own; no action is needed unless it happens every day, which would mean something is sending far more than it should."
          control={null}
        />
      )}
      {status.devices.length === 0 ? (
        <Row
          label="No phone has registered"
          icon={SmartphoneIcon}
          hint="A paired phone registers the first time it is asked for notification permission. If yours has not, open Telar on it — it asks once, after pairing."
          control={null}
        />
      ) : (
        status.devices.map((device) => (
          <Row
            key={`${device.deviceId}:${device.topic}`}
            id={`push-device-${device.deviceId}`}
            label={device.name ?? "Unnamed device"}
            icon={SmartphoneIcon}
            hint={deviceLine(device)}
            control={null}
          />
        ))
      )}
    </SettingsGroup>
  );
}
