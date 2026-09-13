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
import { TerminalIcon, ServerIcon, GlobeIcon, CircleHelpIcon, CheckIcon, CopyIcon, LockIcon, MonitorIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QrMatrix } from "@/lib/remote/qr";
import { fmtAgo } from "@/lib/format";
import { desktopApp } from "@/lib/desktop-app";
import { cn } from "@/lib/utils";
import { QrCodeView } from "./qr-code";
import { CopyCommand } from "./copy-command";
import { Dropdown, Row, SettingsGroup, ToggleRow } from "./settings-shell";

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
  tailscaleServe?: boolean;
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
  /** Eight digits — the one pairing secret. Typed, scanned or linked. */
  code: string;
  expiresAt: number;
  qrByUrl: Record<string, QrMatrix>;
}

/** "48129037" → "4812 9037": the way a person reads eight digits off a screen. */
const spaced = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

/** What each address is for, in the words a person choosing one needs. */
const ENDPOINT_HINTS: Record<string, string> = {
  loopback: "Clients on this machine",
  lan: "Devices on the same network",
  tailnet: "Devices on your private network",
  magicdns: "Any device, over HTTPS",
};

/** The pairing code, big, with its own copy button — the thing a person reads
 *  across a room or copies into a message. One control, one secret. */
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
            // No clipboard on an insecure origin: the digits are on screen.
          });
      }}
      className="group flex shrink-0 items-center gap-3 rounded-lg border border-border/70 bg-muted/40 px-4 py-2.5 text-left transition-colors hover:bg-muted/70"
    >
      <span className="font-mono text-2xl tracking-[0.15em] whitespace-nowrap tabular-nums">{spaced(code)}</span>
      {copied ? <CheckIcon className="size-4 text-success" /> : <CopyIcon className="size-4 text-muted-foreground/70 group-hover:text-foreground" />}
    </button>
  );
}

/** An address as a row you pick, not a segment you squint at — the label
 *  and what it reaches, selected state as a quiet fill. */
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

  /** Persisted now, honoured at the next launch — exactly like exposure. */
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
      {/* NO CAPTION: the row's sentence changes with the switch and is the one
          worth reading, and a standing "Who may reach this cockpit from other
          devices" over a row called "Require pairing" was the doubling #357 is
          about. */}
      <SettingsGroup title="Pairing">
        <ToggleRow
          label="Require pairing"
          icon={SmartphoneIcon}
          hint={
            error ??
            (status.requireAuth
              ? // TRUE ON BOTH PATHS TO "ON", which the old wording was not: a
                // fresh store starts here (#357) with nothing paired at all, and
                // the app running the server is admitted by the host secret
                // rather than by a device record. Flipping the switch by hand
                // still pairs the browser that flipped it, in the same
                // round-trip, so neither route can lock itself out.
                "Unpaired devices are refused. The app running the server is always in."
              : "Anything that can reach this address has full control. The tailnet ACL is the only boundary.")
          }
          checked={status.requireAuth}
          onCheckedChange={(next) => void toggle(next)}
        />
      </SettingsGroup>

      {/* WHERE THIS COCKPIT CAN BE REACHED — the environment, beside who may
          reach it. Only offered once pairing is on: binding every interface,
          or publishing a ts.net name, without a gate would put an unguarded
          cockpit on whatever network this machine is attached to. Both are
          read by the shell at launch, so a change offers a restart rather
          than pretending it took. */}
      {status.requireAuth && (
        // NO CAPTION: both rows print the ADDRESS this cockpit is actually
        // reachable at, which is the answer the caption was asking for (#357).
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
              ) : status.tailscaleServe ? (
                "Will publish through Tailscale Serve at the next launch. Needs Tailscale running with HTTPS certificates enabled for your tailnet."
              ) : (
                "Use Tailscale Serve to expose this cockpit through a MagicDNS HTTPS URL."
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
          // THE CODE'S LIFETIME IS THE CODE'S BUSINESS, and the per-address rule
          // is the endpoint picker's. Both used to sit here, in a header read
          // before either thing is on screen — so the lifetime was forgotten by
          // the time a code existed, and the origins rule was abstract until
          // there was a list of addresses to choose between. Each now sits on
          // the thing it governs, below.
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
                {/* THE CODE, BIG, WITH ITS OWN COPY. It is what a person reads
                    across a room and types on a phone. The QR and the link
                    below carry the SAME eight digits — a way to enter the
                    code, not a second secret. */}
                <div className="flex flex-wrap items-center gap-3">
                  <PairingCode code={minted.code} />
                  <span className="min-w-0 text-xs text-muted-foreground">
                    Type it into the pairing page on the other device. It lives five minutes, and is destroyed after five wrong tries.
                  </span>
                </div>
                {endpoints.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    {/* WHY THE CHOICE MATTERS, beside the choice. A browser
                        pairs per ORIGIN, so picking the tailnet IP here and
                        opening the ts.net name later is two pairings, not one —
                        which is only worth saying when there is a list to pick
                        from, and is noise in a header when there is not. */}
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
              {/* THE QR KEEPS ITS PLACE WHEN IT HAS NOTHING TO SHOW. Loopback
                  has no QR — a phone dialling 127.0.0.1 reaches itself — but
                  removing the element made the card reflow on every pick. So
                  it dims and says why, at exactly the size the code takes. */}
              <div className="relative size-44 shrink-0">
                {matrix ? (
                  <QrCodeView matrix={matrix} className="size-44 rounded-md border border-border/70" />
                ) : (
                  <div className="flex size-44 items-center justify-center rounded-md border border-dashed border-border/60 p-4 text-center text-[0.6875rem] leading-snug text-muted-foreground/70">
                    Nothing to scan — a phone dialling this machine&apos;s address would reach itself.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <Row
              label="Pairing code"
              // The lifetime, on the row that is about the code. Five minutes
              // and five wrong tries is what a person needs when deciding
              // whether to mint one now or walk to the other device first.
              hint={expired ? "Expired — mint a new one." : "Shown once and never stored. A code lives five minutes, and is destroyed after five wrong tries."}
              control={null}
            />
          )}
        </SettingsGroup>
      )}

      {/* THREE SENTENCES OF INSTRUCTIONS BECAME ONE OF SCOPE. The header taught
          renaming, explained what "view only" means and described what revoking
          does — a paragraph to hold while looking down a list for one device.
          Each of those belongs to a control that is already on the row: the name
          is a button that says "Rename", the roles are a dropdown whose two
          options carry their own tooltips, and the ✕ says what it does and what
          it leaves alone. */}
      {/* THE HOST IS A BADGE ON THE HEADER, NOT A ROW (#357). It used to sit in
          the list wearing the shape of a paired device — "This app · Runs the
          server — always connected, nothing to revoke" — which is a row whose
          whole content is that none of the list's controls apply to it. The
          name is still worth showing, because a list of devices that omits the
          one certain answer is the bug the row was added to fix; a badge says
          it without pretending to be revocable. */}
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
          /*
            A TABLE WITH ITS OWN SCROLL, NOT A ROW PER DEVICE (#365).

            Every device was a `Row` with a four-fact sentence under its name, so
            a pane whose LENGTH was a property of how many phones somebody had
            ever paired — and the settings below it (Other Macs, the Danger
            group) moved down the page every time one more did. A person reading
            a list of devices is comparing them, which is what columns are for,
            and the box stops growing at ten-ish rows.

            THE HEIGHT IS FIXED IN PIXELS RATHER THAN IN ROWS. A row's height
            depends on whether its device declared a client and a machine, so
            `max-h` is the only cap that holds for a list of both kinds.
          */
          <div className="-mx-4 max-h-80 overflow-y-auto">
            <table className="w-full border-collapse text-left text-xs">
              {/* STICKY, because a scrolled list whose headings have gone is
                  four columns of values with nothing saying which is which. */}
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border/60 text-[0.6875rem] font-normal tracking-wide text-muted-foreground uppercase">
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

      {/* DANGER, AT THE FLOOR OF THE PANE. A plain label and no red panel — the
          separation is structural, so the one action that logs several devices
          out is never adjacent to the per-device controls it resembles. It used
          to be the last row inside "Paired devices", one hairline below a ✕ that
          revokes exactly one.
          Per-device revoke stays on its own row: it belongs to the device it
          names, and a Danger group that hoisted every list affordance out of its
          list would be a worse page, not a safer one. */}
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
  // The kind first; the old platform field only for rows written before it.
  const kind = device.identity?.kind ?? (device.platform === "ios" ? "phone" : device.platform);
  const Icon = (kind ? KIND_ICONS[kind] : undefined) ?? CircleHelpIcon;
  /**
   * WHAT IS ACTUALLY CONNECTED, when the name does not already say it. A client
   * picks its own name at pairing and often picks the machine's — Lintel pairs
   * as "MINI-FBARBERA" — which left the row naming the box and never the app
   * running on it. The name is whatever it was called; this is what it IS, and
   * it has a column of its own now rather than riding in a run-on sentence.
   */
  const declaredSource = [device.identity?.client, device.identity?.machine].filter(Boolean).join(" · ");
  const source = declaredSource && !device.name.includes(declaredSource) ? declaredSource : undefined;
  // WHERE IT IS, which is the whole point of the report-back fields: two rows
  // reading "Chrome" are told apart by the address they came from.
  const whereabouts = [device.identity?.address, device.identity?.origin ? `via ${device.identity.origin}` : undefined]
    .filter(Boolean)
    .join(" · ");

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== device.name) onRename(draft);
  };

  return (
    <tr className="border-b border-border/60 align-middle last:border-0">
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
              {whereabouts && <span className="block truncate text-[0.6875rem] text-muted-foreground">{whereabouts}</span>}
            </span>
            {isSelf && <Badge variant="outline">This device</Badge>}
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-muted-foreground">{source ?? kind ?? "—"}</td>
      {/* PAIRED, NOT SEEN, when it has never come back — a column headed "Last
          seen" showing the pairing date would be a lie by omission. */}
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
            // WHAT EACH ROLE MEANS, on the option rather than in a header —
            // the same `<span title>` the transport picker uses in
            // mcp-section.tsx, so "view only" is defined where it is chosen.
            options={[
              { value: "full", text: "Full", label: <span title="Reads and changes everything, like this app">Full</span> },
              { value: "observer", text: "View only", label: <span title="Reads everything, changes nothing">View only</span> },
            ]}
          />
          {/* What revoking does NOT do: nothing on the device itself changes,
              and it can pair again with a new code. */}
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
      hint="Keeps this one — the lost-phone button. Nothing on those devices changes, and any of them can pair again with a new code."
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
