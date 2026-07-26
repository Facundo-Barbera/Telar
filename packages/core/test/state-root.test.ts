// State-root resolution under a hostile TELAR_HOME (CAP-1).
//
// The core resolvers only — manifest.ts's telarDir() and looms.ts's private
// telarDir(), observed through loomDir(). The apps/web resolvers carry the same
// guard and are pinned over there — store.ts's stateRoot() in
// apps/web/lib/store.test.ts, permissions.ts's telarHome() and session-log.ts's
// home() in apps/web/lib/state-root.test.ts; none of the three can be reached
// from here.
//
// WHY EVERY ASSERTION IS A STRING COMPARISON AND NOTHING IS EVER WRITTEN: with
// the guard in place an empty or unset TELAR_HOME resolves to the REAL
// ~/.telar, and no test may touch that. The un-guarded root cannot be probed
// by writing either — measured, with root "": mkdirSync("", { recursive: true })
// throws ENOENT, so the ledger and chats writers CRASH, while looms.ts's
// loomsDir() is the non-empty RELATIVE path "looms" and mkdirSync SUCCEEDS, so
// a loom's whole sandbox lands under <cwd>/looms/<id> with no error at all.
// The resolved string is the one thing common to both halves of that split, so
// it is the thing to pin.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Whatever root was in effect when this file loaded. bun test runs every file
// in ONE process, so a suite that re-points TELAR_HOME and does not put it back
// silently re-roots every suite that runs after it.
const ORIGINAL = process.env.TELAR_HOME;
const restore = () => {
  if (ORIGINAL === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL;
};
afterEach(restore);
afterAll(restore);

// `await import` rather than a static import: this suite deliberately does NOT
// pin a root at module scope (varying it IS the subject), so it must not depend
// on import order either. It matches the settled repo idiom (weave.test.ts).
const { telarDir } = await import("../src/manifest");
const { loomDir } = await import("../src/looms");

const HOME_DEFAULT = path.join(os.homedir(), ".telar");

describe("state root resolution (CAP-1)", () => {
  test("an EMPTY TELAR_HOME resolves to the home default, never to the cwd", () => {
    // `??` falls back on null/undefined but NOT on "", and an exported-but-empty
    // `TELAR_HOME=` is routine in shell scripts and CI — `export TELAR_HOME=`,
    // a `TELAR_HOME=${SOMETHING_UNSET}` expansion, an env block with an empty
    // value. Whitespace-only is in the loop because the guard TRIMS: it is the
    // same mistake with an invisible payload.
    // The exact path an un-guarded root would have produced in the cwd.
    // Snapshotted rather than asserted absent outright, so an unrelated
    // directory that already happens to sit there cannot fail this.
    const loomsInCwd = path.join(process.cwd(), "looms");
    const loomsInCwdBefore = fs.existsSync(loomsInCwd);
    for (const empty of ["", "   ", "\t", "\n"]) {
      process.env.TELAR_HOME = empty;
      expect(telarDir()).toBe(HOME_DEFAULT);
      expect(loomDir("L1")).toBe(path.join(HOME_DEFAULT, "looms", "L1"));
      // The specific harm, stated positively: neither resolver may produce a
      // path under the process's cwd. Un-guarded, telarDir() returned "" and
      // loomDir("L1") returned the relative "looms/L1".
      expect(path.isAbsolute(telarDir())).toBe(true);
      expect(path.isAbsolute(loomDir("L1"))).toBe(true);
      expect(loomDir("L1").startsWith(process.cwd() + path.sep)).toBe(false);
    }
    // Resolving is a pure computation; nothing may be created as a side effect.
    expect(fs.existsSync(loomsInCwd)).toBe(loomsInCwdBefore);
  });

  test("an UNSET TELAR_HOME still resolves to <homedir>/.telar", () => {
    // AC2: with TELAR_HOME unset, behavior is identical to before the guard.
    // Asserted as a string — os.homedir() under Bun is resolved at process
    // start and ignores a later process.env.HOME write, so a fake home cannot
    // be installed in-process.
    delete process.env.TELAR_HOME;
    expect(telarDir()).toBe(HOME_DEFAULT);
    expect(loomDir("L1")).toBe(path.join(HOME_DEFAULT, "looms", "L1"));
  });

  test("a RELATIVE TELAR_HOME resolves to an absolute path", () => {
    // THE DESIGN CALL, pinned so it is a decision rather than an accident: a
    // relative root is RESOLVED, not refused. path.resolve does not lift the
    // root out of the cwd — it freezes it at the call instead of leaving a
    // fragment that every later caller re-interprets against its own,
    // possibly chdir'd, cwd. Refusing outright is the stronger guarantee and
    // is an open call for the human; if it is taken, this becomes a toThrow.
    process.env.TELAR_HOME = "telar-relative-root";
    expect(path.isAbsolute(telarDir())).toBe(true);
    expect(telarDir()).toBe(path.resolve("telar-relative-root"));
    expect(loomDir("L1")).toBe(path.join(path.resolve("telar-relative-root"), "looms", "L1"));

    // "." and ".." are relative too, and are the shapes most likely to arrive
    // from a hand-written script. They must normalize, not be pasted into a
    // join as a literal segment.
    process.env.TELAR_HOME = "./nested/../telar-relative-root";
    expect(telarDir()).toBe(path.resolve("telar-relative-root"));
  });

  test("an ABSOLUTE TELAR_HOME is passed through unchanged", () => {
    // The no-regression half. path.resolve is purely LEXICAL — it does not
    // follow symlinks — so on macOS an fs.mkdtempSync(os.tmpdir()) path
    // (/var/folders/… , itself a symlink to /private/var/folders/…) comes back
    // byte-identical. This is what keeps manifest.test.ts's
    // `expect(telarDir()).toBe(home)` and store.test.ts's
    // `expect(store.stateRoot()).toBe(TMP)` passing verbatim.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-state-root-"));
    try {
      process.env.TELAR_HOME = root;
      expect(telarDir()).toBe(root);
      expect(loomDir("L1")).toBe(path.join(root, "looms", "L1"));

      // Surrounding whitespace is stripped, not joined into the path. An
      // untrimmed "<root>\n" would produce a sibling directory whose name ends
      // in a newline — a state root that looks right in every log line and
      // matches nothing.
      process.env.TELAR_HOME = ` ${root}\n`;
      expect(telarDir()).toBe(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the two core resolvers agree on the same root for the same input", () => {
    // looms.ts keeps its own copy of the expression rather than importing
    // manifest.ts's telarDir — deliberately, since collapsing the five-way
    // duplication is separately tracked. This is the test that makes the two
    // copies drifting apart a failure instead of a silent split-brain in which
    // a loom's directory and the projects registry live under different roots.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-state-root-agree-"));
    try {
      for (const value of ["", "  ", "telar-relative-root", root]) {
        process.env.TELAR_HOME = value;
        expect(loomDir("L1")).toBe(path.join(telarDir(), "looms", "L1"));
      }
      delete process.env.TELAR_HOME;
      expect(loomDir("L1")).toBe(path.join(telarDir(), "looms", "L1"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
