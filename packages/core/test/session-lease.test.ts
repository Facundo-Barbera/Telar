// AD-16 / AC11 — ONE lease primitive, TWO lifetimes, and a reclaim decision
// that structurally cannot say `done`.
//
// The three things this file has to prove, in the AC's own order:
//   1. ONE SHAPE   — a loom root and a session root leased through the SAME
//                    exported functions produce structurally identical records.
//                    If there are two write paths, this AC is not met however
//                    green the suite is.
//   2. RUNTIME ONLY — sessionDir() resolves under TELAR_HOME, is created on
//                    demand, and writing a session lease creates nothing named
//                    chats.json / usage.ndjson anywhere and
//                    does not touch the root-level store.
//   3. NEVER AUTO-DONE — the reclaim decision is a pure function whose return
//                    union has no member that can express a terminal success.
//                    Enumerated AND pinned against the compiler, because a test
//                    over behavior alone would pass on a union that merely
//                    happens not to return `done` today.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pin a throwaway state root BEFORE importing anything that resolves it. Static
// imports are hoisted and evaluated first, so the modules under test are loaded
// dynamically below — the settled convention after story 1.1 fixed four suites
// for exactly this. bun runs every file in ONE process, so the root is re-pinned
// in beforeEach and restored in afterAll.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-lease-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = home;

const sessions = await import("../src/sessions");
const lease = await import("../src/runner/lease");
const looms = await import("../src/looms");
const recover = await import("../src/runner/recover");
const schemas = await import("../src/schemas");

beforeEach(() => {
  process.env.TELAR_HOME = home;
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

// Sorted relative listing of everything under `dir` — stronger than checking
// the one path we predict.
const tree = (dir: string): string[] => {
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
};

describe("AC11.1 — ONE record shape, written through ONE set of functions", () => {
  test("AC11 a loom root and a session root lease through the SAME exports and produce identical records", () => {
    const loomRoot = looms.loomDir("L-same-shape");
    const sessionId = "sess-same-shape";

    // The loom side goes through the primitive directly; the session side goes
    // through sessions.ts, which COMPOSES over that same primitive. Both land
    // on writeLease.
    const loomRecord = lease.writeLease(loomRoot, { pid: 11, token: "tok-loom" }, () => 1000);
    const sessionRecord = sessions.writeSessionLease(
      sessionId,
      { pid: 22, token: "tok-session" },
      () => 1000,
    );

    // Structurally identical: same keys, same field types, same ts semantics.
    expect(Object.keys(loomRecord).sort()).toEqual(["pid", "token", "ts"]);
    expect(Object.keys(sessionRecord).sort()).toEqual(Object.keys(loomRecord).sort());
    for (const k of ["pid", "token", "ts"] as const) {
      expect(typeof sessionRecord[k]).toBe(typeof loomRecord[k]);
    }
    expect(loomRecord.ts).toBe(1000);
    expect(sessionRecord.ts).toBe(1000);

    // ...and identical ON DISK, which is the claim that actually matters.
    const loomOnDisk = JSON.parse(fs.readFileSync(lease.leaseFile(loomRoot), "utf8"));
    const sessionOnDisk = JSON.parse(fs.readFileSync(sessions.sessionLeaseFile(sessionId), "utf8"));
    expect(Object.keys(loomOnDisk).sort()).toEqual(Object.keys(sessionOnDisk).sort());

    // Both read back through the SAME reader, too.
    expect(lease.readLease(loomRoot)).toEqual(loomRecord);
    expect(lease.readLease(sessions.sessionDir(sessionId))).toEqual(sessionRecord);
    expect(sessions.readSessionLease(sessionId)).toEqual(sessionRecord);
  });

  test("AC11 the lease filename is `.runner-lease` on BOTH lifetimes — one filename, zero divergence", () => {
    expect(path.basename(lease.leaseFile(looms.loomDir("L-filename")))).toBe(".runner-lease");
    expect(path.basename(sessions.sessionLeaseFile("sess-filename"))).toBe(".runner-lease");
    // The word "runner" is historical and stays: real loom trees already hold a
    // .runner-lease on disk and a rename would orphan them.
    expect(sessions.sessionLeaseFile("sess-filename")).toBe(
      path.join(home, "sessions", "sess-filename", ".runner-lease"),
    );
  });

  test("AC11 heartbeat keeps pid/token and moves ts, identically on both paths", () => {
    const loomRoot = looms.loomDir("L-beat");
    lease.writeLease(loomRoot, { pid: 7, token: "k" }, () => 1000);
    expect(lease.heartbeatLease(loomRoot, () => 5000)).toEqual({ pid: 7, token: "k", ts: 5000 });

    sessions.writeSessionLease("sess-beat", { pid: 7, token: "k" }, () => 1000);
    expect(sessions.heartbeatSessionLease("sess-beat", () => 5000)).toEqual({
      pid: 7,
      token: "k",
      ts: 5000,
    });
    expect(sessions.readSessionLease("sess-beat")!.ts).toBe(5000);

    // Nothing to beat is null on both paths, never an invented lease.
    expect(lease.heartbeatLease(looms.loomDir("L-nobeat"), () => 1)).toBeNull();
    expect(sessions.heartbeatSessionLease("sess-nobeat", () => 1)).toBeNull();
    expect(sessions.readSessionLease("sess-nobeat")).toBeNull();
  });

  test("sessions.ts COMPOSES over the primitive — it does not contain a second write path", () => {
    // The story's own tripwire: "if the word renameSync appears in this file,
    // you have written a second lease." Asserted rather than promised.
    const source = fs.readFileSync(
      fileURLToPath(new URL("../src/sessions.ts", import.meta.url)),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    // (JSON.stringify is NOT on this list — the id guard uses it to quote a bad
    // id in its error, exactly as looms.ts's loomDir does. The tell for a second
    // lease is the WRITE idiom, not serialization.)
    const forbidden = ["renameSync", "writeFileSync", "mkdirSync", ".tmp", "runner-lease"];
    expect(forbidden.filter((f) => code.includes(f))).toEqual([]);
    // Floor: the scan is looking at the right file.
    expect(code).toContain("writeLease(sessionDir(sessionId)");
  });
});

describe("AC11.2 — the session tree exists and holds RUNTIME state only", () => {
  test("AC11 sessionDir resolves under TELAR_HOME at the byte-identical path session-log.ts uses", () => {
    // Pinned as a LITERAL, not by comparing against an import core cannot
    // reach: apps/web/lib/session-log.ts builds `<TELAR_HOME>/sessions/<id>`
    // with its own private resolver, and if these two ever disagree the
    // directory split-brains between its two co-tenants.
    expect(sessions.sessionsDir()).toBe(path.join(home, "sessions"));
    expect(sessions.sessionDir("abc-123")).toBe(path.join(home, "sessions", "abc-123"));
    expect(sessions.sessionDir("abc-123")).toBe(`${home}${path.sep}sessions${path.sep}abc-123`);
  });

  test("AC11 the session directory is created on demand by the first lease write", () => {
    const id = "sess-on-demand";
    expect(fs.existsSync(sessions.sessionDir(id))).toBe(false);
    sessions.writeSessionLease(id, { pid: 1, token: "t" }, () => 1);
    expect(fs.existsSync(sessions.sessionDir(id))).toBe(true);
    expect(fs.existsSync(sessions.sessionLeaseFile(id))).toBe(true);
  });

  test("AC11 a traversal id fails CLOSED — the deliberate asymmetry with session-log.ts", () => {
    // session-log.ts's resolver does NOT guard its id; core's does. Core
    // therefore refuses an id session-log.ts would happily write, which is the
    // safer direction and a stated choice rather than an accident.
    for (const bad of ["../../etc", "a/b", "", "..", "a b", "a.b", "/abs", "a\\b"]) {
      expect(() => sessions.sessionDir(bad)).toThrow(/invalid session id/);
      expect(() => sessions.sessionLeaseFile(bad)).toThrow(/invalid session id/);
      expect(() => sessions.writeSessionLease(bad, { pid: 1, token: "t" })).toThrow(
        /invalid session id/,
      );
      expect(() => sessions.readSessionLease(bad)).toThrow(/invalid session id/);
    }
    // A UUID-shaped SDK session id passes, which is the real input.
    expect(() => sessions.sessionDir("0f9c2e14-8b7a-4d61-9a02-3f5b6c7d8e90")).not.toThrow();
  });

  test("AC11 a session lease creates NO chats.json / usage.ndjson and leaves the root store untouched", () => {
    // Plant the root-level store first: "nothing new appeared" is not enough on
    // its own — a leak can be a CONTENT change rather than a new file.
    const planted: Record<string, string> = {
      "chats.json": JSON.stringify({ planted: "chats" }),
      "usage.ndjson": JSON.stringify({ planted: "usage" }) + "\n",
    };
    for (const [name, body] of Object.entries(planted)) {
      fs.writeFileSync(path.join(home, name), body);
    }
    const before = tree(home);

    const id = "sess-runtime-only";
    sessions.writeSessionLease(id, { pid: 3, token: "t" }, () => 10);
    sessions.heartbeatSessionLease(id, () => 20);
    sessions.readSessionLease(id);
    sessions.sessionLeaseReclaim(id, 5, 100);

    // The root-level store is byte-for-byte what it was.
    for (const [name, body] of Object.entries(planted)) {
      expect(fs.readFileSync(path.join(home, name), "utf8")).toBe(body);
    }
    // Nothing by those names appeared ANYWHERE in the tree beyond the plants.
    const after = tree(home);
    const forbidden = ["chats.json", "usage.ndjson"];
    const created = after.filter((p) => !before.includes(p));
    expect(created.filter((p) => forbidden.includes(path.basename(p)))).toEqual([]);
    // What the session lease DID create is exactly its own directory + file.
    // ("sessions" itself is filtered out — an earlier test in this file may
    // already have created it, and whether it is new here is not the claim.)
    expect(created.filter((p) => p !== "sessions").sort()).toEqual(
      [path.join("sessions", id), path.join("sessions", id, ".runner-lease")].sort(),
    );
  });

  test("the lease writes atomically — no .tmp residue survives the rename", () => {
    const id = "sess-atomic";
    sessions.writeSessionLease(id, { pid: 4, token: "t" }, () => 1);
    expect(fs.readdirSync(sessions.sessionDir(id))).toEqual([".runner-lease"]);
  });
});

describe("AC11.3 — the reclaim decision cannot express a terminal success", () => {
  test("AC11 every value the reclaim union can take is enumerated, and `done` is not among them", () => {
    // The AC's own instruction: enumerate the union, do not merely observe that
    // today's inputs never yield `done`.
    expect([...lease.LEASE_RECLAIM_OUTCOMES]).toEqual(["held", "reclaimable"]);
    expect([...lease.LEASE_RECLAIM_OUTCOMES]).not.toContain("done");
    for (const outcome of lease.LEASE_RECLAIM_OUTCOMES) {
      expect(["done", "completed", "success", "ok", "passed"]).not.toContain(outcome);
    }
    // And the enumeration is EXHAUSTIVE over what the function actually
    // produces — a constant that drifted from the implementation would be a
    // list of reassuring strings and nothing more.
    const produced = new Set<string>();
    for (const l of [null, { pid: 1, token: "t", ts: 0 }, { pid: 1, token: "t", ts: 100 }]) {
      for (const [ttl, now] of [
        [0, 0],
        [10, 100],
        [1000, 100],
        [10, 1_000_000],
      ] as const) {
        produced.add(lease.leaseReclaim(l, ttl, now));
      }
    }
    expect([...produced].sort()).toEqual(["held", "reclaimable"]);
  });

  test("AC11 leaseReclaim is PURE and wraps isLeaseFresh — fresh is held, everything else is reclaimable", () => {
    const l = { pid: 1, token: "t", ts: 1000 };
    // Identical boundary behavior to isLeaseFresh, because it IS isLeaseFresh —
    // re-deriving `now - lease.ts <= ttlMs` inline would be the second
    // stale-reclaim in its smallest form.
    for (const [ttl, now] of [
      [100, 1050],
      [100, 1100],
      [100, 1101],
      [0, 1000],
      [0, 1001],
    ] as const) {
      expect(lease.leaseReclaim(l, ttl, now)).toBe(
        lease.isLeaseFresh(l, ttl, now) ? "held" : "reclaimable",
      );
    }
    expect(lease.leaseReclaim(null, 100, 1000)).toBe("reclaimable");
    // Pure: no clock read, no disk. Same inputs, same answer, and the argument
    // is not mutated.
    const before = JSON.stringify(l);
    expect(lease.leaseReclaim(l, 100, 1101)).toBe("reclaimable");
    expect(JSON.stringify(l)).toBe(before);
  });

  test("AC11 a STALE lease resolves to reclaimable on BOTH the loom path and the session path", () => {
    const TTL = 30_000;
    const WRITTEN_AT = 1_000_000;
    const LATER = WRITTEN_AT + TTL + 1;

    const loomRoot = looms.loomDir("L-stale");
    lease.writeLease(loomRoot, { pid: 99, token: "tok" }, () => WRITTEN_AT);
    sessions.writeSessionLease("sess-stale", { pid: 99, token: "tok" }, () => WRITTEN_AT);

    // Fresh on both while inside the ttl...
    expect(lease.leaseReclaim(lease.readLease(loomRoot), TTL, WRITTEN_AT + 1)).toBe("held");
    expect(sessions.sessionLeaseReclaim("sess-stale", TTL, WRITTEN_AT + 1)).toBe("held");

    // ...and reclaimable on both once it goes stale. Never a success value —
    // there is no success value to return.
    const loomOutcome = lease.leaseReclaim(lease.readLease(loomRoot), TTL, LATER);
    const sessionOutcome = sessions.sessionLeaseReclaim("sess-stale", TTL, LATER);
    expect(loomOutcome).toBe("reclaimable");
    expect(sessionOutcome).toBe("reclaimable");
    expect(loomOutcome).toBe(sessionOutcome); // one rule, both lifetimes
    for (const outcome of [loomOutcome, sessionOutcome]) {
      expect(lease.LEASE_RECLAIM_OUTCOMES).toContain(outcome);
      expect(outcome).not.toBe("done");
    }

    // An absent lease is reclaimable on both paths too, not an error and not a
    // success.
    expect(lease.leaseReclaim(lease.readLease(looms.loomDir("L-absent")), TTL, LATER)).toBe(
      "reclaimable",
    );
    expect(sessions.sessionLeaseReclaim("sess-absent", TTL, LATER)).toBe("reclaimable");
  });

  test("AC11 the downstream of a stale lease is at worst a false-positive failed — never an auto-done", () => {
    // The moat claim in full: a stale lease makes recovery treat the owner as
    // not-live, and the not-live reconciler is exhaustive over WorkUnitState and
    // can only ever yield resume / queued / halt / leave / skip.
    const outcomes = new Set(
      schemas.WorkUnitState.options.map((s) => recover.reconcileState(s)),
    );
    expect([...outcomes].sort()).toEqual(["halt", "leave", "queued", "resume", "skip"]);
    expect([...outcomes]).not.toContain("done");
  });
});

// ── The compile-time half of AC11.3 ────────────────────────────────────────
// packages/core/tsconfig.json is `include: ["src"], exclude: ["test"]`, so
// `bunx tsc --noEmit` in this workspace never sees this file. A structural claim
// about a TYPE therefore has to be proved by running the compiler. Same harness
// as event-bus.test.ts's AC1 proof; duplicated deliberately — every file in
// packages/core/test/ is a self-contained `.test.ts` and this dir has never held
// a helper module.
const CORE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_TSC = path.join(CORE_ROOT, "node_modules", "typescript", "bin", "tsc");
const LEASE_MODULE = path.join(CORE_ROOT, "src", "runner", "lease");

const typecheck = (source: string): { ok: boolean; output: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-lease-compile-"));
  try {
    const file = path.join(dir, "fixture.ts");
    fs.writeFileSync(
      file,
      `import { LEASE_RECLAIM_OUTCOMES, type LeaseReclaim } from ${JSON.stringify(LEASE_MODULE)};\n` +
        `void LEASE_RECLAIM_OUTCOMES;\n${source}\n`,
    );
    // Run the compiler through THIS runtime: node_modules/.bin/tsc is a
    // `#!/usr/bin/env node` shim and this repo is bun-only. cwd is pinned to
    // packages/core so `--types node` resolves from its node_modules —
    // runner/lease.ts imports node:fs, so the fixture's program needs them.
    const out = spawnSync(
      process.execPath,
      [
        REPO_TSC,
        "--noEmit",
        "--ignoreConfig",
        "--strict",
        "--target",
        "es2022",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
        "--types",
        "node",
        file,
      ],
      { encoding: "utf8", cwd: CORE_ROOT },
    );
    return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("AC11.3 — the union is pinned against the compiler, not just against behavior", () => {
  test("AC11 `done` is NOT assignable to LeaseReclaim — the moat, checked by tsc", () => {
    const r = typecheck(`const x: LeaseReclaim = "done";\nvoid x;`);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("LeaseReclaim");
    expect(r.output).toContain('"done"');
  });

  test("AC11 the union is EXACTLY held | reclaimable — no member may be added without failing here", () => {
    // A type-level equality assertion, so widening the union (with `done`, or
    // with anything at all) breaks this compile even if every runtime test still
    // passes. `Equal` is the standard conditional-type identity trick.
    const r = typecheck(
      [
        `type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;`,
        `type Expect<T extends true> = T;`,
        `type _Pinned = Expect<Equal<LeaseReclaim, "held" | "reclaimable">>;`,
        `const outcomes: Array<"held" | "reclaimable"> = [...LEASE_RECLAIM_OUTCOMES];`,
        `void outcomes;`,
      ].join("\n"),
    );
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
    // A tsc SPAWN, against bun's 5 s default on the loaded CI Mac mini (#458).
    // Same explicit budget as workspace-store.test.ts's AC9 proofs rather than
    // the suite's 20 s ceiling: a cold compiler is the slowest thing this file
    // does, and its budget should say so out loud.
  }, 60_000);

  test("AC11 the compile pin DISCRIMINATES — a wrong expectation really does fail", () => {
    // Without this, a fixture that silently stopped compiling anything would
    // read as a passing structural proof.
    const r = typecheck(
      [
        `type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;`,
        `type Expect<T extends true> = T;`,
        `type _Wrong = Expect<Equal<LeaseReclaim, "held" | "reclaimable" | "done">>;`,
      ].join("\n"),
    );
    expect(r.ok).toBe(false);
  });
});
