"use client";

// LANE: loom-detail (UX brainstorm 2026-07-23) — human-facing sessions in
// the loom, all embedded in the final walkable design. One chat idiom serves
// every moment a loom talks to a human: the INTAKE session that runs Prepare
// (drift report → steering edits → readiness → the gate as the
// conversation's last message), the always-open STEERING thread, and the
// LIVE ESCALATION (parked question whose composer is the resume button).
import {
  ArrowUpIcon,
  CheckIcon,
  CircleAlertIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

function You({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <div className="flex items-end justify-end gap-2">
      <span className="pb-1 font-mono text-[9px] text-muted-foreground/40">{t}</span>
      <div className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-sm bg-muted px-4 py-2.5 text-sm leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function Agent({
  who,
  t,
  children,
}: {
  who: string;
  t: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <SparklesIcon className="size-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] font-medium text-foreground/80">{who}</span>
          <span className="font-mono text-[9px] text-muted-foreground/40">{t}</span>
        </div>
        <div className="mt-1 space-y-3 text-sm leading-relaxed text-foreground/90">
          {children}
        </div>
      </div>
    </div>
  );
}

function Tool({ call, result }: { call: string; result: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pl-9">
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
        <WrenchIcon className="size-3" />
        {call}
        <CheckIcon className="size-3 text-muted-foreground/60" />
      </span>
      <span className="font-mono text-[10px] text-muted-foreground/60">{result}</span>
    </div>
  );
}

function Marker({ text, attention }: { text: string; attention?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-border" />
      <span
        className={cn(
          "flex max-w-[80%] items-center gap-1.5 rounded-full border border-dashed px-2.5 py-0.5 text-center font-mono text-[9px]",
          attention
            ? "border-amber-600/40 text-amber-600 dark:text-amber-400"
            : "border-border text-muted-foreground",
        )}
      >
        {attention && <CircleAlertIcon className="size-3" />}
        {text}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Chips({ options }: { options: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 pl-9">
      {options.map((o) => (
        <span
          key={o}
          className="inline-flex cursor-default items-center rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
        >
          {o}
        </span>
      ))}
    </div>
  );
}

function Composer({ placeholder }: { placeholder: string }) {
  return (
    <div className="shrink-0 border-t border-border px-6 py-4">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5">
        <span className="flex-1 text-sm text-muted-foreground/60">{placeholder}</span>
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <ArrowUpIcon className="size-4" />
        </span>
      </div>
    </div>
  );
}

// The gate, as the conversation's last message — the accept moment lives
// where the conversation happened, stamped once taken.
function GateCard() {
  return (
    <div className="ml-9 rounded-xl border border-foreground/25 bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Readiness gate
      </p>
      <p className="mt-1.5 text-sm text-foreground/90">
        8 subgoals · 2 lanes · recipe proven · all planning artifacts attached.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span className="flex cursor-default items-center gap-1.5 rounded-md border border-foreground/20 bg-foreground px-3 py-1.5 text-xs text-background">
          <CheckIcon className="size-3.5" /> Accept plan
        </span>
        <span className="cursor-default rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
          Modify
        </span>
        <span className="cursor-default rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
          Deny — go direct to dev
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
          accepted 07:24
        </span>
      </div>
    </div>
  );
}

// ---- Moment 1: the intake session — the conversation that IS Prepare.
export function IntakeSessionBody() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-6 py-6">
          <You t="07:15">
            Clients need to log in, see only their own campaigns, and reach checkout with
            seeded access.
          </You>

          <Tool call="map · diff intent against regions" result="drift in 2 of 6" />

          <Agent who="intake" t="07:16">
            <p>
              Two regions drift: <span className="font-mono text-xs">surfaces</span>{" "}
              (there is no client-facing nav) and{" "}
              <span className="font-mono text-xs">verification norms</span> (no
              client-role e2e path). Objective and architecture are current. Spawning
              context gathering and UX/feel; the PRD is fresh, so no node.
            </p>
          </Agent>

          <Marker text="nodes spawned: context-gathering · ux-feel — prd skipped, no drift" />

          <Agent who="intake" t="07:18">
            <p>
              Context gathering is back: 9 files touch roles and auth, session claims
              already carry a role field. Draft plan: 7 subgoals in 2 lanes, seeding
              folded into the schema node.
            </p>
          </Agent>

          <You t="07:21">
            Split seeding out of schema — I want the seed script reusable for demos. And
            add a runbook node.
          </You>

          <Marker text="graph edited by you · 2 changes · 07:22" />

          <Agent who="intake" t="07:22">
            <p>
              Done — 8 subgoals, 2 lanes, graph locked. Verification readiness is
              standing the lab up now.
            </p>
          </Agent>

          <Tool call="verification-readiness · next-dev+postgres" result="green in 41s" />

          <GateCard />
        </div>
      </div>
      <Composer placeholder="Steer the preparation…" />
    </div>
  );
}

// ---- The steering thread: the always-open line to the conductor. Turns are
// loom-specific; an empty list with a note renders a closed-but-reopenable
// conversation.
export type SteerTurn = { from: "you" | "agent"; who?: string; t: string; text: string };

export function SteeringSessionBody({
  turns,
  note,
  placeholder,
}: {
  turns: SteerTurn[];
  note?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-6 py-6">
          {note && <Marker text={note} />}
          {turns.map((turn, i) =>
            turn.from === "you" ? (
              <You key={i} t={turn.t}>
                {turn.text}
              </You>
            ) : (
              <Agent key={i} who={turn.who ?? "orchestrator"} t={turn.t}>
                <p>{turn.text}</p>
              </Agent>
            ),
          )}
        </div>
      </div>
      <Composer placeholder={placeholder ?? "Steer the loom…"} />
    </div>
  );
}


// ---- A LIVE escalation: parked, unanswered — the composer is the resume
// button. Used by the at-scale walkable (tax-adapter, repair exhausted).
export function EscalationSessionBody() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-6 py-6">
          <Marker
            attention
            text="parked 09:21 · repair exhausted (3 of 3) — mediation could not resolve"
          />

          <Agent who="orchestrator" t="09:21">
            <p>
              tax-adapter failed the same rounding check three times: AUD tax lines come
              out one cent off the golden cases. The golden cases assume round-half-up;
              the synthetic tax tables round half-even. Which is canonical?
            </p>
          </Agent>

          <Tool call="attempt history · rounding check" result="×3 failed · diff 1¢ AUD" />

          <Chips options={["half-up (golden cases)", "half-even (tax tables)"]} />
        </div>
      </div>
      <Composer placeholder="Answer — the loom resumes the moment you send…" />
    </div>
  );
}
