"use client";

/**
 * COMPUTER USE — whether sessions can drive Mac apps, in one row.
 *
 * Claude and Codex sessions drive Mac apps through a desktop engine Telar owns.
 * Two backends can supply it:
 *
 *   - cua-driver (trycua/cua, MIT) — Telar's own. CuaDriver.app holds the
 *     Accessibility + Screen Recording grants, and "Grant access" runs cua's
 *     native flow, which launches the app through LaunchServices so the dialogs
 *     attribute to it.
 *   - Codex's Sky client — the proprietary fallback, reached over Apple events.
 *     Its grant is an Automation permission on whatever process macOS holds
 *     responsible, and "Test access" is the flow that raises that prompt.
 *
 * Either way the answer is MEASURED — one real read-only call — never
 * remembered, so a stale grant can't lie to the reader.
 *
 * THREE ROWS BECAME ONE (#357). "Engine", "Driver daemon" and "Access" were
 * three readouts of a single question — can a session drive this Mac — and a
 * reader had to combine three badges to answer it. Worse, two of the three were
 * unactionable trivia: which open-source project supplies the engine, and that
 * a daemon "launches automatically when a session first needs it", which is to
 * say there is nothing to do about it. What survives is the ONE state that
 * decides the feature and the ONE sentence that says how to fix it — the grant
 * names and where macOS hides the switch, which is what a person blocked here
 * actually needs.
 */

import { useCallback, useEffect, useState } from "react";
import { MonitorIcon } from "lucide-react";
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

/** What the row's state is CALLED. Ordered by what stops the feature first: an
 *  engine that is not installed cannot be ungranted, and one that is not running
 *  cannot be tested. */
export type ComputerUseState = "checking" | "unknown" | "not-installed" | "not-running" | "not-granted" | "ready";

/**
 * The whole readout, from the probe. Pure and exported because it is the
 * decision this pane exists to make, and a decision inside a render function is
 * one nothing can test.
 */
export function computerUseState(input: { status?: ComputerUseStatus; checking: boolean; failed: boolean }): ComputerUseState {
  if (input.failed) return "unknown";
  if (!input.status) return "checking";
  if (!input.status.installed) return "not-installed";
  if (!input.status.hostRunning) return "not-running";
  return input.status.permission === "granted" ? "ready" : "not-granted";
}

const BADGE: Record<Exclude<ComputerUseState, "checking">, { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  ready: { label: "Ready", variant: "secondary" },
  "not-granted": { label: "Not granted", variant: "destructive" },
  "not-running": { label: "Not running", variant: "outline" },
  "not-installed": { label: "Not installed", variant: "outline" },
  unknown: { label: "Unknown", variant: "outline" },
};

/**
 * THE SENTENCE, ONLY WHERE THERE IS SOMETHING TO DO. A working setup says so
 * with its badge; the rest name the grant or the pane that fixes them.
 *
 * `isCua` changes the instruction and nothing else — the two backends are
 * granted in genuinely different places, which is the one fact about the
 * backend split a reader ever has to act on.
 */
export function computerUseHint(state: ComputerUseState, isCua: boolean): string | undefined {
  switch (state) {
    case "ready":
    case "checking":
      return undefined;
    case "unknown":
      return "Could not reach the engine. Retry to check again.";
    case "not-installed":
      return "Install cua-driver (github.com/trycua/cua), or Codex, and Telar picks it up.";
    case "not-running":
      return isCua ? "The driver launches when a session first needs it." : "Wake the host app, or start a session that needs it.";
    case "not-granted":
      return isCua
        ? "cua-driver needs Accessibility + Screen Recording. “Grant access” launches CuaDriver.app so macOS attributes the prompts to it."
        : "System Settings → Privacy & Security → Automation: enable the target under Telar (packaged) or the terminal (dev), then test again.";
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

  const state = computerUseState({ ...(status ? { status } : {}), checking, failed: !status && !checking && error !== undefined });
  const hint = computerUseHint(state, isCua);

  return (
    // NO CAPTION: the row's own sentence is the one that changes with the state,
    // and a standing "Sessions can drive Mac apps — screenshots, clicks, typing"
    // above a row that already says whether they can is the doubling #357 names.
    <SettingsGroup>
      <Row
        label="Computer use"
        icon={MonitorIcon}
        {...(hint ? { hint } : {})}
        // The backend's own words, verbatim, under the instruction rather than
        // instead of it — a failure is exactly when the fix is worth re-reading.
        {...(error ?? status?.message ? { error: error ?? status?.message } : {})}
        control={
          <div className="flex items-center gap-2">
            {state === "checking" ? (
              <Spinner className="size-4" />
            ) : (
              <Badge variant={BADGE[state].variant}>{BADGE[state].label}</Badge>
            )}
            {state === "unknown" && (
              <Button size="sm" variant="outline" onClick={() => void check()}>
                Retry
              </Button>
            )}
            {state === "not-running" && !isCua && (
              <Button size="sm" variant="outline" onClick={() => void wake()}>
                Wake
              </Button>
            )}
            {state === "not-granted" && isCua && (
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void grant()}>
                Grant access
              </Button>
            )}
            {state === "not-granted" && !isCua && (
              <Button size="sm" variant="ghost" onClick={() => window.open(AUTOMATION_PANE)}>
                Open System Settings
              </Button>
            )}
            {status?.installed && (
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
                Test access
              </Button>
            )}
          </div>
        }
      />
    </SettingsGroup>
  );
}
