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
  return status.backend === "cua" ? "cua-driver" : "Codex Computer Use";
}

/**
 * What the Engine row says. A probe that is running and one that FAILED are
 * different facts, and neither is an engine — the first draft rendered
 * "Checking" forever once the request rejected.
 */
export function engineHint(input: { status?: ComputerUseStatus; checking: boolean; failed: boolean; isCua: boolean }): string {
  if (input.failed) return "Could not reach the engine. Retry to check again.";
  if (!input.status) return "Checking which engine is installed.";
  if (!input.status.installed) return "Install cua-driver (github.com/trycua/cua), or Codex, and Telar picks it up.";
  // THE CODEX CARVE-OUT BELONGS TO THE cua ANSWER, not to the page. "When Telar
  // supplies the engine, Codex's own computer use is off for Telar sessions
  // only" sat in the group header, where it was conditional prose a reader had
  // to evaluate against a fact three rows down. It IS the cua branch, so it is
  // stated once the probe has measured one — and the reassurance that the carve
  // -out is scoped to Telar is the half people actually need.
  return input.isCua
    ? "Open source — Telar holds the grants through CuaDriver.app. Codex's own computer use is off for Telar sessions only."
    : "Codex's bundled client. Install cua-driver to switch to the open-source engine.";
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
      description="Sessions can drive Mac apps — screenshots, clicks, typing."
    >
      {/* Three states, not two: checking, failed, answered. Neither of the
          first two may name an engine — see `engineHint`. */}
      <Row
        label="Engine"
        hint={engineHint({ status, checking, failed: !status && !checking && error !== undefined, isCua })}
        control={
          checking && !status ? (
            <Spinner className="size-4" />
          ) : status ? (
            <Badge variant={status.installed ? "secondary" : "outline"}>{backendLabel(status)}</Badge>
          ) : (
            <div className="flex items-center gap-2">
              <Badge variant="outline">Unknown</Badge>
              <Button size="sm" variant="outline" onClick={() => void check()}>
                Retry
              </Button>
            </div>
          )
        }
      />
      {status?.installed && (
        <Row
          label={isCua ? "Driver daemon" : "Host app"}
          hint={
            isCua
              ? "Launches automatically when a session first needs it."
              : "Woken automatically when a session first needs it."
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
              ? "A read-only call succeeded. Sessions can drive the Mac."
              : isCua
                ? "cua-driver needs Accessibility + Screen Recording. “Grant access” launches CuaDriver.app so macOS attributes the prompts to it."
                : status.permission === "denied"
                  ? "macOS refused Apple events. System Settings → Privacy & Security → Automation: enable the target under Telar (packaged) or the terminal (dev), then test again."
                  : "“Test access” sends one read-only call; macOS prompts the first time."
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
