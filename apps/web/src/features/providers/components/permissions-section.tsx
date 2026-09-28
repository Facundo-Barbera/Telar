"use client";

import { useCallback, useEffect, useState } from "react";
import { MonitorIcon } from "lucide-react";
import { driverTakesComputerUse, type ComputerUseGrant, type ComputerUseStatus } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine/index";
import { DRIVER_LABEL, DRIVERS } from "../provider-instances";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "@/features/settings";

// The bundled computer-use helper is cua-driver (trycua/cua, MIT).

const api = createEngineApi();

export type ComputerUseState =
  | "checking"
  | "unknown"
  | "not-installed"
  | "not-running"
  | "not-granted"
  | "not-accepted"
  | "ready";

export function computerUseState(input: { status?: ComputerUseStatus; checking: boolean; failed: boolean }): ComputerUseState {
  if (input.failed) return "unknown";
  if (!input.status) return "checking";
  if (!input.status.installed) return "not-installed";
  if (!input.status.hostRunning) return "not-running";
  if (input.status.permission === "granted") return "ready";
  if (input.status.permission === "unauthenticated") return "not-accepted";
  return "not-granted";
}

const GATE_INFO = "Sessions get the desktop tools only after a check here answers Ready.";
const FINDER_INFO = "If “Computer Use for Telar” is not in a System Settings list, Show in Finder and drag it in.";
const REMOVE_INFO =
  "Remove permissions clears only Telar's bundled helper, not a separately installed cua. Grant access again to use computer use.";

const BADGE: Record<Exclude<ComputerUseState, "checking">, { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  ready: { label: "Ready", variant: "secondary" },
  "not-granted": { label: "Not granted", variant: "destructive" },
  "not-accepted": { label: "Not accepted", variant: "destructive" },
  "not-running": { label: "Not running", variant: "outline" },
  "not-installed": { label: "Not installed", variant: "outline" },
  unknown: { label: "Unknown", variant: "outline" },
};

export function computerUseHint(state: ComputerUseState, { bundled = false }: { bundled?: boolean } = {}): string | undefined {
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
      if (bundled) return "Computer use needs Accessibility + Screen Recording, turned on for “Computer Use for Telar” in System Settings.";
      return "cua-driver needs Accessibility + Screen Recording. “Grant access” launches CuaDriver.app so macOS attributes the prompts to it.";
    case "not-accepted":
      return "The installed computer-use client does not accept Telar as a caller, so sessions are not given its tools.";
  }
}

export function grantFollowUp(opened: ComputerUseGrant["opened"], status: ComputerUseStatus | undefined): "done" | "next-pane" | "wait" {
  if (status?.permission === "granted") return "done";
  if (opened === "accessibility" && status?.missing?.length === 1 && status.missing[0] === "screen-recording") return "next-pane";
  return "wait";
}

export const GRANT_POLL_MS = 3_000;
export const GRANT_WAIT_MS = 10 * 60_000;

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

  useEffect(() => {
    const task = window.setTimeout(() => void check(), 0);
    return () => window.clearTimeout(task);
  }, [check]);

  const poll = useCallback(async () => {
    try {
      const next = (await api.computerUseStatus()).computerUse;
      setStatus(next);
      return next;
    } catch {
      return undefined;
    }
  }, []);

  const [waiting, setWaiting] = useState<ComputerUseGrant["opened"] | "none">();
  const [granting, setGranting] = useState(false);

  const grant = async () => {
    setGranting(true);
    setError(undefined);
    try {
      const answer = await api.grantComputerUseAccess();
      if (answer.message) setError(answer.message);
      if (!answer.started) return;
      setWaiting(answer.opened ?? "none");
    } catch {
      setError("The engine did not answer.");
    } finally {
      setGranting(false);
    }
  };

  useEffect(() => {
    if (waiting === undefined) return;
    let asked = false;
    const tick = async () => {
      const step = grantFollowUp(waiting === "none" ? undefined : waiting, await poll());
      if (step === "done") setWaiting(undefined);
      if (step === "next-pane" && !asked) {
        asked = true;
        const answer = await api.grantComputerUseAccess().catch(() => undefined);
        if (answer?.message) setError(answer.message);
        if (answer?.opened) setWaiting(answer.opened);
      }
    };
    const timer = window.setInterval(() => void tick(), GRANT_POLL_MS);
    const stop = window.setTimeout(() => setWaiting(undefined), GRANT_WAIT_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
      window.removeEventListener("focus", tick);
    };
  }, [waiting, poll]);

  const reveal = async () => {
    try {
      if (!(await api.revealComputerUseHelper()).revealed) setError("Finder did not open.");
    } catch {
      setError("The engine did not answer.");
    }
  };

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const remove = async () => {
    setConfirmingRemove(false);
    try {
      const answer = await api.resetComputerUseAccess();
      await check();
      if (!answer.reset && answer.message) setError(answer.message);
    } catch {
      setError("The engine did not answer.");
    }
  };

  const bundled = status?.bundled === true;
  const state = computerUseState({ ...(status ? { status } : {}), checking, failed: !status && !checking && error !== undefined });
  const hint = computerUseHint(state, { bundled });

  return (
    <SettingsGroup>
      <Row
        label="Computer use"
        icon={MonitorIcon}
        info={bundled ? `${GATE_INFO} ${FINDER_INFO} ${REMOVE_INFO}` : GATE_INFO}
        {...(hint ? { hint } : {})}
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
              <Button size="sm" variant="outline" disabled={checking || granting} onClick={() => void grant()}>
                {granting && <Spinner className="size-3" />}
                Grant access
              </Button>
            )}
            {bundled && state === "not-granted" && (
              <Button size="sm" variant="ghost" onClick={() => void reveal()}>
                Show in Finder
              </Button>
            )}
            {status?.installed && (
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
                Test access
              </Button>
            )}
            {bundled &&
              state !== "checking" &&
              (confirmingRemove ? (
                <>
                  <Button size="sm" variant="destructive" disabled={checking} onClick={() => void remove()}>
                    Confirm remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" disabled={checking} onClick={() => setConfirmingRemove(true)}>
                  Remove permissions
                </Button>
              ))}
          </div>
        }
      >
        <ComputerUseProviders />
      </Row>
    </SettingsGroup>
  );
}
