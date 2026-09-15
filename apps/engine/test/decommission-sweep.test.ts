/**
 * The Spool's and the Looms' leftovers, swept once — issue #501, step 2.
 *
 * What is pinned here is the whole contract a person depends on: BOTH
 * directories go, it happens ONCE per home, it never touches anything else in
 * the home, a failure leaves the home alone rather than half-swept-and-forgotten,
 * and it SAYS what went — because a deletion nobody reports is indistinguishable
 * from data loss to whoever goes looking for the directory.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepReport, sweepSpoolAndLooms } from "../src/decommission-sweep";

let home: string;
let engineRoot: string;

/** A home shaped like a real one: `<TELAR_HOME>/engine` with `looms/` beside it. */
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "decommission-"));
  engineRoot = path.join(home, "engine");
  fs.mkdirSync(engineRoot, { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const writeSpool = () => {
  fs.mkdirSync(path.join(engineRoot, "spool", "subjects"), { recursive: true });
  fs.writeFileSync(path.join(engineRoot, "spool", "items.json"), '{"items":[]}');
  fs.writeFileSync(path.join(engineRoot, "spool", "subjects", "aurora.json"), "{}");
};
const writeLooms = () => {
  fs.mkdirSync(path.join(home, "looms"), { recursive: true });
  fs.writeFileSync(path.join(home, "looms", "one.json"), '{"loom":"one"}');
};

test("both directories go, and the line names each with what it took", () => {
  writeSpool();
  writeLooms();
  // Something else in the home, to prove the sweep is aimed rather than broad.
  fs.writeFileSync(path.join(engineRoot, "projects.json"), "{}");
  fs.mkdirSync(path.join(engineRoot, "sessions"), { recursive: true });

  const sweep = sweepSpoolAndLooms(engineRoot);

  expect(fs.existsSync(path.join(engineRoot, "spool"))).toBe(false);
  expect(fs.existsSync(path.join(home, "looms"))).toBe(false);
  // …and NOTHING else was touched. This is the half that makes the deletion
  // defensible: a sweep that took the sessions with it would be a data loss.
  expect(fs.existsSync(path.join(engineRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(path.join(engineRoot, "sessions"))).toBe(true);

  expect(sweep.removed.map((entry) => entry.what)).toEqual(["the Spool's store", "the Looms"]);
  // 2 spool files across a nested directory, 1 loom file — the walk recurses.
  expect(sweep.removed[0]?.files).toBe(2);
  expect(sweep.removed[1]?.files).toBe(1);

  const line = sweepReport(sweep);
  expect(line).toContain("the Spool's store");
  expect(line).toContain("the Looms");
  expect(line).toContain("#501");
});

test("ONCE — a second start walks nothing and says nothing, even if a directory comes back", () => {
  writeSpool();
  expect(sweepSpoolAndLooms(engineRoot).removed).toHaveLength(1);

  // The marker is the memory. An older build still running against this home
  // could recreate the directory; deleting it again and again, silently, is the
  // failure the marker exists to prevent.
  writeSpool();
  const second = sweepSpoolAndLooms(engineRoot);
  expect(second.removed).toEqual([]);
  expect(sweepReport(second)).toBeUndefined();
  expect(fs.existsSync(path.join(engineRoot, "spool"))).toBe(true);
});

test("a home with neither directory is swept silently and still only once", () => {
  const sweep = sweepSpoolAndLooms(engineRoot);
  expect(sweep.removed).toEqual([]);
  // Nothing to report: a daemon that printed "removed nothing" every morning
  // would train its reader to skip the line that matters.
  expect(sweepReport(sweep)).toBeUndefined();
  // It still remembers, so the next start does no walk at all.
  writeLooms();
  expect(sweepSpoolAndLooms(engineRoot).removed).toEqual([]);
  expect(fs.existsSync(path.join(home, "looms"))).toBe(true);
});

test("a directory that cannot be removed leaves the home alone and is retried", () => {
  writeSpool();
  writeLooms();
  const spool = path.join(engineRoot, "spool");
  // Read-only parent: the rm of `spool/` fails, the looms sweep still runs.
  fs.chmodSync(engineRoot, 0o500);
  let sweep: ReturnType<typeof sweepSpoolAndLooms>;
  try {
    sweep = sweepSpoolAndLooms(engineRoot);
  } finally {
    fs.chmodSync(engineRoot, 0o700);
  }

  expect(fs.existsSync(spool)).toBe(true);
  expect(fs.existsSync(path.join(home, "looms"))).toBe(false);
  expect(sweep.removed.map((entry) => entry.what)).toEqual(["the Looms"]);

  // NO MARKER after a failure, so the next start has another go rather than
  // writing this home off as done while the leftover is still sitting there.
  const retry = sweepSpoolAndLooms(engineRoot);
  expect(retry.removed.map((entry) => entry.what)).toEqual(["the Spool's store"]);
  expect(fs.existsSync(spool)).toBe(false);
});
