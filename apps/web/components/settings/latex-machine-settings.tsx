"use client";

/**
 * WHAT LATEX DOES ON THIS MAC when a project has not said otherwise.
 *
 * EVERY ROW IS A DEFAULT, NOT AN OVERRIDE. A project that chose its own
 * distribution keeps it; a project that has not now compiles with this one
 * rather than refusing for want of a path. `resolveLatex` walks exactly that
 * chain — project, then this, then the managed copy — so each row changes what
 * actually runs instead of persisting an inert field.
 *
 * ── "TELAR (MANAGED)" IS THE ROW THAT MATTERS ───────────────────────────────
 * It is first, and it is first because it is the only distribution that can be
 * TRUE ON A MACHINE NOBODY HAS SET UP. The others are found: MacTeX if somebody
 * ran the installer, Homebrew's tectonic if somebody brewed it. This one Telar
 * downloads itself, into its own state directory, so a thesis opened on a
 * borrowed Mac compiles. That is the whole point of the row and the reason the
 * Install button is not hidden behind an "advanced" disclosure.
 *
 * It is also the only row with a VERB rather than a choice, until it is here:
 * offering "Use" for a binary that has not been downloaded would store a
 * default that silently resolves to nothing.
 *
 * The other choices come from the SAME probe the project pane uses
 * (`/api/latex/toolchain`), so the two panes cannot disagree about what is
 * installed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlertIcon, DownloadIcon, HardDriveIcon, PackagePlusIcon, SettingsIcon } from "lucide-react";
import type { LatexToolchain, ManagedTectonic, PluginLatexEngine, ProjectPlugins } from "@telar/engine-client";
import { latexMachineSettings } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, SettingsGroup, ToggleRow } from "./settings-shell";

const api = createEngineApi();

/** How often the pane re-asks while a download is running. */
const INSTALL_POLL_MS = 1500;

/** base-ui refuses `""`, so "nothing pinned" needs a sentinel of its own. */
const ENGINE_DEFAULT = "__engine-default";

const ENGINE_LABEL: Record<PluginLatexEngine, string> = {
  pdflatex: "pdfLaTeX",
  lualatex: "LuaLaTeX",
  xelatex: "XeLaTeX",
};

type Choice = { kind: "tectonic" | "texlive" | "managed"; path?: string };

const sameChoice = (a: Choice | undefined, b: Choice): boolean =>
  a?.kind === b.kind && (b.kind === "managed" || a?.path === b.path);

export function LatexMachineSettings({
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
      // An engine that predates the managed install says nothing here, and the
      // row simply does not render rather than showing a broken button.
      if (answer.toolchain.managed) setManaged(answer.toolchain.managed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the TeX toolchain.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  /**
   * WHILE A DOWNLOAD RUNS, ASK AGAIN. The install is a 20 MB fetch, so the POST
   * that starts it cannot be the thing that reports it finished — a pane that
   * only rendered the POST's answer would sit on "Installing…" forever.
   *
   * The timer is keyed on `installing` and cleared by the effect's own cleanup,
   * so a pane closed mid-download leaves nothing behind.
   */
  const installing = managed?.installing === true;
  const pollRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!installing) return;
    const tick = async () => {
      try {
        setManaged((await api.managedTectonic()).managed);
      } catch {
        // A blip mid-download is not worth replacing the pane with an error;
        // the next tick, or the next open, answers.
      }
    };
    pollRef.current = window.setInterval(() => void tick(), INSTALL_POLL_MS);
    return () => window.clearInterval(pollRef.current);
  }, [installing]);

  const install = async () => {
    setError(undefined);
    // Optimistic only in the one field the engine is about to confirm: the
    // button has to stop being pressable before the POST resolves, because the
    // POST resolves when the DOWNLOAD does.
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

  /** One write of the whole blob — the engine validates it against LaTeX's own schema. */
  const save = async (patch: Partial<ReturnType<typeof latexMachineSettings>>) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = { ...settings, ...patch };
      // An undefined field means "no default", and the blob is replaced whole,
      // so the key has to actually go rather than be written as undefined.
      for (const key of Object.keys(next) as (keyof typeof next)[]) if (next[key] === undefined) delete next[key];
      // `enabled: true` rather than omitted: writing a setting for a plugin the
      // Mac has turned off would silently turn it back on.
      const answer = await api.updateMachinePlugins({ latex: { enabled: true, settings: next } });
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
        {/* FIRST, ALWAYS — see the file header. Absent only on an engine that
            predates it, where there is nothing to offer and no button to show. */}
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
      </SettingsGroup>

      <SettingsGroup title="Compiling" description="How a compile runs here, unless the project says otherwise.">
        {/* THE ENGINE IS A TEX LIVE FACT AND SAYS SO. Tectonic is XeTeX inside
            and takes no engine flag, so a row that silently did nothing on the
            default distribution would be worse than one that explains itself. */}
        <Row
          icon={SettingsIcon}
          label="Default engine"
          hint="What latexmk drives on a TeX Live install. Tectonic is XeTeX inside and ignores it."
          {...(settings.engine ? { onRevert: () => void save({ engine: undefined }) } : {})}
          control={
            <Select
              value={settings.engine ?? ENGINE_DEFAULT}
              onValueChange={(next: unknown) => {
                if (typeof next !== "string") return;
                void save({ engine: next === ENGINE_DEFAULT ? undefined : (next as PluginLatexEngine) });
              }}
              disabled={busy}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue>{settings.engine ? ENGINE_LABEL[settings.engine] : "pdfLaTeX"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ENGINE_DEFAULT}>pdfLaTeX</SelectItem>
                <SelectItem value="lualatex">{ENGINE_LABEL.lualatex}</SelectItem>
                <SelectItem value="xelatex">{ENGINE_LABEL.xelatex}</SelectItem>
              </SelectContent>
            </Select>
          }
        />

        <ToggleRow
          icon={PackagePlusIcon}
          label="Install missing packages automatically"
          hint="When a TeX Live compile fails on a package it does not have, install it with tlmgr and compile once more. Tectonic already fetches packages by itself."
          checked={settings.autoInstallPackages === true}
          onCheckedChange={(next: boolean) => void save({ autoInstallPackages: next ? true : undefined })}
        />

        {error && <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />}
      </SettingsGroup>
    </>
  );
}
