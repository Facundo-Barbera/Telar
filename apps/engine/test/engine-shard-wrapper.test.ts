/**
 * THE SHARD RUNS THROUGH THE BOUNDED WRAPPER, AND STILL COUNTS ITS FILES — #849.
 *
 * #841 moved `Test engine` onto `scripts/engine-shard.mjs`, which spawned
 * `bun test` directly and was bounded only by the job's `timeout-minutes: 20`.
 * CI gained the sharding and LOST what #807/#844 built: a hang and a red test
 * are both non-zero exits, and a job killed at its own timeout prints neither a
 * tally nor a reason. Routing the shard through the wrapper gives the four
 * outcomes back — and the risk it introduces is that the extra process breaks
 * the one check that catches a shard silently dropping files.
 *
 * So both halves are asserted here, and both are asserted in the direction that
 * can fail: the count is read out of REAL wrapper output rather than a string
 * typed into this file, and every verdict branch is exercised with the value
 * that should produce it.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SHARD_BUDGET_MS,
  filesReportedIn,
  shardArguments,
  shardOf,
  shardVerdict,
  wrappedShardCommand,
} from "../../../scripts/engine-shard.mjs";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/** The ceiling on any `Bun.spawnSync` here — #807's rule, applied to this file too. */
const SPAWN_CEILING_MS = 40_000;

test("the shard hands the wrapper the same bun invocation it used to run directly", () => {
  const files = ["test/a.test.ts", "test/b.test.ts"];
  const command = wrappedShardCommand(files, 20_000, 1_234);

  // The wrapper, then its options, then `--`, then the command it bounds. The
  // `--` is load-bearing: without it the wrapper parses `bun` as an option and
  // throws, and with the wrong arguments before it the budget silently reverts
  // to the 15-minute default.
  expect(command[0]).toBe("bun");
  expect(command[1]).toBe(path.join(REPO_ROOT, "scripts/test-engine-bounded.mjs"));
  expect(command.slice(2, 4)).toEqual(["--budget-ms", "1234"]);
  const separator = command.indexOf("--");
  expect(separator).toBe(4);
  // What runs after `--` is EXACTLY what this script used to spawn itself, so
  // the ceiling and the file list cannot drift by going through the wrapper.
  expect(command.slice(separator + 1)).toEqual(["bun", ...shardArguments(files, 20_000)]);

  // The budget has to fire before the job's own timeout or it buys nothing.
  expect(SHARD_BUDGET_MS).toBeLessThan(20 * 60_000);
});

test("bun's `Ran N tests across M files.` line survives the wrapper's tee", () => {
  /**
   * THE RISK THE EXTRA PROCESS INTRODUCES, MEASURED RATHER THAN ARGUED. The
   * shard's file-count check reads bun's own line out of captured output; the
   * wrapper now sits between them and prints lines of its own. If the tee
   * dropped or reshaped that line, the check would fail open on every run and
   * a shard that dropped files would go green — which is the exact failure the
   * count exists to catch.
   */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-shard-"));
  try {
    for (const name of ["one.test.ts", "two.test.ts"]) {
      fs.writeFileSync(path.join(root, name), `import { test, expect } from "bun:test";\ntest("passes", () => { expect(1).toBe(1); });\n`);
    }
    const command = wrappedShardCommand(["one.test.ts", "two.test.ts"], 20_000, 30_000);
    const run = Bun.spawnSync(command, { cwd: root, timeout: SPAWN_CEILING_MS, killSignal: "SIGKILL" });
    const output = `${run.stdout?.toString() ?? ""}${run.stderr?.toString() ?? ""}`;

    // Read back through the shard's own parser, from real wrapper output.
    expect(filesReportedIn(output)).toBe(2);
    // And the wrapper really was in the path — otherwise this asserts nothing
    // about the tee at all.
    expect(output).toContain("[test-engine-bounded]");
    expect(run.exitCode).toBe(0);

    // The whole verdict, end to end: two files handed over, two files run.
    expect(shardVerdict({ status: run.exitCode ?? 1, output, handed: 2 })).toMatchObject({ code: 0, error: null, reported: 2 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("a hung or unknown shard keeps the wrapper's code and is not retold as an arithmetic failure", () => {
  /**
   * A HANG PRINTS NO TALLY, so the file-count branch would fire on it and
   * replace "the run never ended, here is what was holding it open" with "this
   * shard cannot say what it ran". Same red, worse sentence — and the ability
   * to tell those apart is the only reason to route through the wrapper.
   */
  const hung = shardVerdict({ status: 2, output: "no tally here", handed: 65 });
  expect(hung.code).toBe(2);
  expect(hung.error).toContain("HUNG");

  const unknown = shardVerdict({ status: 3, output: "", handed: 65 });
  expect(unknown.code).toBe(3);
  expect(unknown.error).toContain("UNKNOWN");

  // A FAILING TEST IS STILL A 1, and still gets its arithmetic checked: a red
  // shard that also dropped files is two problems, and the count is the one
  // nobody would otherwise notice.
  const red = shardVerdict({ status: 1, output: "Ran 200 tests across 65 files.\n", handed: 65 });
  expect(red).toMatchObject({ code: 1, error: null });
});

test("a leaked shard keeps the wrapper's 4, and a dropped file is still reported first", () => {
  /**
   * #849: A LEAK IS A RED THE SHARD MUST NOT TURN GREEN. The wrapper exits 4
   * when every test passed and something was left in the group; a shard that
   * read that as "non-zero, arithmetic fine, error null" would still fail the
   * job but say nothing about why.
   */
  const leaked = shardVerdict({ status: 4, output: "Ran 1000 tests across 65 files.\n", handed: 65 });
  expect(leaked.code).toBe(4);
  expect(leaked.error).toContain("did not stop it");

  // The count still runs first — it printed its tally, unlike a hang.
  const leakedAndDropped = shardVerdict({ status: 4, output: "Ran 1000 tests across 64 files.\n", handed: 65 });
  expect(leakedAndDropped.code).toBe(4);
  expect(leakedAndDropped.error).toContain("handed bun 65 paths and bun ran 64 files");
});

test("a shard that drops files fails even when every test it did run passed", () => {
  // THE FAST GREEN RUN. bun exits 0 having opened 64 of the 65 paths it was
  // handed, which is what a renamed file looks like.
  const dropped = shardVerdict({ status: 0, output: "Ran 1000 tests across 64 files.\n", handed: 65 });
  expect(dropped.code).toBe(1);
  expect(dropped.error).toContain("handed bun 65 paths and bun ran 64 files");

  // And the no-line case, which is different from a mismatch and must not be
  // folded into a pass.
  const silent = shardVerdict({ status: 0, output: "1 pass\n0 fail\n", handed: 65 });
  expect(silent.code).toBe(1);
  expect(silent.error).toContain("never printed");
});

test("the three shards partition the suite, and their file counts sum to the single-job number", async () => {
  /**
   * THE PROPERTY THE SHARD SPLIT RESTS ON, asserted against the real tree the
   * way `scripts/source-invariants.mjs` does — and repeated here because this
   * PR changes how a shard RUNS, and the thing worth proving is that changing
   * the runner did not change what is run.
   */
  const { engineTestFiles } = await import("../../../scripts/engine-shard.mjs");
  const all = await engineTestFiles();
  const shards = [1, 2, 3].map((index) => shardOf(all, index, 3));

  expect(shards.reduce((sum, shard) => sum + shard.length, 0)).toBe(all.length);
  expect(shards.flat().slice().sort()).toEqual(all.slice().sort());
  for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  // No file in two shards — a duplicate would make the sum right and the
  // partition wrong.
  expect(new Set(shards.flat()).size).toBe(all.length);
});
