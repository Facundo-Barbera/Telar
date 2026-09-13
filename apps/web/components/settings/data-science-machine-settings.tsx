"use client";

/**
 * WHAT DATA SCIENCE DOES ON THIS MAC when a project has not said otherwise.
 *
 * TWO DEFAULTS, AND THEY ARE NOT THE SAME KIND OF THING.
 *
 *   The DEFAULT PYTHON is a fallback that RUNS: a project with the plugin on
 *   but no interpreter chosen gets a kernel on this one instead of no kernel at
 *   all. `resolveDataScience` walks that chain, so the row changes behaviour
 *   rather than storing a preference.
 *
 *   The DEFAULT PACKAGES are a list a NEW environment is built with. They do
 *   not reach into an environment somebody already has — nothing here installs
 *   anything on save, and a row that did would be a settings page that spends
 *   four minutes and 800 MB because you typed in a text box.
 *
 * THE PYTHON IS ABSOLUTE, unlike a project's. A project may store
 * `.venv/bin/python` so a worktree session resolves ITS tree's interpreter; a
 * Mac-wide default has no checkout to be relative to, and the engine's schema
 * says so. The row's hint says it in the language of the person typing.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleAlertIcon, FlaskConicalIcon, PackageIcon } from "lucide-react";
import type { DataScienceToolchain, ProjectPlugins } from "@telar/engine-client";
import { dataScienceMachineSettings } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** A packages list is typed as text and stored as a list. One place converts. */
const parsePackages = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter(Boolean);

export function DataScienceMachineSettings({
  machine,
  onChange,
}: {
  machine?: ProjectPlugins;
  onChange: (machine: ProjectPlugins) => void;
}) {
  const stored = dataScienceMachineSettings(machine);
  const [toolchain, setToolchain] = useState<DataScienceToolchain>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  /**
   * DRAFTS, because these two rows are TYPED rather than picked. Every other
   * row on this page saves on the change event; a text field that did would
   * write once per keystroke and fight the caret. The draft holds what is in
   * the box, the stored value is what the engine has, and Save is what moves
   * one to the other.
   */
  const [python, setPython] = useState(stored.python ?? "");
  const [packages, setPackages] = useState((stored.packages ?? []).join(", "));

  const load = useCallback(async () => {
    try {
      setToolchain((await api.dataScienceToolchain()).toolchain);
    } catch {
      // The interpreter suggestions are a convenience; the fields still work
      // without them, so a failed probe is not worth an error banner.
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const save = async (patch: { python?: string; packages?: string[] }) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = { ...stored, ...patch };
      // An empty field means "no default"; the blob is replaced whole, so the
      // key must actually go rather than be stored as an empty string.
      if (!next.python) delete next.python;
      if (!next.packages?.length) delete next.packages;
      // `enabled: true` rather than omitted: writing a setting for a plugin the
      // Mac has turned off would silently turn it back on.
      const answer = await api.updateMachinePlugins({ "data-science": { enabled: true, settings: next } });
      onChange(answer.machine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const pythonDirty = python.trim() !== (stored.python ?? "");
  // Compared as JSON rather than a joined string: a separator that could appear
  // inside a package name would call two different lists equal.
  const packagesDirty = JSON.stringify(parsePackages(packages)) !== JSON.stringify(stored.packages ?? []);

  /** The interpreters uv can already see — a hint about what to type, not a picker. */
  const suggestion = toolchain?.pythons.find((entry) => entry.installed && entry.path)?.path;

  return (
    <SettingsGroup
      title="Data science defaults"
      description="What a project on this Mac inherits when it has not chosen for itself."
    >
      <Row
        id="plugins-data-science-python"
        icon={FlaskConicalIcon}
        label="Default Python"
        hint={
          stored.python
            ? "A project with no interpreter of its own runs its kernel on this one."
            : `An absolute path to an interpreter — a Mac-wide default cannot be relative to a checkout.${suggestion ? ` This Mac has one at ${suggestion}.` : ""}`
        }
        {...(stored.python ? { onRevert: () => void save({ python: "" }) } : {})}
        control={
          <div className="flex items-center gap-2">
            <Input
              value={python}
              onChange={(event) => setPython(event.target.value)}
              placeholder={suggestion ?? "/usr/local/bin/python3"}
              spellCheck={false}
              className="h-8 w-64 font-mono text-xs"
              aria-label="Default Python interpreter for this Mac"
            />
            <Button size="sm" variant="outline" disabled={busy || !pythonDirty} onClick={() => void save({ python: python.trim() })}>
              Save
            </Button>
          </div>
        }
      />

      <Row
        id="plugins-data-science-packages"
        icon={PackageIcon}
        label="Default packages"
        hint="Installed into environments Telar creates from here on. Nothing is installed into an environment that already exists."
        {...(stored.packages?.length ? { onRevert: () => void save({ packages: [] }) } : {})}
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
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !packagesDirty}
              onClick={() => void save({ packages: parsePackages(packages) })}
            >
              Save
            </Button>
          </div>
        }
      />

      {error && <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />}
    </SettingsGroup>
  );
}
