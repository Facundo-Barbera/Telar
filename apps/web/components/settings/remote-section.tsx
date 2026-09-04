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
import { TerminalIcon, ServerIcon, GlobeIcon, CircleHelpIcon, MonitorIcon, SmartphoneIcon, XIcon } from "lucide-react";
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
  identity?: { kind?: string; client?: string; machine?: string; os?: string; address?: string; origin?: string };
}

/** The process running the server. Reported, never stored — it has no id
 *  because there is nothing to revoke; quitting the app is the revoke. */
interface RemoteHost {
  name: string;
  identity?: RemoteDevice["identity"];
  isCaller?: boolean;
}

interface RemoteStatus {
  requireAuth: boolean;
  exposure?: "local-only" | "network-accessible";
  host?: RemoteHost;
  devices: RemoteDevice[];
  callerDeviceId?: string;
  callerRole?: "full" | "observer";
  pairing?: { expiresAt: number };
  endpoints: Array<{ kind: string; label: string; url: string; qrSafe: boolean }>;
}

/**
 * ICONS FOR THE KINDS WE KNOW, and a fallback for the ones we do not.
 *
 * The kind is a free slug a client declares about itself, so this map is a
 * courtesy and not a validation: an unrecognised kind gets the question-mark
 * glyph and keeps its own name in the row, which beats a familiar icon over a
 * wrong label. Adding a row here is how a new client earns an icon; it is not
 * how it earns the right to pair.
 */
const KIND_ICONS: Record<string, typeof MonitorIcon> = {
  browser: GlobeIcon,
  phone: SmartphoneIcon,
  tablet: SmartphoneIcon,
  desktop: MonitorIcon,
  cli: TerminalIcon,
  service: ServerIcon,
};

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
  /** The shell picks its bind address at launch, so a change here is pending
   *  until the app restarts. Sticky: reloading the panel must not hide it. */
  const [restartNeeded, setRestartNeeded] = useState(false);
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

  /**
   * EVERY ADDRESS, ONE AT A TIME. Loopback rides in the same picker as the
   * shareable ones — it is the address a SECOND client on this machine needs
   * — but it is never drawn as a QR: scanning 127.0.0.1 with a phone reaches
   * the phone. The panel shows one link for the picked address, and a QR
   * only when that address is one a phone can dial.
   */
  const endpoints = useMemo(() => status?.endpoints ?? [], [status]);
  // Prefer the most shareable candidate: listEndpoints orders loopback → lan
  // → tailnet → magicdns, so the last qrSafe entry wins.
  const selectedUrl = endpointUrl ?? endpoints.filter((endpoint) => endpoint.qrSafe).at(-1)?.url ?? endpoints.at(-1)?.url ?? null;
  const selectedEndpoint = endpoints.find((endpoint) => endpoint.url === selectedUrl);

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

  /**
   * WIDEN OR NARROW WHERE THE SOCKET LISTENS.
   *
   * The shell reads this at launch, so nothing about the running server moves
   * — saying so is the honest answer, and it is why this reports a restart
   * rather than reloading and pretending.
   */
  const setExposure = useCallback(
    async (next: "local-only" | "network-accessible") => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/remote", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ exposure: next }),
        });
        const body = (await response.json()) as { error?: { message?: string } };
        if (!response.ok) throw new Error(body.error?.message ?? `status ${response.status}`);
        setRestartNeeded(true);
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not change network access.");
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

  const matrix = minted && selectedUrl && selectedEndpoint?.qrSafe ? minted.qrByUrl[selectedUrl] : undefined;
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
              ? "Unpaired devices are refused. Whatever turned this on was paired in the same breath, so it cannot lock itself out."
              : "Anything that can reach this address has full control. The tailnet ACL is the only boundary.")
          }
          checked={status.requireAuth}
          onCheckedChange={(next) => void toggle(next)}
        />
        {/* WHERE THE SOCKET LISTENS, beside who may reach it — the two halves
            of the same question. Only offered once pairing is on: binding every
            interface without a gate would publish an unguarded cockpit to
            whatever network this machine is attached to. */}
        {status.requireAuth && (
          <ToggleRow
            label="Reachable from the network"
            icon={GlobeIcon}
            hint={
              status.exposure === "network-accessible"
                ? "Listening on every interface, so a tailnet or LAN address reaches this cockpit. Pairing is what guards it."
                : "Listening on 127.0.0.1 only. A pairing link that names another address cannot connect — this machine is the only one that can reach it."
            }
            checked={status.exposure === "network-accessible"}
            onCheckedChange={(next) => void setExposure(next ? "network-accessible" : "local-only")}
          />
        )}
        {restartNeeded && (
          <Row
            label="Restart to apply"
            hint="The server chooses its address when it starts, so this takes effect on the next launch."
            control={null}
          />
        )}
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
          {minted && !expired && (
            <Row
              label="Code"
              hint="The bare code, for typing into the pairing page by hand when a link or a scan will not take."
              control={
                <div className="w-full max-w-md">
                  <CopyCommand command={minted.token} />
                </div>
              }
            />
          )}
          {minted && !expired && endpoints.length > 1 && (
            <Row
              label="Address"
              hint={
                selectedEndpoint?.kind === "loopback"
                  ? "For another client on this computer — a second browser, a CLI. Nothing to scan: a phone dialling 127.0.0.1 reaches itself."
                  : "The address the device will dial. Pick the one it can reach."
              }
              control={
                <Segmented
                  value={selectedUrl ?? ""}
                  onChange={(value) => setEndpointUrl(value)}
                  options={endpoints.map((endpoint) => ({ value: endpoint.url, label: endpoint.label }))}
                />
              }
            />
          )}
          {minted && !expired && pairingUrl && (
            <div className="flex flex-col items-start gap-3 py-3">
              {matrix && <QrCodeView matrix={matrix} className="size-44 rounded-md border border-border/70" />}
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
        {status.host && <HostRow host={status.host} />}
        {status.devices.length === 0 && !status.host && (
          <Row label="None yet" hint="Devices appear here as they pair." control={null} />
        )}
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

/**
 * The app hosting the server. It is not pairable and not revocable, so it gets
 * no role switch and no X — the controls a paired device needs would all be
 * lies here. It is listed anyway because a panel that answers "what is
 * connected" and omits the one certain answer is the bug this fixes.
 */
function HostRow({ host }: { host: RemoteHost }) {
  const Icon = KIND_ICONS[host.identity?.kind ?? "desktop"] ?? MonitorIcon;
  return (
    <Row
      icon={Icon}
      label={
        <span className="inline-flex items-center gap-2">
          {host.name}
          <Badge variant="outline">{host.isCaller ? "This app" : "Host"}</Badge>
        </span>
      }
      hint="Runs the server — always connected, nothing to revoke."
      control={null}
    />
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
  // The kind first; the old platform field only for rows written before it.
  const kind = device.identity?.kind ?? (device.platform === "ios" ? "phone" : device.platform);
  const Icon = (kind ? KIND_ICONS[kind] : undefined) ?? CircleHelpIcon;
  // Suppressed when the name already carries it, so a row does not read
  // "Chrome · macOS — Chrome · macOS · Last seen …".
  const declaredSource = [device.identity?.client, device.identity?.machine].filter(Boolean).join(" · ");
  const source = declaredSource && !device.name.includes(declaredSource) ? declaredSource : undefined;

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
      hint={[
        // WHAT IS ACTUALLY CONNECTED, when the name does not already say it.
        // A client picks its own name at pairing and often picks the machine's
        // — Lintel pairs as "MINI-FBARBERA" — which left the row naming the box
        // and never the app running on it. The name is whatever it was called;
        // this line is what it is. Renaming a row does not make it lie.
        source,
        device.lastSeenAt ? `Last seen ${fmtAgo(device.lastSeenAt)}` : `Paired ${fmtAgo(device.createdAt)}`,
        // WHERE IT IS, which is the whole point of the report-back fields: two
        // rows reading "Chrome" are told apart by the address they came from.
        device.identity?.address,
        device.identity?.origin ? `via ${device.identity.origin}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")}
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
