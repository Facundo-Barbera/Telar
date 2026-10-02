import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attributeClaudeLogs } from "./log-attribution";
import type { RatesTable } from "./pricing";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const RATES: RatesTable = { status: "fresh", rates: new Map() };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

let message = 0;
function transcript(root: string, name: string, input: { sessionId: string; cwd: string; tokens: number; extra?: object[]; at?: number }) {
  const dir = path.join(root, input.cwd.replaceAll("/", "-"));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", sessionId: input.sessionId, cwd: input.cwd, message: { role: "user", content: "hi" } },
    ...(input.extra ?? []),
    {
      type: "assistant",
      sessionId: input.sessionId,
      cwd: input.cwd,
      timestamp: new Date(input.at ?? NOW - 3_600_000).toISOString(),
      requestId: `req_${++message}`,
      message: { id: `msg_${message}`, model: "claude-sonnet-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: input.tokens, cache_creation_input_tokens: 0 } },
    },
  ];
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

async function attribute(build: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-claude-logs-"));
  roots.push(root);
  build(root);
  const rows = await attributeClaudeLogs({
    logsRoot: root,
    sinceMs: NOW - 30 * 86_400_000,
    rates: RATES,
    storeSessions: new Set(["claude-session-in-store"]),
    storeFolders: ["/home/me/.telar/engine/worktrees"],
    telarFolders: ["/code/acme"],
  });
  return Object.fromEntries(rows.map((row) => [path.basename(row.file, ".jsonl"), row.bucket]));
}

test("a transcript this store resumed, or one in its worktrees, is this store's", async () => {
  const buckets = await attribute((root) => {
    transcript(root, "resumed", { sessionId: "claude-session-in-store", cwd: "/anywhere", tokens: 10 });
    transcript(root, "worktree", { sessionId: "other", cwd: "/home/me/.telar/engine/worktrees/acme-1/src", tokens: 10 });
  });

  expect(buckets).toEqual({ resumed: "store", worktree: "store" });
});

test("Telar's own markers, a registered project or another worktrees folder make a transcript Telar's but not this store's", async () => {
  const buckets = await attribute((root) => {
    transcript(root, "tools", { sessionId: "a", cwd: "/somewhere", tokens: 10, extra: [{ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__telar__sessions_send" }] } }] });
    transcript(root, "notice", { sessionId: "b", cwd: "/somewhere", tokens: 10, extra: [{ type: "user", message: { content: "[agent message · result] session x sent this session a result" } }] });
    transcript(root, "project", { sessionId: "c", cwd: "/code/acme/web", tokens: 10 });
    transcript(root, "elsewhere", { sessionId: "d", cwd: "/Volumes/Big/worktrees/acme-2", tokens: 10 });
  });

  expect(buckets).toEqual({ tools: "telar", notice: "telar", project: "telar", elsewhere: "telar" });
});

test("only a transcript with no Telar evidence at all is outside Telar", async () => {
  const buckets = await attribute((root) => {
    transcript(root, "plain", { sessionId: "e", cwd: "/home/me/scratch", tokens: 10 });
  });

  expect(buckets).toEqual({ plain: "outside" });
});

test("usage older than the window, and repeated messages, are not counted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-claude-logs-"));
  roots.push(root);
  transcript(root, "old", { sessionId: "f", cwd: "/x", tokens: 10, at: NOW - 40 * 86_400_000 });
  transcript(root, "fresh", { sessionId: "g", cwd: "/x", tokens: 7 });
  const fresh = path.join(root, "-x", "fresh.jsonl");
  fs.copyFileSync(fresh, path.join(root, "-x", "copy.jsonl"));

  const rows = await attributeClaudeLogs({ logsRoot: root, sinceMs: NOW - 30 * 86_400_000, rates: RATES, storeSessions: new Set(), storeFolders: [], telarFolders: [] });

  expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(7);
});
