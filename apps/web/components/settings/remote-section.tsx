"use client";

/**
 * REMOTE ACCESS — who may reach this cockpit from off this machine.
 *
 * Pairing is the cockpit's own boundary, distinct from the engine's loopback
 * token: a device token authenticates a phone (or another browser) to /api.
 * Enabling the toggle pairs THIS browser in the same round-trip, so the hand
 * that flips the switch cannot lock itself out. If everything goes wrong:
 *
 *     rm <TELAR_HOME>/remote/remote.json
 *
 * logs every device out and turns the requirement off.
 *
 * COOKIES ARE PER-ORIGIN. Pairing this browser at the tailnet IP does not
 * pair it at the ts.net name — each origin pairs once. The panel says so
 * rather than looking broken.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleHelpIcon, MonitorIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QrMatrix } from "@/lib/remote/qr";
import { fmtAgo } from "@/lib/format";
import { QrCodeView } from "./qr-code";
import { CopyCommand } from "./copy-command";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";

interface RemoteDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  role: "full" | "observer";
  platform?: "ios" | "browser";
}

interface RemoteStatus {
  requireAuth: boolean;
  devices: RemoteDevice[];
  callerDeviceId?: string;
  callerRole?: "full" | "observer";
  pairing?: { expiresAt: number };
  endpoints: Array<{ kind: string; label: string; url: string; qrSafe: boolean }>;
}

const PLATFORM_ICONS = { ios: SmartphoneIcon, browser: MonitorIcon } as const;

interface MintedPairing {
  token: string;
  expiresAt: number;
  qrByUrl: Record<string, QrMatrix>;
}

export function RemoteSection() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [minted, setMinted] = useState<MintedPairing | null>(null);
  const [endpointUrl, setEndpointUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [expiryFor, setExpiryFor] = useState<MintedPairing | null>(null);
  // A fresh mint resets the expiry flag during render — React's own
  // "adjust state when a prop changes" shape, which this app's lint enforces
  // over a synchronous set inside the effect.
  if (expiryFor !== minted) {
    setExpiryFor(minted);
    setExpired(false);
  }

  // The code's death is an event, not a render-time clock read: one timer
  // armed per mint.
  useEffect(() => {
    if (!minted) return;
    const remaining = minted.expiresAt - Date.now();
    const task = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(task);
  }, [minted]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/remote");
      if (!response.ok) throw new Error(`status ${response.status}`);
      setStatus((await response.json()) as RemoteStatus);
      setError(null);
    } catch {
      setError("The pairing store did not answer.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const qrEndpoints = useMemo(() => (status?.endpoints ?? []).filter((endpoint) => endpoint.qrSafe), [status]);
  // Prefer the most shareable candidate: listEndpoints orders loopback → lan
  // → tailnet → magicdns, so the last qrSafe entry wins.
  const selectedUrl = endpointUrl ?? qrEndpoints.at(-1)?.url ?? null;

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        const response = await fetch("/api/remote", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requireAuth: next }),
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        if (!next) setMinted(null);
        await load();
      } catch {
        setError("Could not change the pairing requirement.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const mint = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/remote/pairing", { method: "POST" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      setMinted((await response.json()) as MintedPairing);
      await load();
    } catch {
      setError("Could not mint a pairing code.");
    } finally {
      setBusy(false);
    }
  }, [load]);

  const revoke = useCallback(
    async (deviceId: string) => {
      await fetch(`/api/remote/devices/${deviceId}`, { method: "DELETE" }).catch(() => undefined);
      await load();
    },
    [load],
  );

  const patchDevice = useCallback(
    async (deviceId: string, body: { name?: string; role?: "full" | "observer" }) => {
      try {
        const response = await fetch(`/api/remote/devices/${deviceId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (response.status === 409) {
          setError("Keep at least one device with full access.");
        } else if (!response.ok) {
          setError("Could not update the device.");
        } else {
          setError(null);
        }
      } catch {
        setError("Could not update the device.");
      }
      await load();
    },
    [load],
  );

  const revokeOthers = useCallback(async () => {
    await fetch("/api/remote/devices", { method: "DELETE" }).catch(() => undefined);
    await load();
  }, [load]);

  // Last seen ages while the tab is hidden; refresh on return.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  if (!status) {
    return (
      <SettingsGroup title="Pairing" description="Who may reach this cockpit from other devices.">
        <Row label="Loading" hint={error ?? "Reading the pairing store."} control={null} />
      </SettingsGroup>
    );
  }

  const matrix = minted && selectedUrl ? minted.qrByUrl[selectedUrl] : undefined;
  const pairingUrl = minted && selectedUrl ? `${selectedUrl}/pair#token=${minted.token}` : null;

  return (
    <>
      <SettingsGroup title="Pairing" description="Who may reach this cockpit from other devices.">
        <ToggleRow
          label="Require pairing"
          icon={SmartphoneIcon}
          hint={
            error ??
            (status.requireAuth
              ? "Unpaired devices are refused. This browser was paired when you enabled it."
              : "Anything that can reach this address has full control. The tailnet ACL is the only boundary.")
          }
          checked={status.requireAuth}
          onCheckedChange={(next) => void toggle(next)}
        />
      </SettingsGroup>

      {status.requireAuth && (
        <SettingsGroup
          title="Pair a device"
          description="A pairing code is one-time and lives ten minutes. Each browser pairs per address — the tailnet IP and a ts.net name are different origins."
        >
          <Row
            label="Pairing code"
            hint={
              minted
                ? expired
                  ? "Expired — mint a new one."
                  : "Scan from the Telar iOS app or any phone browser."
                : "Codes are shown once and never stored."
            }
            control={
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void mint()}>
                {minted ? "New code" : "Show pairing code"}
              </Button>
            }
          />
          {minted && !expired && qrEndpoints.length > 1 && (
            <Row
              label="Address"
              hint="The address the phone will dial. Pick the one it can reach."
              control={
                <Segmented
                  value={selectedUrl ?? ""}
                  onChange={(value) => setEndpointUrl(value)}
                  options={qrEndpoints.map((endpoint) => ({ value: endpoint.url, label: endpoint.label }))}
                />
              }
            />
          )}
          {minted && !expired && matrix && pairingUrl && (
            <div className="flex flex-col items-start gap-3 px-4 py-3">
              <QrCodeView matrix={matrix} className="size-44 rounded-md border border-border/70" />
              <div className="w-full max-w-md">
                <CopyCommand command={pairingUrl} />
              </div>
            </div>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        title="Paired devices"
        description={
          status.requireAuth
            ? "Rename by clicking the name. View-only devices may read everything and change nothing. Revoking logs the device out on its next request."
            : "Pairing is off — anything that can reach this address has full control. These credentials matter again when you turn it on."
        }
      >
        {status.devices.length === 0 && <Row label="None yet" hint="Devices appear here as they pair." control={null} />}
        {status.devices.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            isSelf={device.id === status.callerDeviceId}
            busy={busy}
            onRename={(name) => void patchDevice(device.id, { name })}
            onRole={(role) => void patchDevice(device.id, { role })}
            onRevoke={() => void revoke(device.id)}
          />
        ))}
        {status.devices.length > 1 && status.callerDeviceId && (
          <RevokeOthersRow count={status.devices.length - 1} onConfirm={() => void revokeOthers()} />
        )}
      </SettingsGroup>
    </>
  );
}

function DeviceRow({
  device,
  isSelf,
  busy,
  onRename,
  onRole,
  onRevoke,
}: {
  device: RemoteDevice;
  isSelf: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onRole: (role: "full" | "observer") => void;
  onRevoke: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name);
  const Icon = device.platform ? PLATFORM_ICONS[device.platform] : CircleHelpIcon;

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== device.name) onRename(draft);
  };

  return (
    <Row
      icon={Icon}
      label={
        editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(device.name);
                setEditing(false);
              }
            }}
            className="h-6 w-48 px-1.5 text-sm"
          />
        ) : (
          <span className="inline-flex items-center gap-2">
            <button
              type="button"
              className="cursor-text hover:underline decoration-dotted underline-offset-2"
              title="Rename"
              onClick={() => {
                setDraft(device.name);
                setEditing(true);
              }}
            >
              {device.name}
            </button>
            {isSelf && <Badge variant="outline">This device</Badge>}
          </span>
        )
      }
      hint={device.lastSeenAt ? `Last seen ${fmtAgo(device.lastSeenAt)}` : `Paired ${fmtAgo(device.createdAt)}`}
      control={
        <div className="flex items-center gap-2">
          <Segmented
            value={device.role}
            onChange={(role) => {
              if (!busy && role !== device.role) onRole(role);
            }}
            options={[
              { value: "full", label: "Full" },
              { value: "observer", label: "View only" },
            ]}
          />
          <Button variant="ghost" size="icon-sm" aria-label={`Revoke ${device.name}`} onClick={onRevoke}>
            <XIcon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}

// Two taps, no dialog: the destructive arm disarms itself after a beat.
function RevokeOthersRow({ count, onConfirm }: { count: number; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const task = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(task);
  }, [armed]);
  return (
    <Row
      label="Revoke all other devices"
      hint="Keeps this one. The lost-phone button."
      control={
        <Button
          variant={armed ? "destructive" : "outline"}
          size="sm"
          onClick={() => {
            if (armed) {
              setArmed(false);
              onConfirm();
            } else {
              setArmed(true);
            }
          }}
        >
          {armed ? `Revoke ${count} device${count === 1 ? "" : "s"}` : "Revoke others"}
        </Button>
      }
    />
  );
}
