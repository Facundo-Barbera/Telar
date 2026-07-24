// LANE: workspace (CONCEPT) — fixtures for the organization-module mockups.
// Everything here is fake and deliberately opinionated: it renders the ideas
// from the 2026-07-23 brainstorm (context bank, desk rail, queue as drawer,
// work packets, batches, bed mode) as if they already existed. Timestamps are
// static strings — no wall clock anywhere (see ../now.ts for why).
//
// v1 ingestion decision: sources are NOT an integration enum. Everything from
// outside is hand-fed (pasted, typed, dropped) and interpreted by agents, so
// provenance is a free-form label, not a channel type.
//
// Lanes are DYNAMIC data, not an enum: the user splits/renames them as life
// demands, the master may PROPOSE a split when a cluster crowds a lane, and
// acceptance is human. The fixture state shows one such split already
// accepted: "Aurora" carved out of "Office" (see its `note`).

export type DeadlineKind = "external" | "self";

export interface WsDeadline {
  label: string; // "Fri" / "Sep 2"
  kind: DeadlineKind;
  slips?: number; // self-deadlines remember how often they slid
}

// One queue item. `packet` present = rich work packet; absent = plain todo.
// `subtasks` is where decomposition lives — INSIDE the item, so breaking work
// down never grows the queue (the conservation law's pressure valve).
export interface WsItem {
  id: string;
  rank: number;
  title: string;
  project?: string; // absent = floating (no project yet)
  mirrored?: string; // foreign issue ref, e.g. "#214" — Telar holds a view only
  provenance: string; // free-form: how it got in ("note", "pasted transcript"…)
  captured: string; // static "Tue 16:42"-style label
  deadline?: WsDeadline;
  packet?: { files: number; mockups: number };
  verdict?: "session" | "loom"; // expert triage: how this should be executed
  subtasks?: { title: string; done?: boolean }[];
}

export interface WsLane {
  key: string; // user-defined — lanes are data, never an enum
  label: string;
  window: string; // coarse, shifting — never clock-scheduled
  note?: string; // structural provenance ("split from Office — accepted Mon")
  items: WsItem[];
}

export const WS_LANES: WsLane[] = [
  {
    key: "aurora",
    label: "Aurora",
    window: "work hours",
    note: "split from Office — you accepted Mon",
    items: [
      {
        id: "ws-aurora-accept",
        rank: 1,
        title: "Accept payments-retry loom (evidence ready)",
        project: "aurora",
        provenance: "loom event",
        captured: "today 03:12",
        verdict: "session",
      },
      {
        id: "ws-aurora-onboarding",
        rank: 2,
        title: "Rework onboarding flow",
        project: "aurora",
        mirrored: "#218",
        provenance: "note",
        captured: "Tue 16:42",
        deadline: { label: "Fri", kind: "self", slips: 0 },
        packet: { files: 3, mockups: 1 },
        verdict: "loom",
      },
      {
        id: "ws-aurora-export",
        rank: 3,
        title: "Remove CSV export button",
        project: "aurora",
        mirrored: "#214",
        provenance: "pasted transcript",
        captured: "Wed 14:19",
        deadline: { label: "Fri", kind: "external" },
        verdict: "session",
      },
      {
        id: "ws-diego-pr",
        rank: 4,
        title: "Review Diego’s PR on the exports module",
        project: "aurora",
        mirrored: "#221",
        provenance: "mirror sync",
        captured: "Wed 17:30",
        verdict: "session",
      },
      {
        id: "ws-demo-notes",
        rank: 5,
        title: "Prep Thursday demo walkthrough notes",
        project: "aurora",
        provenance: "note",
        captured: "Wed 11:02",
        deadline: { label: "Thu", kind: "self", slips: 0 },
      },
    ],
  },
  {
    key: "office",
    label: "Office",
    window: "work hours",
    items: [
      {
        id: "ws-maria",
        rank: 1,
        title: "Call María about the invoice",
        provenance: "chat",
        captured: "Wed 18:04",
        deadline: { label: "Fri", kind: "external" },
      },
    ],
  },
  {
    key: "school",
    label: "School",
    window: "evenings, shifts with the term",
    items: [
      {
        id: "ws-essay",
        rank: 1,
        title: "Distributed-systems essay — draft 2",
        project: "thesis",
        provenance: "note",
        captured: "Mon 21:10",
        deadline: { label: "Fri", kind: "self", slips: 2 },
        packet: { files: 2, mockups: 0 },
        verdict: "session",
        subtasks: [
          { title: "rework the outline per feedback", done: true },
          { title: "rewrite section 3 (consensus comparison)" },
          { title: "citations pass" },
        ],
      },
      {
        id: "ws-lab",
        rank: 2,
        title: "Email prof about lab access",
        project: "thesis",
        provenance: "pasted email",
        captured: "Tue 09:55",
        deadline: { label: "Sep 2", kind: "external" },
      },
      {
        id: "ws-chapter",
        rank: 3,
        title: "Read chapter 7 — consensus protocols",
        project: "thesis",
        provenance: "session",
        captured: "Mon 20:40",
      },
    ],
  },
  {
    key: "free",
    label: "Free",
    window: "whenever",
    items: [
      {
        id: "ws-notes-pin",
        rank: 1,
        title: "Idea: Telar Notes pin per-screen",
        project: "telar",
        provenance: "chat",
        captured: "today 09:16",
      },
      {
        id: "ws-backups",
        rank: 2,
        title: "Rotate the home-lab backup disks",
        provenance: "note",
        captured: "Sun 12:03",
      },
    ],
  },
];

export const WS_ITEM_COUNT = WS_LANES.reduce((n, l) => n + l.items.length, 0);

// ── the desk: agent-placed items living on the right rail ──────────────────
// When the master files something it lands here — persistent, editable through
// conversation without moving. Dismissing one sends it to the queue (never
// deletes). `unplaced` = the master couldn't file it and is asking.

export interface DeskItem {
  id: string;
  title: string;
  tag?: string; // project, mono
  hint?: string; // tiny second line ("Thu", "updated just now")
  unplaced?: boolean;
}

export const WS_DESK: DeskItem[] = [
  {
    id: "desk-export",
    title: "Remove CSV export button",
    tag: "aurora",
    hint: "Fri · external",
  },
  {
    id: "desk-maria",
    title: "Call María — invoice",
    hint: "moved to Fri · updated just now",
  },
  {
    id: "desk-pdf",
    title: "“the pdf thing”",
    hint: "unplaced — what is it?",
    unplaced: true,
  },
  {
    id: "desk-notes-pin",
    title: "Notes pin per-screen",
    tag: "telar",
    hint: "idea · Free",
  },
];

// ── the packet detail (Rework onboarding flow) ─────────────────────────────

export type PacketActor = "you" | "expert" | "bed";

export interface PacketEvent {
  at: string;
  actor: PacketActor;
  text: string;
  proposal?: boolean; // bed-mode output awaiting a human look
}

export const PACKET = {
  title: "Rework onboarding flow",
  project: "aurora",
  mirrored: "#218",
  lane: "Aurora",
  verdict: "loom" as const,
  raw: "onboarding feels clunky?? ask diego — maybe merge steps 2/3",
  rawSource: "Telar Note · Tue 16:42",
  fixed:
    "Rework aurora's onboarding: merge steps 2 and 3 into a single profile screen, keep the invite flow untouched. Diego flagged drop-off between the two steps in Wednesday's sync; the mirrored issue (#218) tracks it on their side.",
  acceptance: [
    "steps 2/3 collapse into one screen without losing the invite path",
    "drop-off instrumentation still fires on the merged step",
    "their issue #218 gets a link back to the evidence",
  ],
  timeline: [
    { at: "Tue 16:42", actor: "you", text: "captured as a floating note" },
    {
      at: "Tue 03:02",
      actor: "bed",
      text: "fixed the fragment, filed it under aurora (matched “steps 2/3” to the onboarding flow)",
    },
    {
      at: "Wed 14:19",
      actor: "expert",
      text: "you pasted the sync transcript — expert cut the excerpt where Diego describes the drop-off",
    },
    {
      at: "Thu 03:11",
      actor: "bed",
      text: "drafted onboarding-v2.html mockup",
      proposal: true,
    },
    {
      at: "Thu 03:14",
      actor: "expert",
      text: "complexity read: 3 screens + auth touchpoints — recommend a loom",
      proposal: true,
    },
  ] satisfies PacketEvent[],
};
