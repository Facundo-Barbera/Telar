import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reapNodeModules, reapReport, type ReapCandidate } from "./node-modules-reap";

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const NOW = Date.parse("2026-03-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reap-"));
  made.push(root);
  return root;
}

function checkout(root: string, sessionId: string, bytes = 0): string {
  const worktree = path.join(root, "worktrees", sessionId);
  fs.mkdirSync(path.join(worktree, "node_modules", "some-package"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "node_modules", "some-package", "index.js"), "module.exports = 1;\n");
  if (bytes > 0) fs.writeFileSync(path.join(worktree, "node_modules", "some-package", "payload"), crypto.getRandomValues(new Uint8Array(bytes)));
  fs.writeFileSync(path.join(worktree, "README.md"), "the person's uncommitted work\n");
  return worktree;
}

const candidate = (sessionId: string, worktree: string, patch: Partial<ReapCandidate> = {}): ReapCandidate =>
  ({ sessionId, worktree, archived: true, live: false, ...patch });

test("an archived session's node_modules goes, and its work does not", async () => {
  const root = home();
  const worktree = checkout(root, "session_archived");
  const reap = await reapNodeModules(root, [candidate("session_archived", worktree)], { now: () => NOW });
  expect(reap.reaped).toHaveLength(1);
  expect(reap.reaped[0]!.sessionId).toBe("session_archived");
  expect(reap.reaped[0]!.files).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  expect(fs.readFileSync(path.join(worktree, "README.md"), "utf8")).toContain("uncommitted work");
});

test("a session that is not archived is refused, and the remover is never called", async () => {
  const root = home();
  const worktree = checkout(root, "session_open");
  let removals = 0;
  const reap = await reapNodeModules(
    root,
    [candidate("session_open", worktree, { archived: false })],
    { now: () => NOW, remove: async () => { removals += 1; } },
  );
  expect(removals).toBe(0);
  expect(reap.reaped).toHaveLength(0);
  expect(reap.refused.live).toBe(1);
});

test("a live turn outranks the archive flag — the first refusal #633 asks for", async () => {
  const root = home();
  const worktree = checkout(root, "session_working");
  let removals = 0;
  const reap = await reapNodeModules(
    root,
    [candidate("session_working", worktree, { live: true })],
    { now: () => NOW, remove: async () => { removals += 1; } },
  );
  expect(removals).toBe(0);
  expect(reap.refused.working).toBe(1);
  expect(reap.reaped).toHaveLength(0);
});

test("the marker bounds the sweep to once a day, and does not write the home off forever", async () => {
  const root = home();
  const first = checkout(root, "session_one");
  expect((await reapNodeModules(root, [candidate("session_one", first)], { now: () => NOW })).reaped).toHaveLength(1);

  const second = checkout(root, "session_two");
  const soon = await reapNodeModules(root, [candidate("session_two", second)], { now: () => NOW + 60 * 60 * 1000 });
  expect(soon.standDown).toBe("swept-recently");
  expect(fs.existsSync(path.join(second, "node_modules"))).toBe(true);

  const later = await reapNodeModules(root, [candidate("session_two", second)], { now: () => NOW + DAY + 1 });
  expect(later.standDown).toBeUndefined();
  expect(later.reaped).toHaveLength(1);
  expect(fs.existsSync(path.join(second, "node_modules"))).toBe(false);
});

test("the space really comes back — proven by free space, the only instrument that can", async () => {
  const root = home();
  const PAYLOAD = 64 * 1024 * 1024;
  const worktree = checkout(root, "session_archived", PAYLOAD);

  const free = () => {
    const stat = fs.statfsSync(root);
    return Number(stat.bavail) * Number(stat.bsize);
  };
  const before = free();
  const reap = await reapNodeModules(root, [candidate("session_archived", worktree)], { now: () => NOW });
  const after = free();

  expect(reap.reaped).toHaveLength(1);
  expect(after - before).toBeGreaterThan(PAYLOAD / 4);
});

test("the line is said only when something went, and never overstates it", () => {
  expect(reapReport({ reaped: [], refused: { live: 0, working: 0 } })).toBeUndefined();
  expect(reapReport({ reaped: [], refused: { live: 2, working: 1 }, standDown: "swept-recently" })).toBeUndefined();

  const said = reapReport({
    reaped: [
      { sessionId: "a", path: "/x/a/node_modules", bytes: 1_200_000_000, files: 40_000 },
      { sessionId: "b", path: "/x/b/node_modules", bytes: 300_000_000, files: 9_000 },
    ],
    refused: { live: 0, working: 0 },
  })!;
  expect(said).toContain("2 checkouts");
  expect(said).toContain("1.5 GB");
  expect(said).toContain("up to");
  expect(said).toContain("remade by the next install");
});
