"use client";

// Story 4.2 — THE SUB-AGENT RAIL'S WORKFLOWS SECTION (`ui-contract.md` §3).
//
// Run cards (name · state · spend · Stop), phase groups holding per-agent rows,
// a FIXED-HEIGHT scrolling narrator window, and a read-only Script tab with a
// link-out to the authoring reference. It renders INSIDE `SubagentRail` through
// its `workflows` slot, so it shares that rail's border, its collapse behaviour
// and its scroll column (§5.5-D10).
//
// EVERY DECISION IS IN `lib/ultra-runs.ts`, NOT HERE. Which agent rows exist,
// which phase an agent belongs to, which log lines are narration, whether a
// denominator exists — all projected and all tested. What is left here is
// layout, because there is no DOM harness in this repo to prove layout with.
//
// THE RAIL IS `w-60` IN PRODUCTION (240px), not the demo's `w-72`, and it has no
// `bg-card`. Everything here fits 240px minus `p-2`, which is why every
// variable-width child carries `min-w-0` + `truncate` and why the chips are
// `text-[10px]`.
//
// QUIET COLOUR, AND THE GALLERY IS NOT THE REFERENCE FOR IT. `STATE_STYLE`'s
// saturated fills, the saturated agent dots and the `animate-pulse` running pill
// are all violations of UX-DR10/DR11; the tone table lives in `ultra-anchor.tsx`
// and is imported rather than re-derived (ONE mapping table, in one module,
// never per component).
//
// NO BUDGET UI (NFR-UW-7 / AC9): spend readouts only. No meter, no ceiling, no
// percentage, no reserved headroom, and no `<Progress>` bound to money.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlayIcon,
  SquareIcon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ULTRA_STATE_TONE, ULTRA_TONE_CLASS } from "@/components/session/ultra-anchor";
import { ULTRA_AUTHORING_REFERENCE } from "@/lib/ultra-authoring";
import { anchorSpend, type AgentRow, type RunSnapshot } from "@/lib/ultra-runs";
import type { SpendProvider } from "@/lib/spend-readout";
import { cn } from "@/lib/utils";

/** The narrator window's height, EXPLICIT and not a `max-h` (§5.4-H). A `max-h`
 *  grows with content until it caps, which is a layout shift on every one of the
 *  first N lines — and `components/ai-elements/conversation.tsx` configures
 *  `StickToBottom` with `resize="smooth"`, so a shift here animates the whole
 *  transcript beside it. "No layout shift, ever" is a mechanical claim. */
const NARRATOR_H = "h-20";

type Props = {
  /** This session's runs, newest-first, already projected. */
  runs: readonly RunSnapshot[];
  /** The selected run. Lives in `session-view.tsx`, NOT here: its writer is the
   *  `?run=` effect in that file, and story 4.2 adds no React context (INV-8c
   *  fails by name on a provider). */
  openRunId: string | null;
  onOpenRun: (runId: string | null) => void;
  provider: SpendProvider;
  /** Ask the owner to refetch after a control was used. The card reconciles from
   *  the next MANIFEST snapshot, never from the button's own reply. */
  onChanged: () => void;
};

export function UltraRail({ runs, openRunId, onOpenRun, provider, onChanged }: Props) {
  if (runs.length === 0) return null;
  const liveCount = runs.filter((r) => r.state === "running").length;
  return (
    <div className="flex flex-col border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Workflows
        </span>
        {liveCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 font-mono text-[10px] text-foreground">
            <Shimmer as="span" className="text-[9px] leading-none">
              ●
            </Shimmer>
            {liveCount}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{runs.length}</span>
      </div>
      <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
        {runs.map((run) => (
          <RunCard
            key={run.runId}
            run={run}
            provider={provider}
            open={openRunId === run.runId}
            onToggle={() => onOpenRun(openRunId === run.runId ? null : run.runId)}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

// ── one run ─────────────────────────────────────────────────────────────────

function RunCard({
  run,
  provider,
  open,
  onToggle,
  onChanged,
}: {
  run: RunSnapshot;
  provider: SpendProvider;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tab, setTab] = useState<"run" | "script">("run");
  const [openOrdinal, setOpenOrdinal] = useState<number | null>(null);
  const tone = ULTRA_STATE_TONE[run.state];
  const spend = anchorSpend(provider, run.spendUsd);
  // AC5 proof 1 — Resume shows for `stopped` and `failed` and NOT for `done`.
  // THIS IS A UI RULE AND CORE DOES NOT AGREE WITH IT: `resumeUltraRun` does not
  // gate on state and will resume a `done` run and re-fire its wake. Do not
  // "fix" the UI to match the port.
  const canResume = run.state === "stopped" || run.state === "failed";

  const act = useCallback(
    async (verb: "stop" | "resume") => {
      setBusy(true);
      setProblem(null);
      try {
        const r = await fetch(`/api/ultra/${encodeURIComponent(run.runId)}/${verb}`, {
          method: "POST",
        });
        const body: unknown = await r.json().catch(() => null);
        if (verb === "resume" && !r.ok) {
          // AC5 proof 3 — RESUME IS NOT IDEMPOTENT. A second POST while the run
          // is live returns 400 naming the run. That renders as the terse error,
          // never as a crash.
          const err = (body as { error?: unknown } | null)?.error;
          setProblem(typeof err === "string" ? err : "Resume was refused.");
        }
        // §5.6-T9 — `{"ok": false}` FROM STOP IS THE NORMAL ANSWER, NOT AN
        // ERROR. `stopUltraRun` returns false for three indistinguishable
        // situations: the run is unknown, it is not live IN THIS PROCESS, or it
        // is already terminal. This code assumes the third — the common case, a
        // user clicking Stop on a run the server already reconciled — and
        // therefore renders nothing. It does not assume it further than that:
        // the card's state comes from the next manifest snapshot either way.
      } catch {
        setProblem("The request did not reach the server.");
      } finally {
        setBusy(false);
        // AC5 proof 6 / §5.6-T14 — RECONCILE FROM THE MANIFEST, NEVER FROM THE
        // BUTTON'S REPLY. The agent can also stop a run by tool call
        // (`mcp__ultra__ultra_stop`), and a run can reach a terminal state with
        // no event and no publish at all (`getUltraManifest` rewrites a stale
        // `running` to `stopped` ON READ). An optimistic local state would show
        // a stale `running` for every one of those.
        onChanged();
      }
    },
    [run.runId, onChanged],
  );

  return (
    <div className="rounded-lg border">
      <div className="flex min-w-0 items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <WorkflowIcon className={cn("size-3 shrink-0", ULTRA_TONE_CLASS[tone])} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
            {run.name}
          </span>
        </button>
        <span className="shrink-0 text-[10px] text-muted-foreground">{run.state}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title={spend.title}>
          {spend.text}
        </span>
        {run.state === "running" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("stop")}
            title="Stop this run"
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <SquareIcon className="size-3" />
          </button>
        )}
        {canResume && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("resume")}
            title="Resume this run from its journal"
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <PlayIcon className="size-3" />
          </button>
        )}
      </div>

      {run.error && (
        <div className="flex min-w-0 items-center gap-1 px-1.5 pb-1 text-[10px] text-destructive">
          <TriangleAlertIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{run.error}</span>
        </div>
      )}
      {problem && (
        <div className="min-w-0 truncate px-1.5 pb-1 text-[10px] text-destructive">{problem}</div>
      )}

      {open && (
        <div className="border-t px-1.5 py-1">
          <div className="mb-1 flex gap-1">
            {(["run", "script"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                  tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                {t === "run" ? "Run" : "Script"}
              </button>
            ))}
          </div>

          {tab === "run" ? (
            <>
              {run.phases.map((group) => (
                // The unphased group's title is the empty string (`UNPHASED`),
                // so the key is PREFIXED rather than defaulted: a bare
                // `group.title || "unphased"` would collide with a real phase
                // actually named "unphased", and a separator character here is
                // how this repo has now shipped a NUL byte four times.
                <div key={`phase:${group.title}`} className="mb-1">
                  {group.title && (
                    <div className="min-w-0 truncate px-0.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      {group.title}
                    </div>
                  )}
                  {group.agents.map((agent) => (
                    <AgentRowView
                      key={agent.ordinal}
                      runId={run.runId}
                      agent={agent}
                      provider={provider}
                      open={openOrdinal === agent.ordinal}
                      onToggle={() =>
                        setOpenOrdinal(openOrdinal === agent.ordinal ? null : agent.ordinal)
                      }
                    />
                  ))}
                </div>
              ))}
              <Narrator lines={run.narrator} />
              {/* `ui-contract.md` §7: "`done` triggers the anchor's one permitted
                  collapse; THE RESULT STAYS REACHABLE FROM THE RAIL CARD." The
                  anchor drops its detail row at terminal (AC2), so this card is
                  the script's returned value's only home. `manifest.result` is
                  present ONLY alongside `done`. */}
              {run.state === "done" && <Result runId={run.runId} />}
            </>
          ) : (
            <ScriptTab runId={run.runId} />
          )}
        </div>
      )}
    </div>
  );
}

// ── one agent row ───────────────────────────────────────────────────────────

function AgentRowView({
  runId,
  agent,
  provider,
  open,
  onToggle,
}: {
  runId: string;
  agent: AgentRow;
  provider: SpendProvider;
  open: boolean;
  onToggle: () => void;
}) {
  const label = agent.label ?? `agent ${agent.ordinal}`;
  // AC11 proof 1 — `model·effort` when effort is present, `model` ALONE when it
  // is not. Never a chip whose second half is a guess.
  const chip = agent.model ? (agent.effort ? `${agent.model}·${agent.effort}` : agent.model) : null;
  // AC11 proof 6 — COST ONLY. There are no token counts anywhere on the ultra
  // path, and a live agent with no cost yet renders nothing rather than `$0`.
  const cost = agent.costUsd === undefined ? null : anchorSpend(provider, agent.costUsd).text;
  // REVIEW ROUND 1, SF-3 — `live` AND NOT `!settled`. `stopUltraRun` aborts its
  // in-flight agents, so neither ever emits a settling `agent` event and both
  // stay `settled: false` for good; the same arrives with no user action at all
  // through `getUltraManifest`'s on-read `running` → `stopped` rewrite after a
  // server restart. Branching on `!settled` painted an infinitely-animating
  // shimmer and a live dot inside a card whose header read `stopped` — an
  // animation that never ends on a run that ended, which is a placebo. The
  // decision is `lib/ultra-runs.ts`'s, where a test can drive it.
  const failed = agent.settled && agent.ok === false;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1 rounded px-0.5 py-0.5 text-left transition-colors hover:bg-muted/60"
      >
        <span
          className={cn(
            "shrink-0 text-[9px] leading-none",
            failed ? "text-destructive" : agent.live ? "text-foreground" : "text-muted-foreground/50",
          )}
          aria-hidden
        >
          ●
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-foreground">{label}</span>
        {chip && (
          // `Shimmer`'s `children` is typed `string` (§5.6-T17), so it cannot
          // wrap elements — the chip is a SIBLING of the shimmering snippet,
          // never its child.
          <span className="shrink-0 rounded border px-1 text-[9px] text-muted-foreground">
            {chip}
          </span>
        )}
        {cost && <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{cost}</span>}
      </button>
      {agent.snippet !== "" &&
        (agent.live ? (
          <Shimmer as="div" className="min-w-0 truncate px-2 pb-0.5 text-[10px]">
            {agent.snippet}
          </Shimmer>
        ) : (
          <div className="min-w-0 truncate px-2 pb-0.5 text-[10px] text-muted-foreground">
            {agent.snippet}
          </div>
        ))}
      {open && <AgentTranscript runId={runId} ordinal={agent.ordinal} />}
    </div>
  );
}

// `ui-contract.md` §3: "Clicking an agent row opens its transcript as a
// sub-agent tab does today." The data source already existed —
// `GET /api/ultra/[id]/agents/[ordinal]` → `{ ordinal, events }` from
// `readUltraAgentTranscript` — and story 4.2 added none for it.
//
// Rendered in the RAIL'S OWN PANEL: not by minting a `RailAgent` and not by
// touching `agent-tabs.tsx`, whose `activeId` vocabulary belongs to session
// sub-agents and would collide with the transcript's own bucket selector.
//
// HIGHEST `attempt` ONLY, for the same reason the index's `lastText` is: a
// retried ordinal's attempt-1 events are DISCARDED WORK — the run took attempt
// 2's answer.
function AgentTranscript({ runId, ordinal }: { runId: string; ordinal: number }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}/agents/${ordinal}`);
        if (!r.ok || cancelled) return;
        const d: unknown = await r.json();
        const events = (d as { events?: unknown }).events;
        if (!Array.isArray(events) || cancelled) return;
        const rows = events as Array<{ attempt?: number; type?: string; text?: string }>;
        const top = rows.reduce((m, e) => (typeof e.attempt === "number" && e.attempt > m ? e.attempt : m), 0);
        const prose = rows
          .filter((e) => e.attempt === top && e.type === "text" && typeof e.text === "string")
          .map((e) => e.text as string)
          .join("\n");
        setText(prose === "" ? "(no prose on this attempt)" : prose);
      } catch {
        if (!cancelled) setText("(transcript unavailable)");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, ordinal]);
  return (
    <pre className="mx-1 mb-1 max-h-40 overflow-x-auto overflow-y-auto rounded bg-background/60 p-1.5 font-mono text-[10px] whitespace-pre-wrap break-words text-muted-foreground ring-1 ring-border">
      {text ?? "…"}
    </pre>
  );
}

// ── the narrator window ─────────────────────────────────────────────────────

// A FIXED-HEIGHT SCROLLING WINDOW WITH NO LAYOUT SHIFT, EVER (`ui-contract.md`
// §3, NFR-UW-11). An explicit `h-*`, `overflow-y-auto`, and a plain ref.
//
// `ScrollArea` is not used: it exposes NO VIEWPORT REF, so it cannot be pinned
// to the bottom. Auto-scroll is `el.scrollTop = el.scrollHeight` in a
// post-render effect — never `scrollIntoView` (there is none anywhere in
// `apps/web`, and it scrolls ancestors too) and never a programmatic `.focus()`
// (WebKit 26.x, the hazard `agent-tabs.tsx`, `subagent-rail.tsx` and
// `session-view.tsx` all record).
//
// `lines` has ALREADY had `storage.ts`'s four accounting-failure `log` prefixes
// filtered out, in `lib/ultra-runs.ts` — a naive narrator shows the ledger's
// bookkeeping errors to the user.
function Narrator({ lines }: { lines: readonly string[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div
      ref={ref}
      className={cn(
        NARRATOR_H,
        "mt-1 w-full min-w-0 overflow-y-auto rounded bg-background/40 px-1 py-0.5 ring-1 ring-border",
      )}
    >
      {lines.length === 0 ? (
        <div className="text-[10px] text-muted-foreground/60">No narration yet.</div>
      ) : (
        lines.map((line, i) => (
          // The key names the line's position in an APPEND-ONLY stream, which is
          // the one case where an index is the event: narrator lines are never
          // reordered and never removed.
          <div key={`${i}:${line}`} className="min-w-0 truncate text-[10px] text-muted-foreground">
            {line}
          </div>
        ))
      )}
    </div>
  );
}

// ── the run's returned value ────────────────────────────────────────────────

function Result({ runId }: { runId: string }) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}`);
        if (!r.ok || cancelled) return;
        const d: unknown = await r.json();
        const result = (d as { run?: { result?: unknown } }).run?.result;
        if (cancelled || result === undefined) return;
        setBody(JSON.stringify(result, null, 2));
      } catch {
        // A `done` run whose manifest cannot be re-read shows nothing rather
        // than an error — the outcome already reached the user through the
        // completion wake (story 4.1).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (body === null) return null;
  return (
    <div className="mt-1">
      <div className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        Result
      </div>
      <pre className="max-h-40 overflow-x-auto overflow-y-auto rounded bg-background/60 p-1.5 font-mono text-[10px] whitespace-pre-wrap break-words text-muted-foreground ring-1 ring-border">
        {body}
      </pre>
    </div>
  );
}

// ── the Script tab ──────────────────────────────────────────────────────────

// READ-ONLY, with the model pins visible (`ui-contract.md` §3), plus a link-out
// to the authoring reference (CAP-3).
//
// THE LINK-OUT GOES SOMEWHERE REAL. The demo gallery's is
// `href="#authoring-reference"` with `preventDefault` — a dead anchor, which is
// exactly the placebo hard rule 3 forbids. This one renders
// `ULTRA_AUTHORING_REFERENCE`, THE SAME STRING the session's system-prompt
// appendix carries, so there is exactly one source for that guidance in the
// product.
function ScriptTab({ runId }: { runId: string }) {
  const [script, setScript] = useState<string | null>(null);
  const [showReference, setShowReference] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}/script`);
        if (cancelled) return;
        if (!r.ok) {
          setScript("(no script on disk for this run)");
          return;
        }
        const d: unknown = await r.json();
        // The SECOND suspension point needs its own re-check, exactly as
        // `AgentTranscript` and `Result` above already do (review NH-2). It has
        // no behavioural consequence today — `RunCard` is keyed by `runId`, so
        // this instance's `runId` cannot change while mounted, leaving only a
        // post-unmount `setScript` that React 19 no-ops — but a file that
        // applies a pattern correctly twice and drops it once reads as a
        // decision rather than an omission.
        if (cancelled) return;
        const s = (d as { script?: unknown }).script;
        setScript(typeof s === "string" ? s : "(no script on disk for this run)");
      } catch {
        if (!cancelled) setScript("(script unavailable)");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);
  return (
    <div>
      <button
        type="button"
        onClick={() => setShowReference((v) => !v)}
        aria-expanded={showReference}
        className="mb-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <BookOpenIcon className="size-3" />
        {showReference ? "Back to script" : "Authoring reference"}
      </button>
      <pre className="max-h-64 overflow-x-auto overflow-y-auto rounded bg-background/60 p-1.5 font-mono text-[10px] whitespace-pre-wrap break-words text-muted-foreground ring-1 ring-border">
        {showReference ? ULTRA_AUTHORING_REFERENCE : (script ?? "…")}
      </pre>
    </div>
  );
}
