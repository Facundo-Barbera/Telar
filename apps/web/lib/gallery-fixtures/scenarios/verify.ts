// GALLERY (delete with /gallery) — verify group: the independent-verdict Verify
// tab across its states — in-progress timeline, gate results, per-thread and
// integration verifies, red verdicts, must-clear-vs-advisory critics, and the
// auto-repair convergence loop.
import type { GalleryFixtureBundle } from "../index";
import type { Loom } from "@telar/core";
import {
  at,
  galleryId,
  greenPanel,
  makeAttempt,
  makeCharter,
  makeCritic,
  makeEvent,
  makeEvidence,
  makeFinding,
  makeGate,
  makeLoom,
  makePanel,
  makeRepairRound,
  makeSubGoal,
  makeVerdict,
  PNG_DATA_URI,
} from "../builders";

const wovenRoot = (slug: string, title: string, state: Loom["state"], extra: Partial<Loom> = {}): Loom =>
  makeLoom({
    id: galleryId(slug),
    project: "aurora",
    kind: "story",
    title,
    prompt: "Streamed CSV export + audit write + export button, verified end-to-end.",
    state,
    createdAt: at(0),
    updatedAt: at(600),
    charter: makeCharter({
      objective: "Streamed CSV export + audit write + export button.",
      decomposition: [
        makeSubGoal({ id: "s1", title: "Streaming CSV endpoint" }),
        makeSubGoal({ id: "s2", title: "Audit-log write", dependsOn: ["s1"] }),
      ],
    }),
    ...extra,
  });

const thread = (root: string, subGoalId: string, slug: string, title: string, state: Loom["state"], extra: Partial<Loom> = {}): Loom =>
  makeLoom({
    id: galleryId(slug),
    parentLoomId: root,
    subGoalId,
    project: "aurora",
    kind: "custom",
    title,
    state,
    createdAt: at(200),
    updatedAt: at(500),
    ...extra,
  });

export const verifyBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("verify-in-progress"),
    label: "Verify · in progress",
    group: "verify",
    description:
      "The live verifier/critic process timeline — critics starting, driving the app, and reporting observations as they go.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("verify-in-progress"),
      project: "aurora",
      kind: "custom",
      title: "CSV export for the events table",
      prompt: "Stream a CSV of the filtered events table to the browser.",
      state: "verifying",
      createdAt: at(0),
      updatedAt: at(500),
      contractRequired: true,
      attempts: [makeAttempt({ costUsd: 0.9, startedAt: at(120), endedAt: at(400) })],
    }),
    threads: [],
    feed: [
      makeEvent("critic-start", { ts: at(410), lens: "adversarial/edge-cases", blocker: true }),
      makeEvent("critic-text", { ts: at(412), lens: "adversarial/edge-cases", text: "Checking the export past the 10k page boundary." }),
      makeEvent("critic-step", { ts: at(414), lens: "adversarial/edge-cases", name: "browser_navigate", input: "/events?filter=errors" }),
      makeEvent("critic-observation", { ts: at(418), lens: "adversarial/edge-cases", kind: "network", output: "GET /api/events/export → 200, 42MB stream" }),
      makeEvent("critic-start", { ts: at(420), lens: "reproduction/cold-retry", blocker: true }),
      makeEvent("critic-text", { ts: at(422), lens: "reproduction/cold-retry", text: "Replaying the documented export steps from a cold session." }),
    ],
    viewHints: ["verify"],
  },
  {
    id: galleryId("verify-gate-results"),
    label: "Verify · gate results",
    group: "verify",
    description:
      "Deterministic gates — a pass/fail mix (typecheck + unit green, lint red). The offline layer before the panel.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("verify-gate-results"),
      project: "finch",
      kind: "custom",
      title: "Add range-satisfies() to the comparator",
      prompt: "Implement satisfies(version, range) for ^, ~, and hyphen ranges.",
      state: "verifying",
      createdAt: at(0),
      updatedAt: at(500),
      attempts: [
        makeAttempt({
          costUsd: 0.5,
          startedAt: at(120),
          endedAt: at(420),
          verdict: makeVerdict({ files_touched: ["src/range/satisfies.ts"] }),
          gates: [
            makeGate({ name: "typecheck", ok: true, output: "tsc --noEmit — 0 errors", durationMs: 4200 }),
            makeGate({ name: "unit", ok: true, output: "bun test — 214 pass, 0 fail", durationMs: 8800 }),
            makeGate({
              name: "lint",
              ok: false,
              exitCode: 1,
              output: "src/range/satisfies.ts:41  'coerce' is defined but never used  (no-unused-vars)",
              durationMs: 1900,
            }),
          ],
        }),
      ],
    }),
    threads: [],
    feed: [],
    viewHints: ["verify"],
  },
  {
    id: galleryId("verify-thread"),
    label: "Verify · per-thread report",
    group: "verify",
    description:
      "A woven weave — each thread carries its own panel verdict (scope: thread). The per-thread VerifyReport blocks.",
    surface: "godview",
    loom: wovenRoot("verify-thread", "Realtime CSV export with an audit trail", "ready"),
    threads: [
      thread(galleryId("verify-thread"), "s1", "vthread-s1", "Streaming CSV endpoint", "ready", {
        contractRequired: true,
        attempts: [
          makeAttempt({
            costUsd: 1.0,
            verdict: makeVerdict({ summary: "Streamed export reuses buildFilter(); covers all pages." }),
            panelReport: greenPanel(
              [
                makeCritic({
                  lens: "reproduction/happy-path",
                  class: "reproduction",
                  blocker: true,
                  ok: true,
                  summary: "Exported a filtered set from a cold session — every row present.",
                }),
              ],
              "http://localhost:4310/events",
            ),
          }),
        ],
      }),
      thread(galleryId("verify-thread"), "s2", "vthread-s2", "Audit-log write", "ready", {
        contractRequired: true,
        attempts: [
          makeAttempt({
            costUsd: 0.6,
            verdict: makeVerdict({ summary: "One audit row per export, with actor + filter." }),
            gates: [makeGate({ name: "audit-count", ok: true, output: "1 row inserted per export — assertion held" })],
          }),
        ],
      }),
    ],
    feed: [],
    viewHints: ["verify"],
  },
  {
    id: galleryId("verify-integration"),
    label: "Verify · integration verdict",
    group: "verify",
    description:
      "The end-of-orchestration integration verify over the COMPOSED whole (scope: ALL) — the root's own green verdict.",
    surface: "godview",
    loom: wovenRoot("verify-integration", "Realtime CSV export with an audit trail", "ready", {
      latestVerdict: "pass",
      // Woven root built under worktree isolation carries the review-branch
      // deliverable — ready (not done) so the badge shows the "not yet merged" copy.
      consolidationBranch: `telar/${galleryId("verify-integration")}`,
    }),
    threads: [
      thread(galleryId("verify-integration"), "s1", "vint-s1", "Streaming CSV endpoint", "ready", {
        attempts: [makeAttempt({ costUsd: 1.0, verdict: makeVerdict(), panelReport: greenPanel() })],
      }),
      thread(galleryId("verify-integration"), "s2", "vint-s2", "Audit-log write", "ready", {
        attempts: [makeAttempt({ costUsd: 0.6, verdict: makeVerdict(), gates: [makeGate({ name: "audit-count", ok: true })] })],
      }),
    ],
    feed: [
      makeEvent("verify-summary", {
        ts: at(560),
        source: "panel",
        panelRequired: true,
        reason: "All required threads verified; the composed whole passed regression + completeness.",
      }),
      makeEvent("panel", {
        ts: at(562),
        report: greenPanel(
          [
            makeCritic({
              lens: "intent/completeness",
              class: "intent",
              blocker: false,
              ok: true,
              summary: "Every acceptance criterion across s1+s2 is satisfied in the composed build.",
            }),
          ],
          "http://localhost:4310",
        ),
      }),
      makeEvent("integration-verify", { ts: at(565), verification: "pass" }),
    ],
    viewHints: ["verify"],
  },
  {
    id: galleryId("verify-red-verdict"),
    label: "Verify · red verdict",
    group: "verify",
    description:
      "A must-clear lens that did not clear — the red integration verdict that demotes the weave to needs-review.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("verify-red-verdict"),
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
          verdict: makeVerdict({ ok: false, blocker: "export stops at the first 10k rows" }),
          panelReport: makePanel(
            [
              makeCritic({
                lens: "adversarial/pagination",
                class: "adversarial",
                blocker: true,
                ok: false,
                summary: "The export truncates at the first page — rows past 10k are silently dropped.",
                findings: [
                  makeFinding({
                    severity: "blocker",
                    title: "Truncated export",
                    detail: "A filter matching 24k rows exported only 10,000 — no error, no warning.",
                    recommendation: "Paginate the export cursor until the result set is exhausted.",
                    evidence: [makeEvidence({ kind: "console", text: "exported 10000 of 24118 rows", label: "export truncation" })],
                  }),
                ],
              }),
            ],
            { url: "http://localhost:4310/events" },
          ),
        }),
      ],
    }),
    threads: [],
    feed: [],
    viewHints: ["verify"],
  },
  {
    id: galleryId("verify-critics-mustclear-advisory"),
    label: "Verify · must-clear vs advisory",
    group: "verify",
    description:
      "A blocker lens (must clear) alongside an advisory lens (nudges, never gates) — each with findings and evidence.",
    surface: "godview",
    loom: makeLoom({
      id: galleryId("verify-critics-mustclear-advisory"),
      project: "aurora",
      kind: "custom",
      title: "Presence indicators on the dashboard",
      prompt: "Show who else is viewing a dashboard via a websocket presence channel.",
      state: "needs-review",
      createdAt: at(0),
      updatedAt: at(500),
      contractRequired: true,
      error: "adversarial/isolation did not clear: presence leaks across dashboards.",
      attempts: [
        makeAttempt({
          costUsd: 1.3,
          startedAt: at(120),
          endedAt: at(460),
          verdict: makeVerdict({ ok: false, blocker: "presence channel is not scoped per dashboard" }),
          panelReport: makePanel(
            [
              makeCritic({
                lens: "adversarial/isolation",
                class: "adversarial",
                blocker: true,
                ok: false,
                summary: "Presence events from one dashboard appear on another — the channel is global.",
                findings: [
                  makeFinding({
                    severity: "blocker",
                    title: "Cross-dashboard presence leak",
                    detail: "Opening dashboard A showed a viewer who was only on dashboard B.",
                    recommendation: "Scope the presence channel to the dashboard id.",
                    evidence: [
                      makeEvidence({ kind: "screenshot", path: "critic/presence-leak.png", label: "leaked viewer on A" }),
                    ],
                  }),
                ],
                evidence: [makeEvidence({ kind: "screenshot", path: "critic/presence-leak.png", label: "reproduction" })],
              }),
              makeCritic({
                lens: "aesthetic/polish",
                class: "aesthetic",
                blocker: false,
                ok: false,
                summary: "The presence avatars overlap awkwardly and lack a tooltip — advisory only.",
                findings: [
                  makeFinding({
                    severity: "minor",
                    title: "Avatar stack has no overflow affordance",
                    detail: "Beyond four viewers the avatars clip instead of collapsing to a +N chip.",
                    recommendation: "Collapse to a +N chip past four avatars.",
                    evidence: [makeEvidence({ kind: "a11ySnapshot", text: "img group without accessible name", label: "avatar stack" })],
                  }),
                ],
              }),
            ],
            { url: "http://localhost:4310/d/aurora" },
          ),
        }),
      ],
    }),
    threads: [],
    feed: [],
    evidence: { "critic/presence-leak.png": PNG_DATA_URI },
    viewHints: ["verify"],
  },
  {
    id: galleryId("verify-repair-converged"),
    label: "Verify · repair converged",
    group: "verify",
    description:
      "The bounded auto-repair loop that CONVERGED — the failing set strictly shrank round over round to zero, landing ready.",
    surface: "godview",
    loom: wovenRoot("verify-repair-converged", "Realtime CSV export with an audit trail", "ready", {
      repairHistory: [
        makeRepairRound({ n: 1, verification: "fail", failingIds: ["a1", "a2", "a3"], passingIds: ["a4"], costUsd: 0, startedAt: at(400), endedAt: at(445) }),
        makeRepairRound({ n: 2, verification: "fail", failingIds: ["a2", "a3"], passingIds: ["a1", "a4"], costUsd: 0.6, startedAt: at(460), endedAt: at(520) }),
        makeRepairRound({ n: 3, verification: "pass", failingIds: [], passingIds: ["a1", "a2", "a3", "a4"], costUsd: 0.7, startedAt: at(540), endedAt: at(600) }),
      ],
    }),
    threads: [
      thread(galleryId("verify-repair-converged"), "s1", "vrc-s1", "Streaming CSV endpoint", "ready", {
        attempts: [makeAttempt({ costUsd: 1.0, verdict: makeVerdict(), panelReport: greenPanel() })],
      }),
      thread(galleryId("verify-repair-converged"), "s2", "vrc-s2", "Audit-log write", "ready", {
        attempts: [makeAttempt({ costUsd: 0.6, verdict: makeVerdict(), gates: [makeGate({ name: "audit-count", ok: true })] })],
      }),
    ],
    feed: [
      makeEvent("verify-summary", { ts: at(605), source: "panel", panelRequired: true, reason: "Repair converged; the composed whole passes." }),
      makeEvent("integration-verify", { ts: at(606), verification: "pass" }),
    ],
    viewHints: ["verify"],
  },
  {
    id: galleryId("verify-repair-escalated"),
    label: "Verify · repair escalated",
    group: "verify",
    description:
      "The auto-repair guard tripped — a fix regressed a previously-green assertion, so the loop escalated to needs-review.",
    surface: "godview",
    loom: wovenRoot("verify-repair-escalated", "Realtime CSV export with an audit trail", "needs-review", {
      error: "regression: a1 — the fix for a3 broke the previously-green a1 golden diff (guard 4).",
      repairHistory: [
        makeRepairRound({ n: 1, verification: "fail", failingIds: ["a2", "a3"], passingIds: ["a1", "a4"], costUsd: 0, startedAt: at(400), endedAt: at(445) }),
        makeRepairRound({ n: 2, verification: "fail", failingIds: ["a1"], passingIds: ["a2", "a3", "a4"], costUsd: 0.6, startedAt: at(460), endedAt: at(520) }),
      ],
    }),
    threads: [
      thread(galleryId("verify-repair-escalated"), "s1", "vre-s1", "Streaming CSV endpoint", "needs-review", {
        error: "golden diff a1 regressed",
        attempts: [makeAttempt({ costUsd: 1.2, verdict: makeVerdict({ ok: false, blocker: "a1 golden diff regressed" }) })],
      }),
      thread(galleryId("verify-repair-escalated"), "s2", "vre-s2", "Audit-log write", "ready", {
        attempts: [makeAttempt({ costUsd: 0.6, verdict: makeVerdict(), gates: [makeGate({ name: "audit-count", ok: true })] })],
      }),
    ],
    feed: [
      makeEvent("verify-summary", { ts: at(525), source: "panel", panelRequired: true, reason: "Repair escalated on a regression." }),
      makeEvent("integration-verify", { ts: at(526), verification: "fail" }),
    ],
    viewHints: ["verify"],
  },
];
