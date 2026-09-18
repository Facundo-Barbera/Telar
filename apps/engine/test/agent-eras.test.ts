/**
 * THE CONVERSATION IN CACHITOS — an era summarised once (#599).
 *
 * `foldOldTurns` re-derived its whole fold from raw on every lap: it stringified
 * every message in the conversation to weigh it and rewrote every folded line.
 * `src/agent/eras.ts` stores the settled part — a run of turns entirely behind
 * the fold's frontier — so it is derived once.
 *
 * What must not drift:
 *
 *   - AN ERA IS COMPUTED ONCE AND REUSED, not recomputed per turn, and the
 *     stored lines are what a later fold actually sends;
 *   - THE FOLD IS UNCHANGED BY THE STORE. It is a cache of a deterministic
 *     projection, so the same conversation must produce the same messages and
 *     stop at the same turn with and without one;
 *   - `recall` STILL FINDS A PHRASE THAT OCCURS ONLY IN A SUMMARISED ERA. This
 *     is the owner's "detalle muy mínimo", and the reason nothing here touches
 *     `agent_rows` or the FTS index;
 *   - only WHOLE eras are sealed, because the fold maps an ordinal onto turn
 *     indices by multiplication;
 *   - eras are scoped to a thread, and a store that reaches past the
 *     conversation is ignored rather than trusted.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { foldOldTurns, isFold } from "../src/agent/compact";
import { AgentEraLog, ERA_TURNS, type AgentEra, type EraStore } from "../src/agent/eras";
import { openAgentCheckpointer } from "../src/agent/checkpointer";
import { AgentThreadLog } from "../src/agent/thread-log";

const contentOf = (message: BaseMessage) => String(message.content);

/** One turn, big enough that a few dozen of them are over any budget worth
 *  testing — the shape `agent-compact.test.ts` already folds. */
const turn = (ask: string, tools: readonly string[], answer: string): BaseMessage[] => [
  new HumanMessage(ask),
  ...tools.flatMap((name, index) => [
    new AIMessage({ content: "", tool_calls: [{ id: `${ask}_${index}`, name, args: {}, type: "tool_call" as const }] }),
    new ToolMessage({ tool_call_id: `${ask}_${index}`, content: "x".repeat(3_000) }),
  ]),
  new AIMessage(answer),
];

/** A conversation of `count` turns, each identifiable by its number. */
const conversation = (count: number): BaseMessage[] =>
  Array.from({ length: count }, (_unused, index) => turn(`question ${index}`, ["sessions_list"], `answer ${index}`)).flat();

/**
 * THE PORT, WITH ITS CALLS COUNTED — how "computed once" is observed.
 *
 * `seals` is every era this store was asked to keep, in order. A second fold
 * over a longer conversation must not ask again for an ordinal it already has,
 * which is the whole claim.
 */
function spyStore(initial: AgentEra[] = []): EraStore & { seals: AgentEra[]; reads: number } {
  const held = [...initial];
  const store = {
    seals: [] as AgentEra[],
    reads: 0,
    sealed: () => {
      store.reads += 1;
      return held;
    },
    seal: (era: AgentEra) => {
      store.seals.push(era);
      if (!held.some((kept) => kept.ordinal === era.ordinal)) held.push(era);
      held.sort((a, b) => a.ordinal - b.ordinal);
    },
  };
  return store;
}

/* ------------------------------------------------------------------ *
 * The store is a cache, and must change nothing.
 * ------------------------------------------------------------------ */

test("the fold sends the same messages and stops at the same turn, with a store and without one", () => {
  const messages = conversation(60);
  const budgetChars = 40_000;
  const plain = foldOldTurns(messages, { budgetChars });
  const stored = foldOldTurns(messages, { budgetChars, eras: spyStore() });
  expect(stored.folded).toBe(plain.folded);
  expect(stored.messages.map(contentOf)).toEqual(plain.messages.map(contentOf));

  // And again, now that the first pass has sealed what it folded — the pass
  // that READS the store has to agree with the one that wrote it.
  const store = spyStore();
  foldOldTurns(messages, { budgetChars, eras: store });
  const reused = foldOldTurns(messages, { budgetChars, eras: store });
  expect(reused.folded).toBe(plain.folded);
  expect(reused.messages.map(contentOf)).toEqual(plain.messages.map(contentOf));
});

test("a conversation inside its budget folds nothing and stores nothing", () => {
  const store = spyStore();
  const messages = conversation(2);
  expect(foldOldTurns(messages, { budgetChars: 500_000, eras: store }).folded).toBe(0);
  expect(store.seals).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Summarised once.
 * ------------------------------------------------------------------ */

test("an era is sealed once and reused, not recomputed per turn", () => {
  const store = spyStore();
  const budgetChars = 40_000;
  // Six turns' worth of new conversation per "turn", so the frontier keeps
  // moving and eras keep aging out.
  let length = 50;
  for (let round = 0; round < 6; round += 1) {
    foldOldTurns(conversation(length), { budgetChars, eras: store });
    length += 6;
  }
  // No ordinal was ever offered twice: every era was derived on the one turn
  // its last turn aged out, and read back on every turn after it.
  const ordinals = store.seals.map((era) => era.ordinal);
  expect(ordinals).toEqual([...new Set(ordinals)]);
  expect(ordinals.length).toBeGreaterThan(0);
  expect(ordinals).toEqual(ordinals.map((_unused, index) => index));
});

test("only whole eras are sealed, and each carries exactly ERA_TURNS turns", () => {
  const store = spyStore();
  foldOldTurns(conversation(60), { budgetChars: 40_000, eras: store });
  expect(store.seals.length).toBeGreaterThan(0);
  for (const era of store.seals) expect(era.turns).toHaveLength(ERA_TURNS);
});

test("the STORED lines are what a later fold sends — the era is not re-derived from raw", () => {
  const messages = conversation(60);
  const budgetChars = 40_000;
  const first = spyStore();
  foldOldTurns(messages, { budgetChars, eras: first });
  expect(first.seals.length).toBeGreaterThan(0);

  /**
   * THE SAME CONVERSATION, WITH ERA 0 CARRYING A LINE NOBODY COULD DERIVE.
   *
   * If the fold re-derived that turn from raw, this phrase could not appear. It
   * is the only way to prove the stored summary was USED rather than merely
   * written, and it is why the seal matters: an era is a record, not a hint.
   */
  const doctored: AgentEra[] = [
    { ordinal: 0, turns: first.seals[0]!.turns.map((kept, index) => (index === 0 ? { ...kept, line: "· the era that was stored" } : kept)) },
  ];
  const later = foldOldTurns(messages, { budgetChars, eras: spyStore(doctored) });
  const block = later.messages.find((message) => isFold(message) && message.getType() === "ai")!;
  expect(String(block.content)).toContain("the era that was stored");
});

test("a store that reaches past the conversation is ignored rather than trusted", () => {
  const messages = conversation(30);
  const budgetChars = 40_000;
  const plain = foldOldTurns(messages, { budgetChars });
  // Three eras is sixty turns, and there are thirty. Lines would land under the
  // wrong numbers, so the fold derives everything from raw instead.
  const tooMany: AgentEra[] = [0, 1, 2].map((ordinal) => ({
    ordinal,
    turns: Array.from({ length: ERA_TURNS }, () => ({ line: "· an era from another conversation", chars: 10 })),
  }));
  const guarded = foldOldTurns(messages, { budgetChars, eras: spyStore(tooMany) });
  expect(guarded.messages.map(contentOf)).toEqual(plain.messages.map(contentOf));
});

/* ------------------------------------------------------------------ *
 * The table.
 * ------------------------------------------------------------------ */

function store(): { eras: AgentEraLog; log: AgentThreadLog; close: () => void; location: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-eras-"));
  const location = path.join(dir, "threads.sqlite");
  const opened = openAgentCheckpointer(location);
  return { eras: new AgentEraLog(opened.db), log: new AgentThreadLog(opened.db), close: () => opened.close(), location };
}

const era = (ordinal: number, mark: string): AgentEra => ({
  ordinal,
  turns: Array.from({ length: ERA_TURNS }, (_unused, index) => ({ line: `· ${mark} ${ordinal}.${index}`, chars: 1_000 })),
});

test("an era survives the process that wrote it, and a second seal of the same ordinal is ignored", () => {
  const held = store();
  held.eras.seal("thread_one", era(0, "first"));
  held.eras.seal("thread_one", era(0, "second"));
  const sealed = held.eras.sealed("thread_one");
  expect(sealed).toHaveLength(1);
  // The FIRST wording stands: an era a conversation has already been told must
  // not change under it.
  expect(sealed[0]!.turns[0]!.line).toContain("first");
  held.close();
});

test("eras are scoped to their thread, and a gap truncates rather than misplacing a line", () => {
  const held = store();
  held.eras.seal("thread_one", era(0, "one"));
  held.eras.seal("thread_one", era(2, "one"));
  held.eras.seal("thread_two", era(0, "two"));
  // Era 1 is missing, so era 2 cannot be placed and is left on disk unread.
  expect(held.eras.sealed("thread_one").map((kept) => kept.ordinal)).toEqual([0]);
  expect(held.eras.sealed("thread_two")[0]!.turns[0]!.line).toContain("two");
  held.close();
});

test("the port reads the table once per turn, however many laps the turn runs", () => {
  const held = store();
  held.eras.seal("thread_one", era(0, "one"));
  const port = held.eras.port("thread_one");
  expect(port.sealed()).toHaveLength(1);
  expect(port.sealed()).toHaveLength(1);
  // A seal invalidates it, because the next lap's fold must see what this one
  // stored.
  port.seal(era(1, "one"));
  expect(port.sealed()).toHaveLength(2);
  held.close();
});

/* ------------------------------------------------------------------ *
 * The detalle muy mínimo — the test this whole design is judged against.
 * ------------------------------------------------------------------ */

test("recall still finds a phrase that occurs ONLY in an era old enough to have been summarised", () => {
  const held = store();
  const threadId = "thread_recall";
  const PHRASE = "the milanesa deploy key";

  /**
   * THE PHRASE IS BURIED WHERE NO FOLD LINE CAN CARRY IT — in the middle of a
   * tool result on the very first turn. `foldedTurnLine` keeps the first 120
   * characters of what was asked and 200 of what was answered, and never a
   * tool result, so a fold of that turn provably drops it. That is the point:
   * the prompt loses the detail and the RECORD does not.
   */
  const buried = `${"y".repeat(2_000)}\n${PHRASE}\n${"z".repeat(2_000)}`;
  const messages: BaseMessage[] = [
    new HumanMessage("question 0"),
    new AIMessage({ content: "", tool_calls: [{ id: "t0", name: "sessions_answer", args: {}, type: "tool_call" as const }] }),
    new ToolMessage({ tool_call_id: "t0", content: buried }),
    new AIMessage("answer 0"),
    ...conversation(59).slice(4),
  ];

  // The transcript is written as it always is, from the tool's own answer.
  held.log.append({ threadId, runId: "run_0", at: 1, kind: "tool_call", detail: { name: "sessions_answer", output: buried } });
  for (let index = 1; index < 60; index += 1) {
    held.log.append({ threadId, runId: `run_${index}`, at: 1 + index, kind: "user_message", detail: { text: `question ${index}` } });
  }

  const port = held.eras.port(threadId);
  const folded = foldOldTurns(messages, { budgetChars: 40_000, eras: port });

  // Turn 0 is behind the frontier and era 0 is sealed, so the detail is gone
  // from what the model is sent.
  expect(folded.folded).toBeGreaterThanOrEqual(ERA_TURNS);
  expect(held.eras.sealed(threadId).length).toBeGreaterThan(0);
  expect(folded.messages.map(contentOf).join("\n")).not.toContain(PHRASE);

  // AND IT IS STILL THERE TO BE FOUND. This is the owner's case: a conversation
  // from today is unlikely to matter in two months, but one tiny detail might.
  const hits = held.log.search(threadId, ["milanesa deploy key"], 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.kind).toBe("tool_call");
  expect(hits[0]!.why).toContain(PHRASE);
  held.close();
});
