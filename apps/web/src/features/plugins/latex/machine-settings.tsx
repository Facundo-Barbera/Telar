"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlertIcon, DownloadIcon, HardDriveIcon } from "lucide-react";
import type { LatexToolchain, ManagedTectonic, PluginLatexEngine, ProjectPlugins } from "@telar/engine-client";
import { latexMachineSettings } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { machineSettingsPatch } from "../sections";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { usePoll } from "@/ui/hooks/use-poll";
import { Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

const INSTALL_POLL_MS = 1500;

export const ENGINE_LABEL: Record<PluginLatexEngine, string> = {
  pdflatex: "pdfLaTeX",
  lualatex: "LuaLaTeX",
  xelatex: "XeLaTeX",
};

type Choice = { kind: "tectonic" | "texlive" | "managed"; path?: string };

const sameChoice = (a: Choice | undefined, b: Choice): boolean =>
  a?.kind === b.kind && (b.kind === "managed" || a?.path === b.path);

export function LatexDistributionSettings({
  machine,
  onChange,
}: {
  machine?: ProjectPlugins;
  onChange: (machine: ProjectPlugins) => void;
}) {
  const [available, setAvailable] = useState<LatexToolchain>();
  const [managed, setManaged] = useState<ManagedTectonic>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const settings = latexMachineSettings(machine);
  const chosen = settings.toolchain;

  const load = useCallback(async () => {
    try {
      const answer = await api.latexToolchain();
      setAvailable(answer.toolchain);
      if (answer.toolchain.managed) setManaged(answer.toolchain.managed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the TeX toolchain.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  usePoll(
    async () => {
      try {
        setManaged((await api.managedTectonic()).managed);
      } catch {
      }
    },
    managed?.installing === true ? INSTALL_POLL_MS : null,
    { immediate: false },
  );

  const install = async () => {
    setError(undefined);
    setManaged((current) => (current ? { ...current, installing: true, error: undefined } : current));
    try {
      const answer = await api.installManagedTectonic();
      setManaged(answer.managed);
      await load();
    } catch (cause) {
      setManaged((current) => (current ? { ...current, installing: false } : current));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const save = async (patch: Partial<ReturnType<typeof latexMachineSettings>>) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = { ...settings, ...patch };
      for (const key of Object.keys(next) as (keyof typeof next)[]) if (next[key] === undefined) delete next[key];
      const answer = await api.updateMachinePlugins(machineSettingsPatch(machine, "latex", next));
      onChange(answer.machine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const found: Choice[] = [
    ...(available?.tectonic ? [{ kind: "tectonic" as const, path: available.tectonic.path }] : []),
    ...(available?.texlive ?? []).map((dist) => ({ kind: "texlive" as const, path: dist.binDir })),
  ];

  const choose = (choice: Choice, selected: boolean) => void save({ toolchain: selected ? undefined : choice });

  return (
    <>
      <SettingsGroup
        title="TeX distribution"
        description="What this Mac compiles with when a project has not chosen its own."
      >
        {managed && (
          <ManagedTectonicRow
            managed={managed}
            selected={sameChoice(chosen, { kind: "managed" })}
            busy={busy}
            onChoose={(selected) => choose({ kind: "managed" }, selected)}
            onInstall={() => void install()}
          />
        )}

        {found.length === 0 && (
          <Row
            icon={HardDriveIcon}
            label="No other TeX install found"
            hint="Telar's own Tectonic above needs nothing installed; TeX Live and a system Tectonic are found here when they are present."
            control={<Badge variant="outline">None</Badge>}
          />
        )}

        {found.map((choice) => {
          const selected = sameChoice(chosen, choice);
          return (
            <Row
              key={`${choice.kind}:${choice.path}`}
              icon={HardDriveIcon}
              label={choice.kind === "tectonic" ? "Tectonic" : "TeX Live"}
              hint={choice.path}
              control={
                <Button variant={selected ? "secondary" : "outline"} size="sm" disabled={busy} onClick={() => choose(choice, selected)}>
                  {selected ? "Default" : "Use"}
                </Button>
              }
            />
          );
        })}

        {error && <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />}
      </SettingsGroup>
    </>
  );
}

function ManagedTectonicRow({
  managed,
  selected,
  busy,
  onChoose,
  onInstall,
}: {
  managed: ManagedTectonic;
  selected: boolean;
  busy: boolean;
  onChoose: (selected: boolean) => void;
  onInstall: () => void;
}) {
  return (
    <Row
      id="plugins-latex-managed"
      icon={DownloadIcon}
      label="Telar (managed)"
      status={
        selected ? <Badge variant="outline">Default</Badge> : undefined
      }
      hint={
        managed.installed
          ? `Tectonic ${managed.version}, downloaded by Telar — a project opened on any Mac compiles with it, with no TeX installed.`
          : `Tectonic ${managed.version}, about 20 MB. Telar keeps it in its own folder, so LaTeX works on a Mac with no TeX on it.`
      }
      {...(managed.supported ? {} : { unavailable: { reason: "Telar has no managed Tectonic for this platform yet." } })}
      {...(managed.error ? { error: managed.error } : {})}
      control={
        managed.installed ? (
          <Button
            variant={selected ? "secondary" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() => onChoose(selected)}
          >
            {selected ? "Default" : "Use"}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={managed.installing || !managed.supported}
            onClick={onInstall}
          >
            {managed.installing ? "Installing…" : "Install"}
          </Button>
        )
      }
    />
  );
}
