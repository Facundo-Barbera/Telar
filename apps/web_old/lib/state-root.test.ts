// State-root resolution for the two apps/web resolvers that had no test
// (CAP-1, Finding 8): lib/permissions.ts and lib/session-log.ts.
//
// The trim+resolve guard — `const v = process.env.TELAR_HOME?.trim(); return v
// ? path.resolve(v) : <home default>` — was applied to five resolvers. Three
// are already pinned: manifest.telarDir and looms.loomDir in
// packages/core/test/state-root.test.ts, store.stateRoot in ./store.test.ts.
// These two were not, and permissions.ts is the one that matters most: it holds
// the allow-rules that gate the Human-Accept Moat, and its pre-fix failure was
// SILENT — with root "" atomicWrite's mkdirSync(path.dirname("permissions.json"))
// resolves to "." and SUCCEEDS, so a moat rule accepted under one cwd is simply
// absent under another, with no error anywhere. session-log.ts fails the same
// way one directory deeper: "sessions/<id>" is a non-empty relative path, so
// mkdirSync succeeds and every live turn's log lands in <cwd>/sessions/<id>/.
//
// NEITHER RESOLVER IS EXPORTED (permissions.ts's telarHome(), session-log.ts's
// home()), so every assertion here goes through the nearest exported functions
// that use them — addRule/readRules and startSessionLog/appendSessionEvent/
// readSessionEvents. That is also the surface that actually matters: it pins
// the resolver AND that the write side and the read side agree on one root.
//
// WHY A CHILD PROCESS FOR THE EMPTY / UNSET / RELATIVE CASES: each of those is
// a claim about the cwd or about the home default, and none can be probed in
// this process. (a) With the guard in place an empty or unset root resolves to
// the REAL ~/.telar, and these two writers — unlike store.ts's, which crash on
// mkdirSync("") — SUCCEED, so an in-process probe would write into the human's
// actual state. (b) os.homedir() under Bun is resolved at process start and
// ignores an in-process process.env.HOME write, so a fake home only exists for
// a child. (c) A relative root writes under the cwd, and this suite's cwd is
// the repo. A child gets an mkdtemp'd HOME and an mkdtemp'd cwd of its own, so
// all three become observable without a byte written outside a throwaway dir.
//
// EVERY child cwd is seeded with a DECOY at the exact path the un-guarded
// resolver used, because "nothing new appeared in the cwd" is not enough on its
// own: startSessionLog TRUNCATES its target and addRule READS its target before
// rewriting it, so a leak can be a content change rather than a new file. The
// decoy makes that observable. Measured against a copy of each module with the
// guard reverted to the pre-fix `??` form: the permissions decoy comes back as
// ["DECOY-cwd-rule","Write"] and <cwd>/sessions/<id>/live.ndjson is truncated.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Whatever root was in effect when this file loaded. bun test runs every file
// in ONE process, so a suite that re-points TELAR_HOME and does not put it back
// silently re-roots every suite that runs after it.
const ORIGINAL = process.env.TELAR_HOME;
const restore = () => {
  if (ORIGINAL === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL;
};

// Pin a throwaway root BEFORE importing either module. Both resolvers read
// process.env lazily, so this is belt-and-braces — but it is the repo idiom
// (store.test.ts, permissions.test.ts) and it means no import-time read can
// ever reach a real root, whatever these modules grow later.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-web-state-root-"));
process.env.TELAR_HOME = TMP;

const permissions = await import("./permissions");
const sessionLog = await import("./session-log");
// Put it straight back: the pin only has to cover the imports, and every test
// below sets the root it needs. Leaving TMP in place would re-root any suite
// whose module scope happens to be evaluated between here and the first
// afterEach — TMP is deleted when this file finishes.
restore();

afterEach(restore);
afterAll(() => {
  restore();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(PROBES, { recursive: true, force: true });
});

const PROBE_PROJECT = "state-root-probe";
const PROBE_SESSION = "state-root-probe-session";
const DECOY_RULES = JSON.stringify({ [PROBE_PROJECT]: { allow: ["DECOY-cwd-rule"] } }, null, 2);
const DECOY_EVENT = JSON.stringify({ event: "decoy", data: {} }) + "\n";

// ── child probes ───────────────────────────────────────────────────────────
// Generated rather than committed: each one imports the module under test by
// ABSOLUTE path (so it resolves the same module this file imported, from its
// own directory, keeping ./loom-mcp and @telar/core resolvable) and prints the
// READBACK, which proves the writer and the reader picked the same root.
const PROBES = fs.mkdtempSync(path.join(os.tmpdir(), "telar-state-root-probes-"));
const permissionsProbe = path.join(PROBES, "permissions-probe.ts");
const sessionLogProbe = path.join(PROBES, "session-log-probe.ts");
fs.writeFileSync(
  permissionsProbe,
  [
    `const perms = await import(${JSON.stringify(fileURLToPath(new URL("./permissions.ts", import.meta.url)))});`,
    `perms.addRule(${JSON.stringify(PROBE_PROJECT)}, "Write");`,
    `console.log(JSON.stringify(perms.readRules(${JSON.stringify(PROBE_PROJECT)})));`,
  ].join("\n"),
);
fs.writeFileSync(
  sessionLogProbe,
  [
    `const log = await import(${JSON.stringify(fileURLToPath(new URL("./session-log.ts", import.meta.url)))});`,
    `log.startSessionLog(${JSON.stringify(PROBE_SESSION)}, "hello");`,
    `log.appendSessionEvent(${JSON.stringify(PROBE_SESSION)}, "text", { text: "x" });`,
    `const read = log.readSessionEvents(${JSON.stringify(PROBE_SESSION)}, 0);`,
    `console.log(JSON.stringify(read.events.map((e) => e.event)));`,
  ].join("\n"),
);

type Sandbox = { cwd: string; home: string; abs: string; cleanup: () => void };

// A child's whole world: its own cwd, its own HOME, and one absolute root to
// point TELAR_HOME at. All three are mkdtemp'd, so a regressed resolver has
// nowhere to write that isn't cleaned up.
function sandbox(tag: string): Sandbox {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `telar-${tag}-cwd-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `telar-${tag}-home-`));
  const abs = fs.mkdtempSync(path.join(os.tmpdir(), `telar-${tag}-abs-`));
  return {
    cwd,
    home,
    abs,
    cleanup: () => {
      for (const dir of [cwd, home, abs]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// `telarHome: undefined` means UNSET (deleted), not empty — the two are
// different inputs and both are pinned below.
function runProbe(
  probe: string,
  s: Sandbox,
  telarHome: string | undefined,
  opts: { unset?: boolean } = {},
): string {
  // ProcessEnv is typed without an index signature in this app, so TELAR_HOME
  // is set/deleted through a cast — the same idiom store.test.ts uses.
  const env = { ...process.env, HOME: s.home };
  const mutable = env as Record<string, string | undefined>;
  if (opts.unset) delete mutable.TELAR_HOME;
  else mutable.TELAR_HOME = telarHome;
  const out = spawnSync(process.execPath, [probe], { cwd: s.cwd, env, encoding: "utf8" });
  expect(out.stderr).toBe("");
  expect(out.status).toBe(0);
  return out.stdout.trim();
}

// Sorted relative listing of everything under `dir`. Used to assert that a run
// created NOTHING in the cwd — stronger than checking the one path we predict.
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      out.push(child);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk("");
  return out.sort();
}

const homeDefault = path.join(os.homedir(), ".telar");

// Bounded, read-only fingerprint of the two things in the REAL ~/.telar that
// this file could conceivably touch. Never creates the directory, never stats
// it into existence, and never walks a loom's working tree.
function realHomeFingerprint(): Record<string, string> {
  const snap: Record<string, string> = {};
  try {
    snap["permissions.json"] = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(homeDefault, "permissions.json")))
      .digest("hex");
  } catch {
    snap["permissions.json"] = "<absent>";
  }
  try {
    snap["sessions/"] = fs.readdirSync(path.join(homeDefault, "sessions")).sort().join(",");
  } catch {
    snap["sessions/"] = "<absent>";
  }
  return snap;
}
const REAL_HOME_BEFORE = realHomeFingerprint();

describe("permissions.ts state root (CAP-1, Finding 8)", () => {
  test("an ABSOLUTE TELAR_HOME is honored unchanged, for both the write and the read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-perm-abs-"));
    try {
      process.env.TELAR_HOME = root;
      permissions.addRule(PROBE_PROJECT, "Write");
      expect(fs.existsSync(path.join(root, "permissions.json"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, "permissions.json"), "utf8"))).toEqual({
        [PROBE_PROJECT]: { allow: ["Write"] },
      });
      // The read side resolves the same root — a split between them is exactly
      // the "accepted here, absent there" failure this guard exists to end.
      expect(permissions.readRules(PROBE_PROJECT)).toEqual(["Write"]);
      permissions.removeRule(PROBE_PROJECT, "Write");
      expect(permissions.readRules(PROBE_PROJECT)).toEqual([]);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("surrounding whitespace is trimmed off an absolute root, not joined into the path", () => {
    // Asserted through a READ over a planted file, never a write: an untrimmed
    // " <root>\n" is a RELATIVE path (it starts with a space), so under a
    // regression a write would land under this suite's cwd — i.e. in the repo.
    // Reading can only ever fail to find the plant.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-perm-trim-"));
    try {
      fs.writeFileSync(
        path.join(root, "permissions.json"),
        JSON.stringify({ [PROBE_PROJECT]: { allow: ["Edit"] } }),
      );
      for (const padded of [` ${root}`, `${root}\n`, `\t${root} `]) {
        process.env.TELAR_HOME = padded;
        expect(permissions.readRules(PROBE_PROJECT)).toEqual(["Edit"]);
      }
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an EMPTY TELAR_HOME writes the moat's rules to the home default, never to the cwd", () => {
    // `??` falls back on null/undefined but NOT on "", and an exported-but-empty
    // `TELAR_HOME=` is routine in shell scripts and CI. Whitespace-only is in
    // the loop because the guard TRIMS: same mistake, invisible payload.
    for (const empty of ["", "   ", "\t"]) {
      const s = sandbox("perm-empty");
      try {
        const decoy = path.join(s.cwd, "permissions.json");
        fs.writeFileSync(decoy, DECOY_RULES);
        const before = tree(s.cwd);

        // The rule the child persisted is the ONLY rule it reads back: it never
        // saw the cwd's file. Un-guarded this is ["DECOY-cwd-rule","Write"].
        expect(JSON.parse(runProbe(permissionsProbe, s, empty))).toEqual(["Write"]);
        expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_RULES);
        expect(tree(s.cwd)).toEqual(before);
        expect(JSON.parse(fs.readFileSync(path.join(s.home, ".telar", "permissions.json"), "utf8"))).toEqual({
          [PROBE_PROJECT]: { allow: ["Write"] },
        });
      } finally {
        s.cleanup();
      }
    }
  });

  test("an UNSET TELAR_HOME behaves exactly as an empty one: <homedir>/.telar", () => {
    // AC2 — the no-regression half. Unset was never broken; this pins that the
    // guard did not change it.
    const s = sandbox("perm-unset");
    try {
      const decoy = path.join(s.cwd, "permissions.json");
      fs.writeFileSync(decoy, DECOY_RULES);
      const before = tree(s.cwd);
      expect(JSON.parse(runProbe(permissionsProbe, s, undefined, { unset: true }))).toEqual(["Write"]);
      expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_RULES);
      expect(tree(s.cwd)).toEqual(before);
      expect(fs.existsSync(path.join(s.home, ".telar", "permissions.json"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("a RELATIVE TELAR_HOME resolves against the cwd and normalizes", () => {
    // THE DESIGN CALL, pinned so it is a decision rather than an accident: a
    // relative root is RESOLVED, not refused. It does not lift the rules out of
    // the cwd — it makes them land at exactly path.resolve(<cwd>, <value>),
    // ".." segments collapsed, instead of at a fragment each caller re-joins.
    // (If refusing outright is ever taken instead, this becomes a non-zero
    // exit.) The child's cwd is mkdtemp'd, so "under the cwd" is throwaway.
    const s = sandbox("perm-rel");
    try {
      const decoy = path.join(s.cwd, "permissions.json");
      fs.writeFileSync(decoy, DECOY_RULES);
      expect(JSON.parse(runProbe(permissionsProbe, s, "sub/../telar-relative-root"))).toEqual(["Write"]);
      expect(fs.existsSync(path.join(s.cwd, "telar-relative-root", "permissions.json"))).toBe(true);
      // "sub" is a segment of the input that resolution cancels; it must never
      // be created on disk.
      expect(fs.existsSync(path.join(s.cwd, "sub"))).toBe(false);
      // A relative root must not silently fall back to the home default either.
      expect(fs.existsSync(path.join(s.home, ".telar"))).toBe(false);
      expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_RULES);
    } finally {
      s.cleanup();
    }
  });

  test("a whitespace-padded ABSOLUTE root lands in the root, with nothing in the cwd", () => {
    // The write-side half of the trim, run where a regression can only damage a
    // throwaway cwd (see the read-only in-process trim test above).
    const s = sandbox("perm-abs");
    try {
      const decoy = path.join(s.cwd, "permissions.json");
      fs.writeFileSync(decoy, DECOY_RULES);
      const before = tree(s.cwd);
      expect(JSON.parse(runProbe(permissionsProbe, s, ` ${s.abs}\n`))).toEqual(["Write"]);
      expect(fs.existsSync(path.join(s.abs, "permissions.json"))).toBe(true);
      expect(tree(s.abs)).toEqual(["permissions.json"]);
      expect(tree(s.cwd)).toEqual(before);
      expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_RULES);
      expect(fs.existsSync(path.join(s.home, ".telar"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });
});

describe("session-log.ts state root (CAP-1, Finding 8)", () => {
  test("an ABSOLUTE TELAR_HOME is honored unchanged, for both the write and the read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-slog-abs-"));
    try {
      process.env.TELAR_HOME = root;
      sessionLog.startSessionLog(PROBE_SESSION, "hello");
      sessionLog.appendSessionEvent(PROBE_SESSION, "text", { text: "x" });
      const live = path.join(root, "sessions", PROBE_SESSION, "live.ndjson");
      expect(fs.existsSync(live)).toBe(true);
      // startSessionLog and appendSessionEvent swallow every error, so the file
      // check alone would pass on a silent no-op — read the events back too.
      expect(sessionLog.readSessionEvents(PROBE_SESSION, 0).events.map((e) => e.event)).toEqual([
        "user",
        "text",
      ]);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("surrounding whitespace is trimmed off an absolute root, not joined into the path", () => {
    // Read-only over a planted log, for the same reason as the permissions
    // trim test: an untrimmed " <root>\n" is a relative path.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-slog-trim-"));
    try {
      fs.mkdirSync(path.join(root, "sessions", PROBE_SESSION), { recursive: true });
      fs.writeFileSync(
        path.join(root, "sessions", PROBE_SESSION, "live.ndjson"),
        JSON.stringify({ event: "planted", data: {} }) + "\n",
      );
      for (const padded of [` ${root}`, `${root}\n`, `\t${root} `]) {
        process.env.TELAR_HOME = padded;
        expect(sessionLog.readSessionEvents(PROBE_SESSION, 0).events.map((e) => e.event)).toEqual([
          "planted",
        ]);
      }
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an EMPTY TELAR_HOME writes the live turn log to the home default, never to the cwd", () => {
    for (const empty of ["", "   ", "\t"]) {
      const s = sandbox("slog-empty");
      try {
        // The decoy sits at the exact path an un-guarded root produced —
        // <cwd>/sessions/<id>/live.ndjson — and startSessionLog TRUNCATES its
        // target, so a leak shows up as content loss, not as a new file.
        const decoyDir = path.join(s.cwd, "sessions", PROBE_SESSION);
        fs.mkdirSync(decoyDir, { recursive: true });
        const decoy = path.join(decoyDir, "live.ndjson");
        fs.writeFileSync(decoy, DECOY_EVENT);
        const before = tree(s.cwd);

        expect(JSON.parse(runProbe(sessionLogProbe, s, empty))).toEqual(["user", "text"]);
        expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_EVENT);
        expect(tree(s.cwd)).toEqual(before);
        expect(
          fs.existsSync(path.join(s.home, ".telar", "sessions", PROBE_SESSION, "live.ndjson")),
        ).toBe(true);
      } finally {
        s.cleanup();
      }
    }
  });

  test("an UNSET TELAR_HOME behaves exactly as an empty one: <homedir>/.telar", () => {
    const s = sandbox("slog-unset");
    try {
      const decoyDir = path.join(s.cwd, "sessions", PROBE_SESSION);
      fs.mkdirSync(decoyDir, { recursive: true });
      const decoy = path.join(decoyDir, "live.ndjson");
      fs.writeFileSync(decoy, DECOY_EVENT);
      const before = tree(s.cwd);
      expect(JSON.parse(runProbe(sessionLogProbe, s, undefined, { unset: true }))).toEqual([
        "user",
        "text",
      ]);
      expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_EVENT);
      expect(tree(s.cwd)).toEqual(before);
      expect(
        fs.existsSync(path.join(s.home, ".telar", "sessions", PROBE_SESSION, "live.ndjson")),
      ).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("a RELATIVE TELAR_HOME resolves against the cwd and normalizes", () => {
    const s = sandbox("slog-rel");
    try {
      const decoyDir = path.join(s.cwd, "sessions", PROBE_SESSION);
      fs.mkdirSync(decoyDir, { recursive: true });
      const decoy = path.join(decoyDir, "live.ndjson");
      fs.writeFileSync(decoy, DECOY_EVENT);
      expect(JSON.parse(runProbe(sessionLogProbe, s, "sub/../telar-relative-root"))).toEqual([
        "user",
        "text",
      ]);
      expect(
        fs.existsSync(
          path.join(s.cwd, "telar-relative-root", "sessions", PROBE_SESSION, "live.ndjson"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(s.cwd, "sub"))).toBe(false);
      expect(fs.existsSync(path.join(s.home, ".telar"))).toBe(false);
      // The relative root is <cwd>/telar-relative-root, NOT the cwd itself.
      expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_EVENT);
    } finally {
      s.cleanup();
    }
  });

  test("a whitespace-padded ABSOLUTE root lands in the root, with nothing new in the cwd", () => {
    const s = sandbox("slog-abs");
    try {
      const decoyDir = path.join(s.cwd, "sessions", PROBE_SESSION);
      fs.mkdirSync(decoyDir, { recursive: true });
      const decoy = path.join(decoyDir, "live.ndjson");
      fs.writeFileSync(decoy, DECOY_EVENT);
      const before = tree(s.cwd);
      expect(JSON.parse(runProbe(sessionLogProbe, s, ` ${s.abs}\n`))).toEqual(["user", "text"]);
      expect(tree(s.abs)).toEqual([
        "sessions",
        path.join("sessions", PROBE_SESSION),
        path.join("sessions", PROBE_SESSION, "live.ndjson"),
      ]);
      expect(tree(s.cwd)).toEqual(before);
      expect(fs.readFileSync(decoy, "utf8")).toBe(DECOY_EVENT);
      expect(fs.existsSync(path.join(s.home, ".telar"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });
});

// ── THE READ IDIOM, PINNED AS A REPO-WIDE INVARIANT ─────────────────────────
// Every test above drives ONE resolver through ONE exported caller. That is the
// right shape for a resolver, and it is structurally incapable of catching the
// defect that actually shipped: a NEW reader of process.env.TELAR_HOME that
// forgets the trim. Two of those were found by review rather than by any test —
// usage-ledger.ts's logUsage guard, which let TELAR_HOME=" " through and
// appended a synthetic billing line to the developer's real ~/.telar; and
// doctor.ts's telarHomeCheck, which labelled the HOME DEFAULT "Custom
// (TELAR_HOME override)" for the same value, in the one readout a human uses to
// confirm which state root is live. Both were the same shape: a reader that
// asks a DIFFERENT QUESTION of the variable than telarDir() answers.
//
// A per-resolver test cannot see that class, because the offender is by
// definition a site nobody wrote a test for. A text scan can, and it is the
// same instrument weave.test.ts uses for its append-only invariant, with the
// same honest limits: it matches text, so a read assembled some other way
// (destructuring process.env, an alias, a computed key) evades it.
describe("the TELAR_HOME read idiom, across every source tree that resolves it", () => {
  const REPO = fileURLToPath(new URL("../../../", import.meta.url));
  const SCANNED = ["apps/web/lib", "apps/web/app", "apps/web/components", "packages/core/src", "scripts"];

  const sourceFiles = (rel: string): string[] => {
    const dir = path.join(REPO, rel);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.includes("node_modules") && !f.includes(".next"))
      .map((f) => path.join(dir, f));
  };

  test("every read of process.env.TELAR_HOME goes through ?.trim() — writes and deletes excepted", () => {
    const READ = /process\.env\.TELAR_HOME/g;
    const offenders: string[] = [];
    let reads = 0;
    for (const rel of SCANNED) {
      for (const file of sourceFiles(rel)) {
        const text = fs.readFileSync(file, "utf8");
        READ.lastIndex = 0;
        for (let m = READ.exec(text); m; m = READ.exec(text)) {
          const after = text.slice(m.index + m[0].length);
          const before = text.slice(0, m.index);
          // An ASSIGNMENT (`process.env.TELAR_HOME = x`) sets the variable and
          // reads nothing, and a `delete` unsets it. Both are how a caller PINS
          // a root — scripts/e2e does exactly this — and neither can disagree
          // with a resolver about a value.
          if (/^\s*=[^=]/.test(after)) continue;
          if (/\bdelete\s+$/.test(before)) continue;
          reads++;
          if (!after.startsWith("?.trim()")) {
            offenders.push(`${path.relative(REPO, file)}:${before.split("\n").length}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // A FLOOR, so a scan whose pattern went dead cannot pass by matching
    // nothing: the five resolvers plus logUsage's guard plus doctor's label.
    expect(reads).toBeGreaterThanOrEqual(7);
  });

  test("the scan DISCRIMINATES — it catches a raw read and ignores the shapes that are not one", () => {
    // A scan that had quietly stopped matching would pass exactly as green as a
    // clean tree, so the patterns are proved against fixtures that must fail
    // and fixtures that must not.
    const raw = "const v = process.env.TELAR_HOME;";
    const trimmed = "const v = process.env.TELAR_HOME?.trim();";
    const assigned = "process.env.TELAR_HOME = home;";
    const deleted = "delete process.env.TELAR_HOME;";
    const check = (src: string) => {
      const m = /process\.env\.TELAR_HOME/.exec(src);
      if (!m) return "no-match";
      const after = src.slice(m.index + m[0].length);
      if (/^\s*=[^=]/.test(after)) return "write";
      if (/\bdelete\s+$/.test(src.slice(0, m.index))) return "delete";
      return after.startsWith("?.trim()") ? "trimmed-read" : "RAW READ";
    };
    expect(check(raw)).toBe("RAW READ");
    expect(check(trimmed)).toBe("trimmed-read");
    expect(check(assigned)).toBe("write");
    expect(check(deleted)).toBe("delete");
  });
});

describe("the real ~/.telar", () => {
  // Declared last so it runs last (bun runs a file's tests in declaration
  // order). The tripwire for every test above: with the guard in place an
  // empty or unset root resolves HERE, and nothing in this file may write to
  // it — which is why those two cases are only ever exercised in a child with
  // an mkdtemp'd HOME.
  test("is neither created nor modified by anything in this file", () => {
    expect(realHomeFingerprint()).toEqual(REAL_HOME_BEFORE);
  });
});
