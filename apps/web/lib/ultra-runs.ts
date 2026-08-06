// Story 4.2 — THE PROJECTION LAYER FOR ULTRA'S REAL SESSION UI, and its whole
// job is refusing to invent data.
//
// WHY THIS IS A MODULE AND NOT JSX. There is no DOM test harness in this repo
// and story 3.1's hard rule 9 forbids introducing one, so a decision that lives
// inside a component is a decision that ships unproven. Story 4.1's review round
// moved three functions out of `session-view.tsx` for exactly this reason and
// gained sixteen tests by doing it. So everything here is a CHOICE — which form
// the anchor takes, which agent rows exist, which phase an agent belongs to,
// which log lines are narration, whether a denominator exists at all, what the
// dock summary says, whether the composer chip is armed for this send — and
// every one of them has a test in `ultra-runs.test.ts`. What is left in
// `ultra-anchor.tsx` / `ultra-rail.tsx` / `ultra-dock-signal.tsx` is layout.
//
// PURE AND CLIENT-REACHABLE. No React, no fetch, no `@telar/core` RUNTIME. The
// only `@telar/core` edge is the `import type` below, which TypeScript erases at
// build time — this module is reached from `use-ultra-runs.ts`, a "use client"
// root, and a value edge there is an INV-4c violation reported by name
// (AD-3 / NFR-X-3, the CLIENT-BUNDLE RULE). Its two runtime imports are
// `@/lib/spend-readout` (itself importless but for `@/lib/format`) and
// `@/components/conversation/items`, a pure data module with no core edge of its
// own — reusing its `CONVERSATION_KINDS` is what keeps the splice from minting a
// second copy of the shell's vocabulary. Shape lineage:
// `escalation-kickoff.ts` → `ultra-wake.ts` → `spend-readout.ts` → this.
//
// NO PLACEBO (hard rule 3, `ui-contract.md`'s own house rule). The frozen
// contract names five things the engine does not produce. Two are sourced by
// story 4.2's declared additive engine change (`effort`, and live agent rows via
// the `agent-start` event); three are NOT SOURCED AND NOT INVENTED and this file
// is where that refusal is executable rather than aspirational:
//   - agents `total` — `RunSnapshot.agentsTotal` is TYPED `undefined`. A script
//     may spawn any number of agents, in a loop, conditionally; nothing in the
//     engine knows the total and nothing can. The type itself refuses it.
//   - the progress sliver — a fraction of DECLARED PHASES, never of agents and
//     never of money. `progressFraction` returns `undefined` when `meta.phases`
//     is absent or malformed, and an undefined fraction renders NO sliver — not
//     an indeterminate bar, not a pulse, not a spinner pretending to be progress.
//   - per-agent `tokens` — THE ENGINE NOW PRODUCES THESE, so the refusal that
//     stood here is retired rather than relaxed. The note read "there are no
//     token counts anywhere on the ultra path (ultra's ledger write passes
//     `costUsd` and no token counts at all), so `AgentRow` HAS NO `tokens`
//     FIELD" — accurate then: `engine.ts` discarded the SDK result's `usage`
//     and kept only the dollar figure. It is captured now, journaled beside the
//     cost (so a resume re-presents it) and carried on the settle event, which
//     is what this reader reads. The refusal it encoded still binds everything
//     it was written about: an ABSENT count renders as absent, never as a
//     confident 0, and the demo gallery's `agentTokensAt` — which interpolates
//     one over wall time — is still theatre and is still not a source.
//
// REVIEW ROUND 1 EXTENDED THAT REFUSAL FROM "WHAT THE ENGINE CANNOT PRODUCE" TO
// "WHAT THIS READER HAS NOT READ" (B1), which is the same rule and was the
// bigger hole. A run that was already terminal when the page mounted has a
// manifest and NOTHING ELSE, and the manifest carries no agent count, no phase
// history and no log lines — so the anchor stated `0 done` about a run that
// settled five agents. `agentsDone` and `progress` are now ABSENT rather than
// zero until this run's journal has actually been read, and `runSnapshot` takes
// `null` (not `[]`) to say so.
//
// NOT A BUDGET (NFR-UW-7 / AC9). Every money figure here goes through
// `spendReadout`, whose own header says a readout has no ceiling, no percentage
// and no reserved headroom. Nothing in ultra gates on money — `storage.ts` says
// it in its own words: "Ultra's spend is a READOUT, not a cap". The one bar this
// story renders is the phase sliver above, and it is a fraction of phases.

// TYPE-ONLY, ERASED AT BUILD TIME — the same comment `use-accounts.ts` and
// `use-ultra-wake.ts` both carry. These are the wire shapes verbatim rather than
// a hand-written mirror, so a field added to either in `packages/core` cannot
// drift away from what this file projects.
import type { UltraEvent, UltraManifest } from "@telar/core";
import { CONVERSATION_KINDS, type TranscriptItem, type ToolsPayload } from "@/components/conversation/items";
import type { ToolPart } from "@/components/session/tool-step";
import { spendReadout, type SpendProvider, type SpendReadout } from "@/lib/spend-readout";
// The registry the composer's own model picker renders — imported so an Ultra
// agent's model is named the way the rest of the product names it, rather than
// by whatever alias the script happened to type.
import { MODELS } from "@/lib/models";

export type UltraEventLike = UltraEvent;
export type UltraManifestLike = UltraManifest;

// NEVER "completed". The demo gallery's `RunState` declares
// `running | stopped | completed | failed`; the engine's is this, and `SPEC.md`
// says outright that "the plan's draft name `completed` is superseded". A
// `STATE_STYLE` key copied across from the gallery misses silently at runtime
// rather than failing to compile — which is why this alias exists at all.
export type UltraRunState = "running" | "done" | "failed" | "stopped";

/** One row of `GET /api/ultra/[id]/agents` — the ONLY source of a live agent's
 *  snippet. `lastText` is the highest-`attempt` text record: a retried
 *  ordinal's attempt-1 text is discarded work and showing it shows the wrong
 *  thing. */
export type AgentIndexRow = { ordinal: number; settled: boolean; attempt: number; lastText: string };

export type AgentRow = {
  ordinal: number;
  label?: string;
  model: string;
  effort?: string;
  /** absent while live; set from the `agent` event's own `ok` once it settles */
  ok?: boolean;
  /** What the provider billed. Kept on the row because the run header and the
   *  session breakdown still speak dollars; the per-agent UI shows `tokens`. */
  costUsd?: number;
  /** The provider's own usage split for this agent, or ABSENT when it reported
   *  none. Absent is not zero: a row with no counts says so rather than
   *  claiming the agent consumed nothing. */
  tokens?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  /** highest-`attempt` text from the agent index; "" while nothing has streamed */
  snippet: string;
  /** an `agent` settle event (or the index's own `settled`) was seen for this
   *  ordinal. IT IS NOT THE COMPLEMENT OF `live` — see below. */
  settled: boolean;
  /** REVIEW ROUND 1, SF-3 — is this ordinal working RIGHT NOW? `!settled` is not
   *  the same question and treating it as one is a placebo: `stopUltraRun`
   *  ABORTS its in-flight agents, so neither ever emits its settling `agent`
   *  event and both stay `settled: false` forever. Rendering that as "live" put
   *  an infinitely-animating shimmer inside a card whose header read `stopped`.
   *  The same arrives with no user action at all through `getUltraManifest`'s
   *  on-read `running` → `stopped` rewrite (AD-15 / §5.6-T14) after a server
   *  restart. An unsettled ordinal on a run that has ENDED was terminated, not
   *  started; it is neither settled nor live. */
  live: boolean;
};

/** WHERE A PHASE IS, AS ONE CLOSED VOCABULARY (issue #27). A group used to be
 *  purely a fact — it existed because it had happened — and could therefore be
 *  drawn with no state at all. Pre-displaying a DECLARED phase breaks that: a
 *  group can now exist before anything has happened in it, and the difference
 *  between "not yet" and "never" is not cosmetic. A run that returns early
 *  (`fix` runs only if the author survived) leaves a declared phase that will
 *  never begin, and rendering that as pending on a run that has already ended is
 *  a worse lie than not showing the phase at all.
 *
 *  `done` here means BEGAN AND IS NO LONGER IN PROGRESS — not "succeeded". Phase
 *  events carry no outcome; whether the work inside went well is what the agent
 *  rows say. */
export type PhaseStatus = "done" | "running" | "pending" | "never-reached";

export type PhaseGroup = { title: string; agents: AgentRow[]; status: PhaseStatus };

/** The word a header adds beside its title, or "" for the two states that need
 *  none. A `done` or `running` group has AGENT ROWS UNDER IT saying so in more
 *  detail, and a second word above them is noise; the two empty states are
 *  exactly the ones with nothing beneath them to explain themselves. Kept as a
 *  closed table beside the vocabulary — the same shape `AGENT_STATUS_LABEL`
 *  uses — so a new status cannot reach the renderer without a DECISION about
 *  what it says. (`Record` forces a key, not a word: `""` is legal and is used
 *  twice above. What it rules out is the state nobody thought about.) */
export const PHASE_STATUS_NOTE: Record<PhaseStatus, string> = {
  done: "",
  running: "",
  pending: "pending",
  "never-reached": "not reached",
};

export type RunSnapshot = {
  runId: string;
  /** pre-rendered server-side by the list route, or by `runLabel` below for the
   *  stream-only window — NEVER by core's `ultraRunLabel`, a VALUE export whose
   *  import from here would be an INV-4c violation. See `runLabel`'s comment. */
  name: string;
  state: UltraRunState;
  /** `manifest.spend` VERBATIM. Never a sum of `agent.costUsd` deltas: the
   *  manifest figure is a fold over `usage.ndjson` recomputed on every save, it
   *  is not monotonic, and a resume re-presents every replayed settle with its
   *  ORIGINAL cost — so an accumulator double-counts on the first resume
   *  (AD-18/AD-20). */
  spendUsd: number;
  error?: string;
  startedAt: number;
  updatedAt: number;
  /** Deduped count of ordinals that have SETTLED — and ABSENT, never `0`, when
   *  this run's event journal has not been read (REVIEW ROUND 1, B1).
   *
   *  `0 done` for a run that settled five agents yesterday is a WRONG NUMBER
   *  STATED AS FACT, which is the same prohibition AC11 proof 3 makes about the
   *  denominator pointed at the numerator. The manifest carries no agent count,
   *  so a run projected from its manifest ALONE knows nothing about its agents —
   *  and this file's own doctrine for that is already written down twice
   *  (`agentsTotal` is typed `undefined`; `progress` is absent rather than
   *  zero): NOT SOURCED ⇒ NOT RENDERED. `use-ultra-runs.ts` now reads a terminal
   *  run's journal too, so the absence is a brief window rather than a permanent
   *  state — but it is the window, and a failed read, that this refuses to lie
   *  about. */
  agentsDone?: number;
  /** AC11 proof 3 — the TYPE ITSELF refuses the denominator. Nothing knows how
   *  many agents a script will spawn. `ultra_status`'s `total` is a count of
   *  settled agents, so `done/total` through that lens is always 1.0 — a
   *  denominator always equal to its numerator is worse than none. */
  agentsTotal: undefined;
  phases: PhaseGroup[];
  narrator: string[];
  /** undefined ⇒ NO SLIVER (AC11 proof 4) */
  progress?: { seen: number; declared: number };
  /** true until the first manifest (a `run` SSE frame or a list row) lands. The
   *  launch is a FACT the moment the tool result carries a `runId`, so the
   *  anchor renders in a pending form rather than being dropped. */
  pending: boolean;
};

export type UltraAnchorPayload = {
  run: RunSnapshot;
  /** for `spendReadout()`. The adapter supplies it because the renderer may read
   *  nothing else — a renderer that decides a unit is a renderer with a domain
   *  rule in it. */
  provider: SpendProvider;
  /** `ui-contract.md` §2: "Clicking it focuses that run in the rail." */
  onFocus: () => void;
  onStop: () => void;
  onResume: () => void;
  /** disables both affordances between the click and the next manifest snapshot
   *  (AC5 proof 3 — Resume is NOT idempotent) */
  busy: boolean;
};

export type ArmState = { armed: boolean };

export type DockRunSummary = {
  text: string;
  /** present only for the single-run case; N>1 has no one state to name */
  state?: UltraRunState;
  spend: SpendReadout;
  focusRunId?: string;
} | null;

// ── the tool wire name ──────────────────────────────────────────────────────

/** The launch call's wire name. Read off `ULTRA_AUTO_TOOLS`' first entry rather
 *  than re-derived from `createSdkMcpServer({name:"ultra"})` + `tool("ultra",…)`
 *  — but spelled as a literal here rather than imported, because
 *  `lib/ultra-mcp.ts` pulls in the Agent SDK and this module must stay reachable
 *  from a client root. The two are pinned together by a test. */
export const ULTRA_TOOL_NAME = "mcp__ultra__ultra";

/** The registered item kind. Declared HERE, in the pure module, so the splice
 *  that mints items of this kind and the `ItemKind` that renders them cannot
 *  drift apart — `ultra-anchor.tsx` writes `id: ULTRA_ANCHOR_KIND`. INV-10a
 *  pins the literal, the module segment, and its membership of
 *  `MODULE_NAMESPACES`. */
export const ULTRA_ANCHOR_KIND = "ultra:run-anchor";

/** THE TAB SELECTOR PREFIX — a different vocabulary from an item-kind id, and
 *  deliberately not spelled like one. `ultra:` is already taken TWICE: it is the
 *  kind id's module segment (`ULTRA_ANCHOR_KIND`, pinned to exactly one id by
 *  INV-10a/c) and it is the item KEY `spliceRunAnchors` mints (`ultra:${runId}`).
 *  A third meaning on the same string is how two lookups start answering each
 *  other's questions. `activeTab` holds this, `"main"`, or a spawn tool_use id —
 *  three vocabularies in one field, kept apart by this prefix and nothing else. */
export const ULTRA_TAB_PREFIX = "ultra-run:";
export const ultraTabId = (runId: string) => `${ULTRA_TAB_PREFIX}${runId}`;
export const ultraTabRunId = (tab: string): string | null =>
  tab.startsWith(ULTRA_TAB_PREFIX) ? tab.slice(ULTRA_TAB_PREFIX.length) : null;

// ── T16: ONE envelope adapter, used everywhere ──────────────────────────────

// THREE ENVELOPES FOR ONE OBJECT and that is measured, not asserted: the SSE
// `run`/`end` frames send the BARE `UltraManifest`; `GET /api/ultra/[id]` sends
// `{ run }`; `GET /api/ultra` sends `{ runs }`. Unwrapping inline at each call
// site means unwrapping the wrong level exactly once, in the case tested least.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A single manifest out of a bare frame OR a `{ run }` envelope. Null when the
 *  value is neither — a UI that throws on a shape it did not expect is a UI that
 *  500s the page for one bad row (AD-8: a vanished cross-tree reference renders
 *  as a tombstone, never a throw). */
export function unwrapManifest(value: unknown): UltraManifestLike | null {
  if (!isRecord(value)) return null;
  const inner = isRecord(value.run) ? value.run : value;
  return typeof inner.runId === "string" ? (inner as unknown as UltraManifestLike) : null;
}

/** Many manifests out of a `{ runs }` envelope OR a bare array. Always an array;
 *  never null, because "no runs" and "malformed" render identically here — an
 *  empty Workflows section. */
export function unwrapManifests(value: unknown): UltraManifestLike[] {
  const raw = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.runs) ? value.runs : [];
  return raw.map((r) => unwrapManifest(r)).filter((m): m is UltraManifestLike => m !== null);
}

// ── D5a: the run label, duplicated from core DELIBERATELY, and it is four lines ─

// `ultraRunLabel` lives in `packages/core/src/ultra/events.ts` and is a RUNTIME
// VALUE. This module is reached from a "use client" root, so importing it is an
// INV-4c violation reported by name. And the anchor cannot simply take the
// server-rendered `name` off the list route either: its per-tick channel is the
// SSE tail, whose `run`/`end` frames carry the BARE `UltraManifest` — which has
// `meta` and no `name` field at all. So the rule lives here too: read
// `meta.name` when it is a NON-EMPTY STRING, else fall back to the runId.
//
// THIS IS THE SECOND COPY OF ONE RULE AND IT IS THE CORRECT TRADE. The
// alternatives are a value edge INV-4 forbids, or an anchor with no label until
// the first list poll answers. `ultra-runs.test.ts` asserts both copies agree on
// a `meta` with a name, a `meta` without one, and a `meta` whose `name` is not a
// string.
export function runLabel(meta: unknown, runId: string): string {
  if (isRecord(meta) && typeof meta.name === "string" && meta.name.trim() !== "") return meta.name;
  return runId;
}

// ── T6: the narrator's filter ───────────────────────────────────────────────

// A `log` event is NOT always a script's `log()` call. `storage.ts` narrates its
// own accounting and publish failures through the SAME variant. These four
// prefixes were re-derived from `packages/core/src/ultra/storage.ts` at
// `e093a98` (grep the literals; the count moved once already when story 4.1
// added the fourth). They are diagnostics for a developer reading
// `events.ndjson` with `tail` at 1am — the logging doctrine
// `ARCHITECTURE-SPINE.md` states — not narration for a user watching a run.
export const ACCOUNTING_LOG_PREFIXES = [
  "spend-read-unavailable:",
  "spend-record-skipped ordinal=",
  "spend-record-failed ordinal=",
  "run-completed-publish-failed:",
] as const;

const isAccountingLog = (msg: string): boolean =>
  ACCOUNTING_LOG_PREFIXES.some((p) => msg.startsWith(p));

export function narratorLines(events: readonly UltraEventLike[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "log" && !isAccountingLog(e.msg)) out.push(e.msg);
  }
  return out;
}

// ── agent rows ──────────────────────────────────────────────────────────────

// DEDUPED BY ORDINAL, LAST-WINS, and that is what makes a resume survivable: a
// resumed run's `events.ndjson` gains a SECOND `agent` event for every replayed
// ordinal carrying `cached: true`, so a list-shaped projection doubles its rows
// on the first resume. Keying on the ordinal cannot.
//
// `agent-start` is emitted immediately before an ordinal's first LIVE attempt
// and never on the cached-replay path, so a replayed ordinal has only its
// `agent` event — one row either way.
export function agentRows(
  events: readonly UltraEventLike[],
  agentIndex: readonly AgentIndexRow[],
  /** The OWNING RUN's state, because whether an unsettled ordinal is still
   *  working is a fact about the run and not about the ordinal (SF-3). Defaults
   *  to `running`, which is the only state under which "unsettled" and "live"
   *  coincide — so every caller that has no run in hand keeps the old reading. */
  runState: UltraRunState = "running",
): AgentRow[] {
  const byOrdinal = new Map<number, Omit<AgentRow, "live">>();
  for (const e of events) {
    if (e.type === "agent-start") {
      const prev = byOrdinal.get(e.ordinal);
      byOrdinal.set(e.ordinal, {
        ordinal: e.ordinal,
        ...(e.label !== undefined ? { label: e.label } : {}),
        model: e.model,
        ...(e.effort !== undefined ? { effort: e.effort } : {}),
        snippet: prev?.snippet ?? "",
        // A re-emitted start for an ordinal that already settled must not
        // un-settle it. In practice the executor never emits one, but a stream
        // is append-only and a projection over it should not depend on that.
        settled: prev?.settled ?? false,
        ...(prev?.ok !== undefined ? { ok: prev.ok } : {}),
        ...(prev?.costUsd !== undefined ? { costUsd: prev.costUsd } : {}),
        ...(prev?.tokens !== undefined ? { tokens: prev.tokens } : {}),
      });
    } else if (e.type === "agent") {
      const prev = byOrdinal.get(e.ordinal);
      byOrdinal.set(e.ordinal, {
        ordinal: e.ordinal,
        // The settle event is authoritative for label/model; `agent-start`'s
        // copies are the same values read off the same `UltraAgentOpts`.
        ...(e.label !== undefined ? { label: e.label } : prev?.label !== undefined ? { label: prev.label } : {}),
        model: e.model,
        ...(e.effort !== undefined ? { effort: e.effort } : prev?.effort !== undefined ? { effort: prev.effort } : {}),
        ok: e.ok,
        ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
        ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
        snippet: prev?.snippet ?? "",
        settled: true,
      });
    }
  }
  // The index carries the live snippet, and it can also see an ordinal whose
  // `agent-start` has not reached this reader yet (two channels, one truth).
  for (const row of agentIndex) {
    const prev = byOrdinal.get(row.ordinal);
    if (prev) {
      byOrdinal.set(row.ordinal, {
        ...prev,
        snippet: row.lastText,
        settled: prev.settled || row.settled,
      });
    } else {
      byOrdinal.set(row.ordinal, {
        ordinal: row.ordinal,
        // No `agent-start` seen for it yet, so the model is genuinely unknown.
        // "" renders as no chip at all — never a guessed model name.
        model: "",
        snippet: row.lastText,
        settled: row.settled,
      });
    }
  }
  // Liveness is decided HERE, in one place, over the run's own state — never in
  // the component, where it would be untestable (§5.4's whole reason this module
  // exists).
  const runIsLive = runState === "running";
  return [...byOrdinal.values()]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => ({ ...r, live: runIsLive && !r.settled }));
}

// ── phase grouping (T5) ─────────────────────────────────────────────────────

/** Agents seen before any `phase` event. Rendered without a heading. */
export const UNPHASED = "";

// AN AGENT'S OWN `phase` WINS; THE AMBIENT ONE IS THE FALLBACK (issue #40).
// `agent()` takes `opts.phase` and the authoring reference documents it as the
// remedy for pipeline()/parallel() stages racing on the global `phase()` state.
// The engine dropped it before the event stream, so this read the ambient value
// for every agent — the exact race, and a three-phase run drew all seven of its
// agents under phase one. The engine emits it now; this prefers it.
//
// THE FALLBACK IS NOT A FALLBACK FOR MEMBERSHIP ONLY. `opts.phase` is scoped to
// the ONE call that names it and deliberately does NOT become the new ambient:
// a bare `agent()` after a `{ phase: "review" }` stage still belongs to whatever
// `phase()` last said, or the leak would reintroduce the race one call later.
//
// GROUPED BY STREAM ORDER OTHERWISE, because there is no phase id and no other
// agent→phase link in the data (the demo gallery's `PhaseDef.id` /
// `AgentDef.phaseId` are fabricated). An agent that named no phase belongs to
// the MOST RECENT PRECEDING `phase` event — `ultra_status`'s own idiom.
//
// IDEMPOTENT UNDER A RESUME, which re-emits the whole phase sequence from the
// cheap re-run: membership is last-assignment-wins over a Map keyed by ordinal,
// and group identity is the phase TITLE, so replaying the same stream twice
// produces the same groups rather than doubling them.
//
// SEEDED FROM THE DECLARED PHASES, NEVER RESTRICTED BY THEM (issue #27). A
// script names its phases at launch and the run view rendered only the ones that
// had already happened, so a four-phase run showed one box and a long first
// phase read as though it might be the whole run. `meta.phases` orders
// `titleOrder` before the walk begins; a `phase()` call with a title that is NOT
// declared still appears, appended where it is first observed, exactly as
// before. The declared list is a seed, not a whitelist — a script is free to
// disagree with its own metadata and the surface reports what actually ran.
//
// HEADERS ONLY. NEVER SKELETON AGENT ROWS. A phase's NAME is knowable in
// advance and its CONTENTS are not: a script decides at runtime how many agents
// to spawn (one per lens, or one only if a previous agent survived), so nothing
// here can know a pending phase's row count. A pending phase is a titled EMPTY
// group; inventing rows for it would be exactly the fabrication this module's
// header refuses.
export function phaseGroups(
  events: readonly UltraEventLike[],
  rows: readonly AgentRow[],
  /** The manifest, for its DECLARED phases and for the run's own state — which
   *  is what separates `pending` from `never-reached`. Omitted (or null) ⇒ the
   *  observed-only grouping this function has always produced. */
  manifest: UltraManifestLike | null = null,
  /** Whether the declared phases may SEED groups. Split from the manifest
   *  because the two facts are independent: whether this reader has read the
   *  journal (B1) decides the seed, while the run's STATE is knowable from the
   *  manifest either way. Folding them — passing `null` to suppress the seed —
   *  also threw the state away, and reported a finished run's groups as
   *  `running`. */
  seedDeclared = true,
): PhaseGroup[] {
  const declared = declaredPhases(manifest) ?? [];
  const titleOrder: string[] = [];
  const phaseOf = new Map<number, string>();
  /** Titles a `phase` event or an agent was actually observed under. A declared
   *  title absent from this has not begun — the whole pending/never distinction
   *  rests on it, so it is tracked separately from `titleOrder`, which now
   *  contains titles that may never have happened. */
  const begun = new Set<string>();
  let current = UNPHASED;
  /** Where the run most recently ENTERED — a `phase()` call, or an agent
   *  STARTING under one it named itself. SEPARATE FROM `current` on purpose:
   *  `current` answers "which phase does a call that named none belong to" and
   *  must stay the ambient, while a script that phases ONLY through `opts.phase`
   *  never moves the ambient at all. A SETTLE never moves this — it says work
   *  ended, not where the run is, and letting it count made the marker jump
   *  backwards into a phase that had already finished. */
  let latest = UNPHASED;
  const note = (title: string) => {
    if (!titleOrder.includes(title)) titleOrder.push(title);
  };
  /** THE PHASE AN ORDINAL NAMED FOR ITSELF, resolved across the WHOLE stream
   *  before the walk begins, because an ordinal's `agent-start` and its settle
   *  are two events about ONE agent and only some of them carry `phase`: a
   *  pre-#40 `events.ndjson` has it on no settle at all, and a reader that took
   *  the events one at a time let the phase-less one win by arriving last. */
  const ownOf = new Map<number, string>();
  for (const e of events) {
    if (e.type !== "agent-start" && e.type !== "agent") continue;
    const own = ownPhaseTitle(e.phase, declared);
    if (own !== undefined) ownOf.set(e.ordinal, own);
  }
  // THE UNPHASED GROUP KEEPS ITS PLACE AT THE TOP when it exists because agents
  // ran BEFORE the first `phase()` call. It is chronologically first by
  // construction, and seeding the declared titles ahead of it would file the
  // run's opening agents underneath every header on screen — a reordering of
  // rows that were already rendering correctly.
  //
  // An agent that named its OWN phase is not unphased even when it ran first, so
  // the scan looks past it rather than stopping — otherwise a script that phases
  // purely through `opts.phase` grows a phantom headerless group at the top. It
  // is `ownOf` and not this event that decides that, or the settle of a
  // perfectly well phased agent opens the box its own start closed.
  for (const e of events) {
    if (e.type === "phase") break;
    if ((e.type === "agent-start" || e.type === "agent") && !ownOf.has(e.ordinal)) {
      note(UNPHASED);
      break;
    }
  }
  if (seedDeclared) for (const title of declared) note(title);
  for (const e of events) {
    if (e.type === "phase") {
      // The DECLARED spelling wins over the one the call typed — see
      // `canonicalPhaseTitle`; byte-exact identity drew the same phase twice.
      current = canonicalPhaseTitle(e.title, declared);
      latest = current;
      note(current);
      begun.add(current);
    } else if (e.type === "agent-start" || e.type === "agent") {
      // A phase named ONLY here still gets its group and its place in the order:
      // `note` appends an undeclared title where it is first observed, and a
      // declared one is already seeded in its published position. The ordinal's
      // OWN phase (from either of its events — see `ownOf`) beats the ambient;
      // only an agent that named none anywhere falls back to it.
      const title = ownOf.get(e.ordinal) ?? current;
      phaseOf.set(e.ordinal, title);
      if (e.type === "agent-start") latest = title;
      note(title);
      begun.add(title);
    }
  }
  const byTitle = new Map<string, AgentRow[]>();
  for (const title of titleOrder) byTitle.set(title, []);
  for (const row of rows) {
    const title = phaseOf.get(row.ordinal) ?? UNPHASED;
    if (!byTitle.has(title)) {
      byTitle.set(title, []);
      note(title);
    }
    // A row that reached this group did so under a title the run was really in
    // — the agent index can answer for an ordinal whose `agent-start` this
    // reader has not seen yet (`agentRows`' two-channels-one-truth merge).
    begun.add(title);
    byTitle.get(title)!.push(row);
  }
  // THE RUN'S STATE, NOT THE PHASE'S — there is no per-phase terminal event and
  // there cannot be one, so "this declared phase will never happen" is a
  // deduction from the RUN having ended, and `stopped` and `failed` end it just
  // as `done` does. AD-15's on-read `running` → `stopped` rewrite is why this is
  // read off the manifest rather than off a `state` event: a run killed by a
  // server restart emits none, and a phase left spinning on it is the exact lie
  // this state exists to prevent.
  const runIsLive = (manifest?.state ?? "running") === "running";
  /** Titles holding at least one agent that has not settled. THE FACT `latest`
   *  WAS STANDING IN FOR: "the last phase observed" assumed phases are
   *  sequential in the stream, and `opts.phase` exists precisely because
   *  pipeline()/parallel() stages are NOT — with no inter-stage barrier, the
   *  last agent event is whichever one happened to land, so two identical runs
   *  drew different markers and a phase holding live agents rendered `done`. A
   *  group with work still in flight is running, and several may be at once
   *  (`PHASE_STATUS_NOTE.running` is empty, so the header reads the same). */
  const hasLive = new Set<string>();
  for (const [title, group] of byTitle) if (group.some((r) => r.live)) hasLive.add(title);
  const statusOf = (title: string): PhaseStatus => {
    if (!begun.has(title)) return runIsLive ? "pending" : "never-reached";
    if (!runIsLive) return "done";
    // `latest` still answers for a group with no rows YET — a `phase()` call the
    // run has reached but not yet spawned into.
    return hasLive.has(title) || title === latest ? "running" : "done";
  };
  // A phase that declared itself but has no agents yet is still a real group —
  // it is the run telling the user where it is.
  return titleOrder.map((title) => ({
    title,
    agents: byTitle.get(title) ?? [],
    status: statusOf(title),
  }));
}

// ── the progress sliver (AC11 proof 4) ──────────────────────────────────────

// SOURCED FROM PHASES, NEVER FROM AGENTS OR MONEY. `ULTRA_TOOL_DESCRIPTION`
// teaches `export const meta = { name, description, phases }`, and
// `{ type: "phase", title }` events say which one the run is in. So the
// denominator is `meta.phases.length` and the numerator is the count of DISTINCT
// phase titles seen.
//
// `ScriptMeta` is `Record<string, unknown>` and NOTHING VALIDATES `phases` —
// `compileScript` checks only that `meta` is a pure object literal. So this
// reads it ONLY when it is an array whose entries are all strings, exactly as
// story 4.1's `ultraRunLabel` reads `meta.name` only when it is a non-empty
// string. Anything else ⇒ `undefined` ⇒ NO SLIVER.
//
// ONE READ, TWO READERS (issue #27). The sliver's denominator and the phase
// group list are now both fractions of the same declared array, so they are both
// this function. A second copy of the four checks below is a way for the sliver
// to say "1 of 4" while the group list shows one box — the two disagreeing on
// screen about a `phases` nothing type-checks.
export function declaredPhases(manifest: UltraManifestLike | null): string[] | undefined {
  const meta: unknown = manifest === null ? undefined : manifest.meta;
  const phases = isRecord(meta) ? meta.phases : undefined;
  if (!Array.isArray(phases) || phases.length === 0) return undefined;
  if (!phases.every((p) => typeof p === "string")) return undefined;
  // A TITLE THAT RENDERS AS NOTHING IS NOT A PHASE — the same reading story 4.1
  // gives `meta.name`, one paragraph up. The empty string is the UNPHASED
  // group's own identity, so seeding it plants that group mid-list (where the
  // run's pre-phase agents then land instead of at the top) behind a header the
  // renderer draws blank. Dropped HERE and not at one reader, so the sliver's
  // denominator and the group list keep counting the same array.
  const named = (phases as string[]).filter((p) => p.trim() !== "");
  return named.length === 0 ? undefined : named;
}

/** THE DECLARED SPELLING IS THE IDENTITY. Nothing type-checks `meta.phases`, so
 *  a script may declare `"Survey"` and then call `phase("survey")` — and both
 *  readers of that array have to fold the two together or they disagree on
 *  screen: the group list drawing SURVEY *pending* above SURVEY (the header
 *  uppercases) while the sliver counts the drifted call as a second phase
 *  reached. An undeclared title has nothing to answer to and keeps its own
 *  spelling, because the declared list is a seed and never a whitelist. */
function canonicalPhaseTitle(title: string, declared: readonly string[]): string {
  const key = title.trim().toLowerCase();
  return declared.find((d) => d.trim().toLowerCase() === key) ?? title;
}

/** The phase an agent event named for ITSELF (`agent()`'s `opts.phase`), or
 *  `undefined` when it named none. Canonicalised against the declared spelling
 *  exactly as a `phase()` title is: a script may declare `"Review"` and pass
 *  `{ phase: "review" }`, and folding one but not the other draws the same phase
 *  twice. The `typeof` check is not defensive dressing — these events are
 *  JSON.parsed off `events.ndjson` with no validation between disk and here. A
 *  blank string is "named none", the same reading `declaredPhases` gives a blank
 *  declaration. */
function ownPhaseTitle(phase: unknown, declared: readonly string[]): string | undefined {
  if (typeof phase !== "string" || phase.trim() === "") return undefined;
  return canonicalPhaseTitle(phase, declared);
}

export function progressFraction(
  manifest: UltraManifestLike | null,
  events: readonly UltraEventLike[],
): { seen: number; declared: number } | undefined {
  const phases = declaredPhases(manifest);
  if (phases === undefined) return undefined;
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type === "phase") seen.add(canonicalPhaseTitle(e.title, phases));
    // AN AGENT'S OWN `opts.phase` COUNTS TOO (issue #40) — for the same reason
    // the group list reads it, and it has to be the same reason or the two
    // readers of one declared array disagree on screen: a pipeline that phases
    // only through `opts.phase` would draw three begun boxes beside "0 of 3".
    //
    // SO THE FRACTION IS PHASES ENTERED, NOT WORK COMPLETED — the reading
    // `phase()` has always given it, now reachable sooner because a pipeline
    // enters its last stage while earlier items are still in their first. A
    // full sliver therefore means "every phase has begun", and the RUNNING
    // group markers are what still say work is in flight.
    else if (e.type === "agent-start" || e.type === "agent") {
      const own = ownPhaseTitle(e.phase, phases);
      if (own !== undefined) seen.add(own);
    }
  }
  return { seen: Math.min(seen.size, phases.length), declared: phases.length };
}

// ── the run snapshot ────────────────────────────────────────────────────────

export function runSnapshot(
  manifest: UltraManifestLike | null,
  /** THE JOURNAL, OR `null` FOR "NOT READ" — and the difference is the whole of
   *  B1. `[]` means this reader has the run's events and there are none; `null`
   *  means it has never opened the channel that would tell it, which is exactly
   *  the state a page is in for a run that was already terminal when it mounted.
   *  Every figure that can only come from the journal is ABSENT in that case
   *  rather than zero. */
  events: readonly UltraEventLike[] | null,
  agentIndex: readonly AgentIndexRow[] = [],
  runId?: string,
): RunSnapshot {
  const id = manifest?.runId ?? runId ?? "";
  const state = manifest?.state ?? "running";
  const journal = events ?? [];
  // The agent INDEX is a second, independent source for the same question, so a
  // run whose index has answered is sourced even with no journal read.
  const sourced = events !== null || agentIndex.length > 0;
  const rows = agentRows(journal, agentIndex, state);
  const progress = events === null ? undefined : progressFraction(manifest, journal);
  return {
    runId: id,
    name: runLabel(manifest?.meta, id),
    // AD-15 / T14: the state comes from the MANIFEST, never from having observed
    // a `state` event. `getUltraManifest` rewrites a stale `running` to
    // `stopped` ON READ without going through `settle()`, so a run killed by a
    // server restart reaches a terminal state with no event, no publish and no
    // `end` frame anyone will ever see. A UI that waits for an event to declare
    // a run finished shows a permanently-running anchor for every one of them.
    state,
    spendUsd: manifest?.spend ?? 0,
    ...(manifest?.error !== undefined ? { error: manifest.error } : {}),
    startedAt: manifest?.startedAt ?? 0,
    updatedAt: manifest?.updatedAt ?? 0,
    ...(sourced ? { agentsDone: rows.filter((r) => r.settled).length } : {}),
    agentsTotal: undefined,
    // THE DECLARED PHASES ARE SEEDED ONLY ONCE THE JOURNAL HAS BEEN READ, and
    // the `events !== null` term is the same one `progress` above carries, for
    // the same reason (B1). Unread means this reader does not know which phases
    // BEGAN — so seeding a terminal run's four declared phases from its manifest
    // alone would draw four `never reached` headers over a run that in fact ran
    // all four. Absent until sourced; the group list and the sliver appear
    // together, on the same fact.
    //
    // THE MANIFEST ITSELF GOES THROUGH EITHER WAY. Suppressing the seed by
    // nulling it also threw away the run's STATE, and the agent INDEX can put
    // rows in the unphased group with the journal still unread — so a finished
    // run's one group came back `running`, the exact lie the fourth state exists
    // to prevent.
    phases: phaseGroups(journal, rows, manifest, events !== null),
    narrator: narratorLines(journal),
    ...(progress !== undefined ? { progress } : {}),
    pending: manifest === null,
  };
}

/** Every stacked row the anchor can draw. AC2's executable stand-in, WIDENED IN
 *  REVIEW ROUND 1 (SF-5) from a bare form to the full set of shape-affecting
 *  decisions.
 *
 *  WHY THE OLD SHAPE WAS A GUARD THAT COULD NOT FAIL. `anchorForm` read `state`
 *  and nothing else, so it was STRUCTURALLY BLIND to a height change driven by
 *  anything else — and there was one: the phase sliver was rendered only when
 *  `run.progress` was defined, and `progress` is undefined for D8's pending
 *  payload (`progressFraction` short-circuits on a null manifest) and becomes
 *  defined when the first manifest lands. So the anchor gained `gap-1` + `h-px`
 *  MID-STREAM, a second height change AC2 forbids, and the test asserting "the
 *  form changes at most once" could not see it. */
export type AnchorShape = {
  form: "running" | "terminal";
  /** row 2 — the narrator line plus the sliver track. */
  detail: boolean;
  /** the sliver's TRACK, which is RESERVED rather than conditional: a run whose
   *  script declared no phases still gets the pixel, drawn empty. Absence would
   *  be a height change the moment `meta.phases` arrived. */
  sliver: boolean;
  /** the terminal error line (`failed` only — `done` has no error). */
  errorRow: boolean;
};

/** AC2's honest proof. A rendered HEIGHT cannot be tested without a DOM; the
 *  claim that THE SHAPE OF THE ANCHOR IS CONSTANT WHILE RUNNING can, and that is
 *  what this is. The renderer consumes it — it branches on nothing else — so the
 *  two cannot diverge. */
export function anchorShape(run: RunSnapshot): AnchorShape {
  const form: AnchorShape["form"] = run.state === "running" ? "running" : "terminal";
  return {
    form,
    detail: form === "running",
    sliver: form === "running",
    // NON-EMPTY, not merely present: the renderer this replaces branched on
    // `run.error` truthiness, and `error: ""` is reachable (`runSnapshot` copies
    // the manifest's field whenever it is not `undefined`). An empty string
    // would otherwise draw an icon beside nothing — a row of height, with no
    // content, on a terminal run.
    errorRow: form === "terminal" && run.error !== undefined && run.error !== "",
  };
}

/** WHICH AFFORDANCES EXIST, kept SEPARATE from the shape on purpose: the two
 *  controls sit in row 1, which is a non-wrapping flex line, so their presence
 *  changes the anchor's WIDTH and never its HEIGHT. Folding them into
 *  `AnchorShape` would make AC2's "the shape is constant while running" proof
 *  fail on a difference AC2 does not forbid — and a proof that has to be told
 *  which of its own fields to ignore is back to being prose. */
export type AnchorControls = { canStop: boolean; canResume: boolean };

export function anchorControls(run: RunSnapshot): AnchorControls {
  return {
    // `!run.pending` IS LOAD-BEARING AND IS NOT BELT AND BRACES (review B2). The
    // pending payload has no manifest, and `state` FALLS BACK to `running`
    // because AD-15 leaves no honest alternative — a run with no manifest yet is
    // far likelier to be starting than finished. But `session-view.tsx` seeds
    // `messages` synchronously from `initialChat` while `useUltraRuns` starts
    // empty and fetches in an effect, so on the FIRST PAINT of any session that
    // ever launched a run every anchor is pending — including one whose run
    // finished last week. Without this term that run offered a live `running`
    // badge and an ENABLED STOP BUTTON, on every load, for every such session.
    canStop: run.state === "running" && !run.pending,
    // AC5 proof 1 — Resume is for `stopped` and `failed` and NOT for `done`.
    // THAT IS A UI RULE, NOT A CORE RULE: `resumeUltraRun` does not gate on
    // state and will happily resume a `done` run and re-fire its wake. Stated
    // here so the next reader does not "fix" the UI to match the port.
    canResume: run.state === "stopped" || run.state === "failed",
  };
}

/** The form alone, kept because AC2's original proof and `ui-contract.md` both
 *  speak in those two words. It is now DERIVED from the shape rather than
 *  computed beside it, so it cannot drift from what the renderer draws. */
export function anchorForm(run: RunSnapshot): "running" | "terminal" {
  return anchorShape(run).form;
}

// ── the session filter (D5 / C1) ────────────────────────────────────────────

// DEFINED-AND-EQUAL, NEVER TRUTHY. `run.sessionId` is optional — a run launched
// outside a chat has none — so `sessionId && run.sessionId === sessionId` would
// silently return everything for the empty string, and `run.sessionId ===
// sessionId` alone would match every chat-less run against an absent filter.
//
// Generic over `{ sessionId?: string }` rather than over `RunSnapshot` because
// the route filters `UltraManifest[]` server-side and the rail filters snapshots
// — one rule, and the route is a three-line caller of it. That is the whole
// mechanism by which a route with no test harness in this repo is still proved.
export function filterRunsBySession<T extends { sessionId?: string }>(
  runs: readonly T[],
  sessionId?: string,
): readonly T[] {
  if (sessionId === undefined) return runs;
  return runs.filter((r) => r.sessionId === sessionId);
}

// ── per-session liveness for the sidebar (issue #17) ────────────────────────

// A session row's "Working…" dot is sourced ONLY from the in-flight chat-turn
// registry (lib/chat-runs.ts's isSessionRunLive), which knows nothing about
// Ultra: a launched run keeps going as its own detached process (its manifest
// lives under TELAR_HOME/ultra/*) long after the HTTP turn that launched it
// has returned and the registry entry is gone. So a session can have real,
// user-visible work in flight while every signal the sidebar already reads
// says idle. This is that missing signal, folded down to the one shape a row
// needs: how many of ITS runs are `running` right now.
//
// Generic over the manifest/snapshot shape for the same reason
// `filterRunsBySession` above is: `/api/chats` counts raw `UltraManifest[]`
// server-side (a `@telar/core` VALUE import, fine there — it is a route, not
// a client component), while a client caller in possession of `RunSnapshot[]`
// gets the identical answer without needing that server-only type in scope.
export function liveRunCountsBySession<T extends { sessionId?: string; state: UltraRunState }>(
  runs: readonly T[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    // DEFINED-AND-EQUAL, same rule `filterRunsBySession` states above: a run
    // launched outside any chat has no `sessionId` and must count toward
    // nothing, never toward the empty-string key.
    if (run.sessionId === undefined || run.state !== "running") continue;
    counts.set(run.sessionId, (counts.get(run.sessionId) ?? 0) + 1);
  }
  return counts;
}

// ── the journal-stream reconciler (review round 1 — B1 and SF-1) ────────────

// WHICH RUNS NEED AN OPEN JOURNAL STREAM, AND WHAT TO DO ABOUT IT. Both
// decisions live here rather than inside `use-ultra-runs.ts`'s effect, for the
// reason this file's header gives: an effect body cannot be driven by a test in
// this repo, and BOTH of these shipped wrong.
//
// B1 — A TERMINAL RUN NEEDS ITS JOURNAL READ EXACTLY ONCE. The hook opened a
// stream only for a `running` run, so a run that settled before the page mounted
// was projected from its MANIFEST ALONE — and the manifest carries no agent
// count, no phase history and no log lines. The anchor therefore stated `0 done`
// as a fact for a run that settled five agents. `/api/ultra/[id]/events` replays
// every event from line 0 and then sends `end` for a terminal run, so opening it
// once IS a one-shot read of the journal rather than a subscription; `hydrated`
// is what stops it becoming one.
//
// SF-1 — AND THE SET IS RECONCILED, NEVER REBUILT. The effect closed every
// stream in its cleanup, which React runs on EVERY dependency change: a second
// run launching tore down the FIRST run's still-wanted stream, the body then
// found the map empty and re-opened it, and the route replayed the whole journal
// into an accumulator nothing reset — so the narrator repeated its own history,
// once more per concurrent launch. AC4's headline "concurrent runs are
// first-class" case was the one case that broke it.

/** Every run whose journal this page still needs open: all the live ones, plus
 *  any run it has not yet drained to `end`. */
export function wantedStreams(
  liveIds: readonly string[],
  allIds: readonly string[],
  hydrated: ReadonlySet<string>,
): string[] {
  const live = new Set(liveIds);
  return allIds.filter((id) => live.has(id) || !hydrated.has(id));
}

/** The INCREMENTAL step from what is open to what is wanted. A run present in
 *  both appears in NEITHER list — that is the whole point, and it is what a
 *  close-everything cleanup could not express. */
export function reconcileStreams(
  openIds: readonly string[],
  wanted: readonly string[],
): { close: string[]; open: string[] } {
  const want = new Set(wanted);
  const have = new Set(openIds);
  return {
    close: openIds.filter((id) => !want.has(id)),
    open: wanted.filter((id) => !have.has(id)),
  };
}

// ── the dock summary (AC7 proof 6) ──────────────────────────────────────────

// "One dock signal per session; concurrent live runs summarize" —
// `ui-contract.md` §9. One run renders its name; N>1 renders "N runs live"; the
// spend is the SUM of those runs' figures.
//
// `provider` is an ARGUMENT, not a hard-coded value, even though every ultra
// surface passes the Claude one today (see `anchorSpend` below) — the dock's
// poller has no session provider in scope because `Runtime` carries none, so the
// unit has to arrive from somewhere and a default would hide the decision.
export function summarizeRuns(runs: readonly RunSnapshot[], provider: SpendProvider): DockRunSummary {
  const live = runs.filter((r) => r.state === "running");
  if (live.length === 0) return null;
  const usd = live.reduce((sum, r) => sum + r.spendUsd, 0);
  const spend = anchorSpend(provider, usd);
  if (live.length === 1) {
    const only = live[0]!;
    return { text: only.name, state: only.state, spend, focusRunId: only.runId };
  }
  return { text: `${live.length} runs live`, spend };
}

// D6a — THE SPEND CALL, SPELLED OUT ONCE, because the two halves do not fit.
// `UltraManifest.spend` is a bare USD number; `spendReadout(provider, {usd,
// tokens})` wants a pair. There is no tokens figure anywhere on the ultra path
// and no route that would produce one.
//
// A `tokens: 0` HERE IS NOT A READOUT OF ZERO TOKENS; it is the unit that never
// applies on this path. `provider` is always the Claude value on every ultra
// surface — anchor, rail card and dock head alike — because the ultra MCP server
// is constructed only on the Claude branch of the chat route and NFR-UW-8 fixes
// that. Passing the Codex value would render a confident `0`, which is a
// fabricated figure (hard rule 3). IF A CODEX ULTRA PATH EVER EXISTS, THIS IS
// THE ONE PLACE IT CHANGES.
export function anchorSpend(provider: SpendProvider, usd: number): SpendReadout {
  return spendReadout(provider, { usd, tokens: 0 });
}

/** REVIEW ROUND 1, SF-4 — is this the session the user is looking at RIGHT NOW?
 *
 *  The dock signal's job is discovering a session that is NOT a dock entry
 *  (AC7's whole case), and it did that by docking every session with a live run
 *  — including the one whose page was on screen, so a minimized head for the
 *  session you were already reading slid into the corner within 8 seconds, and
 *  nothing removed it because `session-view.tsx`'s `clearAutoDock` effect fires
 *  only at mount.
 *
 *  A ROUTE TEST AND NOT A FOCUS TEST, deliberately, and this is a considered
 *  deviation from the review's suggested fix. `loom-notifications.tsx`'s
 *  `visibilityState === "hidden" || !document.hasFocus()` is the right guard for
 *  a NOTIFICATION, whose whole premise is that the user is away. It is the wrong
 *  guard here: AC7's Given is "the user is on ANOTHER PAGE with a run live" — a
 *  focused tab — so a focus guard would suppress the dock head in exactly the
 *  case the AC exists to describe. What must be skipped is one session, not one
 *  tab, and that is a fact about the ROUTE.
 *
 *  `dock.tsx` builds `/projects/<project>/sessions/<id>`, so the id is the last
 *  segment. Compared raw first, then decoded, because a router pathname may or
 *  may not carry percent-escapes and a malformed one must be a non-match rather
 *  than a throw. */
export function isSessionRoute(pathname: string, sessionId: string): boolean {
  if (sessionId === "") return false;
  const suffix = `/sessions/${sessionId}`;
  if (pathname.endsWith(suffix)) return true;
  try {
    return decodeURIComponent(pathname).endsWith(suffix);
  } catch {
    return false;
  }
}

// ── the composer's arm state (AC6 / D2) ─────────────────────────────────────

// ARMING IS PER-MESSAGE AND IS NOT PERSISTED (T11). `telar:composer:${project}`
// remembers model, effort and permission mode across sessions; the chip is
// per-message by NFR-UW-1 ("Opt-in is a request, not a behavior flag"). A
// remembered chip is a behaviour flag with extra steps.
//
// "sent" is distinct from "disarm" so the reducer records WHY it disarmed: the
// user untoggling and the send consuming the arm are the same end state and
// different events, and the test that matters — arm → send → next send carries
// no key — reads the second.
export function armReducer(state: ArmState, action: "arm" | "disarm" | "sent"): ArmState {
  switch (action) {
    case "arm":
      return { armed: true };
    case "disarm":
    case "sent":
      return { armed: false };
  }
}

/** The `POST /api/chat` options for one dispatch. The wire name is `ultra` —
 *  `app/api/chat/route.ts` destructures that exact key and narrows it with
 *  `rawUltra === true`. Do NOT invent `ultraAnnotated`, `ultraArmed` or
 *  `annotateUltra` on the wire. */
export type ChatSendOptions = { hidden?: boolean; ultra?: boolean };

/** WHICH MESSAGE THE ARM APPLIES TO, decided here rather than inside the body
 *  literal, and the reason is measured rather than stylistic.
 *
 *  `session-view.tsx` has ONE `POST /api/chat` body literal and THREE dispatch
 *  sources fire it: the user pressing Enter, the message queue draining when the
 *  agent goes idle, and story 4.1's HIDDEN WAKE TURN. Reading the chip's
 *  component state inside that literal would annotate all three — including a
 *  turn with no user message at all, whose appendix would then claim "the user's
 *  message below is Ultra-annotated" about nothing, and including a queued
 *  message that would carry whatever the chip happened to say when the queue
 *  drained rather than when the user pressed Enter.
 *
 *  So the arm is read ONCE, at `handleSubmit`, and travels with the dispatch:
 *  immediately for the idle path, and on the queued item for the busy path.
 *  The wake's dispatch is not a source here at all — it stays the literal
 *  `next.hidden ? { hidden: true } : undefined` it already was, and
 *  `ultra-runs.test.ts` pins that line statically so a later edit cannot quietly
 *  route it through this function. */
export type SendSource = { kind: "user"; armed: boolean } | { kind: "queued"; ultra?: boolean };

export function sendOptionsFor(source: SendSource): ChatSendOptions | undefined {
  const armed = source.kind === "user" ? source.armed : source.ultra === true;
  return armed ? { ultra: true } : undefined;
}

// ── the transcript splice (D8 / AC1 proof 2 / AC4) ──────────────────────────

// HOW A LAUNCH IS RECOGNISED, PRECISELY, BECAUSE GETTING IT WRONG IS SILENT.
// The tool's wire name is `mcp__ultra__ultra`; its `output` is the handler's
// okResult text, `JSON.stringify({ runId, meta, note }, null, 2)`.
//
// AND IT IS TRUNCATED. `app/api/chat/route.ts` passes every tool result through
// `capToolOutput`, a HEAD-truncate at `TOOL_OUTPUT_CAP`, so a launch whose
// `meta` is large arrives as a PREFIX OF VALID JSON — which `JSON.parse`
// rejects outright. Because `runId` is the first key the tool emits, the head
// survives. So: try `JSON.parse`; on failure fall back to a regex over the same
// text. Both arms are tested, including a deliberately truncated fixture. A
// splice that only handles well-formed JSON works on every small script you test
// by hand and fails on the first real one.
const RUN_ID_IN_TEXT = /"runId"\s*:\s*"([^"]+)"/;

export function extractRunId(output: string | undefined): string | null {
  if (typeof output !== "string" || output === "") return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (isRecord(parsed) && typeof parsed.runId === "string" && parsed.runId !== "") return parsed.runId;
  } catch {
    // fall through to the truncated-prefix arm
  }
  const m = RUN_ID_IN_TEXT.exec(output);
  return m && m[1] ? m[1] : null;
}

/** The runId this tool part launched, or null when it is not a launch.
 *
 *  TWO MORE RECOGNITION RULES, both from `ui-contract.md` §5. An `isError: true`
 *  ultra result is a VALIDATION REJECTION (a `model`-less script returning to
 *  the agent, which re-authors) — there is no run, so it stays an ordinary tool
 *  row. And a part with NO `output` yet is a launch in flight: leave it a tool
 *  row until the result lands, then splice. */
export function launchedRunId(part: ToolPart): string | null {
  if (part.name !== ULTRA_TOOL_NAME) return null;
  if (part.isError === true) return null;
  return extractRunId(part.output);
}

// THE SPLICE REPLACES THE ULTRA TOOL PART AND SPLITS ITS GROUP. IT NEVER
// APPENDS. `groupParts` collapses a run of consecutive tool calls into one
// `conversation:tools` item, so the launch usually arrives inside a group with
// neighbours. Three shapes were considered and two rejected:
//   - Append the anchor AFTER the group. REJECTED: the shell marks only the LAST
//     top-level item live, and `isTrailingItem` is what makes a streaming turn's
//     trailing tool group auto-open. An item appended after it silently steals
//     the turn's liveness. The `trailing` prop's own doc says this in the shell's
//     words, and it is why story 3.1 put the loom rows there instead.
//   - Leave the tool row and add an anchor BESIDE it. REJECTED: the contract says
//     "Each run is ONE compact fixed-height tool-style row", and a generic tool
//     row showing `{script: "…4KB…"}` beside it is the noise the density rule
//     exists to prevent.
//   - Replace the part and split the group. CHOSEN.
//
// IT IS A TOTAL FUNCTION: items with no ultra call come back unchanged.
//
// KEYS NAME THE EVENT, NOT THE SLOT (the house maxim, paid for three times in
// story 1.1). The anchor's key is derived from the runId — the run IS the event
// — and the trailing half of a split group is keyed by the launch that split it,
// never by a loop index.
export function spliceRunAnchors(
  items: readonly TranscriptItem[],
  runs: ReadonlyMap<string, UltraAnchorPayload>,
  /** Builds the PENDING form (D8) for a runId the caller has no snapshot for
   *  yet. The launch is a fact the moment the tool result carries a runId, so an
   *  anchor whose manifest has not arrived renders pending rather than being
   *  dropped. Omitted ⇒ an unknown runId leaves its tool row alone, which is the
   *  other honest total-function answer. */
  pending?: (runId: string) => UltraAnchorPayload,
): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const item of items) {
    if (item.kind !== CONVERSATION_KINDS.tools) {
      out.push(item);
      continue;
    }
    const payload = item.payload as ToolsPayload;
    const parts = payload.parts ?? [];
    // Cheap negative path: no ultra launch in this group at all.
    if (!parts.some((p) => launchedRunId(p) !== null)) {
      out.push(item);
      continue;
    }
    let bucket: ToolPart[] = [];
    let bucketKey = item.key;
    let splitCount = 0;
    const flush = () => {
      if (bucket.length === 0) return; // drop an empty side rather than emit an empty group
      out.push({ ...item, key: bucketKey, payload: { ...payload, parts: bucket } satisfies ToolsPayload });
      bucket = [];
    };
    for (const part of parts) {
      const runId = launchedRunId(part);
      const anchor = runId === null ? undefined : (runs.get(runId) ?? pending?.(runId));
      if (runId !== null && anchor) {
        flush();
        out.push({ kind: ULTRA_ANCHOR_KIND, key: `ultra:${runId}`, payload: anchor });
        splitCount += 1;
        bucketKey = `${item.key}~${runId}`;
      } else {
        bucket.push(part);
      }
    }
    if (splitCount === 0) {
      // Every launch in this group was unresolvable (no snapshot, no pending
      // factory). Restore the group EXACTLY as it arrived — same object, same
      // key — rather than re-emitting a structurally-equal copy.
      bucket = [];
      out.push(item);
      continue;
    }
    flush();
  }
  return out;
}

// ── the agent row's derived fields (owner ruling, 2026-07-31) ────────────────
//
// All of them live HERE and not in the component for this file's stated reason:
// what a row SAYS is a decision and gets a test; what it looks like is layout
// and does not. The component that renders them owns no rule at all. (Three when
// this section was written; issue #27 added the label's de-prefixing as the
// fourth, for exactly the same reason — it is a rule about what a row says.)

/** THE ROW'S STATUS, as one closed vocabulary. `AgentRow` carries three
 *  independent booleans (`live`, `settled`, `ok`) whose combinations a renderer
 *  was reading ad hoc, and one of those combinations is genuinely not
 *  "running": `stopUltraRun` aborts its in-flight agents, so an ordinal on an
 *  ENDED run can be neither settled nor live — it was terminated before it
 *  began, which reads as "not started" rather than as a failure it never had. */
export type AgentRunStatus = "not-started" | "running" | "done" | "failed";

export function agentRunStatus(agent: {
  live?: boolean;
  settled?: boolean;
  ok?: boolean;
}): AgentRunStatus {
  if (agent.live) return "running";
  if (!agent.settled) return "not-started";
  return agent.ok === false ? "failed" : "done";
}

export const AGENT_STATUS_LABEL: Record<AgentRunStatus, string> = {
  "not-started": "not started",
  running: "running",
  done: "done",
  failed: "failed",
};

/** THE LABEL AS READ UNDER ITS OWN HEADER (issue #27). Scripts write
 *  `label: "survey:measure"`, so under a `SURVEY` header the rows read
 *  `survey:measure`, `survey:style`, `survey:desktop` — the header supplies that
 *  word and every row repeats it.
 *
 *  STRIPPED IN THE RENDERER AND NOT AT THE SOURCE, deliberately. The stored
 *  label is UNTOUCHED: the prefix is genuinely useful in every FLAT context —
 *  `ultra_inspect` output, the run anchor, any list with no group header to
 *  supply the context — and removing it from the event would lose that
 *  everywhere to fix it in one place. Fixing it here also fixes every script
 *  already written, including ones authored outside this repo, which an
 *  authoring-guide note cannot.
 *
 *  EXACT TITLE MATCH ONLY, case-insensitively. `fix` does not strip `fixup:`,
 *  because the prefix must be the group's own name and nothing else — a
 *  substring rule would eat a real label's first word. An empty group title
 *  (`UNPHASED`) strips nothing at all; otherwise a label beginning with a bare
 *  colon would lose it. And a label that IS only its prefix (`"survey:"`) comes
 *  back whole, because a nameless row says less than a redundant one. */
export function agentLabelInPhase(label: string, groupTitle: string): string {
  if (groupTitle === "") return label;
  if (label.slice(0, groupTitle.length).toLowerCase() !== groupTitle.toLowerCase()) return label;
  if (label[groupTitle.length] !== ":") return label;
  // `trimStart` rather than one optional space: the separator scripts actually
  // write varies, and a row rendered with leading whitespace truncates from a
  // blank.
  const stripped = label.slice(groupTitle.length + 1).trimStart();
  return stripped === "" ? label : stripped;
}

/** THE MODEL, NAMED THE WAY THE PRODUCT NAMES IT. A script passes a bare alias
 *  (`"sonnet"`, `"opus"`) straight to `agent()`, and the row printed that alias
 *  — so an Ultra said `sonnet` where every other surface in the app says
 *  "Sonnet 5 1M". Resolved against `lib/models.ts`, the same registry the
 *  composer's picker renders, by exact id first and then by TIER so the aliases
 *  scripts actually use resolve too.
 *
 *  AN UNRECOGNISED STRING IS RETURNED VERBATIM. A model this build has never
 *  heard of is still what the run was told to use, and inventing a prettier
 *  name for it would misreport which model ran. */
export function agentModelLabel(model: string): string {
  const raw = model.trim();
  if (raw === "") return "";
  const exact = MODELS.find((m) => m.id === raw);
  const byTier = exact ?? MODELS.find((m) => m.tier === raw.toLowerCase());
  if (!byTier) return raw;
  return byTier.context ? `${byTier.name} ${byTier.context}` : byTier.name;
}

/** TOKENS, NOT MONEY, for a sub-agent (owner ruling): what a run consumed is
 *  the useful per-agent figure, and the dollar total already has one home in
 *  the run header and another in the session breakdown.
 *
 *  ABSENT IS NOT ZERO, and the caller must keep them apart — this returns
 *  `undefined` when the provider reported no usage, and the row renders that as
 *  a placeholder rather than as a confident `0`.
 *
 *  INPUT + OUTPUT, THE SAME PAIR A SESSION COUNTS. `lib/spend-readout.ts`
 *  already settled this for the session readout and spelled out why: cache
 *  reads and cache writes are re-presentations of content already sent, so
 *  folding them in makes the figure climb every turn purely from re-sending the
 *  same transcript. Its header names this surface directly — "story 4.2's
 *  per-run anchor can compute the identical figure ... Whatever the anchor
 *  chooses, it must be able to choose THIS" — and this function used to choose
 *  the other thing, summing all four fields.
 *
 *  WHAT THAT COST, and it is the reason the rule is now stated in both places
 *  rather than only in `spend-readout.ts`. A per-agent row read `1.7M tok`
 *  beside a `Claude Sonnet 1M` model chip: two figures in the same unit, on the
 *  same row, one a cumulative sum over every turn and the other a per-turn
 *  ceiling. The reading it invites — that the agent overran its window and
 *  compacted — is false, and the run it was read off had in fact spent almost
 *  all of that on cache reads, which is why its dollar total was a fifth of
 *  what 1.7M fresh input tokens would have cost. The count was not wrong; it
 *  was answering a question nobody was asking next to a number that made it
 *  look like an answer to a different one.
 *
 *  So this is NOT context occupancy either, and must not be presented as one:
 *  it is still a lifetime sum across the agent's turns and can exceed the
 *  model's window. `ContextUsageSnapshot` is where occupancy lives, with a
 *  `maxTokens` beside it to divide by. */
export function agentTokenTotal(agent: {
  tokens?: { input: number; output: number; cacheRead: number; cacheCreate: number };
}): number | undefined {
  const t = agent.tokens;
  if (!t) return undefined;
  return t.input + t.output;
}

// PANEL ORDER FOR THE WORKFLOWS SECTION — live work first, finished work last.
//
// WHAT WAS WRONG. The section rendered `[...ultraRuns.values()]` in map
// insertion order, which is arrival order, which after a busy session is
// neither. A run that finished an hour ago sat above one working right now, and
// the only thing distinguishing them was a word inside the card. Ten runs in,
// the section is mostly history with the live one somewhere in it.
//
// STABLE WITHIN EACH GROUP, deliberately. This is a partition, not a re-sort:
// runs keep their existing relative order inside "live" and inside "finished",
// so a row never moves for any reason except its own state changing. A sort on
// a timestamp would shuffle neighbours whenever one settled, which is exactly
// the kind of motion that makes a list hard to click.
//
// `running` IS THE ONLY LIVE STATE — done, failed and stopped are all terminal
// and all sink. Failed does NOT get a middle tier: a failure is finished, and
// promoting it above other finished runs would make the list argue with the
// counts in the header rather than agree with them.
export function orderRunsForPanel<T extends { state: UltraRunState }>(runs: readonly T[]): T[] {
  const live: T[] = [];
  const finished: T[] = [];
  for (const run of runs) (run.state === "running" ? live : finished).push(run);
  return [...live, ...finished];
}
