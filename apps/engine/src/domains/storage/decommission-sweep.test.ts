import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { retireAgentReport, retireAgentStore, sweepReport, sweepSpoolAndLooms } from "./decommission-sweep";
import { statePaths } from "../../platform/fs/state-paths";
import { DIRECTORY_CATEGORIES } from "./measure";

let home: string;
let engineRoot: string;

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
  fs.writeFileSync(path.join(engineRoot, "projects.json"), "{}");
  fs.mkdirSync(path.join(engineRoot, "sessions"), { recursive: true });

  const sweep = sweepSpoolAndLooms(engineRoot);

  expect(fs.existsSync(path.join(engineRoot, "spool"))).toBe(false);
  expect(fs.existsSync(path.join(home, "looms"))).toBe(false);
  expect(fs.existsSync(path.join(engineRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(path.join(engineRoot, "sessions"))).toBe(true);

  expect(sweep.removed.map((entry) => entry.what)).toEqual(["the Spool's store", "the Looms"]);
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

  writeSpool();
  const second = sweepSpoolAndLooms(engineRoot);
  expect(second.removed).toEqual([]);
  expect(sweepReport(second)).toBeUndefined();
  expect(fs.existsSync(path.join(engineRoot, "spool"))).toBe(true);
});

test("a home with neither directory is swept silently and still only once", () => {
  const sweep = sweepSpoolAndLooms(engineRoot);
  expect(sweep.removed).toEqual([]);
  expect(sweepReport(sweep)).toBeUndefined();
  writeLooms();
  expect(sweepSpoolAndLooms(engineRoot).removed).toEqual([]);
  expect(fs.existsSync(path.join(home, "looms"))).toBe(true);
});

test("a directory that cannot be removed leaves the home alone and is retried", () => {
  writeSpool();
  writeLooms();
  const spool = path.join(engineRoot, "spool");
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

  const retry = sweepSpoolAndLooms(engineRoot);
  expect(retry.removed.map((entry) => entry.what)).toEqual(["the Spool's store"]);
  expect(fs.existsSync(spool)).toBe(false);
});

const AT = Date.parse("2026-09-23T10:04:05.006Z");
const STAMPED = "agent-2026-09-23T10-04-05-006Z";

const writeAgent = () => {
  const dir = path.join(engineRoot, "agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.json"), '{"enabled":true}');
  fs.writeFileSync(path.join(dir, "threads.sqlite"), "not really sqlite");
  fs.writeFileSync(path.join(dir, "credentials.json"), '{"key":"placeholder"}', { mode: 0o600 });
  fs.chmodSync(path.join(dir, "credentials.json"), 0o600);
};

const declared = () => {
  const { root: _root, ...named } = statePaths(engineRoot);
  return new Set([...Object.values(named).map((file) => path.basename(file)), ...Object.keys(DIRECTORY_CATEGORIES)]);
};

test("the Agent's directory moves whole to retired/agent-<stamp>/, the key keeps its 0600, and the line says where", () => {
  writeAgent();
  fs.writeFileSync(path.join(engineRoot, "projects.json"), "{}");

  const retirement = retireAgentStore(engineRoot, () => AT);

  const target = path.join(engineRoot, "retired", STAMPED);
  expect(retirement).toEqual({ moved: true, to: target });
  expect(fs.existsSync(path.join(engineRoot, "agent"))).toBe(false);
  expect(fs.readdirSync(target).sort()).toEqual(["agent.json", "credentials.json", "threads.sqlite"]);
  expect(fs.statSync(path.join(target, "credentials.json")).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(path.join(engineRoot, "projects.json"))).toBe(true);
  expect(fs.existsSync(statePaths(engineRoot).agentRetiredMarker)).toBe(true);

  const line = retireAgentReport(retirement);
  expect(line).toContain(target);
  expect(line).toContain("#908");
  expect(line).toContain("nothing was deleted");
});

test("ONCE — a second start is a no-op and says nothing, even if agent/ comes back", () => {
  writeAgent();
  expect(retireAgentStore(engineRoot, () => AT).moved).toBe(true);

  writeAgent();
  const second = retireAgentStore(engineRoot, () => AT + 1000);
  expect(second).toEqual({ moved: false });
  expect(retireAgentReport(second)).toBeUndefined();
  expect(fs.existsSync(path.join(engineRoot, "agent"))).toBe(true);
  expect(fs.readdirSync(path.join(engineRoot, "retired"))).toEqual([STAMPED]);
});

test("a home with no agent/ is a silent no-op that still remembers", () => {
  const retirement = retireAgentStore(engineRoot, () => AT);
  expect(retirement).toEqual({ moved: false });
  expect(retireAgentReport(retirement)).toBeUndefined();
  expect(fs.existsSync(path.join(engineRoot, "retired"))).toBe(false);
  expect(fs.existsSync(statePaths(engineRoot).agentRetiredMarker)).toBe(true);
});

test("a rename that fails leaves agent/ untouched, never throws, says so, and is retried", () => {
  writeAgent();
  fs.chmodSync(engineRoot, 0o500);
  let failed: ReturnType<typeof retireAgentStore>;
  try {
    failed = retireAgentStore(engineRoot, () => AT);
  } finally {
    fs.chmodSync(engineRoot, 0o700);
  }

  expect(failed.moved).toBe(false);
  expect("failed" in failed && failed.failed).toBeTruthy();
  expect(retireAgentReport(failed)).toContain("will be retried");
  expect(fs.statSync(path.join(engineRoot, "agent", "credentials.json")).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(statePaths(engineRoot).agentRetiredMarker)).toBe(false);

  expect(retireAgentStore(engineRoot, () => AT).moved).toBe(true);
});

test("the #665 storage invariant rejects a leftover agent/ and accepts the home once it is swept", () => {
  writeAgent();
  fs.writeFileSync(path.join(engineRoot, "projects.json"), "{}");
  const undeclared = () => fs.readdirSync(engineRoot).filter((name) => !declared().has(name));

  expect(undeclared()).toEqual(["agent"]);
  retireAgentStore(engineRoot, () => AT);
  expect(undeclared()).toEqual([]);
  expect(fs.readdirSync(engineRoot)).toContain("retired");
});
