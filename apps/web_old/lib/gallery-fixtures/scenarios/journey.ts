// GALLERY (delete with /gallery) — journey group: the looms index card grid and
// the new-loom planning session shell.
import type { GalleryFixtureBundle } from "../index";
import { at, galleryId, makeAttempt, makeLoom, makeVerdict } from "../builders";

// A spread of listable looms for the index grid — mixed kinds + states so the
// LoomCard rail colors, cost/duration, and error lines all show at once.
const gridLooms = [
  makeLoom({
    id: galleryId("card-running"),
    project: "finch",
    kind: "custom",
    title: "Add range-satisfies() to the semver comparator",
    prompt: "Implement `satisfies(version, range)` covering ^, ~, and hyphen ranges.",
    state: "running",
    createdAt: at(0),
    updatedAt: at(320),
    attempts: [makeAttempt({ costUsd: 0.42 })],
  }),
  makeLoom({
    id: galleryId("card-ready"),
    project: "aurora",
    kind: "story",
    title: "Cohort retention chart on the analytics dashboard",
    prompt: "Add a weekly cohort-retention heatmap to the Aurora overview page.",
    state: "ready",
    createdAt: at(-3600),
    updatedAt: at(280),
    attempts: [makeAttempt({ costUsd: 1.87, verdict: makeVerdict() })],
  }),
  makeLoom({
    id: galleryId("card-done"),
    project: "finch",
    kind: "quickfix",
    title: "Fix prerelease precedence (1.0.0-rc.1 < 1.0.0)",
    prompt: "Prerelease tags must sort below the release per semver §11.",
    state: "done",
    createdAt: at(-7200),
    updatedAt: at(-6800),
    commit: "9f3c2ab41d7e",
    attempts: [makeAttempt({ costUsd: 0.31, verdict: makeVerdict() })],
  }),
  makeLoom({
    id: galleryId("card-needs-review"),
    project: "aurora",
    kind: "custom",
    title: "CSV export for the events table",
    prompt: "Stream a CSV of the filtered events table to the browser.",
    state: "needs-review",
    createdAt: at(-5400),
    updatedAt: at(-200),
    error: "adversarial/edge-cases did not clear: export omits rows past the 10k page boundary.",
    attempts: [makeAttempt({ costUsd: 0.96 })],
  }),
  makeLoom({
    id: galleryId("card-failed"),
    project: "aurora",
    kind: "story",
    title: "Realtime presence indicators",
    prompt: "Show who else is viewing a dashboard via a websocket presence channel.",
    state: "failed",
    createdAt: at(-9000),
    updatedAt: at(-8600),
    error: "Setup lane never came up — the websocket gateway exited on boot (exit 1).",
    attempts: [makeAttempt({ costUsd: 0.12 })],
  }),
  makeLoom({
    id: galleryId("card-blocked"),
    project: "finch",
    kind: "custom",
    title: "Publish the coverage badge from CI",
    prompt: "Wire the coverage number into a README badge on every main build.",
    state: "blocked",
    createdAt: at(-2600),
    updatedAt: at(-100),
    blockedQuestion: "How should verification run this — there's no dev server and no test command yet?",
    attempts: [],
  }),
];

export const journeyBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("card-running"),
    label: "Looms index · card grid",
    group: "journey",
    description:
      "The top-level Looms list — LoomCard grid across running / ready / done / needs-review / failed / blocked states.",
    surface: "loom-cards",
    // The stage renders LoomCard over [loom, ...threads]; reuse `threads` as the
    // rest of the grid (they are NOT real children — surface:loom-cards only).
    loom: gridLooms[0],
    threads: gridLooms.slice(1),
    feed: [],
  },
  {
    id: galleryId("plan-session"),
    label: "New-loom planning session",
    group: "journey",
    description:
      "The SessionView planner shell (start a new loom). The chat stream is benign-stubbed — a documented limitation.",
    surface: "session",
    loom: makeLoom({
      id: galleryId("plan-session"),
      project: "aurora",
      kind: "custom",
      title: "Plan a new loom for Aurora",
      prompt: "Draft the charter for a new piece of work on the analytics dashboard.",
      state: "scoping",
    }),
    threads: [],
    feed: [],
  },
];
