"use client";

import { useState } from "react";
import { PackageIcon } from "lucide-react";
import type { ProjectPlugins } from "@telar/engine-client";
import { dataScienceMachineSettings } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { machineSettingsPatch } from "../sections";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Row } from "@/features/settings";

const api = createEngineApi();

const parsePackages = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter(Boolean);

export function DataSciencePackagesRow({
  machine,
  onChange,
}: {
  machine?: ProjectPlugins;
  onChange: (machine: ProjectPlugins) => void;
}) {
  const stored = dataScienceMachineSettings(machine);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [packages, setPackages] = useState((stored.packages ?? []).join(", "));

  const save = async (next: string[]) => {
    setBusy(true);
    setError(undefined);
    try {
      const settings: Record<string, unknown> = { ...stored, packages: next };
      if (!next.length) delete settings.packages;
      const answer = await api.updateMachinePlugins(machineSettingsPatch(machine, "data-science", settings));
      onChange(answer.machine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const dirty = JSON.stringify(parsePackages(packages)) !== JSON.stringify(stored.packages ?? []);

  return (
    <Row
      id="plugins-data-science-packages"
      icon={PackageIcon}
      label="Default packages"
      hint="Installed into environments Telar creates from here on. Nothing is installed into an environment that already exists."
      {...(error ? { error } : {})}
      {...(stored.packages?.length ? { onRevert: () => void save([]) } : {})}
      control={
        <div className="flex items-center gap-2">
          <Input
            value={packages}
            onChange={(event) => setPackages(event.target.value)}
            placeholder="pandas, matplotlib, numpy"
            spellCheck={false}
            className="h-8 w-64 text-xs"
            aria-label="Default packages for new environments on this Mac"
          />
          <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void save(parsePackages(packages))}>
            Save
          </Button>
        </div>
      }
    />
  );
}
