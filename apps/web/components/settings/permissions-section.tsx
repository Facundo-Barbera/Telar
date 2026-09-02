"use client";

/**
 * PERMISSIONS — the macOS grants agent capabilities stand on.
 *
 * Computer use is the first resident: Claude and Codex sessions drive Mac apps
 * through a desktop engine Telar owns. Two backends can supply it, and the pane
 * says which is in play, because the fix differs:
 *
 *   - cua-driver (trycua/cua, MIT) — Telar's own. CuaDriver.app holds the
 *     Accessibility + Screen Recording grants, and "Grant access" runs cua's
 *     native flow, which launches the app through LaunchServices so the dialogs
 *     attribute to it. Clean, and the app can be bundled.
 *   - Codex's Sky client — the proprietary fallback, reached over Apple events.
 *     Its grant is an Automation permission on whatever process macOS holds
 *     responsible, and "Test access" is the flow that raises that prompt.
 *
 * Either way the answer is MEASURED — one real read-only call — never
 * remembered, so a stale grant can't lie to the reader.
 */

import { useCallback, useEffect, useState } from "react";
import type { ComputerUseStatus } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** macOS's own deep link to the Automation pane — the Sky-backend fix. Inert
 *  in a browser tab, which is why the prose spells the path out too. */
const AUTOMATION_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

function backendLabel(status: ComputerUseStatus): string {
  if (!status.installed) return "Not installed";
  return status.backend === "cua" ? "cua-driver (open source)" : "Codex Computer Use (Sky)";
}

function PermissionBadge({ status }: { status: ComputerUseStatus }) {
  if (!status.installed) return <Badge variant="outline">Not installed</Badge>;
  switch (status.permission) {
    case "granted":
      return <Badge variant="secondary">Granted</Badge>;
    case "denied":
      return <Badge variant="destructive">Not granted</Badge>;
    case "host-not-running":
      return <Badge variant="outline">Host not running</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

export function PermissionsSection() {
  const [status, setStatus] = useState<ComputerUseStatus>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();

  const check = useCallback(async () => {
    setChecking(true);
    setError(undefined);
    try {
      setStatus((await api.computerUseStatus()).computerUse);
    } catch {
      setError("The engine did not answer.");
    } finally {
      setChecking(false);
    }
  }, []);

  // Measured on entry: the page IS the readout, and a stale remembered answer
  // would defeat it. The probe is read-only.
  useEffect(() => {
    const task = window.setTimeout(() => void check(), 0);
    return () => window.clearTimeout(task);
  }, [check]);

  const isCua = status?.backend === "cua";

  const grant = async () => {
    try {
      await api.grantComputerUseAccess();
      // The grant dialogs take a moment; re-measure after they've had one.
      window.setTimeout(() => void check(), 2_500);
    } catch {
      setError("The engine did not answer.");
    }
  };

  const wake = async () => {
    try {
      await api.wakeComputerUseHost();
      window.setTimeout(() => void check(), 1_500);
    } catch {
      setError("The engine did not answer.");
    }
  };

  return (
    <SettingsGroup
      title="Computer use"
      description="Claude and Codex sessions can drive Mac apps — screenshots, clicks, typing — through a desktop engine Telar owns. When Telar supplies it, Codex's own computer use is turned off for Telar's sessions only."
    >
      <Row
        label="Engine"
        hint={
          status && !status.installed
            ? "Install the open-source cua-driver (github.com/trycua/cua) — or Codex, whose bundled Computer Use works as a fallback — and Telar picks it up."
            : isCua
              ? "The open-source trycua/cua driver. Telar drives it and holds the grants through CuaDriver.app."
              : "Codex's bundled Computer Use client (proprietary). Install cua-driver to switch to the open-source engine."
        }
        control={checking && !status ? <Spinner className="size-4" /> : <Badge variant={status?.installed ? "secondary" : "outline"}>{backendLabel(status ?? { installed: false, hostRunning: false })}</Badge>}
      />
      {status?.installed && (
        <Row
          label={isCua ? "Driver daemon" : "Host app"}
          hint={
            isCua
              ? "CuaDriver.app runs the actions in the background; it launches automatically when a session first needs it."
              : "The background app that performs the actions. Woken automatically when a session first needs it."
          }
          control={
            <div className="flex items-center gap-2">
              {status.hostRunning ? <Badge variant="secondary">Running</Badge> : <Badge variant="outline">Stopped</Badge>}
              {!status.hostRunning && !isCua && (
                <Button size="sm" variant="outline" onClick={() => void wake()}>
                  Wake
                </Button>
              )}
            </div>
          }
        />
      )}
      {status?.installed && (
        <Row
          label="Access"
          hint={
            status.permission === "granted"
              ? "One real read-only call succeeded. Claude and Codex sessions can drive the Mac."
              : isCua
                ? "cua-driver needs Accessibility + Screen Recording. “Grant access” launches CuaDriver.app so macOS attributes the prompts to it."
                : status.permission === "denied"
                  ? "macOS refused Apple events. System Settings → Privacy & Security → Automation: enable the target under Telar (packaged) or the terminal (dev), then test again."
                  : "“Test access” sends one real read-only call; the first time, macOS shows its own consent prompt."
          }
          control={
            <div className="flex items-center gap-2">
              {checking ? <Spinner className="size-4" /> : <PermissionBadge status={status} />}
              {isCua && status.permission !== "granted" && (
                <Button size="sm" variant="outline" disabled={checking} onClick={() => void grant()}>
                  Grant access
                </Button>
              )}
              <Button size="sm" variant={isCua ? "ghost" : "outline"} disabled={checking} onClick={() => void check()}>
                Test access
              </Button>
              {!isCua && status.permission === "denied" && (
                <Button size="sm" variant="ghost" onClick={() => window.open(AUTOMATION_PANE)}>
                  Open System Settings
                </Button>
              )}
            </div>
          }
        />
      )}
      {(error || status?.message) && (
        <Row label="Last answer" hint="The backend's own words, verbatim." control={<code className="max-w-96 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{error ?? status?.message}</code>} />
      )}
    </SettingsGroup>
  );
}
