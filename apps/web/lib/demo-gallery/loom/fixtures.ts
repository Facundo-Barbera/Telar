// LANE: loom — rich fixture data for the redesigned Loom view + Thread drawer.
// Data-only (no JSX), so it stays framework-neutral and any client component in
// the lane can import it. Shapes are LOCAL to the demo (not @telar/core) so the
// gallery never touches the real derivation — but the status vocabulary mirrors
// godview.ts (GodStatusKind + WorkUnitState) so we can reuse the production
// StatusBadge and speak the exact same visual language the live cockpit does.
import type { WorkUnitState } from "@telar/core";
import type { GodStatusKind } from "@/components/looms/godview";

// A transcript row — mirrors godview.ts's TranscriptEntry so the L3 viewer can
// render through the same session-style ToolStepRow / MessageResponse the live
// drawer uses.
export type DemoScriptEntry =
  | { k: "say"; text: string }
  | { k: "tool"; name: string; input?: Record<string, unknown>; output?: string; isError?: boolean }
  | { k: "pw"; text: string } // a critic's live Playwright drive step
  | { k: "res"; ok: boolean; text: string }
  | { k: "note"; text: string }
  | { k: "verdict"; ok: boolean; text: string }
  | { k: "meta"; text: string };

export type DemoStepState = "idle" | "active" | "done" | "failed";
export type DemoStep = { name: string; state: DemoStepState; detail?: string; at?: string };

export type DemoGate = {
  name: string;
  ok: boolean | null; // null = still running
  command: string;
  durationMs?: number;
  detail?: string;
};

// One rung of the mediation ladder — the doctrine's escalation chain made
// visible: a thread's own inner loop repairs first; only when exhausted does the
// orchestrator mediate; only when THAT is exhausted does it ping the human.
export type MediationLevel = "thread" | "orchestrator" | "human";
export type MediationOutcome = "repaired" | "regressed" | "escalated" | "pending" | "accepted";
export type DemoMediation = {
  n: number;
  level: MediationLevel;
  actor: string; // "Thread inner loop" | "Orchestrator" | "You"
  trigger: string; // what tripped it
  action: string; // what was tried
  outcome: MediationOutcome;
  fixed?: string[]; // criteria cleared this rung
  stillFailing?: string[]; // criteria still red after it
  costUsd?: number;
  at: string; // relative clock label
};

export type DemoAgentRole = "builder" | "critic";
export type DemoAgentStatus = "live" | "merged" | "failed" | "passed" | "blocking" | "queued";
export type DemoAgent = {
  id: string;
  role: DemoAgentRole;
  label: string;
  now: string; // one-line current activity / verdict
  status: DemoAgentStatus;
  sessionId?: string;
  model?: string;
  account?: string; // critics run on a different account
  costUsd?: number;
  turns?: number;
  lens?: string; // critic lens
  blocker?: boolean; // critic: must-clear vs advisory
  steps: DemoStep[];
  transcript: DemoScriptEntry[];
};

export type DemoFile = { op: "add" | "mod"; path: string; stat: string };

export type DemoThread = {
  id: string;
  title: string;
  subGoalId: string;
  // Status tuple fed straight into the production StatusBadge.
  statusKind: GodStatusKind;
  state: WorkUnitState;
  active: boolean;
  statusLabel: string;
  now: string; // "what's happening now" one-liner
  objective: string;
  summary: string | null;
  dependsOn: string[];
  costUsd: number;
  elapsed: string;
  steps: DemoStep[];
  gates: DemoGate[];
  mediation: DemoMediation[];
  agents: DemoAgent[];
  files: DemoFile[];
  verifyNote: string;
};

// ---------------------------------------------------------------------------
// The weave — one root loom decomposed into five threads in varied states, each
// with a real, replayable transcript. Chosen to exercise every drawer state:
// live fan-out, verifying, needs-review (deep escalation ladder), dead-ended,
// and cleanly promoted.
// ---------------------------------------------------------------------------

export const WEAVE_TITLE = "Realtime CSV export with an audit trail";
export const WEAVE_PROJECT = "aurora";
export const WEAVE_OBJECTIVE =
  "Stream a filtered CSV export end-to-end and record every export in a tamper-evident audit log — with the dashboard keyboard-accessible throughout.";

export const DEMO_THREADS: DemoThread[] = [
  // ── 1. live, fanned out ──────────────────────────────────────────────────
  {
    id: "th_csv_export",
    title: "Streaming CSV endpoint",
    subGoalId: "s1",
    statusKind: "run",
    state: "running",
    active: true,
    statusLabel: "building",
    now: "2 builders weaving in parallel — isolated worktrees, merged on green.",
    objective: "Stream a filtered CSV export from a cold session without buffering the whole set in memory.",
    summary: "Split the endpoint across two disjoint builders — a filtered query builder and a chunked streamer; both merged clean, wiring the route now.",
    dependsOn: [],
    costUsd: 2.14,
    elapsed: "4m 12s",
    steps: [
      { name: "Plan", state: "done", detail: "Split into query + streamer over disjoint files.", at: "0:04" },
      { name: "Build", state: "active", detail: "×2 builders in isolated worktrees.", at: "0:22" },
      { name: "Gate", state: "idle", detail: "runs on green build", at: "—" },
      { name: "Verify", state: "idle", detail: "critic panel after gates", at: "—" },
    ],
    gates: [
      { name: "typecheck", ok: null, command: "bunx tsc -p tsconfig.json --noEmit", detail: "waiting on both lanes to merge" },
      { name: "unit", ok: null, command: "bun test lib/export", detail: "waiting on both lanes to merge" },
    ],
    mediation: [],
    files: [
      { op: "add", path: "lib/export/query.ts", stat: "+41 −0" },
      { op: "add", path: "lib/export/stream.ts", stat: "+63 −0" },
      { op: "mod", path: "app/api/export/route.ts", stat: "+18 −3" },
    ],
    verifyNote: "Verify runs once both lanes merge and the gates go green.",
    agents: [
      {
        id: "op",
        role: "builder",
        label: "Thread operator",
        now: "Wiring both merged pieces into the export route.",
        status: "live",
        sessionId: "sess_op_csv_1a2b",
        model: "opus-4.8",
        costUsd: 0.74,
        turns: 11,
        steps: [
          { name: "Read route", state: "done" },
          { name: "Fan out ×2", state: "done" },
          { name: "Merge lanes", state: "active" },
        ],
        transcript: [
          { k: "say", text: "Reading the current export route, then splitting the work across two helpers over disjoint files so they can weave in parallel." },
          { k: "tool", name: "Read", input: { file_path: "app/api/export/route.ts" }, output: "export async function GET(req: Request) {\n  const rows = await allRows();\n  return csv(rows);\n}", isError: false },
          { k: "say", text: "The current route buffers **every** row before responding. I'll fan out a query lane and a streaming lane, then wire them together." },
          { k: "res", ok: true, text: "spawned 2 builders · isolated worktrees" },
          { k: "say", text: "Both lanes reported merged. Wiring `buildFilter()` into `streamCsv()` on the route now." },
          { k: "tool", name: "Edit", input: { file_path: "app/api/export/route.ts" }, output: "wrote app/api/export/route.ts (+18 −3)", isError: false },
        ],
      },
      {
        id: "piece_query",
        role: "builder",
        label: "Builder · query lane",
        now: "Merged — filtered query builder landed.",
        status: "merged",
        sessionId: "sess_piece_query_7c",
        model: "sonnet-4.8",
        costUsd: 0.28,
        turns: 7,
        steps: [
          { name: "Build filter", state: "done" },
          { name: "Self-test", state: "done" },
          { name: "Merge", state: "done" },
        ],
        transcript: [
          { k: "say", text: "Building the filtered query with `buildFilter()` — pushing the predicate into SQL rather than filtering in JS." },
          { k: "tool", name: "Edit", input: { file_path: "lib/export/query.ts" }, output: "wrote lib/export/query.ts (+41 −0)", isError: false },
          { k: "tool", name: "Bash", input: { command: "bun test lib/export/query.test.ts" }, output: "✓ builds a parameterized filter\n✓ escapes user predicates\n2 pass, 0 fail", isError: false },
          { k: "res", ok: true, text: "success · 7 turns · $0.28" },
          { k: "verdict", ok: true, text: "Filtered query builder complete — predicates parameterized, no string interpolation. Merged to the thread worktree." },
        ],
      },
      {
        id: "piece_stream",
        role: "builder",
        label: "Builder · stream lane",
        now: "Merged — chunked CSV streamer landed.",
        status: "merged",
        sessionId: "sess_piece_stream_9d",
        model: "sonnet-4.8",
        costUsd: 0.33,
        turns: 8,
        steps: [
          { name: "Chunk streamer", state: "done" },
          { name: "Self-test", state: "done" },
          { name: "Merge", state: "done" },
        ],
        transcript: [
          { k: "say", text: "Building the chunked CSV streamer over a `ReadableStream` so we never hold the whole export in memory." },
          { k: "tool", name: "Edit", input: { file_path: "lib/export/stream.ts" }, output: "wrote lib/export/stream.ts (+63 −0)", isError: false },
          { k: "tool", name: "Bash", input: { command: "bun test lib/export/stream.test.ts" }, output: "✓ streams in 16KB chunks\n✓ flushes a trailing partial row\n✓ closes on client abort\n3 pass, 0 fail", isError: false },
          { k: "res", ok: true, text: "success · 8 turns · $0.33" },
          { k: "verdict", ok: true, text: "Chunked streamer complete — constant memory, backpressure-aware. Merged clean." },
        ],
      },
    ],
  },

  // ── 2. verifying ─────────────────────────────────────────────────────────
  {
    id: "th_audit_log",
    title: "Audit-log write",
    subGoalId: "s2",
    statusKind: "verify",
    state: "verifying",
    active: true,
    statusLabel: "verifying",
    now: "The critic panel is driving the live product — reproduction lens in flight.",
    objective: "Record every export in a tamper-evident, append-only audit log with the actor, filter, and row count.",
    summary: "Append-only audit writer landed with a hash chain; gates green, the independent critic panel is driving it now.",
    dependsOn: ["s1"],
    costUsd: 1.86,
    elapsed: "6m 40s",
    steps: [
      { name: "Build", state: "done", at: "0:18" },
      { name: "Gate", state: "done", detail: "3/3 gates green", at: "3:02" },
      { name: "Verify", state: "active", detail: "critic panel driving live", at: "5:40" },
    ],
    gates: [
      { name: "typecheck", ok: true, command: "bunx tsc --noEmit", durationMs: 4200 },
      { name: "unit", ok: true, command: "bun test lib/audit", durationMs: 8100, detail: "11 pass" },
      { name: "lint", ok: true, command: "bunx eslint lib/audit", durationMs: 2600 },
    ],
    mediation: [],
    files: [
      { op: "add", path: "lib/audit/log.ts", stat: "+72 −0" },
      { op: "add", path: "lib/audit/chain.ts", stat: "+44 −0" },
    ],
    verifyNote: "The reproduction critic is exporting from a cold session and asserting the audit row appears with a valid hash link.",
    agents: [
      {
        id: "op",
        role: "builder",
        label: "Thread operator",
        now: "Handed off to verify — awaiting the panel verdict.",
        status: "passed",
        sessionId: "sess_op_audit_3f",
        model: "opus-4.8",
        costUsd: 1.02,
        turns: 14,
        steps: [
          { name: "Design chain", state: "done" },
          { name: "Implement", state: "done" },
          { name: "Gates green", state: "done" },
          { name: "Hand to verify", state: "done" },
        ],
        transcript: [
          { k: "say", text: "Designing an append-only log where each row carries `prevHash` so tampering breaks the chain." },
          { k: "tool", name: "Write", input: { file_path: "lib/audit/chain.ts" }, output: "wrote lib/audit/chain.ts (+44 −0)", isError: false },
          { k: "tool", name: "Write", input: { file_path: "lib/audit/log.ts" }, output: "wrote lib/audit/log.ts (+72 −0)", isError: false },
          { k: "tool", name: "Bash", input: { command: "bun test lib/audit" }, output: "✓ appends with a prevHash link\n✓ detects a mutated row\n✓ records actor + filter + count\n11 pass, 0 fail", isError: false },
          { k: "res", ok: true, text: "gate unit passed · 11 pass" },
          { k: "verdict", ok: true, text: "Tamper-evident audit writer complete — hash chain verified across 11 cases. Handing to the independent panel." },
        ],
      },
      {
        id: "critic_repro",
        role: "critic",
        label: "Critic · reproduction/happy-path",
        now: "Driving the live app from a cold session — in flight.",
        status: "live",
        lens: "reproduction/happy-path",
        blocker: true,
        account: "critic@aurora (isolated)",
        steps: [
          { name: "Cold export", state: "active" },
          { name: "Assert audit row", state: "idle" },
        ],
        transcript: [
          { k: "meta", text: "read-only critic · different account · no Write/Edit/Bash" },
          { k: "pw", text: "Opened http://localhost:4310/export from a fresh session." },
          { k: "pw", text: "Applied filter status=active, requested CSV." },
          { k: "note", text: "Verdict pending — asserting the audit row appears with a valid hash link." },
        ],
      },
    ],
  },

  // ── 3. needs-review — the deep escalation ladder (the star of concern 6) ──
  {
    id: "th_saved_filters",
    title: "Saved filters (keyboard-accessible)",
    subGoalId: "s3",
    statusKind: "block",
    state: "needs-review",
    active: false,
    statusLabel: "needs review",
    now: "Couldn't independently verify the keyboard-nav criterion — no executable check ran to prove it. Review and decide.",
    objective: "Let a user save a filter set and recall it — fully operable by keyboard, WCAG 2.1 AA.",
    summary: "Saved-filter persistence works and gates are green, but the a11y critic couldn't confirm keyboard operability after two thread rebuilds and an orchestrator re-scope.",
    dependsOn: [],
    costUsd: 4.72,
    elapsed: "18m 03s",
    steps: [
      { name: "Build", state: "done", at: "0:20" },
      { name: "Gate", state: "done", detail: "2/2 green", at: "2:40" },
      { name: "Verify", state: "failed", detail: "a11y blocker did not clear", at: "6:10" },
      { name: "Repair ×2", state: "done", detail: "thread inner loop", at: "12:30" },
      { name: "Mediate", state: "done", detail: "orchestrator re-scoped", at: "16:10" },
      { name: "Escalate", state: "active", detail: "→ you", at: "18:03" },
    ],
    gates: [
      { name: "typecheck", ok: true, command: "bunx tsc --noEmit", durationMs: 3900 },
      { name: "unit", ok: true, command: "bun test lib/filters", durationMs: 6200, detail: "save/recall covered · 9 pass" },
    ],
    mediation: [
      {
        n: 1,
        level: "thread",
        actor: "Thread inner loop",
        trigger: "a11y/keyboard-operable (blocker) did not clear — focus trap on the saved-filter menu.",
        action: "Rebuilt the menu with a roving tabindex + explicit Escape handler, re-ran verify.",
        outcome: "regressed",
        fixed: ["focus enters the menu"],
        stillFailing: ["Escape returns focus to the trigger"],
        costUsd: 1.1,
        at: "8:05",
      },
      {
        n: 2,
        level: "thread",
        actor: "Thread inner loop",
        trigger: "a11y/keyboard-operable still red — Escape restored focus to <body>, not the trigger.",
        action: "Captured the trigger ref and restored focus on close; re-ran verify.",
        outcome: "regressed",
        stillFailing: ["arrow-key navigation between saved filters"],
        costUsd: 1.28,
        at: "12:30",
      },
      {
        n: 3,
        level: "orchestrator",
        actor: "Orchestrator",
        trigger: "Thread exhausted its bounded repair budget (2 attempts) with the a11y blocker still open.",
        action: "Mediated — re-scoped the failing criterion into an explicit arrow-key contract and handed an enriched repro back to a fresh builder.",
        outcome: "regressed",
        stillFailing: ["arrow-key navigation could not be observed by the critic — no executable a11y harness in this project"],
        costUsd: 0.94,
        at: "16:10",
      },
      {
        n: 4,
        level: "human",
        actor: "You",
        trigger: "No executable check exists to prove keyboard operability; the critic can drive but can't assert it deterministically.",
        action: "Escalated to needs-review — the orchestrator won't fabricate a green it can't independently prove.",
        outcome: "escalated",
        at: "18:03",
      },
    ],
    files: [
      { op: "add", path: "lib/filters/saved.ts", stat: "+58 −0" },
      { op: "mod", path: "components/filters/menu.tsx", stat: "+37 −12" },
    ],
    verifyNote: "The must-clear a11y lens never reported a deterministic verdict — the panel fails closed rather than promoting an unproven thread.",
    agents: [
      {
        id: "op",
        role: "builder",
        label: "Thread operator",
        now: "Exhausted the bounded repair loop; handed to the orchestrator.",
        status: "failed",
        sessionId: "sess_op_filters_5a",
        model: "opus-4.8",
        costUsd: 2.9,
        turns: 31,
        steps: [
          { name: "Build persistence", state: "done" },
          { name: "Gates green", state: "done" },
          { name: "a11y repair ×2", state: "failed" },
        ],
        transcript: [
          { k: "say", text: "Saved-filter persistence with recall is straightforward — storing under a per-user key and rehydrating on mount." },
          { k: "tool", name: "Write", input: { file_path: "lib/filters/saved.ts" }, output: "wrote lib/filters/saved.ts (+58 −0)", isError: false },
          { k: "tool", name: "Bash", input: { command: "bun test lib/filters" }, output: "✓ saves a named filter\n✓ recalls by name\n✓ overwrites on same name\n9 pass, 0 fail", isError: false },
          { k: "res", ok: true, text: "gates green · 9 pass" },
          { k: "note", text: "Verify failed — a11y/keyboard-operable (blocker) did not clear. Repro handed back." },
          { k: "tool", name: "Edit", input: { file_path: "components/filters/menu.tsx" }, output: "wrote components/filters/menu.tsx (+22 −4) — roving tabindex", isError: false },
          { k: "note", text: "Repair attempt 2 — Escape now restores focus to the trigger; arrow-key nav still unobserved." },
          { k: "tool", name: "Edit", input: { file_path: "components/filters/menu.tsx" }, output: "wrote components/filters/menu.tsx (+15 −8)", isError: false },
          { k: "verdict", ok: false, text: "Bounded repair budget exhausted. Keyboard operability of arrow-key navigation could not be independently proven — no executable a11y harness. Handing to the orchestrator." },
        ],
      },
      {
        id: "critic_a11y",
        role: "critic",
        label: "Critic · a11y/keyboard-operable",
        now: "Blocking — could not deterministically assert arrow-key navigation.",
        status: "blocking",
        lens: "a11y/keyboard-operable",
        blocker: true,
        account: "critic@aurora (isolated)",
        steps: [
          { name: "Tab into menu", state: "done" },
          { name: "Escape restores focus", state: "done" },
          { name: "Arrow-key nav", state: "failed" },
        ],
        transcript: [
          { k: "meta", text: "read-only critic · different account · no Write/Edit/Bash" },
          { k: "pw", text: "Tabbed into the saved-filter menu — focus lands on the first item. ✓" },
          { k: "pw", text: "Pressed Escape — focus returned to the trigger. ✓" },
          { k: "pw", text: "Pressed ArrowDown — DOM focus did not move; no visible focus ring change to assert against." },
          { k: "verdict", ok: false, text: "Cannot clear a11y/keyboard-operable: arrow-key navigation between saved filters is not observable through a deterministic check. This is a must-clear lens — failing closed." },
          { k: "note", text: "blocker · arrow-key navigation — the component may be correct, but the criterion is unprovable without an executable a11y harness." },
          { k: "meta", text: "live tool-by-tool steps not captured — verdict + evidence only" },
        ],
      },
      {
        id: "critic_contrast",
        role: "critic",
        label: "Critic · a11y/contrast",
        now: "Passed — advisory lens, cleared.",
        status: "passed",
        lens: "a11y/contrast",
        blocker: false,
        account: "critic@aurora (isolated)",
        steps: [{ name: "Contrast audit", state: "done" }],
        transcript: [
          { k: "meta", text: "read-only critic · advisory (non-blocker) · different account" },
          { k: "verdict", ok: true, text: "All saved-filter UI text clears 4.5:1 against its background." },
          { k: "meta", text: "live tool-by-tool steps not captured — verdict + evidence only" },
        ],
      },
    ],
  },

  // ── 4. failed / dead-ended ────────────────────────────────────────────────
  {
    id: "th_rate_limit",
    title: "Export rate limiter",
    subGoalId: "s4",
    statusKind: "repair",
    state: "failed",
    active: false,
    statusLabel: "failed",
    now: "Dead-ended — the loop couldn't land this thread. Resume to retry, or send it back with feedback.",
    objective: "Cap exports at 5 / minute / user with a clear 429 and a Retry-After header.",
    summary: "The limiter kept oscillating: fixing the burst window regressed the sliding-window test, and vice versa — the repair loop tripped its oscillation guard.",
    dependsOn: ["s2"],
    costUsd: 3.41,
    elapsed: "14m 22s",
    steps: [
      { name: "Build", state: "done", at: "0:16" },
      { name: "Gate", state: "failed", detail: "unit red", at: "3:40" },
      { name: "Repair ×3", state: "failed", detail: "oscillation guard tripped", at: "14:22" },
    ],
    gates: [
      { name: "typecheck", ok: true, command: "bunx tsc --noEmit", durationMs: 3800 },
      { name: "unit", ok: false, command: "bun test lib/ratelimit", durationMs: 5400, detail: "sliding-window test red" },
    ],
    mediation: [
      {
        n: 1,
        level: "thread",
        actor: "Thread inner loop",
        trigger: "unit gate red — burst of 6 requests was allowed through the fixed window.",
        action: "Switched from a fixed to a sliding window; re-ran the gate.",
        outcome: "regressed",
        fixed: ["burst is now rejected at the boundary"],
        stillFailing: ["sliding-window test: Retry-After off by the partial second"],
        costUsd: 1.02,
        at: "6:10",
      },
      {
        n: 2,
        level: "thread",
        actor: "Thread inner loop",
        trigger: "Retry-After rounding regressed the boundary test that had just passed.",
        action: "Rounded Retry-After up; re-ran the gate.",
        outcome: "regressed",
        stillFailing: ["burst test now red again — rounding widened the window"],
        costUsd: 0.88,
        at: "10:05",
      },
      {
        n: 3,
        level: "orchestrator",
        actor: "Orchestrator",
        trigger: "Guard-4 oscillation: burst and boundary tests trade green/red across rounds — no monotone progress.",
        action: "Halted the repair loop rather than burn budget on a cycle; marked the thread failed with the oscillation trace.",
        outcome: "escalated",
        stillFailing: ["lib/ratelimit sliding-window ⟷ burst oscillation"],
        at: "14:22",
      },
    ],
    files: [{ op: "add", path: "lib/ratelimit/window.ts", stat: "+51 −19" }],
    verifyNote: "No promotion — the oscillation guard stops the loop before it fabricates a green by luck of the last round.",
    agents: [
      {
        id: "op",
        role: "builder",
        label: "Thread operator",
        now: "Dead-ended after 3 repair rounds — oscillation guard tripped.",
        status: "failed",
        sessionId: "sess_op_rate_2c",
        model: "opus-4.8",
        costUsd: 3.41,
        turns: 27,
        steps: [
          { name: "Fixed window", state: "done" },
          { name: "Sliding window", state: "done" },
          { name: "Oscillation", state: "failed" },
        ],
        transcript: [
          { k: "say", text: "Starting with a fixed-window limiter keyed by user id." },
          { k: "tool", name: "Write", input: { file_path: "lib/ratelimit/window.ts" }, output: "wrote lib/ratelimit/window.ts (+51 −0)", isError: false },
          { k: "tool", name: "Bash", input: { command: "bun test lib/ratelimit" }, output: "✗ rejects a burst at the window boundary\n  expected 429, got 200\n1 fail, 4 pass", isError: true },
          { k: "note", text: "Repair 1 — moved to a sliding window." },
          { k: "tool", name: "Bash", input: { command: "bun test lib/ratelimit" }, output: "✗ Retry-After matches the remaining window\n  expected 42, got 43\n1 fail, 4 pass", isError: true },
          { k: "note", text: "Repair 2 — rounded Retry-After up; boundary test regressed." },
          { k: "tool", name: "Bash", input: { command: "bun test lib/ratelimit" }, output: "✗ rejects a burst at the window boundary\n  expected 429, got 200\n1 fail, 4 pass", isError: true },
          { k: "verdict", ok: false, text: "Oscillation: each fix regresses the last. Stopping — this needs a single unified window model, not another patch. Handing back failed." },
        ],
      },
    ],
  },

  // ── 5. done / promoted ────────────────────────────────────────────────────
  {
    id: "th_schema",
    title: "Export schema migration",
    subGoalId: "s0",
    statusKind: "done",
    state: "done",
    active: false,
    statusLabel: "passed",
    now: "Verified against its story and promoted.",
    objective: "Add the export_jobs + audit columns migration, reversible, with a backfill.",
    summary: "Reversible migration with a backfill; gates green and the reproduction critic confirmed a round-trip up/down on a seeded database.",
    dependsOn: [],
    costUsd: 1.09,
    elapsed: "3m 51s",
    steps: [
      { name: "Build", state: "done", at: "0:12" },
      { name: "Gate", state: "done", detail: "2/2 green", at: "1:50" },
      { name: "Verify", state: "done", detail: "critic passed", at: "3:20" },
      { name: "Promote", state: "done", at: "3:51" },
    ],
    gates: [
      { name: "migrate:up", ok: true, command: "bun run migrate up && migrate down", durationMs: 5100, detail: "round-trip clean" },
      { name: "unit", ok: true, command: "bun test db/migrations", durationMs: 3200 },
    ],
    mediation: [],
    files: [
      { op: "add", path: "db/migrations/0007_export_jobs.sql", stat: "+34 −0" },
      { op: "add", path: "db/migrations/0007_export_jobs.down.sql", stat: "+9 −0" },
    ],
    verifyNote: "Green landed the thread in ready; promoted after the parent weave rolled up. Only a human accept writes done at the loom level.",
    agents: [
      {
        id: "op",
        role: "builder",
        label: "Thread operator",
        now: "Merged and promoted.",
        status: "merged",
        sessionId: "sess_op_schema_8e",
        model: "sonnet-4.8",
        costUsd: 0.71,
        turns: 9,
        steps: [
          { name: "Write migration", state: "done" },
          { name: "Round-trip", state: "done" },
          { name: "Verify", state: "done" },
        ],
        transcript: [
          { k: "say", text: "Adding the `export_jobs` table plus audit columns, with a matching down migration so it's reversible." },
          { k: "tool", name: "Write", input: { file_path: "db/migrations/0007_export_jobs.sql" }, output: "wrote 0007_export_jobs.sql (+34 −0)", isError: false },
          { k: "tool", name: "Bash", input: { command: "bun run migrate up && bun run migrate down" }, output: "up: applied 0007 in 41ms\ndown: reverted 0007 in 22ms\nschema matches baseline ✓", isError: false },
          { k: "res", ok: true, text: "round-trip clean · 2 gates green" },
          { k: "verdict", ok: true, text: "Reversible migration + backfill complete — up/down round-trip verified against a seeded database." },
        ],
      },
      {
        id: "critic_repro",
        role: "critic",
        label: "Critic · reproduction/migration",
        now: "Passed — round-trip confirmed on a seeded DB.",
        status: "passed",
        lens: "reproduction/migration",
        blocker: true,
        account: "critic@aurora (isolated)",
        steps: [{ name: "Seed + round-trip", state: "done" }],
        transcript: [
          { k: "meta", text: "read-only critic · different account" },
          { k: "verdict", ok: true, text: "Applied 0007 to a seeded copy, exercised an export job, rolled back — no residue, no data loss. Cleared." },
          { k: "meta", text: "live tool-by-tool steps not captured — verdict + evidence only" },
        ],
      },
    ],
  },
];

// ── Orchestrator-level derived facts (for the concern-6 loom-page variants) ──

export type WeaveActivity = {
  at: string;
  kind: "plan" | "ok" | "fail" | "block" | "info" | "observe";
  title: string;
  detail?: string;
};

export const WEAVE_ACTIVITY: WeaveActivity[] = [
  { at: "18:03", kind: "block", title: "Escalated s3 → you", detail: "a11y keyboard-nav unprovable after 2 thread repairs + 1 mediation" },
  { at: "16:10", kind: "info", title: "Orchestrator mediated s3", detail: "re-scoped the failing criterion; handed enriched repro to a fresh builder" },
  { at: "14:22", kind: "fail", title: "s4 failed — oscillation guard tripped", detail: "burst ⟷ sliding-window tests traded green/red" },
  { at: "12:30", kind: "info", title: "s3 thread repair ×2", detail: "focus restore fixed; arrow-key nav still unobserved" },
  { at: "6:40", kind: "observe", title: "s2 handed to verify", detail: "gates green — reproduction critic driving" },
  { at: "3:51", kind: "ok", title: "s0 promoted", detail: "migration round-trip verified" },
  { at: "0:22", kind: "plan", title: "Fanned s1 out into 2 builders", detail: "query lane + stream lane, disjoint files" },
  { at: "0:04", kind: "plan", title: "Charter approved · decomposed into 5 threads" },
];

// The plan graph (subgoal → deps) for the org-chart.
export type WeaveNode = { id: string; threadId: string; dependsOn: string[] };
export const WEAVE_PLAN: WeaveNode[] = [
  { id: "s0", threadId: "th_schema", dependsOn: [] },
  { id: "s1", threadId: "th_csv_export", dependsOn: [] },
  { id: "s2", threadId: "th_audit_log", dependsOn: ["s1"] },
  { id: "s3", threadId: "th_saved_filters", dependsOn: [] },
  { id: "s4", threadId: "th_rate_limit", dependsOn: ["s2"] },
];

export function threadById(id: string): DemoThread | undefined {
  return DEMO_THREADS.find((t) => t.id === id);
}

export function threadBySubGoal(sub: string): DemoThread | undefined {
  return DEMO_THREADS.find((t) => t.subGoalId === sub);
}
