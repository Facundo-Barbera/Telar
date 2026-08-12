// LANE: loom — fixture data for the "Weave view: anchor + rail" god-view
// redesign candidate. Ported from the approved mockup (scratchpad/
// anchor-rail-spec.html) as a REAL run: P10 · Carga lite + Vista cliente, mid
// mediation-exhausted escalation on subgoal P10-B. Data-only (no JSX), so it
// stays framework-neutral — see ./fixtures.ts for the same convention. The
// status vocabulary mirrors godview.ts (GodStatusKind + WorkUnitState) so the
// rail/anchor can render through the production StatusBadge, exactly like
// ./fixtures.ts's DEMO_THREADS.
import type { WorkUnitState } from "@telar/core";
import type { GodStatusKind } from "@/components/looms/godview";

export const WEAVE_ID = "ozom-gv";
export const WEAVE_TITLE = "P10 · Carga lite + Vista cliente";
export const WEAVE_TITLE_SUB = "(+ AI carga-lite prefill)";
export const WEAVE_STATE_LABEL = "running";
export const WEAVE_SPEND_USD = 15.13;
export const WEAVE_ELAPSED = "1h05m";

export const BANNER_TEXT = "2 threads still building — nothing to do";
export const BANNER_MOAT =
  "The weave can't come off the loom on its own. Promotion to done needs a passing independent verify.";

export const ORCH_SUBTITLE = "weaver · owns the loop";
export const ORCH_PHASE = "schedule";

// The one fact worth a human's attention right now — shared verbatim by the
// rail's orchestrator lane, the anchor's escalation callout, and the top
// decision-log entry, exactly as the mockup repeats it in all three spots.
export const ESCALATION_TEXT =
  "required subgoal `P10-B` needs-review — mediation exhausted, escalating";

// The orchestrator's own inner loop (doctrine: plan → schedule → observe →
// decide ↺), current phase lit.
export type TickState = "done" | "active" | "idle";
export type TickStage = { name: string; state: TickState };
export const TICK_STAGES: TickStage[] = [
  { name: "plan", state: "done" },
  { name: "schedule", state: "active" },
  { name: "observe", state: "idle" },
  { name: "decide", state: "idle" },
];

// Recent decisions — the orchestrator's own log, newest first (matches the
// mockup's 11 entries exactly). `` `code` `` spans render as inline mono
// chips (see renderInline in weave-view.tsx); `emph` bolds the row's text,
// same as the mockup's `.tlw-t-item.emph`.
export type WeaveDecisionKind = "ok" | "fail" | "block" | "mediate" | "hold" | "spawn" | "schedule";
export type WeaveDecision = { kind: WeaveDecisionKind; text: string; emph?: boolean };

export const ORCHESTRATOR_DECISIONS: WeaveDecision[] = [
  { kind: "fail", emph: true, text: "Weave rolled up → failed" },
  { kind: "fail", text: "F settled · failed" },
  { kind: "block", emph: true, text: ESCALATION_TEXT },
  { kind: "mediate", text: "mediating `P10-B` (needs-review) — attempt 2/2 before any human park" },
  { kind: "mediate", text: "mediating `P10-B` (failed) — attempt 1/2 before any human park" },
  { kind: "fail", text: "`P10-B` settled · failed" },
  { kind: "hold", text: "holding — waiting on in-flight threads before the next move" },
  { kind: "spawn", text: "Spawned thread for `P10-B`" },
  { kind: "spawn", text: "Spawned thread for `F`" },
  { kind: "schedule", text: "schedule 2 — `F` first (unblocks 4 downstream); all ready pieces fit the pool + budget" },
  { kind: "ok", text: "Charter approved · `auto:weave-planner`" },
];

// The rail: compact thread lanes. Both threads are queued behind the pool —
// neither has started building yet, so each mini-feed is short (decomposed →
// scheduling note), the honest state for a not-yet-live thread.
export type WeaveEventKind = "plan" | "info";
export type WeaveEvent = { kind: WeaveEventKind; text: string };

export type WeaveThreadFixture = {
  id: string;
  subGoalId: string;
  railId?: string; // only the mockup's first lane shows a truncated id chip
  title: string;
  statusKind: GodStatusKind;
  state: WorkUnitState;
  active: boolean;
  statusLabel: string;
  now: string;
  objective: string;
  agentRole: string;
  events: WeaveEvent[];
};

export const WEAVE_THREADS: WeaveThreadFixture[] = [
  {
    id: "th-client-role",
    subGoalId: "s-client-role",
    railId: "loom_mrl…",
    title: "Client role + access seeding",
    statusKind: "wait",
    state: "queued",
    active: false,
    statusLabel: "queued",
    now: "Waiting for a scheduling slot — Foundation is holding the pool while it builds.",
    objective:
      "Seed the client role and its row-level access policies so a client login sees only its own campaign data.",
    agentRole: "builder",
    events: [
      { kind: "plan", text: "Decomposed from the P10 charter." },
      { kind: "info", text: "Not yet scheduled — waiting for a pool slot behind Foundation." },
    ],
  },
  {
    id: "th-foundation",
    subGoalId: "s-foundation",
    title: "Foundation — pd.campaign_plan schema, RPCs, un-stub alerts/lifecy…",
    statusKind: "wait",
    state: "queued",
    active: false,
    statusLabel: "queued",
    now: "Scheduled first — unblocks 4 downstream threads. Queued for the next pool slot.",
    objective:
      "Add the pd.campaign_plan schema and RPCs, and un-stub the alerts/lifecycle hooks that read from it.",
    agentRole: "builder",
    events: [
      { kind: "plan", text: "Decomposed from the P10 charter." },
      { kind: "info", text: "schedule 2 — chosen first; unblocks 4 downstream. All ready pieces fit the pool + budget." },
    ],
  },
];

export function threadFixtureById(id: string): WeaveThreadFixture | undefined {
  return WEAVE_THREADS.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Verify tab — owner decision: VERIFY stays its own full tab (not a rail
// item). This is the REAL P10 verification contract mid-run: verbatim ids
// and run commands, `B-client-role-isolated` settled failed (the same
// `P10-B` fact ESCALATION_TEXT already names above), everything else
// pending — nothing else has run yet. Mirrors the type/state vocabulary the
// production Verify tab renders (see components/looms/spec-bundle.tsx's
// AssertionRow + components/looms/god-view.tsx's OUTCOME_BADGE) but kept
// local and data-only — this fixture has no ContractAssertion evidence to
// carry, just id/type/description/state/command.
// ---------------------------------------------------------------------------

export type VerifyAssertionType = "command" | "live-critic";
export type VerifyAssertionState = "proven" | "failed" | "pending";

export type VerifyAssertion = {
  id: string;
  type: VerifyAssertionType;
  description: string;
  state: VerifyAssertionState;
  command?: string; // shown in mono, "command"-type assertions only
};

export const VERIFY_ASSERTIONS: VerifyAssertion[] = [
  {
    id: "suite-green",
    type: "command",
    description: "Whole-repo gate — typecheck, lint, and packages/module-pd's own suite all pass.",
    state: "pending",
    command: "bun run typecheck && bun run lint && bun test packages/module-pd",
  },
  {
    id: "db-tests-green",
    type: "command",
    description: "Database test suite passes end to end against a fresh compose.",
    state: "pending",
    command: "bun run test:db",
  },
  {
    id: "F-plan-vs-actual-join",
    type: "command",
    description:
      "`pd.campaign_plan` joins cleanly against actuals — the plan-vs-actual query returns matching rows.",
    state: "pending",
    command: "bun run test:db",
  },
  {
    id: "F-alerts-unstubbed",
    type: "command",
    description: "Alert and lifecycle hooks read from `pd.campaign_plan`, not the stub they shipped against.",
    state: "pending",
    command: "bun test packages/module-pd",
  },
  {
    id: "A-carga-lite-saves",
    type: "command",
    description: "The carga-lite form saves a campaign plan end to end.",
    state: "pending",
    command: "bun test packages/module-pd",
  },
  {
    id: "B-client-role-isolated",
    type: "command",
    description: "A client login sees only its own campaign data — row-level access is isolated by role.",
    state: "failed",
    command: "bun run db:compose && bun test packages/module-client",
  },
  {
    id: "C-client-view-scoped",
    type: "command",
    description: "Vista cliente is scoped to the logged-in client — no cross-account data leaks in.",
    state: "pending",
    command: "bun test packages/module-client && bun run test:db",
  },
  {
    id: "C-performance-export",
    type: "command",
    description: "Vista cliente's export stays inside the performance budget under a realistic dataset.",
    state: "pending",
    command: "bun test packages/module-client",
  },
  {
    id: "AI-prefill-fallback",
    type: "command",
    description: "AI carga-lite prefill degrades to the manual form when the model call fails.",
    state: "pending",
    command: "bun test packages/module-pd",
  },
];

// ---------------------------------------------------------------------------
// Chat tab — the steerer conversation, same P10-B escalation the Weave and
// Verify tabs already show. `` `code` `` spans render inline mono (see
// renderInline in weave-view.tsx), same convention as WeaveDecision.text.
// ---------------------------------------------------------------------------

export type ChatTurn = { from: "human" | "loom"; text: string };

export const WEAVE_CHAT_TURNS: ChatTurn[] = [
  { from: "human", text: "Why does `P10-B` keep failing?" },
  {
    from: "loom",
    text:
      "Two mediation attempts already ran on `B-client-role-isolated`. Both trip on the same root cause: `db:compose` regenerates the role-permissions seed on every run, so the client role's row-level policies come back mismatched against what the migration just created. Attempt 1/2 caught a policy-name mismatch; attempt 2/2 fixed that and hit the same-class drift on a different table. It settled `failed` — this needed a rung above thread mediation.",
  },
  { from: "human", text: "What do you need from me?" },
  {
    from: "loom",
    text:
      "I escalated it. Two ways through: relax `B-client-role-isolated`'s `db:compose` step to a known-safe compose ordering — I can propose that change — or you decide how the role-permissions seed should regenerate (freeze it, or keep auto-regen and fix the drift upstream). That's a scope-of-verification call, not something another mediation retry settles.",
  },
];
