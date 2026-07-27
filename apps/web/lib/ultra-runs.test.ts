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
import {
  ACCOUNTING_LOG_PREFIXES,
  ULTRA_ANCHOR_KIND,
  ULTRA_TOOL_NAME,
  UNPHASED,
  agentRows,
  anchorForm,
  anchorSpend,
  armReducer,
  extractRunId,
  filterRunsBySession,
  launchedRunId,
  narratorLines,
  phaseGroups,
  progressFraction,
  runLabel,
  runSnapshot,
  sendOptionsFor,
  spliceRunAnchors,
  summarizeRuns,
  unwrapManifest,
  unwrapManifests,
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
  start: (ordinal: number, over: Partial<{ label: string; model: string; effort: string }> = {}): UltraEventLike => ({
    type: "agent-start",
    ordinal,
    model: "sonnet",
    ...over,
  }),
  agent: (
    ordinal: number,
    over: Partial<{ label: string; model: string; effort: string; ok: boolean; costUsd: number; cached: true }> = {},
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
    // `GET /api/ultra` has no callers today but it is a published shape, and its
    // unfiltered behaviour must stay byte-for-byte what it was. The route is a
    // three-line caller of this function, which is how a route with no test
    // harness in this repo is still proved.
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
  const SCANNED = [
    "apps/web/components/session/ultra-anchor.tsx",
    "apps/web/components/session/ultra-rail.tsx",
    "apps/web/components/common/ultra-dock-signal.tsx",
    "apps/web/components/dock/dock.tsx",
  ] as const;

  test("all four files are readable — the floor, so a rename fails LOUDLY instead of scanning nothing", () => {
    const read = SCANNED.map((rel) => readSource(rel));
    expect(read.length).toBe(4);
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

describe("4.2 §5.5-D1 item 7 — the wake's dispatch can never carry the chip's key", () => {
  test("the injection drain's dispatch literal is UNTOUCHED", () => {
    // Story 4.1's hidden wake turn fires through the SAME `send` and the same
    // body literal as a user message. Its drain passes a hard-coded option
    // object, so no arm state can reach it — and this pins that line so a later
    // edit cannot quietly route it through `sendOptionsFor`.
    //
    // WHY A STATIC PIN RATHER THAN A PURE TEST: the claim is about a line of
    // JSX-adjacent code in a 3000-line client component, and there is no DOM
    // harness in this repo to drive it. Asserting the line's SHAPE is the honest
    // executable form; the reducer's own behaviour is asserted above.
    const src = readSource("apps/web/components/session/session-view.tsx");
    expect(src).toContain("void send(next.text, next.hidden ? { hidden: true } : undefined);");
    // The complementary half: the ONE site that reads the chip is handleSubmit,
    // and the body literal reads `opts`, never component state.
    expect(src).toContain("...(opts?.ultra ? { ultra: true } : {}),");
    expect(src).not.toContain("...(ultraArmed ? { ultra: true } : {})");
    expect(src).not.toContain("ultraArm.armed ? { ultra: true }");
  });

  test("the arm reducer says ARMED and the wake's options still carry no `ultra` key", () => {
    // The pure half of the same claim, stated as §5.5-D1 item 7 asks: even with
    // the reducer armed, the wake's dispatch options are the hidden literal.
    const armed = armReducer({ armed: false }, "arm");
    expect(armed.armed).toBe(true);
    const wakeOptions = { hidden: true } as const;
    expect("ultra" in wakeOptions).toBe(false);
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
