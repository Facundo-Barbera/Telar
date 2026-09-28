import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { describeImport, readClaudeTranscript, readClaudeTranscriptFile, type ImportedRow } from "./transcript";

const FIXTURES = path.join(import.meta.dir, "../../../test/fixtures/claude-transcript");

function load(name: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8").split("\n");
}

const kinds = (rows: readonly ImportedRow[]) => rows.map((row) => row.detail.type);
const textOf = (row: ImportedRow | undefined) =>
  row && (row.detail.type === "user_message" || row.detail.type === "assistant_message" || row.detail.type === "reasoning")
    ? row.detail.text
    : undefined;

test("an ordinary conversation reads back as the turns it was", () => {
  const result = readClaudeTranscript(load("terminal-session"));

  expect(kinds(result.rows)).toEqual([
    "user_message",
    "reasoning",
    "assistant_message",
    "command_execution",
    "assistant_message",
    "file_read",
    "user_message",
    "file_change",
    "assistant_message",
  ]);

  expect(textOf(result.rows[0])).toBe("Set up the deploy script for the staging environment.");
  expect(textOf(result.rows[1])).toStartWith("The staging script needs a build step");
  expect(result.cut).toEqual({ kind: "whole" });
  expect(result.chainBrokeEarly).toBe(false);
  expect(result.sessionId).toBe("11111111-2222-4333-8444-555555555555");
  expect(result.cwd).toBe("/work/project");
  expect(result.gitBranch).toBe("main");
});

test("every imported row says it was imported, and can be traced back", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  expect(result.rows.length).toBeGreaterThan(0);
  for (const row of result.rows) {
    expect(row.imported).toBe(true);
    expect(row.providerRefs.itemId).toBeTruthy();
    expect(row.providerRefs.sessionId).toBe("11111111-2222-4333-8444-555555555555");
  }
});

test("a tool result is folded into its call rather than becoming a row of its own", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  const bash = result.rows.find((row) => row.detail.type === "command_execution");
  expect(bash?.detail.type).toBe("command_execution");
  if (bash?.detail.type !== "command_execution") throw new Error("unreachable");
  expect(bash.detail.command.command).toBe("cat scripts/deploy.sh");
  expect(bash.detail.command.outputPreview).toContain("rsync -a dist/");
  expect(bash.status).toBe("completed");
  expect(bash.completedAt).toBeGreaterThan(bash.startedAt);

  const spoken = result.rows.filter((row) => textOf(row)?.includes("rsync -a dist/"));
  expect(spoken).toEqual([]);
});

test("a tool that failed reads as failed", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  const read = result.rows.find((row) => row.detail.type === "file_read");
  expect(read?.status).toBe("failed");
});

test("the live driver's own classifier decides the row types", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  const byTitle = new Map(result.rows.map((row) => [row.detail.type, row.title]));
  expect(byTitle.get("command_execution")).toBe("cat scripts/deploy.sh");
  expect(byTitle.get("file_read")).toBe("/work/project/vite.config.ts");
  expect(byTitle.get("file_change")).toBe("/work/project/scripts/deploy.sh");
});

test("an abandoned edit branch is not part of the conversation", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  expect(result.rows.map(textOf).filter(Boolean)).not.toContain("Set up the deploy script. Actually, wait.");
  expect(result.rows.map(textOf).filter(Boolean)).not.toContain("Happy to wait.");
  expect(result.dropped.offPath).toBeGreaterThan(0);
});

test("a sidechain is a sub-agent's conversation, not the person's", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  expect(result.rows.map(textOf).filter(Boolean)).not.toContain("Search the repo for stale deploy targets.");
  expect(result.dropped.sidechain).toBeGreaterThan(0);
});

test("injected wrappers and bookkeeping records never become rows", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  expect(result.rows.map(textOf).filter(Boolean).join(" ")).not.toContain("Environment refreshed");
  expect(result.dropped.meta).toBeGreaterThan(0);
  expect(result.dropped["last-prompt"]).toBe(1);
  expect(result.dropped.attachment).toBeGreaterThan(0);
});

test("nothing before the conversation's root is parsed at all", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  expect(result.cut).toEqual({ kind: "whole" });
  expect(result.dropped["queue-operation"]).toBeUndefined();
});

test("a slash command reads as the command, not as its markup", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  const command = result.rows.find((row) => textOf(row)?.startsWith("/model"));
  expect(textOf(command)).toBe("/model claude-sonnet-5");
  expect(textOf(command)).not.toContain("<command-name>");
});

test("compaction is where the import cuts, and the provider's own summary comes with it", () => {
  const result = readClaudeTranscript(load("compacted-session"));

  expect(result.cut.kind).toBe("compact_boundary");
  if (result.cut.kind !== "compact_boundary") throw new Error("unreachable");
  expect(result.cut.droppedTokens).toBe(168150);

  expect(kinds(result.rows)).toEqual(["context_compaction", "unknown", "assistant_message"]);

  const compaction = result.rows[0];
  if (compaction?.detail.type !== "context_compaction") throw new Error("unreachable");
  expect(compaction.detail.reason).toBe("auto");
  expect(compaction.detail.preTokens).toBe(182450);
  expect(compaction.detail.postTokens).toBe(14300);

  expect(result.priorSummary).toContain("The indexer was rebuilt to stream");
  expect(kinds(result.rows)).not.toContain("user_message");

  expect(result.rows.map(textOf).filter(Boolean)).not.toContain("Start of a long conversation about the indexer.");
});

test("a transcript caught mid-write costs one line, not the read", () => {
  const result = readClaudeTranscript(load("truncated"));
  expect(result.unparseable).toBe(1);
  expect(kinds(result.rows)).toEqual(["user_message", "assistant_message"]);
  expect(textOf(result.rows[0])).toBe("Does the importer survive a file being written to?");
});

test("the row budget bounds a transcript with no compaction in reach", () => {
  const result = readClaudeTranscript(load("terminal-session"), { maxRows: 2 });
  expect(result.cut).toEqual({ kind: "row_budget", budget: 2 });
  expect(result.rows.length).toBeLessThan(readClaudeTranscript(load("terminal-session")).rows.length);
  expect(textOf(result.rows.at(-1))).toBe("The deploy script now builds before it uploads.");
});

test("a tool's output is a preview, never the whole thing", () => {
  const lines = load("terminal-session");
  const result = readClaudeTranscript(lines, { maxOutputChars: 12 });
  const bash = result.rows.find((row) => row.detail.type === "command_execution");
  if (bash?.detail.type !== "command_execution") throw new Error("unreachable");
  expect(bash.detail.command.outputPreview).toContain("more characters in the transcript");
  expect(bash.detail.command.outputPreview!.length).toBeLessThan(100);
});

test("the cockpit is told what it kept", () => {
  expect(describeImport(readClaudeTranscript(load("terminal-session")))).toBe(
    "Imported this conversation in full — 9 rows.",
  );
  expect(describeImport(readClaudeTranscript(load("compacted-session")))).toBe(
    "Imported the 3 rows since this conversation last compacted its context, with Claude's own summary of what came before.",
  );
  expect(describeImport(readClaudeTranscript(load("terminal-session"), { maxRows: 2 }))).toStartWith(
    "Imported the most recent",
  );
});

test("a chain that runs off the start of the lines says so", () => {
  const whole = load("terminal-session");
  const tail = whole.slice(-6);
  const result = readClaudeTranscript(tail);
  expect(result.chainBrokeEarly).toBe(true);
  expect(describeImport(result)).toContain("did not reach the start");
});

test("reading from a path never materialises the file", () => {
  const file = path.join(FIXTURES, "terminal-session.jsonl");
  expect(readClaudeTranscriptFile(file)).toEqual(readClaudeTranscript(load("terminal-session")));

  const clipped = readClaudeTranscriptFile(file, { maxTailBytes: 4_000 });
  expect(clipped.chainBrokeEarly).toBe(true);
  expect(clipped.rows.length).toBeGreaterThan(0);
  expect(clipped.rows.length).toBeLessThan(readClaudeTranscript(load("terminal-session")).rows.length);
  expect(clipped.unparseable).toBe(0);

  const tooShort = readClaudeTranscriptFile(file, { maxTailBytes: 1_200 });
  expect(tooShort.rows).toEqual([]);
  expect(tooShort.chainBrokeEarly).toBe(true);
});

test("rows come out in the order they happened", () => {
  const result = readClaudeTranscript(load("terminal-session"));
  const times = result.rows.map((row) => row.startedAt);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(result.lastActivityAt).toBe(times.at(-1));
});

test("a title record written after the conversation does not end the walk before it starts", () => {
  const lines = load("terminal-session");
  const titled = [
    ...lines.filter((line) => line.trim()),
    JSON.stringify({
      type: "custom-title",
      sessionId: "11111111-2222-4333-8444-555555555555",
      customTitle: "Adopted into Telar",
      uuid: "99999999-8888-4777-8666-555555555555",
      timestamp: "2026-09-02T10:00:00.000Z",
    }),
  ];

  const result = readClaudeTranscript(titled);
  expect(kinds(result.rows)).toEqual(kinds(readClaudeTranscript(lines).rows));
  expect(result.dropped["custom-title"]).toBe(1);
  expect(result.chainBrokeEarly).toBe(false);
});
