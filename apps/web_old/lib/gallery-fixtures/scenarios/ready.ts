// GALLERY (delete with /gallery) — ready group: the accept rail for a verified
// loom — a clean green accept, and the subjective-criteria surface (criteria the
// loop deliberately carried to YOUR judgment, never a machine gate).
import type { GalleryFixtureBundle } from "../index";
import {
  at,
  galleryId,
  greenPanel,
  makeAssertion,
  makeAttempt,
  makeLoom,
  makeVerdict,
} from "../builders";

export const readyBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("ready-green-accept"),
    label: "Ready · green accept",
    group: "ready",
    description:
      "A verified loom awaiting your accept — the green panel summary and the Accept / Reject rail (accept LANDS the work).",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("ready-green-accept"),
      project: "finch",
      kind: "custom",
      title: "Add range-satisfies() to the comparator",
      prompt: "Implement satisfies(version, range) for ^, ~, and hyphen ranges.",
      state: "ready",
      createdAt: at(0),
      updatedAt: at(500),
      contractRequired: true,
      attempts: [
        makeAttempt({
          costUsd: 0.8,
          startedAt: at(120),
          endedAt: at(440),
          verdict: makeVerdict({
            summary: "Implemented satisfies() for caret, tilde, and hyphen ranges; all criteria pass.",
            files_touched: ["src/range/satisfies.ts", "src/range/index.ts"],
          }),
          panelReport: greenPanel(),
        }),
      ],
    }),
    threads: [],
    feed: [],
  },
  {
    id: galleryId("ready-subjective-criteria"),
    label: "Ready · subjective criteria",
    group: "ready",
    description:
      "The subjective criteria the loop pulled out of the autonomous panel and carried to YOUR judgment at accept.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("ready-subjective-criteria"),
      project: "aurora",
      kind: "story",
      title: "Cohort retention heatmap",
      prompt: "Add a weekly cohort-retention heatmap to the Aurora overview page.",
      state: "ready",
      createdAt: at(0),
      updatedAt: at(500),
      contractRequired: true,
      attempts: [
        makeAttempt({
          costUsd: 1.4,
          startedAt: at(120),
          endedAt: at(460),
          verdict: makeVerdict({
            summary: "Cohort heatmap renders weekly buckets with a diverging color scale.",
            files_touched: ["app/overview/cohort-heatmap.tsx", "lib/analytics/cohorts.ts"],
          }),
          panelReport: greenPanel(),
          // The explicitly-subjective criteria pulled out of the panel into the
          // human-judged bucket (subjective:true, type:"live-critic", observable set).
          humanJudged: [
            makeAssertion({
              id: "h1",
              type: "live-critic",
              subjective: true,
              blocker: false,
              description: "The color scale reads intuitively — high retention is unmistakably 'good'.",
              observable: "the heatmap's diverging color scale on the overview page",
            }),
            makeAssertion({
              id: "h2",
              type: "live-critic",
              subjective: true,
              blocker: false,
              description: "The weekly buckets are labeled clearly enough to find a specific cohort at a glance.",
              observable: "the row/column axis labels of the cohort heatmap",
            }),
          ],
        }),
      ],
    }),
    threads: [],
    feed: [],
  },
];
