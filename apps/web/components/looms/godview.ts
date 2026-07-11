// PURE, CLIENT-SAFE god-view derivation. Maps today's loom data onto the shape
// the locked mockup (scratchpad/loom-godview-integrated.html) renders from: an
// orchestrator header, an array of operators (the weave), and a decision log.
//
// CRITICAL import boundary (docs: apps/web/AGENTS.md) — this file is imported by
// "use client" components, so it may ONLY `import type` from "@telar/core". A
// single runtime VALUE import drags async_hooks into the browser bundle and
// breaks the build. Every derivation below is hand-rolled here; the only shared
// runtime helpers come from ./utils, which is itself client-safe.
import type {
  AttemptRecord,
  CriticVerdict,
  Evidence,
  GateResult,
  Loom,
  LoomEvent,
  PanelReport,
  WorkUnitState,
} from "@telar/core";
import { isSingleThreadWeave, isTerminal, isWoven } from "./utils";

export { isWoven, isTerminal } from "./utils";

// ---------------------------------------------------------------------------
// Return shape — the contract the View / Drawer stages consume.
// ---------------------------------------------------------------------------

// The weaver's control loop position (mockup: plan → schedule → observe → decide ↻).
export type LoopStage = "plan" | "schedule" | "observe" | "decide";

// The mockup's pill/rail vocabulary, one step removed from raw WorkUnitState so
// the View never re-derives colors. Maps to CSS vars --build/--repair/--verify/
// --ok/--accent/--wait via godStatus().
export type GodStatusKind =
  | "run" // building (var(--build))
  | "repair" // failed verify, rebuilding (var(--repair))
  | "verify" // verifying / verified-awaiting (var(--verify))
  | "done" // promoted (var(--ok))
  | "block" // needs a human (var(--accent))
  | "wait"; // scheduled, not started (var(--wait)/--ink-faint)

export type GodStatus = { kind: GodStatusKind; label: string };

export type StageState = "idle" | "active" | "done" | "failed";

// A single step the operator actually took, in the order it happened. NOT a
// fixed build/gate/verify/decide spine (docs/loom-model.md §V.2) — the list is
// DERIVED from attempts/gates/panel, so a loom that only built + verified shows
// exactly those two, never four half-empty cells. `state === "idle"` is only
// used for a step that is present-but-not-yet-started (a live verify pending);
// steps that never happened are simply absent from the array. (Orchestrator-
// authored step names arrive with Phase C; until then the names are the coarse
// stage labels below.)
export type Step = { name: string; state: StageState };

export type FileTouched = { op: "add" | "mod"; path: string; stat: string };

export type SubAgent = {
  id: string; // the fan-out pieceId
  name: string;
  now: string; // last thing it said/did, best-effort from events
  done: boolean;
};

// A transcript slot. `available:false` is a first-class, honest state — the UI
// shows "transcript not captured yet" rather than us fabricating a stream.
export type TranscriptEntry =
  | { k: "say"; text: string }
  | {
      // A tool call, rendered by the shared session-style ToolStepRow. `input`
      // is the raw tool-argument object forwarded from the engine's `tool`
      // event; `output`/`isError` are filled in from the correlated
      // `tool-result` event when the core captured one. All optional: an OLD
      // event that predates input-forwarding still produces a bare row (tool
      // name only, nothing to expand) — it degrades, never breaks.
      k: "tool";
      name: string;
      input?: Record<string, unknown>;
      output?: string;
      isError?: boolean;
    }
  | { k: "pw"; text: string } // Playwright / critic drive step
  | { k: "res"; ok: boolean; text: string }
  | { k: "note"; text: string }
  | { k: "verdict"; ok: boolean; text: string }
  | { k: "meta"; text: string };

export type Transcript =
  | { available: false; reason: string }
  | { available: true; source: "events" | "verdict"; entries: TranscriptEntry[] };

export type RosterEntry = {
  key: string;
  label: string;
  role: "builder" | "critic";
  sessionId?: string;
  transcript: Transcript;
};

export type Operator = {
  id: string;
  name: string;
  state: WorkUnitState;
  status: GodStatus;
  active: boolean; // doing autonomous work right now
  steps: Step[]; // what the operator actually did, in order; [] when nothing yet
  repairs: number; // prior attempts whose panel verify failed
  subAgents: SubAgent[]; // intra-thread fan-out, [] when none / not captured
  files: FileTouched[]; // best-effort from the latest verdict, may be []
  summary: string | null; // latest builder verdict's one-line summary, null when none
  critics: CriticVerdict[]; // latest attempt's panelReport.critics
  url: string; // panelReport.url ("" if none)
  roster: RosterEntry[]; // operator + sub-agents + critics, for the transcript tab
  // WHY it stalled — surfaced verbatim so a failed/needs-review Thread explains
  // itself. `error` is the child Loom's own error line; `failing` names the
  // specific blockers (deterministic gates that went red, must-clear critic
  // lenses that judged it unacceptable, and the builder verdict's blocker note).
  error: string | null;
  failing: { gates: string[]; critics: string[]; verdictBlocker?: string };
};

// The WHY behind a scheduling decision — the deterministic policy inputs Phase 2
// captured on the `decision` event's `rationale`: the critical-path scores, the
// binding fan-out term, a budget/clock snapshot, and (when a proposed decision
// was rejected as invalid) the reason it was downgraded to hold. Read verbatim
// off the event; every field is optional so a pre-Phase-2 event degrades to a
// bare row rather than throwing.
export type RationaleView = {
  summary?: string;
  ranked?: { id: string; score: number }[]; // (a) critical-path scores, highest-first
  fanout?: {
    pieces: number;
    capByPool: number;
    capByBudget: number;
    chosen: number;
    binding: "pieces" | "pool" | "budget" | "pool-exhausted" | string;
  };
  budget?: {
    spentUsd: number;
    inFlight: number;
    budgetLeftUsd: number | null; // null/∞ = uncapped (Infinity serializes to null)
    wallClockRemainingMs: number | null; // null = no wall-clock cap
    maxCostUsd?: number;
  };
  rejected?: string; // (d) the reason the proposed decision was rejected
};

export type DecisionKind = "plan" | "ok" | "fail" | "block" | "info" | "observe";
export type DecisionLogEntry = {
  ts: number;
  kind: DecisionKind;
  title: string;
  detail?: string;
  rationale?: RationaleView; // the expandable "why", when the event carried one
};

// The decomposition graph the weaver planned, joined to live thread state so the
// plan reads as a living map rather than a static list. Derived from the `plan`
// event (Phase 2) with a charter-decomposition fallback; `singleThread` marks a
// weave-of-one so the UI renders the honest one-node case instead of a fake DAG.
export type PlanNodeState = WorkUnitState | "pending";
export type PlanNode = {
  id: string;
  title: string;
  dependsOn: string[];
  required: boolean;
  state: PlanNodeState;
};
export type Plan = {
  nodes: PlanNode[];
  rationale: string | null; // the weaver's decomposition reasoning, when authored
  singleThread: boolean;
};

// `max` is set ONLY when the charter actually declares a maxAgents cap — no
// invented denominator. The bar reads honestly ("2 agents active" / "idle")
// and only shows N/max + a meter when a real cap exists.
export type Governor = { inFlight: number; max?: number };

export type Orchestrator = {
  loopStage: LoopStage;
  tick: string; // one-line summary of the latest decision
  governor: Governor;
  plan: Plan; // the decomposition graph the weaver is executing
};

export type GodView = {
  woven: boolean;
  orchestrator: Orchestrator;
  operators: Operator[];
  decisionLog: DecisionLogEntry[];
};

// ---------------------------------------------------------------------------
// Small predicates on attempts / panels.
// ---------------------------------------------------------------------------

const ACTIVE_STATES: readonly WorkUnitState[] = ["preparing", "running", "verifying"];
const isActive = (s: WorkUnitState) => ACTIVE_STATES.includes(s);

// A panel FAILED verify when any must-clear (blocker) lens judged the work
// unacceptable — the §M.3 floor guarantees ≥1 blocker lens exists.
function panelFailed(pr: PanelReport | null | undefined): boolean {
  if (!pr || pr.critics.length === 0) return false;
  return pr.critics.some((c) => c.blocker && !c.ok);
}

const gatesFailed = (g?: GateResult[]) => !!g && g.some((r) => !r.ok);
const gatesRan = (g?: GateResult[]) => !!g && g.length > 0;

// ---------------------------------------------------------------------------
// state → god-view color/label.
// ---------------------------------------------------------------------------

export function godStatus(op: Loom, repairs: number): GodStatus {
  switch (op.state) {
    case "running":
    case "preparing":
      return repairs > 0
        ? { kind: "repair", label: `repairing · try ${repairs + 1}` }
        : { kind: "run", label: "building" };
    case "verifying":
      return { kind: "verify", label: "verifying" };
    case "ready":
      return { kind: "verify", label: "verified · awaiting you" };
    case "done":
      return { kind: "done", label: "passed" };
    case "blocked":
      return { kind: "block", label: "needs you" };
    case "needs-review":
      return { kind: "block", label: "needs review" };
    case "failed":
    case "halted":
      return { kind: "repair", label: op.state };
    case "skipped":
      return { kind: "wait", label: "skipped" };
    default:
      return { kind: "wait", label: op.state }; // queued/scoping/charter-review
  }
}

// ---------------------------------------------------------------------------
// Step derivation from attempts + gates + panelReport.
//
// The list is built in causal order and only includes stages that actually
// happened (or, for verify, are happening right now) — never a fixed 4-cell
// rail. A brand-new operator that hasn't built yet yields []; a loom that only
// built + verified yields exactly ["Build","Verify"].
// ---------------------------------------------------------------------------

function deriveSteps(op: Loom, latest: AttemptRecord | undefined): Step[] {
  const s = op.state;
  const pr = latest?.panelReport ?? null;
  const gates = latest?.gates;
  const steps: Step[] = [];

  const reachedVerify =
    s === "verifying" || !!pr || (gatesRan(gates) && !gatesFailed(gates)) || isTerminal(s);

  // Build — present the moment any attempt exists.
  if (op.attempts.length > 0) {
    const active = (s === "running" || s === "preparing") && !reachedVerify;
    steps.push({ name: "Build", state: active ? "active" : "done" });
  }

  // Gate — only when deterministic gates actually ran.
  if (gatesRan(gates)) {
    steps.push({ name: "Gate", state: gatesFailed(gates) ? "failed" : "done" });
  }

  // Verify — only when the critic panel ran (done/failed) or is running.
  if (pr) {
    steps.push({ name: "Verify", state: panelFailed(pr) ? "failed" : "done" });
  } else if (s === "verifying") {
    steps.push({ name: "Verify", state: "active" });
  }

  // Decide — only at a real decision point (promoted, awaiting you, parked).
  if (s === "done" || s === "ready") {
    steps.push({ name: "Decide", state: "done" });
  } else if (s === "blocked" || s === "needs-review") {
    steps.push({ name: "Decide", state: "active" });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Transcript reconstruction from the ROOT loom's event stream.
//
// The executor emits text/tool/session/verdict/gate/agent-result events; the
// SSE route appends every one to the loom's event log. So for a SINGLE (non-
// woven) loom, `events` IS a real, replayable transcript. Fan-out pieces tag
// their events with `pieceId`; the operator's own turns have none.
//
// For a WOVEN loom, each child's onEvent is appended to the CHILD's log, which
// is NOT in this payload — so woven-child transcripts degrade to unavailable.
// ---------------------------------------------------------------------------

const evPiece = (ev: LoomEvent) => (ev as { pieceId?: string }).pieceId;

export function eventsToTranscript(events: LoomEvent[], pieceId?: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const ev of events) {
    const p = evPiece(ev);
    // Op-scoped rows (verdict/gate) only belong to the operator lane (no pieceId).
    switch (ev.type) {
      case "text":
        if (p === pieceId) out.push({ k: "say", text: String((ev as { text?: string }).text ?? "") });
        break;
      case "tool": {
        if (p !== pieceId) break;
        const t = ev as { name?: string; input?: unknown };
        const input =
          t.input && typeof t.input === "object" && !Array.isArray(t.input)
            ? (t.input as Record<string, unknown>)
            : undefined;
        out.push({ k: "tool", name: String(t.name ?? "tool"), input });
        break;
      }
      case "tool-result": {
        // Correlate back onto the most recent tool row still missing a result.
        // The engine emits tool-result right after the tool_use's synthetic
        // user message, so the nearest open tool entry (matching name when the
        // event carried one) is the right target. Old events never emit this.
        if (p !== pieceId) break;
        const r = ev as { name?: string; ok?: boolean; output?: string };
        for (let i = out.length - 1; i >= 0; i--) {
          const e = out[i];
          if (e.k !== "tool" || e.output !== undefined || e.isError !== undefined) continue;
          if (r.name && e.name !== r.name) continue;
          e.output = r.output;
          e.isError = r.ok === false;
          break;
        }
        break;
      }
      case "agent-result": {
        if (p !== pieceId) break;
        const r = ev as { subtype?: string; costUsd?: number; turns?: number };
        const bits = [r.subtype ?? "done"];
        if (typeof r.turns === "number") bits.push(`${r.turns} turns`);
        if (typeof r.costUsd === "number") bits.push(`$${r.costUsd.toFixed(2)}`);
        out.push({ k: "res", ok: (r.subtype ?? "success") === "success", text: bits.join(" · ") });
        break;
      }
      case "gate": {
        if (pieceId !== undefined) break; // gates are operator-lane only
        const g = (ev as { result?: GateResult }).result;
        if (g) out.push({ k: "res", ok: g.ok, text: `gate ${g.name} ${g.ok ? "passed" : "failed"}` });
        break;
      }
      case "verdict": {
        if (pieceId !== undefined) break;
        const v = (ev as { verdict?: { ok?: boolean; summary?: string } }).verdict;
        if (v) out.push({ k: "verdict", ok: !!v.ok, text: v.summary ?? "" });
        break;
      }
    }
  }
  return out;
}

// Distinct fan-out pieces seen in the event stream, in first-appearance order.
function derivePieces(events: LoomEvent[]): string[] {
  const seen: string[] = [];
  for (const ev of events) {
    const p = evPiece(ev);
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

// A critic transcript is verdict-only: critics emit a single `critic-verdict`
// event (their step-by-step Playwright drive is NOT persisted), so we render the
// summary + findings + evidence that ARE captured, honestly labelled.
function criticTranscript(c: CriticVerdict): Transcript {
  const entries: TranscriptEntry[] = [];
  entries.push({ k: "verdict", ok: c.ok, text: c.summary });
  for (const f of c.findings) {
    entries.push({ k: "note", text: `${f.severity} · ${f.title} — ${f.detail}` });
  }
  const evLabel = evidenceLabel([...(c.evidence ?? []), ...c.findings.flatMap((f) => f.evidence ?? [])]);
  if (evLabel) entries.push({ k: "meta", text: evLabel });
  entries.push({ k: "meta", text: "live tool-by-tool steps not captured — verdict + evidence only" });
  return { available: true, source: "verdict", entries };
}

function evidenceLabel(ev: Evidence[]): string {
  if (!ev.length) return "";
  const kinds = ev.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});
  return "evidence: " + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(" · ");
}

// ---------------------------------------------------------------------------
// Operator derivation.
// ---------------------------------------------------------------------------

function deriveOperator(op: Loom, opEvents: LoomEvent[], eventsAvailable: boolean): Operator {
  const latest = op.attempts.at(-1);
  const repairs = op.attempts.filter((a) => panelFailed(a.panelReport)).length;
  const steps = deriveSteps(op, latest);
  const critics = latest?.panelReport?.critics ?? [];
  const url = latest?.panelReport?.url ?? "";

  // Why it stalled: the loom's own error line, plus the specific blockers from
  // the latest attempt — red deterministic gates, must-clear critic lenses that
  // failed, and the builder verdict's blocker note. All best-effort / may be [].
  const failing: Operator["failing"] = {
    gates: (latest?.gates ?? []).filter((g) => !g.ok).map((g) => g.name),
    critics: critics.filter((c) => c.blocker && !c.ok).map((c) => c.lens),
    ...(latest?.verdict?.blocker ? { verdictBlocker: latest.verdict.blocker } : {}),
  };

  // Files: best-effort from the latest verdict's files_touched. We can't tell
  // add vs mod from a bare path, so everything is "mod"; empty is fine.
  const files: FileTouched[] = (latest?.verdict?.files_touched ?? []).map((path) => ({
    op: "mod",
    path,
    stat: "",
  }));

  // Sub-agents: only reconstructable for the single-loom operator, whose fan-out
  // pieces tag events with pieceId. Woven children carry no piece events here.
  const pieces = eventsAvailable ? derivePieces(opEvents) : [];
  const subAgents: SubAgent[] = pieces.map((id) => {
    const lane = opEvents.filter((e) => evPiece(e) === id);
    const lastText = [...lane].reverse().find((e) => e.type === "text") as
      | { text?: string }
      | undefined;
    const done = lane.some((e) => e.type === "agent-result");
    return {
      id,
      name: id,
      now: lastText?.text ?? (done ? "merged" : "working…"),
      done,
    };
  });

  // Roster: operator + fan-out pieces + critics.
  const roster: RosterEntry[] = [];

  roster.push({
    key: "op",
    label: `operator ${op.id}`,
    role: "builder",
    sessionId: latest?.sessionId,
    transcript: eventsAvailable
      ? { available: true, source: "events", entries: eventsToTranscript(opEvents, undefined) }
      : {
          available: false,
          reason: latest?.sessionId
            ? `session ${latest.sessionId} is resumable, but its step-by-step transcript is not in this payload`
            : "transcript not captured yet",
        },
  });

  for (const id of pieces) {
    roster.push({
      key: id,
      label: id,
      role: "builder",
      transcript: { available: true, source: "events", entries: eventsToTranscript(opEvents, id) },
    });
  }

  critics.forEach((c, i) => {
    roster.push({
      key: `critic-${i}`,
      label: `critic · ${c.lens}`,
      role: "critic",
      transcript: criticTranscript(c),
    });
  });

  return {
    id: op.id,
    name: op.title,
    state: op.state,
    status: godStatus(op, repairs),
    active: isActive(op.state),
    steps,
    repairs,
    subAgents,
    files,
    summary: latest?.verdict?.summary ?? null,
    critics,
    url,
    roster,
    error: op.error,
    failing,
  };
}

// A WOVEN child's transcript IS captured — in the CHILD's own event log, which
// the god-view page tails via a second EventSource and passes in here. So a
// woven child gets the SAME real transcript as a single loom, keyed on its own
// events. (deriveGodView still passes [] for the roster grid; the drawer swaps
// in this live-tailed operator when the child is opened.)
export function deriveThreadOperator(child: Loom, events: LoomEvent[]): Operator {
  return deriveOperator(child, events, true);
}

// ---------------------------------------------------------------------------
// Orchestrator: loop stage, tick summary, governor.
// ---------------------------------------------------------------------------

function deriveLoopStage(loom: Loom, operators: Operator[]): LoopStage {
  const s = loom.state;
  if (s === "queued" || s === "scoping" || s === "charter-review" || s === "preparing") return "plan";
  if (s === "verifying") return "decide";
  if (s === "blocked" || s === "needs-review" || s === "ready" || isTerminal(s)) return "decide";
  // running: scheduling until something is actually in flight, then observing.
  return operators.some((o) => o.active) ? "observe" : "schedule";
}

type DecisionEvt = { action?: string; subGoalIds?: string[]; threadId?: string; reason?: string; pieces?: number };

function summarizeDecision(d: DecisionEvt): string {
  switch (d.action) {
    case "schedule":
      return `Scheduled ${d.subGoalIds?.length ?? 0} thread(s): ${(d.subGoalIds ?? []).join(", ")}`;
    case "fanout":
      return `Fanned ${d.threadId ?? "a thread"} out into ${d.pieces ?? 0} builders`;
    case "repair":
      return `Repairing ${d.threadId ?? "a thread"} with the failing criterion + repro`;
    case "escalate":
      return `Escalated to you — ${d.reason ?? "needs a decision"}`;
    case "finish-loom":
      return "All required threads verified — closing the weave";
    case "hold":
      return "Holding — waiting on in-flight threads before the next move";
    default:
      return d.action ? `Decision: ${d.action}` : "Deciding…";
  }
}

function deriveTick(loom: Loom, events: LoomEvent[]): string {
  const lastDecision = [...events].reverse().find((e) => e.type === "decision") as
    | { decision?: DecisionEvt; rationale?: { summary?: string } }
    | undefined;
  // Prefer the weaver's own deterministic rationale summary (Phase 2) — it names
  // the head + the binding term — over the coarse action-only fallback.
  if (lastDecision?.rationale?.summary) return lastDecision.rationale.summary;
  if (lastDecision?.decision) return summarizeDecision(lastDecision.decision);

  const lastPanel = [...events].reverse().find(
    (e) => e.type === "panel" && !!(e as { report?: PanelReport | null }).report,
  ) as { report?: PanelReport | null } | undefined;
  if (lastPanel?.report) {
    return panelFailed(lastPanel.report) ? "Verify failed — repair loop engaged" : "Verify passed";
  }
  const lastState = [...events].reverse().find((e) => e.type === "state") as
    | { state?: string }
    | undefined;
  if (lastState?.state) return `State → ${lastState.state}`;
  return `Loom is ${loom.state}`;
}

type PlanEvt = {
  decomposition?: { id: string; title: string; dependsOn?: string[]; required?: boolean }[];
  rationale?: string | null;
};

// The plan the weaver is executing: nodes from the latest `plan` event (Phase 2)
// or, absent one, the charter's decomposition — each joined to its thread's live
// state so the graph reads as a living map. A weave-of-one is flagged so the UI
// shows the honest single-node case (with its "by construction" rationale)
// instead of a degenerate one-box "DAG".
function derivePlan(loom: Loom, threads: Loom[], events: LoomEvent[]): Plan {
  const planEvt = [...events].reverse().find((e) => e.type === "plan") as PlanEvt | undefined;

  const stateBySub = new Map<string, WorkUnitState>();
  for (const t of threads) if (t.subGoalId) stateBySub.set(t.subGoalId, t.state);

  const raw = planEvt?.decomposition ?? loom.charter?.decomposition ?? [];
  const nodes: PlanNode[] = raw.map((sg) => ({
    id: sg.id,
    title: sg.title,
    dependsOn: sg.dependsOn ?? [],
    required: sg.required ?? true,
    state: stateBySub.get(sg.id) ?? "pending",
  }));

  return {
    nodes,
    rationale: planEvt?.rationale ?? loom.charter?.rationale ?? null,
    singleThread: isSingleThreadWeave(loom),
  };
}

// ---------------------------------------------------------------------------
// Decision log from the event stream.
// ---------------------------------------------------------------------------

// Narrow the raw `rationale` object off a `decision` event into RationaleView.
// Defensive by design — an old event (no rationale) or a partial one yields
// only the fields that are actually present, so the row degrades, never throws.
function toRationaleView(r: unknown): RationaleView | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  const view: RationaleView = {};
  if (typeof o.summary === "string") view.summary = o.summary;
  if (Array.isArray(o.ranked)) view.ranked = o.ranked as RationaleView["ranked"];
  if (o.fanout && typeof o.fanout === "object") view.fanout = o.fanout as RationaleView["fanout"];
  if (o.budget && typeof o.budget === "object") view.budget = o.budget as RationaleView["budget"];
  if (typeof o.rejected === "string") view.rejected = o.rejected;
  return Object.keys(view).length > 0 ? view : undefined;
}

function deriveDecisionLog(events: LoomEvent[]): DecisionLogEntry[] {
  const log: DecisionLogEntry[] = [];
  for (const ev of events) {
    const ts = ev.ts;
    switch (ev.type) {
      case "charter-approved":
        log.push({ ts, kind: "plan", title: "Charter approved", detail: String((ev as { by?: string }).by ?? "") });
        break;
      case "decision": {
        const d = (ev as { decision?: DecisionEvt }).decision;
        if (!d) break;
        const rationale = toRationaleView((ev as { rationale?: unknown }).rationale);
        const kind: DecisionKind =
          d.action === "escalate" ? "block" : d.action === "finish-loom" ? "ok" : d.action === "hold" ? "info" : "plan";
        // Prefer the weaver's own rationale summary as the row title (it names the
        // head + the binding term); fall back to the action-only summary.
        log.push({ ts, kind, title: rationale?.summary ?? summarizeDecision(d), rationale });
        break;
      }
      case "observe": {
        // A child settled — surface which one, its rollup state, and the subgoals
        // THIS settle newly unblocked (Phase 2's readiness delta).
        const o = ev as { subGoalId?: string; state?: string; unblocked?: string[] };
        const unblocked = Array.isArray(o.unblocked) ? o.unblocked : [];
        const tail = unblocked.length > 0 ? ` → unblocked ${unblocked.join(", ")}` : "";
        log.push({ ts, kind: "observe", title: `${o.subGoalId ?? "a thread"} settled · ${o.state ?? "?"}${tail}` });
        break;
      }
      case "weave-child-spawned":
        log.push({
          ts,
          kind: "plan",
          title: `Spawned thread for ${String((ev as { subGoalId?: string }).subGoalId ?? "?")}`,
          detail: String((ev as { childId?: string }).childId ?? ""),
        });
        break;
      case "fanout":
        log.push({ ts, kind: "plan", title: `Sized fan-out → ${(ev as { pieces?: number }).pieces ?? 0} builders` });
        break;
      case "panel": {
        const report = (ev as { report?: PanelReport | null }).report;
        if (!report) break; // report:null = panel skipped, not a verdict
        log.push(
          panelFailed(report)
            ? { ts, kind: "fail", title: "Verify failed — handed a repro back to the builder" }
            : { ts, kind: "ok", title: "Verify passed" },
        );
        break;
      }
      case "weave-rollup": {
        const state = String((ev as { state?: string }).state ?? "");
        log.push({ ts, kind: state === "ready" || state === "done" ? "ok" : "fail", title: `Weave rolled up → ${state}` });
        break;
      }
      case "error":
        log.push({ ts, kind: "fail", title: "Error", detail: String((ev as { message?: string }).message ?? "") });
        break;
    }
  }
  return log;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function deriveGodView(loom: Loom, threads: Loom[], events: LoomEvent[]): GodView {
  const woven = isWoven(loom);

  // WOVEN → the operators are the child looms; their per-agent events live in
  // each child's own log (not here), so they render without transcripts.
  // SINGLE → exactly one operator, the loom itself (a weave of one); THIS loom's
  // events ARE its operator/critic transcript.
  const operators: Operator[] = woven
    ? threads.map((t) => deriveOperator(t, [], false))
    : [deriveOperator(loom, events, true)];

  const inFlight = woven
    ? operators.filter((o) => o.active).length
    : operators[0]?.active
      ? 1 + operators[0].subAgents.filter((s) => !s.done).length
      : 0;
  const max = loom.charter?.budget?.maxAgents;

  return {
    woven,
    orchestrator: {
      loopStage: deriveLoopStage(loom, operators),
      tick: deriveTick(loom, events),
      governor: { inFlight, ...(max != null ? { max } : {}) },
      plan: derivePlan(loom, threads, events),
    },
    operators,
    decisionLog: deriveDecisionLog(events),
  };
}
