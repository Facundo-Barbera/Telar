"use client";

// A secret is never sent back to the cockpit: an untouched environment is left out of the patch, and a changed one
// that would drop a kept secret is refused with the names to re-enter.

import { useState } from "react";
import { EyeOffIcon, PlusIcon, XIcon } from "lucide-react";
import { draftProblems } from "../run/presentation";
import type { DraftProblem } from "../run/presentation";
import { DEFAULT_RUN_ICON, RUN_ICON_KEYS, RUN_ICON_LABELS, RunGlyph, runIconKey } from "../run/icons";
import type { RunConfigurationDraft, RunConfigurationView, RunIcon } from "../run/types";
import { cn } from "@/lib/utils";

/** A row as the form holds it: `kept` marks a secret whose stored value the
 *  cockpit has never seen and must not overwrite. */
export type EnvRow = { key: string; value: string; secret?: boolean; kept?: boolean };

export type EditorDraft = { name: string; icon: RunIcon; command: string; cwd: string; readinessUrl: string; env: EnvRow[] };

export function emptyDraft(): EditorDraft {
  return { name: "", icon: DEFAULT_RUN_ICON, command: "", cwd: "", readinessUrl: "", env: [] };
}

export function draftFromConfiguration(config: RunConfigurationView): EditorDraft {
  return {
    name: config.name,
    // An absent icon opens the picker on the default rather than on nothing;
    // saving it back stores nothing, which is what `toDraft` keeps true.
    icon: runIconKey(config.icon),
    command: config.command,
    cwd: config.cwd ?? "",
    readinessUrl: config.readinessUrl ?? "",
    env: (config.env ?? []).map((entry) =>
      entry.secret ? { key: entry.key, value: "", secret: true, kept: true } : { key: entry.key, value: entry.value ?? "" },
    ),
  };
}

/** Trimmed, with the empty optionals dropped so a blank box does not become a
 *  stored empty string. */
export function toDraft(draft: EditorDraft): RunConfigurationDraft {
  return {
    name: draft.name.trim(),
    // Always sent, the default included: the engine merges shallowly, so omitting it could never switch back to `play`.
    icon: draft.icon,
    command: draft.command.trim(),
    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
    ...(draft.readinessUrl.trim() ? { readinessUrl: draft.readinessUrl.trim() } : {}),
    ...(draft.env.length
      ? { env: draft.env.map((row) => ({ key: row.key.trim(), value: row.value, ...(row.secret ? { secret: true } : {}) })) }
      : {}),
  };
}

/** True when the environment differs from what the configuration already has,
 *  and therefore has to be sent as a whole list. */
export function environmentTouched(original: RunConfigurationView | undefined, draft: EditorDraft): boolean {
  const before = original?.env ?? [];
  if (before.length !== draft.env.length) return true;
  return draft.env.some((row, index) => {
    const was = before[index]!;
    if (was.key !== row.key.trim() || Boolean(was.secret) !== Boolean(row.secret)) return true;
    return row.secret ? !row.kept : (was.value ?? "") !== row.value;
  });
}

/** The names that must be re-typed before an environment change can be saved,
 *  or `undefined` when nothing is in the way. */
export function environmentBlocker(original: RunConfigurationView | undefined, draft: EditorDraft): string | undefined {
  if (!environmentTouched(original, draft)) return undefined;
  const kept = draft.env.filter((row) => row.secret && row.kept).map((row) => row.key.trim());
  if (!kept.length) return undefined;
  return `Re-enter ${kept.join(", ")} to change this environment. Telar never sends a secret back to the cockpit, so saving the list without it would erase it.`;
}

/** Everything wrong with the form right now, in the order a human reads it. */
export function editorProblems(original: RunConfigurationView | undefined, draft: EditorDraft): DraftProblem[] {
  const blocker = environmentBlocker(original, draft);
  const problems = draftProblems(toDraft(draft)).filter(
    // A kept secret has no value to validate; the blocker above is the real
    // answer, and a length complaint on top of it would be noise.
    (problem) => !(problem.field === "env" && draft.env.some((row) => row.kept)),
  );
  return blocker ? [...problems, { field: "env", message: blocker }] : problems;
}

/** Which fields a human has finished with: blurred, or swept in by a submit. */
export type TouchedFields = Partial<Record<DraftProblem["field"], true>>;

/** A problem is shown once its field was left, or after Save; `editorProblems` still decides what may be saved. */
export function visibleProblems(problems: DraftProblem[], touched: TouchedFields, submitted: boolean): DraftProblem[] {
  return submitted ? problems : problems.filter((problem) => touched[problem.field]);
}

// Leaving a field for Cancel does not mark it touched: the complaint appearing above Cancel moved it from under the pointer.
export const CANCEL_MARK = "data-editor-cancel";

export function blurMarksTouched(next: EventTarget | null): boolean {
  // Duck-typed rather than `instanceof Element`, which is not a global where
  // this module is also imported (the server render and the unit tests).
  const element = next as { closest?: (selector: string) => unknown } | null;
  return !element?.closest?.(`[${CANCEL_MARK}]`);
}

/** What to PATCH: `env` only when it changed, so an untouched secret survives
 *  the engine's shallow merge untouched. */
export function configurationPatch(original: RunConfigurationView | undefined, draft: EditorDraft): Partial<RunConfigurationDraft> {
  const full = toDraft(draft);
  if (environmentTouched(original, draft)) return full;
  const rest = { ...full };
  delete rest.env;
  return rest;
}

const INPUT = "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm focus-visible:outline focus-visible:outline-ring";

function Field({
  label,
  value,
  placeholder,
  title,
  mono,
  onChange,
  onLeave,
}: {
  label: string;
  value: string;
  placeholder: string;
  title?: string;
  mono?: boolean;
  onChange: (value: string) => void;
  onLeave: (next: EventTarget | null) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        className={cn(INPUT, mono && "font-mono")}
        value={value}
        placeholder={placeholder}
        {...(title ? { title } : {})}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onLeave(event.relatedTarget)}
      />
    </label>
  );
}

function IconPicker({ value, onChange }: { value: RunIcon; onChange: (icon: RunIcon) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-muted-foreground">Icon</legend>
      <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
        {RUN_ICON_KEYS.map((key) => {
          const chosen = value === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={chosen}
              aria-label={RUN_ICON_LABELS[key]}
              title={RUN_ICON_LABELS[key]}
              onClick={() => onChange(key)}
              className={cn(
                "rounded-md border p-1.5 transition-colors focus-visible:outline focus-visible:outline-ring",
                chosen ? "border-ring bg-accent" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              <RunGlyph icon={key} className="size-4" />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function EnvironmentSection({
  rows,
  setRows,
  onLeave,
}: {
  rows: EnvRow[];
  setRows: (update: (rows: EnvRow[]) => EnvRow[]) => void;
  onLeave: (next: EventTarget | null) => void;
}) {
  const setRow = (index: number, patch: Partial<EnvRow>) => setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  return (
    <section className="space-y-2" aria-label="Environment variables">
      <h3 className="text-xs font-medium text-muted-foreground">Environment</h3>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            aria-label="Variable name"
            className="w-40 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-sm focus-visible:outline focus-visible:outline-ring"
            value={row.key}
            onChange={(event) => setRow(index, { key: event.target.value })}
            onBlur={(event) => onLeave(event.relatedTarget)}
          />
          {row.kept ? (
            <button
              type="button"
              className="flex flex-1 items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted"
              onClick={() => setRow(index, { kept: false, value: "" })}
            >
              <EyeOffIcon className="size-3.5" /> Hidden — click to replace
            </button>
          ) : (
            <input
              aria-label="Value"
              type={row.secret ? "password" : "text"}
              className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-sm focus-visible:outline focus-visible:outline-ring"
              value={row.value}
              onChange={(event) => setRow(index, { value: event.target.value })}
              onBlur={(event) => onLeave(event.relatedTarget)}
            />
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={Boolean(row.secret)} onChange={(event) => setRow(index, { secret: event.target.checked, kept: false })} />
            Secret
          </label>
          <button
            type="button"
            aria-label={`Remove ${row.key || "variable"}`}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            onClick={() => setRows((current) => current.filter((_, position) => position !== index))}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        onClick={() => setRows((current) => [...current, { key: "", value: "" }])}
      >
        <PlusIcon className="size-3.5" /> Add variable
      </button>
    </section>
  );
}

type Props = {
  /** Absent when this is a new configuration. */
  config?: RunConfigurationView;
  busy?: boolean;
  error?: string;
  onSave: (patch: Partial<RunConfigurationDraft>) => void;
  onCancel: () => void;
};

export function RunConfigEditor({ config, busy, error, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<EditorDraft>(() => (config ? draftFromConfiguration(config) : emptyDraft()));
  /** Blurred fields, and whether Save has been pressed — see `visibleProblems`
   *  for why a blank form does not start out shouting. */
  const [touched, setTouched] = useState<TouchedFields>({});
  const [submitted, setSubmitted] = useState(false);
  const problems = editorProblems(config, draft);
  const shown = visibleProblems(problems, touched, submitted);
  const touch = (field: DraftProblem["field"]) => setTouched((current) => ({ ...current, [field]: true }));
  /** A blur counts as finishing the field unless focus is going to Cancel —
   *  see `blurMarksTouched`. */
  const leave = (field: DraftProblem["field"], next: EventTarget | null) => {
    if (blurMarksTouched(next)) touch(field);
  };
  const set = (patch: Partial<EditorDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setRows = (update: (rows: EnvRow[]) => EnvRow[]) => setDraft((current) => ({ ...current, env: update(current.env) }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        // Save is always pressable: pressing it is how a person asks to see every problem.
        setSubmitted(true);
        if (!problems.length && !busy) onSave(configurationPatch(config, draft));
      }}
    >
      <Field label="Name" value={draft.name} placeholder="Dev server" onChange={(name) => set({ name })} onLeave={(next) => leave("name", next)} />
      <IconPicker value={draft.icon} onChange={(icon) => set({ icon })} />
      <Field label="Command" mono value={draft.command} placeholder="bun run dev" onChange={(command) => set({ command })} onLeave={(next) => leave("command", next)} />
      <Field
        label="Working directory"
        mono
        value={draft.cwd}
        placeholder="apps/web"
        title="Relative to the worktree the run is started from."
        onChange={(cwd) => set({ cwd })}
        onLeave={(next) => leave("cwd", next)}
      />
      <Field
        label="Readiness check"
        mono
        value={draft.readinessUrl}
        placeholder="http://localhost:3000 — optional"
        title="Only counted when the address was silent before the run started."
        onChange={(readinessUrl) => set({ readinessUrl })}
        onLeave={(next) => leave("readinessUrl", next)}
      />
      <EnvironmentSection rows={draft.env} setRows={setRows} onLeave={(next) => leave("env", next)} />

      {shown.map((problem, index) => (
        <p key={index} role="alert" className="text-xs text-destructive">
          {problem.message}
        </p>
      ))}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50 focus-visible:outline focus-visible:outline-ring"
        >
          Save
        </button>
        <button
          type="button"
          {...{ [CANCEL_MARK]: "" }}
          className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"
          // Keep focus in the field: a blur here is what moved this button out
          // from under the pointer before its click could land.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
