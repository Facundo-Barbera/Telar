"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  FilePen,
  FilePlus,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
} from "lucide-react";
import type { CriticVerdict, Evidence, Loom } from "@telar/core";
import type { Operator, RosterEntry, Step, TranscriptEntry } from "./godview";
import { AcceptancePanel } from "./acceptance-panel";
import { StatusBadge, statusVisual, TONE_ICON } from "./status";
import { MessageResponse } from "@/components/ai-elements/message";
import { ToolStepRow } from "@/components/session/tool-step";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { shortId } from "@/lib/format";

// The agent-view drawer — a native shadcn Sheet that slides in from the right
// when an operator card is clicked. Overview foregrounds the VERIFY critic
// panel (the acceptance evidence); the Transcript tab is a picker across the
// operator + its fanned-out sub-agents + its critics, rendered from the derived
// roster via the shared session-style ToolStepRow. Where a roster entry's
// transcript is NOT available in today's data, it says so plainly rather than
// fabricating a stream.

// A small muted section label, matching the session view's tone.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview helpers.
// ---------------------------------------------------------------------------

// The one-line "what's happening now" copy. needs-review and blocked share the
// "block" pill but read differently and truthfully: couldn't-prove vs. a real
// parked question — never claim a decision-question when there is none.
function nowLine(op: Operator): string {
  switch (op.status.kind) {
    case "done":
      return "Done — verified against its story and promoted.";
    case "block":
      return op.state === "needs-review"
        ? "Couldn't independently verify this — no executable check ran to prove it. Review the deliverable, then accept it (an override), steer it, or send it back from the panel."
        : "Paused on a decision the orchestrator won't guess — answer it from the panel to resume. The rest of the weave keeps running around it.";
    case "repair":
      // A terminal failed/halted Thread also wears the "repair" pill, but it is
      // NOT reworking — it dead-ended. Only a live retry is actually reworking.
      // `failed` is owner-actionable (the panel below offers Resume / Send back);
      // `halted` is a stopped thread with NO panel action, so don't promise one.
      if (op.state === "failed")
        return "Dead-ended — the loop couldn't land this thread. Resume it to retry as-is, or send it back with feedback from the panel below.";
      if (op.state === "halted")
        return "Stopped — this thread was halted and isn't running. There's no action to take on it here.";
      return "Builder resumed with the failing criterion + a repro. Reworking against the contract.";
    case "verify":
      return op.state === "ready"
        ? "Verified by an independent panel — awaiting your acceptance."
        : "Verifying — the critic panel is driving the live product.";
    case "run": {
      const live = op.subAgents.filter((s) => !s.done).length;
      return live > 0
        ? `${live} builder${live === 1 ? "" : "s"} weaving in parallel — isolated worktrees, merged on green.`
        : "Building against the spec.";
    }
    default:
      return "Scheduled — not started yet.";
  }
}

function MiniStage({ step, fanCount }: { step: Step; fanCount: number }) {
  const { state } = step;
  const label =
    step.name === "Build" && state === "active" && fanCount > 0
      ? `Build ×${fanCount}`
      : step.name;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px]",
        state === "failed"
          ? "text-destructive"
          : state === "active"
            ? "text-foreground"
            : state === "done"
              ? "text-muted-foreground"
              : "text-muted-foreground/60",
      )}
    >
      {state === "done" && <Check className="size-3 text-emerald-600 dark:text-emerald-400" />}
      {state === "active" && <Loader2 className="size-3 animate-spin" />}
      {state === "failed" && <CircleX className="size-3 text-destructive" />}
      {label}
    </span>
  );
}

function evidenceCount(critic: CriticVerdict): number {
  const all: Evidence[] = [
    ...(critic.evidence ?? []),
    ...critic.findings.flatMap((f) => f.evidence ?? []),
  ];
  return all.length;
}

function CriticCard({
  critic,
  index,
  onGoto,
}: {
  critic: CriticVerdict;
  index: number;
  onGoto: (key: string) => void;
}) {
  const evN = evidenceCount(critic);
  const key = `critic-${index}`;
  return (
    <button
      type="button"
      onClick={() => onGoto(key)}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg border p-3 text-left text-xs transition-colors hover:bg-muted/40",
        critic.ok ? "border-border" : "border-destructive/40 bg-destructive/[0.04]",
      )}
    >
      <div className="flex items-center gap-1.5">
        {critic.ok ? (
          <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <CircleX className="size-3.5 text-destructive" />
        )}
        <span className="font-medium text-foreground">{critic.lens}</span>
        <Badge
          variant={critic.blocker ? "destructive" : "secondary"}
          className="ml-auto text-[10px]"
        >
          {critic.blocker ? "blocker" : "soft"}
        </Badge>
      </div>
      <p className="text-muted-foreground">{critic.summary}</p>
      {critic.findings.map((f, i) => (
        <p key={i} className="text-muted-foreground/90">
          <span className="font-mono text-[10px] text-muted-foreground/70">{f.severity}</span> ·{" "}
          {f.title}
          {f.detail ? ` — ${f.detail}` : ""}
        </p>
      ))}
      {evN > 0 && (
        <span className="text-[10px] text-muted-foreground/70">
          {evN} evidence artifact{evN === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}

function VerifyPanel({ op, onGoto }: { op: Operator; onGoto: (key: string) => void }) {
  const verifyActive = op.steps.some((s) => s.name === "Verify" && s.state === "active");
  const notBuilt = !op.steps.some((s) => s.name === "Build");

  if (op.critics.length === 0) {
    if (verifyActive) {
      return (
        <div className="flex flex-col gap-2">
          <SectionLabel>
            <FlaskConical className="size-3.5" />
            Verify · the critic panel
          </SectionLabel>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Verify is running — the critic panel is driving the live product.
          </p>
        </div>
      );
    }
    if (notBuilt) {
      return (
        <div className="flex flex-col gap-2">
          <SectionLabel>
            <FlaskConical className="size-3.5" />
            Verify · the critic panel
          </SectionLabel>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            Verify runs once this operator builds green. The panel will drive the live product.
          </p>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>
        <FlaskConical className="size-3.5" />
        Verify · the critic panel — drives the live product
      </SectionLabel>
      {op.url && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Play className="size-3.5" />
          Playwright drove <span className="font-mono text-[11px]">{op.url}</span>
        </p>
      )}
      <div className="flex flex-col gap-2">
        {op.critics.map((c, i) => (
          <CriticCard key={i} critic={c} index={i} onGoto={onGoto} />
        ))}
      </div>
    </div>
  );
}

// WHY it stalled, in destructive tint — the loom's own error line as the
// headline, then the specific blockers (red gates, must-clear critic lenses,
// the builder verdict's blocker). Shown for a failed (dead-ended) or a
// needs-review (couldn't-prove) Thread; null when there's nothing to explain.
function FailureReason({ op }: { op: Operator }) {
  if (op.state !== "failed" && op.state !== "needs-review") return null;
  const { gates, critics, verdictBlocker } = op.failing;
  const hasDetail = gates.length > 0 || critics.length > 0 || !!verdictBlocker;
  if (!op.error && !hasDetail) return null;
  const headline =
    op.error ?? (op.state === "failed" ? "This thread failed." : "Couldn't be independently verified.");

  return (
    <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/[0.05] px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <CircleX className="size-3.5 shrink-0 text-destructive" />
        <span className="text-xs font-medium tracking-wide text-destructive uppercase">
          {op.state === "failed" ? "Failure reason" : "Why it can't be verified"}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-foreground/80">{headline}</p>
      {hasDetail && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {gates.map((name) => (
            <li key={`gate-${name}`} className="flex items-start gap-1.5">
              <CircleX className="mt-0.5 size-3 shrink-0 text-destructive" />
              <span>
                gate <span className="font-mono text-[11px] text-foreground/70">{name}</span> failed
              </span>
            </li>
          ))}
          {critics.map((lens) => (
            <li key={`critic-${lens}`} className="flex items-start gap-1.5">
              <CircleX className="mt-0.5 size-3 shrink-0 text-destructive" />
              <span>
                blocker lens{" "}
                <span className="font-mono text-[11px] text-foreground/70">{lens}</span> did not clear
              </span>
            </li>
          ))}
          {verdictBlocker && (
            <li className="flex items-start gap-1.5">
              <CircleAlert className="mt-0.5 size-3 shrink-0 text-destructive" />
              <span>builder flagged: {verdictBlocker}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function Overview({
  op,
  loom,
  onIntervened,
  onGoto,
}: {
  op: Operator;
  // The raw loom behind this operator — passed so the intervention panel can act
  // on the Thread (accept/steer/reject/resume). Optional/absent for a stale
  // cached view; the panel self-gates on loom.state and renders nothing until an
  // owner-actionable state.
  loom?: Loom | null;
  onIntervened?: () => void;
  onGoto: (key: string) => void;
}) {
  const kind = op.status.kind;
  const nv = statusVisual(kind, op.state, op.active);

  return (
    <div className="flex flex-col gap-4">
      <FailureReason op={op} />

      {op.summary && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Summary</SectionLabel>
          <div className="text-sm leading-relaxed">
            <MessageResponse>{op.summary}</MessageResponse>
          </div>
        </div>
      )}

      {op.steps.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Steps so far</SectionLabel>
          <div className="flex flex-wrap items-center gap-1">
            {op.steps.map((s, i) => (
              <MiniStage key={`${s.name}-${i}`} step={s} fanCount={op.subAgents.length} />
            ))}
          </div>
        </div>
      )}

      {op.repairs > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RotateCcw className="size-3.5 text-destructive" />
          verify failed, rebuilt · repair loop (bounded), attempt {op.repairs + 1}
        </p>
      )}

      <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
        {nv.spinning ? (
          <Loader2 className={cn("mt-0.5 size-3.5 shrink-0 animate-spin", TONE_ICON.active)} />
        ) : (
          <nv.Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE_ICON[nv.tone])} />
        )}
        <span className="text-foreground/80">{nowLine(op)}</span>
      </div>

      {op.subAgents.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>
            Fanned-out agents · {op.subAgents.length}
            <span className="font-normal text-muted-foreground/60">— select for a transcript</span>
          </SectionLabel>
          <div className="flex flex-col gap-1.5">
            {op.subAgents.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onGoto(s.id)}
                className="flex items-start gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40"
              >
                {s.done ? (
                  <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {s.done ? "merged" : "live"}
                    </span>
                  </div>
                  <span className="truncate text-muted-foreground">{s.now}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The owner's move on THIS Thread — accept/steer/reject/resume, wired to
          /api/looms/<childId>/…. Self-gates on loom.state, so it renders only in
          an owner-actionable state (ready/needs-review/blocked/failed) and is
          null otherwise. Replaces the old disabled "Take over in chat" stub. */}
      {loom && <AcceptancePanel loom={loom} onAccepted={onIntervened} />}

      {op.files.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Files touched</SectionLabel>
          <div className="flex flex-col gap-1">
            {op.files.map((f, i) => (
              <div
                key={`${f.path}-${i}`}
                className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"
              >
                {f.op === "add" ? (
                  <FilePlus className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <FilePen className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{f.path}</span>
                {f.stat && <span className="shrink-0 text-muted-foreground/60">{f.stat}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <VerifyPanel op={op} onGoto={onGoto} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript tab.
// ---------------------------------------------------------------------------

export function ScriptEntry({
  e,
  open,
  onToggle,
}: {
  e: TranscriptEntry;
  open: boolean;
  onToggle: () => void;
}) {
  switch (e.k) {
    case "say":
      // Assistant prose through the same markdown renderer the session chat
      // uses — readable, not a mono blob.
      return (
        <div className="text-sm leading-relaxed">
          <MessageResponse>{e.text}</MessageResponse>
        </div>
      );
    case "tool":
      // The shared session-style collapsible tool row.
      return (
        <ToolStepRow
          part={{
            type: "tool",
            name: e.name,
            input: e.input,
            output: e.output,
            isError: e.isError,
          }}
          running={false}
          open={open}
          onToggle={onToggle}
        />
      );
    case "pw":
      return (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Play className="size-3.5 shrink-0" />
          {e.text}
        </p>
      );
    case "res":
      return (
        <p className="flex items-center gap-1.5 text-xs">
          {e.ok ? (
            <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <CircleX className="size-3.5 shrink-0 text-destructive" />
          )}
          <span className="text-muted-foreground">{e.text}</span>
        </p>
      );
    case "note":
      return (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <RotateCcw className="mt-0.5 size-3.5 shrink-0" />
          {e.text}
        </p>
      );
    case "verdict":
      // PASS/FAIL badge on top, the builder summary rendered as markdown prose
      // below (same renderer as `say`) — not a raw one-liner. Badge-only when
      // there's no summary text.
      return (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-md border px-3 py-2.5 leading-relaxed",
            e.ok
              ? "border-emerald-500/30 bg-emerald-500/[0.05]"
              : "border-destructive/40 bg-destructive/[0.05]",
          )}
        >
          <div className="flex items-center gap-1.5 text-xs">
            {e.ok ? (
              <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CircleX className="size-3.5 shrink-0 text-destructive" />
            )}
            <span
              className={cn(
                "font-medium",
                e.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
              )}
            >
              {e.ok ? "PASS" : "FAIL"}
            </span>
          </div>
          {e.text && (
            <div className="text-sm leading-relaxed">
              <MessageResponse>{e.text}</MessageResponse>
            </div>
          )}
        </div>
      );
    case "meta":
      return <p className="text-[11px] text-muted-foreground/70">{e.text}</p>;
    default:
      return null;
  }
}

// The Agent-SDK session id for an agent lane (operator / fan-out piece),
// shown short with a click-to-copy affordance. Identity only — read-only, no
// resume path (loom-level resume lives in the AcceptancePanel; there is no
// per-session resume endpoint, so we surface the id honestly, nothing more).
function SessionIdChip({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(sessionId).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title={`Copy session id ${sessionId}`}
      className="inline-flex items-center gap-1 rounded font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      session {shortId(sessionId)}
      {copied ? (
        <Check className="size-3 text-emerald-500" />
      ) : (
        <Copy className="size-3 opacity-60" />
      )}
    </button>
  );
}

// Compact identity header above a transcript body: the agent's role, its
// session id (when captured), and — for a fan-out piece — a live/merged badge.
// Honest by omission: no chip when a lane has no session id (critics never do).
function AgentHeader({ entry }: { entry: RosterEntry }) {
  const isCritic = entry.role === "critic";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-medium">
        {isCritic ? <FlaskConical className="size-3" /> : <Play className="size-3" />}
        {isCritic ? "critic" : "builder"}
      </span>
      {entry.sessionId && <SessionIdChip sessionId={entry.sessionId} />}
      {!isCritic && (
        <Badge variant="secondary" className="text-[10px]">
          {entry.done === true ? "merged" : "live"}
        </Badge>
      )}
    </div>
  );
}

function TranscriptBody({ entry }: { entry: RosterEntry }) {
  // Per-row expand state, keyed by entry index — lifted here (not inside
  // ToolStepRow) since the row is a controlled component; reset on remount
  // when the picker switches (see the key on TranscriptBody below).
  const [openRows, setOpenRows] = useState<Record<number, boolean>>({});
  if (!entry.transcript.available) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Clock className="mt-0.5 size-3.5 shrink-0" />
        Transcript not captured yet — {entry.transcript.reason}
      </p>
    );
  }
  if (entry.transcript.entries.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" />
        No steps recorded on this session yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {entry.transcript.entries.map((e, i) => (
        <ScriptEntry
          key={i}
          e={e}
          open={!!openRows[i]}
          onToggle={() => setOpenRows((o) => ({ ...o, [i]: !o[i] }))}
        />
      ))}
    </div>
  );
}

function Transcript({
  op,
  selected,
  onSelect,
}: {
  op: Operator;
  selected: string;
  onSelect: (key: string) => void;
}) {
  if (op.roster.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" />
        This operator hasn&apos;t started — no transcript yet.
      </p>
    );
  }
  const active = op.roster.find((r) => r.key === selected) ?? op.roster[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {op.roster.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onSelect(r.key)}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors",
              r.key === active.key
                ? "border-border bg-muted font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted/60",
            )}
          >
            {r.role === "critic" && <FlaskConical className="size-3" />}
            {r.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-[11px] text-muted-foreground/70">
          {active.role === "critic"
            ? "read-only critic · different account · no Write/Edit/Bash"
            : "builder · Write · Edit · Bash · resumable session"}
        </p>
        {active.sessionId && <SessionIdChip sessionId={active.sessionId} />}
      </div>
      <Separator />
      {/* Per-agent identity header — role, session id, live/merged. */}
      <AgentHeader entry={active} />
      {/* key on the roster entry so per-row expand state resets when the
          picker switches to a different agent's transcript. */}
      <TranscriptBody key={active.key} entry={active} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The drawer.
// ---------------------------------------------------------------------------

export function AgentViewDrawer({
  operator,
  loom,
  onIntervened,
  onClose,
}: {
  operator: Operator | null;
  // The RAW loom behind the open operator (root for a single loom, else the
  // child Thread) — powers the in-drawer intervention panel. onIntervened fires
  // after an accept/steer/reject/resume so the page re-polls the Threads.
  loom?: Loom | null;
  onIntervened?: () => void;
  onClose: () => void;
}) {
  const open = operator !== null;
  const [tab, setTab] = useState<"overview" | "transcript">("overview");
  const [agentKey, setAgentKey] = useState("op");

  // Cache the last non-null operator so content stays put during the close.
  const cacheRef = useRef<Operator | null>(operator);
  if (operator) cacheRef.current = operator;
  const op = operator ?? cacheRef.current;

  // Cache the loom in step with the operator so the intervention panel doesn't
  // flash away mid-close (openLoom goes null the instant the drawer closes).
  const loomCacheRef = useRef<Loom | null>(loom ?? null);
  if (loom) loomCacheRef.current = loom;
  const drawerLoom = loom ?? loomCacheRef.current;

  // Reset tab/selection whenever a different operator opens.
  const openedId = operator?.id;
  useEffect(() => {
    if (openedId) {
      setTab("overview");
      setAgentKey("op");
    }
  }, [openedId]);

  const goto = (key: string) => {
    setAgentKey(key);
    setTab("transcript");
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent side="right" className="w-full gap-0 p-0 data-[side=right]:sm:max-w-xl">
        {op && (
          <>
            <SheetHeader className="border-b">
              <div className="flex items-center gap-2 pr-8">
                <div className="flex min-w-0 flex-col">
                  <SheetTitle className="truncate">{op.name}</SheetTitle>
                  <SheetDescription className="font-mono text-[11px]">
                    operator {shortId(op.id)} ·{" "}
                    {op.subAgents.length > 0 ? `fan-out ×${op.subAgents.length}` : "atomic"}
                  </SheetDescription>
                </div>
                <StatusBadge
                  kind={op.status.kind}
                  state={op.state}
                  active={op.active}
                  label={op.status.label}
                  className="ml-auto"
                />
              </div>
            </SheetHeader>

            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "overview" | "transcript")}
              className="min-h-0 flex-1 gap-0"
            >
              <div className="px-4 pt-3">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="transcript">Transcript</TabsTrigger>
                </TabsList>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-4">
                  <TabsContent value="overview">
                    <Overview
                      op={op}
                      loom={drawerLoom}
                      onIntervened={onIntervened}
                      onGoto={goto}
                    />
                  </TabsContent>
                  <TabsContent value="transcript">
                    <Transcript op={op} selected={agentKey} onSelect={setAgentKey} />
                  </TabsContent>
                </div>
              </ScrollArea>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
