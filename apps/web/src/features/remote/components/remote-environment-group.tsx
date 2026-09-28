"use client";

import { GlobeIcon, LockIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { desktopApp } from "@/platform/desktop/desktop-app";
import { Row, SettingsGroup, ToggleRow } from "@/features/settings";
import { describeServeError } from "../tailscale-serve";
import type { RemoteStatus } from "../api";

function TailscaleHint({ status }: { status: RemoteStatus }) {
  const magicdns = status.endpoints.find((endpoint) => endpoint.kind === "magicdns");
  if (magicdns) {
    return (
      <>
        Served at <span className="font-mono text-foreground">{magicdns.url}/</span> — a real certificate, so phone browsers get a secure context.
      </>
    );
  }
  if (status.tailscaleServeError) return <span className="text-destructive">{describeServeError(status.tailscaleServeError)}</span>;
  if (status.tailscaleServe) return "Publishes at the next launch. Needs Tailscale running, with HTTPS certificates on for your tailnet.";
  return (
    <>
      Expose this cockpit through a MagicDNS HTTPS URL — a real certificate, so phone browsers get a secure context.{" "}
      <span className="text-foreground">
        Issuing it publishes this machine&rsquo;s name to a public Certificate Transparency log, permanently. Rename the machine in Tailscale first if
        it carries yours.
      </span>{" "}
      Dictation also works over an <span className="font-mono text-foreground">ssh -L</span> tunnel, which needs neither.
    </>
  );
}

function ExposureHint({ status }: { status: RemoteStatus }) {
  if (status.exposure !== "network-accessible") return "Listening on 127.0.0.1 only — this machine is the only one that can reach it.";
  const reachableAt = status.endpoints.filter((endpoint) => endpoint.kind !== "loopback");
  if (reachableAt.length === 0) return "Listening on every interface. Pairing is what guards it.";
  return (
    <>
      Reachable at <span className="font-mono text-foreground">{reachableAt[0]!.url}/</span>
      {reachableAt.length > 1 && <span className="ml-1 text-muted-foreground/70">+{reachableAt.length - 1}</span>}
    </>
  );
}

export function RemoteEnvironmentGroup({
  status,
  restartNeeded,
  onExposure,
  onTailscaleServe,
}: {
  status: RemoteStatus;
  restartNeeded: boolean;
  onExposure: (next: "local-only" | "network-accessible") => void;
  onTailscaleServe: (next: boolean) => void;
}) {
  const relaunch = desktopApp();
  return (
    <SettingsGroup title="This environment">
      <ToggleRow
        label="Network access"
        icon={GlobeIcon}
        hint={<ExposureHint status={status} />}
        checked={status.exposure === "network-accessible"}
        onCheckedChange={(next) => onExposure(next ? "network-accessible" : "local-only")}
      />
      <ToggleRow
        label="Tailscale HTTPS"
        icon={LockIcon}
        hint={<TailscaleHint status={status} />}
        checked={status.tailscaleServe === true}
        onCheckedChange={onTailscaleServe}
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
  );
}
