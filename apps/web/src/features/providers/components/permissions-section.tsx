"use client";

import { useState } from "react";
import { MonitorIcon } from "lucide-react";
import { driverTakesComputerUse, type ComputerUseStatus } from "@telar/engine-client";
import { useComputerUse } from "../hooks/use-computer-use";
import { DRIVER_LABEL, DRIVERS } from "../provider-instances";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { Row, SettingsGroup } from "@/features/settings";

// The bundled computer-use helper is cua-driver (trycua/cua, MIT).

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
  const { status, checking, granting, error, check, grant, reveal, remove } = useComputerUse();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

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
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={checking}
                    onClick={() => {
                      setConfirmingRemove(false);
                      void remove();
                    }}
                  >
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
