"use client";

/**
 * The project's deployment, as one surface: what is running, from which tree,
 * what it is saying, and the saved configurations it can be started from.
 *
 * IT SHOWS THE PROJECT, NOT THE CONVERSATION. There is one deployment per
 * project and every session sees the same one, so this panel reads the same
 * answer in every session and names the worktree the run actually came from —
 * which is the only way a human can tell "my dev server" from "the dev server
 * somebody else's session started from another branch".
 *
 * POLLING, NOT STREAMING, and deliberately so for this milestone: run output has
 * no event stream yet, and a cursor poll is honest about being a poll. The
 * cadence backs off once nothing is live (`pollInterval`) so an idle project
 * costs one request every few seconds rather than four.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EngineApiError } from "@/lib/engine/client";
import { runApi } from "@/lib/run/api";
import type { RunApi } from "@/lib/run/api";
import {
  appendOutput,
  describeReadiness,
  droppedNotice,
  emptyOutput,
  recentRuns,
  runAction,
  statusDetail,
  statusLabel,
  statusTone,
  worktreeLabel,
} from "@/lib/run/presentation";
import type { RunOutputBuffer, RunTone } from "@/lib/run/presentation";
import type { RunConfigurationDraft, RunConfigurationView, RunStatusAnswer } from "@/lib/run/types";
import { RunConfigEditor } from "./run-config-editor";
import { RunControl } from "./run-control";

/** Fast while something is live, slow when nothing is. */
export function pollInterval(answer: RunStatusAnswer | undefined): number {
  const status = answer?.active?.status;
  if (status === "starting" || status === "running") return 1000;
  if (status === "ready") return 3000;
  return 5000;
}

/** Whether output is worth asking for at all: a run that ended still has its
 *  retained window, so this stays true for a finished run we are looking at. */
export function shouldPollOutput(answer: RunStatusAnswer | undefined): boolean {
  return Boolean(answer?.active);
}

const toneClass: Record<RunTone, string> = {
  idle: "text-muted-foreground",
  working: "text-amber-600 dark:text-amber-400",
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-destructive",
  lost: "text-destructive",
};

function message(error: unknown): string {
  if (error instanceof EngineApiError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}

type Props = { sessionId: string; api?: RunApi };

export function RunPanel({ sessionId, api = runApi }: Props) {
  const [answer, setAnswer] = useState<RunStatusAnswer>();
  const [configs, setConfigs] = useState<RunConfigurationView[]>([]);
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<{ config?: RunConfigurationView } | undefined>();
  const [output, setOutput] = useState<RunOutputBuffer>(emptyOutput);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);

  const refreshConfigs = useCallback(async () => {
    const { configurations } = await api.configurations(sessionId);
    setConfigs(configurations);
    setSelected((current) => current ?? configurations[0]?.id);
  }, [api, sessionId]);

  useEffect(() => {
    let live = true;
    void refreshConfigs().catch((cause) => live && setError(message(cause)));
    return () => {
      live = false;
    };
  }, [refreshConfigs]);

  // One timer, rescheduled from its own result, so the cadence follows the run
  // rather than a fixed interval that keeps firing after everything stopped.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await api.status(sessionId);
        if (!live) return;
        setAnswer(next);
        setError(undefined);
        if (shouldPollOutput(next)) {
          const slice = await api.output(sessionId, { after: cursor.current });
          if (!live) return;
          setOutput((current) => {
            const merged = appendOutput(current, slice);
            cursor.current = merged.cursor;
            return merged;
          });
        }
        if (live) timer = setTimeout(() => void tick(), pollInterval(next));
      } catch (cause) {
        if (!live) return;
        setError(message(cause));
        timer = setTimeout(() => void tick(), 5000);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, sessionId]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      cursor.current = 0;
      setOutput(emptyOutput);
      setAnswer(await api.status(sessionId));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = (patch: Partial<RunConfigurationDraft>) => {
    const existing = editing?.config;
    void act(async () => {
      if (existing) await api.updateConfiguration(sessionId, existing.id, patch);
      else await api.createConfiguration(sessionId, patch as RunConfigurationDraft);
      await refreshConfigs();
      setEditing(undefined);
    });
  };

  const active = answer?.active;
  const action = answer ? runAction(answer) : undefined;
  const selectedConfig = configs.find((config) => config.id === selected);

  if (editing) {
    return (
      <div className="space-y-3 p-4">
        <h2 className="text-sm font-medium">{editing.config ? `Edit “${editing.config.name}”` : "New configuration"}</h2>
        <RunConfigEditor
          {...(editing.config ? { config: editing.config } : {})}
          busy={busy}
          {...(error ? { error } : {})}
          onSave={save}
          onCancel={() => setEditing(undefined)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <select
          aria-label="Run configuration"
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
          value={selected ?? ""}
          onChange={(event) => setSelected(event.target.value)}
        >
          {configs.length ? null : <option value="">No saved configurations</option>}
          {configs.map((config) => (
            <option key={config.id} value={config.id}>
              {config.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
          onClick={() => setEditing({})}
        >
          New
        </button>
        {selectedConfig ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
            onClick={() => setEditing({ config: selectedConfig })}
          >
            Edit
          </button>
        ) : null}
      </div>

      {answer ? (
        <RunControl
          answer={answer}
          {...(selectedConfig ? { configName: selectedConfig.name } : {})}
          busy={busy}
          onStart={(replace) => void act(() => api.start(sessionId, selected!, replace))}
          onStop={() => void act(() => api.stop(sessionId))}
          onRestart={() => void act(() => api.restart(sessionId))}
          onRelease={() => void act(() => api.release(sessionId, active!.runId))}
        />
      ) : null}

      {active ? (
        <section className="space-y-1 rounded-md border border-border p-3" aria-label="Deployment">
          <div className="flex items-baseline gap-2">
            <span className={`text-sm font-medium ${toneClass[statusTone(active.status)]}`}>{statusLabel(active)}</span>
            <span className="truncate text-sm">{active.configName}</span>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={active.command}>
            {active.command}
          </p>
          <p className="text-xs text-muted-foreground" title={active.worktreePath}>
            From {worktreeLabel(active.worktreePath, active.worktreeBranch)}
            {active.pid ? ` · pid ${active.pid}` : ""}
          </p>
          {action?.kind === "switch" ? (
            // Stated plainly rather than as a warning colour: the run is fine,
            // it is simply not this session's tree, and its output below is
            // about that other checkout.
            <p className="text-xs text-amber-600 dark:text-amber-400">
              This deployment is not from this session's worktree.
            </p>
          ) : null}
          {describeReadiness(active.readiness, active.readinessUrl) ? (
            <p className="text-xs text-muted-foreground">{describeReadiness(active.readiness, active.readinessUrl)}</p>
          ) : null}
          {statusDetail(active) ? <p className="text-xs text-destructive">{statusDetail(active)}</p> : null}
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing is deployed for this project.</p>
      )}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {output.lines.length ? (
        <section className="min-h-0 space-y-1" aria-label="Output">
          {droppedNotice(output) ? <p className="text-xs text-muted-foreground">{droppedNotice(output)}</p> : null}
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
            {output.lines.map((line, index) => (
              <div key={index} className={line.stream === "stderr" ? "text-destructive" : undefined}>
                {line.text}
              </div>
            ))}
          </pre>
        </section>
      ) : null}

      {answer && recentRuns(answer).length > 1 ? (
        <section className="space-y-1" aria-label="Recent runs">
          <h3 className="text-xs font-medium text-muted-foreground">Recent</h3>
          {recentRuns(answer)
            .filter((entry) => entry.runId !== active?.runId)
            .map((entry) => (
              <p key={entry.runId} className="truncate text-xs text-muted-foreground">
                <span className={toneClass[statusTone(entry.status)]}>{statusLabel(entry)}</span> · {entry.configName} ·{" "}
                {worktreeLabel(entry.worktreePath, entry.worktreeBranch)}
              </p>
            ))}
        </section>
      ) : null}
    </div>
  );
}
