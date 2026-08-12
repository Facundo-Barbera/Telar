// GALLERY (delete with /gallery) — running group: the unified god-view cockpit
// while work is in flight — preparing, a weave-of-one, a woven fan-out, the
// thread roster, and an expandable decision rationale.
import type { GalleryFixtureBundle } from "../index";
import type { Loom, LoomEvent } from "@telar/core";
import {
  at,
  galleryId,
  greenPanel,
  makeAttempt,
  makeCharter,
  makeCritic,
  makeEvent,
  makeLoom,
  makePanel,
  makeSubGoal,
  makeVerdict,
  sayEvent,
  sessionEvent,
  toolEvent,
  toolResultEvent,
} from "../builders";

// A child thread carrying enough to drive its operator card status.
function child(
  root: string,
  subGoalId: string,
  slug: string,
  title: string,
  state: Loom["state"],
  extra: Partial<Loom> = {},
): Loom {
  return makeLoom({
    id: galleryId(slug),
    parentLoomId: root,
    subGoalId,
    project: "aurora",
    kind: "custom",
    title,
    state,
    createdAt: at(200),
    updatedAt: at(400),
    ...extra,
  });
}

const wovenDecomposition = [
  makeSubGoal({ id: "s1", title: "Streaming CSV endpoint", detail: "Stream all filtered rows as CSV." }),
  makeSubGoal({
    id: "s2",
    title: "Audit-log write",
    detail: "One audit row per export.",
    dependsOn: ["s1"],
  }),
  makeSubGoal({
    id: "s3",
    title: "Export UI affordance",
    detail: "An Export button on the toolbar.",
    dependsOn: ["s1"],
  }),
];

// The plan DAG event + decision timeline the woven cockpit reads.
const planEvent: LoomEvent = makeEvent("plan", {
  ts: at(210),
  decomposition: [
    { id: "s1", title: "Streaming CSV endpoint", dependsOn: [], required: true },
    { id: "s2", title: "Audit-log write", dependsOn: ["s1"], required: true },
    { id: "s3", title: "Export UI affordance", dependsOn: ["s1"], required: true },
  ],
  rationale: "s1 is the critical-path head (both s2 and s3 depend on it); schedule it first, then fan its two dependents in parallel.",
});

const decisionFeed: LoomEvent[] = [
  makeEvent("charter-approved", { ts: at(205), by: "you" }),
  planEvent,
  makeEvent("weave-child-spawned", { ts: at(212), subGoalId: "s1", childId: galleryId("fanout-s1") }),
  makeEvent("decision", {
    ts: at(214),
    decision: { action: "schedule", subGoalIds: ["s1"] },
    rationale: { summary: "Scheduled s1 — the critical-path head with no unmet dependencies." },
  }),
  makeEvent("fanout", { ts: at(220), pieces: 3 }),
  makeEvent("decision", {
    ts: at(222),
    decision: { action: "fanout", threadId: galleryId("fanout-s1"), pieces: 3 },
    rationale: {
      summary: "Fanned s1 into 3 disjoint builders (pieces-bound).",
      fanout: { pieces: 3, capByPool: 6, capByBudget: 9, chosen: 3, binding: "pieces" },
    },
  }),
  makeEvent("weave-child-spawned", { ts: at(240), subGoalId: "s2", childId: galleryId("fanout-s2") }),
  makeEvent("weave-child-spawned", { ts: at(242), subGoalId: "s3", childId: galleryId("fanout-s3") }),
  makeEvent("observe", { ts: at(260), subGoalId: "s1", state: "ready", unblocked: ["s2", "s3"] }),
];

export const runningBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("preparing-single"),
    label: "Preparing · single loom",
    group: "running",
    description:
      "A plain loom warming up — the operator lane building, no verify yet. The god-view frame with one operator.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("preparing-single"),
      project: "finch",
      kind: "custom",
      title: "Add range-satisfies() to the comparator",
      prompt: "Implement satisfies(version, range) for ^, ~, and hyphen ranges.",
      state: "preparing",
      createdAt: at(0),
      updatedAt: at(120),
      attempts: [makeAttempt({ costUsd: 0.08, startedAt: at(60) })],
    }),
    threads: [],
    feed: [
      sessionEvent("sess_prep_01", at(62)),
      sayEvent("Bringing the workspace up and reading the comparator module before I start.", at(70)),
      toolEvent("Read", { path: "src/compare/index.ts" }, at(78)),
      toolResultEvent("Read", "export function compare(a: SemVer, b: SemVer): -1 | 0 | 1 { … }", true, at(80)),
    ],
    viewHints: ["orchestrator"],
  },
  {
    id: galleryId("running-single-thread"),
    label: "Running · weave of one",
    group: "running",
    description:
      "The honest single-node plan (a weave of one): the plan graph shows one node, not a fake DAG.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("running-single-thread"),
      project: "finch",
      kind: "custom",
      title: "Add range-satisfies() to the comparator",
      prompt: "Implement satisfies(version, range) for ^, ~, and hyphen ranges.",
      state: "running",
      createdAt: at(0),
      updatedAt: at(300),
      charter: makeCharter({
        objective: "Implement satisfies(version, range) for the finch comparator.",
        singleThread: true,
        rationale: "A single well-bounded change — routed through the weaver as a weave of one by construction.",
        decomposition: [
          makeSubGoal({ id: "s1", title: "range-satisfies()", detail: "The whole change, one thread." }),
        ],
      }),
    }),
    threads: [
      child(galleryId("running-single-thread"), "s1", "wov1-s1", "range-satisfies()", "running", {
        project: "finch",
        attempts: [makeAttempt({ costUsd: 0.34, startedAt: at(120) })],
      }),
    ],
    feed: [makeEvent("charter-approved", { ts: at(60), by: "you" })],
    viewHints: ["orchestrator"],
  },
  {
    id: galleryId("running-woven-fanout"),
    label: "Running · woven fan-out",
    group: "running",
    description:
      "A live weave — the plan DAG plus the decision timeline (schedule, fan-out, observe) as the orchestrator drives it.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("running-woven-fanout"),
      project: "aurora",
      kind: "story",
      title: "Realtime CSV export with an audit trail",
      prompt: "Stream a filtered CSV export and record each export in an audit log.",
      state: "running",
      createdAt: at(0),
      updatedAt: at(300),
      charter: makeCharter({
        objective: "Streamed CSV export + audit write + export button, verified end-to-end.",
        decomposition: wovenDecomposition,
        rationale: planEvent.rationale as string,
      }),
    }),
    threads: [
      child(galleryId("running-woven-fanout"), "s1", "fanout-s1", "Streaming CSV endpoint", "ready", {
        attempts: [makeAttempt({ costUsd: 0.9, verdict: makeVerdict(), panelReport: greenPanel() })],
      }),
      child(galleryId("running-woven-fanout"), "s2", "fanout-s2", "Audit-log write", "running", {
        attempts: [makeAttempt({ costUsd: 0.5, startedAt: at(240) })],
      }),
      child(galleryId("running-woven-fanout"), "s3", "fanout-s3", "Export UI affordance", "running", {
        attempts: [makeAttempt({ costUsd: 0.4, startedAt: at(242) })],
      }),
    ],
    feed: decisionFeed,
    viewHints: ["orchestrator"],
  },
  {
    id: galleryId("running-multi-thread"),
    label: "Running · thread roster",
    group: "running",
    description:
      "The Threads tab — operator cards across mixed thread states (building, verified, needs-review, failed).",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("running-multi-thread"),
      project: "aurora",
      kind: "story",
      title: "Dashboard filters, export, and presence",
      prompt: "Three parallel workstreams on the Aurora dashboard.",
      state: "running",
      createdAt: at(0),
      updatedAt: at(400),
      charter: makeCharter({
        objective: "Filters, export, and presence — a fan of independent threads.",
        decomposition: [
          makeSubGoal({ id: "s1", title: "Saved filters" }),
          makeSubGoal({ id: "s2", title: "CSV export" }),
          makeSubGoal({ id: "s3", title: "Presence indicators" }),
          makeSubGoal({ id: "s4", title: "Keyboard shortcuts" }),
        ],
      }),
    }),
    threads: [
      child(galleryId("running-multi-thread"), "s1", "roster-s1", "Saved filters", "running", {
        attempts: [makeAttempt({ costUsd: 0.6, startedAt: at(120) })],
      }),
      child(galleryId("running-multi-thread"), "s2", "roster-s2", "CSV export", "ready", {
        attempts: [makeAttempt({ costUsd: 1.1, verdict: makeVerdict(), panelReport: greenPanel() })],
      }),
      child(galleryId("running-multi-thread"), "s3", "roster-s3", "Presence indicators", "needs-review", {
        error: "adversarial/edge-cases did not clear: presence leaks across dashboards.",
        attempts: [
          makeAttempt({
            costUsd: 0.8,
            verdict: makeVerdict({ ok: false, blocker: "presence channel not scoped per-dashboard" }),
            panelReport: makePanel([
              makeCritic({
                lens: "adversarial/edge-cases",
                class: "adversarial",
                blocker: true,
                ok: false,
                summary: "Presence events from dashboard A appear on dashboard B.",
              }),
            ]),
          }),
        ],
      }),
      child(galleryId("running-multi-thread"), "s4", "roster-s4", "Keyboard shortcuts", "failed", {
        error: "Builder exhausted its attempt budget without a green verify.",
        attempts: [makeAttempt({ costUsd: 0.3, verdict: makeVerdict({ ok: false, blocker: "shortcut map conflicts with the editor" }) })],
      }),
    ],
    feed: [makeEvent("charter-approved", { ts: at(60), by: "you" })],
    viewHints: ["threads"],
  },
  {
    id: galleryId("running-decision-rationale"),
    label: "Running · decision rationale",
    group: "running",
    description:
      "Click a decision to expand its WHY — the ranked critical-path scores, the binding fan-out term, and the budget snapshot.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("running-decision-rationale"),
      project: "aurora",
      kind: "story",
      title: "Realtime CSV export with an audit trail",
      prompt: "Stream a filtered CSV export and record each export in an audit log.",
      state: "running",
      createdAt: at(0),
      updatedAt: at(300),
      charter: makeCharter({
        objective: "Streamed CSV export + audit write + export button.",
        decomposition: wovenDecomposition,
      }),
    }),
    threads: [
      child(galleryId("running-decision-rationale"), "s1", "rat-s1", "Streaming CSV endpoint", "running", {
        attempts: [makeAttempt({ costUsd: 0.7, startedAt: at(220) })],
      }),
      child(galleryId("running-decision-rationale"), "s2", "rat-s2", "Audit-log write", "queued"),
      child(galleryId("running-decision-rationale"), "s3", "rat-s3", "Export UI affordance", "queued"),
    ],
    feed: [
      makeEvent("charter-approved", { ts: at(200), by: "you" }),
      planEvent,
      makeEvent("decision", {
        ts: at(230),
        decision: { action: "schedule", subGoalIds: ["s1"], pieces: 3 },
        rationale: {
          summary: "Scheduling s1 first — highest critical-path score; fan-out is pieces-bound at 3.",
          ranked: [
            { id: "s1", score: 0.92 },
            { id: "s2", score: 0.55 },
            { id: "s3", score: 0.48 },
          ],
          fanout: { pieces: 3, capByPool: 6, capByBudget: 9, chosen: 3, binding: "pieces" },
          budget: {
            spentUsd: 1.4,
            inFlight: 1,
            budgetLeftUsd: 8.6,
            wallClockRemainingMs: 5_400_000,
            maxCostUsd: 10,
          },
        },
      }),
    ],
    viewHints: ["open-decision-rationale"],
  },
];
