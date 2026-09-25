"use client";

/**
 * The masthead's run control: SETUP, starting and ending live here, monitoring
 * lives in the right panel's Terminal tab, where a run is a chip beside the
 * session's shells (#890). The same `RunConfigEditor` that tab's editor uses is
 * rendered inline, so there is one configuration form, not two.
 *
 * BUILT AROUND THE SESSION'S LIST OF TERMINALS ("Run = a new terminal"). A
 * run is a terminal, a session may have any number of them open, and pressing
 * a configuration opens ANOTHER one — "web dev", then "web dev #2". There is
 * no deployment slot, so nothing here restarts, replaces or switches: the menu
 * is what is open (each with End) above what can be started.
 *
 * THIS PILL DOES NOT POLL ANY MORE, and that is the second half of #890. It
 * asked `/run/status` every four seconds while something was live and every
 * twelve while nothing was — for ever, in every window with the cockpit open,
 * whether or not anybody was looking at it. It now reads status ONCE per mount
 * and follows the engine's `run.status` frames (`lib/run/status-stream.ts`),
 * which carry the whole view: a run started from another session, or by an
 * agent, still reaches this pill, and it reaches it sooner.
 *
 * Host and session together are still this control's identity — the client is
 * pinned with `hostFetcher(hostId)`, because a pathname-following singleton
 * would ask whichever host the URL happens to name and two hosts can hold the
 * same session id.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, CircleStopIcon, Loader2Icon, PlusIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { createRunApi, type RunApi } from "@/lib/run/api";
import { RunGlyph } from "@/lib/run/icons";
import {
  openCount,
  openTerminals,
  runSummary,
  statusDetail,
  statusLabel,
  statusTone,
  terminalTitle,
  type RunTone,
} from "@/lib/run/presentation";
import { mayClose } from "@/lib/terminal-close";
import { useRunStatusFeed } from "@/lib/run/status-stream";
import type { RunConfigurationDraft, RunConfigurationView, RunView } from "@/lib/run/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RunConfigEditor } from "./run-config-editor";
import { cn } from "@/lib/utils";

const TONE_DOT: Record<RunTone, string> = {
  idle: "bg-muted-foreground/40",
  working: "bg-warning",
  good: "bg-success",
  bad: "bg-destructive",
};

type Channel = "configs";
/** What a read carries: the generation it opened under, and its place in its
 *  own channel's sequence. */
export type ReadToken = { channel: Channel; generation: number; seq: number };

/**
 * Which answers may still be applied.
 *
 * An answer is stale if a mutation or unmount bumped the generation, or if a
 * newer read on the same channel has since opened — two configs reads with no
 * mutation between them still order, so the earlier one cannot overwrite the
 * later one's list.
 *
 * THE STATUS CHANNEL AND ITS LATCH ARE GONE (#890). They existed to keep two
 * overlapping status POLLS from landing out of order, and there is no status
 * poll any more: `useRunStatusFeed` reads once and then follows a stream, whose
 * frames are ordered by the connection they arrive on. What is left is the
 * configurations list, which is still read on mount and on every open.
 *
 * Exported because this is the rule worth testing directly; the component
 * below is its only caller.
 */
export function createReadGuard() {
  let generation = 0;
  const newest: Record<Channel, number> = { configs: 0 };

  const open = (channel: Channel): ReadToken => ({ channel, generation, seq: (newest[channel] += 1) });

  return {
    open,
    stale: (token: ReadToken) => token.generation !== generation || token.seq !== newest[token.channel],
    /** A mutation or unmount: every read in flight is now stale. */
    invalidate: () => {
      generation += 1;
    },
  };
}

export type ReadGuard = ReturnType<typeof createReadGuard>;

/**
 * Which button the masthead offers — and the empty case is the interesting one.
 *
 * `setup` is the state where "Run" would be a control that cannot run
 * anything: the project has no saved recipe and nothing is deployed. The
 * button becomes "Setup" and opens the editor, rather than a menu whose only
 * content is a sentence explaining why it is empty.
 *
 * TWO STATES ARE DELIBERATELY NOT `setup`. A list that has not been READ yet
 * (`undefined`) is unknown, not empty — offering Setup over a project that
 * turns out to have three configurations is worse than a moment of "Run". And
 * an open terminal wins over an empty list, because one whose recipe was
 * deleted mid-flight is still the thing a human needs to see and end.
 *
 * Exported because this is the rule worth testing directly; the component
 * below is its only caller.
 */
export function headerMode(configs: RunConfigurationView[] | undefined, active: RunView | undefined): "setup" | "run" {
  return configs?.length === 0 && !active ? "setup" : "run";
}

/**
 * ONE ROW OF THE OPEN LIST: which terminal, how it is doing, and End.
 *
 * THE WARNING IS SHOWN IN FULL HERE, because this is the one place with room
 * for a sentence. A busy port does not block anything — the engine opened the
 * terminal anyway — but a person wondering why it never turned green deserves
 * the engine's own explanation ("port 3000 already answers, so something else
 * may be serving it …") rather than a symbol to decode.
 */
function OpenTerminalRow({
  view,
  config,
  busy,
  onEnd,
}: {
  view: RunView;
  config: RunConfigurationView | undefined;
  busy: boolean;
  onEnd: () => void;
}) {
  const title = terminalTitle(view);
  return (
    <div className="flex flex-col gap-0.5 rounded-md px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[statusTone(view.status)])} />
        <RunGlyph icon={config?.icon} className="size-3.5 shrink-0 opacity-80" />
        <span className="min-w-0 flex-1 truncate text-sm" title={view.command}>
          {title}
        </span>
        <span className="shrink-0 text-3xs text-muted-foreground">{statusLabel(view)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`End ${title}`}
          title="End — stops it and closes its terminal"
          disabled={busy}
          onClick={onEnd}
        >
          <CircleStopIcon />
        </Button>
      </div>
      {view.warning && (
        <p className="flex items-start gap-1 pl-3.5 text-2xs leading-snug text-warning">
          <TriangleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
          <span>{statusDetail(view)}</span>
        </p>
      )}
      {view.readinessUrl && !view.warning && (
        <a
          href={view.readinessUrl}
          target="_blank"
          rel="noreferrer"
          className="truncate pl-3.5 text-2xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {view.readinessUrl}
        </a>
      )}
    </div>
  );
}

export function RunHeaderControl({
  sessionId,
  hostId,
  api: injected,
  onWatchOutput,
}: {
  sessionId: string;
  /** Which Mac this session lives on. Absent means the local one. */
  hostId?: string;
  /** Injected by tests and the fixture; production builds a pinned client. */
  api?: RunApi;
  /** Opens the right panel's Terminal tab — monitoring stays there. */
  onWatchOutput?: () => void;
}) {
  const api = useMemo(() => injected ?? createRunApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), [injected, hostId]);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [configs, setConfigs] = useState<RunConfigurationView[]>();
  const [editing, setEditing] = useState<{ config?: RunConfigurationView } | undefined>();
  const [error, setError] = useState<string>();

  /** Per mount, and the masthead keys this component by host and session — so
   *  a different machine starts with a clean guard. */
  const [guard] = useState(createReadGuard);
  // Unmount discards whatever is still in flight.
  useEffect(() => () => guard.invalidate(), [guard]);

  /**
   * ONE READ, THEN EVENTS — and `refresh` is NOT a poll (#890).
   *
   * The feed asks `/run/status` once per mount and then follows the engine's
   * frames. `refresh` re-reads and re-opens, and is called only after a
   * MUTATION THIS CONTROL PERFORMED, so a pressed button does not look
   * unpressed while its own round trip finishes. Nothing calls it on a timer.
   */
  const feed = useRunStatusFeed({ sessionId, ...(hostId ? { hostId } : {}), api });
  const refresh = feed.refresh;
  /**
   * THE WHOLE LIST, NOT THE NEWEST ONE. A session may have any number of
   * terminals open at once ("web dev", "web dev #2"), and a control that
   * summarised one of them would hide the others behind it.
   */
  const terminals = openTerminals(feed.status);

  /** Read on every open: a configuration added or renamed in the panel must
   *  not be invisible here until the page reloads. */
  const loadConfigs = useCallback(() => {
    const token = guard.open("configs");
    api
      .configurations(sessionId)
      .then((answer) => {
        if (!guard.stale(token)) setConfigs(answer.configurations);
      })
      .catch((cause: unknown) => {
        if (!guard.stale(token)) setError(cause instanceof Error ? cause.message : "Could not read the run configurations.");
      });
  }, [api, sessionId, guard]);

  /**
   * ON MOUNT AS WELL AS ON OPEN, and that is what makes the Setup state
   * possible. The button has to know whether this project has ANY recipe
   * before a human touches it — a list read only when the popover opens would
   * leave the masthead saying "Run" over a menu with nothing in it, which is
   * the exact dead end this empty state exists to remove.
   */
  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  useEffect(() => {
    if (open) loadConfigs();
  }, [open, loadConfigs]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      // A mutation invalidates every read already in flight — the list and
      // the status they would restore both predate this change.
      guard.invalidate();
      refresh();
      loadConfigs();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That run action failed.");
    } finally {
      setBusy(false);
    }
  };

  const save = (draft: RunConfigurationDraft | Partial<RunConfigurationDraft>) =>
    void run(async () => {
      if (editing?.config) await api.updateConfiguration(sessionId, editing.config.id, draft);
      else await api.createConfiguration(sessionId, draft as RunConfigurationDraft);
      setEditing(undefined);
    });

  /**
   * END = CLOSE THE TERMINAL, asking first only if something is running in it
   * — the same question, in the same words, a close on its chip asks
   * (`lib/terminal-close.ts`). "No" leaves it exactly as it was.
   */
  const end = (view: RunView) =>
    void (async () => {
      const target = { id: view.terminalId, label: terminalTitle(view), command: view.command };
      if (!(await mayClose([target]))) return;
      await run(() => api.stop(sessionId, view.terminalId));
    })();

  const summary = runSummary(terminals);
  const setup = headerMode(configs, terminals[0]) === "setup";
  /** One open terminal wears its recipe's glyph in the masthead; several do not
   *  share one. A recipe deleted mid-run simply has no glyph. */
  const only = terminals.length === 1 ? terminals[0] : undefined;
  const onlyConfig = only ? configs?.find((config) => config.id === only.configId) : undefined;
  const warned = terminals.some((view) => view.warning);

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        // Straight into the editor when there is nothing to pick from. Set on
        // the way OPEN rather than kept in state, so a human who cancels sees
        // the (empty) menu and is not trapped in a form they just dismissed.
        if (next && setup) setEditing({});
        if (!next) setEditing(undefined);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            // One family with Open and the pinned summary beside it: bordered,
            // h-7, so the cockpit's controls read as controls rather than as
            // glyphs you have to hover to discover. `outline` is the variant
            // that carries an aria-expanded state, which all three of them —
            // being popover triggers — actually have.
            variant="outline"
            size="sm"
            aria-label={
              setup
                ? "Run — set up a configuration"
                : terminals.length === 0
                  ? "Run this project"
                  : `Run: ${summary.label}${summary.detail ? `, ${summary.detail}` : ""}${warned ? ", with a warning" : ""}`
            }
            className="h-7 gap-1.5 px-2 text-xs font-medium"
          >
            {setup ? (
              // THE WORD IS "RUN" IN BOTH STATES, and the glyph carries the
              // difference. The plus says a form is what opens; no dot, because
              // there is no run to have a status, and no chevron, because this
              // is not a menu.
              <>
                <PlusIcon className="size-3.5 shrink-0" />
                <span className="max-w-32 truncate">Run</span>
              </>
            ) : (
              <>
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[summary.tone])} />
                {onlyConfig && <RunGlyph icon={onlyConfig.icon} className="size-3.5 shrink-0 opacity-80" />}
                <span className="max-w-32 truncate">{summary.label}</span>
                {warned && <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning" />}
                <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
              </>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        // THE FORM MUST REACH ITS OWN SAVE BUTTON. At 34rem the editor's last
        // rows — Save and Cancel — sat below the fold on a 980px-tall window,
        // so the one thing a human opened this form to do was behind a scroll
        // they had no reason to expect. The viewport clamp is what actually
        // binds on a short screen; the 40rem ceiling keeps it from becoming a
        // full-height column on a tall one.
        className={cn(
          "flex-col gap-0 overflow-hidden rounded-xl p-0",
          editing ? "max-h-[min(40rem,calc(100vh-7rem))] w-[26rem]" : "w-80",
        )}
      >
        {editing ? (
          <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <SlidersHorizontalIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {editing.config ? `Edit ${editing.config.name}` : "New run configuration"}
              </span>
            </div>
            {/* THE PANEL'S OWN FORM, not a second one. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <RunConfigEditor
                {...(editing.config ? { config: editing.config } : {})}
                busy={busy}
                {...(error ? { error } : {})}
                onSave={save}
                onCancel={() => setEditing(undefined)}
              />
            </div>
          </div>
        ) : (
          <>
            {/*
             * TWO LISTS, AND THEY ANSWER DIFFERENT QUESTIONS. "Open" is what
             * this session has running right now — each one a terminal in the
             * panel, each with its own End. "Start" is the recipes, and
             * pressing one ALWAYS opens another terminal: it never restarts or
             * replaces one already open, which is what "2 open" beside it is
             * there to make obvious before the press rather than after.
             */}
            {terminals.length > 0 && (
              <section aria-label="Open terminals" className="flex max-h-56 flex-col gap-0.5 overflow-y-auto border-b border-border p-1">
                <h3 className="flex items-center gap-2 px-2 pt-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
                  Open
                  {busy && <Loader2Icon className="size-3 animate-spin" />}
                </h3>
                {terminals.map((view) => (
                  <OpenTerminalRow
                    key={view.terminalId}
                    view={view}
                    config={configs?.find((config) => config.id === view.configId)}
                    busy={busy}
                    onEnd={() => end(view)}
                  />
                ))}
              </section>
            )}

            <section aria-label="Start a terminal" className="flex min-h-0 max-h-72 flex-col gap-0.5 overflow-y-auto p-1">
              <h3 className="px-2 pt-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase">Start</h3>
              {configs === undefined ? (
                <p className="px-2 py-1.5 text-2xs text-muted-foreground">Reading configurations…</p>
              ) : configs.length === 0 ? (
                <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">
                  No run configuration yet. Add one to give this project a start command.
                </p>
              ) : (
                configs.map((config) => {
                  const count = openCount(terminals, config.id);
                  return (
                    <div key={config.id} className="group/run flex items-center gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={count > 0 ? `Start another ${config.name}` : `Start ${config.name}`}
                        title={count > 0 ? "Opens one more terminal running this; the open ones keep going" : "Opens a new terminal running this"}
                        onClick={() => void run(() => api.start(sessionId, config.id))}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60",
                          busy && "opacity-60",
                        )}
                      >
                        <RunGlyph icon={config.icon} className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{config.name}</span>
                        {count > 0 && <span className="shrink-0 text-3xs text-muted-foreground">{count} open</span>}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${config.name}`}
                        title="Edit"
                        disabled={busy}
                        className="shrink-0 opacity-0 group-hover/run:opacity-70 focus-visible:opacity-100"
                        onClick={() => setEditing({ config })}
                      >
                        <SlidersHorizontalIcon />
                      </Button>
                    </div>
                  );
                })
              )}
            </section>

            {error && <p className="border-t border-border px-3 py-1.5 text-2xs leading-snug text-destructive">{error}</p>}

            <div className="flex items-center gap-1 border-t border-border p-1">
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setEditing({})}>
                <PlusIcon className="size-3.5" />
                New configuration
              </Button>
              <div className="flex-1" />
              {/* The door to the terminals, not a second copy of them. */}
              {onWatchOutput && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setOpen(false);
                    onWatchOutput();
                  }}
                >
                  Show terminals
                </Button>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
