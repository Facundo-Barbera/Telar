/**
 * THE COMPUTER-USE ROUTE, AGAINST A REAL DAEMON AND A STUB GATE.
 *
 * `computer-use.test.ts` covers the gate. This covers the wiring: the GET is
 * answered by the daemon's gate — so reading the pane IS measuring, and the
 * answer is what the next claim is decided by — and the Sky host wake is gone.
 *
 * NOTHING IS PROBED: the gate is injected, so this machine's cua-driver is
 * never spawned.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputerUseGrant, ComputerUseStatus } from "@telar/engine-client";
import { EngineClient } from "@telar/engine-client";
import type { ComputerUseGate } from "../src/computer-use";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const GRANTED: ComputerUseStatus = { installed: true, backend: "cua", hostRunning: true, permission: "granted" };

async function engine(
  resetComputerUse?: () => Promise<{ reset: boolean; message?: string }>,
  grantComputerUse?: () => Promise<ComputerUseGrant>,
): Promise<{ daemon: EngineDaemon; measured: () => number }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-computer-use-"));
  roots.push(directory);
  let measures = 0;
  const computerUseGate: ComputerUseGate = {
    last: () => undefined,
    measure: async () => {
      measures += 1;
      return GRANTED;
    },
    forClaim: () => undefined,
    measureIfHostRunning: async () => undefined,
  };
  const daemon = await startEngine({ models: stubModels, engineRoot: directory, computerUseGate, ...(resetComputerUse ? { resetComputerUse } : {}), ...(grantComputerUse ? { grantComputerUse } : {}) });
  daemons.push(daemon);
  return { daemon, measured: () => measures };
}

test("GET /v2/computer-use is answered by the daemon's gate", async () => {
  const { daemon, measured } = await engine();
  const before = measured();
  expect(await new EngineClient(daemon.discovery).computerUseStatus()).toEqual({ computerUse: GRANTED });
  expect(measured()).toBe(before + 1);
});

test("POST /v2/computer-use/host is no longer a route", async () => {
  const { daemon } = await engine();
  const response = await fetch(`http://${daemon.discovery.host}:${daemon.discovery.port}/v2/computer-use/host`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(404);
});

test("POST /v2/computer-use/reset resets, then re-measures so the gate stops handing out the tools", async () => {
  let resets = 0;
  const { daemon, measured } = await engine(async () => ((resets += 1), { reset: true }));
  const before = measured();
  expect(await new EngineClient(daemon.discovery).resetComputerUseAccess()).toEqual({ reset: true });
  expect(resets).toBe(1);
  expect(measured()).toBe(before + 1);
});

test("a reset that did nothing does not re-measure", async () => {
  const { daemon, measured } = await engine(async () => ({ reset: false, message: "no helper" }));
  const before = measured();
  expect(await new EngineClient(daemon.discovery).resetComputerUseAccess()).toEqual({ reset: false, message: "no helper" });
  expect(measured()).toBe(before);
});

test("POST /v2/computer-use/grant answers what each step did — a failure is said, not swallowed", async () => {
  const outcome: ComputerUseGrant = { started: true, backend: "cua", daemon: false, prompted: false, opened: "accessibility", message: "The computer-use helper did not start." };
  const { daemon } = await engine(undefined, async () => outcome);
  expect(await new EngineClient(daemon.discovery).grantComputerUseAccess()).toEqual(outcome);
});
