"use client";

/**
 * COMPUTER USE — whether sessions can drive Mac apps, in one row.
 *
 * Claude and OpenCode sessions drive Mac apps through a desktop engine Telar
 * owns; Codex ships its own and keeps it, which is what the row's provider
 * badges say (#368). One backend supplies Telar's: cua-driver (trycua/cua,
 * MIT). CuaDriver.app holds the Accessibility + Screen Recording grants, and
 * "Grant access" runs cua's native flow, which launches the app through
 * LaunchServices so the dialogs attribute to it.
 *
 * CODEX'S SKY CLIENT WENT. It was the proprietary fallback, and its service
 * authenticates callers by OpenAI's Team ID on the parent/responsible process,
 * so from Telar it only ever answered "-10000: Sender process is not
 * authenticated". The row read that as "Not granted" and pointed at the
 * Automation pane, which cannot fix it. A client that refuses its caller is
 * "Not accepted" now, and nothing here pretends a switch will change that.
 *
 * The answer is MEASURED — one real read-only call — never remembered, so a
 * stale grant can't lie to the reader. And it is the CLAIM GATE: the engine
 * gives sessions the desktop tools only when the last probe answered granted,
 * so this row is the switch — they get the tools after a check here says Ready.
 *
 * THREE ROWS BECAME ONE (#357). "Engine", "Driver daemon" and "Access" were
 * three readouts of a single question — can a session drive this Mac — and a
 * reader had to combine three badges to answer it. What survives is the ONE
 * state that decides the feature and the ONE sentence that says how to fix it.
 */

import { useCallback, useEffect, useState } from "react";
import { MonitorIcon } from "lucide-react";
import { driverTakesComputerUse, type ComputerUseStatus } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { DRIVER_LABEL, DRIVERS } from "@/lib/provider-instances";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** What the row's state is CALLED. Ordered by what stops the feature first: an
 *  engine that is not installed cannot be ungranted, and one that is not running
 *  cannot be tested. */
export type ComputerUseState =
  | "checking"
  | "unknown"
  | "not-installed"
  | "not-running"
  | "not-granted"
  | "not-accepted"
  | "ready";

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
  if (input.status.permission === "granted") return "ready";
  // The client refused Telar as a caller — no grant in System Settings fixes that.
  if (input.status.permission === "unauthenticated") return "not-accepted";
  return "not-granted";
}

const BADGE: Record<Exclude<ComputerUseState, "checking">, { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  ready: { label: "Ready", variant: "secondary" },
  "not-granted": { label: "Not granted", variant: "destructive" },
  "not-accepted": { label: "Not accepted", variant: "destructive" },
  "not-running": { label: "Not running", variant: "outline" },
  "not-installed": { label: "Not installed", variant: "outline" },
  unknown: { label: "Unknown", variant: "outline" },
};

/**
 * THE SENTENCE, ONLY WHERE THERE IS SOMETHING TO DO. A working setup says so
 * with its badge; the rest name the grant that fixes them, or say plainly that
 * nothing on this Mac will.
 */
export function computerUseHint(state: ComputerUseState): string | undefined {
  switch (state) {
    case "ready":
    case "checking":
      return undefined;
    case "unknown":
      return "Could not reach the engine. Retry to check again.";
    case "not-installed":
      return "Install cua-driver (github.com/trycua/cua) and Telar picks it up.";
    case "not-running":
      return "The driver launches when a session first needs it.";
    case "not-granted":
      return "cua-driver needs Accessibility + Screen Recording. “Grant access” launches CuaDriver.app so macOS attributes the prompts to it.";
    case "not-accepted":
      return "The installed computer-use client does not accept Telar as a caller, so sessions are not given its tools.";
  }
}

/**
 * WHOSE SESSIONS THIS GRANT IS FOR — the row's missing half (#368).
 *
 * The pane measured a macOS permission and never said which providers it was a
 * permission FOR, which every reader took as "all of them". Since #521 that
 * reading is correct — every provider Telar drives gets Telar's desktop — but
 * the row still names them, because "all of them" has been the wrong answer
 * once and a reader cannot tell a promise from an assumption.
 *
 * BOTH HALVES STAY even though one is empty today: a provider that arrives
 * with a desktop of its own is a thing that can exist again, and the row that
 * silently stopped distinguishing is how #368 happened.
 *
 * BADGES, NOT A SENTENCE, and not a second hint: the answer is a LIST, the
 * hint slot is the one that changes with the state, and a standing paragraph
 * above a row is the doubling #357 already cut once.
 *
 * READ FROM THE ENGINE'S OWN LIST (`driverTakesComputerUse`), which is what the
 * claim fold uses — so this row can neither promise a provider the engine
 * withholds it from nor stay silent about one it supplies. Both directions of
 * that drift have now been shipped.
 */
export function ComputerUseProviders() {
  const supplied = DRIVERS.filter(driverTakesComputerUse);
  const theirOwn = DRIVERS.filter((driver) => !driverTakesComputerUse(driver));
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {supplied.map((driver) => (
        <Badge key={driver} variant="secondary" className="font-normal">
          {DRIVER_LABEL[driver]}
        </Badge>
      ))}
      {theirOwn.map((driver) => (
        <span key={driver}>{DRIVER_LABEL[driver]} uses its own</span>
      ))}
    </p>
  );
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

  const grant = async () => {
    try {
      await api.grantComputerUseAccess();
      // The grant dialogs take a moment; re-measure after they've had one.
      window.setTimeout(() => void check(), 2_500);
    } catch {
      setError("The engine did not answer.");
    }
  };

  const state = computerUseState({ ...(status ? { status } : {}), checking, failed: !status && !checking && error !== undefined });
  const hint = computerUseHint(state);

  return (
    // NO CAPTION: the row's own sentence is the one that changes with the state,
    // and a standing "Sessions can drive Mac apps — screenshots, clicks, typing"
    // above a row that already says whether they can is the doubling #357 names.
    <SettingsGroup>
      <Row
        label="Computer use"
        icon={MonitorIcon}
        info="Sessions get the desktop tools only after a check here answers Ready."
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
            {state === "not-granted" && (
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void grant()}>
                Grant access
              </Button>
            )}
            {status?.installed && (
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
                Test access
              </Button>
            )}
          </div>
        }
      >
        <ComputerUseProviders />
      </Row>
    </SettingsGroup>
  );
}
