// GALLERY (delete with /gallery) — SHOWCASE fixture DATA for the component
// showcase (gallery v2). Lane F authors the DATA here; lane G renders the JSX
// (component-stage.tsx). Every nested zod-backed shape (gate / critic /
// verifierReport / charter) is parsed against the REAL @telar/core schemas in the
// validate test; the Plan + Operators are DERIVED via the REAL deriveGodView /
// deriveThreadOperator so they can never drift from what the god-view produces in
// production. Same finch + aurora stories as everywhere else.
import type { Loom, LoomEvent, SubGoal } from "@telar/core";
import type { Plan, Operator } from "@/components/looms/godview";
import { deriveGodView, deriveThreadOperator } from "@/components/looms/godview";
import type { PermissionPart } from "@/components/session/session-view";
import {
  at,
  galleryId,
  greenPanel,
  makeAssertion,
  makeAttempt,
  makeCharter,
  makeContract,
  makeCritic,
  makeEvidence,
  makeFinding,
  makeGate,
  makeLoom,
  makePanel,
  makeSubGoal,
  makeThread,
  makeVerdict,
  makeVerifierReport,
  sayEvent,
  toolEvent,
  agentResultEvent,
} from "./builders";
import { accountsList, brokenRow, finchRow } from "./scenarios/app/projects";

// ---------------------------------------------------------------------------
// One loom per WorkUnitState — the state-badge + loom-card variant grids.
// ---------------------------------------------------------------------------
const STATES = [
  "queued",
  "scoping",
  "charter-review",
  "preparing",
  "running",
  "verifying",
  "ready",
  "done",
  "needs-review",
  "blocked",
  "halted",
  "failed",
  "skipped",
] as const;

const loomStates: Loom[] = STATES.map((state, i) =>
  makeLoom({
    id: galleryId(`cmp-state-${state}`),
    project: i % 2 === 0 ? "finch" : "aurora",
    kind: "custom",
    title: `A ${state} unit of work`,
    prompt: `Illustrates the ${state} card + badge styling.`,
    state,
    createdAt: at(-3600 - i * 60),
    updatedAt: at(-i * 30),
    attempts: state === "queued" || state === "scoping" ? [] : [makeAttempt({ costUsd: 0.1 * (i + 1) })],
    error:
      state === "failed"
        ? "Setup lane never came up — the websocket gateway exited on boot (exit 1)."
        : state === "needs-review"
          ? "adversarial/edge-cases did not clear: export omits rows past the 10k page boundary."
          : null,
    ...(state === "blocked"
      ? { blockedQuestion: "How should verification run this — there's no dev server yet?" }
      : {}),
    ...(state === "done" ? { commit: "9f3c2ab41d7e" } : {}),
  }),
);

// ---------------------------------------------------------------------------
// Gate rows — the four GateRunRow states.
// ---------------------------------------------------------------------------
const gate = {
  pass: makeGate({
    name: "test",
    ok: true,
    output: "bun test\n 142 pass\n 0 fail\n Ran 142 tests across 18 files. [1.24s]",
    durationMs: 1240,
  }),
  fail: makeGate({
    name: "typecheck",
    ok: false,
    exitCode: 2,
    output: "src/satisfies.ts(48,7): error TS2345: Argument of type 'string' is not assignable to 'Range'.",
    durationMs: 3800,
  }),
  running: makeGate({ name: "lint", ok: false, exitCode: 0, output: "", durationMs: 0 }),
  timedOut: makeGate({
    name: "e2e",
    ok: false,
    exitCode: null,
    output: "Playwright did not exit within 300000ms — killed.",
    durationMs: 300_000,
    timedOut: true,
  }),
};

// ---------------------------------------------------------------------------
// Critic verdicts + a standalone finding — CriticVerdictRow / CriticFindingRow.
// ---------------------------------------------------------------------------
const finding = makeFinding({
  severity: "blocker",
  title: "CSV export truncates at the 10k page boundary",
  detail:
    "Exporting the filtered events table stops emitting rows once the in-memory page cursor passes 10,000 — later rows are silently dropped.",
  recommendation: "Stream from the DB cursor instead of the paginated in-memory buffer.",
  evidence: [makeEvidence({ kind: "screenshot", label: "row count caps at 10,000", path: "csv-truncation.png" })],
});

const critics = {
  pass: makeCritic({
    lens: "adversarial/edge-cases",
    class: "adversarial",
    blocker: true,
    ok: true,
    summary: "Probed boundary inputs and error paths — every acceptance assertion held.",
  }),
  blocking: makeCritic({
    lens: "reproduction/csv-export",
    class: "reproduction",
    blocker: true,
    ok: false,
    summary: "Reproduced the reported failure: the export drops rows past the first page boundary.",
    findings: [
      finding,
      makeFinding({
        severity: "major",
        title: "No BOM on the CSV",
        detail: "Excel misreads UTF-8 accented headers without a byte-order mark.",
      }),
      makeFinding({
        severity: "minor",
        title: "Filename lacks a timestamp",
        detail: "Repeated exports overwrite each other in the downloads folder.",
      }),
    ],
  }),
  advisory: makeCritic({
    lens: "aesthetic/visual-polish",
    class: "aesthetic",
    blocker: false,
    ok: true,
    summary: "Non-blocking UX nudges: the heatmap legend crowds its axis on narrow viewports.",
    findings: [
      makeFinding({
        severity: "nit",
        title: "Legend overlaps the axis under 640px",
        detail: "The cohort-retention legend wraps onto the x-axis labels on small screens.",
      }),
    ],
  }),
  finding,
};

// ---------------------------------------------------------------------------
// Charter (full: objective / scope / budget / decomposition).
// ---------------------------------------------------------------------------
const decomposition: SubGoal[] = [
  makeSubGoal({
    id: "s1",
    title: "Parse the range grammar",
    detail: "Tokenize ^, ~, hyphen, and comparator ranges into a normalized comparator set.",
    acceptanceCriteria: ["^1.2.3 expands to >=1.2.3 <2.0.0", "1.2.3 - 2.3.4 is inclusive on both ends"],
  }),
  makeSubGoal({
    id: "s2",
    title: "Evaluate a version against a comparator set",
    detail: "satisfies(version, range) returns true iff every comparator in one set holds.",
    dependsOn: ["s1"],
    acceptanceCriteria: ["Prerelease versions only match when the range names that prerelease"],
  }),
  makeSubGoal({
    id: "s3",
    title: "Wire the public satisfies() export",
    detail: "Export satisfies from the package index and add it to the type declarations.",
    dependsOn: ["s2"],
    required: false,
  }),
];

const charter = makeCharter({
  objective: "Add SemVer range satisfaction (satisfies(version, range)) to the finch comparator.",
  scope: {
    allowedPaths: ["src/satisfies.ts", "src/range.ts", "test/**"],
    forbiddenPaths: ["src/version.ts"],
  },
  budget: { maxParallelThreads: 2, maxAgents: 6, maxCriticAgents: 2 },
  decomposition,
  rationale:
    "The grammar parse (s1) is the critical path; evaluation (s2) depends on it, and the export (s3) is a thin, non-blocking wrap.",
  approvedBy: "you",
});

// ---------------------------------------------------------------------------
// Plan — DERIVED via the REAL deriveGodView over a woven root + mixed-state
// threads (s1 done, s2 running, s3 has no thread → pending).
// ---------------------------------------------------------------------------
const planRoot = makeLoom({
  id: galleryId("cmp-plan-root"),
  project: "finch",
  kind: "custom",
  title: "Range-satisfies weave",
  prompt: charter.objective,
  state: "running",
  charter,
});

const planThreads: Loom[] = [
  makeThread(planRoot.id, "s1", {
    id: galleryId("cmp-plan-s1"),
    project: "finch",
    title: "Parse the range grammar",
    state: "done",
    attempts: [makeAttempt({ costUsd: 0.4, verdict: makeVerdict() })],
  }),
  makeThread(planRoot.id, "s2", {
    id: galleryId("cmp-plan-s2"),
    project: "finch",
    title: "Evaluate a version against a comparator set",
    state: "running",
    attempts: [makeAttempt({ costUsd: 0.2 })],
  }),
];

const plan: Plan = deriveGodView(planRoot, planThreads, []).orchestrator.plan;

// ---------------------------------------------------------------------------
// Operators — DERIVED via the REAL deriveThreadOperator for each state, incl. a
// fan-out child whose events carry pieceIds (subAgents reconstruct from those).
// ---------------------------------------------------------------------------
const opRunning = makeThread(galleryId("cmp-op-root"), "s2", {
  id: galleryId("cmp-op-running"),
  project: "finch",
  title: "Evaluate a version against a comparator set",
  state: "running",
  attempts: [makeAttempt({ costUsd: 0.22 })],
});

const opDone = makeThread(galleryId("cmp-op-root"), "s1", {
  id: galleryId("cmp-op-done"),
  project: "finch",
  title: "Parse the range grammar",
  state: "done",
  attempts: [
    makeAttempt({
      costUsd: 0.41,
      verdict: makeVerdict({ summary: "Tokenized every range form; the comparator-set expander is fully covered." , files_touched: ["src/range.ts", "test/range.test.ts"] }),
      panelReport: greenPanel(),
    }),
  ],
});

const opFailed = makeThread(galleryId("cmp-op-root"), "s4", {
  id: galleryId("cmp-op-failed"),
  project: "aurora",
  title: "Realtime presence indicators",
  state: "failed",
  error: "Setup lane never came up — the websocket gateway exited on boot (exit 1).",
  attempts: [
    makeAttempt({
      costUsd: 0.12,
      gates: [makeGate({ name: "test", ok: false, exitCode: 1, output: "3 failing" })],
      verdict: makeVerdict({ ok: false, summary: "Could not stand the gateway up to verify presence.", blocker: "websocket gateway exits on boot" }),
      panelReport: makePanel([
        makeCritic({ lens: "reproduction/presence", class: "reproduction", blocker: true, ok: false, summary: "Gateway never accepted a socket." }),
      ]),
    }),
  ],
});

const opBlocked = makeThread(galleryId("cmp-op-root"), "s5", {
  id: galleryId("cmp-op-blocked"),
  project: "finch",
  title: "Publish the coverage badge from CI",
  state: "blocked",
  blockedQuestion: "How should verification run this — there's no dev server and no test command yet?",
  attempts: [],
});

const opFanOut = makeThread(galleryId("cmp-op-root"), "s6", {
  id: galleryId("cmp-op-fanout"),
  project: "aurora",
  title: "Migrate the events table to the new grid",
  state: "running",
  attempts: [makeAttempt({ costUsd: 0.6 })],
});
const fanOutEvents: LoomEvent[] = [
  sayEvent("Splitting the migration across three disjoint file pieces.", at(10)),
  sayEvent("Rewriting the column model.", at(20), "piece-columns"),
  toolEvent("Edit", { file_path: "app/events/columns.tsx" }, at(24), "piece-columns"),
  sayEvent("Porting the row renderer.", at(30), "piece-rows"),
  toolEvent("Edit", { file_path: "app/events/row.tsx" }, at(34), "piece-rows"),
  agentResultEvent("success", 8, 0.21, at(48), "piece-rows"),
  sayEvent("Updating the table stories.", at(40), "piece-stories"),
];

const operators: Record<"running" | "done" | "failed" | "blocked" | "fanOut", Operator> = {
  running: deriveThreadOperator(opRunning, []),
  done: deriveThreadOperator(opDone, []),
  failed: deriveThreadOperator(opFailed, []),
  blocked: deriveThreadOperator(opBlocked, []),
  fanOut: deriveThreadOperator(opFanOut, fanOutEvents),
};

// ---------------------------------------------------------------------------
// Verifier reports (legacy VerifierReportCard) — pass + fail with findings.
// ---------------------------------------------------------------------------
const verifierReport = {
  pass: makeVerifierReport({
    feature: "satisfies(version, range)",
    ok: true,
    summary: "Drove the comparator end-to-end against the semver conformance corpus; every criterion passed.",
    criteria: [
      { criterion: "^1.2.3 expands correctly", verdict: "pass", observed: "matched >=1.2.3 <2.0.0", evidence: [], repro: [], locators: [] },
      { criterion: "prerelease only matches when named", verdict: "pass", observed: "1.0.0-rc.1 rejected by ^1.0.0", evidence: [], repro: [], locators: [] },
    ],
  }),
  fail: makeVerifierReport({
    feature: "CSV export for the events table",
    ok: false,
    summary: "The export drops rows past the first 10k page boundary; two design findings recorded.",
    criteria: [
      { criterion: "all filtered rows export", verdict: "fail", observed: "row count caps at 10,000", evidence: [], repro: [], locators: [] },
    ],
    sessionEvidence: [makeEvidence({ kind: "screenshot", label: "row count caps at 10,000", path: "csv-truncation.png" })],
    designFindings: [
      { severity: "blocker", category: "state", title: "Rows dropped past 10k", detail: "Export truncates silently once the page cursor passes 10,000 rows.", evidence: [] },
    ],
  }),
};

// ---------------------------------------------------------------------------
// Attempts (AttemptCard) — running / passed-verdict / failed-with-blocker.
// ---------------------------------------------------------------------------
const attempts = {
  running: makeAttempt({ n: 1, costUsd: 0.18, startedAt: at(120) }),
  passed: makeAttempt({
    n: 1,
    costUsd: 0.41,
    startedAt: at(120),
    endedAt: at(320),
    verdict: makeVerdict({ summary: "Implemented satisfies() and confirmed every acceptance criterion.", files_touched: ["src/satisfies.ts"] }),
    panelReport: greenPanel(),
  }),
  failed: makeAttempt({
    n: 2,
    costUsd: 0.27,
    startedAt: at(420),
    endedAt: at(560),
    gates: [makeGate({ name: "test", ok: false, exitCode: 1, output: "3 failing assertions" })],
    verdict: makeVerdict({ ok: false, summary: "Prerelease matching still wrong for ranges with build metadata.", blocker: "1.0.0-rc.1+build matches ^1.0.0 when it should not" }),
  }),
};

// ---------------------------------------------------------------------------
// Permission cards (PermissionPart — the seam-exported live-stream shape).
// ---------------------------------------------------------------------------
const permissionBase = {
  type: "permission" as const,
  id: "perm_1",
  toolName: "Bash",
  input: { command: "rm -rf dist/ && bun run build" },
  rule: "Bash(rm:*)",
  ruleOptions: [
    { rule: "Bash(rm:*)", label: "Always allow rm commands" },
    { rule: "Bash(rm -rf dist/*)", label: "Allow removing dist/" },
    { rule: "Bash(rm -rf dist/ && bun run build)", label: "Just this command" },
  ],
};

const permission: Record<"pending" | "allowed" | "denied", PermissionPart> = {
  pending: { ...permissionBase, id: "perm_pending", status: "pending" },
  allowed: { ...permissionBase, id: "perm_allowed", status: "allowed" },
  denied: { ...permissionBase, id: "perm_denied", status: "denied" },
};

// ---------------------------------------------------------------------------
// Decision log feed (DecisionLog reads decision / weave-child-spawned /
// weave-rollup events).
// ---------------------------------------------------------------------------
const decisionFeed: LoomEvent[] = [
  { ts: at(0), type: "decision", decision: { action: "schedule", subGoalIds: ["s1"], agents: 1 } },
  { ts: at(30), type: "weave-child-spawned", subGoalId: "s1", childId: galleryId("cmp-plan-s1") },
  { ts: at(120), type: "decision", decision: { action: "fanout", threadId: galleryId("cmp-op-fanout"), pieces: 3 } },
  { ts: at(240), type: "decision", decision: { action: "schedule", subGoalIds: ["s2"], agents: 2 } },
  { ts: at(360), type: "decision", decision: { action: "repair", threadId: galleryId("cmp-op-failed") } },
  { ts: at(480), type: "decision", decision: { action: "escalate", reason: "the verification lane can't come up — no dev server configured" } },
  { ts: at(600), type: "weave-rollup", state: "done" },
];

// ---------------------------------------------------------------------------
// Thread tree (ThreadTree: decomposition + children in mixed states, plus an
// orphaned sub-goal with no child thread).
// ---------------------------------------------------------------------------
const threadTree = {
  decomposition,
  children: planThreads,
};

// ---------------------------------------------------------------------------
// Spec bundle (SpecBundle + AssertionRow) — a valid, falsifiable contract.
// ---------------------------------------------------------------------------
const specContract = makeContract([
  makeAssertion({
    id: "a1",
    subGoalId: "s1",
    description: "The comparator suite proves ^, ~, and hyphen ranges expand correctly.",
    type: "command",
    expected: "bun test test/range.test.ts",
  }),
  makeAssertion({
    id: "a2",
    subGoalId: "s2",
    description: "satisfies(1.5.0, '^1.2.3') is true and satisfies(2.0.0, '^1.2.3') is false.",
    type: "live-critic",
    observable: "the boolean satisfies() returns for the caret-range corpus",
  }),
  makeAssertion({
    id: "a3",
    subGoalId: "s2",
    description: "Prerelease versions only match when the range names that prerelease.",
    type: "live-critic",
    observable: "satisfies() rejecting 1.0.0-rc.1 against ^1.0.0",
    blocker: false,
  }),
]);

// ---------------------------------------------------------------------------
// The exported bundle.
// ---------------------------------------------------------------------------
export const SHOWCASE = {
  loomStates,
  gate,
  critics,
  plan,
  operators,
  verifierReport,
  charter,
  attempts,
  permission,
  projectEntry: finchRow,
  manifestErrorEntry: brokenRow,
  accounts: accountsList,
  decisionFeed,
  threadTree,
  specContract,
};
