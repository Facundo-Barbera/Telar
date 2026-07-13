// GALLERY (delete with /gallery) — charter group: the charter-review gate, as a
// single-thread charter and as a woven epic with a decomposition.
import type { GalleryFixtureBundle } from "../index";
import { at, galleryId, makeCharter, makeLoom, makeSubGoal } from "../builders";

export const charterBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("charter-single"),
    label: "Charter review · single thread",
    group: "charter",
    description:
      "A plain (non-weaving) charter awaiting approval — objective, proof strategy, scope, budget; no decomposition.",
    surface: "charter",
    loom: makeLoom({
      id: galleryId("charter-single"),
      project: "finch",
      kind: "custom",
      title: "Add range-satisfies() to the comparator",
      prompt: "Implement satisfies(version, range) for ^, ~, and hyphen ranges.",
      state: "charter-review",
      createdAt: at(0),
      updatedAt: at(140),
      charter: makeCharter({
        objective:
          "Implement `satisfies(version, range)` in the finch comparator, handling caret, tilde, and hyphen ranges with full semver precedence.",
        proofStrategy: "verifier-criteria",
        scope: {
          allowedPaths: ["src/compare/**", "src/range/**"],
          forbiddenPaths: ["src/parse/**"],
          notes: "Range logic only — leave the parser untouched.",
        },
        rationale:
          "Small, well-bounded change in one module with a clear public API — no decomposition needed; a single builder + the verifier criteria suffice.",
      }),
    }),
    threads: [],
    feed: [],
  },
  {
    id: galleryId("charter-woven"),
    label: "Charter review · woven epic",
    group: "charter",
    description:
      "A weaving charter: the decomposition into sub-goals (with dependencies) that the CharterPanel renders as a plan.",
    surface: "charter",
    loom: makeLoom({
      id: galleryId("charter-woven"),
      project: "aurora",
      kind: "story",
      title: "Realtime CSV export with an audit trail",
      prompt: "Stream a filtered CSV export and record each export in an audit log.",
      state: "charter-review",
      createdAt: at(0),
      updatedAt: at(180),
      charter: makeCharter({
        objective:
          "Ship a streamed CSV export of the filtered events table, an audit-log row per export, and a matching UI affordance — verified end-to-end against the running dashboard.",
        proofStrategy: "verifier-criteria",
        scope: {
          allowedPaths: ["app/events/**", "lib/export/**", "lib/audit/**"],
          forbiddenPaths: ["lib/auth/**"],
        },
        rationale:
          "Three separable concerns — a streaming query, an audit write, and the export button — with a natural dependency: the UI depends on the endpoint, the audit write is cross-cutting.",
        decomposition: [
          makeSubGoal({
            id: "s1",
            title: "Streaming CSV endpoint",
            detail: "A route that streams all filtered rows as CSV, across page boundaries.",
            acceptanceCriteria: [
              "Exports every filtered row, not just the first page",
              "Sets Content-Disposition with a filter-derived filename",
            ],
          }),
          makeSubGoal({
            id: "s2",
            title: "Audit-log write",
            detail: "Append exactly one audit row per export, with actor + filter.",
            acceptanceCriteria: ["One audit row per export", "Row records actor and active filter"],
            dependsOn: ["s1"],
          }),
          makeSubGoal({
            id: "s3",
            title: "Export UI affordance",
            detail: "An Export button on the events toolbar that triggers the download.",
            acceptanceCriteria: ["Button visible on the events toolbar", "Click downloads the CSV"],
            dependsOn: ["s1"],
          }),
        ],
      }),
    }),
    threads: [],
    feed: [],
  },
];
