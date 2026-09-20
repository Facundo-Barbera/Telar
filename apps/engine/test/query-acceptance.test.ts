/**
 * ISSUE #516'S ACCEPTANCE, MEASURED — the byte table and the latency proof.
 *
 * The issue asks for three things and this file is all three:
 *
 *   1. The byte size of each query answer at DEFAULT arguments, on an engine of
 *      300 sessions with a 60,000-event journal.
 *   2. Before/after latency of `outline` on the largest session, which must not
 *      fold events per call.
 *   3. #515's fixture test, extended to these reads.
 *
 * `query-fixture.ts` carries the fixture and the fold control, and its header
 * argues why this one is a REAL store where `tool-budgets.test.ts` is right to
 * use a fake.
 *
 * ══ THE PART THAT IS NOT A MEASUREMENT: FALSIFYING THE INSTRUMENT ══
 *
 * A performance suite in this repository's recent history passed all six of its
 * tests WITH THE CLOCK FROZEN AT ZERO, and a CI guard that "proved" a block had
 * run was satisfied by a SKIPPED test printing its own name. Both were green
 * for as long as anybody looked. So two of the tests below are not about
 * `turnOutline` at all — they are about whether the instrument above can report
 * a bad result, and they are the reason the numbers in the PR are worth
 * reading:
 *
 *   - `the clock is not frozen` prices a known load and requires the reading to
 *     MOVE. A frozen clock measures every reader at 0 ms, every ratio becomes
 *     0/0, and every comparison below passes. This is the failure that already
 *     happened here, caught on purpose.
 *   - `the check rejects a reader that does fold` runs the SAME predicate
 *     against `outline` deliberately made slow, and requires it to say no. A
 *     check only ever seen passing is a check nobody has seen work.
 *
 * Both follow `docs/operations/dispatch-board.md` §3: prefer a COUNT the
 * failure state cannot produce over a string both states emit. The floor on the
 * control (`bigMs > FOLD_FLOOR_MS`) is such a count — a frozen clock cannot
 * produce it, and a loaded runner only makes it larger, so the assertion is
 * asymmetric in the safe direction. Nothing here puts a millisecond CEILING on
 * the fast path, because that is an assertion about how busy the machine is.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionQueryTools } from "./../src/sessions-tools/query";
import { startEngine, type EngineDaemon } from "./../src/daemon";
import { collectTools, type SocketTool } from "./../src/mcp-socket";
import { stubModels } from "./stub-models";
import {
  ANSWER_CHARS,
  BIG_JOURNAL,
  BIG_SESSION,
  CONTROL_SESSION,
  ITEMS_PER_TURN,
  JOURNAL_GROWTH,
  MEASURED_TURNS,
  OUTLINE_BATCH,
  PROJECT,
  SESSIONS,
  SMALL_JOURNAL,
  TRACKS_JOURNAL,
  foldOutline,
  isFlat,
  measure,
  ratio,
  rounds,
  seedQueryFixture,
  type Shape,
} from "./query-fixture";

/** The outline's default page — `OUTLINE_PAGE_DEFAULT` in `daemon.ts`, which is
 *  the number every measurement here is taken at. */
const OUTLINE_LIMIT = 20;

/**
 * THE CONTROL'S FLOOR, IN MILLISECONDS, and the only absolute time in the file.
 *
 * It is asserted on the SLOW path, never the fast one, and that asymmetry is
 * the point: a busy runner pushes this number UP, so load can never make the
 * assertion fail for the wrong reason. What it rules out is the frozen clock —
 * folding 60,000 events cannot take under a millisecond, so a reading below
 * this is the instrument speaking, not the code.
 */
const FOLD_FLOOR_MS = 1;

/** Rounds of arithmetic that cannot take under a millisecond on any machine
 *  that can run bun — see `rounds`, which burns fixed WORK rather than watching
 *  the clock it is here to check. */
const HEAVY_ROUNDS = 20_000_000;
const LIGHT_ROUNDS = 1_000;

let daemon: EngineDaemon;
let home: string;
/** Every answer this file measured, printed once at the end as the table the
 *  issue asks for — so the PR's numbers and CI's numbers have one author. */
const table: Array<{ answer: string; bytes: number; note: string }> = [];

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-query-acceptance-"));
  fs.writeFileSync(path.join(home, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  daemon = await startEngine({ models: stubModels, engineRoot: home, executionStorage: "sqlite" });
  seedQueryFixture(daemon.store);
}, 120_000);

afterAll(async () => {
  await daemon?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  if (table.length > 0) {
    const width = Math.max(...table.map((row) => row.answer.length));
    const lines = table
      .sort((a, b) => a.answer.localeCompare(b.answer))
      .map((row) => `  ${row.answer.padEnd(width)}  ${String(row.bytes).padStart(6)} B   ${row.note}`);
    console.log(`\n#516 — answer sizes at default arguments, ${SESSIONS} sessions / ${BIG_JOURNAL}-event journal:\n${lines.join("\n")}\n`);
  }
});

const get = async (route: string): Promise<{ status: number; bytes: number; body: Record<string, unknown> }> => {
  const { host, port, token } = daemon.discovery;
  const answer = await fetch(`http://${host}:${port}${route}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await answer.text();
  return { status: answer.status, bytes: Buffer.byteLength(text, "utf8"), body: JSON.parse(text) as Record<string, unknown> };
};

/**
 * THE FIXTURE IS WHAT IT SAYS IT IS.
 *
 * Asserted rather than assumed, because every number below is a claim ABOUT
 * this fixture and a byte table taken from three sessions and six events would
 * look exactly as green. These are counts the wrong fixture cannot produce.
 */
describe("the fixture the numbers are taken on", () => {
  test(`is ${SESSIONS} sessions with a ${BIG_JOURNAL}-event journal on the largest`, () => {
    const store = daemon.store;
    expect(store.listSessions(PROJECT).length).toBe(SESSIONS + 1); // the 300, plus the control
    expect(store.eventCursor(BIG_SESSION)).toBeGreaterThanOrEqual(BIG_JOURNAL);
    expect(store.eventCursor(CONTROL_SESSION)).toBeGreaterThanOrEqual(SMALL_JOURNAL);
    // The control is the SHORT end and must stay that way, or the comparison
    // below is being read backwards.
    expect(store.eventCursor(CONTROL_SESSION)).toBeLessThan(store.eventCursor(BIG_SESSION) / 5);
    // Turn for turn identical, which is what makes the journal the only
    // variable between the two readings.
    expect(store.turnOutline(BIG_SESSION, { limit: 200 }).total).toBe(MEASURED_TURNS + 1);
    expect(store.turnOutline(CONTROL_SESSION, { limit: 200 }).total).toBe(MEASURED_TURNS + 1);
  });
});

/**
 * ══ THE BYTE TABLE ══
 *
 * Every answer at the arguments a caller passes when it passes none. The
 * ceilings are the issue's own budgets where it states one and the measured
 * size plus headroom where it does not; a route that grows past its ceiling
 * fails here rather than in somebody's context window, which is #515's whole
 * argument one layer down.
 */
describe("every query answer is bounded at default arguments", () => {
  const record = (answer: string, bytes: number, note: string): void => { table.push({ answer, bytes, note }); };

  test("outline — the issue's 6 KB a page, on the largest session", async () => {
    const answer = await get(`/v2/sessions/${BIG_SESSION}/outline`);
    record("GET /outline", answer.bytes, `${(answer.body.turns as unknown[]).length} of ${OUTLINE_LIMIT} rows; byte-bound`);
    expect(answer.status).toBe(200);
    expect(answer.bytes).toBeLessThan(6_500);
    // BYTE-BOUND, NOT ROW-BOUND, which is the worst case worth reporting: the
    // page stops short of its row limit because the rows are full-length.
    expect((answer.body.turns as unknown[]).length).toBeLessThan(OUTLINE_LIMIT);
    expect(answer.body.more).toBe(true);
  });

  test("find — ten rows across 300 sessions, under the issue's 3 KB", async () => {
    const answer = await get("/v2/sessions/find?q=appearance");
    record("GET /find?q=", answer.bytes, `${(answer.body.sessions as unknown[]).length} rows, ${String(answer.body.index)} index`);
    expect(answer.status).toBe(200);
    expect((answer.body.sessions as unknown[]).length).toBe(10);
    expect(answer.bytes).toBeLessThan(3_000);
  });

  test("steps — a run's items as a list to choose from", async () => {
    const answer = await get(`/v2/sessions/${BIG_SESSION}/runs/run_0/items`);
    record("GET /runs/:id/items", answer.bytes, `${(answer.body.items as unknown[]).length} items with their bytes`);
    expect(answer.status).toBe(200);
    expect(answer.bytes).toBeLessThan(2_000);
  });

  test("step — one item, at the 8,000-character default", async () => {
    const answer = await get(`/v2/sessions/${BIG_SESSION}/runs/run_0/items/0`);
    record("GET /runs/:id/items/0", answer.bytes, "one step, maxChars=8000");
    expect(answer.status).toBe(200);
    expect(answer.body.index).toBe(0);
    // The scalar envelope on top of the 8,000-character clamp.
    expect(answer.bytes).toBeLessThan(8_600);
  });

  test("answer — the latest turn that left text, at the 8,000-character slice", async () => {
    const answer = await get(`/v2/sessions/${BIG_SESSION}/answer`);
    record("GET /answer", answer.bytes, `totalChars ${String(answer.body.totalChars)}`);
    expect(answer.status).toBe(200);
    expect(answer.body.totalChars).toBe(ANSWER_CHARS);
    expect(answer.body.more).toBe(false);
    expect(answer.bytes).toBeLessThan(8_600);
  });

  test("grep — 20 hits with 200 characters of context each", async () => {
    const answer = await get(`/v2/sessions/${BIG_SESSION}/grep?pattern=index.lock`);
    record("GET /grep?pattern=", answer.bytes, `${(answer.body.matches as unknown[]).length} matches, 200 chars of context`);
    expect(answer.status).toBe(200);
    expect(answer.bytes).toBeLessThan(12_000);
  });

  test("and no answer is empty — a bounded answer that says nothing is not bounded, it is broken", async () => {
    for (const route of [
      `/v2/sessions/${BIG_SESSION}/outline`,
      "/v2/sessions/find?q=appearance",
      `/v2/sessions/${BIG_SESSION}/runs/run_0/items`,
      `/v2/sessions/${BIG_SESSION}/runs/run_0/items/0`,
      `/v2/sessions/${BIG_SESSION}/answer`,
      `/v2/sessions/${BIG_SESSION}/grep?pattern=index.lock`,
    ]) {
      const answer = await get(route);
      expect(answer.status).toBe(200);
      expect(answer.bytes).toBeGreaterThan(100);
    }
  });
});

/**
 * ══ #515'S GUARD, EXTENDED TO #516'S TOOLS ══
 *
 * WHAT A TOOL ANSWERS, NOT WHAT A ROUTE ANSWERS, which is the number the issue
 * actually asks for: the routes are the engine's, the tools are what a caller's
 * context window pays for, and the wrapper between them is not free.
 *
 * ALL SIX ARE REACHABLE NOW. When this block was written three of them lived on
 * the cockpit Agent's wall and three existed nowhere; they are all on the shared
 * `sessions-tools` wall, over one `SessionsQueryCapability`, and this builds it
 * from `store.*` exactly as `daemon.ts` does — so what is priced here is the
 * real answer over the real fixture rather than a fake's idea of one.
 */
describe("#516's tools, on the same 300-session fixture", () => {
  const wall = (): Map<string, SocketTool> => {
    const store = daemon.store;
    const tools = collectTools(sessionQueryTools as never, {
      find: async (query: Parameters<typeof store.findSessions>[0]) => store.findSessions(query),
      outline: async (sessionId: string, window: Parameters<typeof store.turnOutline>[1]) => store.turnOutline(sessionId, window),
      answer: async (sessionId: string, options: Parameters<typeof store.turnAnswer>[1]) => store.turnAnswer(sessionId, options),
      steps: async (sessionId: string, runId: string) => ({ items: store.runItems(sessionId, runId) }),
      step: async (sessionId: string, runId: string, step: number | string, maxChars: number) => store.runItem(sessionId, runId, step, maxChars),
      grep: async (sessionId: string, pattern: string, window: Parameters<typeof store.grepSession>[2]) => store.grepSession(sessionId, pattern, window),
    } as never);
    return new Map(tools.map((tool) => [tool.name, tool]));
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const answer = await wall().get(name)!.run(args);
    return (answer.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
  };

  /**
   * THE DECISION THIS BLOCK USED TO LEAVE OPEN, MADE.
   *
   * Measured at 7,048 B against the issue's 6 KB, with the route answering
   * 5,918 B for the same page: `OUTLINE_PAGE_BYTES` was doing its job and the
   * gap was the envelope — `json()` pretty-prints at two spaces, deliberately
   * and for every tool on every wall, which is ~19% on a page of twenty small
   * objects. Two ways out were on the table: drop the page budget so the
   * rendered answer lands under 6 KB, or restate the budget as being about the
   * route.
   *
   * THE BULLET IS ABOUT THE TOOL, so the tool is what meets it. The page budget
   * is NOT what moved — the route has other callers (the issue names the web
   * transcript) and already met its own number, and shrinking a shared page to
   * fix one consumer's serialisation would have put this accounting two files
   * away from the `json()` call that causes it. `sessions_outline` bounds its
   * own answer again, in the units that are delivered, against
   * `OUTLINE_ANSWER_CHARS`. Restating the budget as the route's was refused: the
   * route already passed, so that reading makes the criterion vacuous.
   */
  test("sessions_outline, at its default page, on the largest session", async () => {
    const text = await call("sessions_outline", { sessionId: BIG_SESSION });
    const bytes = Buffer.byteLength(text, "utf8");
    table.push({ answer: "tool sessions_outline", bytes, note: "default limit 20 — under the issue's 6 KB" });
    expect(bytes).toBeLessThan(6_000);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  /**
   * AND THE PAGE IS STILL HONEST ABOUT WHAT IT DROPPED — the half a byte
   * ceiling alone would not catch. A tool that met 6 KB by trimming rows and
   * keeping the store's cursor would page straight over every turn it trimmed,
   * which is silent loss wearing a passing test.
   */
  test("the delivered page carries its own cursor, not the store's", async () => {
    const route = await get(`/v2/sessions/${BIG_SESSION}/outline`);
    const body = JSON.parse(await call("sessions_outline", { sessionId: BIG_SESSION })) as {
      turns: Array<{ sequence: number }>;
      more: boolean;
      next: number;
    };
    // The tool's page is a prefix of the route's — same rows, fewer of them
    // where two-space JSON costs more than the store's compact budget knew.
    expect(body.turns.length).toBeLessThanOrEqual((route.body.turns as unknown[]).length);
    expect(body.more).toBe(true);
    // THE CURSOR IS THE LAST ROW ACTUALLY SHOWN. Paging with it lands on the
    // next turn down rather than skipping whatever the byte bound removed.
    expect(body.next).toBe(body.turns.at(-1)!.sequence);
    const older = JSON.parse(
      await call("sessions_outline", { sessionId: BIG_SESSION, before: body.next }),
    ) as { turns: Array<{ sequence: number }> };
    expect(older.turns[0]!.sequence).toBeLessThan(body.next);
  });

  /**
   * UNDER THE ISSUE'S 3 KB, AND THE MARGIN IS SMALL ENOUGH TO BE WORTH SAYING.
   *
   * 2,801 B measured here against the route's 2,003 B — the same ~40% the
   * two-space rendering costs everywhere on this wall. What fills the answer is
   * the quoted line: `WHY_CHARS` is 200 and ten hits is the default, so 2 KB of
   * it is quotation before a single title or id. That is the verb working — a
   * list an agent can choose from rather than one it must open to evaluate —
   * and it is also why the margin here is a few hundred bytes rather than a few
   * thousand.
   *
   * `tool-budgets.test.ts` holds the same tool at 5,000 on a deliberately
   * worst-case fixture, where every row's title and `why` are filled to the last
   * character. Both numbers are real: this one is the acceptance measurement,
   * that one is the ceiling a fixture designed to break the bound has to stay
   * under.
   */
  test("sessions_find, at its default limit, across 300 sessions", async () => {
    const text = await call("sessions_find", { q: "appearance" });
    const bytes = Buffer.byteLength(text, "utf8");
    table.push({ answer: "tool sessions_find", bytes, note: "default limit 10 — under the issue's 3 KB" });
    expect(bytes).toBeLessThan(3_000);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  test("sessions_answer, at its default slice", async () => {
    const text = await call("sessions_answer", { sessionId: BIG_SESSION });
    table.push({ answer: "tool sessions_answer", bytes: Buffer.byteLength(text, "utf8"), note: "default slice 8000" });
    expect(text.length).toBeLessThanOrEqual(8_600);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  test("sessions_steps, at its default page", async () => {
    const text = await call("sessions_steps", { sessionId: BIG_SESSION, runId: "run_0" });
    table.push({ answer: "tool sessions_steps", bytes: Buffer.byteLength(text, "utf8"), note: "default limit 50, with each step's bytes" });
    expect(text.length).toBeLessThanOrEqual(8_600);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  test("sessions_step, at the 8,000-character default", async () => {
    const text = await call("sessions_step", { sessionId: BIG_SESSION, runId: "run_0", step: 0 });
    table.push({ answer: "tool sessions_step", bytes: Buffer.byteLength(text, "utf8"), note: "one step, maxChars 8000" });
    expect(text.length).toBeLessThanOrEqual(8_800);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  /**
   * THE ONE WHOSE ROUTE IS ALREADY PAST THE TOOLKIT'S BACKSTOP: 6,116 B from
   * the route at its default 20 matches, and 100 is what a caller may ask for.
   * `GREP_CHARS` is what keeps the rendered answer from reaching `bounded`,
   * which clips characters and would hand back JSON that does not parse.
   */
  test("sessions_grep, at its default page of 20 matches", async () => {
    const text = await call("sessions_grep", { sessionId: BIG_SESSION, pattern: "index.lock" });
    table.push({ answer: "tool sessions_grep", bytes: Buffer.byteLength(text, "utf8"), note: "default limit 20, 200 chars of context each" });
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });

  /**
   * EVERY BYTE IN THE TABLE IS A BYTE OF AN ANSWER — the assertion without which
   * the six numbers above are not measurements.
   *
   * THE GAP THIS CLOSES, NAMED PLAINLY. Each byte test above asserts a CEILING
   * and that the text parses. Both of those are satisfied by an answer that is
   * correctly shaped and says nothing: `{"matches":[],"more":false}` is 30
   * bytes, parses, and is comfortably under every ceiling here — so a `grep`
   * that silently matched nothing would not fail, and its byte number would go
   * into the issue's table looking like an unusually good result. The route half
   * of this file has had a `bytes > 100` floor since it was written; the tool
   * half never got one, and a floor on bytes would not have caught that example
   * anyway.
   *
   * SO THE CHECK IS ON COUNTS AND CONTENT, not on size. Each answer must carry
   * the rows it claims to have counted, at the number the fixture put there —
   * quantities an empty or wrongly-filtered answer cannot produce, which is the
   * distinction `docs/operations/dispatch-board.md` §3 draws between a check and
   * a check-shaped thing.
   *
   * `grep` CARRIES THE SHARPEST ONE: a full page of 20, and every context
   * actually containing the pattern. An answer built from the wrong rows passes
   * a count and fails that.
   */
  test("every byte in the table is a byte of an ANSWER — the six carry the rows they counted", async () => {
    const body = async <T>(name: string, args: Record<string, unknown>): Promise<T> =>
      JSON.parse(await call(name, args)) as T;

    const outline = await body<{ turns: unknown[]; total: number }>("sessions_outline", { sessionId: BIG_SESSION });
    expect(outline.turns.length).toBeGreaterThan(1);
    expect(outline.total).toBe(MEASURED_TURNS + 1);

    const find = await body<{ sessions: unknown[] }>("sessions_find", { q: "appearance" });
    expect(find.sessions.length).toBe(10);

    const answered = await body<{ text: string; totalChars: number }>("sessions_answer", { sessionId: BIG_SESSION });
    expect(answered.totalChars).toBe(ANSWER_CHARS);
    expect(answered.text.length).toBeGreaterThan(0);

    const steps = await body<{ items: unknown[] }>("sessions_steps", { sessionId: BIG_SESSION, runId: "run_0" });
    expect(steps.items.length).toBe(ITEMS_PER_TURN);

    const step = await body<{ text: string; index: number }>("sessions_step", { sessionId: BIG_SESSION, runId: "run_0", step: 0 });
    expect(step.index).toBe(0);
    expect(step.text.length).toBeGreaterThan(0);

    const grep = await body<{ matches: Array<{ context: string }> }>("sessions_grep", { sessionId: BIG_SESSION, pattern: "index.lock" });
    expect(grep.matches.length).toBe(20);
    expect(grep.matches.filter((match) => match.context.toLowerCase().includes("index.lock"))).toHaveLength(20);
  });

  /**
   * AND NONE OF THEM IS CLIPPED BY THE BACKSTOP — `tool-budgets.test.ts`'s
   * second assertion, which is the one that says a tool is bounded by its own
   * SHAPE. An answer that reaches `bounded` comes back as JSON with its tail
   * cut off: the caller gets a parse error instead of a short page.
   */
  test("no answer is clipped by the backstop — each bounds its own shape", async () => {
    for (const [name, args] of [
      ["sessions_outline", { sessionId: BIG_SESSION }],
      ["sessions_find", { q: "appearance" }],
      ["sessions_answer", { sessionId: BIG_SESSION }],
      ["sessions_steps", { sessionId: BIG_SESSION, runId: "run_0" }],
      ["sessions_step", { sessionId: BIG_SESSION, runId: "run_0", step: 0 }],
      ["sessions_grep", { sessionId: BIG_SESSION, pattern: "index.lock" }],
    ] as const) {
      expect(await call(name, args)).not.toContain("more characters not shown");
    }
  });

  /**
   * THE DESCRIPTION CAP #516 ASKS FOR. These are on the shared wall now, so
   * `tool-budgets.test.ts` covers them too — kept here because this file is
   * where the six are enumerated as six, and a tool that went missing from the
   * wall would fail this count rather than quietly stop being measured.
   */
  test("all six are here, every description under 350 characters and none of them a blank", () => {
    const tools = [...wall().values()];
    expect(tools.map((tool) => tool.name)).toEqual([
      "sessions_find", "sessions_outline", "sessions_answer", "sessions_steps", "sessions_step", "sessions_grep",
    ]);
    const over = tools.filter((tool) => tool.description.length > 350).map((tool) => `${tool.name} (${tool.description.length})`);
    expect(over).toEqual([]);
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(80);
  });
});

/**
 * ══ THE LATENCY PROOF ══
 *
 * Both readers, on the same fixture, in the same run, at two journal sizes.
 */
describe("outline does not fold the journal", () => {
  const shapes = (): { outline: Shape; fold: Shape } => {
    const store = daemon.store;
    return {
      outline: {
        smallMs: measure(() => store.turnOutline(CONTROL_SESSION, { limit: OUTLINE_LIMIT }), 5, OUTLINE_BATCH),
        bigMs: measure(() => store.turnOutline(BIG_SESSION, { limit: OUTLINE_LIMIT }), 5, OUTLINE_BATCH),
      },
      fold: {
        smallMs: measure(() => foldOutline(store.readEvents(CONTROL_SESSION, 0), OUTLINE_LIMIT)),
        bigMs: measure(() => foldOutline(store.readEvents(BIG_SESSION, 0), OUTLINE_LIMIT)),
      },
    };
  };

  /**
   * THE CONTROL ANSWERS THE SAME QUESTION, which has to be settled before any
   * comparison between the two is worth making. A fold that returned something
   * else would be a faster-or-slower reading of a different question, and the
   * ratio below would mean nothing.
   */
  test("the fold control returns the outline's own rows", () => {
    const store = daemon.store;
    const projected = store.turnOutline(BIG_SESSION, { limit: OUTLINE_LIMIT }).turns;
    const folded = foldOutline(store.readEvents(BIG_SESSION, 0), OUTLINE_LIMIT).slice(0, projected.length);
    expect(folded.length).toBe(projected.length);
    expect(folded.length).toBeGreaterThan(0);
    // `endedAt` is excluded and nothing else is: the projection stamps it from
    // the turn document's `completedAt` and the fold can only read the event's
    // `at`, which are written in the same transaction and may differ by a
    // millisecond. Every field that carries an ANSWER is compared.
    const shed = (rows: typeof projected) => rows.map(({ endedAt: _endedAt, ...rest }) => rest);
    expect(shed(folded)).toEqual(shed(projected));
  });

  test(`the fold's cost tracks the journal and the projection's does not (${JOURNAL_GROWTH}× the events)`, () => {
    const { outline, fold } = shapes();
    console.log(
      `\n#516 — outline latency, ${SMALL_JOURNAL} vs ${BIG_JOURNAL} events, ${MEASURED_TURNS} turns on both:\n` +
        `  projection (store.turnOutline)  ${outline.smallMs.toFixed(3)} ms → ${outline.bigMs.toFixed(3)} ms   ×${ratio(outline).toFixed(2)}\n` +
        `  fold control (walk the journal) ${fold.smallMs.toFixed(3)} ms → ${fold.bigMs.toFixed(3)} ms   ×${ratio(fold).toFixed(2)}\n`,
    );

    // THE CONTROL IS REAL. A "fold" that did not grow with the journal would
    // make the comparison vacuous, and this is the reading that says it did.
    expect(fold.bigMs).toBeGreaterThan(FOLD_FLOOR_MS);
    expect(isFlat(fold)).toBe(false);

    // AND THE PROJECTION IS FLAT — the claim the issue is buying.
    expect(isFlat(outline)).toBe(true);

    // Stated as the two shapes rather than as two milliseconds: whatever the
    // machine is doing, it is doing it to both readings.
    expect(ratio(outline)).toBeLessThan(ratio(fold));
    // A CEILING SO THAT A SLOW RUNNER FAILS AS A TIMEOUT AND NOT AS A VERDICT.
    // This test does thousands of measured calls on purpose; bun's default is
    // 5 s when a path is typed by hand and 20 s under the preload, and a 5007 ms
    // failure here would read as "the projection regressed" when it means "the
    // machine is busy" — the exact misreading `dispatch-board.md` §3 names.
  }, 120_000);
});

/**
 * ══ FALSIFYING THE INSTRUMENT ══
 *
 * Neither of these is a test of `turnOutline`. They are tests of whether the
 * two tests above could have failed.
 */
describe("the instrument can report a bad result", () => {
  /**
   * THE FAILURE THAT ALREADY HAPPENED HERE: six performance tests, all green,
   * all measuring zero. If `Bun.nanoseconds()` does not move, `measure` returns
   * 0 for every reader, every ratio is 0/0, and both assertions above pass on
   * an engine that folds the journal on every call.
   *
   * A COUNT THE FROZEN STATE CANNOT PRODUCE: a known load, priced, with the
   * reading required to be larger than a millisecond AND larger than the same
   * instrument's reading of a trivial one. A green here means the clock moved.
   */
  test("the clock is not frozen — a known load measures more than a trivial one", () => {
    const light = measure(() => rounds(LIGHT_ROUNDS));
    const heavy = measure(() => rounds(HEAVY_ROUNDS));
    expect(heavy).toBeGreaterThan(1);
    expect(heavy).toBeGreaterThan(light * 10);
  }, 120_000);

  /**
   * AND THE PREDICATE SAYS NO WHEN IT SHOULD.
   *
   * `outline` made slow on purpose — the projection read with a journal walk
   * bolted onto it, which is precisely "it folds events per call" — run through
   * the SAME `measure` and the SAME `isFlat`. If this returned `true` the check
   * above would be incapable of catching the regression it exists for, and its
   * green would be evidence about the check rather than about the engine.
   *
   * THE NUMBER HAS TO MOVE TOO, asserted separately: a predicate that said
   * `false` while both readings were identical would be failing for some reason
   * other than the one claimed.
   */
  test("the check rejects a reader that does fold — outline, made slow on purpose", () => {
    const store = daemon.store;
    const honest: Shape = {
      smallMs: measure(() => store.turnOutline(CONTROL_SESSION, { limit: OUTLINE_LIMIT }), 5, OUTLINE_BATCH),
      bigMs: measure(() => store.turnOutline(BIG_SESSION, { limit: OUTLINE_LIMIT }), 5, OUTLINE_BATCH),
    };
    const slowed = (sessionId: string) => {
      const answer = store.turnOutline(sessionId, { limit: OUTLINE_LIMIT });
      foldOutline(store.readEvents(sessionId, 0), OUTLINE_LIMIT);
      return answer;
    };
    const planted: Shape = {
      smallMs: measure(() => slowed(CONTROL_SESSION)),
      bigMs: measure(() => slowed(BIG_SESSION)),
    };
    console.log(
      `\n#516 — falsification: the same predicate, on outline deliberately made to fold:\n` +
        `  honest   ${honest.smallMs.toFixed(3)} ms → ${honest.bigMs.toFixed(3)} ms   ×${ratio(honest).toFixed(2)}   flat: ${String(isFlat(honest))}\n` +
        `  planted  ${planted.smallMs.toFixed(3)} ms → ${planted.bigMs.toFixed(3)} ms   ×${ratio(planted).toFixed(2)}   flat: ${String(isFlat(planted))}\n`,
    );

    // The instrument saw the injected work at all.
    expect(planted.bigMs).toBeGreaterThan(honest.bigMs);
    expect(planted.bigMs).toBeGreaterThan(FOLD_FLOOR_MS);
    // And the predicate that passes for the real reader fails for this one.
    expect(isFlat(honest)).toBe(true);
    expect(isFlat(planted)).toBe(false);
    expect(ratio(planted)).toBeGreaterThanOrEqual(TRACKS_JOURNAL);
  }, 120_000);
});
