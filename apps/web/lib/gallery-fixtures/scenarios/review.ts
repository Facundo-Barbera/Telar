// GALLERY (delete with /gallery) — review group: the right-rail AcceptancePanel
// for a needs-review loom — the builder's red self-report plus the audited
// owner-override path (accept anyway / send back).
import type { GalleryFixtureBundle } from "../index";
import {
  at,
  galleryId,
  makeAttempt,
  makeCritic,
  makeLoom,
  makePanel,
  makeVerdict,
} from "../builders";

export const reviewBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("review-red-override"),
    label: "Review · red verdict + override",
    group: "review",
    description:
      "The needs-review rail: the failing verdict, the must-clear blocker, and the audited owner-override (accept anyway).",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("review-red-override"),
      project: "aurora",
      kind: "custom",
      title: "CSV export for the events table",
      prompt: "Stream a CSV of the filtered events table to the browser.",
      state: "needs-review",
      createdAt: at(0),
      updatedAt: at(500),
      contractRequired: true,
      error: "adversarial/pagination did not clear: export omits rows past the 10k page boundary.",
      attempts: [
        makeAttempt({
          costUsd: 1.1,
          startedAt: at(120),
          endedAt: at(450),
          verdict: makeVerdict({
            ok: false,
            summary: "Export works for typical filters but truncates very large result sets.",
            blocker: "export stops at the first 10k rows",
            files_touched: ["app/api/events/export/route.ts", "lib/export/csv.ts"],
          }),
          panelReport: makePanel(
            [
              makeCritic({
                lens: "adversarial/pagination",
                class: "adversarial",
                blocker: true,
                ok: false,
                summary: "Rows past the first page are silently dropped from the export.",
              }),
            ],
            { url: "http://localhost:4310/events" },
          ),
        }),
      ],
    }),
    threads: [],
    feed: [],
  },
];
