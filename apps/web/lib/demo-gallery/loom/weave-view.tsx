"use client";

// LANE: loom — "Weave view: anchor + rail". A high-fidelity React port of the
// approved anchor+rail god-view mockup (scratchpad/anchor-rail-spec.html),
// re-skinned onto the app's native shadcn language — bg-card / border-border /
// text-muted-foreground, the production StatusBadge — rather than the
// mockup's raw scoped CSS, so it reads native to the dark shell (same posture
// as ./god-view.tsx's re-skin comment).
//
// Layout: a left RAIL of compact thread lanes (status dot, name, one-line
// current activity — the orchestrator is its OWN pinned lane, not a thread)
// and a main ANCHOR showing the focused item's full cockpit. The orchestrator
// is focused by default: its tick line (plan → schedule → observe → decide),
// its escalation state, and its recent-decisions log. Clicking a thread lane
// swaps the anchor to that thread's own detail + an inline mini-feed of
// events — the one state the static mockup didn't render, built here to match
// the same visual grammar (see the file header for what was invented vs.
// ported verbatim).
import { useState, type ReactNode } from "react";
import {
  Bot,
  CalendarClock,
  Check,
  CircleAlert,
  CircleCheck,
  CirclePlus,
  CircleX,
  Clock,
  MessageSquare,
  Play,
  RotateCcw,
  SendHorizontal,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/looms/status";
import { cn } from "@/lib/utils";
import { NowLine } from "./ui";
import {
  BANNER_MOAT,
  BANNER_TEXT,
  ESCALATION_TEXT,
  ORCH_PHASE,
  ORCH_SUBTITLE,
  ORCHESTRATOR_DECISIONS,
  TICK_STAGES,
  VERIFY_ASSERTIONS,
  WEAVE_CHAT_TURNS,
  WEAVE_ELAPSED,
  WEAVE_ID,
  WEAVE_SPEND_USD,
  WEAVE_STATE_LABEL,
  WEAVE_THREADS,
  WEAVE_TITLE,
  WEAVE_TITLE_SUB,
  threadFixtureById,
  type ChatTurn,
  type TickStage,
  type VerifyAssertion,
  type VerifyAssertionState,
  type VerifyAssertionType,
  type WeaveDecision,
  type WeaveDecisionKind,
  type WeaveEvent,
  type WeaveEventKind,
  type WeaveThreadFixture,
} from "./weave-view-fixtures";

const ORCHESTRATOR_ID = "orchestrator";

// `` `code` `` spans (fixture convention, see weave-view-fixtures.ts) render as
// inline mono chips — the mockup's tlw-mono treatment for a subgoal id.
function renderInline(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground/90">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
const stripCode = (text: string) => text.replace(/`/g, "");

// ---------------------------------------------------------------------------
// Small shared primitives.
// ---------------------------------------------------------------------------

function Dot({ tone }: { tone: "amber" | "idle" }) {
  return (
    <span
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        tone === "amber"
          ? "animate-pulse bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]"
          : "bg-muted-foreground/50",
      )}
    />
  );
}

function PhaseChip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground">
      {children}
    </span>
  );
}

// A rail lane — the orchestrator's pinned lane or one thread lane. `focused`
// draws the mockup's inset accent bar as a thin absolute rule instead of a
// box-shadow trick, so it composes cleanly with the border/ring the rest of
// the app already uses for focus state.
function LaneButton({
  focused,
  onClick,
  children,
}: {
  focused: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={focused}
      className={cn(
        "relative flex w-full flex-col rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors hover:border-border/80 hover:bg-muted/40",
        focused && "border-border/80 bg-muted/50",
      )}
    >
      {focused && <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-lg bg-foreground/70" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator anchor: tick stepper + escalation callout + decisions log.
// ---------------------------------------------------------------------------

function TickStepper({ stages }: { stages: TickStage[] }) {
  return (
    <div className="flex items-center overflow-x-auto rounded-xl border border-border bg-card px-4 py-3.5">
      {stages.map((s, i) => (
        <div key={s.name} className="flex items-center">
          <div className="flex flex-col items-center gap-1.5">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px]",
                s.state === "done" && "border-muted-foreground/60 text-muted-foreground",
                s.state === "active" && "border-foreground bg-foreground/10 text-foreground",
                s.state === "idle" && "border-border text-muted-foreground/40",
              )}
            >
              {s.state === "done" ? (
                <Check className="size-3" />
              ) : s.state === "active" ? (
                <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
              ) : null}
            </span>
            <span
              className={cn(
                "text-[11px]",
                s.state === "active" ? "font-semibold text-foreground" : "text-muted-foreground/70",
              )}
            >
              {s.name}
            </span>
          </div>
          {i < stages.length - 1 && (
            <span
              className={cn(
                "mx-1.5 mb-5 h-px w-10 shrink-0 sm:w-16",
                s.state === "done" ? "bg-muted-foreground/50" : "bg-border",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

const DECISION_ICON: Record<WeaveDecisionKind, { Icon: LucideIcon; className: string }> = {
  ok: { Icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400 border-emerald-500/35" },
  fail: { Icon: CircleX, className: "text-destructive border-destructive/35" },
  block: { Icon: CircleAlert, className: "text-amber-600 dark:text-amber-400 border-amber-500/40" },
  mediate: { Icon: RotateCcw, className: "text-amber-600 dark:text-amber-400 border-amber-500/40" },
  hold: { Icon: Clock, className: "text-muted-foreground border-border" },
  spawn: { Icon: CirclePlus, className: "text-foreground border-foreground/30" },
  schedule: { Icon: CalendarClock, className: "text-muted-foreground border-border" },
};

const EVENT_ICON: Record<WeaveEventKind, { Icon: LucideIcon; className: string }> = {
  plan: { Icon: CirclePlus, className: "text-foreground border-foreground/30" },
  info: { Icon: Clock, className: "text-muted-foreground border-border" },
};

// Shared row visual for both the orchestrator's decision log and a thread's
// mini-feed — same rail-and-node grammar as loom/ui.tsx's StepTimeline /
// MediationLadder, just with a per-kind icon instead of a fixed state enum.
function FeedRow({
  Icon,
  iconClassName,
  text,
  emph,
  last,
}: {
  Icon: LucideIcon;
  iconClassName: string;
  text: string;
  emph?: boolean;
  last: boolean;
}) {
  return (
    <li className="flex gap-2.5">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-[18px] shrink-0 items-center justify-center rounded-full border bg-card",
            iconClassName,
          )}
        >
          <Icon className="size-2.5" />
        </span>
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-3.5")}>
        <p className={cn("text-xs leading-relaxed", emph ? "font-medium text-foreground" : "text-muted-foreground")}>
          {renderInline(text)}
        </p>
      </div>
    </li>
  );
}

function AnchorOrchestrator() {
  return (
    <div className="flex flex-1 flex-col gap-4 px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <Workflow className="size-[18px]" />
          </span>
          <div className="flex flex-col">
            <span className="text-[15px] font-semibold tracking-tight">Orchestrator</span>
            <span className="font-mono text-xs text-muted-foreground">{ORCH_SUBTITLE}</span>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground/10 px-2.5 py-1 font-mono text-[11.5px] font-semibold text-foreground">
          <span className="size-[5px] animate-pulse rounded-full bg-foreground" />
          {ORCH_PHASE}
        </span>
      </div>

      <TickStepper stages={TICK_STAGES} />

      <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 border-l-2 border-l-amber-500 bg-amber-500/[0.06] px-3.5 py-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">
            Escalation state
          </span>
          <p className="text-[12.5px] leading-relaxed text-foreground">{renderInline(ESCALATION_TEXT)}</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-col">
        <div className="mb-2.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Recent decisions{" "}
          <span className="font-normal normal-case text-muted-foreground/70">
            · {ORCHESTRATOR_DECISIONS.length}
          </span>
        </div>
        <ol className="max-h-[380px] overflow-y-auto pr-1">
          {ORCHESTRATOR_DECISIONS.map((d: WeaveDecision, i) => {
            const meta = DECISION_ICON[d.kind];
            return (
              <FeedRow
                key={i}
                Icon={meta.Icon}
                iconClassName={meta.className}
                text={d.text}
                emph={d.emph}
                last={i === ORCHESTRATOR_DECISIONS.length - 1}
              />
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread anchor — NOT in the static mockup (which only showed the
// orchestrator focused). Built to the same visual grammar: identity header +
// status, objective, a NowLine (reused from ./ui.tsx), and an inline
// mini-feed of this thread's own events.
// ---------------------------------------------------------------------------

function AnchorThread({ thread }: { thread: WeaveThreadFixture }) {
  return (
    <div className="flex flex-1 flex-col gap-4 px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <Play className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-[15px] leading-snug font-semibold tracking-tight">{thread.title}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {thread.agentRole} · {thread.subGoalId}
            </span>
          </div>
        </div>
        <StatusBadge
          kind={thread.statusKind}
          state={thread.state}
          active={thread.active}
          label={thread.statusLabel}
          className="shrink-0"
        />
      </div>

      <p className="text-sm leading-relaxed text-foreground/90">{thread.objective}</p>

      <NowLine icon={Clock}>{thread.now}</NowLine>

      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2.5">
        <Bot className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          Assigned — 1 {thread.agentRole} agent, not started yet
        </span>
      </div>

      <div className="flex flex-col">
        <div className="mb-2.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Thread feed{" "}
          <span className="font-normal normal-case text-muted-foreground/70">· {thread.events.length}</span>
        </div>
        <ol>
          {thread.events.map((e: WeaveEvent, i) => {
            const meta = EVENT_ICON[e.kind];
            return (
              <FeedRow
                key={i}
                Icon={meta.Icon}
                iconClassName={meta.className}
                text={e.text}
                last={i === thread.events.length - 1}
              />
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verify tab — owner decision: VERIFY is its own full tab, not a rail item.
// The verification cockpit: the moat sentence, a contract summary chip, then
// the assertion list. Same visual grammar as the production Verify tab
// (components/looms/spec-bundle.tsx's AssertionRow, god-view.tsx's
// OUTCOME_BADGE) re-skinned to this file's mockup-derived idiom rather than
// imported wholesale — this pane has no live evidence/critic panel to render,
// just the contract + settled state.
// ---------------------------------------------------------------------------

const VERIFY_TYPE_LABEL: Record<VerifyAssertionType, string> = {
  command: "command",
  "live-critic": "live critic",
};

const VERIFY_STATE_BADGE: Record<
  VerifyAssertionState,
  { label: string; className: string; Icon: LucideIcon }
> = {
  proven: { label: "proven", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", Icon: CircleCheck },
  failed: { label: "failed", className: "bg-destructive/15 text-destructive", Icon: CircleX },
  pending: { label: "pending", className: "bg-muted text-muted-foreground", Icon: Clock },
};

function ContractChip({ proven, total, failing }: { proven: number; total: number; failing: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2.5 py-1 font-mono text-[11.5px] font-medium text-foreground">
      {proven}/{total} proven
      {failing > 0 && <span className="text-destructive"> · {failing} failing</span>}
    </span>
  );
}

function VerifyAssertionRow({ assertion }: { assertion: VerifyAssertion }) {
  const state = VERIFY_STATE_BADGE[assertion.state];
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-foreground/90">{assertion.id}</span>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {VERIFY_TYPE_LABEL[assertion.type]}
        </Badge>
        <Badge className={cn("ml-auto gap-1 font-mono text-[10px]", state.className)}>
          <state.Icon className="size-3" />
          {state.label}
        </Badge>
      </div>
      <p className="text-[12.5px] leading-relaxed text-foreground/90">{renderInline(assertion.description)}</p>
      {assertion.type === "command" && assertion.command && (
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={assertion.command}>
          {assertion.command}
        </p>
      )}
    </div>
  );
}

function VerifyTabPane() {
  const total = VERIFY_ASSERTIONS.length;
  const proven = VERIFY_ASSERTIONS.filter((a) => a.state === "proven").length;
  const failing = VERIFY_ASSERTIONS.filter((a) => a.state === "failed").length;

  return (
    <div className="flex w-full flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-border bg-muted/20 px-3.5 py-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-[12.5px] leading-relaxed text-foreground/80">{BANNER_MOAT}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Verification contract
        </span>
        <ContractChip proven={proven} total={total} failing={failing} />
      </div>

      <div className="flex flex-col gap-2">
        {VERIFY_ASSERTIONS.map((a) => (
          <VerifyAssertionRow key={a.id} assertion={a} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat tab — owner decision: CHAT is its own full tab, not a rail item. The
// steerer conversation about the same P10-B escalation, plus a visually-real,
// non-functional composer pinned at the bottom (fixture-only — no send path).
// ---------------------------------------------------------------------------

function ChatBubble({ turn }: { turn: ChatTurn }) {
  const isHuman = turn.from === "human";
  return (
    <div className={cn("flex", isHuman ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3.5 py-2.5 text-[12.5px] leading-relaxed",
          isHuman ? "bg-secondary text-foreground" : "bg-muted/40 text-foreground/90",
        )}
      >
        {renderInline(turn.text)}
      </div>
    </div>
  );
}

// Decorative only — mirrors the sticky-footer composer idiom from
// lib/demo-gallery/ultra/session-ultra.tsx (a placeholder line + a send
// affordance, no wired input) since this gallery entry has no live session.
function ChatComposer() {
  return (
    <div className="rounded-xl border border-border bg-background p-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground/70">
          Message the loom…
        </span>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <SendHorizontal className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

function ChatTabPane() {
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-col gap-3 px-5 py-4 sm:px-6">
        {WEAVE_CHAT_TURNS.map((t, i) => (
          <ChatBubble key={i} turn={t} />
        ))}
      </div>
      <div className="border-t border-border bg-card px-3.5 py-3 sm:px-5">
        <ChatComposer />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The frame: topbar + calm banner + rail/anchor body.
// ---------------------------------------------------------------------------

export function WeaveAnchorRailDemo() {
  const [tab, setTab] = useState("weave");
  const [focusedId, setFocusedId] = useState<string>(ORCHESTRATOR_ID);
  const focusedThread = focusedId === ORCHESTRATOR_ID ? null : threadFixtureById(focusedId);
  const verifyFailing = VERIFY_ASSERTIONS.some((a) => a.state === "failed");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6">
      {/* slim tab strip — owner decision: the anchor+rail surface replaces the
          old Orchestrator+Threads tabs (now folded into the Weave tab below),
          but Verify and Chat stay their own full tabs, same idiom as
          components/looms/god-view.tsx's TabsList variant="line". */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          <TabsTrigger value="weave">
            <Workflow />
            Weave
          </TabsTrigger>
          <TabsTrigger value="verify">
            <ShieldCheck />
            Verify
            {verifyFailing && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-destructive"
                title="1 assertion failing"
                aria-hidden
              />
            )}
          </TabsTrigger>
          <TabsTrigger value="chat">
            <MessageSquare />
            Chat
          </TabsTrigger>
        </TabsList>

        <TabsContent value="weave" className="pt-3">
          <div className="w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            {/* top bar: loom identity + health stats */}
            <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-3.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                  <Workflow className="size-[15px]" />
                </span>
                <div className="flex min-w-0 flex-col">
                  <div className="truncate text-[13.5px] font-semibold tracking-tight">
                    {WEAVE_TITLE} <span className="font-normal text-muted-foreground">{WEAVE_TITLE_SUB}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="font-mono">{WEAVE_ID}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="flex items-center gap-1.5 text-foreground">
                      <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                      {WEAVE_STATE_LABEL}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-5">
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[9.5px] font-medium tracking-wide text-muted-foreground uppercase">
                    Spend
                  </span>
                  <span className="font-mono text-[12.5px] font-semibold">${WEAVE_SPEND_USD.toFixed(2)}</span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[9.5px] font-medium tracking-wide text-muted-foreground uppercase">
                    Elapsed
                  </span>
                  <span className="font-mono text-[12.5px] font-semibold">{WEAVE_ELAPSED}</span>
                </div>
              </div>
            </header>

            {/* calm health banner */}
            <div className="flex flex-col gap-0.5 border-b border-border bg-gradient-to-b from-emerald-500/[0.05] to-transparent px-5 py-2.5">
              <div className="flex items-center gap-1.5">
                <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="text-[12.5px] font-medium">{BANNER_TEXT}</span>
              </div>
              <span className="pl-5 text-[11px] text-muted-foreground">{BANNER_MOAT}</span>
            </div>

            {/* body: rail + anchor */}
            <div className="flex items-stretch">
              <aside className="flex w-72 shrink-0 flex-col gap-1.5 border-r border-border p-3">
                <span className="px-1.5 pt-0.5 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Orchestrator
                </span>
                <LaneButton focused={focusedId === ORCHESTRATOR_ID} onClick={() => setFocusedId(ORCHESTRATOR_ID)}>
                  <div className="flex items-center gap-1.5">
                    <Dot tone="amber" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">Orchestrator</span>
                    <PhaseChip>{ORCH_PHASE}</PhaseChip>
                  </div>
                  <span className="mt-1 font-mono text-[10.5px] text-muted-foreground/70">{ORCH_SUBTITLE}</span>
                  <span
                    className="mt-1 block truncate text-[11px] text-amber-600 dark:text-amber-400"
                    title={stripCode(ESCALATION_TEXT)}
                  >
                    {stripCode(ESCALATION_TEXT)}
                  </span>
                </LaneButton>

                <span className="mt-2.5 px-1.5 pt-0.5 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Threads{" "}
                  <span className="font-normal normal-case text-muted-foreground/70">
                    · {WEAVE_THREADS.length}
                  </span>
                </span>
                {WEAVE_THREADS.map((t) => (
                  <LaneButton key={t.id} focused={focusedId === t.id} onClick={() => setFocusedId(t.id)}>
                    <div className="flex items-center gap-1.5">
                      <Dot tone="idle" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={t.title}>
                        {t.title}
                      </span>
                      <StatusBadge
                        kind={t.statusKind}
                        state={t.state}
                        active={t.active}
                        label={t.statusLabel}
                        className="shrink-0"
                      />
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      {t.railId && (
                        <span className="font-mono text-[10px] text-muted-foreground/60">{t.railId}</span>
                      )}
                      <span className="ml-auto flex items-center gap-1 text-[10.5px] text-muted-foreground">
                        <Bot className="size-3 text-muted-foreground/70" />
                        {t.agentRole}
                      </span>
                    </div>
                  </LaneButton>
                ))}
              </aside>

              <main className="min-w-0 flex-1">
                {focusedThread ? <AnchorThread thread={focusedThread} /> : <AnchorOrchestrator />}
              </main>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="verify" className="pt-3">
          <VerifyTabPane />
        </TabsContent>

        <TabsContent value="chat" className="pt-3">
          <ChatTabPane />
        </TabsContent>
      </Tabs>
    </div>
  );
}
