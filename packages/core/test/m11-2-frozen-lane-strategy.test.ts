// M11.2 — frozenLaneVerify's strategy layer (non-server VerificationStrategies
// established inside the frozen worktree). Hermetic: a fake git runner, fake
// startLane/resolveServersConfig seams, injected signal/chooser seams, and —
// where the REAL runIntegrationVerify runs — an injected gateRunner (no real
// process, agent, git, DB, or browser). Asserts:
//   (1) LIBRARY strategy: GateResult evidence from the frozen worktree `wt`
//       with NO URL, NO startLane call, and the EXPLICIT noTarget marker on the
//       producer opts; verify-strategy event emitted
//   (2) fail-closed DEMOTE at the PRODUCER's effective target (not merely the
//       opts seam): with manifest.urls.dev deliberately stale and a critic stub
//       that would PASS, a non-server strategy's agent-judged leftover runs
//       ZERO critics (the noTarget marker withholds the producer's urls.dev
//       fallback → the no-target panel event fires) → panelRequired skip → the
//       M10.1 fullContract coercion demotes ("fail"), never a false green
//   (3) a strategy bring-up/selection THROW fail-closes to no-target under
//       failClosedLaneDown (verify-lane-down event, noTarget marker, no escape)
//   (4) defense-in-depth: a scripted NON-server strategy never calls startLane
//       even when a host-process config resolves (and carries the marker)
//   (5) teardown runs in finally for non-server strategies (worktree removed
//       even when the producer throws)
//   (6) SERVER strategy byte-identical to today: lane stood up, producer gets
//       url=laneTarget and NO noTarget marker; web shape keeps the
//       manifest.urls.dev fallback; no verify-strategy event on the server path
//   (7) flag-off (failClosedLaneDown absent) byte-identical: no seam is ever
//       consulted, no marker is sent, target falls back exactly as today, a
//       bring-up throw PROPAGATES (weave fail-open preserved)
//   (8) ARTIFACT-TIME ESTABLISHMENT (the deferred-gate hand-off): a SANCTIONED
//       synthesized all-live-critic contract (prompt fallback / the
//       human-answered manifest verifyCommand) is tightened in memory to
//       command gates executing the strategy's runnable — real exit-code
//       evidence, critic never invoked, red gate still demotes; an
//       UNSANCTIONED authored-prose contract is never tightened (case (2))
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m112lane-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { frozenLaneVerify } = await import("../src/verify-thread");
const { runIntegrationVerify } = await import("../src/executor");
const { createLoom } = await import("../src/looms");
const { writeBundleFile, writeContract } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");
import type { Loom } from "../src/looms";
import type { DeliverableSignal } from "../src/deliverable-signal";
import type { VerificationStrategy } from "../src/verification-strategy";
import type { Lane, ServiceHandle, ServersConfig, StartLaneOpts } from "../src/run-server";
import type { GitRunner } from "../src/vcs";
import type { Gate, GateResult } from "../src/gates";
import type { ContractAssertion, VerificationContract } from "../src/schemas";
import { ProjectManifest, ServersConfig as ServersConfigSchema } from "../src/schemas";

// --- fakes -------------------------------------------------------------------

function fakeGit(): { runner: GitRunner; args: string[][] } {
  const args: string[][] = [];
  const runner: GitRunner = (_root, a) => {
    args.push(a);
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, args };
}

const noneCfg = { driver: "none", services: {} } as unknown as ServersConfig;
const hostCfg = ServersConfigSchema.parse({
  driver: "host-process",
  services: { web: { command: "run web", portStrategy: "fixed", port: 5000 } },
});

function fakeLane(url = "http://localhost:5000"): { lane: Lane; stopCount: () => number } {
  let stops = 0;
  const handle = { name: "web", port: 5000, url, stop: async () => {} } as unknown as ServiceHandle;
  return {
    lane: { services: { web: handle }, stopAll: async () => void stops++ },
    stopCount: () => stops,
  };
}

const libSignal: DeliverableSignal = {
  plannable: true,
  shape: "library",
  strategy: "test-gate",
  run: "bun run test",
  reason: "package.json declares a test script",
};
const webSignal: DeliverableSignal = { plannable: false, shape: "web", reason: "dev script" };

const asrt = (over: Partial<ContractAssertion>): ContractAssertion => ({
  id: "x",
  description: "d",
  type: "command",
  blocker: true,
  ...over,
});

// A REAL project + loom + on-disk contract so the REAL runIntegrationVerify
// (and the default bundle readContract inside the strategy layer) both read it.
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m112lane-p-"));
createProject(projectRoot, { name: "pm112" });
// urls.dev is DELIBERATELY set: the non-server assertions below prove the
// strategy layer never falls back to this stale URL (fail-closed tightening).
const manifest = ProjectManifest.parse({
  name: "pm112",
  root: "/tmp/telar-m112lane-repo",
  urls: { dev: "http://stale-dev" },
  gates: [],
});

function rootLoom(contract: VerificationContract): Loom {
  const loom = createLoom({ project: "pm112", kind: "custom", title: "root", prompt: "build lib", account: "personal" });
  writeBundleFile(loom.id, "objective.md", "obj");
  writeContract(loom.id, contract);
  loom.baseSha = "deadbeef"; // pin the snapshot so the frozen worktree path runs
  return loom;
}

function fakeGates(ok = true) {
  const cwds: string[] = [];
  const runs: string[] = [];
  const gateRunner = async (gate: Gate, cwd: string): Promise<GateResult> => {
    cwds.push(cwd);
    runs.push(gate.run);
    return { name: gate.name, ok, exitCode: ok ? 0 : 1, output: "", durationMs: 1, timedOut: false };
  };
  return { gateRunner, cwds, runs };
}

// A critic-run SPY that would return a PASSING verdict if the panel ever ran —
// the seam a stale-target regression would false-green through. The no-target
// mechanism tests assert calls === 0: merely stubbing null would make the
// panel vacuous (skip) and mask a panel that RAN against a stale URL.
function passingCriticSpy() {
  const state = { calls: 0, prompts: [] as string[] };
  const run = (async (prompt: string) => {
    state.calls++;
    state.prompts.push(String(prompt));
    return { ok: true, summary: "looks great", findings: [], evidence: [] };
  }) as never;
  return { run, state };
}

// ── (1) library strategy: GateResult evidence from wt, no URL, no startLane ──
describe("(1) test-gate strategy — gates settle against the frozen worktree, no lane, no URL", () => {
  test("real producer: deterministic assertion runs in wt, panel gets no target, startLane never called", async () => {
    const loom = rootLoom({
      version: 1,
      assertions: [asrt({ id: "t1", expected: "bun run test", subGoalId: "ALL" })],
    });
    const git = fakeGit();
    const { gateRunner, cwds } = fakeGates(true);
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let captured: Record<string, unknown> = {};
    let startCalls = 0;

    const iv = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: (l, m, o) => (
        (captured = o), runIntegrationVerify(l, m, { ...o, gateRunner, run: (async () => null) as never })
      ),
      git: git.runner,
      resolveServersConfig: () => noneCfg,
      startLane: async () => (startCalls++, fakeLane().lane),
      failClosedLaneDown: true,
      deriveSignal: () => libSignal,
      emit: (ev) => events.push(ev),
    });

    // Evidence: a real GateResult from the deterministic gate — a genuine pass.
    expect(iv?.verification).toBe("pass");
    expect(iv?.gatesOk).toBe(true);
    expect(iv?.gates?.length).toBe(1);
    expect(iv?.gates?.[0]?.name).toBe("t1");
    // The gate ran against the FROZEN worktree, not manifest.root.
    expect(cwds.length).toBe(1);
    expect(cwds[0]).toBe(captured.verifyCwd as string);
    expect(cwds[0]).not.toBe(manifest.root);
    // NO URL: neither a lane target nor the stale manifest.urls.dev — and the
    // EXPLICIT noTarget marker is threaded so the producer's own urls.dev
    // fallback is withheld (omitting url alone would silently reinstate it).
    expect(captured.url).toBeUndefined();
    expect(captured.noTarget).toBe(true);
    // NO startLane call for a non-server strategy.
    expect(startCalls).toBe(0);
    // Observability: the strategy pick is on the event stream.
    const strat = events.find((e) => e.type === "verify-strategy");
    expect(strat?.strategy).toBe("test-gate");
    expect(events.some((e) => e.type === "verify-lane-down")).toBe(false);
    // Teardown: the worktree round-trip completed.
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "add")).toBe(true);
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true);
  });
});

// ── (2) fail-closed: agent-judged leftover + no target ⇒ DEMOTING fail ───────
describe("(2) a non-server strategy never false-greens an agent-judged slice", () => {
  test("PASSING critic + stale urls.dev: zero critics run, no-target panel event, coercion demotes", async () => {
    // The rubber-stamp regression case verbatim: manifest.urls.dev is set (the
    // stale URL), the deliverable is a test-gate library, and the contract still
    // carries authored-prose live-critic criteria the suite says nothing about.
    // The critic stub would PASS if the panel ever reached it — so this test
    // FAILS loudly if the producer's `opts.url ?? manifest.urls.dev` fallback is
    // ever reinstated for a non-server strategy (a false green through the
    // method layer), instead of passing vacuously the way a null stub would.
    const loom = rootLoom({
      version: 1,
      synthesized: true, // all-live-critic passes validateContract only as synthesized
      assertions: [
        asrt({
          id: "l1",
          type: "live-critic",
          expected: undefined,
          observable: "syncs against the production account",
          subGoalId: "ALL",
        }),
      ],
    });
    // AUTHORED criteria (not the prompt fallback) and no gate-intent charter /
    // verifyCommand ⇒ the (8) establishment sanction must NOT fire either: the
    // slice stays live-critic and the only honest outcome is the demote.
    loom.acceptanceCriteria = ["syncs against the production account"];
    const git = fakeGit();
    const critic = passingCriticSpy();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const iv = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: (l, m, o) => runIntegrationVerify(l, m, { ...o, run: critic.run }),
      git: git.runner,
      resolveServersConfig: () => noneCfg,
      failClosedLaneDown: true,
      deriveSignal: () => libSignal,
      emit: (ev) => events.push(ev),
      verifyOpts: { fullContract: true },
    });
    // The panel NEVER ran: zero critic invocations (a run against the stale
    // http://stale-dev would have burned spend AND returned a passing verdict),
    // and the producer emitted the no-target panel event (report: null).
    expect(critic.state.calls).toBe(0);
    expect(events.some((e) => e.type === "panel" && e.report === null)).toBe(true);
    // Sacred invariant (executor.ts fullContract coercion): no evidence ⇒ a
    // DEMOTING fail — never "skip"-keeps-ready, never a pass.
    expect(iv?.verification).toBe("fail");
    expect(iv?.error).toContain("panel verification required");
  });
});

// ── (3) strategy selection throw fail-closes to no-target ────────────────────
describe("(3) a strategy bring-up/selection throw fail-closes (flag on)", () => {
  test("deriveSignal throws → laneDown, target=undefined, verify-lane-down event, no escape into fail-open", async () => {
    const git = fakeGit();
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let captured: Record<string, unknown> = {};
    const loom = rootLoom({ version: 1, assertions: [asrt({ id: "t1", expected: "bun run test" })] });

    const iv = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "skip", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => hostCfg, // a lane WOULD be standable — the throw must still fail-close
      startLane: async () => fakeLane().lane,
      failClosedLaneDown: true,
      deriveSignal: () => {
        throw new Error("signal exploded");
      },
      emit: (ev) => events.push(ev),
    });

    expect(iv?.verification).toBe("skip"); // the producer ran — the throw never escaped
    expect(captured.url).toBeUndefined(); // fail-closed: no target, panel must skip
    expect(captured.noTarget).toBe(true); // the marker withholds the producer's urls.dev fallback
    expect(events.some((e) => e.type === "verify-lane-down")).toBe(true);
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true);
  });
});

// ── (4) defense-in-depth: non-server pick skips bring-up even with a config ──
describe("(4) a non-server strategy never calls startLane, even when a config resolves", () => {
  test("scripted cli-harness strategy + host-process config → zero startLane calls, url undefined", async () => {
    const git = fakeGit();
    let startCalls = 0;
    let captured: Record<string, unknown> = {};
    const loom = rootLoom({ version: 1, assertions: [asrt({ id: "c1", expected: "run cli" })] });
    const scripted: VerificationStrategy = { kind: "cli-harness", reason: "scripted" };

    const iv = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => hostCfg,
      startLane: async () => (startCalls++, fakeLane().lane),
      failClosedLaneDown: true,
      chooseStrategy: () => scripted,
      deriveSignal: () => libSignal,
    });

    expect(iv?.verification).toBe("pass");
    expect(startCalls).toBe(0);
    expect(captured.url).toBeUndefined();
    expect(captured.noTarget).toBe(true);
  });
});

// ── (5) teardown in finally for non-server strategies ────────────────────────
describe("(5) teardown holds for non-server strategies", () => {
  test("producer throws under a test-gate strategy → worktree still removed", async () => {
    const git = fakeGit();
    const loom = rootLoom({ version: 1, assertions: [asrt({ id: "t1", expected: "bun run test" })] });
    await expect(
      frozenLaneVerify(loom, manifest, {
        runIntegrationVerify: async () => {
          throw new Error("producer exploded");
        },
        git: git.runner,
        resolveServersConfig: () => noneCfg,
        failClosedLaneDown: true,
        deriveSignal: () => libSignal,
      }),
    ).rejects.toThrow("producer exploded");
    expect(git.args.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true);
  });
});

// ── (6) server strategy byte-identical to today ──────────────────────────────
describe("(6) server-lane keeps today's path verbatim", () => {
  test("host-process config → lane stood up, url=laneTarget, torn down, NO verify-strategy event", async () => {
    const git = fakeGit();
    const { lane, stopCount } = fakeLane("http://localhost:5000");
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let captured: Record<string, unknown> = {};
    // No bundle contract for this loom id (readContract → null → assertions [])
    // and a nonexistent wt → the REAL deriveDeliverableSignal finds no plan →
    // chooser rule 2 (serverConfigured) → server-lane.
    const loom: Loom = {
      id: "srv1",
      project: "pm112",
      kind: "custom",
      title: "t",
      prompt: "x",
      account: "personal",
      state: "queued",
      createdAt: 0,
      updatedAt: 0,
      attempts: [],
      error: null,
      baseSha: "deadbeef",
    };

    const iv = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => hostCfg,
      startLane: async (_c: ServersConfig, _r: string, _o?: StartLaneOpts) => lane,
      failClosedLaneDown: true,
      emit: (ev) => events.push(ev),
    });

    expect(iv?.verification).toBe("pass");
    expect(captured.url).toBe("http://localhost:5000"); // laneTarget — exactly today
    expect(captured.noTarget).toBeUndefined(); // the marker never rides the server path
    expect(stopCount()).toBe(1); // torn down in finally
    expect(events.some((e) => e.type === "verify-strategy")).toBe(false); // server path's event stream unchanged
  });

  test("web-shaped deliverable, driver none → today's manifest.urls.dev fallback preserved", async () => {
    const git = fakeGit();
    let captured: Record<string, unknown> = {};
    const loom = rootLoom({ version: 1, assertions: [asrt({ id: "t1", expected: "bun run test" })] });
    await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => noneCfg,
      failClosedLaneDown: true,
      deriveSignal: () => webSignal, // web shape → server-lane even with no config
    });
    expect(captured.url).toBe("http://stale-dev"); // the server-lane fallback, verbatim
    expect(captured.noTarget).toBeUndefined();
  });
});

// ── (7) flag-off byte-identical ───────────────────────────────────────────────
describe("(7) failClosedLaneDown absent → the strategy layer never engages", () => {
  test("no seam consulted; target falls back to manifest.urls.dev exactly as today", async () => {
    const git = fakeGit();
    let signalCalls = 0;
    let readCalls = 0;
    let chooseCalls = 0;
    let captured: Record<string, unknown> = {};
    const loom = rootLoom({ version: 1, assertions: [asrt({ id: "t1", expected: "bun run test" })] });

    await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: async (_l, _m, o) => ((captured = o), { verification: "pass", gatesOk: true }),
      git: git.runner,
      resolveServersConfig: () => noneCfg,
      deriveSignal: () => (signalCalls++, libSignal),
      readContractFn: () => (readCalls++, { contract: null }),
      chooseStrategy: () => (chooseCalls++, { kind: "test-gate", reason: "x" } as VerificationStrategy),
    });

    expect(signalCalls).toBe(0);
    expect(readCalls).toBe(0);
    expect(chooseCalls).toBe(0);
    expect(captured.url).toBe("http://stale-dev"); // today's fallback, byte-identical
    expect(captured.noTarget).toBeUndefined(); // no marker flag-off
    expect(captured.establishRun).toBeUndefined(); // no establishment flag-off
  });

  test("a bring-up throw still PROPAGATES flag-off (weave fail-open preserved)", async () => {
    const git = fakeGit();
    const loom = rootLoom({ version: 1, assertions: [asrt({ id: "t1", expected: "bun run test" })] });
    await expect(
      frozenLaneVerify(loom, manifest, {
        runIntegrationVerify: async () => ({ verification: "pass", gatesOk: true }),
        git: git.runner,
        resolveServersConfig: () => {
          throw new Error("malformed servers.yaml");
        },
      }),
    ).rejects.toThrow("malformed servers.yaml");
  });
});

// ── (8) artifact-time establishment — the deferred-gate hand-off ─────────────
describe("(8) a sanctioned synthesized all-live-critic contract is ESTABLISHED as a test gate", () => {
  test("greenfield replay (prompt fallback): the derived runnable executes as a gate in wt — real evidence, ready-able", async () => {
    // The loom_mrigs3zo_vxgrsr journey end-to-end at the M11.2 seam: at
    // dispatch the root had zero files (deferred-gate, no runnable) so the
    // persisted synthesized contract is all-live-critic; at verify time the
    // artifact EXISTS and the wt re-derivation answers test-gate with a
    // concrete runnable — which must now actually RUN as the gate, instead of
    // the guaranteed no-target demote.
    const loom = rootLoom({
      version: 1,
      synthesized: true,
      assertions: [
        asrt({ id: "synth-0", type: "live-critic", expected: undefined, observable: "build lib", subGoalId: "ALL" }),
      ],
    });
    // rootLoom sets NO acceptanceCriteria ⇒ the criteria are the PROMPT
    // FALLBACK — the establishment sanction for the greenfield shape.
    expect(loom.acceptanceCriteria ?? []).toEqual([]);
    const git = fakeGit();
    const critic = passingCriticSpy();
    const { gateRunner, cwds, runs } = fakeGates(true);
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let captured: Record<string, unknown> = {};

    const iv = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: (l, m, o) => (
        (captured = o), runIntegrationVerify(l, m, { ...o, gateRunner, run: critic.run })
      ),
      git: git.runner,
      resolveServersConfig: () => noneCfg,
      failClosedLaneDown: true,
      deriveSignal: () => libSignal, // the wt re-derivation: test-gate, `bun run test`
      emit: (ev) => events.push(ev),
      verifyOpts: { fullContract: true },
    });

    // The hand-off: the strategy's runnable reached the producer…
    expect(captured.establishRun).toBe("bun run test");
    // …and EXECUTED as a deterministic gate against the frozen worktree.
    expect(runs).toEqual(["bun run test"]);
    expect(cwds[0]).toBe(captured.verifyCwd as string);
    // The verdict is a REAL zero-browser pass from exit-code evidence — the
    // gate keeps `ready` (never authors done; accept stays the human click).
    expect(iv?.verification).toBe("pass");
    expect(iv?.gates?.length).toBe(1);
    expect(iv?.gates?.[0]?.name).toBe("synth-0"); // GateResult ties back to its assertion
    // The judge was never consulted — no live surface, no critic spend.
    expect(critic.state.calls).toBe(0);
    // Observability: the establishment is on the event stream.
    const est = events.find((e) => e.type === "verify-establish");
    expect(est?.run).toBe("bun run test");
  });

  test("a RED established gate demotes — establishment is evidence, never a rubber-stamp", async () => {
    const loom = rootLoom({
      version: 1,
      synthesized: true,
      assertions: [
        asrt({ id: "synth-0", type: "live-critic", expected: undefined, observable: "build lib", subGoalId: "ALL" }),
      ],
    });
    const git = fakeGit();
    const { gateRunner, runs } = fakeGates(false); // the suite FAILS
    const iv = await frozenLaneVerify(loom, manifest, {
      runIntegrationVerify: (l, m, o) => runIntegrationVerify(l, m, { ...o, gateRunner, run: (async () => null) as never }),
      git: git.runner,
      resolveServersConfig: () => noneCfg,
      failClosedLaneDown: true,
      deriveSignal: () => libSignal,
      verifyOpts: { fullContract: true },
    });
    expect(runs).toEqual(["bun run test"]); // it really ran
    expect(iv?.verification).toBe("fail"); // exit code ≠ 0 ⇒ demote, fail-closed
    expect(iv?.gatesOk).toBe(false);
  });

  test("the human-answered manifest verifyCommand sanctions + supplies the runnable (chooser rule 3, REAL chooser)", async () => {
    // A signal-less repo (unknown shape, nothing derivable) whose human already
    // answered the strategy ask: telar.yaml carries verifyCommand. The REAL
    // chooser must pick test-gate carrying it, and the human answer sanctions
    // establishment even over AUTHORED criteria — a human declared the proof.
    const loom = rootLoom({
      version: 1,
      synthesized: true,
      assertions: [
        asrt({ id: "synth-0", type: "live-critic", expected: undefined, observable: "records sync", subGoalId: "ALL" }),
      ],
    });
    loom.acceptanceCriteria = ["records sync"]; // authored — only the human answer sanctions
    const answered = ProjectManifest.parse({
      name: "pm112",
      root: "/tmp/telar-m112lane-repo",
      urls: { dev: "http://stale-dev" },
      verifyCommand: "bun run check",
      gates: [],
    });
    const git = fakeGit();
    const critic = passingCriticSpy();
    const { gateRunner, runs } = fakeGates(true);
    const events: Array<{ type: string } & Record<string, unknown>> = [];

    const iv = await frozenLaneVerify(loom, answered, {
      runIntegrationVerify: (l, m, o) => runIntegrationVerify(l, m, { ...o, gateRunner, run: critic.run }),
      git: git.runner,
      resolveServersConfig: () => noneCfg,
      failClosedLaneDown: true,
      // REAL chooser; the signal finds no plan — the verifyCommand must carry it.
      deriveSignal: () => ({ plannable: false, shape: "unknown", reason: "no signal" }),
      emit: (ev) => events.push(ev),
      verifyOpts: { fullContract: true },
    });

    const strat = events.find((e) => e.type === "verify-strategy");
    expect(strat?.strategy).toBe("test-gate");
    expect(runs).toEqual(["bun run check"]); // the human's command IS the gate
    expect(iv?.verification).toBe("pass");
    expect(critic.state.calls).toBe(0); // never judged against the stale urls.dev
  });
});
