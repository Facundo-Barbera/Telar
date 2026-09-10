/**
 * The promise attached to the word "secret": you will not see this value in
 * Telar. It has to hold in the places that are easy to forget — the file on
 * disk, the sentence after a restart, and a stream that hands us a secret two
 * characters at a time.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunJournalFile } from "../src/run/journal";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { createOutputSplitter, safeCut } from "../src/run/stream";
import { REDACTED, type RunConfiguration } from "../src/run/types";

const temp = (label: string) => track(fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`)));

const track = (dir: string): string => (tempDirs.push(dir), dir);
/**
 * NOTHING THIS FILE STARTS OUTLIVES IT, and nothing it writes stays on disk.
 * Every run here is a real process in a real temp directory: a test that fails
 * midway used to leave a `sleep` holding a process group and a directory in
 * `/tmp`, so the next reader of a failure was also debugging the litter from
 * the last one. Managers are shut down after each test and the directories go
 * at the end — after, not during, because a manager still draining a group
 * needs its cwd to exist.
 */
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


const TOKEN = "sk_live_9f3a2b7c";

const config = (extra: Partial<RunConfiguration> = {}): RunConfiguration => ({
  id: "runcfg_test",
  projectId: "proj_1",
  name: "fixture",
  command: "sleep 30",
  createdAt: 1,
  updatedAt: 1,
  env: [{ key: "TOKEN", value: TOKEN, secret: true }],
  ...extra,
});

const input = (tree: string, cfg: RunConfiguration): StartRunInput => ({ projectId: "proj_1", config: cfg, worktreePath: tree });

function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ── the file on disk, and the sentence after a restart ─────────────────────

test("a secret pasted into the command or the name never reaches the journal, before OR after recovery", async () => {
  // A human who marks TOKEN secret and then writes it into the command has put
  // the same string into a field the record used to persist verbatim — and a
  // recovered run has no secret list left to scrub it with on the way out.
  const dir = temp("journal-secrets");
  const tree = temp("tree");
  const journal = new RunJournalFile(dir);
  const manager = runManager({ journal });
  const recipe = config({ name: `deploy ${TOKEN}`, command: `sleep 30 # ${TOKEN}` });
  const run = await manager.start(input(tree, recipe));
  const pid = manager.run(run.runId).pid;
  try {
    const onDisk = fs.readFileSync(path.join(dir, "open-runs.json"), "utf8");
    expect(onDisk).not.toContain(TOKEN);
    expect(onDisk).toContain(REDACTED);

    // A fresh manager over the same file is the restart: it has no
    // configuration, no env, and therefore no way to scrub what it was handed.
    const next = runManager({ journal: new RunJournalFile(dir) });
    const [recovered] = next.recover();
    expect(recovered).toBeDefined();
    expect(JSON.stringify(recovered)).not.toContain(TOKEN);
    expect(recovered!.status).toBe("unknown");
    expect(recovered!.error).not.toContain(TOKEN);
    // And the refusal it produces for the next launch is scrubbed too.
    await expect(next.start(input(tree, config()))).rejects.toThrow(/lost contact/);
    await expect(next.start(input(tree, config()))).rejects.not.toThrow(new RegExp(TOKEN));
  } finally {
    reap(pid);
    await manager.shutdown();
  }
}, 15_000);

test("the sentence about a lost run is scrubbed everywhere it is handed back", async () => {
  const manager = runManager({ groupDrainMs: 150, probe: async () => ({ answered: false, serving: false }) });
  const run = await manager.start(
    input(temp("tree"), config({ name: `dev ${TOKEN}`, command: "sleep 30 &", readinessUrl: `http://127.0.0.1:65500/?k=${TOKEN}` })),
  );
  const pid = manager.run(run.runId).pid;
  try {
    // `sleep 30 &` leaves the group alive behind an exited shell: unknown, with
    // a readiness that never got its answer.
    const settled = await (async () => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (manager.run(run.runId).status === "unknown") return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    })();
    expect(settled).toBe(true);

    const view = manager.run(run.runId);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view.readiness.kind).toBe("unattributable");
    let refusal = "";
    try {
      await manager.start(input(temp("tree"), config()));
    } catch (error) {
      refusal = JSON.stringify({ message: (error as Error).message, detail: (error as { detail?: unknown }).detail });
    }
    expect(refusal).toContain("lost contact");
    expect(refusal).not.toContain(TOKEN);
  } finally {
    reap(pid);
    await manager.shutdown();
  }
}, 20_000);

// ── a secret arriving in pieces ────────────────────────────────────────────

/** Feed one string to the splitter in fixed-size slices. */
function split(text: string, size: number, secrets: string[]): string[] {
  const lines: string[] = [];
  const splitter = createOutputSplitter(secrets, 4000, (line) => lines.push(line));
  for (let index = 0; index < text.length; index += size) splitter.push(text.slice(index, index + size));
  splitter.end();
  return lines;
}

test("overlapping secrets survive every chunk partition, in one piece", () => {
  // THE BUG THIS PINS: scrubbing each chunk as it arrives turns "ABCD" into
  // «redacted» and lets the following "EFGH" — the tail of the LONGER secret —
  // straight through. Longest-first ordering cannot help once the evidence has
  // already been destroyed.
  const secrets = ["ABCDEFGH", "ABCD"];
  const stream = "start ABCDEFGH middle ABCD end\ntail ABCDEFGH\n";
  const whole = split(stream, stream.length, secrets);

  for (const size of [1, 2, 3, 4, 5, 7, 8, 13, 100]) {
    const lines = split(stream, size, secrets);
    expect({ size, lines }).toEqual({ size, lines: whole });
    expect(lines.join("\n")).not.toContain("ABCD");
    expect(lines.join("\n")).not.toContain("EFGH");
  }
  expect(whole).toEqual([`start ${REDACTED} middle ${REDACTED} end`, `tail ${REDACTED}`]);
});

test("a process that never sends a newline is still bounded, and still scrubbed", () => {
  const secrets = ["ABCDEFGH", "ABCD"];
  const lines: string[] = [];
  const splitter = createOutputSplitter(secrets, 16, (line) => lines.push(line));
  // A secret straddling the forced cut is the case a fixed-width flush breaks.
  for (const chunk of ["0123456789012345678901234ABC", "DEFGH0123456789012345678901234567890"]) splitter.push(chunk);
  splitter.end();

  const joined = lines.join("");
  expect(joined).not.toContain("ABCD");
  expect(joined).not.toContain("EFGH");
  expect(joined).toContain(REDACTED);
  // Bounded: nothing was held indefinitely waiting for a newline that never came.
  expect(lines.length).toBeGreaterThan(1);
});

test("a long line reads the same whether or not its newline arrived in the same chunk", () => {
  // THE FLAKE THIS PINS: 20k characters and their trailing newline used to be
  // one line when the OS handed them over together — and the cap then TRUNCATED
  // it, dropping 16k characters — while the same bytes split across chunks came
  // back as five bounded lines. Same output, same input, whatever the kernel did.
  const secrets = ["sk_live_secret"];
  const body = Array.from({ length: 20 }, () => `${"0".repeat(1000)}sk_live_secret`).join("");
  const stream = `${body}\n`;

  const atOnce: string[] = [];
  const whole = createOutputSplitter(secrets, 4000, (text) => atOnce.push(text));
  whole.push(stream);
  whole.end();

  for (const size of [1, 999, 4000, 4096, 20_294]) {
    const lines: string[] = [];
    const splitter = createOutputSplitter(secrets, 4000, (text) => lines.push(text));
    for (let index = 0; index < stream.length; index += size) splitter.push(stream.slice(index, index + size));
    splitter.end();
    expect({ size, lines }).toEqual({ size, lines: atOnce });
  }

  expect(atOnce.length).toBeGreaterThan(1);
  for (const line of atOnce) expect(line).not.toContain("sk_live_secret");
  // Wrapped, not truncated: every character is still accounted for.
  expect(atOnce.join("").replace(/«redacted»/g, "sk_live_secret")).toBe(body);
});

test("safeCut never leaves half a secret on either side", () => {
  expect(safeCut("aaSECRETbb", ["SECRET"], 4)).toBe(8);
  // Already outside one: nothing to move.
  expect(safeCut("aaSECRETbb", ["SECRET"], 8)).toBe(8);
  // Pushing past one lands inside another, so it settles rather than passing once.
  expect(safeCut("aaAAABBBcc", ["AAAB", "ABBB"], 3)).toBe(8);
  expect(safeCut("short", ["SECRET"], 99)).toBe(5);
});
