#!/usr/bin/env bun
/**
 * ONE SLICE OF THE ENGINE SUITE, COMPUTED RATHER THAN LISTED — #760's option A.
 *
 * `Test engine` is the longest job in `Verify` on every run where iOS does not
 * archive (12 of 12 measured, 109–147 s against 58–80 s for the next one), and
 * it is one runner walking every engine test file in a row — 190 of them when
 * that was measured, and the count is not written down anywhere here because it
 * moves every week. The runners are not the
 * constraint — verify.yml's header records a measured ceiling of at least 40
 * concurrent hosted jobs — so the job is split and no test is touched.
 *
 * THE SPLIT IS COMPUTED FROM THE FILESYSTEM, NEVER WRITTEN DOWN. A hand-kept
 * list of which file goes in which shard is `test:desktop:unit` before #763 all
 * over again: 36 filenames typed into a script, and the suite quietly stopped
 * running the ones nobody remembered to add. A new test file must land in a
 * shard because of where it is, not because someone edited this file.
 *
 * ROUND-ROBIN OVER THE SORTED LIST, AND NO WEIGHTS. The obvious improvement is
 * a cost table so the expensive files spread evenly — and a cost table is the
 * hand-kept list again, wearing a number instead of a name: it is right on the
 * day it is measured and drifts silently afterwards, with no failure to say so.
 * Round-robin needs nothing maintained and cannot drop a file. Measured against
 * the ten per-file CI timings on #760, the worst of three shards lands near 40 s
 * against a 34 s ideal and a 101 s status quo, which is most of the available
 * win for none of the rot.
 *
 * EACH SHARD CHECKS ITS OWN ARITHMETIC. A shard that silently drops files is the
 * failure mode worth fearing here, because it looks exactly like a fast green
 * run. So the file count bun reports back is compared with the number of paths
 * this script handed it, and a mismatch fails the shard — in band, on every run,
 * rather than in a summary someone reads once.
 */
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace the shards run in, so its bunfig.toml preloads are the ones bun reads. */
export const ENGINE_DIR = "apps/engine";

/** Where the engine's tests live, relative to ENGINE_DIR — what bun is handed. */
export const ENGINE_TEST_DIR = "test";

/**
 * THE CEILING IS READ AS TEXT, NOT IMPORTED. scripts/test-ceiling.mjs imports
 * `bun:test` and calls `setDefaultTimeout` the moment it loads, which is right
 * for a preload and wrong for anything else; importing it here would run that in
 * a process that is not a test run. scripts/source-invariants.mjs reads the same
 * constant the same way, and fails loudly if the declaration ever moves.
 */
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

/**
 * Every engine test file, relative to ENGINE_DIR, sorted — the sort is what
 * makes the partition the same on every runner and in check:source.
 */
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
  await walk(ENGINE_TEST_DIR);
  return found.sort();
}

/**
 * Shard `index` of `total`, one-based. Pure, so check:source can assert the
 * union over synthetic inputs as well as over the real tree.
 */
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
  console.log(`engine shard ${index}/${total}: ${files.length} files, --timeout ${ceilingMs}`);

  let captured = "";
  const child = spawn("bun", shardArguments(files, ceilingMs), { cwd: join(ROOT, ENGINE_DIR), stdio: ["inherit", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      captured += chunk;
      process.stderr.write(chunk);
    });
  }
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));

  // THE ARITHMETIC, IN BAND. Not "did it pass" — how many files it opened.
  const reported = filesReportedIn(captured);
  if (reported === null) {
    console.error(
      `shard ${index}/${total} never printed bun's \`Ran N tests across M files.\` line, so nothing here knows how ` +
        "many files it opened. Treating that as a failure: a shard that cannot say what it ran has not proved it ran.",
    );
    return status === 0 ? 1 : status;
  }
  if (reported !== files.length) {
    console.error(
      `shard ${index}/${total} handed bun ${files.length} paths and bun ran ${reported} files. A shard that drops ` +
        "files is a fast green job that tested less than it claims, which is the whole risk of splitting this suite. " +
        "Check whether a path was renamed, or whether two paths now match one another as filters.",
    );
    return status === 0 ? 1 : status;
  }
  return status;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
