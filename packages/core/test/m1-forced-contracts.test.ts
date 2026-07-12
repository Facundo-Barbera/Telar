// M1 — Forced Contracts + Full Re-Verify (CORE slice). Proves the M1 creation-
// time invariant and its moat-preserving promotion behavior, all hermetic (no
// live agent, no browser, no real process):
//   - synthesizeContract maps prose acceptanceCriteria -> live-critic assertions
//     (and falls back to prompt/title when there are none)
//   - validateContract accepts an all-live-critic contract IFF synthesized:true,
//     but still enforces every OTHER falsifiability rule
//   - EVERY loom ends up with a contract: startLoom persists a synthesized one
//   - a synthesized no-target verify FAILS CLOSED: a non-empty agent-judged
//     slice with no live evidence is panelRequired:true -> decide() retries then
//     lands needs-review (never promotes on self-report — the moat)
//   - runIntegrationVerify now FIRES on a formerly-contractless (synthesized)
//     root, and a red panel yields "fail" (which weave demotes ready ->
//     needs-review); a green panel yields "pass" (weave keeps ready)
//   - the moat: a green verify lands a ROOT in "ready", never "done"
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectManifest, validateContract, type VerificationContract } from "../src/schemas";
import type { Gate, GateResult } from "../src/gates";
import type { Loom } from "../src/looms";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m1-forced-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { synthesizeContract } = await import("../src/weave-contracts");
const {
  runVerification,
  runIntegrationVerify,
  decide,
  terminalStateForCompletedLoom,
} = await import("../src/executor");
const { createLoom, getLoom } = await import("../src/looms");
const { readContract, writeContract, writeBundleFile } = await import("../src/bundle");
const { startLoom } = await import("../src/dispatcher");
const { createProject } = await import("../src/manifest");

// Register project "p" so runPanel's registry lookup resolves (the panel path).
createProject(fs.mkdtempSync(path.join(os.tmpdir(), "telar-m1-p-")), { name: "p" });

const manifestWithUrl = ProjectManifest.parse({
  name: "p",
  root: "/tmp/telar-m1-repo",
  urls: { dev: "http://localhost:3000" },
});
const manifestNoTarget = ProjectManifest.parse({ name: "p", root: "/tmp/telar-m1-repo" }); // no urls.dev, no devCommand

function fakeLoom(overrides: Partial<Loom> = {}): Loom {
  return {
    id: "fake_m1",
    project: "p",
    kind: "custom",
    title: "Ship the widget",
    prompt: "Implement the widget end-to-end.",
    account: "personal",
    state: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: [],
    error: null,
    ...overrides,
  };
}

function fakeGates(decideOk: (cmd: string) => boolean) {
  const calls: Gate[] = [];
  const gateRunner = async (gate: Gate): Promise<GateResult> => {
    calls.push(gate);
    const ok = decideOk(gate.run);
    return { name: gate.name, ok, exitCode: ok ? 0 : 1, output: `ran: ${gate.run}`, durationMs: 1, timedOut: false };
  };
  return { gateRunner, calls };
}

// A fake panel agent: returns a CriticVerdict for each lens, ok decided per-lens.
function fakePanel(ok: boolean) {
  return (async (task: string) => {
    const m = task.match(/--- Your lens: (.+?) \(/);
    const lens = m ? m[1]! : "unknown";
    return {
      lens,
      ok,
      summary: ok ? "clean" : "broken",
      findings: ok ? [] : [{ severity: "blocker", title: "it breaks", detail: "unhandled path", evidence: [] }],
      evidence: [],
    };
  }) as any;
}

describe("synthesizeContract (D1.2)", () => {
  test("maps each acceptanceCriterion -> one live-critic assertion, subGoalId ALL, synthesized:true", () => {
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: ["shows a toast", "  ", "persists on reload"] }));
    expect(c.synthesized).toBe(true);
    // blank criterion is trimmed out
    expect(c.assertions).toEqual([
      { id: "synth-0", subGoalId: "ALL", description: "shows a toast", type: "live-critic", observable: "shows a toast", blocker: true },
      { id: "synth-1", subGoalId: "ALL", description: "persists on reload", type: "live-critic", observable: "persists on reload", blocker: true },
    ]);
  });

  test("no criteria -> a single fallback assertion from the prompt", () => {
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: [], prompt: "Implement GET /healthz" }));
    expect(c.assertions.length).toBe(1);
    expect(c.assertions[0]!.observable).toBe("Implement GET /healthz");
  });

  test("no criteria and no prompt -> falls back to the title (always >=1 assertion)", () => {
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: undefined, prompt: "", title: "Add a route" }));
    expect(c.assertions.length).toBe(1);
    expect(c.assertions[0]!.observable).toBe("Add a route");
  });
});

describe("validateContract + synthesized flag (D0.1)", () => {
  test("an all-live-critic contract is REJECTED without the flag, ACCEPTED with synthesized:true", () => {
    const assertions = [
      { id: "a0", subGoalId: "ALL", description: "d", type: "live-critic" as const, observable: "o", blocker: true },
    ];
    expect(validateContract({ version: 1, assertions })).toContain(
      "contract must have at least one non-live-critic (hard-gate) assertion",
    );
    expect(validateContract({ version: 1, assertions, synthesized: true })).toEqual([]);
  });

  test("synthesized:true skips ONLY the floor — every other falsifiability rule still fires", () => {
    // live-critic with a blank observable is still invalid even when synthesized
    const errs = validateContract({
      version: 1,
      synthesized: true,
      assertions: [{ id: "bad", description: "d", type: "live-critic", observable: "  ", blocker: true }],
    });
    expect(errs).toContain("live-critic assertion bad must name an observable");
  });

  test("a real synthesizeContract output always validates", () => {
    const c = synthesizeContract(fakeLoom({ acceptanceCriteria: ["works"] }));
    expect(validateContract(c)).toEqual([]);
  });
});

describe("every loom ends up with a contract (D0.3 choke point)", () => {
  test("startLoom on a plain custom loom persists a synthesized contract to the root", async () => {
    const seen: Loom[] = [];
    const runLoomFn = async (child: Loom, _m: unknown, opts: { onState?: (l: Loom) => void }) => {
      seen.push(child);
      child.state = "done";
      opts.onState?.(child);
      return child;
    };
    const root = startLoom(
      { project: "p", kind: "custom", title: "t", prompt: "do the thing", acceptanceCriteria: ["must do X"] },
      { accounts: {}, runLoomFn: runLoomFn as never },
    );
    const start = Date.now();
    while (getLoom(root.id)?.state !== "ready" && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const contract = readContract(root.id).contract;
    expect(contract).not.toBeNull();
    expect(contract!.synthesized).toBe(true);
    expect(contract!.assertions.map((a) => a.observable)).toEqual(["must do X"]);
  });
});

describe("synthesized no-target verify FAILS CLOSED (M8: no evidence -> needs-review)", () => {
  test("no live target -> skip with panelRequired:true, and decide() retries then needs-review", async () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    // Persist a synthesized contract (live-critic -> agentJudged, no gates).
    writeContract(loom.id, synthesizeContract(loom));
    writeBundleFile(loom.id, "objective.md", "obj");
    const attempt = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    loom.attempts.push(attempt);

    const events: { type: string }[] = [];
    const res = await runVerification(loom, manifestNoTarget, attempt, (e) => events.push(e));

    // M8 fail-closed: a non-empty agent-judged slice that cannot be judged live
    // is a FAILURE to obtain evidence, NOT a promotable "nothing to verify".
    // Same skip verification, but panelRequired flips to true (authored-contract
    // rule is now the general rule).
    expect(res.verification).toBe("skip");
    expect(res.panelRequired).toBe(true);

    // decide(): gates green + agent ok + a REQUIRED-but-skipped panel -> retry
    // while attempts remain, then needs-review once exhausted. Never `done` on
    // self-report — that contrast with a real panel pass IS the moat.
    const okVerdict = { ok: true, summary: "done", files_touched: [], blocker: null };
    const base = {
      gatesConfigured: true,
      gatesOk: true,
      verdict: okVerdict,
      verification: "skip" as const,
      maxAttempts: 3,
      flakyUsed: 0,
      maxFlaky: 1,
    };
    expect(decide({ ...base, n: 1, panelRequired: res.panelRequired }).action).toBe("retry"); // retries remain
    const exhausted = decide({ ...base, n: 3, panelRequired: res.panelRequired });
    expect(exhausted.action).toBe("needs-review"); // exhausted -> needs-review
    expect(exhausted.error).toBe("panel verification required but did not run");
  });

  test("an AUTHORED contract's no-target skip is NOT promotable (panelRequired stays true)", async () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    // Authored: a real hard gate + a live-critic (agentJudged present). No synthesized flag.
    const authored: VerificationContract = {
      version: 1,
      assertions: [
        { id: "g", subGoalId: "ALL", description: "cmd", type: "command", expected: "echo ok", blocker: true },
        { id: "lc", subGoalId: "ALL", description: "flow", type: "live-critic", observable: "flow works", blocker: true },
      ],
    };
    writeContract(loom.id, authored);
    writeBundleFile(loom.id, "objective.md", "obj");
    const attempt = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    loom.attempts.push(attempt);

    const res = await runVerification(loom, manifestNoTarget, attempt, () => {});
    expect(res.verification).toBe("skip");
    expect(res.panelRequired).toBe(true); // moat: no evidence => no promotion
  });
});

describe("panel exception FAILS CLOSED (M8: a thrown panel never promotes)", () => {
  test("runPanel throws -> verification 'skip' + panelRequired:true, decide() retries then needs-review", async () => {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
    // A synthesized (live-critic) contract -> a non-empty agent-judged slice, so
    // the panel IS required and runs (agentJudged.length > 0, not the all-
    // deterministic short-circuit).
    writeContract(loom.id, synthesizeContract(loom));
    writeBundleFile(loom.id, "objective.md", "obj");
    const attempt = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    loom.attempts.push(attempt);

    // A live target IS present (manifestWithUrl.urls.dev), so we reach runPanel;
    // the injected agent throws, so the panel run rejects. A thrown panel is the
    // strongest no-clean-evidence signal — it must classify skip/panelRequired:true
    // (surfaced reason "required but did not run", NOT a false "verification failed").
    const throwingRun = (() => {
      throw new Error("panel boom");
    }) as any;

    const events: { type: string }[] = [];
    const res = await runVerification(loom, manifestWithUrl, attempt, (e) => events.push(e), undefined, undefined, {
      run: throwingRun,
    });

    expect(res.verification).toBe("skip");
    expect(res.panelRequired).toBe(true);
    expect(events.some((e) => e.type === "panel-error")).toBe(true);

    // Feeds decide() to retry-then-needs-review, never done.
    const base = {
      gatesConfigured: true,
      gatesOk: true,
      verdict: { ok: true, summary: "d", files_touched: [], blocker: null },
      verification: "skip" as const,
      maxAttempts: 3,
      flakyUsed: 0,
      maxFlaky: 1,
    };
    expect(decide({ ...base, n: 1, panelRequired: res.panelRequired }).action).toBe("retry");
    const exhausted = decide({ ...base, n: 3, panelRequired: res.panelRequired });
    expect(exhausted.action).toBe("needs-review");
    expect(exhausted.error).toBe("panel verification required but did not run");
  });
});

describe("runIntegrationVerify now FIRES on a synthesized root (D3 full re-verify)", () => {
  function synthRoot(): Loom {
    const loom = createLoom({ project: "p", kind: "custom", title: "root", prompt: "assemble the whole", account: "personal" });
    writeBundleFile(loom.id, "objective.md", "Integration objective.");
    // The exact contract the choke point persists: all-live-critic, ALL slice, synthesized.
    writeContract(loom.id, synthesizeContract({ ...loom, acceptanceCriteria: ["end-to-end flow works"] }));
    return loom;
  }

  test("a formerly-contractless (synthesized) root: the producer fires (non-null) instead of no-oping", async () => {
    const loom = synthRoot();
    const iv = await runIntegrationVerify(loom, manifestWithUrl, {
      gateRunner: fakeGates(() => true).gateRunner,
      run: fakePanel(true),
    });
    expect(iv).not.toBeNull();
    expect(iv!.verification).toBe("pass");
    expect(loom.attempts.length).toBe(1); // one integration AttemptRecord recorded
    expect(loom.attempts[0]!.role).toBe("integration");
  });

  test("a RED panel on the synthesized root -> 'fail' (this is what weave demotes ready -> needs-review)", async () => {
    const loom = synthRoot();
    const iv = await runIntegrationVerify(loom, manifestWithUrl, {
      gateRunner: fakeGates(() => true).gateRunner,
      run: fakePanel(false),
    });
    expect(iv).not.toBeNull();
    expect(iv!.verification).toBe("fail");
  });
});

describe("MOAT: a green verify lands a ROOT in 'ready', never 'done'", () => {
  test("terminalStateForCompletedLoom(root) === 'ready' (a human accept is the sole 'done' writer)", () => {
    expect(terminalStateForCompletedLoom({ parentLoomId: undefined })).toBe("ready");
    // A child (has a parent) still folds to done under its ready root — unchanged.
    expect(terminalStateForCompletedLoom({ parentLoomId: "root_1" })).toBe("done");
  });
});
