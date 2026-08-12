// GALLERY (delete with /gallery) — terminal group: the lifecycle end-states in
// the god-view — done (committed), failed, halted, skipped, and queued.
import type { GalleryFixtureBundle } from "../index";
import { at, galleryId, makeAttempt, makeEvent, makeLoom, makeVerdict } from "../builders";

export const terminalBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("terminal-done"),
    label: "Done · committed",
    group: "terminal",
    description:
      "An accepted loom — the DoneConfirmation with the landed commit sha and who accepted it.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("terminal-done"),
      project: "finch",
      kind: "quickfix",
      title: "Fix prerelease precedence (1.0.0-rc.1 < 1.0.0)",
      prompt: "Prerelease tags must sort below the release per semver §11.",
      state: "done",
      createdAt: at(0),
      updatedAt: at(500),
      commit: "9f3c2ab41d7e0b8c",
      // Accepted weave — the review branch was merged; the badge shows the
      // "Landed as <sha>" merged copy (state done + commit).
      consolidationBranch: `telar/${galleryId("terminal-done")}`,
      attempts: [
        makeAttempt({
          costUsd: 0.31,
          startedAt: at(120),
          endedAt: at(300),
          verdict: makeVerdict({ summary: "Prerelease tags now sort below the release; added a precedence test." }),
        }),
      ],
    }),
    threads: [],
    feed: [
      makeEvent("accepted", { ts: at(480), by: "you" }),
      makeEvent("committed", { ts: at(482), sha: "9f3c2ab41d7e0b8c", by: "you" }),
    ],
  },
  {
    id: galleryId("terminal-failed"),
    label: "Failed · operator failure",
    group: "terminal",
    description:
      "A loom that failed — the terminal error reason plus the builder's own red verdict on the operator card.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("terminal-failed"),
      project: "aurora",
      kind: "story",
      title: "Realtime presence indicators",
      prompt: "Show who else is viewing a dashboard via a websocket presence channel.",
      state: "failed",
      createdAt: at(0),
      updatedAt: at(400),
      error: "Setup lane never came up — the websocket gateway exited on boot (exit 1) after 3 restarts.",
      attempts: [
        makeAttempt({
          costUsd: 0.12,
          startedAt: at(120),
          endedAt: at(180),
          verdict: makeVerdict({ ok: false, summary: "Could not stand the presence gateway up to build against.", blocker: "gateway exits on boot" }),
        }),
      ],
    }),
    threads: [],
    feed: [],
  },
  {
    id: galleryId("terminal-halted"),
    label: "Halted",
    group: "terminal",
    description: "A loom the owner cancelled mid-flight — the halted status in the god-view.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("terminal-halted"),
      project: "aurora",
      kind: "custom",
      title: "Migrate the events table to server components",
      prompt: "Move the events table off the client bundle onto RSC streaming.",
      state: "halted",
      createdAt: at(0),
      updatedAt: at(260),
      error: "Cancelled by you at 4m 20s.",
      attempts: [makeAttempt({ costUsd: 0.44, startedAt: at(120), endedAt: at(260) })],
    }),
    threads: [],
    feed: [],
  },
  {
    id: galleryId("terminal-skipped"),
    label: "Skipped",
    group: "terminal",
    description: "A dependent thread skipped because its prerequisite never landed — the skipped status.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("terminal-skipped"),
      project: "aurora",
      kind: "custom",
      title: "Export button (depends on the export endpoint)",
      prompt: "Add the Export button once the streaming endpoint exists.",
      state: "skipped",
      createdAt: at(0),
      updatedAt: at(200),
      error: "Skipped — its required dependency (s1: streaming endpoint) failed.",
      attempts: [],
    }),
    threads: [],
    feed: [],
  },
  {
    id: galleryId("terminal-queued"),
    label: "Queued",
    group: "terminal",
    description: "A loom waiting to start — the queued status, no attempts yet.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("terminal-queued"),
      project: "finch",
      kind: "custom",
      title: "Add a --json flag to the finch CLI",
      prompt: "Emit machine-readable JSON from the CLI when --json is passed.",
      state: "queued",
      createdAt: at(0),
      updatedAt: at(10),
      attempts: [],
    }),
    threads: [],
    feed: [],
  },
];
