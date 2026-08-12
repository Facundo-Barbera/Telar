// GALLERY (delete with /gallery) — scoping group: the live charter-drafting
// spinner + planner feed, and the workstreams read-ahead from the spec bundle.
import type { GalleryFixtureBundle } from "../index";
import {
  at,
  galleryId,
  makeAssertion,
  makeContract,
  makeLoom,
  makeSpec,
  sayEvent,
  toolEvent,
  toolResultEvent,
} from "../builders";

const scopingLoom = (slug: string, title: string, prompt: string) =>
  makeLoom({
    id: galleryId(slug),
    project: "aurora",
    kind: "custom",
    title,
    prompt,
    state: "scoping",
    createdAt: at(0),
    updatedAt: at(90),
  });

// Planner activity — operator-lane (no pieceId) say/tool/tool-result rows the
// ScopingFeed renders via eventsToTranscript.
const plannerFeed = [
  sayEvent("Reading the request and the repo layout to scope this into a charter.", at(8)),
  toolEvent("Read", { path: "app/overview/page.tsx" }, at(14)),
  toolResultEvent("Read", "// Aurora overview — server component composing 4 chart cards", true, at(16)),
  sayEvent(
    "This touches the overview page and a new data query. Proof strategy: verifier-criteria against the running dashboard.",
    at(24),
  ),
  toolEvent("Grep", { pattern: "cohort", path: "lib" }, at(30)),
  toolResultEvent("Grep", "No matches — this is net-new query work.", true, at(31)),
  sayEvent("Drafting the decomposition into a query workstream and a UI workstream.", at(40)),
];

export const scopingBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("scoping-charter"),
    label: "Scoping · drafting the charter",
    group: "scoping",
    description:
      "A live charter draft: the spinner plus the planner's real activity feed (ScopingFeed over the event stream).",
    surface: "scoping",
    loom: scopingLoom(
      "scoping-charter",
      "Add a weekly cohort-retention heatmap",
      "Add a cohort-retention heatmap to the Aurora overview, bucketed by signup week.",
    ),
    threads: [],
    feed: plannerFeed,
  },
  {
    id: galleryId("scoping-workstreams"),
    label: "Scoping · planned workstreams",
    group: "scoping",
    description:
      "The workstreams read-ahead — the spec bundle's contract partitioned by subGoalId (two threads + a cross-cutting lens).",
    surface: "scoping",
    loom: scopingLoom(
      "scoping-workstreams",
      "Realtime CSV export with an audit trail",
      "Stream a filtered CSV export and record each export in an audit log.",
    ),
    threads: [],
    feed: plannerFeed,
    spec: makeSpec({
      objective:
        "Export the filtered events table as a streamed CSV, and append an audit-log row for every export.",
      contract: makeContract([
        makeAssertion({
          id: "a1",
          subGoalId: "s1",
          description: "The CSV endpoint streams all rows across page boundaries.",
          type: "command",
          expected: "bun test export/stream.test.ts",
        }),
        makeAssertion({
          id: "a2",
          subGoalId: "s1",
          description: "The download names the file with the active filter + date.",
          type: "live-critic",
          observable: "the browser's download filename after clicking Export",
        }),
        makeAssertion({
          id: "a3",
          subGoalId: "s2",
          description: "Each export writes exactly one audit-log row.",
          type: "contains",
          expected: "INSERT INTO audit_log",
        }),
        makeAssertion({
          id: "a4",
          subGoalId: "ALL",
          description: "No regression to the existing events table rendering.",
          type: "live-critic",
          observable: "the events table still paginates and filters as before",
          blocker: false,
        }),
      ]),
    }),
  },
];
