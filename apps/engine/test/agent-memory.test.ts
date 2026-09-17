/**
 * THE AGENT'S STANDING STATE, AND THE SEARCH OVER ITS OWN ROWS (#541 part F).
 *
 * What must not drift:
 *
 *   - `remember` replaces ONE section and leaves the other three alone, which
 *     is the whole reason there are sections;
 *   - a section is clipped and MARKED, so the document has a ceiling by
 *     arithmetic rather than by a check somebody could forget;
 *   - the standing state is in the SYSTEM PROMPT and never in the transcript;
 *   - `recall` finds a row the prompt no longer carries, and finds it whether
 *     this sqlite has fts5 or not.
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
  preferencesOf,
  readStanding,
  rememberSection,
  renderStanding,
  SECTION_CHARS,
  STANDING_CHARS,
  STANDING_SECTION_KEYS,
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

test("a section too long is clipped and says so", () => {
  const clipped = clipSection("x".repeat(SECTION_CHARS * 3));
  expect(clipped.length).toBeLessThanOrEqual(SECTION_CHARS);
  expect(clipped).toContain("clipped");
});

test("four full sections still fit the document's stated ceiling", () => {
  const paths = agentPaths(root());
  for (const key of STANDING_SECTION_KEYS) rememberSection(paths, key, "y".repeat(SECTION_CHARS * 2));
  const rendered = renderStanding(readStanding(paths))!;
  expect(rendered.length).toBeLessThanOrEqual(STANDING_CHARS);
  // Every section is in it — the cap is per section, so none was dropped.
  for (const key of STANDING_SECTION_KEYS) expect(rendered).toContain("y".repeat(50));
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
    memory: { remember: () => ({ sections: {} }), recall: () => [] },
  }).map((tool) => tool.name);
  expect(withMemory.slice(-2)).toEqual(["remember", "recall"]);
  const without = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() }).map((tool) => tool.name);
  expect(without).not.toContain("remember");
});

test("remember refuses nothing and answers with what the document now holds", async () => {
  const written: Array<[string, string]> = [];
  const tools = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    memory: {
      remember: (section, text) => {
        written.push([section, text]);
        return { sections: { [section]: text } };
      },
      recall: () => [],
    },
  });
  const answer = await tools.find((tool) => tool.name === "remember")!.run({ section: "doing", text: "coordinating #541" });
  expect(written).toEqual([["doing", "coordinating #541"]]);
  expect(answer.isError).toBeUndefined();
  expect(String((answer.content[0] as { text: string }).text)).toContain("coordinating #541");
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
