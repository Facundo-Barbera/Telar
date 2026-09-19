import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeProjectSlug,
  describeFork,
  findTranscript,
  forkClaudeConversation,
  listClaudeConversations,
} from "../src/claude-fork";

/**
 * ADOPTING A CONVERSATION WITHOUT WRITING IN SOMEBODY'S HISTORY. The promise
 * #616 makes is that Telar forks rather than continuing in place, and the test
 * that matters most here is the dullest one: after a fork, the source file is
 * byte-identical. Everything else is in service of that.
 *
 * These run against a REAL store in a temp directory, pointed at by
 * `CLAUDE_CONFIG_DIR`, because the thing under test is the SDK's own fork —
 * a file operation on a store laid out the way the CLI lays one out. A mock of
 * `forkSession` would only assert that we call it.
 */

const SOURCE_CWD = "/tmp/telar-fork-source";
const TELAR_CWD = "/tmp/telar-fork-home/worktree-a";

let roots: string[] = [];
let restore: { config?: string; telar?: string } | undefined;

afterEach(() => {
  // THE STORE MUST BE THE TEMP ONE, ALWAYS. The SDK reads `process.env` at
  // call time rather than any env handed to it, so a test that forgot to
  // point it somewhere safe would fork inside the real `~/.claude` — which is
  // somebody's actual conversation history, and exactly what #616 promises
  // not to touch. Setting it is therefore setup, and restoring it is this.
  if (restore) {
    if (restore.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = restore.config;
    if (restore.telar === undefined) delete process.env.TELAR_HOME;
    else process.env.TELAR_HOME = restore.telar;
    restore = undefined;
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

type Built = { env: NodeJS.ProcessEnv; projects: string; sessionId: string; transcript: string };

/**
 * A transcript in the shape the CLI writes one: a parent-linked chain of
 * user/assistant records under a cwd-slug directory. Field names and flags are
 * read off working transcripts; the content is invented, for the reason the
 * fixtures README beside `claude-transcript` gives at length.
 */
function buildStore(options: { compacted?: boolean; turns?: number } = {}): Built {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-fork-"));
  roots.push(root);
  restore = { config: process.env.CLAUDE_CONFIG_DIR, telar: process.env.TELAR_HOME };
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.TELAR_HOME = "/tmp/telar-fork-home";
  const env: NodeJS.ProcessEnv = process.env;
  const projects = path.join(root, "projects");
  const dir = path.join(projects, claudeProjectSlug(SOURCE_CWD));
  fs.mkdirSync(dir, { recursive: true });

  const sessionId = "aaaaaaaa-1111-4111-8111-111111111111";
  const lines: string[] = [];
  let parent: string | null = null;
  let clock = Date.parse("2026-09-01T10:00:00.000Z");
  const uuid = (n: number) => `bbbbbbbb-2222-4222-8222-${String(n).padStart(12, "0")}`;
  const common = (id: string) => ({
    parentUuid: parent,
    isSidechain: false,
    uuid: id,
    timestamp: new Date((clock += 1000)).toISOString(),
    sessionId,
    cwd: SOURCE_CWD,
    version: "2.1.275",
    gitBranch: "main",
    userType: "external",
  });

  const turns = options.turns ?? 3;
  let n = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    if (options.compacted && turn === Math.floor(turns / 2)) {
      const id = uuid(++n);
      lines.push(
        JSON.stringify({
          ...common(id),
          parentUuid: null,
          logicalParentUuid: parent,
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "auto", preTokens: 150_000, postTokens: 12_000 },
        }),
      );
      parent = id;
    }
    const userId = uuid(++n);
    lines.push(JSON.stringify({ ...common(userId), type: "user", message: { role: "user", content: `question ${turn}` } }));
    parent = userId;
    const replyId = uuid(++n);
    lines.push(
      JSON.stringify({
        ...common(replyId),
        type: "assistant",
        message: { role: "assistant", model: "claude-haiku-4-5-20251001", id: `msg_${turn}`, type: "message", content: [{ type: "text", text: `answer ${turn}` }] },
      }),
    );
    parent = replyId;
  }

  const transcript = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${lines.join("\n")}\n`);
  return { env, projects, sessionId, transcript };
}

const records = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("the project slug is Claude's own encoding, not just a path separator swap", () => {
  expect(claudeProjectSlug("/tmp/plain/path")).toBe("-tmp-plain-path");
  // Measured against `listSessions({ dir })`: dots, underscores and spaces go too.
  expect(claudeProjectSlug("/Users/x/My Project/a.b_c")).toBe("-Users-x-My-Project-a-b-c");
});

test("the picker sees a conversation with enough to recognise it", async () => {
  const built = buildStore();
  const rows = await listClaudeConversations({ cwd: SOURCE_CWD, env: built.env });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.sessionId).toBe(built.sessionId);
  expect(rows[0]?.firstPrompt).toContain("question 0");
  expect(rows[0]?.cwd).toBe(SOURCE_CWD);
  expect(rows[0]?.lastActivityAt).toBeGreaterThan(0);
});

test("a fork gets a new id, lands in Telar's own directory, and leaves none behind", async () => {
  const built = buildStore();
  const sourceDir = path.join(built.projects, claudeProjectSlug(SOURCE_CWD));
  const outcome = await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    env: built.env,
  });

  expect(outcome.sessionId).not.toBe(built.sessionId);
  expect(outcome.transcriptPath).toBe(
    path.join(built.projects, claudeProjectSlug(TELAR_CWD), `${outcome.sessionId}.jsonl`),
  );
  expect(fs.existsSync(outcome.transcriptPath)).toBe(true);
  // The whole point of relocating: the person's own project directory still
  // holds exactly what it held before.
  expect(fs.readdirSync(sourceDir)).toEqual([`${built.sessionId}.jsonl`]);
});

test("the original is byte-identical after a fork — the promise the decision was made for", async () => {
  const built = buildStore();
  const before = fs.statSync(built.transcript);
  const bytes = fs.readFileSync(built.transcript);

  const outcome = await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    env: built.env,
  });

  const after = fs.statSync(built.transcript);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(fs.readFileSync(built.transcript).equals(bytes)).toBe(true);
  // Reported too, so a caller can assert it without re-stating the path.
  expect(outcome.source.bytes).toBe(before.size);
  expect(outcome.source.mtimeMs).toBe(before.mtimeMs);
});

test("every carried record says what it was forked from, and carries the new session id", async () => {
  const built = buildStore();
  const outcome = await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    env: built.env,
  });

  const carried = records(outcome.transcriptPath).filter((record) => record.forkedFrom);
  expect(carried.length).toBeGreaterThan(0);
  const sourceUuids = new Set(records(built.transcript).map((record) => record.uuid));
  for (const record of carried) {
    const from = record.forkedFrom as { sessionId: string; messageUuid: string };
    expect(from.sessionId).toBe(built.sessionId);
    // The uuid remap costs no traceability: every new record still names the
    // source record it copies.
    expect(sourceUuids.has(from.messageUuid)).toBe(true);
    expect(record.sessionId).toBe(outcome.sessionId);
  }
});

test("the boundary cut keeps the compaction and what followed it, and nothing earlier", async () => {
  const built = buildStore({ compacted: true, turns: 4 });
  const outcome = await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    cut: "since_compact_boundary",
    env: built.env,
  });

  const kept = records(outcome.transcriptPath);
  expect(kept[0]?.subtype).toBe("compact_boundary");
  expect(kept.length).toBeLessThan(records(built.transcript).length);
  const text = JSON.stringify(kept);
  expect(text).toContain("question 2");
  expect(text).not.toContain("question 0");
  expect(outcome.cut).toBe("since_compact_boundary");
  expect(outcome.records).toBe(kept.length);
});

test("a boundary cut with no boundary in the transcript keeps it whole", async () => {
  const built = buildStore({ compacted: false, turns: 3 });
  const outcome = await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    cut: "since_compact_boundary",
    env: built.env,
  });
  // There is no principled place to cut, so nothing is thrown away.
  expect(JSON.stringify(records(outcome.transcriptPath))).toContain("question 0");
});

test("an adopted conversation is not offered back as something to adopt", async () => {
  const built = buildStore();
  await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    env: built.env,
  });

  const offered = await listClaudeConversations({ env: built.env });
  expect(offered.map((row) => row.sessionId)).toEqual([built.sessionId]);
  const all = await listClaudeConversations({ env: built.env, includeAdopted: true });
  expect(all.length).toBe(2);
});

test("a session id the CLI does not have fails in the sentence the CLI already uses", async () => {
  const built = buildStore();
  const missing = "cccccccc-3333-4333-8333-333333333333";
  await expect(
    forkClaudeConversation({ sourceSessionId: missing, cwd: TELAR_CWD, title: "x", env: built.env }),
  ).rejects.toThrow(`No conversation found with session ID: ${missing}`);
});

test("a relocated fork is still findable by id, which is what keeps it resumable", async () => {
  const built = buildStore();
  const outcome = await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    env: built.env,
  });
  expect(findTranscript(built.projects, outcome.sessionId)).toBe(outcome.transcriptPath);
});

test("the cockpit is told the copy happened, not left to discover it", async () => {
  const built = buildStore();
  const outcome = await forkClaudeConversation({
    sourceSessionId: built.sessionId,
    cwd: TELAR_CWD,
    title: "Adopted into Telar",
    env: built.env,
  });
  expect(describeFork(outcome)).toContain("untouched");
});
