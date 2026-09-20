/**
 * THE AGENT'S WALL, ITS GATE, AND THE SEND THAT CANNOT LAND TWICE (#531).
 *
 * What must not drift:
 *
 *   - the two shared walls plus the query reads are exactly 21 tools, and none
 *     of them is a shell, a file or a browser — absent, not disabled;
 *   - `fleet_status` is the union of the three lists the Agent has touched,
 *     ranked with what is waiting on a person first, and bounded twice (#570);
 *   - the gate is argument-aware: a task is asked about, a report is not;
 *   - reads are never gated, because a gate on a read teaches people to click
 *     through gates;
 *   - one tool call id produces one run id, so a retried `sessions_send`
 *     replays at the store rather than queueing a second turn;
 *   - a SPOKEN turn is bound to nine of the twenty-five (#603), the rule behind
 *     that list is held as three exclusion sets rather than as prose, every
 *     tool is classified one way or the other, and what a withheld tool answers
 *     with cannot be mistaken for success.
 */
import { expect, test } from "bun:test";
import { collectTools, toolInputSchema } from "../src/mcp-socket";
import { sessionsTools, type SessionsCapability } from "../src/sessions-tools/tools";
import {
  agentFleetTools,
  agentToolSpecs,
  collectAgentTools,
  onSpokenWall,
  spokenWallTable,
  withheldFromSpokenTurn,
  type AgentFleetCapability,
  type FleetSessionRow,
} from "../src/agent/tools";
import { answerIdentity, sessionQueryTools, type SessionsQueryCapability } from "../src/sessions-tools/query";
import { noQueries } from "./query-stub";
import { AGENT_SELF_ID } from "../src/agent/identity";
import { approvalRequest, classifiedTools, needsApproval, readsOnly } from "../src/agent/approval";
import { EngineStateError, TURN_ANSWER_NONE, TURN_ANSWER_NO_SUCH_RUN } from "../src/state";
import type { NotesCapability } from "../src/notes-tools/tools";
import type { Session, Turn } from "@telar/engine-client";

/* ------------------------------------------------------------------ *
 * The gate.
 * ------------------------------------------------------------------ */

test("a task and a blocker are asked about; a report and a result are not", () => {
  expect(needsApproval({ name: "sessions_send", args: { intent: "task" } })).toBe(true);
  expect(needsApproval({ name: "sessions_send", args: { intent: "blocker" } })).toBe(true);
  expect(needsApproval({ name: "sessions_send", args: { intent: "report" } })).toBe(false);
  expect(needsApproval({ name: "sessions_send", args: { intent: "result" } })).toBe(false);
  // The wall's own default is `report`, so an absent intent is not gated.
  expect(needsApproval({ name: "sessions_send", args: {} })).toBe(false);
});

test("the four other effectful calls are gated by name", () => {
  for (const name of ["sessions_create", "sessions_stop", "sessions_resolve_request", "notes_delete"]) {
    expect(needsApproval({ name, args: {} })).toBe(true);
  }
});

test("every read on both walls is ungated", () => {
  const reads = [
    "sessions_list", "sessions_read", "sessions_status", "sessions_diff", "sessions_requests",
    "sessions_subscriptions", "sessions_subscribe", "sessions_unsubscribe", "sessions_settle",
    "sessions_find", "sessions_outline", "sessions_answer", "sessions_steps", "sessions_step", "sessions_grep",
    "fleet_status",
    "notes_projects", "notes_list", "notes_read", "notes_write",
  ];
  for (const name of reads) expect(needsApproval({ name, args: {} })).toBe(false);
});

/**
 * THE READS/LANDS SPLIT IS THE MEMO'S WHOLE SAFETY (#592).
 *
 * The within-turn memo answers a repeat with a pointer instead of the payload,
 * and the one thing it must never do is answer a repeated WRITE that way — a
 * person can legitimately ask for the same message twice, and a swallowed
 * second `sessions_send` is work the Agent believes it did and nobody received.
 *
 * SO THE TABLE IS HELD AGAINST THE WALL ITSELF rather than against a copy of
 * itself: a tool added to either wall and classified nowhere fails HERE, which
 * is the only place the omission is visible before it is a silent bug.
 */
test("every tool the Agent is given is classified as a read or a lander", () => {
  const whole = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    fleet: emptyFleet(),
    github: { issue: async () => ({ unavailable: "not_found" }), pull: async () => ({ unavailable: "not_found" }), projects: async () => [] },
    memory: { remember: (section) => ({ written: true, section, chars: 0, others: {}, standing: 0 }), recall: () => [] },
  }).map((tool) => tool.name);
  const classified = new Set(classifiedTools());
  for (const name of whole) expect(classified.has(name)).toBe(true);
  // And nothing classified has left the wall, so the table cannot rot quietly
  // into a list of tools that no longer exist.
  for (const name of classified) expect(whole).toContain(name);
});

test("the ten calls that land something are never memoisable", () => {
  for (const name of [
    "sessions_create", "sessions_send", "sessions_stop", "sessions_settle", "sessions_subscribe",
    "sessions_unsubscribe", "sessions_resolve_request", "notes_write", "notes_delete", "remember",
  ]) {
    expect(readsOnly(name)).toBe(false);
  }
  // A GATE IS NOT THE TEST FOR THIS, and that is why the table exists: five of
  // the ten above are deliberately ungated, so `needsApproval` would have read
  // them as reads.
  for (const name of ["sessions_settle", "sessions_subscribe", "sessions_unsubscribe", "notes_write", "remember"]) {
    expect(needsApproval({ name, args: {} })).toBe(false);
    expect(readsOnly(name)).toBe(false);
  }
  // A name nobody classified is a lander, because that is the direction whose
  // failure is waste rather than lost work.
  expect(readsOnly("some_tool_added_next_year")).toBe(false);
});

test("the ask names the call it is about, so a surface need not re-derive it", () => {
  const request = approvalRequest({ name: "sessions_send", args: { sessionId: "session_x", intent: "task", input: "do the thing" } }, "call_1");
  expect(request.tool).toBe("sessions_send");
  expect(request.toolCallId).toBe("call_1");
  expect(request.args.sessionId).toBe("session_x");
  expect(request.reason).toContain("assigns work");
});

/* ------------------------------------------------------------------ *
 * The wall.
 * ------------------------------------------------------------------ */

const noSessions = (): SessionsCapability => ({
  self: { sessionId: AGENT_SELF_ID },
  list: async () => ({ sessions: [], projects: [] }),
  create: async () => ({}) as Session,
  send: async () => ({ turn: {} as Turn, replayed: false }),
  read: async () => [],
  status: async () => ({ session: {} as Session, turns: [] }),
  stop: async () => ({ stopped: 0 }) as never,
  settle: async () => ({}) as Session,
  diff: async () => ({}) as never,
  subscribe: async () => ({}) as never,
  unsubscribe: async () => false,
  subscriptions: async () => [],
  requests: async () => [],
  resolveRequest: async () => ({}) as never,
});

const noNotes = (): NotesCapability => ({
  projects: async () => [],
  list: async () => [],
  read: async () => null,
  create: async () => ({}) as never,
  update: async () => null,
  remove: async () => false,
});

const emptyFleet = (): AgentFleetCapability => ({
  rail: async () => ({ sessions: [], projects: [] }),
  subscribed: async () => [],
  who: () => undefined,
  session: async () => undefined,
  lastTurn: async () => undefined,
  openRequests: async () => 0,
  unread: () => ({}),
  since: () => undefined,
});

test("the Agent's wall is the two walls plus the six query reads, and nothing else", () => {
  const names = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() }).map((tool) => tool.name);
  expect(names).toEqual([
    "sessions_list", "sessions_create", "sessions_send", "sessions_read", "sessions_status",
    "sessions_stop", "sessions_settle", "sessions_diff", "sessions_subscribe", "sessions_unsubscribe",
    "sessions_subscriptions", "sessions_requests", "sessions_resolve_request",
    // #516's six, which arrive as part of the sessions wall itself rather than
    // as a second list this file's `collectAgentTools` pastes on — see
    // `collectAgentTools`. The ORDER is therefore the wall's, not the Agent's.
    "sessions_find", "sessions_outline", "sessions_answer", "sessions_steps", "sessions_step", "sessions_grep",
    "notes_projects", "notes_list", "notes_read", "notes_write", "notes_delete",
  ]);
  // ABSENT, not disabled: a model with no such tool says so.
  for (const forbidden of ["bash", "shell", "read_file", "write_file", "browser_navigate", "display_open", "warp"]) {
    expect(names).not.toContain(forbidden);
  }
});

/* ------------------------------------------------------------------ *
 * What the wall COSTS — #563 item 2.
 * ------------------------------------------------------------------ */

test("the bound tool array stays well under what it was, with every tool still on it", () => {
  const shared = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() });
  expect(shared).toHaveLength(24);
  /**
   * 18,744 characters when #563 measured it, 11,576 afterwards for 21 tools,
   * and 13,521 now for 24. A CEILING rather than an equality: prose is allowed
   * to move, and the thing that must not come back is the tax — this array is
   * resent on every lap of every turn, so a sentence added here is a sentence
   * paid for a hundred times a day.
   *
   * ── THE NUMBER WENT UP AND IT WAS NOT PROSE CREEP (#516) ──────────────────
   * Three tools arrived: `sessions_steps`, `sessions_step` and `sessions_grep`.
   * The arithmetic that says this is the denominator changing rather than the
   * wall getting wordier is the PER-TOOL cost, which is the thing #563 was
   * actually about: 551 characters a tool before, 563 after. Twelve characters.
   * Everything else is three more tools existing.
   *
   * The ceiling is therefore raised deliberately and by the measured amount —
   * not nudged to fit. The rule it enforces is unchanged: a CLAUSE still has to
   * buy its space out of another clause, and only a genuinely new tool may move
   * this number.
   */
  expect(JSON.stringify(agentToolSpecs(shared)).length).toBeLessThan(14_000);

  // AND THE WHOLE LIST THE AGENT ACTUALLY BINDS, three tools larger — the same
  // ceiling applies to it, because it is the one that is resent.
  const whole = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    fleet: emptyFleet(),
    github: { issue: async () => ({ unavailable: "not_found" }), pull: async () => ({ unavailable: "not_found" }), projects: async () => [] },
    memory: { remember: (section) => ({ written: true, section, chars: 0, others: {}, standing: 0 }), recall: () => [] },
  });
  expect(whole).toHaveLength(28);
  // 15,938 measured — see the paragraph above for why this moved and what it
  // would have taken for it not to.
  expect(JSON.stringify(agentToolSpecs(whole)).length).toBeLessThan(16_200);
});

/* ------------------------------------------------------------------ *
 * What the wall costs A SPOKEN TURN — #603 lever 2.
 * ------------------------------------------------------------------ */

const wholeWall = () =>
  collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    fleet: emptyFleet(),
    github: { issue: async () => ({ unavailable: "not_found" }), pull: async () => ({ unavailable: "not_found" }), projects: async () => [] },
    memory: { remember: (section) => ({ written: true, section, chars: 0, others: {}, standing: 0 }), recall: () => [] },
  });

test("a spoken turn is bound to nine tools, and the exclusions are the named ones", () => {
  const spoken = agentToolSpecs(wholeWall(), { spoken: true }).map((spec) => spec.function.name);
  expect(spoken).toEqual([
    "sessions_create", "sessions_send", "sessions_status", "sessions_requests",
    "sessions_find", "sessions_answer", "fleet_status", "github_status", "remember",
  ]);
  /**
   * THE RULE, HELD AS THREE LISTS RATHER THAN AS PROSE: a spoken turn answers,
   * it does not page a document and it does not tidy the rail.
   */
  for (const pages of ["sessions_read", "sessions_outline", "sessions_diff", "notes_read", "notes_write", "notes_list", "notes_projects"]) {
    expect(spoken).not.toContain(pages);
  }
  for (const tidies of ["sessions_stop", "sessions_settle", "sessions_subscribe", "sessions_unsubscribe", "sessions_subscriptions", "sessions_resolve_request", "notes_delete"]) {
    expect(spoken).not.toContain(tidies);
  }
  // A second way to do something already on the spoken wall.
  for (const duplicate of ["sessions_list", "recall"]) expect(spoken).not.toContain(duplicate);
});

test("the spoken wall is the saving, and it is paid on every lap", () => {
  const whole = wholeWall();
  const wide = JSON.stringify(agentToolSpecs(whole)).length;
  const spoken = JSON.stringify(agentToolSpecs(whole, { spoken: true })).length;
  /**
   * 13,993 against 5,514 when #603 measured it — 60.6% off the one part of the
   * prompt that is resent WHOLE on every lap. CEILINGS rather than equalities,
   * for the reason the test above this one gives: prose may move, the tax may
   * not come back.
   *
   * THE WIDE ONE HAD SEVEN CHARACTERS OF HEADROOM and then had 47, which was
   * not slack that was found — it was bought. #608 needed `sessions_read` to say
   * that it folds by default and `sessions_answer` that its limit is a floor,
   * and paid for both out of `sessions_read`'s own parameters: four
   * descriptions whose second halves were already stated by the answers those
   * calls return. The ceiling was NOT raised, and the rule it enforces is
   * unchanged — retire something or argue the number up deliberately, never
   * nudge it to fit one more clause.
   *
   * #654 SPENT 45 OF THOSE 47, leaving TWO. `sessions_diff` had to say that an
   * empty answer may be unread rather than unchanged, because it is the one diff
   * surface an agent reads and a wrong "this session changed nothing" gets
   * reported onward as fact. The first draft of that clause was 199 characters
   * and broke this test, which is the test working: everything except the
   * warning itself moved to the answer's own `note`, which is free per lap.
   * THE NEXT CLAUSE HERE HAS TO BUY ITS SPACE. Two characters is not headroom.
   */
  expect(wide).toBeLessThan(16_200);
  /**
   * AND THE SPOKEN HALF DID NOT MOVE — 5,548, which is #516's whole effect on
   * this number and it is nothing: all three new tools PAGE, so all three are
   * withheld, and a spoken turn is bound to the same nine it was. That is the
   * property worth pinning here, because it is what makes "the wall grew" and
   * "every spoken turn costs more" two different statements.
   */
  expect(spoken).toBeLessThan(6_000);
  expect(spoken).toBeLessThan(wide / 2);
});

test("every tool the Agent is given is on the spoken wall or explicitly withheld", () => {
  const table = spokenWallTable();
  const whole = wholeWall().map((tool) => tool.name);
  // The omission is visible HERE, before it is a spoken turn that quietly
  // refuses a tool nobody meant to withhold.
  for (const name of whole) expect(Object.hasOwn(table, name)).toBe(true);
  for (const name of Object.keys(table)) expect(whole).toContain(name);
  // AND IT FAILS TOWARDS WITHHELD: a name nobody classified costs one honest
  // refusal rather than putting bytes silently back on every lap.
  expect(onSpokenWall("some_tool_added_next_year")).toBe(false);
});

test("a withheld tool refuses in a sentence that cannot be read as success", () => {
  const refusal = withheldFromSpokenTurn("sessions_stop");
  // WHAT THE SENTENCE HAS TO CARRY, and each clause is load-bearing: that
  // nothing ran, WHICH tool, and where the person can actually go instead.
  expect(refusal).toContain("NOTHING HAPPENED");
  expect(refusal).toContain("sessions_stop");
  expect(refusal).toContain("no part of it ran");
  expect(refusal).toContain("the Mac");
  // It tells the model to SAY it, because a refusal the person never hears is
  // the silent absence in a slower form.
  expect(refusal).toContain("Tell the person");
});

test("the model's copy drops the validator's bookkeeping and keeps every choice", () => {
  const tools = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() });
  const bound = JSON.stringify(agentToolSpecs(tools));
  expect(bound).not.toContain("$schema");
  expect(bound).not.toContain("minLength");
  expect(bound).not.toContain("9007199254740991");
  // Names, enums, real bounds and `required` are what the model chooses from.
  expect(bound).toContain('"enum":["task","report","result","blocker"]');
  expect(bound).toContain('"required":["projectId","envMode"]');
  expect(bound).toContain('"maximum":50');
  // And the socket's own answer is untouched: other programs validate against it.
  expect(JSON.stringify(toolInputSchema(tools.find((tool) => tool.name === "sessions_send")!.shape))).toContain("$schema");
});

test("no rule was traded for the bytes", () => {
  const byName = new Map(collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() }).map((tool) => [tool.name, tool.description]));
  // The sentence the wall cannot enforce, on all three tools that could be bent
  // into it.
  for (const name of ["sessions_create", "sessions_send", "sessions_resolve_request"]) {
    expect(byName.get(name)).toContain("refused");
  }
  expect(byName.get("sessions_diff")).toContain("NOT AN ACCEPTANCE");
  expect(byName.get("sessions_settle")).toContain("not acceptance");
  expect(byName.get("sessions_requests")).toContain("taking responsibility");
  expect(byName.get("sessions_stop")).toContain("Nothing is undone");
  expect(byName.get("notes_delete")).toContain("the user wrote is theirs");
  expect(byName.get("sessions_list")).toContain("before creating");
});

test("a `self` of agent is what lets the subscription tools work at all", async () => {
  const withSelf = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() });
  const withoutSelf = collectAgentTools({
    sessions: { ...noSessions(), self: undefined },
    notes: noNotes(),
    query: noQueries(),
  });
  const call = (tools: typeof withSelf) => tools.find((tool) => tool.name === "sessions_subscriptions")!.run({});
  expect((await call(withSelf)).isError).toBeUndefined();
  expect((await call(withoutSelf)).isError).toBe(true);
});

/* ------------------------------------------------------------------ *
 * The query tools.
 * ------------------------------------------------------------------ */

test("the query tools clamp rather than refuse, and say when there is more", async () => {
  const asked: unknown[] = [];
  const capability: SessionsQueryCapability = {
    ...noQueries(),
    find: async (query) => {
      asked.push(query);
      return { sessions: [{ id: "session_a", activity: "idle", updatedAt: 1, why: "the appearance rework" }], index: "fts5", more: true };
    },
    outline: async (_id, window) => {
      asked.push(window);
      return { turns: [], total: 0, more: false };
    },
    answer: async (_id, options) => {
      asked.push(options);
      return { runId: "run_1", sequence: 1, text: "ok", from: 0, totalChars: 2, more: false };
    },
  };
  const tools = collectTools(sessionQueryTools as never, capability as never);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const found = await byName.get("sessions_find")!.run({ q: "appearance", limit: 5_000 });
  expect((asked[0] as { limit: number }).limit).toBe(50);
  expect(String((found.content[0] as { text: string }).text)).toContain("Narrow with projectId");

  await byName.get("sessions_outline")!.run({ sessionId: "session_a", limit: 5_000 });
  expect((asked[1] as { limit: number }).limit).toBe(100);

  await byName.get("sessions_answer")!.run({ sessionId: "session_a", limit: 500_000 });
  expect((asked[2] as { limit: number }).limit).toBe(64_000);
});

/**
 * THE THREE #516 ASKED FOR AND NOBODY HAD BUILT — `sessions_steps`,
 * `sessions_step` and `sessions_grep`. Same three claims as the tools above:
 * the ceiling is a clamp rather than a refusal, the answer says what it left
 * out, and a miss is a sentence that closes rather than one that invites a
 * retry.
 */
test("the three new queries clamp their ceilings too, and pass the caller's number down", async () => {
  const asked: unknown[] = [];
  const tools = collectTools(sessionQueryTools as never, {
    ...noQueries(),
    steps: async (_id: string, runId: string) => {
      asked.push(runId);
      return { items: Array.from({ length: 300 }, (_, index) => ({ index, id: `item_${index}`, title: `step ${index}`, status: "completed" as const, bytes: 10 })) };
    },
    grep: async (_id: string, pattern: string, window: { limit: number }) => {
      asked.push({ pattern, ...window });
      return { matches: [], more: false };
    },
    step: async (_id: string, _runId: string, step: number | string, maxChars: number) => {
      asked.push({ step, maxChars });
      return { index: 0, id: "item_0", title: "a step", status: "completed" as const, startedAt: 1, text: "body", totalChars: 4, more: false };
    },
  } as never);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const body = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(String(((await byName.get(name)!.run(args)).content[0] as { text: string }).text)) as Record<string, unknown>;

  /**
   * A 300-STEP RUN IS PAGED, not refused and not handed over — and by BOTH
   * numbers, whichever is reached first. Here it is the byte budget: a step row
   * is around a hundred characters pretty-printed, so 8,000 of them runs out
   * well before the 200-row ceiling. What the test pins is that the answer is
   * honest whichever bound stopped it — `next` is the number of rows actually
   * shown, never the number that were asked for.
   */
  const steps = await body("sessions_steps", { sessionId: "session_a", runId: "run_1", limit: 5_000 });
  const shown = (steps.items as unknown[]).length;
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(200);
  expect(steps.total).toBe(300);
  expect(steps.more).toBe(true);
  expect(steps.next).toBe(shown);
  expect(String(steps.note)).toContain(`after: ${shown}`);
  // And the default is smaller still — a model that named no number gets a
  // screen it can read rather than everything that fits in the budget.
  expect(((await body("sessions_steps", { sessionId: "session_a", runId: "run_1" })).items as unknown[]).length).toBeLessThanOrEqual(50);

  // GREP's ceiling is the route's, and the caller's number reaches the store.
  await body("sessions_grep", { sessionId: "session_a", pattern: "index.lock", limit: 5_000 });
  expect(asked.at(-1)).toEqual({ pattern: "index.lock", limit: 100 });

  // A STEP'S READ BUDGET IS CLAMPED THE SAME WAY, and an absent one is the
  // default rather than an error.
  await body("sessions_step", { sessionId: "session_a", runId: "run_1", step: 3, maxChars: 500_000 });
  expect(asked.at(-1)).toEqual({ step: 3, maxChars: 64_000 });
  await body("sessions_step", { sessionId: "session_a", runId: "run_1", step: "item_7" });
  // A STRING THAT IS NOT A NUMBER IS AN ITEM ID, and one that is gets read as
  // the position it looks like — the route parses it the same way.
  expect(asked.at(-1)).toEqual({ step: "item_7", maxChars: 8_000 });
  await body("sessions_step", { sessionId: "session_a", runId: "run_1", step: "4" });
  expect(asked.at(-1)).toEqual({ step: 4, maxChars: 8_000 });
});

test("an empty answer from one of the three says so, rather than looking like a small one", async () => {
  const tools = collectTools(sessionQueryTools as never, noQueries() as never);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const body = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(String(((await byName.get(name)!.run(args)).content[0] as { text: string }).text)) as Record<string, unknown>;

  // NO STEPS is either "it has done nothing yet" or "that runId is not this
  // session's", and a caller cannot tell them apart — so the note says both and
  // names the call that settles it.
  const steps = await body("sessions_steps", { sessionId: "session_a", runId: "run_nope" });
  expect(steps.items).toEqual([]);
  expect(steps.total).toBe(0);
  expect(String(steps.note)).toContain("sessions_outline");

  // NO MATCHES is a claim about the search, so it names what kind of search it
  // was — an agent that thinks it ran a regular expression will conclude the
  // phrase is absent when it only mistyped the syntax.
  const grepped = await body("sessions_grep", { sessionId: "session_a", pattern: "^index" });
  expect(grepped.matches).toEqual([]);
  expect(String(grepped.note)).toContain("substring match");
});

test("each of the three new queries passes a store refusal back as a sentence", async () => {
  const refusing = (member: string) =>
    collectTools(sessionQueryTools as never, {
      ...noQueries(),
      [member]: async () => {
        throw new Error("session does not exist");
      },
    } as never);
  for (const [member, name] of [["steps", "sessions_steps"], ["step", "sessions_step"], ["grep", "sessions_grep"]]) {
    const tool = refusing(member!).find((each) => each.name === name)!;
    const answer = await tool.run({ sessionId: "session_gone", runId: "run_1", step: 0, pattern: "x" });
    expect(answer.isError).toBe(true);
    const text = String((answer.content[0] as { text: string }).text);
    expect(text).toContain("session does not exist");
    // The sentence names WHICH session missed: a batch of reads needs pairing.
    expect(text).toContain("session_gone");
  }
});

test("a refusal from the store comes back as a sentence the model can read", async () => {
  const tools = collectTools(sessionQueryTools as never, {
    ...noQueries(),
    outline: async () => {
      throw new Error("session does not exist");
    },
  } as never);
  const answer = await tools.find((tool) => tool.name === "sessions_outline")!.run({ sessionId: "session_gone" });
  expect(answer.isError).toBe(true);
  expect(String((answer.content[0] as { text: string }).text)).toContain("session does not exist");
});

/**
 * A REFUSAL THAT READS AS A HINT ABOUT ARGUMENTS COSTS TWO MORE CALLS (#592).
 *
 * The measured turn failed `sessions_answer` twice and retried with different
 * arguments both times, because "turn does not exist" and "this session has no
 * answered turn" describe the miss and neither closes the door. The second is
 * the worse of the two: it reads as "pick a different turn" when it means
 * "there is nothing here at all".
 */
test("both sessions_answer misses tell the model to stop rather than to retry", async () => {
  const miss = async (message: string) => {
    const tools = collectTools(sessionQueryTools as never, {
      ...noQueries(),
      answer: async () => {
        throw new EngineStateError("not_found", message);
      },
    } as never);
    const answered = await tools.find((tool) => tool.name === "sessions_answer")!.run({ sessionId: "session_a" });
    expect(answered.isError).toBe(true);
    return String((answered.content[0] as { text: string }).text);
  };

  // NOTHING HERE AT ALL — and it must not read as an invitation to name a turn.
  const none = await miss(TURN_ANSWER_NONE);
  expect(none).toContain("There is nothing here to read");
  expect(none).toContain("no runId will produce one");
  expect(none).toContain("do not ask it again");
  expect(none).not.toContain("has no answered turn");

  // A runId THAT IS NOT THERE — the retry to shut down is the guess, so the one
  // move that is not a guess is named.
  const wrong = await miss(TURN_ANSWER_NO_SUCH_RUN);
  expect(wrong).toContain("Do not guess another");
  expect(wrong).toContain("omit runId");
  expect(wrong).toContain("sessions_outline");

  // Both still say WHICH session missed: a batch of reads needs pairing.
  for (const sentence of [none, wrong]) expect(sentence).toContain("session_a");
});

/**
 * THE FIRST CALL IS THE WHOLE ANSWER WHERE THE ANSWER FITS (#608).
 *
 * Measured: 20,273 characters fetched across eight overlapping windows for a
 * 6,127-character answer; 15,384 over 7 calls for one of 3,556; and an
 * 883-character answer read five times at limits 2500/4000/4000/3000/4000. Every
 * one of those asked for LESS than the 8,000 default, so a bigger default would
 * have changed none of them — the number had to stop being a way to ask for a
 * smaller page.
 */
test("a limit under the default is served the default, so the first call is the whole answer", async () => {
  const asked: Array<{ from: number; limit: number }> = [];
  const whole = "x".repeat(6_127);
  const tools = collectTools(sessionQueryTools as never, {
    ...noQueries(),
    answer: async (_id: string, options: { from: number; limit: number }) => {
      asked.push(options);
      const text = whole.slice(options.from, options.from + options.limit);
      const more = options.from + text.length < whole.length;
      return { runId: "run_1", sequence: 1, text, from: options.from, totalChars: whole.length, more, ...(more ? { next: options.from + text.length } : {}) };
    },
  } as never);
  const answer = (args: Record<string, unknown>) => tools.find((tool) => tool.name === "sessions_answer")!.run(args);

  const first = await answer({ sessionId: "session_a", limit: 2_500 });
  // THE STORE WAS ASKED FOR THE FLOOR, not for what the model guessed.
  expect(asked[0]!.limit).toBe(8_000);
  const body = JSON.parse(String((first.content[0] as { text: string }).text)) as { text: string; more: boolean; totalChars: number; note: string };
  expect(body.text).toHaveLength(6_127);
  expect(body.more).toBe(false);
  // AND IT SAYS SO IN WORDS. `more` and `totalChars` have been in this reply
  // since #516 and nothing read them.
  expect(body.note).toContain("That is the whole answer (6127 characters)");
  expect(body.note).toContain("do not read this run again");

  // ABOVE THE FLOOR THE NUMBER IS THE CALLER'S AGAIN — a genuinely long answer
  // is still paged, and the reply hands over the exact next call.
  const long = "y".repeat(40_000);
  const paged = collectTools(sessionQueryTools as never, {
    ...noQueries(),
    answer: async (_id: string, options: { from: number; limit: number }) => {
      const text = long.slice(options.from, options.from + options.limit);
      const more = options.from + text.length < long.length;
      return { runId: "run_2", sequence: 1, text, from: options.from, totalChars: long.length, more, ...(more ? { next: options.from + text.length } : {}) };
    },
  } as never);
  const page = await paged.find((tool) => tool.name === "sessions_answer")!.run({ sessionId: "session_b", limit: 20_000 });
  const first20k = JSON.parse(String((page.content[0] as { text: string }).text)) as { text: string; more: boolean; note: string };
  expect(first20k.text).toHaveLength(20_000);
  expect(first20k.more).toBe(true);
  expect(first20k.note).toContain("Characters 0-20000 of 40000");
  expect(first20k.note).toContain("from: 20000");

  // AND IT PARSED AT ALL, which is the defect that read above found: `json()`
  // clamps at 16,000 and this tool will hand over 64,000, so a caller taking the
  // tool at its word used to get JSON cut off mid-string. The slices are
  // verbatim by contract — see `ANSWER_MAX_CHARS`.
  const whole64k = await paged.find((tool) => tool.name === "sessions_answer")!.run({ sessionId: "session_b", limit: 64_000 });
  const everything = JSON.parse(String((whole64k.content[0] as { text: string }).text)) as { text: string; more: boolean };
  expect(everything.text).toHaveLength(40_000);
  expect(everything.more).toBe(false);
});

/**
 * THE IDENTITY THE TURN'S MEMO KEYS ON — the RESOLVED pair, not the arguments.
 * `runtime.ts` owns the memo; this owns what a reply looks like, and the pairing
 * is what keeps a field rename from silently turning the dedup off.
 */
test("a sessions_answer reply names the run it resolved to, and whether it is finished", () => {
  const reply = (fields: Record<string, unknown>) => JSON.stringify({ runId: "run_1", more: false, ...fields });

  // AN OMITTED runId IS A RESOLUTION THE STORE MADE — worth remembering as "the
  // latest". A named one says nothing about which turn is newest.
  expect(answerIdentity("sessions_answer", { sessionId: "session_a" }, reply({}))).toEqual({ sessionId: "session_a", runId: "run_1", latest: true, whole: true });
  expect(answerIdentity("sessions_answer", { sessionId: "session_a", runId: "run_1" }, reply({}))).toEqual({
    sessionId: "session_a", runId: "run_1", latest: false, whole: true,
  });

  // A HALF-READ RUN IS NOT FINISHED, which is what keeps a caller paging a long
  // answer from being handed a pointer in the middle of it.
  expect(answerIdentity("sessions_answer", { sessionId: "session_a" }, reply({ more: true }))?.whole).toBe(false);

  // ANYTHING IT CANNOT READ IS SIMPLY NOT MEMOISED: another tool, a missing
  // session, an error answer that is not JSON, a reply with no runId.
  expect(answerIdentity("fleet_status", { sessionId: "session_a" }, reply({}))).toBeUndefined();
  expect(answerIdentity("sessions_answer", {}, reply({}))).toBeUndefined();
  expect(answerIdentity("sessions_answer", { sessionId: "session_a" }, "Could not read the answer from \"session_a\": …")).toBeUndefined();
  expect(answerIdentity("sessions_answer", { sessionId: "session_a" }, JSON.stringify({ more: false }))).toBeUndefined();
});

test("a store failure that is not one of the two misses is passed through unchanged", async () => {
  const tools = collectTools(sessionQueryTools as never, {
    ...noQueries(),
    answer: async () => {
      throw new Error("the database is locked");
    },
  } as never);
  const answered = await tools.find((tool) => tool.name === "sessions_answer")!.run({ sessionId: "session_a" });
  expect(String((answered.content[0] as { text: string }).text)).toContain("the database is locked");
});

/* ------------------------------------------------------------------ *
 * The send that cannot land twice.
 * ------------------------------------------------------------------ */

function sendWall(seen: string[]): ReturnType<typeof collectTools> {
  const capability: SessionsCapability = {
    ...noSessions(),
    send: async (_sessionId, input) => {
      seen.push(input.runId);
      return { turn: { runId: input.runId, state: "queued", agentDelivery: "wake" } as Turn, replayed: false };
    },
  };
  return collectTools(sessionsTools as never, capability as never);
}

test("two dispatches of the same tool call id produce one run id", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  const args = { sessionId: "session_a", intent: "task", input: "do it" };
  await send.run(args, { toolCallId: "call_abc" });
  await send.run(args, { toolCallId: "call_abc" });
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]!);
  // Shaped like every other run id, so the store's own `Id` check passes.
  expect(seen[0]).toMatch(/^run_[0-9a-f]{32}$/);
});

test("a different tool call id is a different turn, even with identical arguments", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  const args = { sessionId: "session_a", intent: "task", input: "do it" };
  await send.run(args, { toolCallId: "call_one" });
  await send.run(args, { toolCallId: "call_two" });
  expect(seen[0]).not.toBe(seen[1]!);
});

test("a call id with characters the store would refuse is still a valid run id", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  await send.run({ sessionId: "session_a", input: "hi" }, { toolCallId: "call.with/odd:characters" });
  expect(seen[0]).toMatch(/^run_[0-9a-f]{32}$/);
});

test("no call id keeps the old behaviour — a fresh random id every time", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  await send.run({ sessionId: "session_a", input: "hi" });
  await send.run({ sessionId: "session_a", input: "hi" });
  expect(seen[0]).not.toBe(seen[1]!);
});

/* ------------------------------------------------------------------ *
 * `fleet_status` — one call where there were sixteen (#570).
 * ------------------------------------------------------------------ */

/** A fleet whose three sources can each be set independently, so a test can ask
 *  what one of them contributes without the other two in the way. */
function fleet(
  parts: {
    rail?: FleetSessionRow[];
    projects?: Array<{ id: string; name: string }>;
    subscribed?: string[];
    who?: string;
    elsewhere?: Record<string, FleetSessionRow>;
    lastTurn?: Record<string, { state: string; endedAt?: number; answer: string }>;
    openRequests?: Record<string, number>;
    unread?: Record<string, number>;
    /** When the Agent's previous turn began (#592). Omitted means "no previous
     *  turn", which is the first turn of a thread and makes everything news —
     *  so the tests that predate the recency rule keep testing what they were
     *  about. */
    since?: number;
  } = {},
): { tool: (name: string) => { run: (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }> }; reads: string[] } {
  const reads: string[] = [];
  const capability: AgentFleetCapability = {
    rail: async () => ({ sessions: parts.rail ?? [], projects: parts.projects ?? [] }),
    subscribed: async () => parts.subscribed ?? [],
    who: () => parts.who,
    session: async (id) => {
      reads.push(id);
      return parts.elsewhere?.[id];
    },
    lastTurn: async (id) => parts.lastTurn?.[id],
    openRequests: async (id) => parts.openRequests?.[id] ?? 0,
    unread: () => parts.unread ?? {},
    since: () => parts.since,
  };
  const tools = collectTools(agentFleetTools as never, capability as never);
  return { tool: (name) => tools.find((one) => one.name === name)! as never, reads };
}

const answered = async (built: ReturnType<typeof fleet>, args: Record<string, unknown> = {}) =>
  JSON.parse((await built.tool("fleet_status").run(args)).content[0]!.text!) as {
    sessions: Array<{ id: string; title?: string; projectName?: string; activity: string; lastTurn?: { state: string; endedAt?: number }; lastAnswer?: string; openRequests: number; unreadInbox: number; sources: string[] }>;
    total: number;
    note?: string;
  };

test("fleet_status is the union of the rail, the subscriptions and the notes", async () => {
  const built = fleet({
    rail: [{ id: "session_rail", title: "on the rail", projectId: "p1", activity: "idle", updatedAt: 3 }],
    projects: [{ id: "p1", name: "Telar" }],
    subscribed: ["session_subbed"],
    who: "session_noted is on the lap cap; I am waiting on it.",
    elsewhere: {
      session_subbed: { id: "session_subbed", title: "work I assigned", projectId: "p1", activity: "working" },
      session_noted: { id: "session_noted", title: "named in my notes", activity: "idle" },
    },
  });
  const answer = await answered(built);

  // ALL THREE SOURCES, and each row says which list put it there.
  expect(answer.sessions.map((row) => row.id).sort()).toEqual(["session_noted", "session_rail", "session_subbed"]);
  expect(answer.sessions.find((row) => row.id === "session_rail")!.sources).toEqual(["rail"]);
  expect(answer.sessions.find((row) => row.id === "session_subbed")!.sources).toEqual(["subscribed"]);
  expect(answer.sessions.find((row) => row.id === "session_noted")!.sources).toEqual(["notes"]);
  // The project is named, not just pointed at: a model should not need a second
  // call to turn `p1` into "Telar".
  expect(answer.sessions.find((row) => row.id === "session_rail")!.projectName).toBe("Telar");
  // A session already on the rail is not fetched again.
  expect(built.reads).not.toContain("session_rail");
});

test("a session in two sources is one row that names both", async () => {
  const built = fleet({
    rail: [{ id: "session_a", title: "both", activity: "idle" }],
    subscribed: ["session_a"],
    who: "session_a is the one I assigned.",
  });
  const answer = await answered(built);
  expect(answer.sessions).toHaveLength(1);
  expect(answer.sessions[0]!.sources).toEqual(["notes", "rail", "subscribed"]);
});

test("a note that outlives the session it names drops the row rather than failing", async () => {
  const built = fleet({ who: "session_gone did the dictation work.", elsewhere: {} });
  const answer = await answered(built);
  // The Agent's notes outlive sessions; a status answer must not fail over one
  // stale line of its own bookkeeping.
  expect(answer.sessions).toEqual([]);
  expect(answer.total).toBe(0);
});

test("waiting on a person comes first, then running, then most recently ended", async () => {
  const built = fleet({
    rail: [
      { id: "session_old", title: "ended a while ago", activity: "idle" },
      { id: "session_recent", title: "ended just now", activity: "idle" },
      { id: "session_working", title: "running", activity: "working" },
      { id: "session_blocked", title: "waiting on you", activity: "blocked" },
      { id: "session_asked", title: "has an open request", activity: "idle" },
    ],
    openRequests: { session_asked: 2 },
    lastTurn: {
      session_old: { state: "completed", endedAt: 100, answer: "the old answer" },
      session_recent: { state: "completed", endedAt: 900, answer: "the recent answer" },
      session_blocked: { state: "running", answer: "" },
    },
  });
  const answer = await answered(built);

  // BLOCKED AND ASKED SHARE THE TOP BAND: an open request and `blocked` are the
  // same fact from either end, and either alone would miss a case.
  expect(answer.sessions.slice(0, 2).map((row) => row.id).sort()).toEqual(["session_asked", "session_blocked"]);
  expect(answer.sessions[2]!.id).toBe("session_working");
  // Then the two idle ones, most recently ended first.
  expect(answer.sessions.slice(3).map((row) => row.id)).toEqual(["session_recent", "session_old"]);
});

test("a row carries the last turn and the head of its answer, not the whole thing", async () => {
  const built = fleet({
    rail: [{ id: "session_a", title: "a session", activity: "idle" }],
    lastTurn: { session_a: { state: "completed", endedAt: 7, answer: "x".repeat(500) } },
    unread: { session_a: 3 },
    openRequests: { session_a: 1 },
  });
  const answer = await answered(built);
  const row = answer.sessions[0]!;
  expect(row.lastTurn).toEqual({ state: "completed", endedAt: 7 });
  // Clamped at the notebook's own preview length (#592), with the ellipsis that
  // says it was cut. It was 200 and that was most of a 6,628-character answer.
  expect(row.lastAnswer!.length).toBe(120);
  expect(row.lastAnswer!.endsWith("…")).toBe(true);
  expect(row.unreadInbox).toBe(3);
  expect(row.openRequests).toBe(1);
});

/**
 * THE PROSE IS KEPT WHERE IT IS NEWS AND NOWHERE ELSE (#592).
 *
 * 6,628 characters for thirteen sessions, and the excerpt carried for every one
 * of them — including long-idle sessions in other projects — was most of the
 * bytes and nearly all of the staleness.
 */
test("a session that has not moved since the Agent's previous turn loses its prose", async () => {
  const built = fleet({
    rail: [
      { id: "session_fresh", title: "just finished", activity: "idle" },
      { id: "session_stale", title: "idle since yesterday", activity: "idle" },
      { id: "session_busy", title: "still going", activity: "working" },
    ],
    lastTurn: {
      session_fresh: { state: "completed", endedAt: 500, answer: "the PR is open and green" },
      session_stale: { state: "completed", endedAt: 10, answer: "I finished the dictation work" },
      // A turn still running has no `endedAt` at all.
      session_busy: { state: "running", answer: "starting on the migration" },
    },
    since: 100,
  });
  const answer = await answered(built);
  const row = (id: string) => answer.sessions.find((one) => one.id === id)!;

  // NEWS: ended after the Agent last looked, or still working.
  expect(row("session_fresh").lastAnswer).toBe("the PR is open and green");
  expect(row("session_busy").lastAnswer).toBe("starting on the migration");
  // NOT NEWS: the person has already been told, and an excerpt of it is bytes
  // spent on staleness.
  expect(row("session_stale").lastAnswer).toBeUndefined();
  // WHAT THE ROW IS FOR SURVIVES EITHER WAY — the question is "what is running
  // and what needs me", and none of that is prose.
  expect(row("session_stale").activity).toBe("idle");
  expect(row("session_stale").lastTurn).toEqual({ state: "completed", endedAt: 10 });
  expect(row("session_stale").title).toBe("idle since yesterday");
});

test("the first turn of a conversation has reported nothing, so everything is news", async () => {
  const built = fleet({
    rail: [{ id: "session_a", title: "a session", activity: "idle" }],
    lastTurn: { session_a: { state: "completed", endedAt: 1, answer: "what it concluded" } },
    // No previous turn: this is the thread's first.
  });
  expect((await answered(built)).sessions[0]!.lastAnswer).toBe("what it concluded");
});

test("thirteen sessions cost materially less than the 6,628 characters that were measured", async () => {
  // THE SHAPE OF THE MEASURED FLEET: thirteen sessions across three projects,
  // two of them moving and the rest idle since before this conversation, each
  // with a real answer behind it.
  const sessions = Array.from({ length: 13 }, (_, index) => ({
    id: `session_${index}${"0".repeat(24)}`,
    title: `a reasonably descriptive session title ${index}`,
    projectId: `p${index % 3}`,
    activity: index < 2 ? "working" : "idle",
  }));
  const built = fleet({
    rail: sessions,
    projects: [{ id: "p0", name: "Telar" }, { id: "p1", name: "engine" }, { id: "p2", name: "telar-vr" }],
    lastTurn: Object.fromEntries(
      sessions.map((one, index) => [
        one.id,
        { state: index < 2 ? "running" : "completed", ...(index < 2 ? {} : { endedAt: 10 }), answer: "It concluded something at length, in the sort of paragraph a session writes when it has finished a piece of work and wants to hand it over. ".repeat(4) },
      ]),
    ),
    openRequests: { [sessions[3]!.id]: 1 },
    since: 100,
  });

  const answer = await answered(built);
  expect(JSON.stringify(answer).length).toBeLessThan(3_500);
  // AND IT STILL ANSWERS THE QUESTION. What is running, what needs me, and the
  // two rows that moved keep the line that says what they said.
  expect(answer.sessions).toHaveLength(13);
  expect(answer.sessions.filter((row) => row.activity === "working")).toHaveLength(2);
  expect(answer.sessions[0]!.openRequests).toBe(1);
  expect(answer.sessions.filter((row) => row.lastAnswer !== undefined)).toHaveLength(2);
  expect(answer.sessions.every((row) => (row.lastAnswer?.length ?? 0) <= 120)).toBe(true);
});

test("the answer is bounded by rows and by characters, and says what it left out", async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ id: `session_${index}`, title: `session number ${index}`, activity: "idle" }));
  const built = fleet({
    rail: many,
    lastTurn: Object.fromEntries(many.map((one, index) => [one.id, { state: "completed", endedAt: index, answer: "y".repeat(200) }])),
  });

  const capped = await answered(built);
  // TWENTY IS THE CEILING, whatever was asked for, and the count is honest.
  expect(capped.sessions.length).toBeLessThanOrEqual(20);
  expect(capped.total).toBe(40);
  expect(capped.note).toContain("not shown");

  // AND THE CHARACTER BOUND BITES FIRST on rows this heavy — see FLEET_MAX_CHARS.
  expect(JSON.stringify(capped).length).toBeLessThan(7_000);

  // A caller asking for more than the ceiling is served the ceiling.
  const asked = await answered(built, { limit: 500 });
  expect(asked.sessions.length).toBeLessThanOrEqual(20);

  // And a smaller limit is honoured.
  const few = await answered(built, { limit: 3 });
  expect(few.sessions).toHaveLength(3);
  expect(few.note).toContain("37 more");
});

test("an empty fleet answers a list rather than an error", async () => {
  const answer = await answered(fleet());
  expect(answer).toEqual({ sessions: [], total: 0 });
});

/**
 * WHY `sessions_status` IS NOT NEEDED FOR A SESSION THIS JUST LISTED (#608).
 *
 * Measured repeatedly — four occurrences in one stretch of the log at ~4,200
 * characters — `sessions_status` called on a session `fleet_status` had just
 * described. Not a duplicate any memo can catch: two tools, two shapes, both
 * correct. What was missing is that nothing SAID the row already carried the
 * answer, so this holds that the row does carry it and that the reply says so.
 *
 * AND THAT THEY ARE NOT MERGED, deliberately: `sessions_status` is on the shared
 * sessions wall, bound by every session driver and MCP client, none of which has
 * a fleet for this tool's three sources to read — and it genuinely holds one
 * thing a row does not, which the sentence names rather than hides.
 */
test("a fleet row IS that session's status, and the answer says so where the choice is made", async () => {
  const built = fleet({
    rail: [
      { id: "session_working", title: "mid-turn", activity: "working" },
      { id: "session_blocked", title: "parked on a question", activity: "blocked" },
    ],
    lastTurn: { session_working: { state: "running", answer: "the last thing it said" }, session_blocked: { state: "completed", endedAt: 5, answer: "asked" } },
    openRequests: { session_blocked: 1 },
    since: 1,
  });
  const answer = await answered(built);

  // EVERYTHING `sessions_status` ANSWERS IS ALREADY IN THE ROW: is it running,
  // is it waiting on a person, and how the last turn ended.
  const working = answer.sessions.find((row) => row.id === "session_working")!;
  expect(working.activity).toBe("working");
  expect(working.lastTurn!.state).toBe("running");
  const blocked = answer.sessions.find((row) => row.id === "session_blocked")!;
  expect(blocked.activity).toBe("blocked");
  expect(blocked.openRequests).toBe(1);

  // SAID IN WORDS, on the call that made the question possible — a description
  // is resent on every lap, this is paid once.
  expect(answer.note).toContain("A row IS that session's status");
  // AND THE ONE THING IT DOES NOT CARRY IS NAMED, so the sentence is a routing
  // rule rather than a claim the narrow read is redundant.
  expect(answer.note).toContain("only adds its turn rows");

  // An empty fleet says nothing: there is no row to mistake for a status.
  expect((await answered(fleet())).note).toBeUndefined();
});
