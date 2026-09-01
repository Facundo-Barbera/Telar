"use client";

/**
 * PERMISSIONS — the macOS grants agent capabilities stand on.
 *
 * Computer use is the first resident: Claude and Codex sessions drive Mac apps
 * through Codex's Sky client, and that path crosses THREE separately-fixable
 * facts — the plugin being installed (an install task), the host app running
 * (one button here), and the macOS Automation grant (a decision macOS keys on
 * a responsible process the engine cannot reliably name from the inside; the
 * dev chain ends at an orphaned process and `launchctl procinfo` needs root).
 *
 * SO THE TEST IS THE GRANTING FLOW. "Test access" runs one real read-only call
 * (`list_apps`) through the actual client: granted answers granted, denied
 * answers with the exact code (-1743), and an UNDECIDED grant makes macOS put
 * up its own prompt — which names the responsible app better than this page
 * ever could. That is also how Codex handles it; its `doctor` additionally
 * reads the unified security log for enforcement history, which needs access
 * this process does not have.
 */

import { useCallback, useEffect, useState } from "react";
import type { ComputerUseStatus } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** macOS's own deep link to the Automation pane. Works from the desktop
 *  shell; in a browser tab it is inert, which is why the prose beside it also
 *  spells the path out. */
const AUTOMATION_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

function PermissionBadge({ status }: { status: ComputerUseStatus }) {
  if (!status.installed) return <Badge variant="outline">Not installed</Badge>;
  switch (status.permission) {
    case "granted":
      return <Badge variant="secondary">Granted</Badge>;
    case "denied":
      return <Badge variant="destructive">Denied</Badge>;
    case "host-not-running":
      return <Badge variant="outline">Host app not running</Badge>;
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

  const wake = async () => {
    try {
      await api.wakeComputerUseHost();
      // The app takes a moment to come up; re-measure after it has had one.
      window.setTimeout(() => void check(), 1_500);
    } catch {
      setError("The engine did not answer.");
    }
  };

  return (
    <>
      <SettingsGroup
        title="Computer use"
        description="Sessions can drive Mac apps — screenshots, clicks, typing — through Codex's Computer Use client. Claude and Codex sessions share the same engine and the same grants."
      >
        <Row
          label="Codex plugin"
          hint={status && !status.installed ? "Install Codex and enable Computer Use in its settings; Telar picks it up from there." : "Discovered from the Codex install. Nothing to configure here."}
          control={
            checking && !status ? <Spinner className="size-4" /> : status?.installed ? <Badge variant="secondary">Installed</Badge> : <Badge variant="outline">Not installed</Badge>
          }
        />
        {status?.installed && (
          <Row
            label="Host app"
            hint="The background app that performs the actions. Woken automatically when a session first needs it."
            control={
              <div className="flex items-center gap-2">
                {status.hostRunning ? <Badge variant="secondary">Running</Badge> : <Badge variant="outline">Stopped</Badge>}
                {!status.hostRunning && (
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
            label="Automation permission"
            hint={
              status.permission === "denied"
                ? "macOS refused Apple events (-1743). System Settings → Privacy & Security → Automation: enable “Codex Computer Use” under Telar (the packaged app) — or, in a dev build, under the terminal that launched the engine — then test again."
                : status.permission === "granted"
                  ? "One real read-only call succeeded. Claude and Codex sessions can drive the Mac."
                  : "Testing sends one real read-only call. The first time, macOS shows its own “Telar wants to control Codex Computer Use” prompt — allow it and one grant covers every session. (In a dev build the prompt names the terminal, not Telar.)"
            }
            control={
              <div className="flex items-center gap-2">
                {checking ? <Spinner className="size-4" /> : <PermissionBadge status={status} />}
                <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
                  Test access
                </Button>
                {status.permission === "denied" && (
                  <Button size="sm" variant="ghost" onClick={() => window.open(AUTOMATION_PANE)}>
                    Open System Settings
                  </Button>
                )}
              </div>
            }
          />
        )}
        {(error || status?.message) && (
          <Row label="Last answer" hint="The provider's own words, verbatim." control={<code className="max-w-96 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{error ?? status?.message}</code>} />
        )}
      </SettingsGroup>
    </>
  );
}
