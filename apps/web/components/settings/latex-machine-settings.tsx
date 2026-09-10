"use client";

/**
 * WHICH TeX INSTALL THIS MAC COMPILES WITH.
 *
 * A genuinely machine-level fact, and the one LaTeX's manifest has declared as
 * `scope: "machine"` since the plugin host landed — it simply had nowhere to be
 * rendered until this page existed.
 *
 * IT IS A DEFAULT, NOT AN OVERRIDE. A project that has chosen its own
 * distribution keeps it; a project that has not now compiles with this one
 * rather than refusing for want of a path. `resolveLatex` does that fallback, so
 * the setting changes what actually runs instead of persisting an inert field.
 *
 * The choices are the SAME probe the project pane uses (`/api/latex/toolchain`),
 * so the two panes cannot disagree about what is installed.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleAlertIcon, HardDriveIcon } from "lucide-react";
import type { LatexToolchain, ProjectPlugins } from "@telar/engine-client";
import { machineSettings } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

type Choice = { kind: "tectonic" | "texlive"; path: string };

export function LatexMachineSettings({
  machine,
  onChange,
}: {
  machine?: ProjectPlugins;
  onChange: (machine: ProjectPlugins) => void;
}) {
  const [available, setAvailable] = useState<LatexToolchain>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const chosen = (machineSettings(machine, "latex") as { toolchain?: Choice }).toolchain;

  const load = useCallback(async () => {
    try {
      setAvailable((await api.latexToolchain()).toolchain);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the TeX toolchain.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const choices: Choice[] = [
    ...(available?.tectonic ? [{ kind: "tectonic" as const, path: available.tectonic.path }] : []),
    ...(available?.texlive ?? []).map((dist) => ({ kind: "texlive" as const, path: dist.binDir })),
  ];

  const choose = async (toolchain: Choice | undefined) => {
    setBusy(true);
    setError(undefined);
    try {
      // `enabled: true` rather than omitted: writing a setting for a plugin the
      // Mac has turned off would silently turn it back on.
      const answer = await api.updateMachinePlugins({
        latex: { enabled: true, ...(toolchain ? { settings: { toolchain } } : { settings: {} }) },
      });
      onChange(answer.machine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title="TeX distribution"
      description="What this Mac compiles with when a project has not chosen its own."
    >
      {choices.length === 0 && (
        <Row
          icon={HardDriveIcon}
          label="No TeX install found"
          hint="Install TeX Live or Tectonic and reopen this pane."
          control={<Badge variant="outline">None</Badge>}
        />
      )}

      {choices.map((choice) => {
        const selected = chosen?.path === choice.path && chosen?.kind === choice.kind;
        return (
          <Row
            key={`${choice.kind}:${choice.path}`}
            icon={HardDriveIcon}
            label={choice.kind === "tectonic" ? "Tectonic" : "TeX Live"}
            hint={choice.path}
            control={
              <Button
                variant={selected ? "secondary" : "outline"}
                size="sm"
                disabled={busy}
                onClick={() => void choose(selected ? undefined : choice)}
              >
                {selected ? "Default" : "Use"}
              </Button>
            }
          />
        );
      })}

      {error && <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />}
    </SettingsGroup>
  );
}
