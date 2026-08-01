// Story 4.1 — the wake's pure delivery seam (AC1, AC2). No DOM, no disk, no
// core import: everything here is a function of its arguments, which is exactly
// why the seam exists as its own module.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig can't resolve it — suppress just the import.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  ULTRA_WAKE_PROMPT,
  ULTRA_WAKE_SENTINEL,
  appendixCarriesUltraWake,
  formatUltraWakeAppendix,
  freshUltraWakes,
  shouldEnqueueUltraWake,
  isUltraWakeTrigger,
  resolveUltraWakeMessage,
  wakeOutcomeAllowance,
  WAKE_OUTCOME_BUDGET,
  WAKE_OUTCOME_CEILING,
  WAKE_OUTCOME_FLOOR,
  type UltraWakeSummary,
} from "./ultra-wake";

const wake = (over: Partial<UltraWakeSummary> = {}): UltraWakeSummary => ({
  runId: "run_1",
  name: "nightly sweep",
  state: "done",
  spendUsd: 1.5,
  ...over,
});

describe("ultra wake — the recognizer (AC1)", () => {
  test("the sentinel on an existing session IS a wake trigger", () => {
    expect(isUltraWakeTrigger("sess-1", ULTRA_WAKE_SENTINEL)).toBe(true);
  });

  test("T11 — the sentinel with an EMPTY sessionId is NOT a trigger", () => {
    // THE TRAP THIS TEST EXISTS FOR. escalation-kickoff.ts's
    // `isEscalationKickoff` gates on `!sessionId` ("a kickoff is always turn 1").
    // A wake is structurally the reverse — it belongs to a run whose manifest
    // already names a session — so a faithful line-for-line copy of the template
    // would produce a recognizer that is FALSE on every legitimate wake and TRUE
    // only here. This asserts the inversion rather than trusting it.
    expect(isUltraWakeTrigger("", ULTRA_WAKE_SENTINEL)).toBe(false);
    expect(isUltraWakeTrigger(null, ULTRA_WAKE_SENTINEL)).toBe(false);
    expect(isUltraWakeTrigger(undefined, ULTRA_WAKE_SENTINEL)).toBe(false);
  });

  test("an ordinary user turn is never a trigger, whatever it says", () => {
    expect(isUltraWakeTrigger("sess-1", "how did the ultra run go?")).toBe(false);
    expect(isUltraWakeTrigger("sess-1", "")).toBe(false);
    expect(isUltraWakeTrigger("sess-1", `  ${ULTRA_WAKE_SENTINEL}  `)).toBe(false);
    expect(isUltraWakeTrigger("sess-1", `${ULTRA_WAKE_SENTINEL} and also`)).toBe(false);
    // Non-string wire values collapse to false rather than throwing.
    expect(isUltraWakeTrigger("sess-1", undefined)).toBe(false);
    expect(isUltraWakeTrigger("sess-1", 42)).toBe(false);
    expect(isUltraWakeTrigger("sess-1", { message: ULTRA_WAKE_SENTINEL })).toBe(false);
  });

  test("the swap is byte-identical for every non-trigger turn", () => {
    expect(resolveUltraWakeMessage("sess-1", ULTRA_WAKE_SENTINEL)).toBe(ULTRA_WAKE_PROMPT);
    expect(resolveUltraWakeMessage("sess-1", "hello")).toBe("hello");
    expect(resolveUltraWakeMessage("", ULTRA_WAKE_SENTINEL)).toBe(ULTRA_WAKE_SENTINEL);
    expect(resolveUltraWakeMessage(null, "hello")).toBe("hello");
  });

  test("the sentinel is opaque enough that a human cannot type it by accident", () => {
    expect(ULTRA_WAKE_SENTINEL).toMatch(/^__telar_/);
    expect(ULTRA_WAKE_SENTINEL).not.toContain(" ");
    // …and it is not the escalation one. Two sentinels, two branches; a shared
    // value would make each recognizer fire on the other's turn.
    expect(ULTRA_WAKE_SENTINEL).not.toBe("__telar_escalation_kickoff__");
  });

  test("the server-authored prompt tells the model NOT to poll — AC2's 'without calling ultra_status' — with ONE named exception", () => {
    // The default is unchanged: do not re-read an outcome you already have.
    expect(ULTRA_WAKE_PROMPT).toContain("ultra_status");
    expect(ULTRA_WAKE_PROMPT.toLowerCase()).toContain("do not call");
    // The exception is NAMED, because the appendix now clips a large outcome
    // and says so — an unconditional ban would make that truncation permanent.
    expect(ULTRA_WAKE_PROMPT).toContain("truncated");
    // …and it comes AFTER the discouragement, in ONE string, so a model reading
    // only the first half cannot conclude the exception does not exist.
    expect(ULTRA_WAKE_PROMPT.indexOf("truncated")).toBeGreaterThan(
      ULTRA_WAKE_PROMPT.toLowerCase().indexOf("do not call"),
    );
  });
});

describe("ultra wake — the appendix formatter (AC1 proof 5, AC2)", () => {
  test("the empty case is EXACTLY '' — never a stray header", () => {
    // This composes on every chat POST for every session, so the common case is
    // no wakes. A lone heading with nothing under it is an instruction to talk
    // about nothing.
    expect(formatUltraWakeAppendix([])).toBe("");
  });

  test("a `done` wake renders its RESULT", () => {
    const out = formatUltraWakeAppendix([wake({ result: { files: 12, ok: true } })]);
    expect(out).toContain("COMPLETED ULTRA RUNS");
    expect(out).toContain("nightly sweep");
    expect(out).toContain("run_1");
    expect(out).toContain("done");
    expect(out).toContain('"files": 12');
    expect(out).not.toContain("error:");
  });

  test("a `failed` wake renders its ERROR", () => {
    const out = formatUltraWakeAppendix([
      wake({ state: "failed", error: "step 3 threw: ENOENT" }),
    ]);
    expect(out).toContain("failed");
    expect(out).toContain("step 3 threw: ENOENT");
    expect(out).not.toContain("result:");
  });

  test("a `stopped` wake renders NEITHER, and says so", () => {
    // A stop has no resolved value and no failure. Inventing one is a cue to
    // summarize something that does not exist.
    const out = formatUltraWakeAppendix([
      wake({ state: "stopped", result: { should: "not appear" }, error: "should not appear" }),
    ]);
    expect(out).toContain("stopped");
    expect(out).toContain("no result and no error");
    expect(out).not.toContain("should not appear");
  });

  test("a `done` wake that returned nothing says so rather than printing undefined", () => {
    const out = formatUltraWakeAppendix([wake({ result: undefined })]);
    expect(out).toContain("returned nothing");
    expect(out).not.toContain("undefined");
  });

  test("a `failed` wake with no error text still says it failed", () => {
    const out = formatUltraWakeAppendix([wake({ state: "failed", error: "   " })]);
    expect(out).toContain("failed");
    expect(out).toContain("recorded no error text");
  });

  test("a string result is rendered verbatim, not JSON-quoted", () => {
    const out = formatUltraWakeAppendix([wake({ result: "all 12 checks passed" })]);
    expect(out).toContain("all 12 checks passed");
    expect(out).not.toContain('"all 12 checks passed"');
  });

  test("T10 — three finished runs ride ONE appendix", () => {
    // The client fires one trigger per pass; the formatter is what makes that
    // sufficient. A design where each wake needed its own turn would fire three.
    const out = formatUltraWakeAppendix([
      wake({ runId: "run_a", name: "alpha", state: "done", result: "A" }),
      wake({ runId: "run_b", name: "beta", state: "failed", error: "B broke" }),
      wake({ runId: "run_c", name: "gamma", state: "stopped" }),
    ]);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
    expect(out).toContain("B broke");
    // One header, three runs.
    expect(out.match(/COMPLETED ULTRA RUNS/g)).toHaveLength(1);
    expect(out.match(/^• /gm)).toHaveLength(3);
  });

  test("the block is BOUNDED — a huge result cannot swell every turn's system prompt", () => {
    // RE-PINNED DELIBERATELY, name and intent unchanged. The flat 1200-char clip
    // became a shared budget (WAKE_OUTCOME_BUDGET split across the runs present,
    // clamped to [FLOOR, CEILING]), so the numbers moved and the property did
    // not: one huge run is bounded, and three huge runs are bounded by the SAME
    // total rather than by three times a per-run constant.
    const huge = "x".repeat(500_000);
    const out = formatUltraWakeAppendix([wake({ result: huge })]);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(WAKE_OUTCOME_CEILING + 1_000);
    const three = formatUltraWakeAppendix([
      wake({ runId: "a", result: huge }),
      wake({ runId: "b", result: huge }),
      wake({ runId: "c", result: huge }),
    ]);
    expect(three.length).toBeLessThan(WAKE_OUTCOME_BUDGET + 2_000);
  });

  test("the truncation notice names the omitted count AND how to recover the text", () => {
    // AC-E1: when clipping happens the block must SAY SO and say how to get the
    // rest — the old `…(truncated)` said neither, and ULTRA_WAKE_PROMPT then
    // forbade the only recovery there is.
    const out = formatUltraWakeAppendix([wake({ result: "x".repeat(500_000) })]);
    expect(out).toContain("characters omitted");
    expect(out).toContain('ultra_status("run_1")'); // the run's OWN id, not a generic word
  });

  test("a result that FITS is not truncated at all — the raise is real, not a re-worded clip", () => {
    // 4000 chars was cut mid-sentence under the old flat 1200 cap.
    const body = "y".repeat(4_000);
    const out = formatUltraWakeAppendix([wake({ result: body })]);
    expect(out).toContain(body);
    // The header now NAMES truncation as an exception, so the bare word is not
    // the discriminator — the NOTICE is.
    expect(out).not.toContain("characters omitted");
  });

  test("the per-run allowance SHRINKS as the mailbox grows, and never below the old 1200 floor", () => {
    const huge = "z".repeat(500_000);
    const rendered = (n: number) => {
      const list = Array.from({ length: n }, (_, i) => wake({ runId: `r${i}`, result: huge }));
      return formatUltraWakeAppendix(list).length / n;
    };
    expect(rendered(1)).toBeGreaterThan(rendered(3));
    expect(rendered(3)).toBeGreaterThan(rendered(20));
    expect(wakeOutcomeAllowance(1)).toBe(WAKE_OUTCOME_CEILING);
    expect(wakeOutcomeAllowance(20)).toBe(WAKE_OUTCOME_FLOOR);
    expect(wakeOutcomeAllowance(1_000)).toBe(WAKE_OUTCOME_FLOOR); // never worse than today
  });

  test("a WATCHED run is marked; an unwatched one renders exactly as before", () => {
    // The visible half of ultra_watch — without it the tool would be a placebo.
    const watched = formatUltraWakeAppendix([wake({ watched: true })]);
    expect(watched).toContain("you asked to be told about this one");
    const plain = formatUltraWakeAppendix([wake()]);
    expect(plain).not.toContain("you asked to be told");
    expect(plain).toBe(formatUltraWakeAppendix([wake({ watched: false })]));
  });

  test("an unserializable result degrades to a note rather than throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatUltraWakeAppendix([wake({ result: circular })])).not.toThrow();
    expect(formatUltraWakeAppendix([wake({ result: circular })])).toContain(
      "could not be serialized",
    );
    // A BigInt is the other JSON.stringify throw, and it is reachable from a
    // script that counted something large. Built with BigInt() rather than a
    // `1n` literal: this workspace's tsconfig targets below ES2020, so the
    // literal form is a compile error under `bunx tsc --noEmit` here.
    expect(() => formatUltraWakeAppendix([wake({ result: { n: BigInt(1) } })])).not.toThrow();
  });

  test("the spend rides along, in the run's own USD figure", () => {
    // AC5's manifest figure, restated to the model so it can answer "what did it
    // cost" without a tool call. Ultra is Claude-only today (route.ts builds the
    // ultra MCP server on the non-Codex branch), so USD is the only language a
    // run's own spend has ever had.
    expect(formatUltraWakeAppendix([wake({ spendUsd: 2.5 })])).toContain("$2.5000");
  });
});

describe("ultra wake — the delivery gate (review SF-3)", () => {
  // WHY THIS EXISTS. AC7's exactly-once is a claim about DELIVERY, not about a
  // turn having happened. The route's pre-stream ack originally consumed
  // everything `pendingUltraWakes` returned, on the assumption that the appendix
  // it was composed beside must have carried it. Two ways that is false and both
  // are reachable: `ultraWakeAppendix` wraps its read in `safeLiveContext`, which
  // degrades a failed read to ""; and `runCodexTurn` takes no `systemPrompt`, so
  // a Codex turn discards the appendix wholesale. Either way the wake would be
  // stamped delivered having been delivered ZERO times — the one outcome
  // wake.ts's header says is impossible. The route now asks the composed prompt
  // itself, through this predicate.
  test("a run rendered into the appendix is reported as carried", () => {
    const appendix = formatUltraWakeAppendix([wake({ runId: "u-abc123" })]);
    expect(appendixCarriesUltraWake(appendix, "u-abc123")).toBe(true);
  });

  test("a run that is NOT in the appendix is not carried — the SF-3 case", () => {
    // The superset case: the composer read first, this run settled after, the
    // ack's second read sees it. It must not be consumed on this turn.
    const appendix = formatUltraWakeAppendix([wake({ runId: "u-first" })]);
    expect(appendixCarriesUltraWake(appendix, "u-second")).toBe(false);
  });

  test("an EMPTY appendix carries nothing — the failed-read and Codex cases", () => {
    expect(appendixCarriesUltraWake("", "u-abc123")).toBe(false);
    expect(appendixCarriesUltraWake(formatUltraWakeAppendix([]), "u-abc123")).toBe(false);
  });

  test("a run's own RESULT TEXT cannot answer for another run", () => {
    // Found by the fix round's own adversarial verification, which is the point
    // of running one. The appendix embeds an Ultra script's arbitrary return
    // value, so a whole-string `includes` let a run that merely PRINTED
    // "(run u-other)" mark u-other as carried — and on the ack path that means
    // consuming a wake the model was never shown, the delivered-zero-times case
    // this predicate exists to prevent. Scoping to the formatter's own bullet
    // line is the fix.
    const appendix = formatUltraWakeAppendix([
      wake({ runId: "u-real", result: "I inspected (run u-ghost) and it looked fine" }),
    ]);
    expect(appendix).toContain("(run u-ghost)");
    expect(appendixCarriesUltraWake(appendix, "u-real")).toBe(true);
    expect(appendixCarriesUltraWake(appendix, "u-ghost")).toBe(false);
  });

  test("a run's NAME cannot answer for another run either", () => {
    // The name rides the same bullet line the marker does, so this is the arm
    // the line-scoping does NOT close by itself — it is closed by the marker
    // needing its own parentheses. Pinned so a future "just match the id"
    // simplification fails here.
    const appendix = formatUltraWakeAppendix([
      wake({ runId: "u-real", name: "sweep for u-ghost" }),
    ]);
    expect(appendixCarriesUltraWake(appendix, "u-real")).toBe(true);
    expect(appendixCarriesUltraWake(appendix, "u-ghost")).toBe(false);
  });

  test("a TRUNCATION NOTICE can never make a run look carried", () => {
    // THE REGRESSION GUARD FOR THE E4 RAISE. The notice names a runId and sits
    // inside a bullet's sub-lines; if it ever started with the BULLET and carried
    // a `(run …)` marker, one run's truncation would ack another run's delivery.
    const appendix = formatUltraWakeAppendix([
      wake({ runId: "run_a", result: "q".repeat(500_000) }),
    ]);
    expect(appendix).toContain("truncated");
    expect(appendixCarriesUltraWake(appendix, "run_b")).toBe(false);
    // …and the run whose bullet IS present stays carried, truncated or not —
    // that is what route.ts acks on.
    expect(appendixCarriesUltraWake(appendix, "run_a")).toBe(true);
  });

  test("a WATCHED marker does not disturb the ack predicate either", () => {
    const appendix = formatUltraWakeAppendix([wake({ runId: "run_w", watched: true })]);
    expect(appendixCarriesUltraWake(appendix, "run_w")).toBe(true);
    expect(appendixCarriesUltraWake(appendix, "run_x")).toBe(false);
  });

  test("the marker is anchored, so one run id cannot answer for another", () => {
    // THE DISCRIMINATOR. A bare `appendix.includes(runId)` would pass every
    // assertion above and still be wrong: ultra ids share a prefix, and a
    // substring match would let a longer id's presence ack a shorter one. The
    // marker's parenthesis and the `run ` word are what make the match exact.
    const appendix = formatUltraWakeAppendix([wake({ runId: "u-abc123def" })]);
    expect(appendix).toContain("u-abc123def");
    expect(appendixCarriesUltraWake(appendix, "u-abc123")).toBe(false);
    expect(appendixCarriesUltraWake(appendix, "")).toBe(false);
  });
});

describe("ultra wake — the announce latch (review SF-1)", () => {
  const ids = (s: Set<string>) => [...s].sort();

  test("a first pending run is fresh, and then is not", () => {
    const one = freshUltraWakes(new Set(), ["A"]);
    expect(one.fresh).toEqual(["A"]);
    expect(ids(one.announced)).toEqual(["A"]);
    // Still pending because the route has not acked yet — it must NOT re-fire.
    const two = freshUltraWakes(one.announced, ["A"]);
    expect(two.fresh).toEqual([]);
  });

  test("T10 — several runs finishing in one poll are ONE announcement", () => {
    // The appendix's formatter takes a list, so three finished runs are three
    // bullets on one turn, never three turns. `fresh` is non-empty exactly once.
    const r = freshUltraWakes(new Set(), ["A", "B", "C"]);
    expect(r.fresh).toEqual(["A", "B", "C"]);
    expect(freshUltraWakes(r.announced, ["A", "B", "C"]).fresh).toEqual([]);
  });

  test("SF-1 — a SECOND run settling while the first is unacked is fresh", () => {
    // THE BUG THIS PINS, and it shipped. The latch used to be a boolean cleared
    // only by an EMPTY mailbox. Run A settles and its wake turn streams for 30s;
    // run B settles a second later (several runs can be live for one session —
    // §5.6-T10's premise, bounded by ultra's `RUN_CONCURRENCY = 3`); every
    // subsequent poll returns [A, B], the
    // mailbox is never empty, the boolean never cleared, and B was never
    // announced — so when the session went idle no unprompted turn ever appeared
    // for it and AC1 was unmet for that run.
    const first = freshUltraWakes(new Set(), ["A"]);
    expect(first.fresh).toEqual(["A"]);
    const second = freshUltraWakes(first.announced, ["A", "B"]);
    expect(second.fresh).toEqual(["B"]);
    expect(ids(second.announced)).toEqual(["A", "B"]);
  });

  test("an acked run is forgotten, so a RESUMED run under the same id re-arms", () => {
    // `deliveredTerminalAt` scopes the delivery stamp to a terminal, so a run
    // stopped, edited and resumed becomes pending again under its ORIGINAL id.
    // The latch has to let that through or the resume's real outcome is lost on
    // the client side after being made reachable on the server side.
    const fired = freshUltraWakes(new Set(), ["A"]);
    const acked = freshUltraWakes(fired.announced, []);
    expect(acked.fresh).toEqual([]);
    expect(ids(acked.announced)).toEqual([]);
    expect(freshUltraWakes(acked.announced, ["A"]).fresh).toEqual(["A"]);
  });

  test("forgetting is scoped to the run that left, not to the mailbox emptying", () => {
    // THE DISCRIMINATOR for the fix. "Clear everything whenever the set changes"
    // would pass every test above and re-announce A on the very next poll here.
    const both = freshUltraWakes(new Set(), ["A", "B"]);
    const onlyA = freshUltraWakes(both.announced, ["A"]);
    expect(onlyA.fresh).toEqual([]);
    expect(ids(onlyA.announced)).toEqual(["A"]);
  });

  test("the caller's set is never mutated", () => {
    // session-view holds this in a ref across renders; pruning in place would
    // make the prune observable before the assignment.
    const held = new Set(["A"]);
    freshUltraWakes(held, ["B"]);
    expect(ids(held)).toEqual(["A"]);
  });

  test("a duplicate id within one poll counts once", () => {
    expect(freshUltraWakes(new Set(), ["A", "A"]).fresh).toEqual(["A"]);
  });
});

describe("ultra wake — T10 over time: the two latch rules together", () => {
  // WHY THIS TEST EXISTS, and it is the whole lesson of story 4.1's review round
  // stated as a fixture. Both client-side defects the review found — SF-1 (a
  // second run never announced) and the T10 regression the FIX for SF-1 then
  // introduced (a surplus trigger firing a hidden turn against an empty
  // appendix) — are properties of the latch OVER TIME, invisible to any
  // single-call assertion, and both were found by reading because nothing
  // executed them. So the rules are driven here across a poll timeline.
  //
  // The two rules under test are the REAL exports. What is transcribed is only
  // the surrounding traffic: a 4s poll, the §6.D drain's one-at-a-time dispatch,
  // session-view's SF-2 drop-guard (which reads the possibly-stale poll
  // snapshot, deliberately — that staleness is why the enqueue rule exists), and
  // the route's pre-stream ack of exactly what the appendix carried. If
  // session-view stops spelling those the same way, this stops modelling it —
  // which is the honest limit of a test in a workspace with no DOM renderer.
  type Sim = {
    settles: { at: number; runId: string }[];
    blocked?: [number, number]; // the §1b reconnect tail: composer ready, drain not
    turnMs: number;
    until: number;
  };

  const drive = (s: Sim) => {
    const terminal = new Set<string>();
    const delivered = new Set<string>();
    const stillPending = () => [...terminal].filter((r) => !delivered.has(r));

    let snapshot: string[] = [];
    let queue: { id: string; text: string }[] = [];
    let announced = new Set<string>();
    let seq = 0;
    let turnEndsAt: number | null = null;
    const turns: string[][] = [];

    for (let t = 0; t <= s.until; t += 100) {
      for (const x of s.settles) if (x.at === t) terminal.add(x.runId);
      if (t % 4000 === 0) {
        snapshot = stillPending();
        const r = freshUltraWakes(announced, snapshot);
        announced = r.announced;
        if (shouldEnqueueUltraWake(r.fresh, queue)) {
          queue = [...queue, { id: `uw${seq++}`, text: ULTRA_WAKE_SENTINEL }];
        }
      }
      if (turnEndsAt !== null && t >= turnEndsAt) turnEndsAt = null;
      const blocked = !!s.blocked && t >= s.blocked[0] && t < s.blocked[1];
      if (turnEndsAt === null && !blocked && queue.length > 0) {
        const [next, ...rest] = queue;
        queue = rest;
        if (next.text === ULTRA_WAKE_SENTINEL && snapshot.length === 0) continue;
        const carried = stillPending();
        for (const r of carried) delivered.add(r);
        turns.push(carried);
        turnEndsAt = t + s.turnMs;
      }
    }
    return {
      turns,
      // A turn that carried nothing is a hidden turn told to summarise a block
      // its prompt does not contain. Never acceptable.
      spurious: turns.filter((c) => c.length === 0).length,
      // A terminal run nobody ever spoke about. AC1 unmet for it.
      stranded: stillPending(),
    };
  };

  test("SF-1 — a run settling while an earlier wake turn streams still gets a turn", () => {
    const r = drive({
      settles: [
        { at: 0, runId: "A" },
        { at: 1000, runId: "B" },
      ],
      turnMs: 30_000,
      until: 80_000,
    });
    expect(r.stranded).toEqual([]);
    expect(r.spurious).toBe(0);
    expect(r.turns).toEqual([["A"], ["B"]]);
  });

  test("T10 — runs finishing while the drain is BLOCKED are one turn, not several", () => {
    // THE REGRESSION PIN. Remove `shouldEnqueueUltraWake`'s queue check and this
    // fails with three turns, two of them carrying nothing: with the drain held
    // by the reconnect tail, each poll that sees a new run queues its own
    // trigger, and the first turn to dispatch acks all of them.
    const r = drive({
      settles: [
        { at: 0, runId: "A" },
        { at: 4100, runId: "B" },
        { at: 8100, runId: "C" },
      ],
      blocked: [0, 12_000],
      turnMs: 500,
      until: 40_000,
    });
    expect(r.spurious).toBe(0);
    expect(r.stranded).toEqual([]);
    expect(r.turns).toEqual([["A", "B", "C"]]);
  });

  test("T10 — a run settling a poll AFTER the first was acked is its own turn", () => {
    // The discriminator against over-correcting: "never enqueue a second
    // trigger" would pass the test above and strand C here.
    const r = drive({
      settles: [
        { at: 0, runId: "A" },
        { at: 100, runId: "B" },
        { at: 20_000, runId: "C" },
      ],
      turnMs: 1000,
      until: 60_000,
    });
    expect(r.spurious).toBe(0);
    expect(r.stranded).toEqual([]);
    expect(r.turns).toEqual([["A"], ["B"], ["C"]]);
  });
});
