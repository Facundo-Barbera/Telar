"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlertIcon, DownloadIcon, HardDriveIcon } from "lucide-react";
import type { LatexToolchain, ManagedTectonic, PluginLatexEngine, ProjectPlugins } from "@telar/engine-client";
import { latexMachineSettings } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine/index";
import { machineSettingsPatch } from "../sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

  const installing = managed?.installing === true;
  const pollRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!installing) return;
    const tick = async () => {
      try {
        setManaged((await api.managedTectonic()).managed);
      } catch {
      }
    };
    pollRef.current = window.setInterval(() => void tick(), INSTALL_POLL_MS);
    return () => window.clearInterval(pollRef.current);
  }, [installing]);

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
          <Row
            id="plugins-latex-managed"
            icon={DownloadIcon}
            label="Telar (managed)"
            status={
              sameChoice(chosen, { kind: "managed" }) ? <Badge variant="outline">Default</Badge> : undefined
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
                  variant={sameChoice(chosen, { kind: "managed" }) ? "secondary" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() => choose({ kind: "managed" }, sameChoice(chosen, { kind: "managed" }))}
                >
                  {sameChoice(chosen, { kind: "managed" }) ? "Default" : "Use"}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={managed.installing || !managed.supported}
                  onClick={() => void install()}
                >
                  {managed.installing ? "Installing…" : "Install"}
                </Button>
              )
            }
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
