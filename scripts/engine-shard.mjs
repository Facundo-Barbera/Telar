#!/usr/bin/env bun
// One slice of the engine suite. The split is round-robin over the sorted file
// list, computed from the filesystem so a new test file can never be dropped, and
// each shard checks bun ran exactly the files it was handed.
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace the shards run in, so its bunfig.toml preloads are the ones bun reads. */
export const ENGINE_DIR = "apps/engine";

/** Where the engine's tests live, relative to ENGINE_DIR: next to the code, and shared ones in test/. */
export const ENGINE_TEST_DIRS = ["src", "test"];

export async function testCeilingMs() {
  const source = await readFile(join(ROOT, "scripts/test-ceiling.mjs"), "utf8");
  const declared = /export const TEST_CEILING_MS = ([0-9_]+);/.exec(source);
  if (!declared) {
    throw new Error(
      "scripts/test-ceiling.mjs no longer declares `export const TEST_CEILING_MS = <number>`, so this shard cannot " +
        "pass the repo's ceiling to bun. Without --timeout every file after the first runs at bun's 5000ms default " +
        "(#792). Restore the export, or teach this script where the number moved to.",
    );
  }
  return Number(declared[1].replace(/_/g, ""));
}

export async function engineTestFiles() {
  const found = [];
  const walk = async (relative) => {
    const entries = await readdir(join(ROOT, ENGINE_DIR, relative), { withFileTypes: true });
    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(next);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(next);
      }
    }
  };
  for (const dir of ENGINE_TEST_DIRS) await walk(dir);
  return found.sort();
}

export function shardOf(files, index, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`a shard count must be a positive integer, got ${total}`);
  if (!Number.isInteger(index) || index < 1 || index > total) {
    throw new Error(`shard ${index} does not exist in a split of ${total}`);
  }
  return files.filter((_file, position) => position % total === index - 1);
}

/** The argv bun is handed, so a test can read it instead of trusting this comment. */
export function shardArguments(files, ceilingMs) {
  return ["test", "--timeout", String(ceilingMs), ...files];
}

export const SHARD_BUDGET_MS = 8 * 60_000;

export function wrappedShardCommand(files, ceilingMs, budgetMs = SHARD_BUDGET_MS) {
  return [
    "bun",
    join(ROOT, "scripts/test-engine-bounded.mjs"),
    "--budget-ms",
    String(budgetMs),
    "--",
    "bun",
    ...shardArguments(files, ceilingMs),
  ];
}

/** `Ran 3004 tests across 190 files.` — bun's own count, which is the thing worth checking. */
export function filesReportedIn(output) {
  const reported = /Ran \d+ tests? across (\d+) files?\./.exec(output);
  return reported ? Number(reported[1]) : null;
}

async function main(argv) {
  const [rawIndex, rawTotal] = argv;
  const index = Number(rawIndex);
  const total = Number(rawTotal);
  if (!Number.isInteger(index) || !Number.isInteger(total)) {
    console.error("usage: bun scripts/engine-shard.mjs <index> <total>   (one-based, e.g. `1 3`)");
    return 2;
  }

  const files = shardOf(await engineTestFiles(), index, total);
  if (files.length === 0) {
    console.error(
      `shard ${index}/${total} is empty. An empty shard is a green job that ran nothing, so it fails here instead: ` +
        "either the split has more shards than there are test files, or the test directory was not found.",
    );
    return 1;
  }

  const ceilingMs = await testCeilingMs();
  const command = wrappedShardCommand(files, ceilingMs);
  console.log(
    `engine shard ${index}/${total}: ${files.length} files, --timeout ${ceilingMs}, ` +
      `bounded at ${SHARD_BUDGET_MS}ms by scripts/test-engine-bounded.mjs`,
  );

  let captured = "";
  const child = spawn(command[0], command.slice(1), { cwd: join(ROOT, ENGINE_DIR), stdio: ["inherit", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      captured += chunk;
      process.stderr.write(chunk);
    });
  }
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));

  const verdict = shardVerdict({ status, output: captured, handed: files.length, label: `shard ${index}/${total}` });
  if (verdict.error) console.error(verdict.error);
  return verdict.code;
}

export function shardVerdict({ status, output, handed, label = "this shard" }) {
  if (status === 2 || status === 3) {
    return {
      code: status,
      error:
        `${label}: the bounded wrapper reported ${status === 2 ? "HUNG" : "UNKNOWN"} rather than a test failure. Its ` +
        "lines above carry the log path, the last line the run printed, and — when it found any — the pid, ppid and " +
        "command line of everything still in the run's process group.",
    };
  }

  // THE ARITHMETIC, IN BAND. Not "did it pass" — how many files it opened.
  const reported = filesReportedIn(output);
  if (reported === null) {
    return {
      code: status === 0 ? 1 : status,
      error:
        `${label} never printed bun's \`Ran N tests across M files.\` line, so nothing here knows how many files it ` +
        "opened. Treating that as a failure: a shard that cannot say what it ran has not proved it ran.",
    };
  }
  if (reported !== handed) {
    return {
      code: status === 0 ? 1 : status,
      error:
        `${label} handed bun ${handed} paths and bun ran ${reported} files. A shard that drops files is a fast green ` +
        "job that tested less than it claims, which is the whole risk of splitting this suite. Check whether a path " +
        "was renamed, or whether two paths now match one another as filters.",
    };
  }
  if (status === 4) {
    return {
      code: 4,
      error:
        `${label}: every test passed, but the bounded wrapper found processes still in the run's group after it ` +
        "exited — a test that spawned something and did not stop it. Its lines above carry the pid, ppid and command line.",
      reported,
    };
  }
  return { code: status, error: null, reported };
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
