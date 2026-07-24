// LANE: delivery (UX brainstorm 2026-07-23) — FINAL DESIGN fixtures. One
// afternoon, three deliveries ready. Continuity with the home lane: aurora's
// payments-retry (ready at 11:32) plus ozom's client-role-seeding and
// novarix's invoice-rounding finishing later the same day. Every delivery is
// a full card: the shelf skim opens into glass-on-top + dossier below.
//
// Grounding (verification session 2026-07-18, courtroom verdicts): evidence
// ledger with provenance stamps + narrative-must-cite (uncited = marked
// unverified) · attempt history kept on the card + flaky flags · lab grades
// (accept-gating ALL-verify runs at release grade) · reality manifest surfaced
// on the card · accept-then-land (landing silent unless it knocks) · rejection
// is a boomerang, not a bin. Vision critic = advisory pre-verdict (loom-system
// log line 79, MoSCoW COULD). Drift note declared on accept (drift ledger).

export type EvidenceKind = "shot" | "test" | "log" | "diff";

export type LedgerItem = {
  id: string; // E1.. — what narrative claims and contract asserts cite
  kind: EvidenceKind;
  label: string;
  provenance: string; // harness-stamped: who captured it, which lane, when
  note: string;
};

export type NarrativeClaim = {
  text: string;
  cites: string[]; // ledger ids; empty = the claim renders as UNVERIFIED
};

export type ContractAssert = {
  id: string;
  desc: string;
  cites: string[];
};

export type VerifyAttempt = {
  id: string; // v1..
  when: string;
  grade: "dev" | "release";
  outcome: "red" | "green";
  note: string;
  flaky?: string; // flagged, never silently retried into invisibility
};

export type DeliveryLane = {
  url: string; // the frozen final-verify lane serving the ready product
  line: string;
  views: { id: string; label: string }[]; // "live" + ledger screenshots
};

export type Delivery = {
  id: string;
  project: string;
  title: string;
  branch: string;
  meta: string; // one mono line: diff, threads, spend, span
  claim: string;
  manifest: string; // reality manifest: which mode the lab actually ran in
  lane: DeliveryLane;
  narrative: NarrativeClaim[];
  contract: ContractAssert[];
  ledger: LedgerItem[];
  attempts: VerifyAttempt[];
  vision: { verdict: string; note: string }; // advisory pre-verdict
  acceptLabel: string; // accept declares the drift note
  acceptedLine: string; // accept-then-land: what happens next, silently
  boomerangLine: string;
};

export const DELIVERIES: Delivery[] = [
  {
    id: "payments-retry",
    project: "aurora",
    title: "Payments retry with backoff",
    branch: "loom/payments-retry",
    meta: "+412 −88 · 3 threads · $4.80 · 06:10 → 11:32 · 2 repair rounds",
    claim:
      "Failed payments now retry 3× with exponential backoff, then dead-letter with an operator note.",
    manifest:
      "ran real — stripe test-mode gateway · shared postgres, fresh tenant from template · declared at the gate: no synthetic modes",
    lane: {
      url: "lane :4176",
      line: "frozen final-verify · cold checkout · shared warm infra · fresh tenant from template · release grade",
      views: [
        { id: "live", label: "live lane — /billing/dead-letters" },
        { id: "E1", label: "retry-flow.png · 11:02" },
        { id: "E3", label: "dead-letter-note.png · 11:07" },
      ],
    },
    narrative: [
      {
        text: "Failed charges now retry three times with exponential backoff — 1s, 8s, 64s — before giving up.",
        cites: ["E1", "E2"],
      },
      {
        text: "A payment that exhausts its retries dead-letters with an operator note: the last gateway error and a one-click replay.",
        cites: ["E3"],
      },
      {
        text: "Retries drain on the worker tick; no user-facing request ever waits on one.",
        cites: ["E4", "E5"],
      },
      {
        text: "The existing happy path is untouched — the full regression suite stayed green.",
        cites: ["E6"],
      },
      {
        text: "Two new billing env vars (RETRY_MAX, RETRY_BASE_MS); no existing values changed.",
        cites: [],
      },
    ],
    contract: [
      { id: "A1", desc: "failed charge retries 3× with exponential backoff", cites: ["E2"] },
      { id: "A2", desc: "backoff timing 1s / 8s / 64s honored", cites: ["E2"] },
      { id: "A3", desc: "4th failure dead-letters the payment", cites: ["E1"] },
      { id: "A4", desc: "dead-letter row carries operator note + last gateway error", cites: ["E3"] },
      { id: "A5", desc: "replay link re-enqueues the payment once", cites: ["E3"] },
      { id: "A6", desc: "no user-facing request blocks on a retry", cites: ["E4"] },
      { id: "A7", desc: "p95 checkout latency unchanged under injected failures", cites: ["E5"] },
      { id: "A8", desc: "regression suite green — 212 passing", cites: ["E6"] },
      { id: "A9", desc: "diff bounded to payments worker + billing UI", cites: ["E7"] },
    ],
    ledger: [
      {
        id: "E1",
        kind: "shot",
        label: "retry-flow.png",
        provenance: "harness · release lane · 11:02",
        note: "checkout fails twice, succeeds on the third retry; 4th failure lands in dead-letters",
      },
      {
        id: "E2",
        kind: "test",
        label: "retry-backoff.spec",
        provenance: "harness · release lane · 11:04",
        note: "backoff timing asserted at 1s / 8s / 64s",
      },
      {
        id: "E3",
        kind: "shot",
        label: "dead-letter-note.png",
        provenance: "harness · release lane · 11:07",
        note: "operator note with gateway error + replay link on the dead-letter row",
      },
      {
        id: "E4",
        kind: "log",
        label: "worker-drain.log",
        provenance: "harness · release lane · 11:12",
        note: "queue drains on tick · 0 blocked requests over 40 injected failures",
      },
      {
        id: "E5",
        kind: "test",
        label: "checkout-latency.spec",
        provenance: "harness · release lane · 11:14",
        note: "p95 within 2% of baseline under failure injection",
      },
      {
        id: "E6",
        kind: "test",
        label: "regression-suite",
        provenance: "harness · release lane · 11:22",
        note: "212 passing · payment happy path untouched",
      },
      {
        id: "E7",
        kind: "diff",
        label: "loom-diff",
        provenance: "harness · branch head · 11:29",
        note: "+412 −88 across worker/, billing/dead-letters/, env schema",
      },
    ],
    attempts: [
      {
        id: "v1",
        when: "07:58",
        grade: "dev",
        outcome: "red",
        note: "A4 — dead-letter note missing the gateway error → repair",
      },
      {
        id: "v2",
        when: "09:36",
        grade: "dev",
        outcome: "red",
        note: "A7 — p95 regression under injected failures → repair",
        flaky: "lab boot flaky — postgres readiness retried ×2, flagged",
      },
      { id: "v3", when: "10:41", grade: "dev", outcome: "green", note: "9/9 at dev grade" },
      {
        id: "v4",
        when: "11:29",
        grade: "release",
        outcome: "green",
        note: "accept-gating ALL-verify — cold checkout · fresh tenant",
      },
    ],
    vision: {
      verdict: "aligned",
      note: "matches the billing-resilience objective on the map · 1 note: the operator replay surface is new and unowned in the form region",
    },
    acceptLabel: "Accept — declares 1 map note",
    acceptedLine:
      "accepted · landing queued: rebase onto main → release-grade re-verify → lands silently, knocks only if repair exhausts · 1 map note → drift ledger",
    boomerangLine:
      "boomeranged — resumes on loom/payments-retry with your note · branch, worktree and recipe kept",
  },
  {
    id: "client-role-seeding",
    project: "ozom",
    title: "P10 · client role + access seeding",
    branch: "loom/client-role-seeding",
    meta: "+198 −12 · 2 threads · $3.10 · 07:15 → 12:04 · 0 repair rounds",
    claim:
      "A seeded client role logs in and completes checkout with client-scoped access only.",
    manifest:
      "ran real — shared supabase stack · fresh tenant from template · carry planted: supabase/.env.keys · declared: no synthetic modes",
    lane: {
      url: "lane :4551",
      line: "frozen final-verify · cold checkout · shared supabase stack · fresh tenant from template · release grade",
      views: [
        { id: "live", label: "live lane — /checkout (client role)" },
        { id: "E1", label: "login-as-client.png · 11:48" },
        { id: "E2", label: "checkout-client.png · 11:52" },
      ],
    },
    narrative: [
      {
        text: "A client role is seeded with checkout access and nothing else — admin surfaces are walled off for it.",
        cites: ["E1", "E3"],
      },
      {
        text: "Login as the seeded client works end to end; checkout completes under client-scoped keys.",
        cites: ["E1", "E2"],
      },
      {
        text: "Seeding is idempotent — running it twice changes nothing.",
        cites: ["E4"],
      },
    ],
    contract: [
      { id: "A1", desc: "client role exists after seed", cites: ["E4"] },
      { id: "A2", desc: "client login succeeds", cites: ["E1"] },
      { id: "A3", desc: "checkout completes as client", cites: ["E2"] },
      { id: "A4", desc: "admin routes deny the client role", cites: ["E3"] },
      { id: "A5", desc: "client sees only client-scoped rows", cites: ["E3"] },
      { id: "A6", desc: "seed is idempotent on re-run", cites: ["E4"] },
      { id: "A7", desc: "diff bounded to seed + access policies", cites: ["E5"] },
    ],
    ledger: [
      {
        id: "E1",
        kind: "shot",
        label: "login-as-client.png",
        provenance: "harness · release lane · 11:48",
        note: "seeded client credentials land on the client dashboard",
      },
      {
        id: "E2",
        kind: "shot",
        label: "checkout-client.png",
        provenance: "harness · release lane · 11:52",
        note: "checkout completed under the client session",
      },
      {
        id: "E3",
        kind: "test",
        label: "access-wall.spec",
        provenance: "harness · release lane · 11:55",
        note: "admin routes 404 for client · row-level scope asserted",
      },
      {
        id: "E4",
        kind: "test",
        label: "seed-idempotent.spec",
        provenance: "harness · release lane · 11:57",
        note: "second seed run: zero rows changed",
      },
      {
        id: "E5",
        kind: "diff",
        label: "loom-diff",
        provenance: "harness · branch head · 12:01",
        note: "+198 −12 across seed/, policies/",
      },
    ],
    attempts: [
      { id: "v1", when: "09:48", grade: "dev", outcome: "green", note: "7/7 at dev grade" },
      {
        id: "v2",
        when: "11:58",
        grade: "release",
        outcome: "green",
        note: "accept-gating ALL-verify — cold checkout · fresh tenant",
      },
    ],
    vision: {
      verdict: "aligned",
      note: "matches the P10 carga-lite objective on the map · no notes",
    },
    acceptLabel: "Accept",
    acceptedLine:
      "accepted · landing queued: rebase onto main → release-grade re-verify → lands silently, knocks only if repair exhausts",
    boomerangLine:
      "boomeranged — resumes on loom/client-role-seeding with your note · branch, worktree and recipe kept",
  },
  {
    id: "invoice-rounding",
    project: "novarix",
    title: "Invoice rounding on receipts",
    branch: "loom/invoice-rounding",
    meta: "+230 −74 · 2 threads · $5.60 · 06:48 → 13:37 · 3 repair rounds",
    claim:
      "Receipt totals round half-even across all three currencies; the drift is gone.",
    manifest:
      "ran real postgres · fresh tenant from template · FX rates synthetic — declared at the gate",
    lane: {
      url: "lane :4620",
      line: "frozen final-verify · cold checkout · shared warm infra · fresh tenant from template · release grade",
      views: [
        { id: "live", label: "live lane — /receipts" },
        { id: "E1", label: "receipt-green.png · 13:22" },
      ],
    },
    narrative: [
      {
        text: "Receipt totals now round half-even at the line level and the total — the drift between them is gone.",
        cites: ["E1", "E2"],
      },
      {
        text: "All three currencies (MXN, USD, EUR) verified against golden receipts.",
        cites: ["E2"],
      },
      {
        text: "Historic receipts are untouched — the new rounding applies from the migration forward.",
        cites: ["E3"],
      },
      {
        text: "FX conversion paths ran on synthetic rates, exactly as declared at the gate.",
        cites: ["E4"],
      },
    ],
    contract: [
      { id: "A1", desc: "line items round half-even", cites: ["E1"] },
      { id: "A2", desc: "totals round half-even", cites: ["E1"] },
      { id: "A3", desc: "line-vs-total drift = 0 across 500 golden receipts", cites: ["E2"] },
      { id: "A4", desc: "MXN golden receipts match", cites: ["E2"] },
      { id: "A5", desc: "USD golden receipts match", cites: ["E2"] },
      { id: "A6", desc: "EUR golden receipts match", cites: ["E2"] },
      { id: "A7", desc: "historic receipts unchanged", cites: ["E3"] },
      { id: "A8", desc: "regression suite green", cites: ["E5"] },
      { id: "A9", desc: "diff bounded to rounding module + receipt render", cites: ["E6"] },
    ],
    ledger: [
      {
        id: "E1",
        kind: "shot",
        label: "receipt-green.png",
        provenance: "harness · release lane · 13:22",
        note: "3-currency receipt with matching line and total rounding",
      },
      {
        id: "E2",
        kind: "test",
        label: "golden-receipts.spec",
        provenance: "harness · release lane · 13:25",
        note: "500 golden receipts · drift 0 across MXN / USD / EUR",
      },
      {
        id: "E3",
        kind: "test",
        label: "historic-freeze.spec",
        provenance: "harness · release lane · 13:27",
        note: "pre-migration receipts byte-identical",
      },
      {
        id: "E4",
        kind: "log",
        label: "fx-synthetic.log",
        provenance: "harness · release lane · 13:28",
        note: "FX provider stubbed with declared synthetic rates",
      },
      {
        id: "E5",
        kind: "test",
        label: "regression-suite",
        provenance: "harness · release lane · 13:31",
        note: "184 passing",
      },
      {
        id: "E6",
        kind: "diff",
        label: "loom-diff",
        provenance: "harness · branch head · 13:34",
        note: "+230 −74 across rounding/, receipts/render",
      },
    ],
    attempts: [
      {
        id: "v1",
        when: "08:11",
        grade: "dev",
        outcome: "red",
        note: "A3 — drift on MXN totals → repair",
      },
      {
        id: "v2",
        when: "09:40",
        grade: "dev",
        outcome: "red",
        note: "A3 — drift persists on 3-line receipts → repair",
      },
      {
        id: "v3",
        when: "10:52",
        grade: "dev",
        outcome: "red",
        note: "A7 — historic receipts mutated → repair",
        flaky: "e2e boot flaky ×2 — flagged",
      },
      { id: "v4", when: "12:14", grade: "dev", outcome: "green", note: "9/9 at dev grade" },
      {
        id: "v5",
        when: "13:31",
        grade: "release",
        outcome: "green",
        note: "accept-gating ALL-verify — cold checkout · fresh tenant",
      },
    ],
    vision: {
      verdict: "aligned",
      note: "matches the billing-correctness objective · 1 note: half-even is now policy — the map's billing region should record it",
    },
    acceptLabel: "Accept — declares 1 map note",
    acceptedLine:
      "accepted · landing queued: rebase onto main → release-grade re-verify → lands silently, knocks only if repair exhausts · 1 map note → drift ledger",
    boomerangLine:
      "boomeranged — resumes on loom/invoice-rounding with your note · branch, worktree and recipe kept",
  },
];

// Shelf-row compressions of the three deliveries — the 15-second skim.
export type InboxCard = {
  id: string;
  project: string;
  title: string;
  claim: string;
  proof: string;
  risks: string[];
  evidence: { label: string; age: string }[];
};

export const INBOX: InboxCard[] = [
  {
    id: "payments-retry",
    project: "aurora",
    title: "Payments retry with backoff",
    claim: DELIVERIES[0].claim,
    proof: "9/9 assertions · 6 screenshots · +412 −88",
    risks: ["touches billing env vars", "1 claim uncited"],
    evidence: [
      { label: "retry-flow.png", age: "30m" },
      { label: "dead-letter-note.png", age: "25m" },
    ],
  },
  {
    id: "client-role-seeding",
    project: "ozom",
    title: "P10 · client role + access seeding",
    claim: DELIVERIES[1].claim,
    proof: "7/7 assertions · 4 screenshots · +198 −12",
    risks: ["carry file planted: supabase/.env.keys"],
    evidence: [
      { label: "login-as-client.png", age: "45m" },
      { label: "checkout-client.png", age: "41m" },
    ],
  },
  {
    id: "invoice-rounding",
    project: "novarix",
    title: "Invoice rounding on receipts",
    claim: DELIVERIES[2].claim,
    proof: "9/9 assertions · 5 screenshots · +230 −74",
    risks: ["converged after 3 repair rounds", "flaky e2e boot ×2", "synthetic FX rates (declared)"],
    evidence: [{ label: "receipt-green.png", age: "20m" }],
  },
];
