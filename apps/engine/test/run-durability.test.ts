/**
 * AN ENGINE RESTART LEAVES NOTHING BLOCKING.
 *
 * This file used to pin the opposite: a record left open by a crashed engine
 * came back as an `unknown` run that held its project's slot until a person
 * released it, and an unreadable journal refused every launch. "Run = a new
 * terminal" removed the slot, the `unknown` and the release. What is left is a
 * name tag per terminal (`journal.ts`) so a restarted engine can re-list the
 * terminals the desktop host kept — asked once, from `GET /state` — and
 * nothing it can find or fail to find ever refuses a start.
 *
 * The host here is a fake that starts no process; the journal is a real file
 * in a temp directory.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunJournalFile, type RunRecord } from "../src/run/journal";
import type { RunHandle, RunLaunchEvents, RunLauncher } from "../src/run/launcher";
import { RunManager, type StartRunInput } from "../src/run/manager";
import type { TerminalFacts } from "../src/run/terminal-client";
import { PTY_MASK } from "../src/run/pty-stream";
import type { RunConfiguration } from "../src/run/types";

const temp = (label: string) => track(fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`)));
const track = (dir: string): string => (tempDirs.push(dir), dir);
const managers: RunManager[] = [];
const tempDirs: string[] = [];

function runManager(...args: ConstructorParameters<typeof RunManager>): RunManager {
  const manager = new RunManager(...args);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
      /* a manager that already failed is not a second failure */
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SECRET = "sk-live-7b3f91";

const config = (extra: Partial<RunConfiguration> = {}): RunConfiguration => ({
  id: "runcfg_web",
  projectId: "proj_1",
  name: "web dev",
  command: "bun run dev",
  env: [{ key: "TOKEN", value: SECRET, secret: true }],
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const input = (tree: string, cfg: RunConfiguration = config()): StartRunInput => ({ projectId: "proj_1", sessionId: "sess_a", config: cfg, worktreePath: tree });

const record = (extra: Partial<RunRecord> = {}): RunRecord => ({
  terminalId: "term_kept",
  projectId: "proj_1",
  sessionId: "sess_a",
  origin: "run",
  title: "web dev #2",
  configId: "runcfg_web",
  configName: "web dev",
  command: "bun run dev",
  worktreePath: "/tmp/tree",
  cwd: "/tmp/tree",
  startedAt: 1,
  ...extra,
});

/**
 * A desktop host that starts nothing and keeps whatever it is told it holds —
 * which is what a real host looks like to an engine that just restarted.
 */
function fakeHost(held: TerminalFacts[] = [], options: { unreachable?: boolean } = {}) {
  const adopted = new Map<string, RunLaunchEvents>();
  const mirrored: Array<{ id: string; data: string }> = [];
  let sequence = 0;
  const handle = (id: string, pid: number | undefined): RunHandle => ({
    pid,
    terminalId: id,
    close: async () => {},
    signal: async () => {},
    write: async () => true,
    resize: async () => true,
    mirror: (data) => mirrored.push({ id, data }),
  });
  const launcher: RunLauncher = {
    kind: "pty",
    async launch(_request, events) {
      const id = `term_new_${(sequence += 1)}`;
      adopted.set(id, events);
      return handle(id, 60_000 + sequence);
    },
    async held() {
      if (options.unreachable) throw new Error("Telar could not reach its terminal host");
      return held;
    },
    async adopt(facts, events) {
      adopted.set(facts.id, events);
      return handle(facts.id, facts.pid);
    },
  };
  return { launcher, adopted, mirrored };
}

// ── the file itself ──────────────────────────────────────────────────────────

test("a missing, corrupt or malformed journal is simply empty — it never refuses a launch", async () => {
  const dir = temp("journal");
  const journal = new RunJournalFile(dir);
  expect(journal.list()).toEqual([]);

  fs.writeFileSync(path.join(dir, "open-terminals.json"), "{ not json");
  expect(journal.list()).toEqual([]);
  // One malformed entry costs that entry, not the good one beside it.
  fs.writeFileSync(path.join(dir, "open-terminals.json"), JSON.stringify({ terminals: [record(), { terminalId: 7 }] }));
  expect(journal.list().map((entry) => entry.terminalId)).toEqual(["term_kept"]);

  fs.writeFileSync(path.join(dir, "open-terminals.json"), "{ not json");
  const manager = runManager({ journal, launcher: fakeHost().launcher });
  expect(await manager.recover()).toEqual([]);
  const run = await manager.start(input(temp("tree")));
  expect(run.status).toBe("running");
});

test("an opened terminal leaves a name tag with no secret in it, and an ended one takes it away", async () => {
  const dir = temp("journal");
  const journal = new RunJournalFile(dir);
  const host = fakeHost();
  const manager = runManager({ journal, launcher: host.launcher });
  const run = await manager.start(input(temp("tree"), config({ command: `bun run dev --token ${SECRET}` })));

  const tags = journal.list();
  expect(tags.map((entry) => [entry.terminalId, entry.sessionId, entry.title, entry.configId])).toEqual([[run.terminalId, "sess_a", "web dev", "runcfg_web"]]);
  expect(fs.readFileSync(path.join(dir, "open-terminals.json"), "utf8")).not.toContain(SECRET);

  host.adopted.get(run.terminalId)!.exited({ exitCode: 0 });
  expect(journal.list()).toEqual([]);
});

// ── the restart ──────────────────────────────────────────────────────────────

test("an engine restart re-lists the terminals the host kept, forgets the rest, and blocks nothing", async () => {
  const dir = temp("journal");
  const journal = new RunJournalFile(dir);
  journal.replace([record(), record({ terminalId: "term_gone", title: "web dev" })]);

  // The host kept one of the two. The other ended while no engine was
  // listening — the host is the only thing that could have ended it.
  const host = fakeHost([{ id: "term_kept", pid: 4242, sessionId: "sess_a", origin: "run", title: "web dev #2" }]);
  const manager = runManager({ journal, launcher: host.launcher });
  const recovered = await manager.recover({ configFor: () => config() });

  expect(recovered.map((run) => [run.terminalId, run.status, run.title, run.sessionId, run.pid])).toEqual([["term_kept", "running", "web dev #2", "sess_a", 4242]]);
  expect(() => manager.run("term_gone")).toThrow(/no terminal/);
  // NO ORPHAN, NO UNKNOWN: nothing about the gone one survives, not even a tag.
  expect(journal.list().map((entry) => entry.terminalId)).toEqual(["term_kept"]);

  // And a start goes straight through — there is nothing it could be blocked by.
  const next = await manager.start(input(temp("tree")));
  expect(next.status).toBe("running");
  // The re-listed "web dev #2" still holds its number, so the new one is "web dev".
  expect(next.title).toBe("web dev");
});

test("a re-listed terminal is redacted with its configuration's secrets, in the ring and in the mirror", async () => {
  const journal = new RunJournalFile(temp("journal"));
  journal.replace([record()]);
  const host = fakeHost([{ id: "term_kept", pid: 4242 }]);
  const manager = runManager({ journal, launcher: host.launcher });
  await manager.recover({ configFor: () => config() });

  host.adopted.get("term_kept")!.output("stdout", `token=${SECRET}\r\n`);
  const drawn = manager.bytes("term_kept").chunks.join("");
  expect(drawn).not.toContain(SECRET);
  expect(drawn).toContain(PTY_MASK.repeat(SECRET.length));
  expect(host.mirrored.map((frame) => frame.data).join("")).not.toContain(SECRET);
});

test("a re-listed terminal whose configuration was deleted shows nothing rather than unmasked output", async () => {
  const journal = new RunJournalFile(temp("journal"));
  journal.replace([record()]);
  const host = fakeHost([{ id: "term_kept", pid: 4242 }]);
  const manager = runManager({ journal, launcher: host.launcher });
  const [run] = await manager.recover({ configFor: () => undefined });
  expect(run?.status).toBe("running");

  host.adopted.get("term_kept")!.output("stdout", `token=${SECRET}\r\n`);
  expect(JSON.stringify(manager.output("term_kept"))).not.toContain(SECRET);
  expect(host.mirrored).toEqual([]);
  // It says why, rather than looking like a silent process.
  expect(manager.output("term_kept").lines.map((line) => line.text).join(" ")).toContain("has since been deleted");
});

test("a host that cannot be reached re-lists nothing, keeps the tags for next time, and blocks nothing", async () => {
  const journal = new RunJournalFile(temp("journal"));
  journal.replace([record()]);
  const manager = runManager({ journal, launcher: fakeHost([], { unreachable: true }).launcher });
  expect(await manager.recover({ configFor: () => config() })).toEqual([]);
  expect(journal.list().map((entry) => entry.terminalId)).toEqual(["term_kept"]);
  expect((await manager.start(input(temp("tree")))).status).toBe("running");
});

test("the pipe fallback re-lists nothing — a previous engine's child is nobody's to pick up", async () => {
  const journal = new RunJournalFile(temp("journal"));
  journal.replace([record()]);
  const manager = runManager({ journal });
  expect(await manager.recover({ configFor: () => config() })).toEqual([]);
  expect(journal.list()).toEqual([]);
});

test("a terminal the host closed while the engine was away is recorded closed by Telar, never held", async () => {
  const journal = new RunJournalFile(temp("journal"));
  journal.replace([record()]);
  const host = fakeHost([{ id: "term_kept", pid: 4242 }]);
  const manager = runManager({ journal, launcher: host.launcher });
  await manager.recover({ configFor: () => config() });

  // What the channel reports after a reconnect finds the terminal gone.
  host.adopted.get("term_kept")!.gone("Telar's terminal host no longer has this terminal");
  const run = manager.run("term_kept");
  expect(run.status).toBe("closed");
  expect(run.closedBy).toBe("telar");
  expect(journal.list()).toEqual([]);
});
