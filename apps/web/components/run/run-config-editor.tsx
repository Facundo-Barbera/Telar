"use client";

/**
 * The form for one saved configuration: a name, a command, where to run it, and
 * the environment it needs.
 *
 * A SECRET CANNOT BE READ BACK, AND THE FORM SAYS SO. `RunEnvView` has no
 * `value` when `secret` is true — the cockpit is never sent one — so a secret
 * row opens as “hidden”, not as an empty box that would silently blank it on
 * save. The engine's patch merges shallowly, so leaving `env` out of the patch
 * preserves what is stored; that is exactly what this form does whenever the
 * environment was not touched.
 *
 * THE ONE AWKWARD CASE IS STATED RATHER THAN GUESSED. Environment is stored as a
 * whole list, so changing ANY row means sending every row — including secrets
 * whose values this form does not have. Instead of dropping them, or inventing a
 * placeholder the engine would store verbatim, `environmentBlocker` refuses the
 * save and names the variables that must be re-entered.
 */

import { useState } from "react";
import { EyeOffIcon, PlusIcon, XIcon } from "lucide-react";
import { draftProblems } from "@/lib/run/presentation";
import type { DraftProblem } from "@/lib/run/presentation";
import type { RunConfigurationDraft, RunConfigurationView } from "@/lib/run/types";

/** A row as the form holds it: `kept` marks a secret whose stored value the
 *  cockpit has never seen and must not overwrite. */
export type EnvRow = { key: string; value: string; secret?: boolean; kept?: boolean };

export type EditorDraft = { name: string; command: string; cwd: string; readinessUrl: string; env: EnvRow[] };

export function emptyDraft(): EditorDraft {
  return { name: "", command: "", cwd: "", readinessUrl: "", env: [] };
}

export function draftFromConfiguration(config: RunConfigurationView): EditorDraft {
  return {
    name: config.name,
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

/** What to PATCH: `env` only when it changed, so an untouched secret survives
 *  the engine's shallow merge untouched. */
export function configurationPatch(original: RunConfigurationView | undefined, draft: EditorDraft): Partial<RunConfigurationDraft> {
  const full = toDraft(draft);
  if (environmentTouched(original, draft)) return full;
  const { env: _env, ...rest } = full;
  return rest;
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
  const problems = editorProblems(config, draft);
  const set = (patch: Partial<EditorDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setRow = (index: number, patch: Partial<EnvRow>) =>
    setDraft((current) => ({
      ...current,
      env: current.env.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!problems.length && !busy) onSave(configurationPatch(config, draft));
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <input
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm focus-visible:outline focus-visible:outline-ring"
          value={draft.name}
          placeholder="Dev server"
          onChange={(event) => set({ name: event.target.value })}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Command</span>
        <input
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm focus-visible:outline focus-visible:outline-ring"
          value={draft.command}
          placeholder="bun run dev"
          onChange={(event) => set({ command: event.target.value })}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Working directory</span>
        <input
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm focus-visible:outline focus-visible:outline-ring"
          value={draft.cwd}
          placeholder="apps/web"
          onChange={(event) => set({ cwd: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">Relative to the worktree the run is started from.</span>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Readiness check</span>
        <input
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm focus-visible:outline focus-visible:outline-ring"
          value={draft.readinessUrl}
          placeholder="http://localhost:3000"
          onChange={(event) => set({ readinessUrl: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">
          Optional. Only counted when the address was silent before the run started.
        </span>
      </label>

      <section className="space-y-2" aria-label="Environment variables">
        <h3 className="text-xs font-medium text-muted-foreground">Environment</h3>
        {draft.env.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              aria-label="Variable name"
              className="w-40 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-sm focus-visible:outline focus-visible:outline-ring"
              value={row.key}
              onChange={(event) => setRow(index, { key: event.target.value })}
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
              />
            )}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={Boolean(row.secret)}
                onChange={(event) => setRow(index, { secret: event.target.checked, kept: false })}
              />
              Secret
            </label>
            <button
              type="button"
              aria-label={`Remove ${row.key || "variable"}`}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              onClick={() => setDraft((current) => ({ ...current, env: current.env.filter((_, position) => position !== index) }))}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          onClick={() => setDraft((current) => ({ ...current, env: [...current.env, { key: "", value: "" }] }))}
        >
          <PlusIcon className="size-3.5" /> Add variable
        </button>
      </section>

      {problems.map((problem, index) => (
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
          disabled={busy || problems.length > 0}
          className="rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted disabled:opacity-50 focus-visible:outline focus-visible:outline-ring"
        >
          Save
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
