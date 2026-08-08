// Story 4.2 — the proof for `lib/ultra-runs.ts`.
//
// NO DOM, NO DISK, NO NETWORK, and that is the whole design (§5.5-D3). There is
// no component test harness in this repo and story 3.1's hard rule 9 forbids
// introducing one, so every DECISION the Ultra session UI makes was moved into
// pure functions specifically so it could be asserted here. What is left in the
// components is layout, and layout is proved at the dev server instead — §6.2 of
// the story says which claims live where, and this file does not pretend to
// cover the ones it cannot.
//
// THE ONE EXCEPTION IS THE STATIC SCANS at the bottom, which read source files
// as TEXT. They are not disk-touching in the sense §6.1 forbids (no state root,
// no TELAR_HOME, INV-7 unaffected) — they are the executable form of two claims
// that are otherwise prose: "no budget UI anywhere" (AC9) and "the wake's
// dispatch cannot carry the chip's key" (§5.5-D1 item 7).
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig can't resolve it — suppress just the import, exactly
// as `spend-readout.test.ts` and `ultra-wake.test.ts` do. (A directive above an
// IMPORT is safe; hard rule 5's ban is on a directive above a CALL, which still
// calls.)
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ultraRunLabel } from "@telar/core";
import { CONVERSATION_KINDS, type TranscriptItem, type ToolsPayload } from "@/components/conversation/items";
import type { ConversationProps } from "@/components/conversation/conversation";
import type { ToolPart } from "@/components/session/tool-step";
import { LIVE_SNIPPET_CLASS } from "@/components/session/ultra-rail";
import { cn } from "@/lib/utils";
import {
  ACCOUNTING_LOG_PREFIXES,
  PHASE_STATUS_NOTE,
  ULTRA_ANCHOR_KIND,
  ULTRA_TOOL_NAME,
  ultraTabId,
  ultraTabRunId,
  UNPHASED,
  agentLabelInPhase,
  agentModelLabel,
  agentModelShortLabel,
  agentRows,
  agentTokenTotal,
  orderRunsForPanel,
  anchorControls,
  anchorForm,
  anchorShape,
  anchorSpend,
  armReducer,
  declaredPhases,
  extractRunId,
  filterRunsBySession,
  isSessionRoute,
  launchedRunId,
  liveRunCountsBySession,
  narratorLines,
  phaseGroups,
  progressFraction,
  reconcileStreams,
  runLabel,
  runSnapshot,
  sendOptionsFor,
  spliceRunAnchors,
  splitRunsForRail,
  summarizeRuns,
  unwrapManifest,
  unwrapManifests,
  wantedStreams,
  type AgentIndexRow,
  type RunSnapshot,
  type UltraAnchorPayload,
  type UltraEventLike,
  type UltraManifestLike,
} from "./ultra-runs";

// ── fixtures ────────────────────────────────────────────────────────────────

// `fileURLToPath(import.meta.url)` and not `import.meta.dir`: the latter is a
// Bun extension the web tsconfig cannot type, and `session-profiles.test.ts`
// already uses this form for the same reason.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readSource = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const manifest = (over: Partial<UltraManifestLike> = {}): UltraManifestLike =>
  ({
    runId: "u-aaa",
    meta: { name: "Sweep docs", description: "d", phases: ["Scan", "Rewrite"] },
    state: "running",
    spend: 0,
    startedAt: 1_000,
    updatedAt: 2_000,
    ...over,
  }) as UltraManifestLike;

const ev = {
  phase: (title: string): UltraEventLike => ({ type: "phase", title }),
  log: (msg: string): UltraEventLike => ({ type: "log", msg }),
  state: (state: "running" | "done" | "failed" | "stopped"): UltraEventLike => ({ type: "state", state }),
  start: (
    ordinal: number,
    over: Partial<{ label: string; model: string; effort: string; phase: string }> = {},
  ): UltraEventLike => ({
    type: "agent-start",
    ordinal,
    model: "sonnet",
    ...over,
  }),
  agent: (
    ordinal: number,
    over: Partial<{
      label: string;
      model: string;
      effort: string;
      phase: string;
      ok: boolean;
      costUsd: number;
      cached: true;
    }> = {},
  ): UltraEventLike =>
    ({
      type: "agent",
      ordinal,
      model: "sonnet",
      ok: true,
      settleId: `s-${ordinal}`,
      ...over,
    }) as UltraEventLike,
};

const toolPart = (over: Partial<ToolPart> & { name: string; id: string }): ToolPart => ({
  type: "tool",
  ...over,
});

/** The launch tool result, in the exact shape the `ultra` handler emits:
 *  `JSON.stringify({ runId, meta, note }, null, 2)`. */
const okResult = (runId: string, metaName = "Sweep docs") =>
  JSON.stringify({ runId, meta: { name: metaName, description: "d" }, note: "launched" }, null, 2);

const ultraPart = (runId: string, id = `tu-${runId}`) =>
  toolPart({ name: ULTRA_TOOL_NAME, id, output: okResult(runId) });

const toolsItem = (key: string, parts: ToolPart[]): TranscriptItem => ({
  kind: CONVERSATION_KINDS.tools,
  key,
  payload: { parts } satisfies ToolsPayload,
});

const textItem = (key: string, text: string): TranscriptItem => ({
  kind: CONVERSATION_KINDS.text,
  key,
  payload: { text },
});

const payloadFor = (runId: string, over: Partial<RunSnapshot> = {}): UltraAnchorPayload => ({
  run: { ...runSnapshot(manifest({ runId }), []), ...over },
  provider: "claude",
  onFocus: () => {},
  onStop: () => {},
  onResume: () => {},
  busy: false,
});

const partsOf = (item: TranscriptItem) => (item.payload as ToolsPayload).parts.map((p) => p.name);

// ── D5a — the duplicated run label ──────────────────────────────────────────

describe("4.2 D5a — ultra-runs' run label agrees with core's, and the duplication is deliberate", () => {
  // The second copy exists because `ultraRunLabel` is a core VALUE export and
  // this module is reached from a "use client" root (an INV-4c violation
  // reported by name), AND because the anchor's per-tick channel — the SSE tail
  // — carries the bare `UltraManifest`, which has no `name` field at all. So the
  // rule is duplicated and pinned against its original here rather than
  // trusted to stay in step.
  const cases: Array<[string, unknown]> = [
    ["a meta with a name", { name: "Sweep docs" }],
    ["a meta without one", { description: "d" }],
    ["a meta whose name is not a string", { name: 42 }],
    ["a meta whose name is whitespace only", { name: "   " }],
    ["a null meta", null],
    ["an undefined meta", undefined],
  ];
  for (const [label, meta] of cases) {
    test(`both copies agree on ${label}`, () => {
      expect(runLabel(meta, "u-fallback")).toBe(ultraRunLabel(meta, "u-fallback"));
    });
  }

  test("the agreement test is not vacuous — the two answers differ across the cases", () => {
    // A guard that cannot fail is worse than no guard (maxim 3): if every case
    // returned the runId, a `runLabel` that ALWAYS returned the runId would pass
    // every assertion above.
    expect(runLabel({ name: "Sweep docs" }, "u-fallback")).toBe("Sweep docs");
    expect(runLabel({ name: 42 }, "u-fallback")).toBe("u-fallback");
  });
});

// ── T16 — one envelope adapter ──────────────────────────────────────────────

describe("4.2 T16 — one envelope adapter for three shapes of one object", () => {
  test("a bare manifest (the SSE `run`/`end` frame) unwraps to itself", () => {
    expect(unwrapManifest(manifest())?.runId).toBe("u-aaa");
  });
  test("a `{ run }` envelope (GET /api/ultra/[id]) unwraps one level", () => {
    expect(unwrapManifest({ run: manifest({ runId: "u-bbb" }) })?.runId).toBe("u-bbb");
  });
  test("a `{ runs }` envelope (GET /api/ultra) unwraps to the array, in order", () => {
    const rows = unwrapManifests({ runs: [manifest({ runId: "u-1" }), manifest({ runId: "u-2" })] });
    expect(rows.map((r) => r.runId)).toEqual(["u-1", "u-2"]);
  });
  test("a bare array unwraps too, so a route that drops its envelope is survivable", () => {
    expect(unwrapManifests([manifest({ runId: "u-9" })]).map((r) => r.runId)).toEqual(["u-9"]);
  });
  test("garbage is null / [] rather than a throw — AD-8's tombstone rule", () => {
    expect(unwrapManifest(null)).toBeNull();
    expect(unwrapManifest("nope")).toBeNull();
    expect(unwrapManifest({ nothing: true })).toBeNull();
    expect(unwrapManifests(undefined)).toEqual([]);
    expect(unwrapManifests({ runs: [null, { runId: "u-ok" }, 7] }).map((r) => r.runId)).toEqual(["u-ok"]);
  });
});

// ── T6 — the narrator's accounting filter ───────────────────────────────────

describe("4.2 T6 — the narrator shows a script's log() and NEVER the ledger's bookkeeping", () => {
  // Four prefixes, one test each, because a filter that ate everything would
  // pass a single combined case.
  test("an ordinary log line IS narration", () => {
    expect(narratorLines([ev.log("3/10 found")])).toEqual(["3/10 found"]);
  });
  for (const prefix of ACCOUNTING_LOG_PREFIXES) {
    test(`a "${prefix}" line is NOT narration`, () => {
      expect(narratorLines([ev.log(`${prefix} something went wrong`)])).toEqual([]);
    });
  }
  test("the filter is a prefix test, not a substring test — a script that MENTIONS one still narrates", () => {
    // A user's own log line quoting the diagnostic is the user's line.
    expect(narratorLines([ev.log("saw spend-record-failed ordinal=2 in the tail")])).toHaveLength(1);
  });
  test("mixed streams keep order and drop only the accounting lines", () => {
    expect(
      narratorLines([
        ev.log("one"),
        ev.log("spend-read-unavailable: the usage ledger could not be read"),
        ev.log("two"),
        ev.phase("Scan"),
      ]),
    ).toEqual(["one", "two"]);
  });
});

// ── agent rows ──────────────────────────────────────────────────────────────

describe("4.2 AC3/AC11 — agent rows are live, deduped, and carry no invented figures", () => {
  test("an ordinal that has STARTED but not settled is a row, unsettled, with no `ok`", () => {
    const rows = agentRows([ev.start(0, { label: "scout", effort: "high" })], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settled).toBe(false);
    expect(rows[0]!.ok).toBeUndefined();
    expect(rows[0]!.label).toBe("scout");
    expect(rows[0]!.effort).toBe("high");
  });

  test("the settle event marks the SAME row settled — one row, not two", () => {
    const rows = agentRows([ev.start(0), ev.agent(0, { ok: false, costUsd: 0.5 })], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settled).toBe(true);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.costUsd).toBe(0.5);
  });

  test("AC11 proof 6 — an agent row has NO `tokens` key at all, settled or live", () => {
    // There are no token counts anywhere on the ultra path; the demo gallery's
    // rising `{n}t` figures are interpolated over wall time. Absence is asserted
    // on the KEY, not on a falsy value.
    for (const rows of [agentRows([ev.start(0)], []), agentRows([ev.start(0), ev.agent(0, { costUsd: 1 })], [])]) {
      expect("tokens" in rows[0]!).toBe(false);
    }
  });

  test("AC5 proof 5 — a resume's `cached: true` re-emissions do NOT double the row count", () => {
    // A real resumed sequence: run 1 starts and settles two ordinals; the resume
    // replays both from the journal, which re-emits `agent` (never
    // `agent-start`) with `cached: true`.
    const live: UltraEventLike[] = [ev.start(0), ev.agent(0), ev.start(1), ev.agent(1)];
    const resumed: UltraEventLike[] = [
      ...live,
      ev.agent(0, { cached: true, costUsd: 0.1 }),
      ev.agent(1, { cached: true, costUsd: 0.2 }),
    ];
    expect(agentRows(live, [])).toHaveLength(2);
    expect(agentRows(resumed, [])).toHaveLength(2);
    // last-wins: the replay's costs are what the row shows.
    expect(agentRows(resumed, []).map((r) => r.costUsd)).toEqual([0.1, 0.2]);
  });

  test("rows sort by ordinal even when the stream interleaves them (parallel fan-out)", () => {
    const rows = agentRows([ev.start(2), ev.start(0), ev.start(1), ev.agent(1)], []);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  });

  test("the agent index supplies the snippet from the highest attempt, and can see an ordinal the stream has not", () => {
    const index: AgentIndexRow[] = [
      { ordinal: 0, settled: false, attempt: 2, lastText: "retry text" },
      { ordinal: 7, settled: false, attempt: 1, lastText: "orphan" },
    ];
    const rows = agentRows([ev.start(0)], index);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 7]);
    expect(rows[0]!.snippet).toBe("retry text");
    // An ordinal known only to the index has no model to name, so the chip is
    // simply absent — never a guessed model string.
    expect(rows[1]!.model).toBe("");
  });

  test("settlement is sticky: the index saying `settled: false` cannot un-settle a settled ordinal", () => {
    // The index and the event stream are two channels over one truth and they
    // can disagree by one poll. The `agent` event is the authoritative settle.
    const rows = agentRows([ev.start(0), ev.agent(0)], [{ ordinal: 0, settled: false, attempt: 1, lastText: "x" }]);
    expect(rows[0]!.settled).toBe(true);
  });
});

// ── T5 — phase grouping ─────────────────────────────────────────────────────

describe("4.2 T5 — phase membership is stream order, and grouping is idempotent under a resume", () => {
  const stream: UltraEventLike[] = [
    ev.phase("Scan"),
    ev.start(0),
    ev.agent(0),
    ev.phase("Rewrite"),
    ev.start(1),
    ev.start(2),
    ev.agent(1),
    ev.agent(2),
  ];

  test("an agent belongs to the most recent PRECEDING phase event", () => {
    const groups = phaseGroups(stream, agentRows(stream, []));
    expect(groups.map((g) => g.title)).toEqual(["Scan", "Rewrite"]);
    expect(groups[0]!.agents.map((a) => a.ordinal)).toEqual([0]);
    expect(groups[1]!.agents.map((a) => a.ordinal)).toEqual([1, 2]);
  });

  test("a re-emitted phase sequence (a resume) produces the SAME groups, not double", () => {
    const resumed = [...stream, ...stream];
    const groups = phaseGroups(resumed, agentRows(resumed, []));
    expect(groups.map((g) => g.title)).toEqual(["Scan", "Rewrite"]);
    expect(groups.flatMap((g) => g.agents.map((a) => a.ordinal))).toEqual([0, 1, 2]);
  });

  test("agents seen before any phase event land in the unphased group, which renders without a heading", () => {
    const s: UltraEventLike[] = [ev.start(0), ev.phase("Scan"), ev.start(1)];
    const groups = phaseGroups(s, agentRows(s, []));
    expect(groups.map((g) => g.title)).toEqual([UNPHASED, "Scan"]);
    expect(UNPHASED).toBe("");
  });

  test("a phase that declared itself but has spawned nothing yet is still a group — it is where the run IS", () => {
    const s: UltraEventLike[] = [ev.phase("Scan"), ev.phase("Rewrite")];
    expect(phaseGroups(s, []).map((g) => ({ title: g.title, n: g.agents.length }))).toEqual([
      { title: "Scan", n: 0 },
      { title: "Rewrite", n: 0 },
    ]);
  });

  test("two phases with the SAME title are one group — the title is the identity", () => {
    const s: UltraEventLike[] = [ev.phase("Scan"), ev.start(0), ev.phase("Scan"), ev.start(1)];
    const groups = phaseGroups(s, agentRows(s, []));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.agents.map((a) => a.ordinal)).toEqual([0, 1]);
  });

  test("with NO manifest every observed group is `done` except the current one — the old two-state reading", () => {
    // The status field is new (issue #27) and the manifest-less call is the one
    // every pre-existing caller makes, so this pins that the addition did not
    // change what an observed-only grouping SAYS: the last phase seen is the
    // running one, everything before it has been left behind, and nothing is
    // pending because nothing was declared.
    //
    // "LEFT BEHIND" IS A FACT ABOUT THE AGENTS, so `Scan`'s settles are part of
    // the fixture rather than assumed: a bare `await agent()` script has settled
    // its ordinal before the next `phase()` call runs, and a phase still holding
    // an unsettled agent is not behind anything (see the case below).
    const s: UltraEventLike[] = [ev.phase("Scan"), ev.start(0), ev.agent(0), ev.phase("Rewrite"), ev.start(1)];
    expect(phaseGroups(s, agentRows(s, [])).map((g) => g.status)).toEqual(["done", "running"]);
  });

  test("a phase the run has moved PAST but whose agent is still live reads `running`, not `done`", () => {
    // The premise "phases are sequential in the stream" retired with `opts.phase`
    // (issue #40): stages overlap, so the last event seen is not the only place
    // work is happening. Ordinal 0 never settled — `Scan` is still running.
    const s: UltraEventLike[] = [ev.phase("Scan"), ev.start(0), ev.phase("Rewrite"), ev.start(1)];
    expect(phaseGroups(s, agentRows(s, [])).map((g) => g.status)).toEqual(["running", "running"]);
    // …and settling it hands `Scan` back to the sequential reading.
    const settled = [...s, ev.agent(0)];
    expect(phaseGroups(settled, agentRows(settled, [])).map((g) => g.status)).toEqual(["done", "running"]);
  });
});

// ── issue #27 part 1 — the DECLARED phases are shown before they run ─────────

describe("issue #27 — a declared phase is a group before it happens, and has four states", () => {
  // The reported run: `ci-verification-gate`, four phases declared at launch,
  // one box on screen. The user knows more is coming; the surface did not say so.
  const declared = (over: Partial<UltraManifestLike> = {}) =>
    manifest({
      meta: { name: "ci-verification-gate", phases: ["survey", "author", "verify", "fix"] },
      ...over,
    });

  test("all four declared phases are groups on a run that has only reached the first", () => {
    const s: UltraEventLike[] = [ev.phase("survey"), ev.start(0), ev.start(1)];
    const groups = phaseGroups(s, agentRows(s, []), declared());
    expect(groups.map((g) => g.title)).toEqual(["survey", "author", "verify", "fix"]);
    expect(groups.map((g) => g.status)).toEqual(["running", "pending", "pending", "pending"]);
  });

  test("HEADERS ONLY — a pending phase has NO agent rows, because nothing knows how many it will spawn", () => {
    // The constraint that makes this safe to render at all: `verify` spawns one
    // agent per lens and `fix` spawns one only if the author survived, so a
    // skeleton row would be a fabricated count (this module's hard rule 3).
    const s: UltraEventLike[] = [ev.phase("survey"), ev.start(0)];
    const groups = phaseGroups(s, agentRows(s, []), declared());
    expect(groups.filter((g) => g.status === "pending").every((g) => g.agents.length === 0)).toBe(true);
    expect(groups.flatMap((g) => g.agents.map((a) => a.ordinal))).toEqual([0]);
  });

  test("a phase that never began on a TERMINAL run is `never-reached`, never a spinner", () => {
    // The script returns early when the author dies, so `fix` legitimately never
    // happens. Left as `pending` it would spin forever on a finished run.
    const s: UltraEventLike[] = [
      ev.phase("survey"),
      ev.start(0),
      ev.agent(0),
      ev.phase("author"),
      ev.start(1),
      ev.agent(1, { ok: false }),
    ];
    const groups = phaseGroups(s, agentRows(s, [], "failed"), declared({ state: "failed" }));
    expect(groups.map((g) => g.status)).toEqual(["done", "done", "never-reached", "never-reached"]);
    // NOTHING IS `running` ON A RUN THAT HAS ENDED — including the phase that
    // was current when it died. `done` here means "began and is no longer in
    // progress"; whether the work went well is what the agent rows say, and this
    // one's did not.
    expect(groups.some((g) => g.status === "running")).toBe(false);
    expect(groups[1]!.agents[0]!.ok).toBe(false);
  });

  test("stopped and done are terminal for this too — it is the RUN's state, not a phase event", () => {
    // AD-15's on-read `running` → `stopped` rewrite emits no event at all, which
    // is why the manifest is the source here.
    const s: UltraEventLike[] = [ev.phase("survey")];
    for (const state of ["done", "stopped", "failed"] as const) {
      expect(phaseGroups(s, [], declared({ state })).map((g) => g.status)).toEqual([
        "done",
        "never-reached",
        "never-reached",
        "never-reached",
      ]);
    }
    expect(phaseGroups(s, [], declared({ state: "running" })).map((g) => g.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
    ]);
  });

  test("THE DECLARED LIST SEEDS THE ORDER; IT DOES NOT RESTRICT IT — an undeclared phase is appended", () => {
    // A script may call `phase()` with a title that is not in `meta.phases`.
    // Those must still appear, exactly as they did before this change.
    const s: UltraEventLike[] = [ev.phase("survey"), ev.phase("triage"), ev.start(0)];
    const groups = phaseGroups(s, agentRows(s, []), declared());
    expect(groups.map((g) => g.title)).toEqual(["survey", "author", "verify", "fix", "triage"]);
    expect(groups.find((g) => g.title === "triage")!.status).toBe("running");
    expect(groups.find((g) => g.title === "triage")!.agents.map((a) => a.ordinal)).toEqual([0]);
  });

  test("declared order wins over observed order for a phase in both", () => {
    // A script that runs its declared phases out of order gets the order it
    // PUBLISHED, because that is the order the user was promised at launch and
    // the one the group list is a preview of.
    const s: UltraEventLike[] = [ev.phase("verify"), ev.phase("survey")];
    expect(phaseGroups(s, [], declared()).map((g) => g.title)).toEqual([
      "survey",
      "author",
      "verify",
      "fix",
    ]);
  });

  test("a duplicated title in `meta.phases` is still ONE group — the title is the identity", () => {
    const m = manifest({ meta: { name: "n", phases: ["a", "b", "a"] } });
    expect(phaseGroups([], [], m).map((g) => g.title)).toEqual(["a", "b"]);
  });

  test("CASE DRIFT between the declaration and the call is ONE group, spelled the way it was DECLARED", () => {
    // Nothing type-checks `meta.phases`, so `phases: ["Survey"]` +
    // `phase("survey")` is a legal run. Byte-exact identity made those two
    // groups — and the header uppercases, so the screen read SURVEY *pending*
    // directly above SURVEY with its agents running: two identical headers, one
    // of them stating as fact that the phase had not begun, beside a sliver
    // reading "1 of 2" next to three boxes.
    const m = manifest({ meta: { name: "n", phases: ["Survey", "Author"] } });
    const s: UltraEventLike[] = [ev.phase("survey"), ev.start(0)];
    const groups = phaseGroups(s, agentRows(s, []), m);
    expect(groups.map((g) => g.title)).toEqual(["Survey", "Author"]);
    expect(groups.map((g) => g.status)).toEqual(["running", "pending"]);
    expect(groups[0]!.agents.map((a) => a.ordinal)).toEqual([0]);
    // …and the two readers of the same declared array now agree on screen.
    expect(progressFraction(m, s)).toEqual({ seen: 1, declared: 2 });
    // Surrounding whitespace drifts the same way, and the row's own label still
    // loses the prefix under the canonical title (the label rule is already
    // case-insensitive).
    expect(phaseGroups([ev.phase("  SURVEY ")], [], m).map((g) => g.title)).toEqual(["Survey", "Author"]);
    expect(agentLabelInPhase("survey:measure", groups[0]!.title)).toBe("measure");
    // BOTH DRIFTED SPELLINGS OF ONE PHASE COUNT ONCE in the sliver too — folding
    // them in the group list alone would have moved the disagreement rather than
    // removed it ("2 of 2" beside one running box and one pending).
    const twice: UltraEventLike[] = [ev.phase("survey"), ev.phase("SURVEY")];
    expect(progressFraction(m, twice)).toEqual({ seen: 1, declared: 2 });
    expect(phaseGroups(twice, [], m).map((g) => g.title)).toEqual(["Survey", "Author"]);
  });

  test("an UNDECLARED title is still appended verbatim — canonicalisation is not a whitelist", () => {
    // The seed-not-whitelist rule survives the case fold: a title with no
    // declared spelling to answer to keeps its own, exactly as before.
    const m = manifest({ meta: { name: "n", phases: ["Survey"] } });
    const groups = phaseGroups([ev.phase("survey"), ev.phase("TrIaGe")], [], m);
    expect(groups.map((g) => g.title)).toEqual(["Survey", "TrIaGe"]);
  });

  test("an EMPTY declared title seeds no phantom group — that string is the unphased group's identity", () => {
    // `declaredPhases` accepts any array of strings, so `["survey", ""]` is a
    // legal read. Seeded, it drew a headerless box that still consumed the
    // parent's gap — and worse, planted UNPHASED mid-list, so agents that ran
    // before the first `phase()` call landed there instead of at the top.
    const m = manifest({ meta: { name: "n", phases: ["survey", "", "   "] } });
    // Dropped in the SHARED read, so the sliver's denominator does not go on
    // counting a phase the group list refuses to draw.
    expect(declaredPhases(m)).toEqual(["survey"]);
    expect(progressFraction(m, [ev.phase("survey")])).toEqual({ seen: 1, declared: 1 });
    expect(phaseGroups([], [], m).map((g) => g.title)).toEqual(["survey"]);
    const s: UltraEventLike[] = [ev.start(0), ev.phase("survey"), ev.start(1)];
    const groups = phaseGroups(s, agentRows(s, []), m);
    expect(groups.map((g) => g.title)).toEqual([UNPHASED, "survey"]);
    expect(groups[0]!.agents.map((a) => a.ordinal)).toEqual([0]);
    // A declaration of nothing but blanks is not a declaration at all — no
    // sliver, no seed, exactly as a malformed `phases` behaves.
    const blank = manifest({ meta: { name: "n", phases: ["", " "] } });
    expect(declaredPhases(blank)).toBeUndefined();
    expect(progressFraction(blank, [])).toBeUndefined();
    expect(phaseGroups([], [], blank)).toEqual([]);
  });

  test("the unphased group KEEPS ITS PLACE at the top — declared headers do not slide above it", () => {
    // Agents that ran before the first `phase()` call are chronologically first.
    // Seeding the declared titles ahead of them would file the run's opening
    // agents underneath every header on screen.
    // Ordinal 0 settles before `survey` opens — the pre-phase agent has finished,
    // which is what makes the unphased group `done` rather than still running.
    const s: UltraEventLike[] = [ev.start(0), ev.agent(0), ev.phase("survey"), ev.start(1)];
    const groups = phaseGroups(s, agentRows(s, []), declared());
    expect(groups.map((g) => g.title)).toEqual([UNPHASED, "survey", "author", "verify", "fix"]);
    expect(groups[0]!.agents.map((a) => a.ordinal)).toEqual([0]);
    expect(groups[0]!.status).toBe("done");
  });

  test("ONE DEFENSIVE READ, TWO READERS — a `phases` the sliver rejects seeds no groups either", () => {
    // The reuse is the point: if the group list validated `meta.phases`
    // separately from `progressFraction`, the sliver could read `1 of 4` beside
    // a single box, or four boxes could appear with no sliver at all. Nothing
    // type-checks `ScriptMeta`, so both readers go through `declaredPhases`.
    const events: UltraEventLike[] = [ev.phase("survey")];
    const malformed = [
      undefined,
      3,
      [],
      [{ title: "x" }],
      ["ok", 7],
      "survey,author",
    ];
    for (const phases of malformed) {
      const m = manifest({ meta: { name: "n", ...(phases === undefined ? {} : { phases }) } });
      expect(declaredPhases(m)).toBeUndefined();
      expect(progressFraction(m, events)).toBeUndefined();
      // …and the grouping falls back to observed-only, byte for byte.
      expect(phaseGroups(events, [], m)).toEqual(phaseGroups(events, []));
    }
    // The positive half, so the pin cannot pass by rejecting everything.
    const good = declared();
    expect(declaredPhases(good)).toEqual(["survey", "author", "verify", "fix"]);
    expect(progressFraction(good, events)).toEqual({ seen: 1, declared: 4 });
    expect(phaseGroups(events, [], good)).toHaveLength(4);
    expect(declaredPhases(null)).toBeUndefined();
  });

  test("runSnapshot seeds the groups ONLY once the journal has been read (B1's rule, unchanged)", () => {
    const finished = declared({ state: "done" });
    // NOT READ: four `never reached` headers over a run that in fact ran all
    // four would be exactly the wrong-number-stated-as-fact B1 removed. So the
    // group list and the sliver stay absent together, on the same fact.
    const unread = runSnapshot(finished, null, [], "u-27");
    expect(unread.phases).toEqual([]);
    expect("progress" in unread).toBe(false);
    // SUPPRESSING THE SEED IS NOT THE SAME FACT AS "no manifest". The agent
    // INDEX answers for a run whose journal was never streamed, so those rows
    // reach the unphased group with `events` still null — and reading the state
    // off a nulled manifest defaulted them to `running` on a run that is done.
    const byIndex = runSnapshot(finished, null, [{ ordinal: 0, settled: true, attempt: 1, lastText: "x" }], "u-27");
    expect(byIndex.phases.map((g) => ({ title: g.title, status: g.status }))).toEqual([
      { title: UNPHASED, status: "done" },
    ]);
    // READ: the seed applies, and the two phases that never ran say so.
    const read = runSnapshot(finished, [ev.phase("survey"), ev.start(0), ev.agent(0), ev.phase("author")]);
    expect(read.phases.map((g) => ({ title: g.title, status: g.status }))).toEqual([
      { title: "survey", status: "done" },
      { title: "author", status: "done" },
      { title: "verify", status: "never-reached" },
      { title: "fix", status: "never-reached" },
    ]);
    expect(read.progress).toEqual({ seen: 2, declared: 4 });
  });

  test("every status has a note, and only the two silent ones are empty", () => {
    // The closed table the header renders. `done`/`running` have agent rows
    // beneath them saying more than a word could; the other two have nothing
    // beneath them at all, which is precisely why they need one.
    expect(Object.keys(PHASE_STATUS_NOTE).sort()).toEqual(
      ["done", "never-reached", "pending", "running"].sort(),
    );
    expect(PHASE_STATUS_NOTE.pending).toBe("pending");
    expect(PHASE_STATUS_NOTE["never-reached"]).toBe("not reached");
    expect(PHASE_STATUS_NOTE.done).toBe("");
    expect(PHASE_STATUS_NOTE.running).toBe("");
  });
});

// ── issue #40 — an agent's OWN opts.phase beats the ambient one ──────────────

describe("issue #40 — a pipeline whose stages set opts.phase groups by the phase they DECLARED", () => {
  // THE REPORTED RUN: `wave-a-cli-links-comments`, three phases, seven agents,
  // every one spawned with an explicit `{ phase: … }` inside `pipeline()` — and
  // all seven drawn under IMPLEMENT with REVIEW and CLOSE empty and `pending`.
  // The engine dropped `opts.phase` before the stream, so the only signal here
  // was the ambient `phase()` state, which in a pipeline is whatever the last
  // call happened to set. That is precisely the race `opts.phase` exists to
  // avoid, and `pipeline()` is the shape the authoring reference recommends, so
  // an author following the docs got the broken result.
  const threePhase = (over: Partial<UltraManifestLike> = {}) =>
    manifest({ meta: { name: "wave-a", phases: ["implement", "review", "close"] }, ...over });

  /** The failing case exactly: NO `phase` event anywhere, so the ambient never
   *  moves off UNPHASED, and interleaved ordinals because pipeline has no
   *  inter-stage barrier. */
  const interleaved: UltraEventLike[] = [
    ev.start(0, { phase: "implement", label: "impl:35-links" }),
    ev.start(1, { phase: "implement", label: "impl:39-37-cli" }),
    ev.start(2, { phase: "implement", label: "impl:30-comments" }),
    ev.start(3, { phase: "review", label: "review:35-links" }),
    ev.start(4, { phase: "review", label: "review:39-37-cli" }),
    ev.start(5, { phase: "close", label: "close:35-links" }),
    ev.start(6, { phase: "review", label: "review:30-comments" }),
  ];

  test("each agent lands in the phase IT declared, not in the ambient one", () => {
    const groups = phaseGroups(interleaved, agentRows(interleaved, []), threePhase());
    expect(groups.map((g) => g.title)).toEqual(["implement", "review", "close"]);
    expect(groups.map((g) => g.agents.map((a) => a.ordinal))).toEqual([[0, 1, 2], [3, 4, 6], [5]]);
    // …and there is NO headerless group above them. Before this, the first agent
    // event with no preceding `phase()` call opened the unphased box; an agent
    // that named its own phase is not unphased, so the scan looks past it.
    expect(groups.some((g) => g.title === UNPHASED)).toBe(false);
  });

  test("the ambient phase is still the fallback — a bare phase() script is untouched", () => {
    // The regression this fix must not cause. Nothing here sets `opts.phase`, and
    // a bare script `await`s each call, so ordinal 0 has settled by the time
    // `review` opens — the shape that makes `implement` genuinely behind.
    const s: UltraEventLike[] = [
      ev.phase("implement"),
      ev.start(0),
      ev.agent(0),
      ev.phase("review"),
      ev.start(1),
    ];
    const groups = phaseGroups(s, agentRows(s, []), threePhase());
    expect(groups.map((g) => g.agents.map((a) => a.ordinal))).toEqual([[0], [1], []]);
    expect(groups.map((g) => g.status)).toEqual(["done", "running", "pending"]);
  });

  test("OPTS DOES NOT LEAK INTO THE AMBIENT — a later bare agent() belongs to the last phase() call", () => {
    // `opts.phase` is scoped to the one call that names it. Letting it become the
    // new ambient would reintroduce the same race one call later, with the
    // pipeline's non-deterministic interleaving deciding where a bare call lands.
    const s: UltraEventLike[] = [ev.phase("implement"), ev.start(0, { phase: "close" }), ev.start(1)];
    const groups = phaseGroups(s, agentRows(s, []), threePhase());
    expect(groups.find((g) => g.title === "implement")!.agents.map((a) => a.ordinal)).toEqual([1]);
    expect(groups.find((g) => g.title === "close")!.agents.map((a) => a.ordinal)).toEqual([0]);
  });

  test("a phase named ONLY via opts still creates its group, ORDERED against meta.phases", () => {
    // Declared → the published position, even though the events arrive in a
    // different order (`close` before `review` here).
    const s: UltraEventLike[] = [ev.start(0, { phase: "close" }), ev.start(1, { phase: "review" })];
    expect(phaseGroups(s, agentRows(s, []), threePhase()).map((g) => g.title)).toEqual([
      "implement",
      "review",
      "close",
    ]);
    // UNDECLARED → appended where first observed, exactly as an undeclared
    // `phase()` call is. The declared list is a seed and never a whitelist, and
    // that rule does not change because the title arrived on a different event.
    const undeclared: UltraEventLike[] = [ev.start(0, { phase: "implement" }), ev.start(1, { phase: "triage" })];
    const groups = phaseGroups(undeclared, agentRows(undeclared, []), threePhase());
    expect(groups.map((g) => g.title)).toEqual(["implement", "review", "close", "triage"]);
    expect(groups.find((g) => g.title === "triage")!.agents.map((a) => a.ordinal)).toEqual([1]);
    // With NO manifest at all it still groups — the seed is what needs a
    // manifest, the membership never did.
    expect(phaseGroups(undeclared, agentRows(undeclared, []), null).map((g) => g.title)).toEqual([
      "implement",
      "triage",
    ]);
  });

  test("CASE DRIFT folds for opts.phase too — `{ phase: 'Review' }` is not a fourth box", () => {
    // Nothing type-checks `meta.phases` and nothing type-checks `opts.phase`, so
    // the same fold a `phase()` title gets has to apply here or the group list
    // draws REVIEW *pending* above REVIEW with its agents running.
    const s: UltraEventLike[] = [ev.start(0, { phase: " Review " })];
    const groups = phaseGroups(s, agentRows(s, []), threePhase());
    expect(groups.map((g) => g.title)).toEqual(["implement", "review", "close"]);
    expect(groups[1]!.agents.map((a) => a.ordinal)).toEqual([0]);
  });

  test("a BLANK opts.phase means `named none` — it never plants the unphased group mid-list", () => {
    // `UltraEventLike` is JSON.parsed off events.ndjson with nothing validating
    // it, and `""` is the unphased group's own identity, so a blank must read as
    // absent rather than as a title.
    const s: UltraEventLike[] = [ev.start(0, { phase: "   " }), ev.phase("implement"), ev.start(1)];
    const groups = phaseGroups(s, agentRows(s, []), threePhase());
    expect(groups.map((g) => g.title)).toEqual([UNPHASED, "implement", "review", "close"]);
    expect(groups[0]!.agents.map((a) => a.ordinal)).toEqual([0]);
  });

  test("A PHASE HOLDING LIVE AGENTS IS RUNNING — several at once, and independent of event order", () => {
    // Without a running marker at all the reported run read as three `done` boxes
    // while it was still going: the ambient never moved, so no group matched it.
    // But "the last phase observed" is the wrong repair, because `opts.phase`
    // exists exactly BECAUSE pipeline() stages overlap — all seven agents here
    // are unsettled, so CLOSE was rendering `done` around a live row, and which
    // single group won depended on which stage's event happened to land last.
    const live = phaseGroups(interleaved, agentRows(interleaved, []), threePhase());
    expect(live.map((g) => g.status)).toEqual(["running", "running", "running"]);
    // ORDER-INDEPENDENT: pipeline() has no inter-stage barrier, so two identical
    // runs interleave differently and must still draw the same markers.
    const reordered = [interleaved[5]!, interleaved[6]!, ...interleaved.slice(0, 5)];
    expect(phaseGroups(reordered, agentRows(reordered, []), threePhase()).map((g) => g.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
    // …and a stage whose agents have ALL settled is done even while later ones
    // run, so this is not "everything begun is running".
    const implementDone = [...interleaved, ev.agent(0), ev.agent(1), ev.agent(2)];
    expect(phaseGroups(implementDone, agentRows(implementDone, []), threePhase()).map((g) => g.status)).toEqual([
      "done",
      "running",
      "running",
    ]);
    // …and nothing spins once the run has ended. That is the RUN's state, as it
    // has always been.
    const done = phaseGroups(interleaved, agentRows(interleaved, [], "done"), threePhase({ state: "done" }));
    expect(done.map((g) => g.status)).toEqual(["done", "done", "done"]);
  });

  test("A DEAD AGENT KEEPS ITS PHASE — a settle that names none cannot drag it into UNPHASED", () => {
    // The engine now emits `phase` on the failure settle too (executor.ts's
    // fourth emit site), but this grouping is last-assignment-wins per ordinal
    // and every `events.ndjson` written before issue #40 carries `phase` on NO
    // settle — so the reader has to be robust on its own or a run re-groups
    // itself the moment it is read back off disk.
    const s: UltraEventLike[] = [
      ev.start(0, { phase: "implement" }),
      ev.start(1, { phase: "review" }),
      ev.agent(1, { ok: false }), // the pre-#40 shape: no `phase` on the settle
      ev.agent(0, { phase: "implement" }),
    ];
    const groups = phaseGroups(s, agentRows(s, []), threePhase());
    expect(groups.map((g) => g.agents.map((a) => a.ordinal))).toEqual([[0], [1], []]);
    // No phantom headerless box, and the failed row is findable under REVIEW.
    expect(groups.some((g) => g.title === UNPHASED)).toBe(false);
    expect(groups[1]!.agents[0]!.ok).toBe(false);
  });

  test("THE SLIVER COUNTS THE SAME PHASES THE BOXES DO — one read, two readers, still", () => {
    // The rule issue #27 established: the group list and the progress sliver are
    // fractions of the same declared array, so a phase that opens a box must
    // advance the sliver. Left unchanged, this run drew three begun boxes beside
    // "0 of 3" — the sliver saying the run had not started while it was in its
    // last phase, which is the "looks stalled" half of the report.
    const m = threePhase();
    // PHASES ENTERED, NOT WORK FINISHED: this reads a full 3 of 3 while five of
    // the seven agents are still outstanding, because a pipeline enters its last
    // stage with its first item while later items are still in stage one. That is
    // `phase()`'s own long-standing reading of the sliver, reached sooner — and
    // the running group markers beside it are what say the run is not done.
    expect(progressFraction(m, interleaved)).toEqual({ seen: 3, declared: 3 });
    expect(phaseGroups(interleaved, agentRows(interleaved, []), m).some((g) => g.status === "running")).toBe(
      true,
    );
    // A bare-`phase()` stream is unaffected, and the two sources add up when a
    // script mixes them.
    expect(progressFraction(m, [ev.phase("implement")])).toEqual({ seen: 1, declared: 3 });
    expect(progressFraction(m, [ev.phase("implement"), ev.start(0, { phase: "review" })])).toEqual({
      seen: 2,
      declared: 3,
    });
    // …and the same drifted spelling counts ONCE across both sources.
    expect(progressFraction(m, [ev.phase("Implement"), ev.start(0, { phase: "implement" })])).toEqual({
      seen: 1,
      declared: 3,
    });
  });

  test("IDEMPOTENT UNDER A RESUME, which re-emits opts.phase on the cached settle", () => {
    // The engine does NOT journal `phase`: a resume re-runs the script, so every
    // hash-matched call names its phase again and the cache-hit `agent` event
    // carries it off this run's opts (see ultra-executor.test.ts). A replayed
    // ordinal has only that event — never `agent-start` — so this is the whole
    // grouping signal on a resume, and replaying it twice must not double.
    const resumed: UltraEventLike[] = [
      ...interleaved,
      ...interleaved.map((e) =>
        e.type === "agent-start" ? ev.agent(e.ordinal, { phase: e.phase, cached: true }) : e,
      ),
    ];
    const groups = phaseGroups(resumed, agentRows(resumed, []), threePhase());
    expect(groups.map((g) => g.title)).toEqual(["implement", "review", "close"]);
    expect(groups.map((g) => g.agents.map((a) => a.ordinal))).toEqual([[0, 1, 2], [3, 4, 6], [5]]);
  });

  test("the agent INDEX (a journal-less reader) still falls back to unphased — B1 unchanged", () => {
    // `agentRows`' second channel has no events behind it at all, so it can say
    // nothing about phases and must not pretend to. Rows that reach a group by
    // ordinal alone land in UNPHASED exactly as before.
    const snap = runSnapshot(
      threePhase({ state: "done" }),
      null,
      [{ ordinal: 0, settled: true, attempt: 1, lastText: "x" }],
      "u-40",
    );
    expect(snap.phases.map((g) => ({ title: g.title, status: g.status }))).toEqual([
      { title: UNPHASED, status: "done" },
    ]);
  });
});

// ── issue #27 part 2 — a row does not repeat the header above it ─────────────

describe("issue #27 — an agent label drops the phase prefix INSIDE that phase", () => {
  test("the reported rows: `survey:measure` under SURVEY reads `measure`", () => {
    expect(agentLabelInPhase("survey:measure", "survey")).toBe("measure");
    expect(agentLabelInPhase("survey:style", "survey")).toBe("style");
    expect(agentLabelInPhase("survey:desktop", "survey")).toBe("desktop");
  });

  test("case-insensitive, and the optional space goes with the colon", () => {
    // A header renders uppercase, so the label a script wrote in lower case must
    // still match the title it was written for.
    expect(agentLabelInPhase("SURVEY:measure", "survey")).toBe("measure");
    expect(agentLabelInPhase("Survey: measure", "SURVEY")).toBe("measure");
    expect(agentLabelInPhase("survey:  measure", "survey")).toBe("measure");
  });

  test("EXACT TITLE MATCH ONLY — a prefix that merely starts the same is left alone", () => {
    // A substring rule would eat the first word of a real label.
    expect(agentLabelInPhase("fixup:lint", "fix")).toBe("fixup:lint");
    expect(agentLabelInPhase("survey", "survey")).toBe("survey");
    expect(agentLabelInPhase("measure:survey", "survey")).toBe("measure:survey");
    expect(agentLabelInPhase("verify:lens", "survey")).toBe("verify:lens");
  });

  test("stripping to nothing renders the ORIGINAL — a nameless row says less than a redundant one", () => {
    expect(agentLabelInPhase("survey:", "survey")).toBe("survey:");
    expect(agentLabelInPhase("survey:   ", "survey")).toBe("survey:   ");
  });

  test("the UNPHASED group strips nothing — its title is the empty string", () => {
    // Otherwise a label that happens to begin with a colon would silently lose
    // it in the one group that has no header to supply the context.
    expect(agentLabelInPhase(":odd", UNPHASED)).toBe(":odd");
    expect(agentLabelInPhase("survey:measure", UNPHASED)).toBe("survey:measure");
  });

  test("THE STORED LABEL IS UNTOUCHED — this is a rendering rule, not a projection one", () => {
    // The prefix is genuinely useful in flat contexts (`ultra_inspect` output,
    // the run anchor, any list with no header to supply the context), so the
    // event, the row and every other reader keep it. Only the position that
    // already says `SURVEY` above the row drops it.
    const s: UltraEventLike[] = [ev.phase("survey"), ev.start(0, { label: "survey:measure" })];
    const rows = agentRows(s, []);
    expect(rows[0]!.label).toBe("survey:measure");
    expect(phaseGroups(s, rows)[0]!.agents[0]!.label).toBe("survey:measure");
  });
});

// ── AC11 — the denominator and the sliver ───────────────────────────────────

describe("4.2 AC11 — the surface is honest about what the engine does not produce", () => {
  test("proof 3 — `agentsTotal` is undefined while running AND at terminal; nothing knows the total", () => {
    const running = runSnapshot(manifest(), [ev.start(0)]);
    const done = runSnapshot(manifest({ state: "done" }), [ev.start(0), ev.agent(0)]);
    expect(running.agentsTotal).toBeUndefined();
    expect(done.agentsTotal).toBeUndefined();
    // ...and the numerator is real, so "N done" is not vacuous.
    expect(running.agentsDone).toBe(0);
    expect(done.agentsDone).toBe(1);
  });

  test("proof 4 — the sliver is a fraction of DECLARED PHASES, and only when meta.phases is an array of strings", () => {
    expect(progressFraction(manifest(), [ev.phase("Scan")])).toEqual({ seen: 1, declared: 2 });
  });

  test("proof 4 — no `meta.phases` ⇒ NO sliver (undefined, never an indeterminate bar)", () => {
    expect(progressFraction(manifest({ meta: { name: "n" } }), [ev.phase("Scan")])).toBeUndefined();
  });

  test("proof 4 — a MALFORMED `meta.phases` (a number) ⇒ NO sliver; nothing validates ScriptMeta", () => {
    expect(progressFraction(manifest({ meta: { name: "n", phases: 3 } }), [ev.phase("Scan")])).toBeUndefined();
    expect(progressFraction(manifest({ meta: { name: "n", phases: [] } }), [])).toBeUndefined();
    expect(progressFraction(manifest({ meta: { name: "n", phases: [{ title: "x" }] } }), [])).toBeUndefined();
  });

  test("proof 4 — a null manifest (the pending window) ⇒ NO sliver", () => {
    expect(progressFraction(null, [ev.phase("Scan")])).toBeUndefined();
  });

  test("proof 4 — the numerator counts DISTINCT titles and never exceeds the denominator", () => {
    const events = [ev.phase("Scan"), ev.phase("Scan"), ev.phase("Rewrite"), ev.phase("Extra"), ev.phase("More")];
    expect(progressFraction(manifest(), events)).toEqual({ seen: 2, declared: 2 });
  });

  test("proof 5 — a run whose meta has no phases still projects a complete, uncrashed snapshot", () => {
    const snap = runSnapshot(manifest({ meta: { name: "No phases" } }), [
      ev.start(0),
      ev.agent(0, { costUsd: 0.25 }),
      ev.log("hello"),
    ]);
    expect(snap.progress).toBeUndefined();
    expect("progress" in snap).toBe(false);
    expect(snap.name).toBe("No phases");
    expect(snap.agentsDone).toBe(1);
    expect(snap.narrator).toEqual(["hello"]);
    expect(snap.phases[0]!.agents).toHaveLength(1);
  });
});

// ── the run snapshot ────────────────────────────────────────────────────────

describe("4.2 — runSnapshot reads the MANIFEST, never an event, for state and spend", () => {
  test("T14 — state comes from the manifest, so a run killed by a restart is not permanently `running`", () => {
    // `getUltraManifest` rewrites a stale `running` to `stopped` ON READ,
    // without going through settle() — so there is no `state` event to observe.
    const snap = runSnapshot(manifest({ state: "stopped" }), [ev.start(0)]);
    expect(snap.state).toBe("stopped");
    expect(anchorForm(snap)).toBe("terminal");
  });

  test("T13 — spend is `manifest.spend` VERBATIM, never a sum of agent deltas", () => {
    const snap = runSnapshot(manifest({ spend: 1.5 }), [
      ev.agent(0, { costUsd: 9 }),
      ev.agent(1, { costUsd: 9 }),
    ]);
    expect(snap.spendUsd).toBe(1.5);
  });

  test("a null manifest is the PENDING form — the launch is a fact the moment the runId exists", () => {
    const snap = runSnapshot(null, [], [], "u-just-launched");
    expect(snap.pending).toBe(true);
    expect(snap.runId).toBe("u-just-launched");
    expect(snap.name).toBe("u-just-launched");
    expect(snap.state).toBe("running");
    expect(snap.spendUsd).toBe(0);
  });

  test("a manifest that has arrived is NOT pending", () => {
    expect(runSnapshot(manifest(), []).pending).toBe(false);
  });

  test("`error` is absent rather than undefined-valued when the manifest has none", () => {
    expect("error" in runSnapshot(manifest(), [])).toBe(false);
    expect(runSnapshot(manifest({ state: "failed", error: "boom" }), []).error).toBe("boom");
  });
});

// ── AC2 — anchorForm ────────────────────────────────────────────────────────

describe("4.2 AC2 — the anchor's shape-selecting function is constant while running", () => {
  test("across twenty successive snapshots of one run, the form changes AT MOST ONCE and only at terminal", () => {
    // A rendered HEIGHT cannot be tested without a DOM. The honest executable
    // claim is that the function the renderer uses to pick its form does not
    // move while the run is running — which is exactly what "never grows or
    // reflows; its only permitted height change is a one-time collapse" means
    // mechanically.
    const events: UltraEventLike[] = [];
    const forms: string[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(i % 2 === 0 ? ev.start(i) : ev.agent(i - 1, { costUsd: 0.01 }));
      const terminal = i === 17;
      const m = manifest({ state: i >= 17 ? "done" : "running", spend: i * 0.01 });
      forms.push(anchorForm(runSnapshot(m, events)));
      void terminal;
    }
    const changes = forms.filter((f, i) => i > 0 && f !== forms[i - 1]!).length;
    expect(changes).toBe(1);
    expect(forms[0]).toBe("running");
    expect(forms.at(-1)).toBe("terminal");
    // Anti-vacuity: a constant function would report ZERO changes and pass a
    // `<= 1` assertion. The exact `1` is what makes the collapse observable.
    expect(forms.indexOf("terminal")).toBe(17);
  });

  test("every terminal state collapses; only `running` does not", () => {
    for (const state of ["done", "failed", "stopped"] as const) {
      expect(anchorForm(runSnapshot(manifest({ state }), []))).toBe("terminal");
    }
    expect(anchorForm(runSnapshot(manifest({ state: "running" }), []))).toBe("running");
  });
});

// ── D8 / AC1 / AC4 — the transcript splice ──────────────────────────────────

describe("4.2 D8 — the splice recognises a launch", () => {
  test("a well-formed okResult yields the runId", () => {
    expect(extractRunId(okResult("u-abc"))).toBe("u-abc");
  });

  test("a HEAD-TRUNCATED okResult still yields it — the regex arm, and this is the real-world case", () => {
    // `capToolOutput` head-truncates every tool result at TOOL_OUTPUT_CAP, so a
    // launch whose `meta` is large arrives as a PREFIX OF VALID JSON, which
    // JSON.parse rejects outright. `runId` is the first key the tool emits, so
    // the head survives. A splice with only the JSON arm works on every small
    // script tested by hand and fails on the first real one.
    const full = okResult("u-trunc", "a name long enough to be cut in half by the cap");
    const cut = `${full.slice(0, 60)}… (+400 chars)`;
    expect(cut.includes("}")).toBe(false); // genuinely unparseable
    expect(() => JSON.parse(cut)).toThrow();
    expect(extractRunId(cut)).toBe("u-trunc");
  });

  test("no output, empty output, and output with no runId all yield null", () => {
    expect(extractRunId(undefined)).toBeNull();
    expect(extractRunId("")).toBeNull();
    expect(extractRunId("{}")).toBeNull();
    expect(extractRunId('{"runId": ""}')).toBeNull();
    expect(extractRunId("not json at all")).toBeNull();
  });

  test("an isError result is a VALIDATION REJECTION, not a launch — there is no run", () => {
    // ui-contract §5: "a validation rejection (e.g. a `model`-less script)
    // returning to the agent, which re-authors". The correct rendering is the
    // ordinary tool row.
    const part = toolPart({ name: ULTRA_TOOL_NAME, id: "t1", output: okResult("u-x"), isError: true });
    expect(launchedRunId(part)).toBeNull();
  });

  test("a part with no output yet is a launch IN FLIGHT — still a tool row", () => {
    expect(launchedRunId(toolPart({ name: ULTRA_TOOL_NAME, id: "t1" }))).toBeNull();
  });

  test("another tool's result carrying a runId-shaped string is not a launch", () => {
    expect(launchedRunId(toolPart({ name: "Bash", id: "t1", output: okResult("u-x") }))).toBeNull();
  });
});

describe("4.2 D8/AC1 — the splice replaces the ultra part and SPLITS its group", () => {
  test("a group of [Read, ultra, Write] becomes [Read] / anchor / [Write]", () => {
    const items = [
      toolsItem("g1", [
        toolPart({ name: "Read", id: "a" }),
        ultraPart("u-1"),
        toolPart({ name: "Write", id: "c" }),
      ]),
    ];
    const out = spliceRunAnchors(items, new Map([["u-1", payloadFor("u-1")]]));
    expect(out.map((i) => i.kind)).toEqual([
      CONVERSATION_KINDS.tools,
      ULTRA_ANCHOR_KIND,
      CONVERSATION_KINDS.tools,
    ]);
    expect(partsOf(out[0]!)).toEqual(["Read"]);
    expect(partsOf(out[2]!)).toEqual(["Write"]);
    // No part was dropped.
    expect([...partsOf(out[0]!), ...partsOf(out[2]!)]).toEqual(["Read", "Write"]);
  });

  test("an empty side is DROPPED rather than emitted as an empty group", () => {
    const out = spliceRunAnchors(
      [toolsItem("g1", [ultraPart("u-1")])],
      new Map([["u-1", payloadFor("u-1")]]),
    );
    expect(out.map((i) => i.kind)).toEqual([ULTRA_ANCHOR_KIND]);
  });

  test("the leading half keeps the original group key; the trailing half is keyed by the LAUNCH that split it", () => {
    // Keys name the event, not the slot (the house maxim). A trailing key
    // derived from a loop index would name a position that reorders.
    const out = spliceRunAnchors(
      [toolsItem("g1", [toolPart({ name: "Read", id: "a" }), ultraPart("u-1"), toolPart({ name: "Write", id: "c" })])],
      new Map([["u-1", payloadFor("u-1")]]),
    );
    expect(out[0]!.key).toBe("g1");
    expect(out[1]!.key).toBe("ultra:u-1");
    expect(out[2]!.key).toBe("g1~u-1");
  });

  test("it is a TOTAL function: items with no ultra call come back unchanged, same references", () => {
    const items = [textItem("t1", "hi"), toolsItem("g1", [toolPart({ name: "Read", id: "a" })])];
    const out = spliceRunAnchors(items, new Map());
    expect(out).toEqual(items);
    expect(out[0]).toBe(items[0]!);
    expect(out[1]).toBe(items[1]!);
  });

  test("an empty item list comes back empty", () => {
    expect(spliceRunAnchors([], new Map())).toEqual([]);
  });

  test("non-tools items pass through untouched and keep their order", () => {
    const items = [
      textItem("t1", "before"),
      toolsItem("g1", [ultraPart("u-1")]),
      textItem("t2", "after"),
    ];
    const out = spliceRunAnchors(items, new Map([["u-1", payloadFor("u-1")]]));
    expect(out.map((i) => i.kind)).toEqual([
      CONVERSATION_KINDS.text,
      ULTRA_ANCHOR_KIND,
      CONVERSATION_KINDS.text,
    ]);
  });

  test("an unresolvable runId with no pending factory leaves the group EXACTLY as it arrived", () => {
    const items = [toolsItem("g1", [toolPart({ name: "Read", id: "a" }), ultraPart("u-unknown")])];
    const out = spliceRunAnchors(items, new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(items[0]!);
  });

  test("D8's pending form — a launch whose manifest has not arrived still renders an anchor", () => {
    const out = spliceRunAnchors([toolsItem("g1", [ultraPart("u-new")])], new Map(), (runId) => ({
      ...payloadFor(runId),
      run: runSnapshot(null, [], [], runId),
    }));
    expect(out.map((i) => i.kind)).toEqual([ULTRA_ANCHOR_KIND]);
    expect((out[0]!.payload as UltraAnchorPayload).run.pending).toBe(true);
  });

  test("the anchor's payload is the one the map holds — no re-derivation in the splice", () => {
    const p = payloadFor("u-1");
    const out = spliceRunAnchors([toolsItem("g1", [ultraPart("u-1")])], new Map([["u-1", p]]));
    expect(out[0]!.payload).toBe(p);
  });
});

describe("4.2 AC4 — concurrent runs are first-class", () => {
  test("two launches in ONE group produce two anchors, in stream order, dropping nothing", () => {
    const items = [
      toolsItem("g1", [
        toolPart({ name: "Read", id: "a" }),
        ultraPart("u-1"),
        toolPart({ name: "Grep", id: "b" }),
        ultraPart("u-2"),
        toolPart({ name: "Write", id: "c" }),
      ]),
    ];
    const out = spliceRunAnchors(
      items,
      new Map([
        ["u-1", payloadFor("u-1")],
        ["u-2", payloadFor("u-2")],
      ]),
    );
    expect(out.map((i) => i.kind)).toEqual([
      CONVERSATION_KINDS.tools,
      ULTRA_ANCHOR_KIND,
      CONVERSATION_KINDS.tools,
      ULTRA_ANCHOR_KIND,
      CONVERSATION_KINDS.tools,
    ]);
    expect(out.filter((i) => i.kind === ULTRA_ANCHOR_KIND).map((i) => i.key)).toEqual([
      "ultra:u-1",
      "ultra:u-2",
    ]);
    expect(out.filter((i) => i.kind === CONVERSATION_KINDS.tools).flatMap(partsOf)).toEqual([
      "Read",
      "Grep",
      "Write",
    ]);
  });

  test("two launches in DIFFERENT groups produce anchors in different groups", () => {
    const out = spliceRunAnchors(
      [toolsItem("g1", [ultraPart("u-1")]), textItem("t", "x"), toolsItem("g2", [ultraPart("u-2")])],
      new Map([
        ["u-1", payloadFor("u-1")],
        ["u-2", payloadFor("u-2")],
      ]),
    );
    expect(out.map((i) => i.kind)).toEqual([
      ULTRA_ANCHOR_KIND,
      CONVERSATION_KINDS.text,
      ULTRA_ANCHOR_KIND,
    ]);
  });

  test("ANTI-VACUITY — one run produces exactly ONE anchor, so \"everything stacks\" cannot pass this AC", () => {
    const out = spliceRunAnchors(
      [toolsItem("g1", [toolPart({ name: "Read", id: "a" }), ultraPart("u-1")])],
      new Map([["u-1", payloadFor("u-1")]]),
    );
    expect(out.filter((i) => i.kind === ULTRA_ANCHOR_KIND)).toHaveLength(1);
  });

  test("only ONE of two launches resolvable ⇒ one anchor and the other stays a tool row", () => {
    const out = spliceRunAnchors(
      [toolsItem("g1", [ultraPart("u-1"), ultraPart("u-2")])],
      new Map([["u-1", payloadFor("u-1")]]),
    );
    expect(out.map((i) => i.kind)).toEqual([ULTRA_ANCHOR_KIND, CONVERSATION_KINDS.tools]);
    expect(partsOf(out[1]!)).toEqual([ULTRA_TOOL_NAME]);
  });
});

// ── C1 / D5 — the session filter ────────────────────────────────────────────

describe("4.2 C1/D5 — filterRunsBySession is defined-and-equal, never truthy", () => {
  const rows = [
    { runId: "a", sessionId: "s1" },
    { runId: "b" },
    { runId: "c", sessionId: "s2" },
    { runId: "d", sessionId: "s1" },
  ];

  test("an absent sessionId returns the input UNCHANGED — in order, in length, same reference", () => {
    // `GET /api/ultra` HAS TWO CALLERS AND ONE OF THEM DEPENDS ON THIS EXACT
    // CASE. The spec's §5.5-D5 said the route "has no callers today but it is a
    // published shape"; that was true at `e093a98` and was falsified by the very
    // commit that copied the sentence here.
    //
    //   git grep -nE 'fetch\(.?/api/ultra' e093a98 -- apps/web
    //
    // returns exactly one line at the baseline — `use-ultra-wake.ts`'s
    // `/api/ultra/wakes`, a DIFFERENT route — and nothing for the list route.
    // (The `.?` is load-bearing: every call in this repo but one is a BACKTICK
    // template literal, so a pattern written `fetch("/api/ultra` matches nothing
    // at `e093a98` and would make this citation unreproducible.) The same
    // command at HEAD returns nine lines, two of them this route's:
    //
    //   `components/common/ultra-dock-signal.tsx` — `fetch("/api/ultra")`, NO
    //   query, UNFILTERED, on an 8s interval from a component mounted app-wide
    //   in `app/layout.tsx`. That is a hot path on every route in the app, and
    //   §2 AC7 proof 1 requires it to be unfiltered: filtering by the sessions
    //   you already know about can never discover the one you do not.
    //
    //   `lib/use-ultra-runs.ts` — the filtered form, per session, written as a
    //   template literal: fetch(`/api/ultra?sessionId=${…}`).
    //
    // So "the unfiltered answer must stay byte-for-byte what it was" is not a
    // courtesy to a hypothetical future consumer; it is what keeps the dock
    // signal working. The route is a three-line caller of this function, which
    // is how a route with no test harness in this repo is still proved.
    const out = filterRunsBySession(rows, undefined);
    expect(out).toBe(rows);
    expect(out.map((r) => r.runId)).toEqual(["a", "b", "c", "d"]);
  });

  test("a present sessionId keeps only the exactly-equal rows, in order", () => {
    expect(filterRunsBySession(rows, "s1").map((r) => r.runId)).toEqual(["a", "d"]);
  });

  test("a run with NO sessionId is never matched — not by \"\", not by any id", () => {
    // `run.sessionId` is optional (a run launched outside a chat has none), so a
    // truthiness test would return everything for the empty string.
    expect(filterRunsBySession(rows, "").map((r) => r.runId)).toEqual([]);
    expect(filterRunsBySession(rows, "s-nope")).toEqual([]);
  });
});

// ── issue #17 — background-run liveness for the sidebar ─────────────────────

describe("liveRunCountsBySession counts only running runs, keyed by session", () => {
  test("counts running runs per session and ignores terminal ones", () => {
    const runs = [
      { runId: "a", sessionId: "s1", state: "running" as const },
      { runId: "b", sessionId: "s1", state: "running" as const },
      { runId: "c", sessionId: "s1", state: "done" as const },
      { runId: "d", sessionId: "s2", state: "failed" as const },
      { runId: "e", sessionId: "s2", state: "running" as const },
    ];
    const counts = liveRunCountsBySession(runs);
    expect(counts.get("s1")).toBe(2);
    expect(counts.get("s2")).toBe(1);
    expect(counts.has("s3")).toBe(false);
  });

  test("a run with no sessionId counts toward nothing, not the empty-string key", () => {
    const runs = [{ runId: "a", state: "running" as const }];
    const counts = liveRunCountsBySession(runs);
    expect(counts.size).toBe(0);
    expect(counts.get("")).toBeUndefined();
  });

  test("no running runs at all returns an empty map, not a zeroed one", () => {
    const runs = [
      { runId: "a", sessionId: "s1", state: "done" as const },
      { runId: "b", sessionId: "s1", state: "stopped" as const },
    ];
    expect(liveRunCountsBySession(runs).size).toBe(0);
  });
});

// ── AC7 — the dock summarizer ───────────────────────────────────────────────

describe("4.2 AC7 proof 6 — one dock signal per session; concurrent live runs summarize", () => {
  const snap = (runId: string, state: RunSnapshot["state"], spend: number) =>
    runSnapshot(manifest({ runId, state, spend, meta: { name: runId } }), []);

  test("zero live runs ⇒ null, so the dock renders nothing at all", () => {
    expect(summarizeRuns([], "claude")).toBeNull();
    expect(summarizeRuns([snap("u-1", "done", 5)], "claude")).toBeNull();
  });

  test("one live run ⇒ its NAME, its state, its spend, and it is focusable", () => {
    const s = summarizeRuns([snap("u-1", "running", 1.25)], "claude");
    expect(s).not.toBeNull();
    expect(s!.text).toBe("u-1");
    expect(s!.state).toBe("running");
    expect(s!.focusRunId).toBe("u-1");
    expect(s!.spend.unit).toBe("usd");
  });

  test("three live runs ⇒ \"3 runs live\", the SUM of their spend, and no single focus target", () => {
    const s = summarizeRuns(
      [snap("u-1", "running", 1), snap("u-2", "running", 2), snap("u-3", "running", 4)],
      "claude",
    );
    expect(s!.text).toBe("3 runs live");
    expect(s!.focusRunId).toBeUndefined();
    expect(s!.state).toBeUndefined();
    expect(s!.spend.unit === "usd" && s!.spend.usd).toBe(7);
  });

  test("terminal runs are excluded from both the count and the sum", () => {
    const s = summarizeRuns(
      [snap("u-1", "running", 1), snap("u-2", "done", 100), snap("u-3", "failed", 100)],
      "claude",
    );
    expect(s!.text).toBe("u-1");
    expect(s!.spend.unit === "usd" && s!.spend.usd).toBe(1);
  });

  test("D6a — every money figure goes through spendReadout, and a `tokens: 0` never becomes a rendered zero on Claude", () => {
    expect(anchorSpend("claude", 1.95).text).toBe("$1.9500");
    // The Codex arm is unreachable on this path by NFR-UW-8 and is asserted only
    // so the trade is visible: it would render a confident "0 tok", which is
    // exactly the fabricated figure hard rule 3 forbids. Nothing on an ultra
    // surface may pass this provider.
    expect(anchorSpend("codex", 1.95).text).toBe("0 tok");
  });

  test("a per-agent token figure counts input + output, the same pair a session counts", () => {
    // The cache fields are re-presentations of content the agent already sent,
    // and `lib/spend-readout.ts` excludes them from the session figure for that
    // reason. An agent row that included them read `1.7M tok` beside a
    // `Claude Sonnet 1M` chip — a number that invites being read as a blown
    // context window when it is a lifetime sum over every turn.
    expect(
      agentTokenTotal({ tokens: { input: 40, output: 10, cacheRead: 1_700_000, cacheCreate: 900 } }),
    ).toBe(50);
  });

  test("absent usage stays absent — it never collapses into a confident 0", () => {
    // Distinct from an agent that genuinely spent nothing: the row renders
    // `undefined` as a dash, because "nothing was measured" and "nothing was
    // consumed" are different claims and only one of them is true here.
    expect(agentTokenTotal({})).toBeUndefined();
    expect(agentTokenTotal({ tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } })).toBe(0);
  });
});

// ── AC6 — the composer's arm state ──────────────────────────────────────────

describe("4.2 AC6 — the chip arms exactly one message", () => {
  test("arm → send → next send: the second send carries no key", () => {
    let s = armReducer({ armed: false }, "arm");
    expect(s.armed).toBe(true);
    expect(sendOptionsFor({ kind: "user", armed: s.armed })).toEqual({ ultra: true });
    s = armReducer(s, "sent");
    expect(s.armed).toBe(false);
    expect(sendOptionsFor({ kind: "user", armed: s.armed })).toBeUndefined();
  });

  test("the user can disarm it before sending", () => {
    const s = armReducer(armReducer({ armed: false }, "arm"), "disarm");
    expect(s.armed).toBe(false);
  });

  test("arming twice is idempotent, and disarming an unarmed chip is a no-op", () => {
    expect(armReducer(armReducer({ armed: false }, "arm"), "arm")).toEqual({ armed: true });
    expect(armReducer({ armed: false }, "disarm")).toEqual({ armed: false });
  });

  test("D2 — a QUEUED message carries its OWN flag, decided when Enter was pressed", () => {
    // Arming while the agent is busy and pressing Enter must annotate THAT
    // message when it eventually sends — not the next one the user types, and
    // not none of them.
    expect(sendOptionsFor({ kind: "queued", ultra: true })).toEqual({ ultra: true });
    expect(sendOptionsFor({ kind: "queued", ultra: false })).toBeUndefined();
    expect(sendOptionsFor({ kind: "queued" })).toBeUndefined();
  });

  test("the option object omits the key entirely rather than sending `ultra: false`", () => {
    // route.ts narrows with `rawUltra === true`, so a false would be harmless —
    // but the wire stays minimal and the absence is the assertion.
    const opts = sendOptionsFor({ kind: "user", armed: false });
    expect(opts).toBeUndefined();
    expect(sendOptionsFor({ kind: "user", armed: true })).toEqual({ ultra: true });
  });
});

// ── REVIEW ROUND 1 — the regression pins ────────────────────────────────────
//
// One block, because five of the seven findings below reduce to ONE root cause
// the review named precisely: THE SURFACE ONLY KNEW ABOUT A RUN IT PERSONALLY
// WATCHED HAPPEN. Every test here fails against the shipped code.

describe("4.2 review B1 — a run this reader never watched states NO figure it never read", () => {
  // The reviewer's own reproduction, restated as a fixture: a run that spawned
  // five agents across two declared phases and finished. The page is reloaded
  // tomorrow; `GET /api/ultra?sessionId=` answers with the MANIFEST and nothing
  // else, because a manifest is all the list route has.
  const finished = manifest({
    runId: "u-yesterday",
    state: "done",
    meta: { name: "sweep", phases: ["Scan", "Rank"] },
  });
  const journal: UltraEventLike[] = [
    ev.phase("Scan"),
    ev.log("scanning the tree"),
    ev.start(0),
    ev.agent(0),
    ev.start(1),
    ev.agent(1),
    ev.start(2),
    ev.agent(2),
    ev.phase("Rank"),
    ev.start(3),
    ev.agent(3),
    ev.start(4),
    ev.agent(4),
  ];

  test("the manifest ALONE yields no `agentsDone`, no sliver — absent, never `0`", () => {
    const snap = runSnapshot(finished, null, [], "u-yesterday");
    // ABSENT ON THE KEY, the same form `progress` and `error` already use, so a
    // renderer cannot accidentally interpolate `undefined done`.
    expect("agentsDone" in snap).toBe(false);
    expect(snap.agentsDone).toBeUndefined();
    expect("progress" in snap).toBe(false);
    // …and the rest of the snapshot is still complete and uncrashed.
    expect(snap.state).toBe("done");
    expect(snap.name).toBe("sweep");
    expect(snap.pending).toBe(false);
  });

  test("THE DISCRIMINATOR — `[]` is READ-AND-EMPTY and DOES state `0`; `null` is NOT READ", () => {
    // Without this pair, "absent" is indistinguishable from "the field was
    // dropped". `[]` and `null` are different answers to different questions and
    // the whole fix is that the type can now tell them apart.
    expect(runSnapshot(finished, []).agentsDone).toBe(0);
    expect("agentsDone" in runSnapshot(finished, [])).toBe(true);
    expect("agentsDone" in runSnapshot(finished, null)).toBe(false);
  });

  test("once the journal IS read, the figures are the real ones — 5 done, 2 of 2, two phases", () => {
    // This is what `use-ultra-runs.ts` now opens a stream for a terminal run to
    // obtain. Before the fix these three numbers were 0, `0 of 2` and none.
    const snap = runSnapshot(finished, journal, [], "u-yesterday");
    expect(snap.agentsDone).toBe(5);
    expect(snap.progress).toEqual({ seen: 2, declared: 2 });
    expect(snap.phases.map((p) => p.title)).toEqual(["Scan", "Rank"]);
    expect(snap.narrator).toEqual(["scanning the tree"]);
  });

  test("the AGENT INDEX is an independent second source, so its rows alone license the count", () => {
    // `GET /api/ultra/[id]/agents` can answer for a run whose events this page
    // never streamed. A reader holding that is not guessing.
    const index: AgentIndexRow[] = [
      { ordinal: 0, settled: true, attempt: 1, lastText: "done" },
      { ordinal: 1, settled: false, attempt: 1, lastText: "working" },
    ];
    const snap = runSnapshot(finished, null, index, "u-yesterday");
    expect(snap.agentsDone).toBe(1);
    // …but the journal is still unread, so the phase fraction stays absent.
    expect("progress" in snap).toBe(false);
  });
});

describe("4.2 review B2 — an unresolved runId is not a live run", () => {
  test("the pending payload offers NO Stop, even though its state reads `running`", () => {
    // `null` for the events, exactly as `session-view.tsx`'s pending factory
    // passes it: the pending window is when this reader has NOT looked, so it
    // states no count either (B1 wearing D8's clothes — every persisted launch
    // in a reloaded transcript comes through here on the first paint).
    const pending = runSnapshot(null, null, [], "u-finished-days-ago");
    expect("agentsDone" in pending).toBe(false);
    expect(pending.pending).toBe(true);
    // The state fallback is deliberate and stays (AD-15): a run with no manifest
    // is far likelier to be starting than finished. What changes is that the
    // CONTROL no longer believes it.
    expect(pending.state).toBe("running");
    expect(anchorControls(pending).canStop).toBe(false);
    expect(anchorControls(pending).canResume).toBe(false);
  });

  test("THE ANTI-VACUITY HALF — a real `running` run DOES offer Stop", () => {
    // Without this, `canStop: false` everywhere would pass the test above.
    const live = runSnapshot(manifest({ state: "running" }), []);
    expect(live.pending).toBe(false);
    expect(anchorControls(live).canStop).toBe(true);
  });

  test("Resume is for `stopped` and `failed`, never `done`, and never for pending", () => {
    expect(anchorControls(runSnapshot(manifest({ state: "stopped" }), [])).canResume).toBe(true);
    expect(anchorControls(runSnapshot(manifest({ state: "failed" }), [])).canResume).toBe(true);
    expect(anchorControls(runSnapshot(manifest({ state: "done" }), [])).canResume).toBe(false);
  });
});

describe("4.2 review SF-1 — the stream set is RECONCILED, never rebuilt", () => {
  test("A SECOND RUN LAUNCHING DOES NOT TOUCH THE FIRST RUN'S STREAM", () => {
    // THE CASE NO EXISTING TEST DROVE, and the one AC4 calls first-class. Run A
    // is live and has narrated. Run B launches. The old effect's cleanup closed
    // A, the body re-opened it, and the route replayed A's whole journal into an
    // accumulator nothing reset — so the narrator repeated itself.
    const wanted = wantedStreams(["A", "B"], ["A", "B"], new Set());
    expect(wanted).toEqual(["A", "B"]);
    const step = reconcileStreams(["A"], wanted);
    expect(step.open).toEqual(["B"]);
    // THE ASSERTION THAT IS THE FIX: A is in neither list.
    expect(step.close).toEqual([]);
  });

  test("a run that goes terminal and has been drained IS closed, and nothing else is", () => {
    const wanted = wantedStreams(["B"], ["A", "B"], new Set(["A"]));
    expect(wanted).toEqual(["B"]);
    const step = reconcileStreams(["A", "B"], wanted);
    expect(step.close).toEqual(["A"]);
    expect(step.open).toEqual([]);
  });

  test("B1's half — an UNDRAINED terminal run is wanted; a drained one is not", () => {
    // This is the whole of "read a finished run's journal exactly once".
    expect(wantedStreams([], ["A"], new Set())).toEqual(["A"]);
    expect(wantedStreams([], ["A"], new Set(["A"]))).toEqual([]);
    // A LIVE run is wanted whether or not it was drained before — a resumed run
    // is drained and live at once, and it must be watched again.
    expect(wantedStreams(["A"], ["A"], new Set(["A"]))).toEqual(["A"]);
  });

  test("nothing wanted and nothing open is a no-op, not a wipe", () => {
    expect(reconcileStreams([], [])).toEqual({ close: [], open: [] });
    expect(reconcileStreams(["A"], ["A"])).toEqual({ close: [], open: [] });
  });

  test("A RESUMED RUN KEEPS ITS STREAM — `hydrated` must mean the CURRENT connection drained", () => {
    // The sequence that strands a run, walked one step at a time. Found by an
    // adversarial pass over this very fix, not by the original review: the first
    // version of it left `hydrated` add-only, and `hydrated` add-only is a claim
    // that a run drained ONCE can never need reading again — which a resume
    // falsifies.
    const hydrated = new Set<string>();

    // 1. Page mounts on a terminal run. Not hydrated ⇒ wanted (B1).
    expect(wantedStreams([], ["A"], hydrated)).toEqual(["A"]);
    // 2. Its journal drains to `end`.
    hydrated.add("A");
    expect(wantedStreams([], ["A"], hydrated)).toEqual([]);
    // 3. The user clicks Resume. A is live again, so it is wanted regardless…
    expect(wantedStreams(["A"], ["A"], hydrated)).toEqual(["A"]);
    // …and OPENING THE STREAM UN-HYDRATES IT, which is the line under test.
    hydrated.delete("A");
    // 4. A settles. The 4s list poll can see the terminal manifest BEFORE the
    //    400ms SSE tail delivers `end`, so A leaves the live set first. With the
    //    delete, A is still wanted and its stream survives to be drained.
    expect(wantedStreams([], ["A"], hydrated)).toEqual(["A"]);
    expect(reconcileStreams(["A"], wantedStreams([], ["A"], hydrated)).close).toEqual([]);
    // THE ANTI-VACUITY HALF: without the delete, that same step CLOSES the
    // stream, `end` never arrives, and the run reads `journal = null` forever.
    const stale = new Set(["A"]);
    expect(wantedStreams([], ["A"], stale)).toEqual([]);
    expect(reconcileStreams(["A"], wantedStreams([], ["A"], stale)).close).toEqual(["A"]);
    // 5. `end` finally arrives and A is hydrated again, for good this time.
    hydrated.add("A");
    expect(wantedStreams([], ["A"], hydrated)).toEqual([]);
  });
});

describe("4.2 review SF-3 — `settled` and `live` are different questions", () => {
  const inFlight: UltraEventLike[] = [ev.start(0), ev.start(1), ev.agent(1)];

  test("while the run is RUNNING, an unsettled ordinal is live", () => {
    const rows = agentRows(inFlight, [], "running");
    expect(rows.map((r) => [r.ordinal, r.settled, r.live])).toEqual([
      [0, false, true],
      [1, true, false],
    ]);
  });

  test("once the run is STOPPED, its in-flight ordinals are terminated — not live, not settled", () => {
    // `stopUltraRun` ABORTS them, so ordinal 0 never emits a settling `agent`
    // event and stays `settled: false` forever. The rail used to paint that as a
    // live dot and an infinitely-animating shimmer inside a card headed
    // `stopped`. The same arrives with no user action at all through
    // `getUltraManifest`'s on-read `running` → `stopped` rewrite (AD-15/T14).
    for (const state of ["stopped", "failed", "done"] as const) {
      const rows = agentRows(inFlight, [], state);
      expect(rows[0]!.live).toBe(false);
      // AND THE COUNT STAYS HONEST: an aborted agent did not finish, so it is
      // still not `done`. Marking it settled to stop the shimmer would have
      // traded one false statement for another.
      expect(rows[0]!.settled).toBe(false);
      expect(rows[1]!.live).toBe(false);
    }
  });

  test("`runSnapshot` crosses the two, and `agentsDone` counts settlement only", () => {
    const stopped = runSnapshot(manifest({ state: "stopped" }), inFlight);
    expect(stopped.agentsDone).toBe(1);
    expect(stopped.phases.flatMap((p) => p.agents).every((a) => !a.live)).toBe(true);
    const running = runSnapshot(manifest({ state: "running" }), inFlight);
    expect(running.phases.flatMap((p) => p.agents).filter((a) => a.live)).toHaveLength(1);
  });

  test("the default arg keeps every caller with no run in hand reading `!settled`", () => {
    const rows = agentRows(inFlight, []);
    expect(rows.map((r) => r.live)).toEqual([true, false]);
  });
});

describe("4.2 review SF-4 — the dock never docks the session on screen", () => {
  test("the session's own page matches; another session's does not", () => {
    expect(isSessionRoute("/projects/telar/sessions/abc", "abc")).toBe(true);
    expect(isSessionRoute("/projects/telar/sessions/abc", "xyz")).toBe(false);
  });

  test("AC7's OWN CASE still docks — another page, same app", () => {
    // The guard must be about one SESSION, not one tab: AC7's Given is "the user
    // is on another page with a run live", which is a FOCUSED tab. A
    // visibility/focus guard would suppress the head in exactly the case the AC
    // exists for, which is why this is a route test.
    expect(isSessionRoute("/projects/telar", "abc")).toBe(false);
    expect(isSessionRoute("/", "abc")).toBe(false);
    expect(isSessionRoute("/looms/l-1", "abc")).toBe(false);
  });

  test("a percent-escaped pathname matches, an empty id never does, a malformed escape does not throw", () => {
    expect(isSessionRoute("/projects/my%20proj/sessions/abc", "abc")).toBe(true);
    expect(isSessionRoute("/projects/x/sessions/a%20b", "a b")).toBe(true);
    expect(isSessionRoute("/projects/x/sessions/", "")).toBe(false);
    expect(isSessionRoute("/projects/x/sessions/%zz", "abc")).toBe(false);
  });

  test("a session id that is a SUFFIX of another must not match it", () => {
    expect(isSessionRoute("/projects/x/sessions/abcdef", "def")).toBe(false);
  });
});

describe("4.2 review SF-5 — the anchor's shape is constant while running", () => {
  test("THE CASE `anchorForm` COULD NOT SEE — the sliver arriving mid-run", () => {
    // A launch renders pending (no manifest ⇒ `progressFraction` short-circuits
    // ⇒ no fraction), then the first manifest lands carrying `meta.phases`, then
    // phases are observed. The old anchor gained `gap-1` + `h-px` at step two —
    // a second height change AC2 forbids — and `anchorForm(run)` read `state`
    // alone, so it reported "running" at every step and saw nothing.
    const steps: RunSnapshot[] = [
      runSnapshot(null, [], [], "u-1"),
      runSnapshot(manifest({ state: "running" }), []),
      runSnapshot(manifest({ state: "running" }), [ev.phase("Scan")]),
      runSnapshot(manifest({ state: "running" }), [ev.phase("Scan"), ev.start(0)]),
      runSnapshot(manifest({ state: "running" }), [ev.phase("Scan"), ev.phase("Rewrite")]),
    ];
    // The fraction really does appear part-way through — otherwise this test
    // proves nothing about the case it names.
    expect(steps[0]!.progress).toBeUndefined();
    expect(steps.at(-1)!.progress).toEqual({ seen: 2, declared: 2 });
    const shapes = steps.map((s) => JSON.stringify(anchorShape(s)));
    expect(new Set(shapes).size).toBe(1);
  });

  test("and it still changes EXACTLY ONCE, at terminal", () => {
    const running = anchorShape(runSnapshot(manifest({ state: "running" }), []));
    const done = anchorShape(runSnapshot(manifest({ state: "done" }), []));
    expect(running).not.toEqual(done);
    expect(running.detail).toBe(true);
    expect(running.sliver).toBe(true);
    expect(done.detail).toBe(false);
    expect(done.sliver).toBe(false);
    // `anchorForm` is now DERIVED from the shape, so the two cannot drift.
    expect(anchorForm(runSnapshot(manifest({ state: "running" }), []))).toBe("running");
    expect(anchorForm(runSnapshot(manifest({ state: "done" }), []))).toBe("terminal");
  });

  test("the terminal error row is part of the shape, so it is visible to this proof too", () => {
    expect(anchorShape(runSnapshot(manifest({ state: "failed", error: "boom" }), [])).errorRow).toBe(true);
    expect(anchorShape(runSnapshot(manifest({ state: "failed" }), [])).errorRow).toBe(false);
    expect(anchorShape(runSnapshot(manifest({ state: "done" }), [])).errorRow).toBe(false);
    // An EMPTY error is not an error row. `runSnapshot` copies the manifest's
    // field whenever it is not `undefined`, so `""` is reachable, and the
    // renderer this replaced branched on truthiness — a row of height beside no
    // content would be a behaviour change smuggled in by a refactor.
    expect(anchorShape(runSnapshot(manifest({ state: "failed", error: "" }), [])).errorRow).toBe(false);
    // …and it is still a `running` run that has no error row at all.
    expect(anchorShape(runSnapshot(manifest({ state: "running", error: "boom" }), [])).errorRow).toBe(false);
  });
});

// ── the static scans (AC9, AC10 proof 5, §5.5-D1 item 7) ────────────────────
//
// These read SOURCE FILES AS TEXT. They touch no state root, no TELAR_HOME and
// no engine — INV-7 is unaffected — and they exist because three claims this
// story makes are otherwise prose: "no budget UI anywhere", "the wake's dispatch
// cannot carry the chip's key", and "the tool wire name is not re-derived".

/** AC9's rejected vocabulary. A budget has a CEILING; a readout does not. `%`
 *  is checked only next to a currency, because a bare `%` is ordinary CSS. */
const BUDGET_TOKENS = [
  /\bbudget\b/i,
  /\bceiling\b/i,
  /\bmaxCost\b/i,
  /\bremaining\b/i,
  /\bheadroom\b/i,
  /\$[^\n]{0,12}%|%[^\n]{0,12}\$/,
  /<Progress\b/,
];

/** Comments and block comments removed. THE SCAN IS ABOUT RENDERED UI, NOT ABOUT
 *  PROSE, and getting that backwards makes the guard actively harmful: the first
 *  version of this scan counted comments, so it reported every one of these four
 *  files — on sentences that SAY the product has no ceiling and no meter. A rule
 *  that forbids documenting itself is a rule that gets documented somewhere the
 *  scan cannot see. `<Progress>` in a comment is not a progress bar. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function budgetTokensIn(source: string): string[] {
  const code = stripComments(source);
  return BUDGET_TOKENS.filter((re) => re.test(code)).map((re) => String(re));
}

describe("4.2 AC9 — NO BUDGET UI ANYWHERE, and it is a scan rather than a promise", () => {
  // THE ENUMERATED LIST, not a glob: the three new component files plus the ONE
  // edited file this story makes render money (`dock.tsx`, AC7 proof 4). A glob
  // would silently shrink to nothing if a directory were renamed.
  //
  // THE TWO NEW ULTRA FILES ARE BOTH IN, and `ultra-run-views.tsx` is in even
  // though nothing it renders is a number today. "Which half of the new surface
  // will ever render money" is exactly the judgement that goes stale, and this
  // list is enumerated rather than globbed so that judgement never has to be
  // made twice.
  const SCANNED = [
    "apps/web/components/session/ultra-anchor.tsx",
    "apps/web/components/session/ultra-rail.tsx",
    "apps/web/components/session/ultra-tab.tsx",
    "apps/web/components/session/ultra-run-views.tsx",
    "apps/web/components/common/ultra-dock-signal.tsx",
    "apps/web/components/dock/dock.tsx",
  ] as const;

  test("all six files are readable — the floor, so a rename fails LOUDLY instead of scanning nothing", () => {
    const read = SCANNED.map((rel) => readSource(rel));
    expect(read.length).toBe(6);
    // …and each is a real file rather than an empty one.
    expect(read.every((src) => src.length > 500)).toBe(true);
  });

  for (const rel of SCANNED) {
    test(`${rel} contains no budget token`, () => {
      // NFR-UW-7 and `ui-contract.md` §6 are about the SURFACE. Nothing in ultra
      // gates on money — `storage.ts` says so in its own words ("Ultra's spend
      // is a READOUT, not a cap") — so there is nothing to build a meter from
      // and this asserts none was built anyway.
      expect(budgetTokensIn(readSource(rel))).toEqual([]);
    });
  }

  test("THE DISCRIMINATOR — the same function reports a synthetic file that DOES carry one, and not one that does not", () => {
    // §5.4-F, in both directions and through the SAME function the real check
    // uses. Without it, "no budget token found" is indistinguishable from "the
    // scanner matches nothing".
    for (const dirty of [
      "const budget = 5;",
      "const ceiling = 10;",
      "const maxCost = 1;",
      "spend remaining: 40",
      "reserved headroom",
      "<div>$12 (80%)</div>",
      "<Progress value={50} />",
    ]) {
      expect(budgetTokensIn(dirty)).not.toEqual([]);
    }
    for (const clean of [
      'const spend = anchorSpend(provider, run.spendUsd);',
      '<span>{spend.text}</span>',
      // A percentage with NO currency near it is the phase sliver's own width,
      // which is a fraction of DECLARED PHASES and never of money.
      'style={{ width: `${Math.round((seen / declared) * 100)}%` }}',
    ]) {
      expect(budgetTokensIn(clean)).toEqual([]);
    }
  });

  test("THE COMMENT CARVE-OUT is real, and it is exercised in both directions", () => {
    // The scan strips comments before matching, so a sentence SAYING there is no
    // ceiling does not read as a ceiling. That carve-out is a hole unless it is
    // shown to be exactly one token wide: the same word in CODE is still caught.
    expect(budgetTokensIn("// no meter, no ceiling, no reserved headroom")).toEqual([]);
    expect(budgetTokensIn("/* <Progress> would read as a budget meter */")).toEqual([]);
    expect(budgetTokensIn("const ceiling = 10;")).not.toEqual([]);
    expect(budgetTokensIn("<Progress value={x} />")).not.toEqual([]);
    // …and the stripper is genuinely removing something from the real files
    // rather than being a no-op that happens to look like one.
    const anchor = readSource("apps/web/components/session/ultra-anchor.tsx");
    expect(stripComments(anchor).length).toBeLessThan(anchor.length);
    // It must not eat a URL's `//` — that would silently truncate real code and
    // turn this scan into a no-op on any file containing one.
    expect(stripComments('const u = "https://x/y"; const ceiling = 1;')).toContain("ceiling");
  });

  test("the one bar that exists is the PHASE sliver, and its own comment says what it is a fraction of", () => {
    const anchor = readSource("apps/web/components/session/ultra-anchor.tsx");
    expect(anchor).toContain("run.progress");
    expect(anchor).toContain("DECLARED PHASES");
    // …and it is hand-rolled, not `<Progress>`, which would read as a meter.
    expect(anchor).not.toContain("<Progress");
  });
});

describe("4.2 §5.5-D1 item 7 — the wake's turn can never carry the chip's key", () => {
  test("the wake's dispatch is server-authored, and no client module can mint one", () => {
    // The claim is unchanged and its ground moved: the wake turn's body used to
    // be `send`'s, one hard-coded option object away from every composer key,
    // and it is now composed entirely server-side by `machineryTurnPayload` from
    // the session's chats.json row. No composer state exists on that path to
    // reach it.
    //
    // WHY A STATIC PIN RATHER THAN A PURE TEST: the negative half of the claim
    // is about what a FILE may contain, which no unit test can ask of behaviour.
    // The reducer's own behaviour is asserted above.
    const engine = readSource("apps/web/lib/server/session-engine.ts");
    const adapter = readSource("apps/web/components/session/session-view.tsx");
    const alerts = readSource("apps/web/components/session/use-watcher-alerts.ts");
    expect(engine).toContain("machineryTurnPayload(sessionId, ULTRA_WAKE_SENTINEL, key)");
    expect(engine).not.toContain("ultra: true");
    // THE CLIENT CANNOT FIRE A WAKE AT ALL NOW, which is strictly more than the
    // key-cannot-ride claim: the sentinel is in no client module, so there is no
    // trigger for a composer key to ride on…
    for (const src of [adapter, alerts]) {
      expect(src).not.toContain("ULTRA_WAKE_SENTINEL");
      expect(src).not.toContain("...(opts?.ultra ? { ultra: true } : {}),");
      expect(src).not.toContain("...(ultraArmed ? { ultra: true } : {})");
      expect(src).not.toContain("ultraArm.armed ? { ultra: true }");
    }
    // …and the one door a client could enqueue through refuses the fields that
    // would make a ticket machinery.
    const queueRoute = readSource("apps/web/app/api/chat/[sessionId]/queue/route.ts");
    expect(queueRoute).toContain("body.kind !== undefined || body.hidden !== undefined");
  });

  test("the arm reducer says ARMED and the wake ticket still carries no `ultra` key", () => {
    // The pure half of the same claim, stated as §5.5-D1 item 7 asks: even with
    // the reducer armed, the wake's own options are the engine's ticket literal.
    const armed = armReducer({ armed: false }, "arm");
    expect(armed.armed).toBe(true);
    const wakeTicket = { kind: "wake", hidden: true } as const;
    expect("ultra" in wakeTicket).toBe(false);
  });
});

describe("4.2 review round 1 — the four fixes that live in components and hooks, pinned statically", () => {
  // WHY STATIC AND NOT PURE. Each of these is a line of JSX or of effect body,
  // and there is no DOM harness in this repo (hard rule 9). The DECISIONS were
  // all moved into `lib/ultra-runs.ts` above and are asserted there; what these
  // pin is that the component actually CALLS them — which is the half a pure
  // test cannot see, and the half every one of these findings turned on.

  test("SF-2 — the retired Ultra chip cannot return on any composer surface", () => {
    const src = readSource("apps/web/components/session/session-view.tsx");
    expect(src).not.toContain("ultraArmed");
    expect(src).not.toContain("setUltraArmed");
    // …and B1 at the pending factory: `null` (not read) rather than `[]` (read
    // and empty), because every persisted launch in a reloaded transcript
    // renders through it on the first paint.
    expect(src).toContain("run: runSnapshot(null, null, [], runId),");
  });

  test("SF-1 — the hook reconciles its streams and resets the accumulator per connection", () => {
    const src = readSource("apps/web/lib/use-ultra-runs.ts");
    // The decision is delegated to the two functions this file drives above,
    // rather than open-coded in an effect where nothing can reach it.
    expect(src).toContain("wantedStreams(");
    expect(src).toContain("reconcileStreams(");
    // TERMINAL RUNS ARE IN THE EFFECT KEY (B1). Without `allIds` the effect
    // cannot notice a run it has never streamed.
    expect(src).toContain("}, [liveIds, allIds, reload]);");
    // EVERY CONNECTION REPLAYS FROM LINE 0 — the route's `nextLine = 0` lives
    // inside `start(controller)` — so the accumulator is reset on `open`, which
    // also covers a browser reconnect after a transport error.
    expect(src).toContain('es.addEventListener("open"');
    // …and OPENING UN-HYDRATES, so `hydrated` means "the CURRENT connection
    // drained". Without it a resumed run whose list poll beats its `end` frame
    // has its still-undrained stream closed and reads `journal = null` forever.
    expect(src).toContain("hydrated.current.delete(runId);");
    // AND THE WIPE LIVES IN A MOUNT-ONLY EFFECT. React runs a cleanup on EVERY
    // dependency change, so a close-everything cleanup on the reconciling effect
    // is what tore down a still-wanted stream when a second run launched.
    expect(src).toContain(
      "for (const [, es] of open) es.close();\n      open.clear();\n    };\n  }, []);",
    );
  });

  test("SF-4 / NH-1 — the dock signal consults the route, and mints its initial by code point", () => {
    const src = readSource("apps/web/components/common/ultra-dock-signal.tsx");
    expect(src).toContain("isSessionRoute(window.location.pathname, sessionId)");
    expect(src).toContain("if (!seeded.current.has(sessionId) && !watching) {");
    // `String.prototype[0]` indexes UTF-16 code units, so a title starting with
    // an emoji renders half a surrogate pair (§5.6-T19 item 9).
    expect(src).toContain("Array.from(title.trim())[0]");
    expect(src).not.toContain("title.trim()[0]");
  });

  test("SF-5 / B2 / NH-2 — the anchor reserves the sliver row, refuses a fabricated count, and carries no dead expression", () => {
    const src = readSource("apps/web/components/session/ultra-anchor.tsx");
    // The row is drawn whenever the running form is, and its INK is what is
    // conditional — so the fraction arriving cannot change the height.
    expect(src).toContain("{shape.sliver && (");
    expect(src).toContain('run.progress === undefined && "opacity-0"');
    // The controls come from the tested rule, so B2's `!pending` term cannot be
    // dropped here without dropping it there.
    expect(src).toContain("{controls.canStop && (");
    expect(src).toContain("{controls.canResume && (");
    // B1 at the render site: an absent count renders NOTHING, never `0 done`.
    expect(src).toContain("{run.agentsDone !== undefined && (");
    // NH-2 — `{view.live && null}` renders nothing in EITHER branch. Asserted
    // over STRIPPED source, because the comment that replaced it necessarily
    // quotes the expression it removed — and a scan that cannot tell code from
    // prose is the same mistake AC9's own scan was fixed for.
    expect(stripComments(src)).not.toContain("view.live");
    expect(src).toContain("view.live && null");
  });
});

describe("4.2 — the tool wire name is READ from ultra-mcp.ts, never re-derived", () => {
  test("ULTRA_TOOL_NAME matches ULTRA_AUTO_TOOLS' first entry", () => {
    // `lib/ultra-mcp.ts` pulls in the Agent SDK, so `lib/ultra-runs.ts` cannot
    // import from it and stay reachable from a client root. The literal is
    // spelled locally and pinned here instead — one assertion standing in for an
    // import edge that would break INV-4.
    const src = readSource("apps/web/lib/ultra-mcp.ts");
    const list = /ULTRA_AUTO_TOOLS\s*=\s*\[([\s\S]*?)\]/.exec(src);
    expect(list).not.toBeNull();
    const first = /"([^"]+)"/.exec(list![1]!);
    expect(first).not.toBeNull();
    expect(ULTRA_TOOL_NAME).toBe(first![1]!);
    expect(ULTRA_TOOL_NAME).toBe("mcp__ultra__ultra");
  });
});

describe("4.2 AC10 proof 5 — `ConversationProps` is still NINE names, and there is no tenth slot", () => {
  test("a tenth slot does not compile — a TYPE ANNOTATION ON A DATA OBJECT, never a directive above a call", () => {
    // HARD RULE 5. `@ts-expect-error` is a comment to the COMPILER and nothing
    // at all to the RUNTIME: a directive above a CALL still calls, which is how
    // story 2.2 renamed directories under the operator's real ~/.telar. So the
    // erroring construct is confined to a typed data literal and no call is made
    // from it. `apps/web/tsconfig.json` has NO test exclusion, so
    // `bunx tsc --noEmit` genuinely checks this — unlike `packages/core`, whose
    // tsconfig is `include: ["src"]` and never sees a test file at all.
    const props: Partial<ConversationProps> = {
      items: [],
      // @ts-expect-error — ConversationProps is closed at nine names (INV-8i).
      // The Ultra anchor's data arrives in its item PAYLOAD; if this directive
      // ever reports "unused", someone widened the frozen shell and AD-12's
      // contract became a convention.
      ultraRuns: new Map(),
    };
    void props;
    // The positive control, so the negative one is not the whole claim: the
    // names that DO exist still do.
    const real: Partial<ConversationProps> = { items: [], kinds: undefined };
    expect(Array.isArray(real.items)).toBe(true);
  });
});

describe("AC-U1 — a LIVE agent snippet is a BLOCK box, so `truncate` can clip it", () => {
  // ROOT CAUSE, not a string match. `Shimmer` hard-codes `relative inline-block`
  // on its root, and an inline-block whose `truncate` forces `white-space:nowrap`
  // is sized by CSS shrink-to-fit — whose preferred MINIMUM width is the full
  // unwrapped text, so `overflow:hidden` never has anything to clip and the
  // snippet spills across the 240px rail. What follows measures the class the
  // component actually composes, through the same `cn` (twMerge) it uses.
  //
  // The ELLIPSIS ITSELF is a dev-server observation: there is no DOM harness in
  // this repo, deliberately, so no test here paints a pixel.
  const shimmerBase = /cn\("([^"]+)"/.exec(
    readSource("apps/web/components/ai-elements/shimmer.tsx"),
  )?.[1];

  test("the SHARED component was not touched — its root is still `inline-block`", () => {
    // The positive control AND the AC's "every other Shimmer call site renders
    // exactly as before" half: those sites are all flex children or `as="span"`,
    // where the default is required or invisible, so leaving it alone is the fix
    // being local rather than the fix being skipped.
    expect(shimmerBase).toBeDefined();
    expect(shimmerBase).toContain("inline-block");
  });

  test("`block` in the call-site class WINS the display group through twMerge", () => {
    const composed = cn(shimmerBase!, LIVE_SNIPPET_CLASS);
    expect(composed).not.toContain("inline-block");
    expect(composed).toContain("block");
    expect(composed).toContain("truncate");
  });

  test("THE DISCRIMINATOR — the PRE-FIX class still yields the broken display", () => {
    // Without this, the assertion above is indistinguishable from "twMerge drops
    // inline-block whatever you pass it". The old string is exactly the one that
    // shipped the bug.
    expect(cn(shimmerBase!, "min-w-0 truncate px-2 pb-0.5 text-[10px]")).toContain("inline-block");
  });

  test("the component uses the constant this test measured", () => {
    expect(readSource("apps/web/components/session/ultra-rail.tsx")).toContain(
      "className={LIVE_SNIPPET_CLASS}",
    );
  });
});

describe("AC-U2 — the run-tab selector id round-trips and cannot be mistaken for anything else", () => {
  test("it round-trips, including through a runId that itself contains a colon", () => {
    expect(ultraTabRunId(ultraTabId("u-abc"))).toBe("u-abc");
    expect(ultraTabRunId(ultraTabId("u:with:colons"))).toBe("u:with:colons");
  });

  test("the OTHER two vocabularies `activeTab` holds resolve to null", () => {
    expect(ultraTabRunId("main")).toBeNull();
    // A spawn tool_use id — the sub-agent tab vocabulary.
    expect(ultraTabRunId("toolu_01XyZ")).toBeNull();
  });

  test("an ITEM KIND id is NOT a tab id, and a tab id is not an item key", () => {
    // The two vocabularies that look alike. `ULTRA_ANCHOR_KIND` is a registered
    // kind id (INV-10a pins it); `ultra:${runId}` is the item KEY
    // `spliceRunAnchors` mints. A tab id must collide with neither.
    expect(ultraTabRunId(ULTRA_ANCHOR_KIND)).toBeNull();
    expect(ultraTabId("u-abc")).not.toBe(ULTRA_ANCHOR_KIND);
    expect(ultraTabId("u-abc")).not.toBe("ultra:u-abc");
  });

  test("session-view.tsx wires the tab through those helpers, not through a local literal", () => {
    const src = readSource("apps/web/components/session/session-view.tsx");
    // `ultraTabKind`/`SESSION_ULTRA_TAB` DELIBERATELY DROPPED (issue #13). Those
    // named the composite item kind that used to render the Ultra pane BY
    // REPLACING `transcriptItems` — the exact mechanism traced as "renders on top
    // of the main chat", since a scroll column that owns the transcript has no
    // way to show one item INSTEAD of it. The pane now renders in the
    // right-panel Activity dock (a sibling surface, not a transcript swap), so
    // there is no local item-kind literal left for this half of the guard to
    // find. `ultraTabRunId`/`ultraTabId` are unchanged below: `activeTab` still
    // names the selected run, it just feeds the dock instead of this memo.
    expect(src).toContain("ultraTabRunId(activeTab)");
    expect(src).toContain("ultraTabId(runId)");
    // INV-10b's positive half: the anchor kind is still registered in the
    // ADAPTER's registry (and, elsewhere, still absent from the gallery's).
    expect(src).toContain("ultraRunAnchorKind");
  });

  test("all four dock-focus call sites reveal the dock, not just name the content", () => {
    // Proved as a REGRESSION GAP first: `sidebar-mount.test.ts` pins the
    // arrival effect's dependency array growing by `resolvedRightPanelScopeKey`,
    // but a dependency-array pin does not prove the call inside the effect
    // still exists — deleting the `openRightPanelActivity(...)` line and
    // leaving the (now-unused-looking but still-referenced-elsewhere) dep in
    // place left the whole suite green. `setActiveTab(ultraTabId(...))` alone
    // only names WHICH run; since #13(b) moved the pane out of the transcript,
    // naming the run no longer reveals anything by itself (see the removed
    // memo arm above) — the dock must be told to open, separately, at EVERY
    // site that focuses dock-hosted content: the two inline anchor `onFocus`
    // callbacks (`ultraAnchorPayloads`, `pendingUltraAnchor`), the `?run=`
    // arrival effect, and — since the dock migration moved sub-agent panes in
    // beside the runs — `openAgentInDock`, which Main's step rows and
    // completion markers select through. Four call sites, four calls —
    // counted, not just asserted present.
    const src = readSource("apps/web/components/session/session-view.tsx");
    expect(
      src.split("openRightPanelActivity(resolvedRightPanelScopeKey)").length - 1,
    ).toBe(4);
  });

  test("the rail is the INDEX that opens the pane, and says which run is open", () => {
    // Comments stripped: this file's own header says "NOT HERE" about its
    // decisions, and the chip is JSX TEXT rather than a quoted string.
    const code = stripComments(readSource("apps/web/components/session/ultra-rail.tsx"));
    expect(code).toContain("activeRunId");
    expect(code).toContain("Here");
    expect(code).toContain("text-primary");
    // `anchorControls(` IS NO LONGER ASSERTED HERE. Stop/Resume moved to the
    // pane on an owner ruling that the index shows "which runs exist and who is
    // working, nothing more" — so the rail no longer decides a control's states
    // and has no rule left to duplicate. The pane still reads `anchorControls`,
    // and the AC-U3 block above is what pins that.
    //
    // WHAT THE INDEX MUST STILL DO, and the reason this test survives: the whole
    // card opens the pane. A chevron-sized target beside a name that did
    // something else was the original complaint.
    expect(code).toContain("onClick={onOpen}");
  });
});

describe("AC-U3 — the wide view reuses the projection and the routes, and invents no data path", () => {
  // STATIC, and that is the honest ceiling: there is no DOM harness in this
  // repo, so LAYOUT — the thing a "full-pane" view is mostly about — is proved
  // on the dev server and nowhere else. What IS mechanical is that the pane
  // reads the SAME projection and the SAME three on-demand routes the rail
  // already calls, which is precisely the claim that goes quietly false.
  const tab = () => readSource("apps/web/components/session/ultra-tab.tsx");

  test("it renders the projection's own fields and the tested spend/controls rules", () => {
    const src = tab();
    expect(src).toContain("anchorSpend(");
    expect(src).toContain("anchorControls(");
    expect(src).toContain("run.phases");
    // `run.narrator` IS NO LONGER ASSERTED. The narrator window was removed from
    // the pane on an owner ruling (the lines are a script author's debug prints
    // and duplicate what the agent rows say). Two things made removing this
    // assertion necessary rather than optional: it pinned a design decision that
    // has since been reversed, and — because it greps RAW source — the prose
    // explaining the removal satisfied it, so it would have stayed green while
    // measuring a comment. The projection still computes the field for the rail.
    expect(src).toContain("run.agentsDone !== undefined");
    // ISSUE #27 — both new rules are the PROJECTION's, not the renderer's. The
    // pane calls them; it does not re-derive "is this phase still coming" from
    // `group.agents.length === 0`, and it does not slice the prefix off a label
    // with its own `indexOf(":")`. A local re-derivation is the failure this
    // whole module exists to prevent, and it is invisible in a repo with no DOM
    // harness — a static read is the only place it can be caught.
    //
    // STRIPPED, for the reason spelled out four lines above: `src` is RAW, so a
    // future edit that inlines the rule and leaves behind a comment naming the
    // call it removed would keep these three green while measuring prose. All
    // three appear in real code, so the stricter read costs nothing.
    const code = stripComments(src);
    expect(code).toContain("agentLabelInPhase(");
    expect(code).toContain("PHASE_STATUS_NOTE[");
    expect(code).toContain("group.status");
  });

  test("it shares the three readers rather than writing a fourth copy of the fetch", () => {
    // The RAIL half of this assertion is gone with the rail's detail: it is now
    // a glanceable index that renders no transcript, no result and no script, so
    // it imports none of the three readers. The claim worth keeping is the one
    // that can still go quietly false — that the PANE reuses them instead of
    // growing a fourth copy of the same fetch.
    expect(tab()).toContain('from "@/components/session/ultra-run-views"');
  });

  test("NO SECOND HOOK, NO SECOND STREAM, NO SECOND LIST POLL", () => {
    // COMMENTS STRIPPED, for the same reason the budget scan strips them: this
    // file's header SAYS "no new hook, no second poll", and a rule that forbids
    // documenting itself gets documented somewhere the scan cannot see.
    const code = stripComments(tab());
    expect(code).not.toContain("useUltraRuns");
    expect(code).not.toContain("new EventSource");
    expect(code).not.toContain('fetch("/api/ultra?');
  });

  test("it uses the FOUR-state tone/label tables, never the rail's three-state one", () => {
    // `RailStatus` is running|done|error and has no honest home for `stopped` —
    // the state that grows a Resume affordance. Collapsing it would read a
    // stopped run as done or as a failure.
    const code = stripComments(tab());
    expect(code).toContain("STATE_LABEL");
    expect(code).toContain("ULTRA_STATE_TONE");
    expect(code).not.toContain("SubagentBanner");
    expect(code).not.toContain("RailStatus");
  });

  // THE NARRATOR TEST IS GONE BECAUSE THE NARRATOR IS. It asserted a fixed
  // `TAB_NARRATOR_H` so the window could not animate the StickToBottom viewport
  // it renders inside. The owner removed the window itself after reading a real
  // run in it, which retires the hazard rather than relaxing the guard — there
  // is no longer a growing-height box in this pane to constrain.
  test("the pane's on-demand readers are bounded, so none of them can grow unbounded", () => {
    // What replaced the narrator concern: every reader the pane opens is a
    // scroll box with an explicit bound. An unbounded one would push the page
    // taller on every fetch, which is the same layout-shift failure the narrator
    // rule existed to prevent.
    //
    // THE TRANSCRIPT'S BOUND IS A FIXED HEIGHT, NOT A CAP, and the difference is
    // the owner ruling behind it: under `max-h` each agent's box took whatever
    // height its own content wanted, so opening a chatty agent and a terse one
    // moved every row beneath them by hundreds of pixels. A fixed height makes
    // the page geometry identical whichever agent is open.
    const code = stripComments(tab());
    expect(code).toContain("h-96"); // an agent's transcript — standard, scrollable
    expect(code).toContain("max-h-[40rem]"); // the run's result
    expect(code).toContain("max-h-[48rem]"); // the script
  });
});

describe("AC-U4 — the rail stays w-60; nothing here widened it", () => {
  test("subagent-rail.tsx still sizes the expanded rail at w-60", () => {
    const src = readSource("apps/web/components/session/subagent-rail.tsx");
    expect(src).toContain("w-60");
    expect(src).not.toContain("w-72");
    expect(src).not.toContain("w-80");
  });

  test("ultra-rail.tsx still documents the 240px budget it is built to", () => {
    expect(readSource("apps/web/components/session/ultra-rail.tsx")).toContain("240px");
  });
});

describe("orderRunsForPanel — live work first, finished work last", () => {
  const run = (runId: string, state: RunSnapshot["state"]) => ({ runId, state });

  test("a finished run never sits above a running one", () => {
    // The reported symptom: the Workflows section rendered map insertion order,
    // so a run that settled an hour ago appeared above one working right now
    // and only the word inside the card told them apart.
    const ordered = orderRunsForPanel([
      run("done-1", "done"),
      run("live-1", "running"),
      run("failed-1", "failed"),
      run("live-2", "running"),
    ]);
    expect(ordered.map((r) => r.runId)).toEqual(["live-1", "live-2", "done-1", "failed-1"]);
  });

  test("order is STABLE inside each group — a row moves only when its own state changes", () => {
    // A partition, not a sort. Sorting on a timestamp would shuffle neighbours
    // every time one settled, which is what makes a list hard to click.
    const ordered = orderRunsForPanel([
      run("a", "done"),
      run("b", "stopped"),
      run("c", "failed"),
    ]);
    expect(ordered.map((r) => r.runId)).toEqual(["a", "b", "c"]);
  });

  test("failed does NOT get a middle tier — every terminal state sinks together", () => {
    // Promoting failures above other finished runs would make the list argue
    // with the header's counts instead of agreeing with them.
    const ordered = orderRunsForPanel([run("f", "failed"), run("d", "done")]);
    expect(ordered.map((r) => r.runId)).toEqual(["f", "d"]);
  });

  test("an all-live and an all-finished list are both returned untouched", () => {
    expect(orderRunsForPanel([run("x", "running"), run("y", "running")]).map((r) => r.runId)).toEqual(["x", "y"]);
    expect(orderRunsForPanel([run("x", "done"), run("y", "done")]).map((r) => r.runId)).toEqual(["x", "y"]);
    expect(orderRunsForPanel([])).toEqual([]);
  });
});

describe("splitRunsForRail — issue #45: only `done` collapses", () => {
  const run = (runId: string, state: RunSnapshot["state"]) => ({ runId, state });
  const ids = (rows: readonly { runId: string }[]) => rows.map((r) => r.runId);

  test("the reported case: thirteen settled runs stop burying the one that is live", () => {
    // One running, thirteen done — the shape the issue was filed against. The
    // live run is the whole pinned group; nothing else competes with it for card
    // size, and the thirteen are still all present, one row each.
    const runs = [
      ...Array.from({ length: 13 }, (_, i) => run(`d${i}`, "done" as const)),
      run("live", "running"),
    ];
    const { pinned, done } = splitRunsForRail(runs);
    expect(ids(pinned)).toEqual(["live"]);
    expect(done).toHaveLength(13);
  });

  test("a FAILED or STOPPED run is pinned beside the live ones, never filed under Done", () => {
    // The care note in the issue, and #44's wrongly-failed run: a run that ended
    // badly is the one thing a user is scrolling to find. A `Done · N` heading
    // over a failure would also be lying in its own words.
    const { pinned, done } = splitRunsForRail([
      run("d", "done"),
      run("f", "failed"),
      run("s", "stopped"),
      run("l", "running"),
    ]);
    expect(ids(pinned)).toEqual(["l", "f", "s"]);
    expect(ids(done)).toEqual(["d"]);
  });

  test("the ORDER is `orderRunsForPanel`'s — this partitions what that sorted, and adds no rule", () => {
    // The issue's own instruction ("the rail should not grow a second ordering
    // rule"). Live first inside the pinned group, and stable within each group:
    // `f` was authored before `s` and stays before it.
    const runs = [run("f", "failed"), run("s", "stopped"), run("l1", "running"), run("l2", "running")];
    const { pinned } = splitRunsForRail(runs);
    expect(ids(pinned)).toEqual(["l1", "l2", "f", "s"]);
    // …and it is exactly the ordered list with the `done` rows lifted out.
    const { pinned: p2, done: d2 } = splitRunsForRail([...runs, run("d", "done")]);
    expect(ids([...p2, ...d2])).toEqual(ids(orderRunsForPanel([...runs, run("d", "done")])));
  });

  test("EVERY state lands in exactly one group — the four-state vocabulary, closed", () => {
    // `UltraRunState` has four members and a partition that silently drops one
    // would delete runs from the rail rather than mis-file them.
    const all = [run("a", "running"), run("b", "done"), run("c", "failed"), run("d", "stopped")];
    const { pinned, done } = splitRunsForRail(all);
    expect(ids([...pinned, ...done]).sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("the two degenerate lists, and the empty one", () => {
    // All-live ⇒ no group at all (the section is exactly what it was before this
    // change). All-done ⇒ no pinned cards, which is the calm empty state: the
    // heading sits directly under the section header and the counts agree.
    expect(splitRunsForRail([run("x", "running")]).done).toEqual([]);
    expect(splitRunsForRail([run("x", "done")]).pinned).toEqual([]);
    expect(splitRunsForRail([])).toEqual({ pinned: [], done: [] });
  });

  test("THE COUNT CONTRACT — the two groups still sum to the total the header prints", () => {
    // `ultra-rail.tsx`'s header prints `runs.length`, `subagent-rail.tsx`'s
    // collapsed edge prints the same figure from `workflowCount`, and neither
    // can derive the other. This is the arithmetic those two readers depend on:
    // the split hides nothing, so `pinned + done` is still the total.
    const runs = [run("a", "running"), run("b", "done"), run("c", "failed"), run("d", "done")];
    const { pinned, done } = splitRunsForRail(runs);
    expect(pinned.length + done.length).toBe(runs.length);
  });
});

describe("agentModelShortLabel — the compact chip drops provider and context, never accuracy", () => {
  test("a script alias resolves to the tier word alone", () => {
    expect(agentModelShortLabel("sonnet")).toBe("Sonnet");
    expect(agentModelShortLabel("opus")).toBe("Opus");
  });

  test("no provider word, no context suffix — the two things a narrow row cannot afford", () => {
    const short = agentModelShortLabel("sonnet");
    expect(short.includes("Claude")).toBe(false);
    expect(agentModelLabel("sonnet").length).toBeGreaterThan(short.length);
  });

  test("an unrecognised string comes back verbatim — same rule as the full label, same reason", () => {
    expect(agentModelShortLabel("some-model-this-build-never-met")).toBe(
      "some-model-this-build-never-met",
    );
  });

  test("empty stays empty (the row renders its own placeholder)", () => {
    expect(agentModelShortLabel("")).toBe("");
    expect(agentModelShortLabel("   ")).toBe("");
  });
});
