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
  LensSpec,
  Loom,
  LoomEvent,
  PanelReport,
  RepairRound,
  VerifierReport,
  WorkUnitState,
} from "@telar/core";
import { isSingleThreadWeave, isTerminal, isWoven } from "./utils";
import { shortId } from "@/lib/format";

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
  // Sub-agent lifecycle for a fan-out piece: true once its lane merged/finished
  // (from the subAgents `done` derivation), undefined = live/unknown. Drives the
  // per-agent header's live/merged badge; never set for the operator or critics.
  done?: boolean;
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
  verify: VerifyView; // the Verify tab's derivation (M1)
};

// ---------------------------------------------------------------------------
// Verify tab (M1) — the INDEPENDENT verdict surface. Every field is derived,
// never fabricated: an unverified loom reads "not verified yet", a verify that
// ran no executable check reads "no executable check ran". The builder's own
// self-report is carried walled-off (`builderVerdict`) and NEVER merged into the
// independent `verdict` — that separation IS the moat.
// ---------------------------------------------------------------------------

// A re-derived, pure outcome. `pending` = not verified yet; `skip` = a verify
// ran but no executable/independent check produced a verdict.
export type AssertionOutcome = "pass" | "fail" | "flaky" | "skip" | "pending";

// One entry in the live verifier/critic process timeline, folded from the §2
// process events. `who` is "verifier" (legacy path) or a critic lens label.
export type VerifyStep =
  | { k: "text"; who: string; text: string }
  | { k: "tool"; who: string; name: string; input?: string }
  | { k: "observation"; who: string; kind: string; output?: string }
  | { k: "sized"; sized: LensSpec[]; sizedFrom?: Record<string, number> }
  | { k: "critic-start"; lens: string; blocker: boolean };

export type VerifyReport = {
  scope: "integration" | "thread";
  id: string; // the loom whose evidence dir backs this report (root or child)
  title: string;
  verdict: AssertionOutcome; // re-derived, INDEPENDENT of the builder's verdict
  source: "panel" | "verifier" | "gates" | "none";
  panelRequired: boolean; // when a skip is unpromotable (authored contract, no evidence)
  reason?: string; // the panel's own aggregation reason (from verify-summary), when a panel ran
  gates: GateResult[];
  critics: CriticVerdict[];
  legacy: VerifierReport | null; // the single-Verifier report, when the legacy path ran
  mustClearFailed: string[]; // blocker lenses that did NOT clear
  advisory: string[]; // non-blocker (advisory) lenses
  url?: string; // the app URL the panel/verifier drove, when captured
  steps: VerifyStep[]; // the live process timeline, [] when none captured in this feed
  builderVerdict: { ok: boolean; summary: string } | null; // self-report, walled off
};

// ---------------------------------------------------------------------------
// Auto-repair history (M4) — the bounded convergence loop, read-only display.
// Derived PURELY from the root loom's `repairHistory` (absent unless the
// autoRepair flag fired) + `state`/`error`. Every field is honest: a round that
// hasn't been reached is simply absent; the outcome is read off the loom's state
// and the escalate reason is `loom.error` verbatim — never a fabricated verdict.
// ---------------------------------------------------------------------------

// One observed integration-verify round, plus the per-round DELTA that the
// convergence guards act on: `fixed` = assertions that were failing last round
// and cleared this round; `regressed` = assertions that were green in an earlier
// round and went red this round (the Guard-4 oscillation signal).
export type RepairRoundView = {
  n: number;
  verification: string; // "pass" | "fail" | "flaky" | "skip"
  failing: string[];
  passing: string[];
  fixed: string[];
  regressed: string[];
  costUsd: number;
  durationMs: number;
};

// converged  → the loom landed `ready` (a human accept is still the only path to done)
// escalated  → a guard tripped; the loom is `needs-review` with `reason` from loom.error
// in-progress→ the loop is still iterating (last round still red, loom not settled)
export type RepairOutcome = "converged" | "escalated" | "in-progress";

export type RepairView = {
  rounds: RepairRoundView[];
  outcome: RepairOutcome;
  reason?: string; // escalate reason (loom.error), only when outcome === "escalated"
  totalCostUsd: number;
};

export type VerifyView = {
  root: VerifyReport | null; // the end-of-orchestration integration verify (from feed)
  threads: VerifyReport[]; // per-thread verifies (from each thread's latest attempt)
  repair: RepairView | null; // the auto-repair loop history, null unless it fired
  moatNote: string;
};

const MOAT_NOTE =
  "A green verify lands the loom in ready (awaiting a human accept) — never done. " +
  "A red integration verdict demotes the weave to needs-review. Nothing here can mark itself done.";

// ---------------------------------------------------------------------------
// Small predicates on attempts / panels.
// ---------------------------------------------------------------------------

const ACTIVE_STATES: readonly WorkUnitState[] = ["preparing", "running", "verifying"];
const isActive = (s: WorkUnitState) => ACTIVE_STATES.includes(s);

// Single source of truth for client panel green/red: classifyPanelPure mirrors
// core's fail-closed aggregatePanel (packages/core/src/panel.ts). A boolean view
// for the pure pass/fail rendering sites (Verify Step state, repairs count) so the
// cockpit can never render green where the Verify tab renders red.
const panelIsFail = (pr: PanelReport | null | undefined): boolean =>
  classifyPanelPure(pr) === "fail";

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
    // Empty 'skip' stays 'done' (genuinely-empty behavior preserved); only a real
    // fail from classifyPanelPure (blocker !ok / missing sized blocker) goes red.
    steps.push({ name: "Verify", state: panelIsFail(pr) ? "failed" : "done" });
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
  const repairs = op.attempts.filter((a) => classifyPanelPure(a.panelReport) === "fail").length;
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

  // Session identity per lane: the executor emits {type:"session", sessionId}
  // for the operator (no pieceId) and {type:"session", pieceId, sessionId} for
  // each fan-out piece (executor.ts). Fold those into a map so the roster can
  // identify each agent by its Agent-SDK session. Session events are metadata —
  // they stay OUT of eventsToTranscript (the transcript body), surfaced only in
  // the per-agent header.
  const sessionByPiece = new Map<string | undefined, string>();
  for (const ev of opEvents) {
    if (ev.type === "session") {
      const sid = (ev as { sessionId?: string }).sessionId;
      if (sid) sessionByPiece.set(evPiece(ev), sid);
    }
  }
  const subAgentDone = new Map(subAgents.map((s) => [s.id, s.done]));

  // Roster: operator + fan-out pieces + critics.
  const roster: RosterEntry[] = [];

  roster.push({
    key: "op",
    label: `operator ${op.id}`,
    role: "builder",
    // The event-stream session id (freshest) wins; fall back to the persisted
    // attempt.sessionId so a payload without session events still identifies it.
    sessionId: sessionByPiece.get(undefined) ?? latest?.sessionId,
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
      label: `piece ${shortId(id)}`,
      role: "builder",
      sessionId: sessionByPiece.get(id),
      done: subAgentDone.get(id),
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
    switch (classifyPanelPure(lastPanel.report)) {
      case "fail":
        return "Verify failed — repair loop engaged";
      case "pass":
        return "Verify passed";
      default:
        // skip/no floor — a panel ran but produced no independent verdict. Never
        // render this as "Verify passed" (that would fabricate a green).
        return "Verify ran but produced no independent verdict";
    }
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
        switch (classifyPanelPure(report)) {
          case "fail":
            log.push({ ts, kind: "fail", title: "Verify failed — handed a repro back to the builder" });
            break;
          case "pass":
            log.push({ ts, kind: "ok", title: "Verify passed" });
            break;
          default:
            // skip/no floor: a panel ran but yielded no independent verdict — an
            // honest non-ok row, NEVER green. Uses the fail|ok|info|observe vocab.
            log.push({ ts, kind: "info", title: "Verify ran — no independent verdict" });
            break;
        }
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
// Verify tab derivation (M1).
// ---------------------------------------------------------------------------

const asStr = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const optStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

// Sized blocker lenses that never reported a verdict (crash/timeout/no emit) —
// core drops them from `critics` (critic.ts) but keeps them in `sized`, and
// aggregatePanel (panel.ts) treats a missing blocker lens as a failure to clear.
// We must mirror that exactly, else a thread core deemed unverifiable would
// render as a fabricated green. Also names them so "must clear" explains the fail.
function missingBlockerLenses(pr: PanelReport | null | undefined): string[] {
  const critics = pr?.critics ?? [];
  return (pr?.sized ?? [])
    .filter((l) => l.blocker && !critics.some((c) => c.lens === l.lens))
    .map((l) => l.lens);
}

// Re-classify a completed panel INDEPENDENTLY (mirrors panel.ts:aggregatePanel's
// §M.3 floor + blocker rules) — never trusts a builder self-report. An empty or
// floorless panel is not a pass; it's honestly "skip" (no floor) / "fail".
function classifyPanelPure(pr: PanelReport | null | undefined): AssertionOutcome {
  const critics = pr?.critics ?? [];
  // Source of truth: packages/core/src/panel.ts:aggregatePanel (now fail-closed).
  // Compute the missing sized-blocker set up FRONT so it also decides the
  // empty-critics case: a sized blocker lens that never reported fails the panel
  // even with zero critics present — the vacuous-panel hole aggregatePanel closes.
  // A genuinely empty panel (no critics AND no sized blocker) stays an honest skip.
  const missing = missingBlockerLenses(pr);
  if (critics.length === 0) return missing.length > 0 ? "fail" : "skip";
  const hasFloor = critics.some(
    (c) => (c.class === "adversarial" || c.class === "reproduction") && c.blocker,
  );
  if (!hasFloor) return "fail"; // floorless panel is illegal — never a silent pass
  if (critics.some((c) => c.blocker && !c.ok)) return "fail";
  // A sized blocker lens that never reported must fail the panel, same as core.
  if (missing.length > 0) return "fail";
  const blockerFindings = critics.flatMap((c) => c.findings.filter((f) => f.severity === "blocker"));
  return blockerFindings.length > 0 ? "fail" : "pass";
}

// Fold the §2 verifier/critic process events into an ordered live timeline. Any
// feed missing these events yields [] — the UI then says so honestly rather than
// inventing a stream.
function foldVerifySteps(feed: LoomEvent[]): VerifyStep[] {
  const steps: VerifyStep[] = [];
  for (const ev of feed) {
    const e = ev as Record<string, unknown>;
    switch (ev.type) {
      case "verifier-text":
        steps.push({ k: "text", who: "verifier", text: asStr(e.text) });
        break;
      case "critic-text":
        steps.push({ k: "text", who: asStr(e.lens) || "critic", text: asStr(e.text) });
        break;
      case "verifier-step":
        steps.push({ k: "tool", who: "verifier", name: asStr(e.name) || "tool", input: optStr(e.input) });
        break;
      case "critic-step":
        steps.push({ k: "tool", who: asStr(e.lens) || "critic", name: asStr(e.name) || "tool", input: optStr(e.input) });
        break;
      case "verifier-observation":
        steps.push({ k: "observation", who: "verifier", kind: asStr(e.kind) || "result", output: optStr(e.output) });
        break;
      case "critic-observation":
        steps.push({ k: "observation", who: asStr(e.lens) || "critic", kind: asStr(e.kind) || "result", output: optStr(e.output) });
        break;
      case "panel-sized":
        steps.push({
          k: "sized",
          sized: (Array.isArray(e.sized) ? (e.sized as LensSpec[]) : []),
          sizedFrom: (e.sizedFrom && typeof e.sizedFrom === "object"
            ? (e.sizedFrom as Record<string, number>)
            : undefined),
        });
        break;
      case "critic-start":
        steps.push({ k: "critic-start", lens: asStr(e.lens) || "critic", blocker: !!e.blocker });
        break;
    }
  }
  return steps;
}

const ACTIVE_VERIFY_STATES: readonly WorkUnitState[] = ["queued", "preparing", "running", "verifying"];

// A thread's INDEPENDENT verdict, re-derived from its latest attempt's artifacts
// (panel → verifier → gates). Never reads the builder's own verdict.
function threadVerdict(t: Loom, latest: AttemptRecord | undefined): AssertionOutcome {
  // Route through the fail-closed classifier whenever a panel RAN — not only when
  // critics reported. A vacuous panel (critics: [], sized: [<blockers>]) — every
  // critic crashed/timed-out — must fail-close via classifyPanelPure (returns
  // 'fail' on missing sized blockers), never fall through to gates and fabricate a
  // green. A genuinely-empty panel (no critics, no sized blockers) returns 'skip',
  // which renders muted — never green. Matches deriveSteps/repairs/core.
  if (latest?.panelReport) return classifyPanelPure(latest.panelReport);
  if (latest?.verifierReport) return latest.verifierReport.ok ? "pass" : "fail";
  if (gatesRan(latest?.gates)) return gatesFailed(latest?.gates) ? "fail" : "pass";
  if (!latest) return "pending";
  if (ACTIVE_VERIFY_STATES.includes(t.state)) return "pending";
  return "skip"; // settled, but no executable/independent check produced a verdict
}

// A per-thread report, reconstructed PURELY from the loom's latest attempt — no
// events needed (the attempt carries panelReport/verifierReport/gates/verdict).
function threadReport(t: Loom): VerifyReport {
  const latest = t.attempts.at(-1);
  const pr = latest?.panelReport ?? null;
  const vr = latest?.verifierReport ?? null;
  const gates = latest?.gates ?? [];
  const critics = pr?.critics ?? [];
  const source: VerifyReport["source"] = pr ? "panel" : vr ? "verifier" : gates.length > 0 ? "gates" : "none";
  return {
    scope: "thread",
    id: t.id,
    title: t.title,
    verdict: threadVerdict(t, latest),
    source,
    // A contract-required loom that skips was HELD (no promotion); a plain one is
    // promotable. We can't read the attempt's runtime panelRequired, so proxy it
    // off contractRequired — the field that drove that very decision in core.
    panelRequired: t.contractRequired ?? false,
    reason: undefined,
    gates,
    critics,
    legacy: vr,
    mustClearFailed: [
      ...critics.filter((c) => c.blocker && !c.ok).map((c) => c.lens),
      ...missingBlockerLenses(pr).map((l) => `${l} (no verdict)`),
    ],
    advisory: critics.filter((c) => !c.blocker).map((c) => c.lens),
    url: pr?.url || vr?.url || undefined,
    steps: [],
    builderVerdict: latest?.verdict ? { ok: latest.verdict.ok, summary: latest.verdict.summary } : null,
  };
}

// The end-of-orchestration INTEGRATION verify, folded from the ROOT feed. A woven
// root never builds itself, so every panel/gate/critic event on its own log comes
// from runIntegrationVerify. Returns null until an integration verify has actually
// left a trace (no fabricated "pending" block).
function rootReport(loom: Loom, feed: LoomEvent[]): VerifyReport | null {
  const rev = [...feed].reverse();
  const term = rev.find((e) => e.type === "integration-verify" || e.type === "weave-verify") as
    | { verification?: string }
    | undefined;
  const lastPanel = rev.find(
    (e) => e.type === "panel" && !!(e as { report?: PanelReport | null }).report,
  ) as { report?: PanelReport | null } | undefined;
  const summary = rev.find((e) => e.type === "verify-summary") as
    | { source?: string; panelRequired?: boolean; reason?: string }
    | undefined;

  // Latest GateResult per name (a re-verify re-runs the same gates).
  const gateMap = new Map<string, GateResult>();
  for (const e of feed) {
    if (e.type !== "gate") continue;
    const g = (e as { result?: GateResult }).result;
    if (g) gateMap.set(g.name, g);
  }
  const gates = [...gateMap.values()];
  const pr = lastPanel?.report ?? null;

  // Nothing to show until an integration verify actually ran or emitted evidence.
  if (!term && !pr && gates.length === 0) return null;

  const critics = pr?.critics ?? [];
  const v = term?.verification;
  const verdict: AssertionOutcome =
    v === "pass" || v === "fail" || v === "flaky" || v === "skip"
      ? v
      : pr
        ? classifyPanelPure(pr)
        : gates.length > 0
          ? gates.every((g) => g.ok)
            ? "pass"
            : "fail"
          : "pending";

  const s = summary?.source;
  const source: VerifyReport["source"] =
    s === "panel" || s === "verifier" || s === "gates"
      ? s
      : pr
        ? "panel"
        : gates.length > 0
          ? "gates"
          : "none";

  return {
    scope: "integration",
    id: loom.id,
    title: "Integration verify — the whole weave",
    verdict,
    source,
    panelRequired: summary?.panelRequired ?? true,
    reason: summary?.reason,
    gates,
    critics,
    legacy: null,
    mustClearFailed: [
      ...critics.filter((c) => c.blocker && !c.ok).map((c) => c.lens),
      ...missingBlockerLenses(pr).map((l) => `${l} (no verdict)`),
    ],
    advisory: critics.filter((c) => !c.blocker).map((c) => c.lens),
    url: pr?.url || undefined,
    steps: foldVerifySteps(feed),
    builderVerdict: null,
  };
}

// The auto-repair loop history, derived purely from the root loom. `repairHistory`
// is absent unless the M4 autoRepair flag fired, so this returns null on every
// flag-off loom (byte-identical to today's Verify tab). The outcome is read off
// the loom's settled state — never inferred from a model verdict — and the
// escalate reason is surfaced verbatim from `loom.error`.
export function deriveRepair(loom: Loom): RepairView | null {
  const history = loom.repairHistory ?? [];
  if (history.length === 0) return null;

  // Union of every id that was ever green in a strictly-earlier round — the set
  // the convergence guard intersects with F_n to catch a regression.
  const rounds: RepairRoundView[] = history.map((r: RepairRound, i) => {
    const prev = i > 0 ? history[i - 1] : undefined;
    const priorPassing = new Set(history.slice(0, i).flatMap((p) => p.passingIds));
    const failing = uniqSorted(r.failingIds);
    const passing = uniqSorted(r.passingIds);
    const fixed = prev
      ? uniqSorted(prev.failingIds.filter((id) => !r.failingIds.includes(id)))
      : [];
    const regressed = uniqSorted(r.failingIds.filter((id) => priorPassing.has(id)));
    return {
      n: r.n,
      verification: r.verification,
      failing,
      passing,
      fixed,
      regressed,
      costUsd: r.costUsd,
      durationMs: Math.max(0, r.endedAt - r.startedAt),
    };
  });

  const last = history[history.length - 1];
  const cleared = last.failingIds.length === 0;
  const outcome: RepairOutcome = cleared
    ? "converged"
    : loom.state === "needs-review"
      ? "escalated"
      : "in-progress";

  return {
    rounds,
    outcome,
    ...(outcome === "escalated" && loom.error ? { reason: loom.error } : {}),
    totalCostUsd: history.reduce((sum, r) => sum + (r.costUsd || 0), 0),
  };
}

const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

// The Verify tab's whole derivation. Mirrors deriveGodView's operator split: a
// WOVEN root's threads are its child looms (their verifies ride each child's
// attempt); a single loom is its own one thread (its verify + process steps ride
// the root feed). The integration `root` report is folded from the root feed and
// is present only once an integration re-verify has run.
export function deriveVerify(loom: Loom, threads: Loom[], feed: LoomEvent[]): VerifyView {
  const woven = isWoven(loom);
  const threadLooms = woven ? threads : [loom];
  const threadReports = threadLooms.map(threadReport);
  // A single loom's verifier/critic process events land on the root feed — attach
  // them to its one thread report so its live timeline is inspectable too.
  if (!woven && threadReports[0]) threadReports[0].steps = foldVerifySteps(feed);
  return {
    root: woven ? rootReport(loom, feed) : null,
    threads: threadReports,
    repair: deriveRepair(loom),
    moatNote: MOAT_NOTE,
  };
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
    verify: deriveVerify(loom, threads, events),
  };
}
