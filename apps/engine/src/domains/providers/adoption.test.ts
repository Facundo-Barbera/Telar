import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { claudeProjectSlug } from "../../drivers/claude";

const SOURCE_CWD = "/tmp/telar-adopt-store-source";

const roots: string[] = [];
const stores: EngineStore[] = [];
let restore: { config?: string } | undefined;

afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  if (restore) {
    if (restore.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = restore.config;
    restore = undefined;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(options: { turns?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-adopt-store-"));
  roots.push(root);
  restore = { config: process.env.CLAUDE_CONFIG_DIR };
  const claudeHome = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;

  const projects = path.join(claudeHome, "projects");
  const dir = path.join(projects, claudeProjectSlug(SOURCE_CWD));
  fs.mkdirSync(dir, { recursive: true });

  const sourceSessionId = "aaaaaaaa-1111-4111-8111-111111111111";
  const lines: string[] = [];
  let parent: string | null = null;
  let clock = Date.parse("2026-09-01T10:00:00.000Z");
  const uuid = (n: number) => `bbbbbbbb-2222-4222-8222-${String(n).padStart(12, "0")}`;
  const common = (id: string) => ({
    parentUuid: parent,
    isSidechain: false,
    uuid: id,
    timestamp: new Date((clock += 1000)).toISOString(),
    sessionId: sourceSessionId,
    cwd: SOURCE_CWD,
    version: "2.1.275",
    gitBranch: "main",
    userType: "external",
  });
  let n = 0;
  for (let turn = 0; turn < (options.turns ?? 2); turn += 1) {
    const userId = uuid((n += 1));
    lines.push(JSON.stringify({ ...common(userId), type: "user", message: { role: "user", content: `question ${turn}` } }));
    parent = userId;
    const replyId = uuid((n += 1));
    lines.push(
      JSON.stringify({
        ...common(replyId),
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          id: `msg_${turn}`,
          type: "message",
          content: [{ type: "text", text: `answer ${turn}` }],
        },
      }),
    );
    parent = replyId;
  }
  const transcript = path.join(dir, `${sourceSessionId}.jsonl`);
  fs.writeFileSync(transcript, `${lines.join("\n")}\n`);

  const store = new EngineStore(path.join(root, "engine"), Date.now);
  stores.push(store);
  store.registerProject({ id: "project_one", name: "one", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one", title: "Picked up in Telar" });
  return { store, sourceSessionId, transcript, projects, engineRoot: path.join(root, "engine") };
}

test("an adopted session resumes the FORK, never the person's own conversation", async () => {
  const { store, sourceSessionId } = setup();
  const { provenance } = await store.adoptClaudeConversation("session_one", { sourceSessionId });

  const session = store.getSession("session_one");
  expect(session.resumeCursor).toBe(provenance.sessionId);
  expect(session.resumeCursor).not.toBe(sourceSessionId);
  expect(store.turns("session_one")[0]?.providerSessionId).toBe(provenance.sessionId);
});

test("the person's own transcript is byte-identical afterwards", async () => {
  const { store, sourceSessionId, transcript } = setup();
  const before = fs.statSync(transcript);
  const bytes = fs.readFileSync(transcript);

  await store.adoptClaudeConversation("session_one", { sourceSessionId });

  const after = fs.statSync(transcript);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(fs.readFileSync(transcript).equals(bytes)).toBe(true);
});

test("the history lands as rows on one turn, and the turn is not the person's words", async () => {
  const { store, sourceSessionId } = setup({ turns: 2 });
  const { turn } = await store.adoptClaudeConversation("session_one", { sourceSessionId });

  expect(turn.kind).toBe("import");
  expect(turn.state).toBe("completed");

  const items = store.items("session_one");
  expect(items.every((item) => item.runId === turn.runId)).toBe(true);
  const history = items.filter((item) => item.imported);
  expect(history.length).toBeGreaterThan(0);
  const text = JSON.stringify(history);
  expect(text).toContain("question 0");
  expect(text).toContain("answer 1");
  expect(history.every((item) => item.imported === true)).toBe(true);
  expect(history.every((item) => Boolean(item.providerRefs?.itemId))).toBe(true);
});

test("the head of the history says where it came from", async () => {
  const { store, sourceSessionId } = setup();
  const { turn } = await store.adoptClaudeConversation("session_one", { sourceSessionId });

  const stamp = store.items("session_one").find((item) => item.detail.type === "conversation_import");
  expect(stamp).toBeDefined();
  expect(store.items("session_one")[0]?.id).toBe(stamp!.id);
  if (stamp?.detail.type !== "conversation_import") throw new Error("unreachable");
  expect(stamp.detail.import.sourceSessionId).toBe(sourceSessionId);
  expect(stamp.detail.import.sourceCwd).toBe(SOURCE_CWD);
  expect(stamp.detail.import.firstPrompt).toContain("question 0");
  expect(stamp.detail.import.rows).toBeGreaterThan(0);

  const events = store.readEvents("session_one");
  expect(events.some((event) => event.type === "item.completed" && event.item.detail.type === "conversation_import")).toBe(true);
  expect(turn.input).toContain(sourceSessionId);
});

test("the fork lands under the engine root, and is not offered back as adoptable", async () => {
  const { store, sourceSessionId, projects, engineRoot } = setup();
  const { provenance } = await store.adoptClaudeConversation("session_one", { sourceSessionId });

  expect(
    fs.existsSync(path.join(projects, claudeProjectSlug(path.join(engineRoot, "adopted")), `${provenance.sessionId}.jsonl`)),
  ).toBe(true);

  const offered = await store.listAdoptableClaudeConversations();
  expect(offered.map((row) => row.sessionId)).toEqual([sourceSessionId]);
});

test("a session that has already spoken refuses to adopt", async () => {
  const { store, sourceSessionId } = setup();
  store.submitTurn("session_one", { runId: "run_one", input: "hello" });

  await expect(store.adoptClaudeConversation("session_one", { sourceSessionId })).rejects.toThrow(
    /already started a conversation/,
  );
});

test("a conversation the store does not have is refused in a sentence", async () => {
  const { store } = setup();
  await expect(
    store.adoptClaudeConversation("session_one", { sourceSessionId: "cccccccc-3333-4333-8333-333333333333" }),
  ).rejects.toThrow(/No conversation found with session ID/);
});
