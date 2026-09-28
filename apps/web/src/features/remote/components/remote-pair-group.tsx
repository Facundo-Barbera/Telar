"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { CopyCommand } from "@/ui/copy-command";
import { cn } from "@/ui/utils";
import { Row, SettingsGroup } from "@/features/settings";
import { QrCodeView } from "./qr-code";
import type { MintedPairing, RemoteStatus } from "../api";

type RemoteEndpoint = RemoteStatus["endpoints"][number];

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

function EndpointRow({ endpoint, selected, onSelect }: { endpoint: RemoteEndpoint; selected: boolean; onSelect: () => void }) {
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

function useExpired(minted: MintedPairing | null): boolean {
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
  return expired;
}

type EndpointChoice = { endpointUrl: string | null; onSelectEndpoint: (url: string) => void };

function MintedCode({ minted, endpoints, endpointUrl, onSelectEndpoint }: { minted: MintedPairing; endpoints: RemoteEndpoint[] } & EndpointChoice) {
  const selectedUrl = endpointUrl ?? endpoints.filter((endpoint) => endpoint.qrSafe).at(-1)?.url ?? endpoints.at(-1)?.url ?? null;
  const selectedEndpoint = endpoints.find((endpoint) => endpoint.url === selectedUrl);
  const matrix = selectedUrl && selectedEndpoint?.qrSafe ? minted.qrByUrl[selectedUrl] : undefined;
  const pairingUrl = selectedUrl ? `${selectedUrl}/pair#token=${minted.code}` : null;
  return (
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
              <EndpointRow key={endpoint.url} endpoint={endpoint} selected={endpoint.url === selectedUrl} onSelect={() => onSelectEndpoint(endpoint.url)} />
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
  );
}

export function RemotePairGroup({
  minted,
  endpoints,
  busy,
  onMint,
  endpointUrl,
  onSelectEndpoint,
}: {
  minted: MintedPairing | null;
  endpoints: RemoteEndpoint[];
  busy: boolean;
  onMint: () => void;
} & EndpointChoice) {
  const expired = useExpired(minted);
  return (
    <SettingsGroup
      title="Pair a device"
      description="One code, one device."
      action={
        <Button variant="outline" size="sm" disabled={busy} onClick={onMint}>
          {minted && !expired ? "New code" : "Show pairing code"}
        </Button>
      }
    >
      {minted && !expired ? (
        <MintedCode minted={minted} endpoints={endpoints} endpointUrl={endpointUrl} onSelectEndpoint={onSelectEndpoint} />
      ) : (
        <Row
          label="Pairing code"
          hint={expired ? "Expired — mint a new one." : "Shown once and never stored. Five minutes, or five wrong tries."}
          control={null}
        />
      )}
    </SettingsGroup>
  );
}
