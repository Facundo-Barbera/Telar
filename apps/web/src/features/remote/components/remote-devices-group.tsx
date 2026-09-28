"use client";

import { useEffect, useState } from "react";
import { TerminalIcon, ServerIcon, GlobeIcon, CircleHelpIcon, MonitorIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { fmtAgo } from "@/ui/format";
import { Dropdown, Row, SettingsGroup } from "@/features/settings";
import type { RemoteDevice } from "@telar/engine-client";
import type { RemoteStatus } from "../api";

const KIND_ICONS: Record<string, typeof MonitorIcon> = {
  browser: GlobeIcon,
  phone: SmartphoneIcon,
  tablet: SmartphoneIcon,
  desktop: MonitorIcon,
  cli: TerminalIcon,
  service: ServerIcon,
};

function DeviceName({ device, isSelf, onRename }: { device: RemoteDevice; isSelf: boolean; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name);
  const kind = device.identity?.kind ?? (device.platform === "ios" ? "phone" : device.platform);
  const Icon = (kind ? KIND_ICONS[kind] : undefined) ?? CircleHelpIcon;
  const whereabouts = [device.identity?.address, device.identity?.origin ? `via ${device.identity.origin}` : undefined]
    .filter(Boolean)
    .join(" · ");

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== device.name) onRename(draft);
  };

  if (editing) {
    return (
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
    );
  }
  return (
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
  );
}

type DeviceActions = {
  busy: boolean;
  onRename: (id: string, name: string) => void;
  onRole: (id: string, role: "full" | "observer") => void;
  onRevoke: (id: string) => void;
};

function DeviceRow({ device, isSelf, busy, onRename, onRole, onRevoke }: { device: RemoteDevice; isSelf: boolean } & DeviceActions) {
  const kind = device.identity?.kind ?? (device.platform === "ios" ? "phone" : device.platform);
  const declaredSource = [device.identity?.client, device.identity?.machine].filter(Boolean).join(" · ");
  const source = declaredSource && !device.name.includes(declaredSource) ? declaredSource : undefined;

  return (
    <tr className="border-b border-border/40 align-middle last:border-0">
      <td className="py-2 pr-3 pl-4">
        <DeviceName device={device} isSelf={isSelf} onRename={(name) => onRename(device.id, name)} />
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
              if (!busy && role !== device.role) onRole(device.id, role);
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
            onClick={() => onRevoke(device.id)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

export function RemoteDevicesGroup({ status, ...actions }: { status: RemoteStatus } & DeviceActions) {
  return (
    <SettingsGroup
      title="Paired devices"
      description={
        status.requireAuth ? "Devices that may reach this cockpit." : "Pairing is off — these credentials only matter again when you turn it back on."
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
                <DeviceRow key={device.id} device={device} isSelf={device.id === status.callerDeviceId} {...actions} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsGroup>
  );
}

export function RevokeOthersRow({ count, onConfirm }: { count: number; onConfirm: () => void }) {
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
