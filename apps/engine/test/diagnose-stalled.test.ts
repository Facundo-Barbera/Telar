/**
 * `telar diagnose stalled` — issue #813's frequency question, as a command.
 *
 * ══ EVERY TEST HERE BUILDS ITS OWN STORE IN A TEMP DIRECTORY ══
 *
 * Nothing in this file reads, copies or names the store under `~/Library`. The
 * fixtures are made by driving a real `EngineStore` through the real paths —
 * submit, claim, start, complete — so what the scan reads is the journal the
 * engine actually writes, not a hand-written table that agrees with the query.
 *
 * ══ AND THE ASSERTIONS ARE COUNTS AND RUN IDS ══
 *
 * Never the shape of the JSON and never a message: a scan that reported the
 * right number of the wrong runs would pass a count-only test, so every case
 * below also names which runs it expected and which it did not.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STALLED_AFTER_MS } from "@telar/engine-client";
import { EngineStore } from "../src/state";
import { DiagnoseError, executionDatabase, scanStalled } from "../src/diagnose";
import { runDiagnose } from "../src/diagnose-main";

const roots: string[] = [];
const stores: EngineStore[] = [];

const tmp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const START = 1_000_000;

/**
 * A store on its own temp root with four runs in four different shapes, built
 * through the store's real transitions on an injected clock.
 *
 * The clock is advanced BETWEEN the runs, so each one's newest record sits at a
 * known instant and "how long has this been silent" is a subtraction rather
 * than a guess. The store is closed before the scan reads it — sqlite's WAL
 * means an unflushed journal would otherwise make this a test of buffering.
 */
function fixture() {
  let now = START;
  const root = tmp("telar-diagnose-");
  const store = new EngineStore(root, () => now, { executionStorage: "sqlite" });
  stores.push(store);
  const project = store.registerProject({ name: "aurora", root: tmp("telar-diagnose-project-") });
  const session = (title: string) => store.createSession({ projectId: project.id, envMode: "local", title }).id;

  // 1 — accepted long ago and never claimed. #813's occurrence A.
  const stranded = session("stranded");
  store.submitTurn(stranded, { runId: "run_stranded", input: "start" });

  /**
   * `claimTurn`, NOT `claimNextTurn`, and it matters: the scan picks the
   * oldest ACCEPTED turn across every session, so a fixture built with it
   * would hand this worker the stranded run above and produce a store with
   * none of the shapes it meant to make.
   */
  const start = (sessionId: string, runId: string, workerId: string) => {
    const claim = store.claimTurn(sessionId, workerId)!;
    store.markRunning(sessionId, runId, claim.claim!.token);
    return claim.claim!.token;
  };

  // 2 — started long ago, never ended, silent ever since.
  const wedged = session("wedged");
  store.submitTurn(wedged, { runId: "run_wedged", input: "start" });
  start(wedged, "run_wedged", "worker_one");

  // 3 — ran and finished. Never in any answer, however long ago it was.
  const finished = session("finished");
  store.submitTurn(finished, { runId: "run_finished", input: "start" });
  const finishedToken = start(finished, "run_finished", "worker_two");
  store.completeTurn(finished, "run_finished", finishedToken, { text: "done" });

  // Everything above is now old. What follows is recent.
  now += STALLED_AFTER_MS * 2;

  // 4 — started a moment ago and still going. The healthy long turn #813's
  // second occurrence actually was, and the one a bad scan reports.
  const healthy = session("healthy");
  store.submitTurn(healthy, { runId: "run_healthy", input: "start" });
  start(healthy, "run_healthy", "worker_three");

  const scannedAt = now + 60_000;
  store.closeExecutionStore();
  stores.splice(stores.indexOf(store), 1);
  return { root, scannedAt, ids: { stranded, wedged, finished, healthy } };
}

const runIds = (scan: { runs: Array<{ runId: string }> }) => scan.runs.map((run) => run.runId);

test("the scan names a stranded run and a wedged one, and neither the finished nor the healthy turn", () => {
  const { root, scannedAt } = fixture();
  const scan = scanStalled({ engineRoot: root, now: () => scannedAt });

  expect(scan.counts).toEqual({ neverClaimed: 1, noProgress: 1 });
  expect(runIds(scan).sort()).toEqual(["run_stranded", "run_wedged"]);
  // NOT the finished one, however old: it ended, and an ending is an answer.
  expect(runIds(scan)).not.toContain("run_finished");
  // NOT the healthy one, which is the assertion that matters — a turn running
  // for a minute is not a turn that has stopped, and reporting it is #813's
  // second occurrence repeated by machine.
  expect(runIds(scan)).not.toContain("run_healthy");
  // Non-vacuity: it looked at every run, not only the two it reported.
  expect(scan.runsExamined).toBe(4);
});

test("each run is classified by what it got as far as, and carries how long it has been silent", () => {
  const { root, scannedAt, ids } = fixture();
  const scan = scanStalled({ engineRoot: root, now: () => scannedAt });

  const stranded = scan.runs.find((run) => run.runId === "run_stranded")!;
  expect(stranded.kind).toBe("never_claimed");
  expect(stranded.sessionId).toBe(ids.stranded);
  // Accepted at START and silent since: the fixture advanced the clock by twice
  // the threshold and then a further minute before scanning.
  expect(stranded.silentForMs).toBe(scannedAt - START);

  const wedged = scan.runs.find((run) => run.runId === "run_wedged")!;
  expect(wedged.kind).toBe("no_progress");
  expect(wedged.sessionId).toBe(ids.wedged);
  expect(wedged.lastRecordAt).toBe(START);
});

test("the threshold decides, and a shorter one catches the healthy turn too", () => {
  const { root, scannedAt } = fixture();
  // Thirty seconds, against a turn that started sixty seconds before the scan.
  // The SAME store, so this is the threshold moving and nothing else.
  const eager = scanStalled({ engineRoot: root, now: () => scannedAt, thresholdMs: 30_000 });
  expect(runIds(eager)).toContain("run_healthy");
  expect(eager.counts.noProgress).toBe(2);
  expect(eager.thresholdMs).toBe(30_000);
  // And a threshold nothing can clear reports nothing, rather than everything.
  const patient = scanStalled({ engineRoot: root, now: () => scannedAt, thresholdMs: STALLED_AFTER_MS * 100 });
  expect(patient.runs).toEqual([]);
  expect(patient.runsExamined).toBe(4);
});

test("it reports ids and times and never a word anybody wrote", () => {
  const { root, scannedAt } = fixture();
  const scan = scanStalled({ engineRoot: root, now: () => scannedAt });
  const printed = JSON.stringify(scan);
  // The fixture's titles and message bodies are in the store it just read.
  for (const secret of ["stranded", "wedged", "healthy", "aurora", "start", "done"]) {
    expect(printed.includes(`"${secret}"`)).toBe(false);
  }
  // Every key of every run is an id, a kind or a number.
  for (const run of scan.runs) {
    expect(Object.keys(run).sort()).toEqual(["kind", "lastRecordAt", "runId", "sessionId", "silentForMs"]);
  }
});

test("the database is opened read-only: the scan cannot change what it read", () => {
  const { root, scannedAt } = fixture();
  const file = executionDatabase(root);
  const before = fs.readFileSync(file);
  scanStalled({ engineRoot: root, now: () => scannedAt });
  // Byte-for-byte. A scan that took the daemon's own open path would have
  // migrated, reconciled and swept on the way in, and this would differ.
  expect(fs.readFileSync(file).equals(before)).toBe(true);
});

test("the command needs an explicit root and refuses a store it cannot read", () => {
  const { root, scannedAt } = fixture();
  const answer = JSON.parse(runDiagnose(["stalled", "--root", root, "--minutes", "1"])) as {
    counts: { neverClaimed: number; noProgress: number };
    thresholdMs: number;
  };
  expect(answer.thresholdMs).toBe(60_000);
  // A one-minute threshold against this fixture catches all three unfinished
  // runs — so the CLI is passing its argument through rather than ignoring it.
  expect(answer.counts.neverClaimed + answer.counts.noProgress).toBe(3);
  void scannedAt;

  // A directory with no journal refuses by NAMING the file it wanted, rather
  // than answering "no stalled runs" about a store it never opened.
  const empty = tmp("telar-diagnose-empty-");
  expect(() => runDiagnose(["stalled", "--root", empty])).toThrow(executionDatabase(empty));
  expect(() => runDiagnose(["stalled", "--root", root, "--minutes", "0"])).toThrow("positive");
  expect(() => runDiagnose(["wedged", "--root", root])).toThrow(DiagnoseError);
});
