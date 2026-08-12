// GALLERY (delete with /gallery) — drawers group: the AgentViewDrawer (operator
// roster + transcript) in its captured / not-captured / woven-fanout variants,
// and the SpecDrawer (objective + contract + files + provenance).
import type { GalleryFixtureBundle } from "../index";
import type { Loom } from "@telar/core";
import {
  agentResultEvent,
  at,
  galleryId,
  makeAssertion,
  makeAttempt,
  makeCharter,
  makeContract,
  makeCritic,
  makeLoom,
  makePanel,
  makeProvenance,
  makeSpec,
  makeSubGoal,
  makeVerdict,
  sayEvent,
  sessionEvent,
  toolEvent,
  toolResultEvent,
} from "../builders";

// A single loom whose OWN event stream is its operator + sub-agent transcript.
const capturedLoom = makeLoom({
  id: galleryId("drawer-transcript-captured"),
  project: "finch",
  kind: "custom",
  title: "Add range-satisfies() to the comparator",
  prompt: "Implement satisfies(version, range) for ^, ~, and hyphen ranges.",
  state: "running",
  createdAt: at(0),
  updatedAt: at(500),
  attempts: [makeAttempt({ costUsd: 0.9, startedAt: at(120), sessionId: "sess_op_captured" })],
});

const wovenFanoutRoot = makeLoom({
  id: galleryId("drawer-woven-child-fanout"),
  project: "aurora",
  kind: "story",
  title: "Realtime CSV export with an audit trail",
  prompt: "Stream a filtered CSV export and record each export in an audit log.",
  state: "running",
  createdAt: at(0),
  updatedAt: at(500),
  charter: makeCharter({
    objective: "Streamed CSV export + audit write.",
    decomposition: [
      makeSubGoal({ id: "s1", title: "Streaming CSV endpoint" }),
      makeSubGoal({ id: "s2", title: "Audit-log write", dependsOn: ["s1"] }),
    ],
  }),
});

const fanoutChild: Loom = makeLoom({
  id: galleryId("dwf-s1"),
  parentLoomId: wovenFanoutRoot.id,
  subGoalId: "s1",
  project: "aurora",
  kind: "custom",
  title: "Streaming CSV endpoint",
  state: "verifying",
  createdAt: at(200),
  updatedAt: at(480),
  attempts: [
    makeAttempt({
      costUsd: 1.1,
      startedAt: at(220),
      sessionId: "sess_child_s1",
      verdict: makeVerdict({ summary: "Split the endpoint across two disjoint builders; both merged clean." }),
      panelReport: makePanel(
        [
          makeCritic({
            lens: "reproduction/happy-path",
            class: "reproduction",
            blocker: true,
            ok: true,
            summary: "Exported a filtered set from a cold session — every row present.",
          }),
        ],
        { url: "http://localhost:4310/events" },
      ),
    }),
  ],
});

export const drawersBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("drawer-transcript-captured"),
    label: "Agent view · transcript captured",
    group: "drawers",
    description:
      "The agent drawer pre-opened on the operator — a real replayable transcript (say / tool / result) plus a fan-out sub-agent.",
    surface: "godview",
    loom: capturedLoom,
    threads: [],
    feed: [
      sessionEvent("sess_op_captured", at(122)),
      sayEvent("Reading the comparator, then splitting the range work across two helpers.", at(130)),
      toolEvent("Read", { path: "src/compare/index.ts" }, at(134)),
      toolResultEvent("Read", "export function compare(a, b): -1 | 0 | 1 { … }", true, at(136)),
      // A fan-out piece (tagged with pieceId) — surfaces as a sub-agent + its own roster lane.
      sessionEvent("sess_piece_caret", at(140), "piece-caret"),
      sayEvent("Implementing caret-range satisfaction.", at(142), "piece-caret"),
      toolEvent("Edit", { path: "src/range/caret.ts" }, at(146), "piece-caret"),
      toolResultEvent("Edit", "wrote src/range/caret.ts (+38 −0)", true, at(148), "piece-caret"),
      agentResultEvent("success", 9, 0.21, at(160), "piece-caret"),
      sayEvent("Caret helper merged; wiring it into satisfies().", at(170)),
      toolEvent("Edit", { path: "src/range/satisfies.ts" }, at(174)),
      toolResultEvent("Edit", "wrote src/range/satisfies.ts (+52 −4)", true, at(176)),
    ],
    openOperatorId: galleryId("drawer-transcript-captured"),
  },
  {
    id: galleryId("drawer-not-captured"),
    label: "Agent view · transcript not captured",
    group: "drawers",
    description:
      "The honest empty state — a woven child whose step-by-step transcript is not in this payload (session resumable, no fabricated stream).",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("drawer-not-captured"),
      project: "aurora",
      kind: "story",
      title: "Dashboard filters and export",
      prompt: "Two parallel workstreams on the Aurora dashboard.",
      state: "running",
      createdAt: at(0),
      updatedAt: at(400),
      charter: makeCharter({
        objective: "Filters + export, woven.",
        decomposition: [
          makeSubGoal({ id: "s1", title: "Saved filters" }),
          makeSubGoal({ id: "s2", title: "CSV export" }),
        ],
      }),
    }),
    threads: [
      makeLoom({
        id: galleryId("dnc-s1"),
        parentLoomId: galleryId("drawer-not-captured"),
        subGoalId: "s1",
        project: "aurora",
        kind: "custom",
        title: "Saved filters",
        state: "running",
        createdAt: at(200),
        updatedAt: at(400),
        // A sessionId so the honest "not captured" reason names a resumable session.
        attempts: [makeAttempt({ costUsd: 0.6, startedAt: at(220), sessionId: "sess_child_filters" })],
      }),
      makeLoom({
        id: galleryId("dnc-s2"),
        parentLoomId: galleryId("drawer-not-captured"),
        subGoalId: "s2",
        project: "aurora",
        kind: "custom",
        title: "CSV export",
        state: "queued",
        createdAt: at(200),
        updatedAt: at(400),
      }),
    ],
    // No per-child events in the feed — the opened thread's transcript is
    // genuinely not in this payload (the honest available:false / empty state).
    feed: [],
    openOperatorId: galleryId("dnc-s1"),
  },
  {
    id: galleryId("drawer-woven-child-fanout"),
    label: "Agent view · woven child fan-out",
    group: "drawers",
    description:
      "A woven child opened via its live tail — its intra-thread fan-out sub-agents and the critic cards from its panel verdict.",
    surface: "godview",
    loom: wovenFanoutRoot,
    threads: [fanoutChild],
    // The opened child's OWN transcript — the stage feeds this to
    // deriveThreadOperator(child, feed): operator lane + two fan-out pieces.
    feed: [
      sessionEvent("sess_child_s1", at(222)),
      sayEvent("Splitting the endpoint into a query builder and a streamer over disjoint files.", at(226)),
      sessionEvent("sess_piece_query", at(230), "piece-query"),
      sayEvent("Building the filtered query with buildFilter().", at(232), "piece-query"),
      toolEvent("Edit", { path: "lib/export/query.ts" }, at(236), "piece-query"),
      toolResultEvent("Edit", "wrote lib/export/query.ts (+41 −0)", true, at(238), "piece-query"),
      agentResultEvent("success", 7, 0.28, at(250), "piece-query"),
      sessionEvent("sess_piece_stream", at(232), "piece-stream"),
      sayEvent("Building the chunked CSV streamer.", at(234), "piece-stream"),
      toolEvent("Edit", { path: "lib/export/stream.ts" }, at(240), "piece-stream"),
      toolResultEvent("Edit", "wrote lib/export/stream.ts (+63 −0)", true, at(242), "piece-stream"),
      agentResultEvent("success", 8, 0.33, at(258), "piece-stream"),
      sayEvent("Both pieces merged clean; handing off to verify.", at(270)),
    ],
    openOperatorId: galleryId("dwf-s1"),
    viewHints: ["threads"],
  },
  {
    id: galleryId("drawer-spec"),
    label: "Spec drawer",
    group: "drawers",
    description:
      "The Spec Bundle drawer pre-opened — objective, the falsifiable Verification Contract, context files, and provenance.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("drawer-spec"),
      project: "finch",
      kind: "custom",
      title: "Add range-satisfies() to the comparator",
      prompt: "Implement satisfies(version, range) for ^, ~, and hyphen ranges.",
      state: "ready",
      createdAt: at(0),
      updatedAt: at(500),
      contractRequired: true,
      attempts: [makeAttempt({ costUsd: 0.8, verdict: makeVerdict() })],
    }),
    threads: [],
    feed: [],
    openSpec: true,
    spec: makeSpec({
      objective:
        "Implement `satisfies(version, range)` in the finch comparator — caret, tilde, and hyphen ranges, with full semver precedence and prerelease handling.",
      files: ["src/range/satisfies.ts", "src/range/index.ts", "test/range/satisfies.test.ts"],
      contract: makeContract([
        makeAssertion({
          id: "a1",
          description: "satisfies('1.2.3', '^1.0.0') is true; '2.0.0' is false.",
          type: "command",
          expected: "bun test test/range/satisfies.test.ts -t caret",
        }),
        makeAssertion({
          id: "a2",
          description: "Hyphen ranges are inclusive on both bounds.",
          type: "command",
          expected: "bun test test/range/satisfies.test.ts -t hyphen",
        }),
        makeAssertion({
          id: "a3",
          description: "The public range API is documented in the README.",
          type: "contains",
          expectedFile: "README.md",
        }),
        makeAssertion({
          id: "a4",
          description: "The comparator reads clearly and handles prerelease edge cases sensibly.",
          type: "live-critic",
          observable: "the satisfies() behavior on prerelease inputs like 1.0.0-rc.1",
          blocker: false,
        }),
      ]),
      provenance: makeProvenance({ approvedBy: "you", sessionId: "sess_plan_finch" }),
    }),
  },
];
