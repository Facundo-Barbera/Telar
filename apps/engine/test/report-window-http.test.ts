/**
 * THE CADENCE OVER THE REAL WIRE — what a PERSON's surface can see, issue #723.
 *
 * `report-window.test.ts` proves the mechanism: routine reports are held, merged
 * and delivered on a clock. It proves it against the store, which is the right
 * altitude for a delivery rule and the wrong one for this question — because the
 * half that was missing when the mechanism landed was not behaviour, it was
 * VISIBILITY. A window existed as a field an agent could set on itself, and no
 * route answered "is one set, and what is it holding right now".
 *
 * SO THESE TESTS ARE ABOUT ONE ROUTE AND BOTH ITS NUMBERS. A control that could
 * only show the setting would make a held report look exactly like a lost one —
 * which is the bug #631 part 2 fixed, and the one this feature is most able to
 * reintroduce.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-window-http-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A coordinator, a worker, and a live claim on the worker — the proof an agent
 *  message is attributed from. */
async function ready() {
  const daemon = await startEngine({ models: stubModels, engineRoot: root() });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_one", name: "One", root: root() });
  await client.createSession({ id: "session_coord", projectId: "project_one" });
  await client.createSession({ id: "session_worker", projectId: "project_one" });
  const store = daemon.store;
  store.submitTurn("session_worker", { runId: "run_source", input: "work" });
  const claimToken = store.claimTurn("session_worker", "worker_one")!.claim!.token;
  store.markRunning("session_worker", "run_source", claimToken);
  return { client, store, proof: { sessionId: "session_worker", runId: "run_source", claimToken } };
}

const report = (store: EngineDaemon["store"], proof: Parameters<EngineDaemon["store"]["submitAgentTurn"]>[2], runId: string) =>
  store.submitAgentTurn("session_coord", { runId, input: "progress", intent: "report" }, proof);

test("a session with no window says so, rather than saying nothing", async () => {
  const { client } = await ready();
  // `null`, not an absent key: a surface reading this has to be able to draw
  // "as they arrive" from the answer itself, without inferring it from silence.
  expect(await client.sessionReportWindow("session_coord")).toEqual({ reportWindowMinutes: null, held: 0 });
});

test("the window a session was given is the window the route reports", async () => {
  const { client } = await ready();
  await client.setSessionReportWindow("session_coord", 25);
  expect(await client.sessionReportWindow("session_coord")).toEqual({ reportWindowMinutes: 25, held: 0 });
});

test("what the window is HOLDING is counted, which is the half no other route could answer", async () => {
  const { client, store, proof } = await ready();
  await client.setSessionReportWindow("session_coord", 25);

  // Two routine reports at an IDLE coordinator. Without a window each would
  // have woken it on arrival; with one they go to the mailbox instead.
  report(store, proof, "run_one");
  report(store, proof, "run_two");

  expect(await client.sessionReportWindow("session_coord")).toEqual({ reportWindowMinutes: 25, held: 2 });
});

test("turning the window off does not deliver what is held, and the count says so", async () => {
  const { client, store, proof } = await ready();
  await client.setSessionReportWindow("session_coord", 25);
  report(store, proof, "run_one");

  // The store is deliberate about this: adjusting a cadence must not hand the
  // session a turn it did not ask for, at the moment a person was configuring
  // it. What was held stays held until the next drain — so a surface that
  // claimed "0 held" the instant the window came off would be wrong about
  // exactly the mail this control exists to account for.
  await client.setSessionReportWindow("session_coord", null);
  expect(await client.sessionReportWindow("session_coord")).toEqual({ reportWindowMinutes: null, held: 1 });
});

test("a window the contract refuses is refused over the wire too", async () => {
  const { client } = await ready();
  await expect(client.setSessionReportWindow("session_coord", 0)).rejects.toThrow();
  await expect(client.setSessionReportWindow("session_coord", 24 * 60 + 1)).rejects.toThrow();
  // And the session is untouched by either attempt.
  expect(await client.sessionReportWindow("session_coord")).toEqual({ reportWindowMinutes: null, held: 0 });
});
