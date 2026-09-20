/**
 * A SAFE COPY OF THE STORE — issue #665.
 *
 * ══ WHY THE ABSENCE OF THIS WAS ITSELF A FINDING ══
 *
 * There was no sanctioned way to look at a store without opening the live one.
 * The only read paths were a size walk and a hand-run `sqlite3 -readonly`
 * snippet pasted into an issue, so every question of the form "what is actually
 * in there" became either a manual query against the one irreplaceable artifact
 * or an estimate — which is what happened in #646 and #658, and why #646's own
 * figures had to be corrected twice.
 *
 * ══ WHAT EACH TEST BELOW IS ACTUALLY HOLDING ══
 *
 *   - the copy OPENS, and holds the same conversations. A copy that opens and
 *     is WRONG is worse than one that refuses, which is why this reads the
 *     copy back through a real `EngineStore` rather than comparing file sizes.
 *   - the ORIGINAL is untouched — no compaction, no watermark, no vacuum. A
 *     "get me a safe copy" that quietly rewrote the source would be the
 *     opposite of the point.
 *   - the reproducible tier is NOT carried, and that is named rather than
 *     inferred from a size: on a real machine `worktrees/` is 59 checkouts and
 *     tens of gigabytes, and a copy that took minutes is a button nobody
 *     presses.
 *   - the destination MUST NOT EXIST. The one thing here that could destroy
 *     anything is writing over a folder somebody named by mistake.
 *   - the copy is 0600. `VACUUM INTO` creates its file with the process umask,
 *     which on a default macOS account is 0644 — a world-readable copy of
 *     every conversation on the machine, made by the button whose whole purpose
 *     is to be the safe way to do this.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.closeExecutionStore(); } catch { /* already closed */ } }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const START = Date.parse("2026-01-01T00:00:00Z");

function scene(): { home: string; store: EngineStore } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-copy-"));
  homes.push(home);
  const store = new EngineStore(home, () => START, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "one", root: "/tmp" });
  store.createSession({ id: "session_one", projectId: "project_one" });
  store.submitTurn("session_one", { runId: "run_one", input: "what is in there" });
  const token = store.claimTurn("session_one", "worker_one")!.claim!.token;
  store.markRunning("session_one", "run_one", token);
  store.completeTurn("session_one", "run_one", token, { text: "this, and it can be read" });
  return { home, store };
}

test("the copy opens, and holds the conversation the original holds", () => {
  const { home, store } = scene();
  const destination = path.join(home, "..", `telar-copy-${Date.now()}`);
  homes.push(destination);
  const copy = store.copyStoreTo(destination);
  expect(copy.root).toBe(destination);
  expect(copy.files).toBeGreaterThan(1);
  expect(copy.bytes).toBeGreaterThan(0);

  /**
   * READ BACK THROUGH A REAL STORE, not compared as bytes. A `cp` of a live
   * database produces a file whose pages come from different moments and whose
   * `-wal` is not beside it — it opens, and it is wrong. `VACUUM INTO` is what
   * makes this assertion possible, and this assertion is what holds it there.
   */
  const opened = new EngineStore(destination, () => START, { executionStorage: "sqlite" });
  stores.push(opened);
  expect(opened.getSession("session_one").id).toBe("session_one");
  expect(opened.turns("session_one")[0]?.input).toBe("what is in there");
  expect(opened.readEvents("session_one").length).toBe(store.readEvents("session_one").length);
  expect(opened.listProjects().map((project) => project.id)).toEqual(["project_one"]);
});

test("the copy is 0600, and no `-wal` travels beside it", () => {
  const { home, store } = scene();
  const destination = path.join(home, "..", `telar-copy-mode-${Date.now()}`);
  homes.push(destination);
  store.copyStoreTo(destination);
  expect(fs.statSync(path.join(destination, "execution.sqlite")).mode & 0o777).toBe(0o600);
  // A log beside a vacuumed database is a log that describes a different file.
  expect(fs.existsSync(path.join(destination, "execution.sqlite-wal"))).toBe(false);
  expect(fs.existsSync(path.join(destination, "execution.sqlite-shm"))).toBe(false);
});

test("the reproducible tier is not carried, and neither is the live daemon's lock", () => {
  const { home, store } = scene();
  // Each of these is real on a live store: checkouts, a Python environment, a
  // toolchain, and the lock naming the daemon that holds it.
  for (const directory of ["worktrees", "python", "tools"]) {
    fs.mkdirSync(path.join(home, directory, "deep"), { recursive: true });
    fs.writeFileSync(path.join(home, directory, "deep", "big"), "x".repeat(4096));
  }
  fs.writeFileSync(path.join(home, "engine.lock"), JSON.stringify({ host: "somewhere", pid: 1 }));
  fs.mkdirSync(path.join(home, "notes"), { recursive: true });
  fs.writeFileSync(path.join(home, "notes", "kept.json"), JSON.stringify({ note: "irreplaceable" }));

  const destination = path.join(home, "..", `telar-copy-tiers-${Date.now()}`);
  homes.push(destination);
  store.copyStoreTo(destination);
  for (const skipped of ["worktrees", "python", "tools", "engine.lock", "execution.sqlite-wal"]) {
    expect(fs.existsSync(path.join(destination, skipped))).toBe(false);
  }
  // …and the irreplaceable tier IS carried, which is the other half: a copy
  // that skipped everything would pass the assertion above.
  expect(JSON.parse(fs.readFileSync(path.join(destination, "notes", "kept.json"), "utf8"))).toEqual({ note: "irreplaceable" });
  expect(fs.existsSync(path.join(destination, "projects.json"))).toBe(true);
});

test("the original is not touched — no vacuum, no compaction, no watermark", () => {
  const { home, store } = scene();
  const file = path.join(home, "execution.sqlite");
  const before = { size: fs.statSync(file).size, events: store.readEvents("session_one").length };
  const destination = path.join(home, "..", `telar-copy-readonly-${Date.now()}`);
  homes.push(destination);
  store.copyStoreTo(destination);
  /**
   * A COPY THAT REWROTE ITS SOURCE would be the opposite of the point — and it
   * is the shape a naive implementation takes, because the in-place `VACUUM`
   * is the first thing anyone reaches for. `VACUUM INTO` takes a read
   * transaction and writes elsewhere; the source file is not rewritten, so its
   * size does not move.
   */
  expect(fs.statSync(file).size).toBe(before.size);
  expect(store.readEvents("session_one").length).toBe(before.events);
});

test("a destination that already exists is refused rather than written into", () => {
  const { home, store } = scene();
  const destination = path.join(home, "..", `telar-copy-exists-${Date.now()}`);
  homes.push(destination);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "somebody-elses-work"), "do not overwrite me");
  expect(() => store.copyStoreTo(destination)).toThrow(/already exists/);
  // And it really left it alone, rather than refusing after doing half the job.
  expect(fs.readdirSync(destination)).toEqual(["somebody-elses-work"]);
});

test("a relative destination is not a destination", () => {
  const { store } = scene();
  expect(() => store.copyStoreTo("somewhere/relative")).toThrow(/absolute/);
});
