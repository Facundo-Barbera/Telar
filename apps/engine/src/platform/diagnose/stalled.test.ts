import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STALLED_AFTER_MS } from "@telar/engine-client";
import { EngineStore } from "../../state";
import { DiagnoseError, executionDatabase, scanStalled } from "./stalled";
import { runDiagnose } from "./main";

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

function fixture() {
  let now = START;
  const root = tmp("telar-diagnose-");
  const store = new EngineStore(root, () => now);
  stores.push(store);
  const project = store.projectRegistry.register({ name: "aurora", root: tmp("telar-diagnose-project-") });
  const session = (title: string) => store.lifecycle.createSession({ projectId: project.id, envMode: "local", title }).id;

  const stranded = session("stranded");
  store.intake.submitTurn(stranded, { runId: "run_stranded", input: "start" });

  const start = (sessionId: string, runId: string, workerId: string) => {
    const claim = store.claims.claimTurn(sessionId, workerId)!;
    store.turnLifecycle.markRunning(sessionId, runId, claim.claim!.token);
    return claim.claim!.token;
  };

  const wedged = session("wedged");
  store.intake.submitTurn(wedged, { runId: "run_wedged", input: "start" });
  start(wedged, "run_wedged", "worker_one");

  const finished = session("finished");
  store.intake.submitTurn(finished, { runId: "run_finished", input: "start" });
  const finishedToken = start(finished, "run_finished", "worker_two");
  store.turnLifecycle.completeTurn(finished, "run_finished", finishedToken, { text: "done" });

  now += STALLED_AFTER_MS * 2;

  const healthy = session("healthy");
  store.intake.submitTurn(healthy, { runId: "run_healthy", input: "start" });
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
  expect(runIds(scan)).not.toContain("run_finished");
  expect(runIds(scan)).not.toContain("run_healthy");
  expect(scan.runsExamined).toBe(4);
});

test("each run is classified by what it got as far as, and carries how long it has been silent", () => {
  const { root, scannedAt, ids } = fixture();
  const scan = scanStalled({ engineRoot: root, now: () => scannedAt });

  const stranded = scan.runs.find((run) => run.runId === "run_stranded")!;
  expect(stranded.kind).toBe("never_claimed");
  expect(stranded.sessionId).toBe(ids.stranded);
  expect(stranded.silentForMs).toBe(scannedAt - START);

  const wedged = scan.runs.find((run) => run.runId === "run_wedged")!;
  expect(wedged.kind).toBe("no_progress");
  expect(wedged.sessionId).toBe(ids.wedged);
  expect(wedged.lastRecordAt).toBe(START);
});

test("the threshold decides, and a shorter one catches the healthy turn too", () => {
  const { root, scannedAt } = fixture();
  const eager = scanStalled({ engineRoot: root, now: () => scannedAt, thresholdMs: 30_000 });
  expect(runIds(eager)).toContain("run_healthy");
  expect(eager.counts.noProgress).toBe(2);
  expect(eager.thresholdMs).toBe(30_000);
  const patient = scanStalled({ engineRoot: root, now: () => scannedAt, thresholdMs: STALLED_AFTER_MS * 100 });
  expect(patient.runs).toEqual([]);
  expect(patient.runsExamined).toBe(4);
});

test("it reports ids and times and never a word anybody wrote", () => {
  const { root, scannedAt } = fixture();
  const scan = scanStalled({ engineRoot: root, now: () => scannedAt });
  const printed = JSON.stringify(scan);
  for (const secret of ["stranded", "wedged", "healthy", "aurora", "start", "done"]) {
    expect(printed.includes(`"${secret}"`)).toBe(false);
  }
  for (const run of scan.runs) {
    expect(Object.keys(run).sort()).toEqual(["kind", "lastRecordAt", "runId", "sessionId", "silentForMs"]);
  }
});

test("the database is opened read-only: the scan cannot change what it read", () => {
  const { root, scannedAt } = fixture();
  const file = executionDatabase(root);
  const before = fs.readFileSync(file);
  scanStalled({ engineRoot: root, now: () => scannedAt });
  expect(fs.readFileSync(file).equals(before)).toBe(true);
});

test("the command needs an explicit root and refuses a store it cannot read", () => {
  const { root, scannedAt } = fixture();
  const answer = JSON.parse(runDiagnose(["stalled", "--root", root, "--minutes", "1"])) as {
    counts: { neverClaimed: number; noProgress: number };
    thresholdMs: number;
  };
  expect(answer.thresholdMs).toBe(60_000);
  expect(answer.counts.neverClaimed + answer.counts.noProgress).toBe(3);
  void scannedAt;

  const empty = tmp("telar-diagnose-empty-");
  expect(() => runDiagnose(["stalled", "--root", empty])).toThrow(executionDatabase(empty));
  expect(() => runDiagnose(["stalled", "--root", root, "--minutes", "0"])).toThrow("positive");
  expect(() => runDiagnose(["wedged", "--root", root])).toThrow(DiagnoseError);
});
