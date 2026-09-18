/**
 * THE AGENT'S STANDING STATE, AND THE SEARCH OVER ITS OWN ROWS (#541 part F).
 *
 * What must not drift:
 *
 *   - `remember` replaces ONE section and leaves the other three alone, which
 *     is the whole reason there are sections;
 *   - a write ANSWERS with that section alone and never the document (#607) —
 *     the echo made `remember` the biggest consumer of the Agent's context;
 *   - a write over the section's budget is REFUSED, atomically and out loud,
 *     never clipped in silence, and one rewrite gets through;
 *   - the read path still clips, because a file outlives its build — and it
 *     COUNTS what it dropped, per `tool-kit.ts`'s rule;
 *   - the standing state is in the SYSTEM PROMPT and never in the transcript;
 *   - `recall` finds a row the prompt no longer carries, and finds it whether
 *     this sqlite has fts5 or not;
 *   - the standing state sits between the briefing and #541 A's digest, most
 *     permanent first, and neither is in the transcript.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import {
  clipSection,
  CROWDED_CHARS,
  preferencesOf,
  readStanding,
  rememberSection,
  renderStanding,
  SECTION_CHARS,
  standingChars,
  STANDING_CHARS,
  STANDING_SECTION_KEYS,
  type RememberResult,
} from "../src/agent/memory";
import { agentPaths } from "../src/agent/store";
import { AgentRuntime } from "../src/agent/runtime";
import { collectAgentTools } from "../src/agent/tools";
import { AgentThreadLog, searchText } from "../src/agent/thread-log";
import { openAgentCheckpointer, type NativeDatabase } from "../src/agent/checkpointer";
import type { SocketTool } from "../src/mcp-socket";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "telar-agent-memory-"));

/* ------------------------------------------------------------------ *
 * The document.
 * ------------------------------------------------------------------ */

test("remember replaces one section and leaves the others exactly as they were", () => {
  const paths = agentPaths(root());
  rememberSection(paths, "preferences", "Small PRs, conventional commits.");
  rememberSection(paths, "who", "session_a is on the dictation work.");
  rememberSection(paths, "doing", "Coordinating #541.");

  rememberSection(paths, "doing", "Coordinating #541 and #563.");
  const state = readStanding(paths);
  expect(state.sections.doing).toBe("Coordinating #541 and #563.");
  expect(state.sections.preferences).toBe("Small PRs, conventional commits.");
  expect(state.sections.who).toBe("session_a is on the dictation work.");
  expect(state.sections.questions).toBeUndefined();
});

test("empty text clears a section rather than storing an empty one", () => {
  const paths = agentPaths(root());
  rememberSection(paths, "questions", "Waiting on the owner about part C.");
  rememberSection(paths, "questions", "   ");
  expect(readStanding(paths).sections.questions).toBeUndefined();
});

/* ------------------------------------------------------------------ *
 * The budget: refused on the way in, clipped-and-counted on the way out.
 * ------------------------------------------------------------------ */

const written = (result: RememberResult) => {
  if (!result.written) throw new Error(`expected a write, got a refusal of ${result.sent} characters`);
  return result;
};
const refused = (result: RememberResult) => {
  if (result.written) throw new Error("expected a refusal, got a write");
  return result;
};

test("a write over the section budget is refused, and refused ATOMICALLY", () => {
  const paths = agentPaths(root());
  rememberSection(paths, "doing", "Coordinating #541.");

  const result = refused(rememberSection(paths, "doing", "x".repeat(SECTION_CHARS + 1)));
  expect(result.sent).toBe(SECTION_CHARS + 1);
  expect(result.limit).toBe(SECTION_CHARS);
  expect(result.over).toBe(1);
  // What it holds rides back, so the rewrite does not cost a read as well.
  expect(result.holding).toBe("Coordinating #541.");
  // NOTHING WAS WRITTEN — not a clipped version, not an empty one.
  expect(readStanding(paths).sections.doing).toBe("Coordinating #541.");
});

test("a refusal is followed by a rewrite that gets through — it cannot loop", () => {
  const paths = agentPaths(root());
  rememberSection(paths, "doing", ["#541 part F", "#576 RESOLVED", "#563 RESOLVED"].join("\n"));

  const no = refused(rememberSection(paths, "doing", "z".repeat(SECTION_CHARS + 200)));
  // The error is actionable on its own: it says what is held, so the second
  // attempt is composed from `holding` with the settled lines struck out.
  const shorter = no.holding.split("\n").filter((line) => !line.includes("RESOLVED")).join("\n");
  const yes = written(rememberSection(paths, "doing", shorter));
  expect(yes.chars).toBe("#541 part F".length);
  expect(readStanding(paths).sections.doing).toBe("#541 part F");
});

test("exactly at the budget is a write; one character over is not", () => {
  const paths = agentPaths(root());
  expect(written(rememberSection(paths, "doing", "a".repeat(SECTION_CHARS))).chars).toBe(SECTION_CHARS);
  expect(refused(rememberSection(paths, "who", "a".repeat(SECTION_CHARS + 1))).over).toBe(1);
});

test("the read path still clips — and COUNTS what it dropped, never silently", () => {
  const clipped = clipSection("x".repeat(SECTION_CHARS * 3));
  expect(clipped.text.length).toBeLessThanOrEqual(SECTION_CHARS);
  expect(clipped.dropped).toBeGreaterThan(SECTION_CHARS);
  // The count is in the mark, so a reader of the document knows how much went.
  expect(clipped.text).toContain(`${clipped.dropped} characters dropped`);
  // And text that fits is returned untouched, at no cost.
  expect(clipSection("  short  ")).toEqual({ text: "short", dropped: 0 });
});

test("a memory.json holding an over-long section still renders inside the ceiling", () => {
  const paths = agentPaths(root());
  fs.mkdirSync(paths.dir, { recursive: true });
  // What an older build — or a person with an editor — can leave behind.
  fs.writeFileSync(
    path.join(paths.dir, "memory.json"),
    JSON.stringify({ version: 1, sections: Object.fromEntries(STANDING_SECTION_KEYS.map((key) => [key, "y".repeat(SECTION_CHARS * 4)])) }),
  );
  const rendered = renderStanding(readStanding(paths))!;
  expect(rendered.length).toBeLessThanOrEqual(STANDING_CHARS);
  expect(rendered).toContain("characters dropped");
});

test("four full sections still fit the document's stated ceiling", () => {
  const paths = agentPaths(root());
  for (const key of STANDING_SECTION_KEYS) rememberSection(paths, key, "y".repeat(SECTION_CHARS));
  const rendered = renderStanding(readStanding(paths))!;
  expect(rendered.length).toBeLessThanOrEqual(STANDING_CHARS);
  // Every section is in it — the cap is per section, so none was dropped.
  for (const key of STANDING_SECTION_KEYS) expect(rendered).toContain("y".repeat(50));
});

test("the document's bound holds across many turns, on a fixture rather than by assertion", () => {
  const paths = agentPaths(root());
  let lines: string[] = [];
  let refusals = 0;
  // Two hundred turns of an Agent that only ever APPENDS — #607's actual
  // failure, where every settled item became a "RESUELTO: #NNN" line.
  for (let turn = 0; turn < 200; turn += 1) {
    lines.push(`#${600 + turn} ${turn % 3 === 0 ? "RESUELTO" : "in flight"} — a line of roughly the length these really are`);
    const result = rememberSection(paths, "doing", lines.join("\n"));
    if (!result.written) {
      refusals += 1;
      // What the Agent is told to do, done: settled lines OUT.
      lines = lines.filter((line) => !line.includes("RESUELTO"));
      // And if that is still not enough, the oldest go until it fits.
      while (!rememberSection(paths, "doing", lines.join("\n")).written) lines.shift();
    }
    expect(standingChars(readStanding(paths))).toBeLessThanOrEqual(STANDING_CHARS);
    expect((readStanding(paths).sections.doing ?? "").length).toBeLessThanOrEqual(SECTION_CHARS);
  }
  // It really did hit the wall repeatedly — otherwise this proves nothing.
  expect(refusals).toBeGreaterThan(1);
  // And it came back DOWN, which is the half of #607 that was missing: the
  // document was measured 448 → 3,698 and never once smaller.
  expect((readStanding(paths).sections.doing ?? "").length).toBeLessThan(SECTION_CHARS);
});

test("writing the same section twice with identical text does not grow the document", () => {
  const paths = agentPaths(root());
  const text = "Coordinating #541, #563 and #607.";
  const first = written(rememberSection(paths, "doing", text));
  const second = written(rememberSection(paths, "doing", text));
  expect(second.chars).toBe(first.chars);
  expect(second.standing).toBe(first.standing);
  expect(readStanding(paths).sections.doing).toBe(text);
});

test("a write answers with its own section's size and the others' sizes, never their text", () => {
  const paths = agentPaths(root());
  rememberSection(paths, "who", "session_a is on the dictation work.");
  rememberSection(paths, "preferences", "Small PRs, conventional commits.");

  const result = written(rememberSection(paths, "doing", "Coordinating #541."));
  expect(result.section).toBe("doing");
  expect(result.chars).toBe("Coordinating #541.".length);
  expect(result.others).toEqual({
    who: "session_a is on the dictation work.".length,
    preferences: "Small PRs, conventional commits.".length,
  });
  // `doing` is not in `others` — it is the one that was written.
  expect(Object.keys(result.others)).not.toContain("doing");
  // The whole rendered document, which is what it costs on every turn.
  expect(result.standing).toBe(standingChars(readStanding(paths)));
});

test("an empty document renders nothing at all", () => {
  expect(renderStanding({ sections: {} })).toBeUndefined();
});

test("a memory.json somebody broke costs the notes, not the turn", () => {
  const paths = agentPaths(root());
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(path.join(paths.dir, "memory.json"), "{ not json");
  expect(readStanding(paths)).toEqual({ sections: {} });
});

test("the preferences section is reachable on its own — what a reset keeps", () => {
  const paths = agentPaths(root());
  rememberSection(paths, "preferences", "Ask before opening a PR.");
  expect(preferencesOf(readStanding(paths))).toBe("Ask before opening a PR.");
  expect(preferencesOf({ sections: {} })).toBeUndefined();
});

/* ------------------------------------------------------------------ *
 * The wall.
 * ------------------------------------------------------------------ */

const noSessions = () =>
  ({
    self: { sessionId: "agent" },
    list: async () => ({ sessions: [], projects: [] }),
    create: async () => ({}),
    send: async () => ({}),
    read: async () => [],
    status: async () => ({}),
    stop: async () => ({}),
    settle: async () => ({}),
    diff: async () => ({}),
    subscribe: async () => ({}),
    unsubscribe: async () => false,
    subscriptions: async () => [],
    requests: async () => [],
    resolveRequest: async () => ({}),
  }) as never;
const noNotes = () => ({ projects: async () => [], list: async () => [], read: async () => null, create: async () => ({}), update: async () => null, remove: async () => false }) as never;
const noQueries = () =>
  ({
    find: async () => ({ sessions: [], index: "like", more: false }),
    outline: async () => ({ turns: [], total: 0, more: false }),
    answer: async () => ({ runId: "run_1", sequence: 1, text: "", from: 0, totalChars: 0, more: false }),
  }) as never;

test("the two memory tools are on the wall, and only when the Agent brought them", () => {
  const withMemory = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    memory: { remember: (section) => ({ written: true, section, chars: 0, others: {}, standing: 0 }), recall: () => [] },
  }).map((tool) => tool.name);
  expect(withMemory.slice(-2)).toEqual(["remember", "recall"]);
  const without = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() }).map((tool) => tool.name);
  expect(without).not.toContain("remember");
});

/** The wall over one real document, so a tool answer can be measured. */
function memoryWall(paths: ReturnType<typeof agentPaths>) {
  const tools = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    memory: { remember: (section, text) => rememberSection(paths, section, text), recall: () => [] },
  });
  const remember = tools.find((tool) => tool.name === "remember")!;
  return async (section: string, text: string) => {
    const answer = await remember.run({ section, text });
    return { isError: answer.isError === true, text: String((answer.content[0] as { text: string }).text) };
  };
}

/** A note of the shape #607 measured: the other three sections near enough
 *  full, so the document is the ~3.7 KB the issue found in the log. */
const FILLED = 880;
const filled = (lead: string) => lead.padEnd(FILLED, ".").slice(0, FILLED);

function fullNote(paths: ReturnType<typeof agentPaths>) {
  rememberSection(paths, "who", filled("session_a is on #576. session_b is on #563. session_c idle."));
  rememberSection(paths, "questions", filled("Waiting on the owner about part C of #541."));
  rememberSection(paths, "preferences", filled("Small PRs. Conventional commits. Ask before pushing."));
}

test("a single-section write answers with that section alone — the whole note is not echoed", async () => {
  const paths = agentPaths(root());
  fullNote(paths);
  const call = memoryWall(paths);

  const answer = await call("doing", "Coordinating #541 and #607.");
  expect(answer.isError).toBe(false);
  const body = JSON.parse(answer.text) as { section: string; chars: number; others: Record<string, number>; standing: number; note: string };

  expect(body.section).toBe("doing");
  expect(body.chars).toBe("Coordinating #541 and #607.".length);
  // LENGTHS, NOT TEXT. The three sections it did not touch are numbers.
  expect(body.others).toEqual({ who: FILLED, questions: FILLED, preferences: FILLED });
  for (const other of ["session_a is on #576", "Waiting on the owner", "Conventional commits"]) {
    expect(answer.text).not.toContain(other);
  }
});

test("the answer is a small fraction of the note it wrote into", async () => {
  const paths = agentPaths(root());
  fullNote(paths);
  const answer = await memoryWall(paths)("doing", "Coordinating #541 and #607.");
  const note = standingChars(readStanding(paths));

  // #607 measured 3,686 characters returned to write one section. The whole
  // note is still that big — the ANSWER is what shrank.
  expect(note).toBeGreaterThan(2_000);
  expect(answer.text.length).toBeLessThan(note / 5);
  expect(answer.text.length).toBeLessThan(500);
});

test("a write over the budget is an ERROR the model can act on, not a silent clip", async () => {
  const paths = agentPaths(root());
  rememberSection(paths, "doing", "#541 part F\n#576 RESUELTO");
  const call = memoryWall(paths);

  const answer = await call("doing", "q".repeat(SECTION_CHARS + 50));
  expect(answer.isError).toBe(true);
  expect(answer.text).toContain("NOTHING WAS WRITTEN");
  expect(answer.text).toContain(String(SECTION_CHARS + 50));
  expect(answer.text).toContain("50 over");
  // It carries what the section holds, which is what makes one rewrite enough.
  expect(answer.text).toContain("#576 RESUELTO");
  expect(readStanding(paths).sections.doing).toBe("#541 part F\n#576 RESUELTO");

  // And the rewrite lands.
  const second = await call("doing", "#541 part F");
  expect(second.isError).toBe(false);
  expect(readStanding(paths).sections.doing).toBe("#541 part F");
});

test("a crowded note is told it is crowded, and told what to do about it", async () => {
  const paths = agentPaths(root());
  const call = memoryWall(paths);

  const roomy = JSON.parse((await call("doing", "Coordinating #541.")).text) as { standing: number; note: string };
  expect(roomy.standing).toBeLessThan(CROWDED_CHARS);
  expect(roomy.note).not.toContain("DELETE");

  fullNote(paths);
  const crowded = JSON.parse((await call("doing", "Coordinating #541 and #607.")).text) as { standing: number; note: string };
  expect(crowded.standing).toBeGreaterThan(CROWDED_CHARS);
  expect(crowded.note).toContain("DELETE what is settled");
  expect(crowded.note).toContain(String(crowded.standing));
});

/* ------------------------------------------------------------------ *
 * Through the runtime: the prompt, the transcript, and recall.
 * ------------------------------------------------------------------ */

type Step = { text?: string; toolCalls?: ToolCall[] };

class ScriptedChatModel extends BaseChatModel {
  index = 0;
  readonly seen: BaseMessage[][] = [];
  constructor(private readonly script: Step[]) {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const step = this.script[this.index] ?? { text: "done" };
    this.index += 1;
    const message = new AIMessage({ content: step.text ?? "", tool_calls: step.toolCalls ?? [] });
    return { generations: [{ text: step.text ?? "", message }] };
  }
}

async function until(check: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function agentOver(engineRoot: string, script: Step[], extra: SocketTool[] = []) {
  const model = new ScriptedChatModel(script);
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => [
      ...collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries(), memory: agent.memory() }),
      ...extra,
    ],
    model: () => model,
  });
  agent.patch({ enabled: true });
  return { agent, model };
}

test("what was remembered is in the system prompt on the next turn, and in no message", async () => {
  const engineRoot = root();
  const { agent, model } = agentOver(engineRoot, [
    { toolCalls: [{ id: "call_1", name: "remember", args: { section: "who", text: "session_a is on the dictation work." }, type: "tool_call" }] },
    { text: "noted." },
    { text: "still noted." },
  ]);

  agent.submit({ text: "session_a is doing dictation" });
  await until(() => agent.state().running === false, "the first turn");
  agent.submit({ text: "who is on what?" });
  await until(() => agent.state().running === false && agent.state().queued === 0, "the second turn");

  const second = model.seen.at(-1)!;
  const system = second[0] as SystemMessage;
  expect(system.getType()).toBe("system");
  expect(String(system.content)).toContain("Who is on what");
  expect(String(system.content)).toContain("session_a is on the dictation work.");
  // NEVER IN THE TRANSCRIPT: the only place that sentence appears is the system
  // block and the tool call that wrote it.
  const asMessages = second.slice(1).map((message) => String(message.content)).join("\n");
  expect(asMessages).not.toContain("Who is on what");
  agent.close();
});

test("recall finds a row from a turn the prompt no longer carries", async () => {
  const engineRoot = root();
  const { agent } = agentOver(engineRoot, [{ text: "The dictation language picker went in on Tuesday." }]);
  agent.submit({ text: "what happened with dictation?" });
  await until(() => agent.state().running === false, "the turn");

  const hits = agent.memory().recall("dictation", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((hit) => hit.why.includes("dictation"))).toBe(true);
  // Newest first, and every hit names the run it came from so the transcript
  // can be opened at it.
  expect(hits[0]!.runId).toMatch(/^run_/);
  agent.close();
});

test("recall answers nothing rather than throwing when the Agent has no thread", () => {
  const agent = new AgentRuntime({ engineRoot: root(), tools: () => [], model: () => new ScriptedChatModel([]) });
  expect(agent.memory().recall("anything", 5)).toEqual([]);
  agent.close();
});

test("recall searches the tool answers too, which is where the facts are", async () => {
  const engineRoot = root();
  const found: SocketTool = {
    name: "sessions_find_fixture",
    description: "a fixture",
    shape: {},
    run: async () => ({ content: [{ type: "text", text: JSON.stringify({ sessions: [{ id: "session_a", why: "the appearance rework" }] }) }] }),
  };
  const { agent } = agentOver(engineRoot, [{ toolCalls: [{ id: "call_1", name: "sessions_find_fixture", args: {}, type: "tool_call" }] }, { text: "found it" }], [found]);
  agent.submit({ text: "find the appearance thread" });
  await until(() => agent.state().running === false, "the turn");

  const hits = agent.memory().recall("appearance", 5);
  expect(hits.some((hit) => hit.kind === "tool_call")).toBe(true);
  agent.close();
});

/* ------------------------------------------------------------------ *
 * Reset keeps the preferences; disable keeps everything.
 * ------------------------------------------------------------------ */

test("reset writes the preferences out BEFORE it clears anything, and clears the rest", async () => {
  const engineRoot = root();
  const order: string[] = [];
  const kept: string[] = [];
  const model = new ScriptedChatModel([{ text: "noted." }]);
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => [],
    model: () => model,
    keepPreferences: (preferences) => {
      // The document is still on disk at this moment — that is the ordering the
      // reset depends on.
      order.push(readStanding(agentPaths(engineRoot)).sections.doing ? "document still here" : "document gone");
      kept.push(preferences);
    },
  });
  agent.patch({ enabled: true });
  const paths = agentPaths(engineRoot);
  rememberSection(paths, "doing", "coordinating #541");
  rememberSection(paths, "who", "session_a is on part F");
  rememberSection(paths, "preferences", "Small PRs. Ask before opening one.");
  agent.submit({ text: "hello" });
  await until(() => agent.state().running === false, "the turn");

  agent.patch({ reset: true });
  expect(kept).toEqual(["Small PRs. Ask before opening one."]);
  expect(order).toEqual(["document still here"]);
  // Everything else is gone: the standing state, and the conversation with it.
  expect(readStanding(paths)).toEqual({ sections: {} });
  expect(agent.thread().rows).toEqual([]);
  agent.close();
});

test("reset with nothing remembered writes no note at all", () => {
  const engineRoot = root();
  const kept: string[] = [];
  const agent = new AgentRuntime({ engineRoot, tools: () => [], model: () => new ScriptedChatModel([]), keepPreferences: (text) => kept.push(text) });
  agent.patch({ enabled: true });
  rememberSection(agentPaths(engineRoot), "doing", "coordinating #541");
  agent.patch({ reset: true });
  expect(kept).toEqual([]);
  agent.close();
});

test("a notebook that refuses the note does not stop the reset", () => {
  const engineRoot = root();
  const agent = new AgentRuntime({
    engineRoot,
    tools: () => [],
    model: () => new ScriptedChatModel([]),
    keepPreferences: () => {
      throw new Error("the notebook is unwritable");
    },
  });
  agent.patch({ enabled: true });
  rememberSection(agentPaths(engineRoot), "preferences", "Small PRs.");
  expect(() => agent.patch({ reset: true })).not.toThrow();
  expect(readStanding(agentPaths(engineRoot))).toEqual({ sections: {} });
  agent.close();
});

test("disable keeps everything — the standing state included", async () => {
  const engineRoot = root();
  const { agent } = agentOver(engineRoot, [{ text: "noted." }]);
  const paths = agentPaths(engineRoot);
  rememberSection(paths, "doing", "coordinating #541");
  agent.submit({ text: "hello" });
  await until(() => agent.state().running === false, "the turn");

  agent.patch({ enabled: false });
  expect(readStanding(paths).sections.doing).toBe("coordinating #541");
  agent.patch({ enabled: true });
  expect(readStanding(paths).sections.doing).toBe("coordinating #541");
  agent.close();
});

/* ------------------------------------------------------------------ *
 * recall on both sqlite builds.
 * ------------------------------------------------------------------ */

/** A database that answers everything except `CREATE VIRTUAL TABLE … fts5` —
 *  which is the OTHER supported configuration, not a fault: `node:sqlite` under
 *  Electron-as-Node may be built without the module. `execution-store.ts` takes
 *  the same two paths for the same reason. */
function withoutFts5(db: NativeDatabase): NativeDatabase {
  return {
    exec: (sql: string) => {
      if (sql.includes("fts5")) throw new Error("no such module: fts5");
      return db.exec(sql);
    },
    prepare: (sql: string) => db.prepare(sql),
    close: () => db.close(),
  };
}

function rows(log: AgentThreadLog, threadId: string) {
  log.append({ threadId, runId: "run_1", at: 1, kind: "user_message", detail: { text: "what happened with the dictation language picker" } });
  log.append({ threadId, runId: "run_1", at: 2, kind: "assistant_message", detail: { text: "It went in on Tuesday, on both platforms." } });
  log.append({ threadId, runId: "run_1", at: 3, kind: "turn_started", detail: {} });
  log.append({ threadId, runId: "run_2", at: 4, kind: "user_message", detail: { text: "and the appearance rework?" } });
}

test("recall finds the same row with fts5 and without it", () => {
  const opened = openAgentCheckpointer(":memory:");
  const fast = new AgentThreadLog(opened.db);
  expect(fast.searchIndex).toBe("fts5");
  rows(fast, "thread_a");
  const found = fast.search("thread_a", ["dictation"], 5);
  expect(found).toHaveLength(1);
  expect(found[0]!.kind).toBe("user_message");
  expect(found[0]!.why).toContain("dictation");
  opened.close();

  const plain = openAgentCheckpointer(":memory:");
  const slow = new AgentThreadLog(withoutFts5(plain.db));
  expect(slow.searchIndex).toBe("like");
  rows(slow, "thread_a");
  const scanned = slow.search("thread_a", ["dictation"], 5);
  expect(scanned).toHaveLength(1);
  expect(scanned[0]!.why).toContain("dictation");
  plain.close();
});

test("a row that says nothing is not in the index for every query to skip", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  rows(log, "thread_a");
  // `turn_started` carries no text, so nothing matches a search for its kind.
  expect(log.search("thread_a", ["turn_started"], 5)).toEqual([]);
  expect(searchText("turn_started", {})).toBe("");
  opened.close();
});

test("rows written before the index existed are caught up on the next open", () => {
  const opened = openAgentCheckpointer(":memory:");
  // A log that never had the virtual table writes the rows and indexes nothing.
  const before = new AgentThreadLog(withoutFts5(opened.db));
  rows(before, "thread_a");
  expect(before.searchIndex).toBe("like");

  // The same database, opened by a build that HAS fts5: the catch-up runs once.
  const after = new AgentThreadLog(opened.db);
  expect(after.searchIndex).toBe("fts5");
  expect(after.search("thread_a", ["dictation"], 5)).toHaveLength(1);
  opened.close();
});

test("recall is scoped to one thread — an archived conversation answers nothing", () => {
  const opened = openAgentCheckpointer(":memory:");
  const log = new AgentThreadLog(opened.db);
  rows(log, "thread_a");
  expect(log.search("thread_b", ["dictation"], 5)).toEqual([]);
  opened.close();
});

/* ------------------------------------------------------------------ *
 * Standing state beside the digest — #541 parts A and F in one prompt.
 * ------------------------------------------------------------------ */

test("the system block carries the briefing, then the standing state, then the digest", async () => {
  const engineRoot = root();
  const { agent, model } = agentOver(engineRoot, [{ text: "read them both." }]);
  rememberSection(agentPaths(engineRoot), "doing", "coordinating #541 across three sessions");

  // A worker finishing writes an inbox row and starts nothing (#541 A).
  agent.wake({
    notification: {
      kind: "wake",
      wakeKind: "turn_completed",
      sessionId: "session_aaaaaaaa",
      runId: "run_9",
      summary: "Session session_a finished a turn",
    } as never,
  });

  agent.submit({ text: "what happened?" });
  await until(() => agent.state().running === false, "the turn");

  const system = String((model.seen.at(-1)![0] as SystemMessage).content);
  const standingAt = system.indexOf("coordinating #541 across three sessions");
  const digestAt = system.indexOf("Session session_a finished a turn");
  expect(standingAt).toBeGreaterThan(-1);
  expect(digestAt).toBeGreaterThan(-1);
  // MOST PERMANENT FIRST: the briefing, then what is true now, then the news.
  expect(system.indexOf("You are Telar's Agent")).toBeLessThan(standingAt);
  expect(standingAt).toBeLessThan(digestAt);
  // AND NEITHER IS IN THE TRANSCRIPT — the person's words are their own.
  expect(agent.thread({ limit: 50 }).rows.find((row) => row.kind === "user_message")!.detail.text).toBe("what happened?");
  agent.close();
});
