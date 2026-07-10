"use client";

import { useMemo } from "react";
import type { Loom, SubGoal } from "@telar/core";
import type {
  DecisionLogEntry,
  GodStatusKind,
  GodView,
  Operator,
  Orchestrator,
  Step,
} from "./godview";
import { cn } from "@/lib/utils";
import { fmtAgo, shortId } from "@/lib/format";

// The locked mockup (scratchpad/loom-godview-integrated.html) renders one
// unified frame for every non-scoping loom: a compact charter strip, an
// orchestrator bar on top, THE WEAVE (operator thread cards), a right rail
// (decision log + steer), and the moat. All layout classes live under the
// `.godview` scope in globals.css; this component only wires derived data
// (deriveGodView) onto that structure. A single loom shows exactly one
// operator (a weave of one); a woven loom shows one card per child thread.

// ---------------------------------------------------------------------------
// Shared vocabulary — god-status → mockup card/pill classes.
// ---------------------------------------------------------------------------

const CARD_CLASS: Record<GodStatusKind, string> = {
  run: "s-run",
  repair: "s-repair",
  verify: "s-verify",
  done: "s-done",
  block: "s-block",
  wait: "s-wait",
};

const PILL_GLYPH: Record<GodStatusKind, string> = {
  run: "◐",
  repair: "↺",
  verify: "▶",
  done: "✓",
  block: "✋",
  wait: "◷",
};

// ---------------------------------------------------------------------------
// Charter strip — objective + a few chips + View spec / Revise.
// ---------------------------------------------------------------------------

const PROOF_LABEL: Record<string, string> = {
  quickfix: "quickfix",
  "bmad-story": "bmad story",
  "verifier-criteria": "criteria",
  custom: "custom",
};

function CharterStrip({ loom, onViewSpec }: { loom: Loom; onViewSpec: () => void }) {
  const charter = loom.charter;
  const objective = charter?.objective || loom.prompt || loom.title;

  const scopePaths = charter?.scope?.allowedPaths ?? [];
  const budget = charter?.budget;
  const budgetBits: string[] = [];
  if (budget?.maxCostUsd != null) budgetBits.push(`≤ $${budget.maxCostUsd}`);
  if (budget?.maxWallClockHours != null) budgetBits.push(`≤ ${budget.maxWallClockHours}h`);

  return (
    <section className="charter">
      <div className="ch-top">
        <span className="k">Charter</span>
        {charter?.approvedBy && (
          <span className="ok">
            ✓ approved by {charter.approvedBy}
            {charter.version ? ` · v${charter.version}` : ""}
          </span>
        )}
        <div className="spacer" />
        <button className="btn ghost sm" onClick={onViewSpec}>
          View spec ↗
        </button>
        <button className="btn ghost sm" disabled title="Charter revision — coming soon">
          Revise
        </button>
      </div>
      <p className="obj">{objective}</p>
      {charter && (
        <div className="meta">
          {charter.proofStrategy && (
            <span className="chip">
              proof · {PROOF_LABEL[charter.proofStrategy] ?? charter.proofStrategy}
            </span>
          )}
          {scopePaths.length > 0 && (
            <span className="chip">scope · {scopePaths.slice(0, 2).join(" · ")}</span>
          )}
          {budgetBits.length > 0 && <span className="chip">budget · {budgetBits.join(" · ")}</span>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator bar — the loop, the live tick, the concurrency governor.
// ---------------------------------------------------------------------------

const LOOP: Orchestrator["loopStage"][] = ["plan", "schedule", "observe", "decide"];

function OrchestratorBar({ orchestrator }: { orchestrator: Orchestrator }) {
  const { loopStage, tick, governor } = orchestrator;
  const pct =
    governor.budget > 0 ? Math.min(100, (governor.inFlight / governor.budget) * 100) : 0;

  return (
    <section className="orch">
      <div className="obar">
        <div className="badge">
          <span className="glyph">✳</span>
          <span>
            <span className="lbl">Orchestrator</span>
            <br />
            <span className="who">weaver · fresh context · owns the loop</span>
          </span>
        </div>
        <div className="loop">
          {LOOP.map((s, i) => (
            <span key={s} className="contents">
              <span className={cn("v", s === loopStage && "on")}>{s}</span>
              {i < LOOP.length - 1 ? <span className="arr">→</span> : <span className="cyc">↻</span>}
            </span>
          ))}
        </div>
        <div className="gov">
          <span className="n mono">
            {governor.inFlight} / {governor.budget} agents
          </span>
          <div className="meter">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      <div className="tick">
        <span className="live-dot" />
        <span>
          <b>Tick:</b> {tick}
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The weave — one operator card per thread.
// ---------------------------------------------------------------------------

type DepInfo = { hasDeps: boolean; waitsOn: string[] };

// Layout-only dependency derivation (godview.ts's Operator omits the graph):
// map each operator (= a child thread) to its subgoal's dependsOn, and list any
// dep whose thread hasn't reached "done" yet. Single looms have no threads → no
// deps. Guarded against a missing charter / empty threads.
function deriveDeps(loom: Loom, threads: Loom[]): Map<string, DepInfo> {
  const out = new Map<string, DepInfo>();
  const decomposition: SubGoal[] = loom.charter?.decomposition ?? [];
  if (decomposition.length === 0 || threads.length === 0) return out;

  const bySubGoal = new Map<string, Loom>();
  for (const t of threads) if (t.subGoalId) bySubGoal.set(t.subGoalId, t);

  for (const t of threads) {
    const sg = decomposition.find((d) => d.id === t.subGoalId);
    const dependsOn = sg?.dependsOn ?? [];
    const waitsOn = dependsOn
      .filter((dep) => bySubGoal.get(dep)?.state !== "done")
      .map((dep) => {
        const depThread = bySubGoal.get(dep);
        const depSg = decomposition.find((d) => d.id === dep);
        return depThread ? shortId(depThread.id) : (depSg?.title ?? dep);
      });
    out.set(t.id, { hasDeps: dependsOn.length > 0, waitsOn });
  }
  return out;
}

function summarize(operators: Operator[]): string {
  const total = operators.length;
  const done = operators.filter((o) => o.status.kind === "done").length;
  const weaving = operators.filter((o) => o.active).length;
  const waiting = operators.filter((o) => o.status.kind === "wait").length;
  const needsYou = operators.filter((o) => o.status.kind === "block").length;
  const bits = [`${total} thread${total === 1 ? "" : "s"}`];
  if (done) bits.push(`${done} done`);
  if (weaving) bits.push(`${weaving} weaving`);
  if (waiting) bits.push(`${waiting} waiting`);
  if (needsYou) bits.push(`${needsYou} needs you`);
  return bits.join(" · ");
}

// One derived step, rendered as a muted chip (the palette is intentionally
// calm — one quiet signal, not a highlighter). `fanCount` only decorates a
// live Build with its parallel-builder count.
function StageCell({ step, fanCount }: { step: Step; fanCount: number }) {
  const cls = ["stage"];
  if (step.state === "done") cls.push("done");
  else if (step.state === "active") cls.push("active");
  else if (step.state === "failed") cls.push("failed");
  const label =
    step.name === "Build" && step.state === "active" && fanCount > 0
      ? `Build ×${fanCount}`
      : step.name;
  const suffix = step.state === "failed" ? " ✗" : "";
  return <div className={cls.join(" ")}>{label}{suffix}</div>;
}

function OperatorNote({ op, dep }: { op: Operator; dep: DepInfo | undefined }) {
  const kind = op.status.kind;

  if (kind === "block") {
    return (
      <div className="t-note">
        <span className="flag" style={{ color: "var(--accent)" }}>
          paused
        </span>
        <span>
          Parked for a decision the orchestrator won&apos;t guess — the weave keeps running around
          it.
        </span>
      </div>
    );
  }
  if (kind === "repair" && op.repairs > 0) {
    return (
      <div className="t-note">
        <span className="flag" style={{ color: "var(--repair)" }}>
          verify ✗
        </span>
        <span>
          Verify failed — the failing criterion + repro were handed back to the builder (attempt{" "}
          {op.repairs + 1}).
        </span>
      </div>
    );
  }
  if (kind === "wait" && dep?.waitsOn.length) {
    return (
      <div className="t-note">
        <span style={{ color: "var(--ink-faint)" }}>
          Waits on {dep.waitsOn.join(", ")} — scheduled the moment they pass.
        </span>
      </div>
    );
  }
  if (kind === "done") {
    return (
      <div className="t-note">
        <span className="flag" style={{ color: "var(--ok)" }}>
          done
        </span>
        <span>Verified against its story and promoted.</span>
      </div>
    );
  }
  return null;
}

function OperatorCard({
  op,
  dep,
  onOpen,
}: {
  op: Operator;
  dep: DepInfo | undefined;
  onOpen: (id: string) => void;
}) {
  const kind = op.status.kind;
  const fanCount = op.subAgents.length;

  return (
    <article
      className={cn("thread", CARD_CLASS[kind], dep?.hasDeps && "dep")}
      tabIndex={0}
      role="button"
      onClick={() => onOpen(op.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(op.id);
        }
      }}
    >
      <div className="t-row">
        <span className="t-name">{op.name}</span>
        <span className="t-id">{shortId(op.id)}</span>
        <div className="t-right">
          <span className="drill">open agent ↳</span>
          <span className={cn("pill", kind)}>
            {PILL_GLYPH[kind]} {op.status.label}
          </span>
        </div>
      </div>

      {op.steps.length > 0 && (
        <div className="stages">
          {op.steps.map((s, i) => (
            <StageCell key={`${s.name}-${i}`} step={s} fanCount={fanCount} />
          ))}
        </div>
      )}

      {fanCount > 0 && (
        <div className="fanout">
          <span className="lead">fanned out →</span>
          {op.subAgents.map((s) => (
            <span key={s.id} className={cn("agent-chip", s.done && "done")}>
              <span className="sp" /> {s.name}
            </span>
          ))}
        </div>
      )}

      <OperatorNote op={op} dep={dep} />

      {kind === "block" && (
        <div className="t-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn accent sm" disabled title="Steering — coming soon">
            Answer &amp; resume
          </button>
          <button className="btn ghost sm" disabled title="Coming soon">
            Take over in chat →
          </button>
        </div>
      )}
    </article>
  );
}

function Weave({
  operators,
  loom,
  threads,
  onOpenOperator,
}: {
  operators: Operator[];
  loom: Loom;
  threads: Loom[];
  onOpenOperator: (id: string) => void;
}) {
  const deps = useMemo(() => deriveDeps(loom, threads), [loom, threads]);

  return (
    <section>
      <div className="weave-head">
        <h2>The weave</h2>
        <span className="cnt">{summarize(operators)}</span>
        <span className="hint">click any to open its agent view</span>
      </div>
      <div className="threads">
        {operators.length === 0 ? (
          <div className="t-note" style={{ marginTop: 8 }}>
            <span style={{ color: "var(--ink-faint)" }}>No operators weaving yet.</span>
          </div>
        ) : (
          operators.map((op) => (
            <OperatorCard key={op.id} op={op} dep={deps.get(op.id)} onOpen={onOpenOperator} />
          ))
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Right rail — decision log + steer box + launched-from-session link.
// ---------------------------------------------------------------------------

const LOG_CLASS: Record<DecisionLogEntry["kind"], string> = {
  plan: "plan",
  ok: "ok",
  fail: "fail",
  block: "block",
  info: "",
};

function RightRail({ log, loom }: { log: DecisionLogEntry[]; loom: Loom }) {
  // godview.ts derives the log oldest→newest; the rail shows newest first so
  // the latest move is visible without scrolling.
  const entries = useMemo(() => [...log].reverse(), [log]);
  const sessionId = loom.charter?.scopingSessionId;

  return (
    <aside className="rail">
      <div className="card">
        <div className="hd">
          <span className="k">Orchestrator log</span>
          <span className="who">weaver</span>
        </div>
        <div className="bd">
          {entries.length === 0 ? (
            <div className="empty">No decisions yet.</div>
          ) : (
            <ul className="log">
              {entries.map((e, i) => (
                <li key={`${e.ts}-${i}`} className={LOG_CLASS[e.kind]}>
                  <b>{e.title}</b>
                  {e.detail ? ` ${e.detail}` : ""}
                  <span className="t">{fmtAgo(e.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card steer">
        <div className="hd">
          <span className="k">Steer this loom</span>
        </div>
        <div className="bd">
          <textarea
            placeholder="e.g. 'For a declined card, use the “try another card” copy.'"
            disabled
          />
          <div className="foot">
            <button className="btn accent sm" disabled title="Steering — coming soon">
              Send directive
            </button>
            <span className="hint">Picked up at the next thread boundary.</span>
          </div>
        </div>
      </div>

      {sessionId && (
        <a className="from-chat" href="#">
          💬 Launched from session {shortId(sessionId)} →
        </a>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The unified frame.
// ---------------------------------------------------------------------------

export function LoomGodView({
  view,
  loom,
  threads,
  onOpenOperator,
  onViewSpec,
}: {
  view: GodView;
  loom: Loom;
  threads: Loom[];
  onOpenOperator: (id: string) => void;
  onViewSpec: () => void;
}) {
  return (
    <>
      <CharterStrip loom={loom} onViewSpec={onViewSpec} />
      <OrchestratorBar orchestrator={view.orchestrator} />

      <div className="rel">
        <span>operators the orchestrator is weaving</span>
        <span className="ln" />
        <span>↓ click any to open its agent view</span>
      </div>

      <div className="content">
        <Weave
          operators={view.operators}
          loom={loom}
          threads={threads}
          onOpenOperator={onOpenOperator}
        />
        <RightRail log={view.decisionLog} loom={loom} />
      </div>

      <div className="moat">
        <span className="lock">🔒</span>
        <span>
          <b>The weave can&apos;t come off the loom on its own.</b> Promotion to done needs a passing{" "}
          <b>independent</b> verify — no thread, the orchestrator, or a chat marks itself done.
        </span>
      </div>
    </>
  );
}
