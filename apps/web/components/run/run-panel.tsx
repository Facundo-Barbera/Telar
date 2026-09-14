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
 *
 * IT IS PINNED TO ONE MAC. The default `runApi` resolves the host from the
 * address bar per call, so a two-leg poll could finish against another host —
 * and session ids are per-host and can collide, so the answer would describe a
 * stranger's deployment rather than fail. Hence: the api is built once from
 * `hostFetcher(hostId)`, host and session together are this panel's identity
 * (`runIdentity`), and an answer is published only if `stillOurs` says the
 * identity it was asked under is still current.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngineApiError } from "@/lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { createRunApi } from "@/lib/run/api";
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
  working: "text-warning",
  good: "text-success",
  bad: "text-destructive",
  lost: "text-destructive",
};

function message(error: unknown): string {
  if (error instanceof EngineApiError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** Which Mac and which session this panel is about, as one comparable value.
 *  Joined by NUL, which neither id can contain, so no pair can spell another. */
export function runIdentity(hostId: string | undefined, sessionId: string): string {
  return `${hostId ?? LOCAL_HOST_ID}\u0000${sessionId}`;
}

/**
 * May an answer asked for under `asked` still be published?
 *
 * Every request captures the identity it was made under and re-checks it here
 * on the way back — the rule that keeps a late status, a late output slice or a
 * late stop from landing on a different Mac's deployment. A poll paused while
 * the panel is off screen also stops being current, so its in-flight legs are
 * discarded rather than applied on reopen.
 */
export function stillOurs(asked: string, current: string, watching: boolean): boolean {
  return watching && asked === current;
}

type Props = {
  sessionId: string;
  /** The Mac this session lives on. Absent means this cockpit's own. */
  hostId?: string;
  /**
   * On screen? The shell keeps the panel mounted at zero width through its
   * close animation, so polling has to stop on a flag rather than on unmount.
   */
  visible?: boolean;
  /** Injected in tests; production builds one pinned to `hostId`. */
  api?: RunApi;
};

export function RunPanel({ sessionId, hostId, visible = true, api: injected }: Props) {
  const [answer, setAnswer] = useState<RunStatusAnswer>();
  const [configs, setConfigs] = useState<RunConfigurationView[]>([]);
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<{ config?: RunConfigurationView } | undefined>();
  const [output, setOutput] = useState<RunOutputBuffer>(emptyOutput);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);

  /** One per host, not one per render — see the note at the top of the file. */
  const api = useMemo(() => injected ?? createRunApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), [injected, hostId]);

  const identity = runIdentity(hostId, sessionId);
  /** The identity in-flight requests are checked against on the way back. Read
   *  from callbacks only; written from the effect below. */
  const current = useRef(identity);
  const watching = useRef(visible);
  const mine = (asked: string) => stillOurs(asked, current.current, watching.current);

  const refreshConfigs = useCallback(
    async (asked: string) => {
      const { configurations } = await api.configurations(sessionId);
      if (!mine(asked)) return;
      setConfigs(configurations);
      setSelected((selection) => selection ?? configurations[0]?.id);
    },
    [api, sessionId],
  );

  /** A different host or session is a different subject, so nothing on screen
   *  survives the change. Cleared during render, not from an effect, so no
   *  frame shows one Mac's deployment under another's heading. */
  const [subject, setSubject] = useState(identity);
  if (subject !== identity) {
    setSubject(identity);
    setAnswer(undefined);
    setConfigs([]);
    setSelected(undefined);
    setOutput(emptyOutput);
    setError(undefined);
    // The open editor goes too. It holds a configuration id belonging to the
    // OLD subject, and saving it after the change would PATCH the new project
    // with the old one's id — a form left standing is not a cosmetic leftover.
    setEditing(undefined);
  }

  useEffect(() => {
    current.current = identity;
    cursor.current = 0;
  }, [identity]);

  useEffect(() => {
    watching.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const asked = identity;
    const load = async () => {
      try {
        await refreshConfigs(asked);
      } catch (cause) {
        if (mine(asked)) setError(message(cause));
      }
    };
    void load();
  }, [refreshConfigs, identity, visible]);

  /**
   * One timer, rescheduled from its own result, so the cadence follows the run
   * rather than a fixed interval that keeps firing after everything stopped.
   *
   * NOTHING IS POLLED WHILE THE PANEL IS OFF SCREEN. It stays mounted at zero
   * width through the close animation, and a hidden surface asking once a
   * second is cost with no reader. Re-running on `visible` is also the refresh:
   * a reopened panel asks immediately rather than waiting out a timer.
   */
  useEffect(() => {
    if (!visible) return;
    const asked = identity;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const usable = () => live && mine(asked);
    const tick = async () => {
      try {
        const next = await api.status(sessionId);
        if (!usable()) return;
        setAnswer(next);
        setError(undefined);
        if (shouldPollOutput(next)) {
          const slice = await api.output(sessionId, { after: cursor.current });
          if (!usable()) return;
          setOutput((buffer) => {
            const merged = appendOutput(buffer, slice);
            cursor.current = merged.cursor;
            return merged;
          });
        }
        if (usable()) timer = setTimeout(() => void tick(), pollInterval(next));
      } catch (cause) {
        if (!usable()) return;
        setError(message(cause));
        timer = setTimeout(() => void tick(), 5000);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, sessionId, identity, visible]);

  /** An action's completion is as stale-able as a poll's: a stop that lands
   *  after the panel moved on must not clear the new subject's output. `busy`
   *  is the exception — it is this button's own state, and leaving it set would
   *  strand the control behind a spinner that never clears. */
  const act = async (work: () => Promise<unknown>) => {
    const asked = identity;
    setBusy(true);
    setError(undefined);
    try {
      await work();
      if (!mine(asked)) return;
      cursor.current = 0;
      setOutput(emptyOutput);
      const next = await api.status(sessionId);
      if (mine(asked)) setAnswer(next);
    } catch (cause) {
      if (mine(asked)) setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = (patch: Partial<RunConfigurationDraft>) => {
    const existing = editing?.config;
    const asked = identity;
    void act(async () => {
      if (existing) await api.updateConfiguration(sessionId, existing.id, patch);
      else await api.createConfiguration(sessionId, patch as RunConfigurationDraft);
      await refreshConfigs(asked);
      if (mine(asked)) setEditing(undefined);
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
          className="rounded-md border border-border px-2 py-1.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setEditing({})}
        >
          New
        </button>
        {selectedConfig ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
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
            <p className="text-xs text-warning">
              This deployment is not from this session&apos;s worktree.
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
