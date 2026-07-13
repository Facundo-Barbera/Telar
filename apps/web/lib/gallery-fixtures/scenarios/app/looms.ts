// GALLERY (delete with /gallery) — the story loom set (shared by the dashboard,
// the looms index, and the project-detail looms list) plus the looms-index
// scenes. Looms are typed Loom (compile-time checked) and every state is a valid
// WorkUnitState (the validate test parses each). finch + aurora, same two
// stories as the 35 loom bundles.
import type { Loom } from "@telar/core";
import type { GalleryScene } from "../../scene";
import { at, galleryId, makeAttempt, makeLoom, makeVerdict } from "../../builders";

// A spread of listable looms across every card state, split by project so the
// project-detail page (which filters /api/looms by project) shows a real subset.
export const finchLooms: Loom[] = [
  makeLoom({
    id: galleryId("app-loom-finch-running"),
    project: "finch",
    kind: "custom",
    title: "Add range-satisfies() to the comparator",
    prompt: "Implement satisfies(version, range) covering ^, ~, and hyphen ranges.",
    state: "running",
    createdAt: at(-600),
    updatedAt: at(-40),
    attempts: [makeAttempt({ costUsd: 0.42 })],
  }),
  makeLoom({
    id: galleryId("app-loom-finch-done"),
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
    id: galleryId("app-loom-finch-blocked"),
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

export const auroraLooms: Loom[] = [
  makeLoom({
    id: galleryId("app-loom-aurora-ready"),
    project: "aurora",
    kind: "story",
    title: "Cohort retention chart on the analytics dashboard",
    prompt: "Add a weekly cohort-retention heatmap to the Aurora overview page.",
    state: "ready",
    createdAt: at(-3600),
    updatedAt: at(-280),
    attempts: [makeAttempt({ costUsd: 1.87, verdict: makeVerdict() })],
  }),
  makeLoom({
    id: galleryId("app-loom-aurora-needs-review"),
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
    id: galleryId("app-loom-aurora-failed"),
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
];

export const allLooms: Loom[] = [...auroraLooms, ...finchLooms];

// The ids of the looms doing autonomous work right now (running).
export const activeLoomIds: string[] = [galleryId("app-loom-finch-running")];

// ---------------------------------------------------------------------------
// SCENES — looms index.
// ---------------------------------------------------------------------------

export const loomsScene: GalleryScene = {
  looms: { body: { looms: allLooms, active: activeLoomIds } },
};

export const loomsEmptyScene: GalleryScene = {
  looms: { body: { looms: [], active: [] } },
};

export const loomsErrorScene: GalleryScene = {
  looms: { body: { looms: [], active: [] }, status: 500 },
};
