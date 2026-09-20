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
 * So this group answers three questions in the order somebody asks them: can
 * this Mac push, which phones has it been asked to push to, and how do I fix it
 * if the answer to the first is no.
 *
 * ── NO CREDENTIAL IS SHOWN, STORED IN STATE, OR LOGGED ──────────────────────
 * The route sends no tokens. The paste box holds the config only until it is
 * handed to the shell, and is CLEARED on success; a refusal never quotes what
 * was in it. The write itself goes through the desktop bridge rather than a
 * route, because the server that spends this credential on every push must not
 * be able to mint one — see `lib/desktop-push.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { BellIcon, SmartphoneIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtAgo } from "@/lib/format";
import { desktopPush } from "@/lib/desktop-push";
import { parseRelayConfig } from "@/lib/mobile/relay-config";
import { Row, SettingsGroup } from "./settings-shell";

export interface PushRelayStatus {
  /** The worker's own gate. False here means this Mac sends nothing. */
  configured: boolean;
  /** Whether a relay is what makes it configured, as opposed to a local APNs
   *  key — the two are provisioned in different places. */
  relay: boolean;
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
  }>;
}

/** What the header badge says, in the words a person would use about it. */
export function relayHeadline(status: PushRelayStatus): { label: string; ok: boolean } {
  if (!status.configured) return { label: "Not configured", ok: false };
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
  parts.push(device.enabled ? "Alerts on" : "Alerts off");
  if (device.liveActivities) parts.push("Live Activities");
  // A DEBUG BUILD REGISTERS SANDBOX and can never be delivered to through the
  // relay, which is worth saying beside a phone that shows up and never rings.
  if (device.sandbox) parts.push("sandbox build — the relay cannot reach it");
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

/** "Push paused until 14:32" — the relay's daily budget, in the words somebody
 *  looking at a phone that is not ringing would use. */
export function pausedLine(pausedUntil: number): string {
  return `Push paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function PushNotificationsGroup() {
  const [status, setStatus] = useState<PushRelayStatus>();
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const bridge = desktopPush();

  const read = useCallback(async (fresh = false) => {
    try {
      const response = await fetch(`/api/mobile/relay${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      if (!response.ok) return;
      setStatus((await response.json()) as PushRelayStatus);
    } catch {
      // A Mac that did not answer leaves the pane as it was; Settings does not
      // fail to load over a status read.
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(task);
  }, [read]);

  /**
   * VALIDATED HERE, WRITTEN THERE.
   *
   * `parseRelayConfig` is the cockpit's own definition of a valid config — the
   * same function the server's relay reader uses — so the pane cannot accept
   * something the reader would later reject and leave push quietly dead. The
   * shell re-checks it at the boundary that writes, which is belt and braces
   * rather than duplication: neither side trusts the other's caller.
   */
  const provision = useCallback(async () => {
    setError(undefined);
    setSaved(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(paste);
    } catch {
      setError("That is not JSON. Paste the relay config the deploy printed.");
      return;
    }
    const config = parseRelayConfig(parsed);
    if (!config) {
      setError('Not a relay config: it needs an https url with no path and a 64-character hex token — {"url": "https://…", "token": "…"}.');
      return;
    }
    if (!bridge?.provisionRelay) {
      setError("This build of the desktop app cannot write the Keychain item. Update Telar, or add it with `security add-generic-password`.");
      return;
    }
    setBusy(true);
    try {
      const answer = await bridge.provisionRelay(config);
      if (!answer.ok) {
        setError(answer.error ?? "The Keychain refused the write.");
        return;
      }
      // CLEARED ON SUCCESS. The box held a credential; it should not still be
      // holding one on a screen somebody walks away from.
      setPaste("");
      setSaved(true);
      // `fresh` because the reader caches for 30s, and telling somebody who has
      // just provisioned the relay that this Mac has none is worse than the
      // extra read.
      await read(true);
    } finally {
      setBusy(false);
    }
  }, [bridge, paste, read]);

  if (!status) return null;
  const headline = relayHeadline(status);

  return (
    <SettingsGroup
      title="Push notifications"
      description="Whether this Mac can send alerts to your phones, and which ones it has been asked to reach."
      action={<Badge variant={headline.ok ? "outline" : "destructive"}>{headline.label}</Badge>}
    >
      {!status.configured && (
        <Row
          label="This Mac has no push relay"
          icon={BellIcon}
          hint="Nothing is sent until one is provisioned — the worker that delivers notifications does not start, and every phone that registers is told push is unavailable. Paste the relay config below."
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
      {status.configured && !status.sandbox && (
        <Row
          label="Production builds only"
          icon={BellIcon}
          hint="The Apple key this relay holds is production-only, so a debug build of the phone app registers for sandbox and can never be delivered to."
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
      <Row
        label="Provision relay"
        hint="Paste the relay config from the push-relay deploy. It is written to this Mac's login Keychain and never leaves it."
        {...(error === undefined ? {} : { error })}
        {...(bridge?.provisionRelay
          ? {}
          : { unavailable: { reason: "Open Telar's desktop app on this Mac to write the Keychain item — a browser tab cannot reach the Keychain." } })}
        control={
          <div className="flex w-full max-w-md flex-col gap-2">
            <textarea
              className="h-20 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder='{"url": "https://relay.example.com", "token": "…"}'
              spellCheck={false}
              autoComplete="off"
              value={paste}
              onChange={(event) => {
                setPaste(event.target.value);
                setError(undefined);
                setSaved(false);
              }}
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy || !paste.trim()} onClick={() => void provision()}>
                {busy ? "Writing…" : "Provision relay"}
              </Button>
              {saved && <span className="text-xs text-muted-foreground">Saved to the Keychain.</span>}
            </div>
          </div>
        }
      />
    </SettingsGroup>
  );
}
