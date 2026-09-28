"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TerminalIcon, ServerIcon, GlobeIcon, CircleHelpIcon, CheckIcon, CopyIcon, LockIcon, MonitorIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import type { DeviceIdentity, DeviceRole, RemoteDevice, RemoteState } from "@telar/engine-client";
import type { QrMatrix } from "../qr";
import { describeServeError, type TailscaleServeError } from "../tailscale-serve";
import { fmtAgo } from "@/ui/format";
import { desktopApp } from "@/platform/desktop/desktop-app";
import { hostVisible, subscribeHostVisibility } from "@/platform/desktop/host-visibility";
import { cn } from "@/ui/utils";
import { QrCodeView } from "./qr-code";
import { CopyCommand } from "@/ui/copy-command";
import { PushNotificationsGroup } from "@/features/push";
import { Dropdown, Row, SettingsGroup, ToggleRow } from "@/features/settings";

type RemoteStatus = RemoteState & {
  tailscaleServeError?: TailscaleServeError;
  host?: { name: string; identity?: DeviceIdentity; isCaller?: boolean };
  callerDeviceId?: string;
  callerRole?: DeviceRole;
  endpoints: Array<{ kind: string; label: string; url: string; qrSafe: boolean }>;
};

const KIND_ICONS: Record<string, typeof MonitorIcon> = {
  browser: GlobeIcon,
  phone: SmartphoneIcon,
  tablet: SmartphoneIcon,
  desktop: MonitorIcon,
  cli: TerminalIcon,
  service: ServerIcon,
};

interface MintedPairing {
  code: string;
  expiresAt: number;
  qrByUrl: Record<string, QrMatrix>;
}

const spaced = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

const ENDPOINT_HINTS: Record<string, string> = {
  loopback: "Clients on this machine",
  lan: "Devices on the same network",
  tailnet: "Devices on your private network",
  magicdns: "Any device, over HTTPS",
};

function PairingCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy pairing code"
      onClick={() => {
        navigator.clipboard
          ?.writeText(code)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
          });
      }}
      className="group flex shrink-0 items-center gap-3 rounded-lg border border-border/70 bg-muted/40 px-4 py-2.5 text-left transition-colors hover:bg-muted/70"
    >
      <span className="font-mono text-2xl tracking-[0.15em] whitespace-nowrap tabular-nums">{spaced(code)}</span>
      {copied ? <CheckIcon className="size-4 text-success" /> : <CopyIcon className="size-4 text-muted-foreground/70 group-hover:text-foreground" />}
    </button>
  );
}

function EndpointRow({ endpoint, selected, onSelect }: { endpoint: RemoteStatus["endpoints"][number]; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-baseline gap-2 rounded-md border px-3 py-1.5 text-left text-xs transition-colors",
        selected ? "border-border bg-muted font-medium text-foreground" : "border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      <span className="shrink-0">{endpoint.label}</span>
      <span className="min-w-0 truncate font-normal text-muted-foreground">{ENDPOINT_HINTS[endpoint.kind] ?? endpoint.url}</span>
    </button>
  );
}

export function RemoteSection() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [minted, setMinted] = useState<MintedPairing | null>(null);
  const [endpointUrl, setEndpointUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [expiryFor, setExpiryFor] = useState<MintedPairing | null>(null);
  if (expiryFor !== minted) {
    setExpiryFor(minted);
    setExpired(false);
  }

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

  const endpoints = useMemo(() => status?.endpoints ?? [], [status]);
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

  const setTailscaleServe = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/remote", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tailscaleServe: next }),
        });
        const body = (await response.json()) as { error?: { message?: string } };
        if (!response.ok) throw new Error(body.error?.message ?? `status ${response.status}`);
        setRestartNeeded(true);
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not change Tailscale HTTPS.");
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

  useEffect(
    () =>
      subscribeHostVisibility(() => {
        if (hostVisible()) void load();
      }),
    [load],
  );

  if (!status) {
    return (
      <SettingsGroup title="Pairing">
        <Row label="Loading" hint="Reading the pairing store." {...(error ? { error } : {})} control={null} />
      </SettingsGroup>
    );
  }

  const matrix = minted && selectedUrl && selectedEndpoint?.qrSafe ? minted.qrByUrl[selectedUrl] : undefined;
  const pairingUrl = minted && selectedUrl ? `${selectedUrl}/pair#token=${minted.code}` : null;
  const reachableAt = endpoints.filter((endpoint) => endpoint.kind !== "loopback");
  const magicdns = endpoints.find((endpoint) => endpoint.kind === "magicdns");
  const relaunch = desktopApp();

  return (
    <>
      <SettingsGroup title="Pairing">
        <ToggleRow
          label="Require pairing"
          icon={SmartphoneIcon}
          hint={
            error ??
            (status.requireAuth
              ? // TRUE ON BOTH PATHS TO "ON", which the old wording was not: a
                "Unpaired devices are refused. The app running the server is always in."
              : "Anything that can reach this address has full control. The tailnet ACL is the only boundary.")
          }
          checked={status.requireAuth}
          onCheckedChange={(next) => void toggle(next)}
        />
      </SettingsGroup>

      {status.requireAuth && (
        <SettingsGroup title="This environment">
          <ToggleRow
            label="Network access"
            icon={GlobeIcon}
            hint={
              status.exposure === "network-accessible" ? (
                reachableAt.length > 0 ? (
                  <>
                    Reachable at <span className="font-mono text-foreground">{reachableAt[0]!.url}/</span>
                    {reachableAt.length > 1 && <span className="ml-1 text-muted-foreground/70">+{reachableAt.length - 1}</span>}
                  </>
                ) : (
                  "Listening on every interface. Pairing is what guards it."
                )
              ) : (
                "Listening on 127.0.0.1 only — this machine is the only one that can reach it."
              )
            }
            checked={status.exposure === "network-accessible"}
            onCheckedChange={(next) => void setExposure(next ? "network-accessible" : "local-only")}
          />
          <ToggleRow
            label="Tailscale HTTPS"
            icon={LockIcon}
            hint={
              magicdns ? (
                <>
                  Served at <span className="font-mono text-foreground">{magicdns.url}/</span> — a real certificate, so phone browsers get a secure context.
                </>
              ) : /**
                   * THE FAILURE BEATS THE PROMISE. "Publishes at the next
                   * launch" is what this said for ever to somebody whose last
                   * launch already tried and failed — so when the launcher
                   * reported a reason, that is the hint (#627).
                   */
              status.tailscaleServeError ? (
                <span className="text-destructive">{describeServeError(status.tailscaleServeError)}</span>
              ) : status.tailscaleServe ? (
                "Publishes at the next launch. Needs Tailscale running, with HTTPS certificates on for your tailnet."
              ) : (
                <>
                  Expose this cockpit through a MagicDNS HTTPS URL — a real certificate, so phone browsers get a secure context.{" "}
                  <span className="text-foreground">
                    Issuing it publishes this machine&rsquo;s name to a public Certificate Transparency log, permanently. Rename the machine in
                    Tailscale first if it carries yours.
                  </span>{" "}
                  Dictation also works over an <span className="font-mono text-foreground">ssh -L</span> tunnel, which needs neither.
                </>
              )
            }
            checked={status.tailscaleServe === true}
            onCheckedChange={(next) => void setTailscaleServe(next)}
          />
          {restartNeeded && (
            <Row
              label="Restart to apply"
              hint="The server chooses its addresses when it starts, so this takes effect at the next launch."
              control={
                relaunch ? (
                  <Button variant="outline" size="sm" onClick={() => void relaunch.relaunch()}>
                    Restart Telar
                  </Button>
                ) : null
              }
            />
          )}
        </SettingsGroup>
      )}

      {status.requireAuth && (
        <SettingsGroup
          title="Pair a device"
          description="One code, one device."
          action={
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void mint()}>
              {minted && !expired ? "New code" : "Show pairing code"}
            </Button>
          }
        >
          {minted && !expired ? (
            <div className="flex flex-col gap-4 py-3 sm:flex-row sm:items-start sm:gap-6">
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <PairingCode code={minted.code} />
                  <span className="min-w-0 text-xs text-muted-foreground">
                    Type it into the pairing page on the other device. It lives five minutes, and is destroyed after five wrong tries.
                  </span>
                </div>
                {endpoints.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      Reach this machine via — each browser pairs per address, so the tailnet IP and a ts.net name are different origins.
                    </span>
                    {endpoints.map((endpoint) => (
                      <EndpointRow key={endpoint.url} endpoint={endpoint} selected={endpoint.url === selectedUrl} onSelect={() => setEndpointUrl(endpoint.url)} />
                    ))}
                  </div>
                )}
                {pairingUrl && <CopyCommand command={pairingUrl} />}
              </div>
              <div className="relative size-44 shrink-0">
                {matrix ? (
                  <QrCodeView matrix={matrix} className="size-44 rounded-md border border-border/70" />
                ) : (
                  <div className="flex size-44 items-center justify-center rounded-md border border-dashed border-border/60 p-4 text-center text-2xs leading-snug text-muted-foreground/70">
                    Nothing to scan — a phone dialling this machine&apos;s address would reach itself.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <Row
              label="Pairing code"
              hint={expired ? "Expired — mint a new one." : "Shown once and never stored. Five minutes, or five wrong tries."}
              control={null}
            />
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        title="Paired devices"
        description={
          status.requireAuth
            ? "Devices that may reach this cockpit."
            : "Pairing is off — these credentials only matter again when you turn it back on."
        }
        {...(status.host
          ? {
              action: (
                <Badge variant="outline" title="Runs the server — always connected, nothing to revoke">
                  {status.host.isCaller ? "This app" : "Host"} · {status.host.name}
                </Badge>
              ),
            }
          : {})}
      >
        {status.devices.length === 0 ? (
          <Row label="None yet" hint="Devices appear here as they pair." control={null} />
        ) : (
          <div className="-mx-4 max-h-80 overflow-y-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border/40 text-2xs font-normal tracking-wide text-muted-foreground uppercase">
                  <th scope="col" className="py-1.5 pr-3 pl-4 font-normal">Device</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">Kind</th>
                  <th scope="col" className="py-1.5 pr-3 font-normal">Last seen</th>
                  <th scope="col" className="py-1.5 pr-4 text-right font-normal">Actions</th>
                </tr>
              </thead>
              <tbody>
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
              </tbody>
            </table>
          </div>
        )}
      </SettingsGroup>

      <PushNotificationsGroup />

      {status.devices.length > 1 && status.callerDeviceId && (
        <SettingsGroup title="Danger">
          <RevokeOthersRow count={status.devices.length - 1} onConfirm={() => void revokeOthers()} />
        </SettingsGroup>
      )}
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
  const kind = device.identity?.kind ?? (device.platform === "ios" ? "phone" : device.platform);
  const Icon = (kind ? KIND_ICONS[kind] : undefined) ?? CircleHelpIcon;
  const declaredSource = [device.identity?.client, device.identity?.machine].filter(Boolean).join(" · ");
  const source = declaredSource && !device.name.includes(declaredSource) ? declaredSource : undefined;
  const whereabouts = [device.identity?.address, device.identity?.origin ? `via ${device.identity.origin}` : undefined]
    .filter(Boolean)
    .join(" · ");

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== device.name) onRename(draft);
  };

  return (
    <tr className="border-b border-border/40 align-middle last:border-0">
      <td className="py-2 pr-3 pl-4">
        {editing ? (
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
            className="h-6 w-44 px-1.5 text-xs"
          />
        ) : (
          <span className="flex items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />
            <span className="min-w-0">
              <button
                type="button"
                className="cursor-text decoration-dotted underline-offset-2 hover:underline"
                title="Rename"
                onClick={() => {
                  setDraft(device.name);
                  setEditing(true);
                }}
              >
                {device.name}
              </button>
              {whereabouts && <span className="block truncate text-2xs text-muted-foreground">{whereabouts}</span>}
            </span>
            {isSelf && <Badge variant="outline">This device</Badge>}
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-muted-foreground">{source ?? kind ?? "—"}</td>
      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
        {device.lastSeenAt ? fmtAgo(device.lastSeenAt) : `paired ${fmtAgo(device.createdAt)}`}
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center justify-end gap-1.5">
          <Dropdown<"full" | "observer">
            value={device.role}
            className="h-6 w-28"
            label={`What ${device.name} may do`}
            disabled={busy}
            onChange={(role) => {
              if (!busy && role !== device.role) onRole(role);
            }}
            options={[
              { value: "full", text: "Full", label: <span title="Reads and changes everything, like this app">Full</span> },
              { value: "observer", text: "View only", label: <span title="Reads everything, changes nothing">View only</span> },
            ]}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Revoke ${device.name}`}
            title="Logs this device out on its next request. Nothing on the device changes, and it can pair again."
            onClick={onRevoke}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

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
      hint="Keeps this one — the lost-phone button. Any of them can pair again with a new code."
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
