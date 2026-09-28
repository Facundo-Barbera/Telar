"use client";

/**
 * THE DEFAULT PACKAGES — the one Data Science default that is a bespoke block.
 *
 * A list a NEW environment is built with. It does not reach into an
 * environment somebody already has — nothing here installs anything on save,
 * and a row that did would be a settings page that spends four minutes and
 * 800 MB because you typed in a text box.
 *
 * The DEFAULT PYTHON beside it is a plain path field of Data Science's schema,
 * so it is generated ("Data science defaults", see
 * components/plugins/generated-settings.tsx). This row is typed as text and
 * stored as a list, which the generated renderer does not draw.
 */

import { useState } from "react";
import { PackageIcon } from "lucide-react";
import type { ProjectPlugins } from "@telar/engine-client";
import { dataScienceMachineSettings } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { machineSettingsPatch } from "@/lib/plugins/sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row } from "./settings-shell";

const api = createEngineApi();

/** A packages list is typed as text and stored as a list. One place converts. */
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
  /** A DRAFT, because the row is TYPED: Save is what moves it to the engine. */
  const [packages, setPackages] = useState((stored.packages ?? []).join(", "));

  const save = async (next: string[]) => {
    setBusy(true);
    setError(undefined);
    try {
      // The blob is replaced whole, so the rest of it rides along; an empty
      // list means "no default" and the key goes.
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

  // Compared as JSON rather than a joined string: a separator that could appear
  // inside a package name would call two different lists equal.
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
