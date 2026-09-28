import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunJournalFile } from "./journal";
import type { RunLauncher } from "./launcher";
import { RunManager } from "./manager";
import { type StartRunInput } from "./live-run";
import { createOutputSplitter, safeCut } from "./stream";
import { REDACTED, type RunConfiguration } from "./types";

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

const input = (tree: string, cfg: RunConfiguration): StartRunInput => ({ projectId: "proj_1", sessionId: "sess_a", config: cfg, worktreePath: tree });

function keepingHost() {
  const held: Array<{ id: string; pid: number }> = [];
  const launcher: RunLauncher = {
    kind: "pty",
    async launch() {
      const terminal = { id: `term_${held.length + 1}`, pid: 70_000 + held.length };
      held.push(terminal);
      return { pid: terminal.pid, terminalId: terminal.id, close: async () => {}, signal: async () => {} };
    },
    held: async () => held,
    adopt: async (facts) => ({ pid: facts.pid, terminalId: facts.id, close: async () => {}, signal: async () => {} }),
  };
  return launcher;
}

test("a secret pasted into the command or the name never reaches the name tag, before OR after a restart", async () => {
  const dir = temp("journal-secrets");
  const tree = temp("tree");
  const launcher = keepingHost();
  const manager = runManager({ journal: new RunJournalFile(dir), launcher });
  const recipe = config({ name: `deploy ${TOKEN}`, command: `sleep 30 # ${TOKEN}` });
  await manager.start(input(tree, recipe));

  const onDisk = fs.readFileSync(path.join(dir, "open-terminals.json"), "utf8");
  expect(onDisk).not.toContain(TOKEN);
  expect(onDisk).toContain(REDACTED);

  const next = runManager({ journal: new RunJournalFile(dir), launcher });
  const [recovered] = await next.recover({ configFor: () => undefined });
  expect(recovered).toBeDefined();
  expect(recovered!.status).toBe("running");
  expect(JSON.stringify(recovered)).not.toContain(TOKEN);
});

test("a busy port's warning and readiness sentence are scrubbed like every other text", async () => {
  const manager = runManager({ launcher: keepingHost(), probe: async () => ({ answered: true, serving: true }) });
  const run = await manager.start(input(temp("tree"), config({ name: `dev ${TOKEN}`, readinessUrl: `http://127.0.0.1:65500/?k=${TOKEN}` })));
  expect(run.warning).toContain("already answers");
  expect(run.readiness.kind).toBe("unattributable");
  expect(JSON.stringify(run)).not.toContain(TOKEN);
});

function split(text: string, size: number, secrets: string[]): string[] {
  const lines: string[] = [];
  const splitter = createOutputSplitter(secrets, 4000, (line) => lines.push(line));
  for (let index = 0; index < text.length; index += size) splitter.push(text.slice(index, index + size));
  splitter.end();
  return lines;
}

test("overlapping secrets survive every chunk partition, in one piece", () => {
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
  for (const chunk of ["0123456789012345678901234ABC", "DEFGH0123456789012345678901234567890"]) splitter.push(chunk);
  splitter.end();

  const joined = lines.join("");
  expect(joined).not.toContain("ABCD");
  expect(joined).not.toContain("EFGH");
  expect(joined).toContain(REDACTED);
  expect(lines.length).toBeGreaterThan(1);
});

test("a long line reads the same whether or not its newline arrived in the same chunk", () => {
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
  expect(atOnce.join("").replace(/«redacted»/g, "sk_live_secret")).toBe(body);
});

test("safeCut never leaves half a secret on either side", () => {
  expect(safeCut("aaSECRETbb", ["SECRET"], 4)).toBe(8);
  expect(safeCut("aaSECRETbb", ["SECRET"], 8)).toBe(8);
  expect(safeCut("aaAAABBBcc", ["AAAB", "ABBB"], 3)).toBe(8);
  expect(safeCut("short", ["SECRET"], 99)).toBe(5);
});
