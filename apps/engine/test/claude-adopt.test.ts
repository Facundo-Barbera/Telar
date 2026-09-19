import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adoptClaudeConversation,
  adoptedForkHome,
  describeAdoption,
  listAdoptableConversations,
  withClaudeConfigDir,
} from "../src/claude-adopt";
import { claudeProjectSlug, forkClaudeConversation } from "../src/claude-fork";

/**
 * THE ADOPT STEP, against a REAL Claude store in a temp directory.
 *
 * Two of these tests are the ones that matter. One proves the original is
 * byte-identical after an adoption — the promise the fork decision was made for
 * — and the other proves the wiring would REFUSE if it were not, because a
 * guarantee whose failure branch has never run is a comment.
 *
 * `CLAUDE_CONFIG_DIR` IS SET BEFORE ANY SDK CALL, ALWAYS. The SDK reads it off
 * `process.env` at call time, so a test that forgot would fork inside the real
 * `~/.claude` — somebody's actual conversation history, and the exact thing
 * #616 promises not to touch.
 */

const SOURCE_CWD = "/tmp/telar-adopt-source";

let roots: string[] = [];
let restore: { config?: string; telar?: string } | undefined;

afterEach(() => {
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

type Built = { env: NodeJS.ProcessEnv; projects: string; telarHome: string; sessionId: string; transcript: string };

/** A transcript in the shape the CLI writes one — the same builder the fork
 *  tests use, with a tool call so the reader has something to fold. */
function buildStore(options: { turns?: number; compacted?: boolean } = {}): Built {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-adopt-"));
  roots.push(root);
  const telarHome = path.join(root, "telar-home");
  restore = { config: process.env.CLAUDE_CONFIG_DIR, telar: process.env.TELAR_HOME };
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.TELAR_HOME = telarHome;
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
      const id = uuid((n += 1));
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

  const transcript = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, `${lines.join("\n")}\n`);
  return { env, projects, telarHome, sessionId, transcript };
}

test("the original is byte-identical after an adoption", async () => {
  const built = buildStore();
  const before = fs.statSync(built.transcript);
  const bytes = fs.readFileSync(built.transcript);

  await adoptClaudeConversation({
    sourceSessionId: built.sessionId,
    title: "Adopted into Telar",
    configDir: built.env.CLAUDE_CONFIG_DIR!,
    env: built.env,
  });

  const after = fs.statSync(built.transcript);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(fs.readFileSync(built.transcript).equals(bytes)).toBe(true);
});

test("an adoption that disturbed the original is REFUSED, and leaves no copy behind", async () => {
  const built = buildStore();
  let forkedTo: string | undefined;

  await expect(
    adoptClaudeConversation({
      sourceSessionId: built.sessionId,
      title: "Adopted into Telar",
      configDir: built.env.CLAUDE_CONFIG_DIR!,
      env: built.env,
      // A REAL fork that also writes to the source — the failure the whole
      // design exists to prevent, made to happen so the guard can be seen to
      // fire. Nothing in production passes this.
      fork: async (options) => {
        const outcome = await forkClaudeConversation(options);
        forkedTo = outcome.transcriptPath;
        fs.appendFileSync(built.transcript, "\n");
        // Reported AFTER the write, exactly as the real one reports it.
        const source = fs.statSync(built.transcript);
        return { ...outcome, source: { ...outcome.source, bytes: source.size, mtimeMs: source.mtimeMs } };
      },
    }),
  ).rejects.toThrow(/changed the original transcript/);

  // The refusal is not enough on its own: a fork left in Telar's directory
  // would be a file no session will ever resume.
  expect(forkedTo).toBeDefined();
  expect(fs.existsSync(forkedTo!)).toBe(false);
});

test("the fork lands in Telar's own directory, never in the session's checkout", async () => {
  const built = buildStore();
  const adoption = await adoptClaudeConversation({
    sourceSessionId: built.sessionId,
    title: "Adopted into Telar",
    configDir: built.env.CLAUDE_CONFIG_DIR!,
    env: built.env,
  });

  expect(adoption.fork.transcriptPath).toBe(
    path.join(built.projects, claudeProjectSlug(adoptedForkHome(built.env)), `${adoption.fork.sessionId}.jsonl`),
  );
  // The person's own project directory still holds exactly what it held.
  expect(fs.readdirSync(path.join(built.projects, claudeProjectSlug(SOURCE_CWD)))).toEqual([`${built.sessionId}.jsonl`]);
});

test("the adoption carries the history as rows, every one marked imported", async () => {
  const built = buildStore({ turns: 3 });
  const adoption = await adoptClaudeConversation({
    sourceSessionId: built.sessionId,
    title: "Adopted into Telar",
    configDir: built.env.CLAUDE_CONFIG_DIR!,
    env: built.env,
  });

  expect(adoption.rows.length).toBeGreaterThan(0);
  expect(adoption.rows.every((row) => row.imported)).toBe(true);
  const text = JSON.stringify(adoption.rows);
  expect(text).toContain("question 0");
  expect(text).toContain("answer 2");
});

test("the stamp says where it came from, what was kept, and what it is now", async () => {
  const built = buildStore({ turns: 3 });
  const adoption = await adoptClaudeConversation({
    sourceSessionId: built.sessionId,
    title: "Adopted into Telar",
    configDir: built.env.CLAUDE_CONFIG_DIR!,
    env: built.env,
  });

  const stamp = adoption.provenance;
  expect(stamp.provider).toBe("claude");
  expect(stamp.sourceSessionId).toBe(built.sessionId);
  // NEVER the source: the resumed id is the fork's.
  expect(stamp.sessionId).toBe(adoption.fork.sessionId);
  expect(stamp.sessionId).not.toBe(built.sessionId);
  expect(stamp.sourceCwd).toBe(SOURCE_CWD);
  // The field that actually distinguishes two conversations — the CLI's own
  // titles do not.
  expect(stamp.firstPrompt).toContain("question 0");
  expect(stamp.cut).toBe("whole");
  expect(stamp.rows).toBe(adoption.rows.length);
  expect(stamp.records).toBeGreaterThan(0);
  expect(stamp.sourceBytes).toBe(fs.statSync(built.transcript).size);
  expect(describeAdoption(stamp)).toContain(built.sessionId);
});

test("a boundary cut is reported on both halves — what the model keeps and what the cockpit shows", async () => {
  const built = buildStore({ turns: 4, compacted: true });
  const adoption = await adoptClaudeConversation({
    sourceSessionId: built.sessionId,
    title: "Adopted into Telar",
    cut: "since_compact_boundary",
    configDir: built.env.CLAUDE_CONFIG_DIR!,
    env: built.env,
  });

  expect(adoption.provenance.cut).toBe("since_compact_boundary");
  expect(adoption.provenance.rowCut).toBe("compact_boundary");
  const text = JSON.stringify(adoption.rows);
  expect(text).toContain("question 2");
  expect(text).not.toContain("question 0");
});

test("a conversation the store does not have fails in the CLI's own sentence", async () => {
  const built = buildStore();
  const missing = "cccccccc-3333-4333-8333-333333333333";
  await expect(
    adoptClaudeConversation({
      sourceSessionId: missing,
      title: "Adopted into Telar",
      configDir: built.env.CLAUDE_CONFIG_DIR!,
      env: built.env,
    }),
  ).rejects.toThrow(`No conversation found with session ID: ${missing}`);
});

test("an adopted conversation is not offered back as something to adopt", async () => {
  const built = buildStore();
  await adoptClaudeConversation({
    sourceSessionId: built.sessionId,
    title: "Adopted into Telar",
    configDir: built.env.CLAUDE_CONFIG_DIR!,
    env: built.env,
  });

  const offered = await listAdoptableConversations({ configDir: built.env.CLAUDE_CONFIG_DIR! });
  expect(offered.map((row) => row.sessionId)).toEqual([built.sessionId]);
});

/**
 * THE NEAR-MISS FROM #616, AS A TEST. The SDK takes no config-directory
 * argument: it reads `process.env` when it is called, inside a process the
 * engine owns. So the adopt path has to put the login's directory ON the
 * process for the length of the call — and put back exactly what was there,
 * including the case where there was nothing.
 */
test("the config directory is in effect during the call and restored after it", async () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  let seen: string | undefined = "not-run";
  const answer = await withClaudeConfigDir("/tmp/telar-adopt-login", async () => {
    seen = process.env.CLAUDE_CONFIG_DIR;
    return "done";
  });
  expect(answer).toBe("done");
  expect(seen).toBe("/tmp/telar-adopt-login");
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
});

test("the built-in login DELETES the variable rather than pointing it at the default", async () => {
  const restoreDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/telar-adopt-ambient";
  try {
    let present = true;
    await withClaudeConfigDir(undefined, async () => {
      // Claude keys its credentials per config directory, so pointing the
      // variable at `~/.claude` is NOT the same as leaving it unset — it
      // selects a different, empty Keychain entry.
      present = Object.hasOwn(process.env, "CLAUDE_CONFIG_DIR");
    });
    expect(present).toBe(false);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe("/tmp/telar-adopt-ambient");
  } finally {
    if (restoreDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = restoreDir;
  }
});

test("a thrown call still restores the variable, and does not poison the next one", async () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  await expect(
    withClaudeConfigDir("/tmp/telar-adopt-login", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
  await expect(withClaudeConfigDir("/tmp/telar-adopt-login", async () => "fine")).resolves.toBe("fine");
});
