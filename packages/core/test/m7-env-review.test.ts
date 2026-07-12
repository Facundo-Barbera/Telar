// M7 — the env-review gate (CORE slice). Fakes only: no live agent, no live
// server, tmp dirs fs-removed after. Proves, end to end:
//   A. flag-off byte-identity (needsEnv never set; today's terminal preserved)
//   B. the §1.1 trigger + GAP 1 (SYNTH looms divert too; synth panel runs post-accept)
//   B2. GAP 2 — the accept→verify round-trip (accepted config → lane spins →
//       panel runs live → real verdict; never an env-review loop, never a skip)
//   C. the proposer is READ-ONLY before accept (no Write tool, no startLane, no
//      file written) — the load-bearing moat
//   D. the human gate (approveEnv needs a non-blank `by`; accept vs steer)
//   E. .telar persistence + precedence (incl. the frozen-worktree caveat)
//   F. reject + the moat (green re-verify lands `ready`, never `done`)
//   G. exhaustiveness smoke (reconcileState)
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m7-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.TELAR_ENV_REVIEW;
});

const { runVerification, executeLoom, decideVerifyLoom, terminalStateForCompletedLoom } = await import("../src/executor");
const { proposeServersConfig } = await import("../src/setup/setup-agent");
const { resolveServersConfig, writeAcceptedServersConfig } = await import("../src/servers");
const { approveEnv, rejectLoom } = await import("../src/dispatcher");
const { reconcileState } = await import("../src/runner/recover");
const { runWeave, rollupWeave } = await import("../src/weave");
const { createLoom, getLoom, readEvents, saveLoom, acceptLoom, listChildLooms } = await import("../src/looms");
const { writeContract, writeBundleFile } = await import("../src/bundle");
const { createProject } = await import("../src/manifest");
const { ProjectManifest } = await import("../src/schemas");
import type { Loom } from "../src/looms";
import type { ServersConfig, VerificationContract } from "../src/schemas";
import type { SetupDeps } from "../src/setup/setup-agent";

let n = 0;
// A real on-disk project root (createProject writes telar.yaml + registers it).
// envReview defaults OFF; pass { envReview: true } to arm the gate.
function makeProject(partial: Record<string, unknown> = {}) {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-m7-proj-${n}-`));
  const m = createProject(root, { name: `m7-${n}`, ...partial });
  return { name: m.name, root, manifest: m };
}

// A bare tmp root with NO project registration — for pure runVerification /
// servers precedence checks (no registry lookup on the no-target path).
function tmpRoot(): string {
  n++;
  return fs.mkdtempSync(path.join(os.tmpdir(), `telar-m7-root-${n}-`));
}

// A manifest pointed at a real root, no urls/devCommand, envReview armable.
function manifestAt(root: string, envReview = true) {
  return ProjectManifest.parse({ name: "m7", root, envReview });
}

// An AUTHORED (non-synth) contract: a passing deterministic gate + a live-critic
// (agentJudged non-empty ⇒ panelRequired true).
const authoredContract: VerificationContract = {
  version: 1,
  assertions: [
    { id: "g", subGoalId: "ALL", description: "cmd", type: "command", expected: "echo ok", blocker: true },
    { id: "lc", subGoalId: "ALL", description: "flow", type: "live-critic", observable: "flow works", blocker: true },
  ],
};

const laneCfg: ServersConfig = {
  version: 1,
  driver: "host-process",
  services: {
    web: {
      command: "bun dev",
      portStrategy: "fixed",
      port: 3000,
      env: {},
      dependsOn: [],
      readyCheck: { kind: "http", path: "/", status: 200 },
    },
  },
};

// A fake panel `run`: mirrors panel-wire.test's fake — extract the lens label
// from the real critic prompt and return a clean CriticVerdict for every lens,
// so classifyPanel aggregates "pass". No live agent, no browser.
const fakePanelRun = (async (task: string) => {
  const m = task.match(/--- Your lens: (.+?) \(/);
  const lens = m ? m[1]! : "unknown";
  return { lens, ok: true, summary: "clean", findings: [], evidence: [] };
}) as any;

// A fake startLane seam: records the calls + the config/root it was handed and
// returns a lane exposing `url`, WITHOUT spawning any real process. `stops`
// proves the read-only teardown fired.
function fakeLaneSeam(url: string) {
  let starts = 0;
  let stops = 0;
  let cfg: ServersConfig | undefined;
  let root: string | undefined;
  const startLane = (async (c: ServersConfig, r: string) => {
    starts++;
    cfg = c;
    root = r;
    return {
      services: { web: { name: "web", port: 4599, url, stop: async () => {} } },
      stopAll: async () => {
        stops++;
      },
    };
  }) as any;
  return {
    startLane,
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get cfg() {
      return cfg;
    },
    get root() {
      return root;
    },
  };
}

// A live-critic loom with an authored contract on disk, no builder attempt yet.
function authoredLoom(project = "m7"): Loom {
  const loom = createLoom({ project, kind: "custom", title: "t", prompt: "x", account: "personal" });
  writeContract(loom.id, authoredContract);
  writeBundleFile(loom.id, "objective.md", "obj");
  loom.attempts.push({ n: 1, role: "dev", model: "sonnet", startedAt: Date.now() });
  return loom;
}

// dispatchExecution invokes runLoomFn synchronously up to its first await, so
// `calls` is observable right after approve/reject returns (steer-reject.test).
function fakeDeps() {
  let calls = 0;
  const runLoomFn = async (l: Loom) => {
    calls++;
    l.state = "ready";
    return l;
  };
  return { deps: { accounts: {}, runLoomFn } as any, get calls() { return calls; } };
}

// ── A. flag-off byte-identity ───────────────────────────────────────────────
describe("A. flag-off byte-identity", () => {
  test("authored live-critic, no target/devCommand/config, flag OFF → needsEnv falsy (unchanged skip)", async () => {
    const root = tmpRoot();
    const manifest = manifestAt(root, /*envReview*/ false);
    const loom = authoredLoom();
    let proposeCalled = 0;
    const res = await runVerification(loom, manifest, loom.attempts[0]!, () => {}, undefined, undefined, {});
    expect(res.verification).toBe("skip");
    expect(res.panelRequired).toBe(true); // authored: no evidence ⇒ no promotion
    expect(res.needsEnv).toBeFalsy(); // the divert never arms
    expect(proposeCalled).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── B. trigger — enters env-review only in the exact §1.1 condition ──────────
describe("B. §1.1 trigger", () => {
  test("2. full condition → needsEnv:true, and executeLoom lands env-review with proposedServers (no promotion)", async () => {
    const { name, root, manifest } = makeProject({ envReview: true });
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });
    writeContract(loom.id, authoredContract);
    writeBundleFile(loom.id, "objective.md", "obj");

    let proposeCalls = 0;
    await executeLoom(loom, manifest, {
      run: (async () => ({ ok: true, summary: "done", files_touched: [], blocker: null })) as any,
      proposeServersConfig: async () => {
        proposeCalls++;
        return { config: laneCfg };
      },
      onEvent: () => {},
      onState: () => {},
    });

    expect(proposeCalls).toBe(1);
    expect(loom.state).toBe("env-review");
    expect(loom.proposedServers).toEqual(laneCfg);
    expect(loom.state).not.toBe("done"); // never a promotion
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("3. GAP 1: SYNTH live-critic + no target/devCommand/recipe → flag ON diverts to env-review; flag OFF unchanged (promotable skip)", async () => {
    const { synthesizeContract } = await import("../src/weave-contracts");
    const root = tmpRoot();
    const loom = createLoom({ project: "m7", kind: "custom", title: "t", prompt: "x", account: "personal" });
    writeContract(loom.id, synthesizeContract({ ...loom, acceptanceCriteria: ["flow works"] }));
    writeBundleFile(loom.id, "objective.md", "obj");

    // Flag ON → a synthesized live-critic loom that needs a running app now
    // diverts too (the `!synthesized` exclusion is gone).
    const on = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    const resOn = await runVerification(loom, manifestAt(root, /*envReview*/ true), on, () => {}, undefined, undefined, {});
    expect(resOn.needsEnv).toBe(true);

    // Flag OFF → byte-identical to before: no divert, promotable skip preserved.
    const off = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    const resOff = await runVerification(loom, manifestAt(root, /*envReview*/ false), off, () => {}, undefined, undefined, {});
    expect(resOff.needsEnv).toBeFalsy();
    // M8 fail-closed hardening: the no-target skip is now an UNCONDITIONAL
    // panelRequired:true for BOTH authored and synthesized (a no-evidence skip is
    // no longer promotable). Pre-M8 this was `false` (promotable) for synth; M8
    // makes it `true`, and flag-off env-review preserves that exactly.
    expect(resOff.panelRequired).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("3b. GAP 1 (part 2): after accept, the SYNTH loom's panel ACTUALLY runs vs the spun server (panelRequired true, real verdict — not a promotable skip)", async () => {
    const { synthesizeContract } = await import("../src/weave-contracts");
    const { name, root, manifest } = makeProject({ envReview: true });
    writeAcceptedServersConfig(root, laneCfg); // the post-approveEnv state
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });
    writeContract(loom.id, synthesizeContract({ ...loom, acceptanceCriteria: ["flow works"] }));
    writeBundleFile(loom.id, "objective.md", "obj");
    loom.attempts.push({ n: 1, role: "dev", model: "sonnet", startedAt: Date.now() });

    const lane = fakeLaneSeam("http://localhost:4600");
    const res = await runVerification(loom, manifest, loom.attempts[0]!, () => {}, undefined, undefined, {
      startLane: lane.startLane,
      run: fakePanelRun,
    });
    expect(lane.starts).toBe(1); // lane spun from the accepted config
    expect(res.needsEnv).toBeFalsy(); // NOT re-diverted to env-review
    expect(res.panelRequired).toBe(true); // GAP 1 part 2: synth panel NOT skipped post-accept
    expect(res.verification).toBe("pass"); // a REAL verdict against the live app
    expect(res.panelReport?.url).toBe("http://localhost:4600"); // panel drove the lane URL
    expect(lane.stops).toBe(1); // read-only observe → torn down
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("4. manifest.devCommand set → no divert (M5 auto-spin owns it)", async () => {
    const root = tmpRoot();
    const manifest = ProjectManifest.parse({ name: "m7", root, envReview: true, devCommand: "true" });
    const loom = authoredLoom();
    const aborted = new AbortController();
    aborted.abort(); // the spin path bails immediately; we never stand a server up
    const res = await runVerification(loom, manifest, loom.attempts[0]!, () => {}, undefined, undefined, { abort: aborted });
    expect(res.needsEnv).toBeFalsy(); // took the devCommand branch, not env-review
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("5. an already-accepted host-process config → no divert; the lane spins and the panel runs (GAP 2, reuse-forever)", async () => {
    const { name, root, manifest } = makeProject({ envReview: true });
    writeAcceptedServersConfig(root, laneCfg); // .telar/servers.yaml exists
    expect(resolveServersConfig(root).driver).toBe("host-process");
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });
    writeContract(loom.id, authoredContract);
    writeBundleFile(loom.id, "objective.md", "obj");
    loom.attempts.push({ n: 1, role: "dev", model: "sonnet", startedAt: Date.now() });
    const lane = fakeLaneSeam("http://localhost:4601");
    const res = await runVerification(loom, manifest, loom.attempts[0]!, () => {}, undefined, undefined, {
      startLane: lane.startLane,
      run: fakePanelRun,
    });
    expect(res.needsEnv).toBeFalsy(); // no re-proposal — the recipe is reused
    expect(lane.starts).toBe(1); // and the accepted recipe brings the lane up
    expect(res.verification).toBe("pass"); // a real verdict, not a dead skip
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("6. panelRequired false (all-deterministic contract) → no divert", async () => {
    const root = tmpRoot();
    const manifest = manifestAt(root, true);
    const loom = createLoom({ project: "m7", kind: "custom", title: "t", prompt: "x", account: "personal" });
    // Only a deterministic gate — no live-critic ⇒ agentJudged empty ⇒ panelRequired false.
    writeContract(loom.id, {
      version: 1,
      assertions: [{ id: "g", subGoalId: "ALL", description: "cmd", type: "command", expected: "echo ok", blocker: true }],
    });
    writeBundleFile(loom.id, "objective.md", "obj");
    const attempt = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
    const res = await runVerification(loom, manifest, attempt, () => {}, undefined, undefined, {});
    expect(res.needsEnv).toBeFalsy();
    expect(res.panelRequired).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("7. proposer returns null → honest needs-review, NOT env-review (no fabricated pass, no block)", async () => {
    const { name, root, manifest } = makeProject({ envReview: true });
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });
    writeContract(loom.id, authoredContract);
    writeBundleFile(loom.id, "objective.md", "obj");

    await executeLoom(loom, manifest, {
      run: (async () => ({ ok: true, summary: "done", files_touched: [], blocker: null })) as any,
      proposeServersConfig: async () => ({ config: null, error: "no viable env" }),
      onEvent: () => {},
      onState: () => {},
    });

    expect(loom.state).toBe("needs-review");
    expect(loom.state).not.toBe("env-review");
    expect(loom.proposedServers).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── B2. GAP 2 — the accept→verify round-trip (THE load-bearing proof) ────────
describe("B2. GAP 2 round-trip", () => {
  test("2. re-dispatched verify LEG: an accepted .telar config spins the lane, runs the panel vs its URL, and lands a REAL verdict — never an env-review loop, never a skip", async () => {
    // This is exactly what approveEnv's re-dispatch reaches: verify with the
    // persisted recipe on disk. Prove the whole leg, with fakes only.
    const { name, root, manifest } = makeProject({ envReview: true });
    writeAcceptedServersConfig(root, laneCfg); // ← what approveEnv persisted
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });
    writeContract(loom.id, authoredContract);
    writeBundleFile(loom.id, "objective.md", "obj");
    loom.attempts.push({ n: 1, role: "dev", model: "sonnet", startedAt: Date.now() });

    const lane = fakeLaneSeam("http://localhost:4599");
    const res = await runVerification(loom, manifest, loom.attempts[0]!, () => {}, undefined, undefined, {
      startLane: lane.startLane,
      run: fakePanelRun,
    });

    expect(lane.starts).toBe(1); // the lane spun from the accepted config
    expect(lane.cfg?.driver).toBe("host-process"); // ...the .telar recipe, not "none"
    expect(lane.root).toBe(root); // ...brought up against the project root
    expect(res.needsEnv).toBeFalsy(); // it did NOT loop back to env-review
    expect(res.panelRequired).toBe(true); // it did NOT take a skip
    expect(res.verification).toBe("pass"); // a REAL verdict
    expect(res.panelReport?.url).toBe("http://localhost:4599"); // panel drove the live URL
    expect(lane.stops).toBe(1); // read-only: lane torn down afterward
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("2b. end-to-end via approveEnv: accept → persist → re-dispatch → the verify spins the lane + runs the panel (does NOT re-enter env-review)", async () => {
    const { name, root, manifest } = makeProject({ envReview: true });
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });
    writeContract(loom.id, authoredContract);
    writeBundleFile(loom.id, "objective.md", "obj");
    loom.state = "env-review";
    loom.proposedServers = laneCfg;
    saveLoom(loom);

    const lane = fakeLaneSeam("http://localhost:4599");
    let resolveDone!: (vr: Awaited<ReturnType<typeof runVerification>>) => void;
    const done = new Promise<Awaited<ReturnType<typeof runVerification>>>((r) => (resolveDone = r));

    // The re-dispatched executor is stubbed to the verify LEG: run the real
    // runVerification (with fake seams) on the child the weave hands us, so the
    // whole approveEnv → persist → re-dispatch → verify chain is exercised.
    const runLoomFn = async (l: Loom, mf: typeof manifest) => {
      writeContract(l.id, authoredContract); // deterministic: verify the live-critic
      writeBundleFile(l.id, "objective.md", "obj");
      const attempt = { n: 1, role: "dev", model: "sonnet", startedAt: Date.now() };
      l.attempts.push(attempt);
      const vr = await runVerification(l, mf, attempt, () => {}, undefined, undefined, {
        startLane: lane.startLane,
        run: fakePanelRun,
      });
      l.state = vr.needsEnv ? "env-review" : vr.verification === "pass" ? "ready" : "needs-review";
      resolveDone(vr);
      return l;
    };

    const ok = await approveEnv(loom.id, "alice", undefined, { accounts: {}, runLoomFn } as any);
    expect(ok).toBe(true);

    const vr = await done;
    expect(resolveServersConfig(root).driver).toBe("host-process"); // approveEnv persisted the recipe
    expect(lane.starts).toBe(1); // the re-dispatched verify brought the lane up
    expect(vr.needsEnv).toBeFalsy(); // did NOT loop back to env-review
    expect(vr.verification).toBe("pass"); // a real verdict against the live app
    expect(vr.panelReport?.url).toBe("http://localhost:4599");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── C. proposer is read-only before accept ──────────────────────────────────
describe("C. proposer (read-only, moat)", () => {
  function fakeAgent(result: unknown) {
    const opts: any[] = [];
    const fn = (async (_task: string, o: unknown) => {
      opts.push(o);
      return result;
    }) as unknown as SetupDeps["agent"];
    return { fn, opts };
  }

  test("8. no Write tool; startLane never called; nothing written to disk", async () => {
    const root = tmpRoot();
    const manifest = manifestAt(root, true);
    const loom = createLoom({ project: "m7", kind: "custom", title: "t", prompt: "x", account: "personal" });
    const agent = fakeAgent({ driver: "host-process", services: laneCfg.services });
    let laneStarts = 0;
    const res = await proposeServersConfig(loom, manifest, {
      agent: agent.fn,
      startLane: (async () => {
        laneStarts++;
        return {} as any;
      }) as any,
    });
    expect(res.config).not.toBeNull();
    const o = agent.opts[0] as { tools: string[]; disallowedTools: string[]; settingSources: unknown[] };
    expect(o.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(o.tools).not.toContain("Write"); // cannot persist
    expect(o.tools).not.toContain("Bash"); // cannot exec
    expect(o.disallowedTools).toContain("Write");
    expect(o.disallowedTools).toContain("Bash"); // hard wall: no full write/exec
    expect(o.settingSources).toEqual([]);
    expect(laneStarts).toBe(0); // no bring-up before accept
    // Nothing written by the proposer itself.
    expect(fs.existsSync(path.join(root, "servers.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".telar"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("9. schema-valid draft → config; malformed agent result → {config:null}", async () => {
    const manifest = manifestAt(tmpRoot(), true);
    const loom = createLoom({ project: "m7", kind: "custom", title: "t", prompt: "x", account: "personal" });

    const good = await proposeServersConfig(loom, manifest, {
      agent: fakeAgent({ driver: "host-process", services: laneCfg.services }).fn,
    });
    expect(good.config?.driver).toBe("host-process");
    expect(good.config?.services.web.port).toBe(3000);

    // Missing the required portStrategy ⇒ ServersConfig.safeParse fails.
    const bad = await proposeServersConfig(loom, manifest, {
      agent: fakeAgent({ driver: "host-process", services: { web: { command: "x" } } }).fn,
    });
    expect(bad.config).toBeNull();
    expect(bad.error).toBeTruthy();

    // Agent returns nothing ⇒ null.
    const none = await proposeServersConfig(loom, manifest, { agent: fakeAgent(null).fn });
    expect(none.config).toBeNull();
  });
});

// ── D. human gate ───────────────────────────────────────────────────────────
describe("D. approveEnv human gate", () => {
  function envReviewLoom(project: string, proposed: ServersConfig | undefined = laneCfg) {
    const loom = createLoom({ project, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "env-review";
    loom.proposedServers = proposed;
    saveLoom(loom);
    return loom;
  }

  test("10. blank `by` throws (moat — never autonomous)", async () => {
    const { name } = makeProject();
    const loom = envReviewLoom(name);
    await expect(approveEnv(loom.id, "  ", undefined, fakeDeps().deps)).rejects.toThrow(/non-blank/);
  });

  test("11. accept: persists proposal to .telar, appends env-approved, clears draft, re-dispatches", async () => {
    const { name, root } = makeProject();
    const loom = envReviewLoom(name);
    const f = fakeDeps();

    const ok = await approveEnv(loom.id, "alice", undefined, f.deps);
    expect(ok).toBe(true);
    expect(f.calls).toBe(1); // re-dispatched VERIFY

    const persisted = resolveServersConfig(root);
    expect(persisted.driver).toBe("host-process");
    expect(fs.existsSync(path.join(root, ".telar", "servers.yaml"))).toBe(true);

    const after = getLoom(loom.id)!;
    expect(after.proposedServers).toBeUndefined(); // draft cleared
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "env-approved").length).toBe(1);
    expect(events.find((e) => e.type === "env-approved")!.by).toBe("alice");
  });

  test("12. steer: an edited config is persisted (not the original draft)", async () => {
    const { name, root } = makeProject();
    const loom = envReviewLoom(name);
    const edited: ServersConfig = {
      version: 1,
      driver: "host-process",
      services: {
        web: { command: "npm run dev", portStrategy: "fixed", port: 8080, env: {}, dependsOn: [], readyCheck: { kind: "http", path: "/health", status: 200 } },
      },
    };
    const ok = await approveEnv(loom.id, "alice", edited, fakeDeps().deps);
    expect(ok).toBe(true);
    const persisted = resolveServersConfig(root);
    expect(persisted.services.web.command).toBe("npm run dev");
    expect(persisted.services.web.port).toBe(8080); // the STEERED value, not the draft's 3000
  });

  test("13. from a non-env-review state → false, no write, no dispatch", async () => {
    const { name, root } = makeProject();
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "ready";
    loom.proposedServers = laneCfg;
    saveLoom(loom);
    const f = fakeDeps();
    const ok = await approveEnv(loom.id, "alice", undefined, f.deps);
    expect(ok).toBe(false);
    expect(f.calls).toBe(0);
    expect(fs.existsSync(path.join(root, ".telar", "servers.yaml"))).toBe(false);
  });
});

// ── E. persistence + precedence ─────────────────────────────────────────────
describe("E. .telar persistence + precedence", () => {
  test("14. accepted .telar tier wins over a repo servers.yaml", () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, "servers.yaml"),
      "version: 1\ndriver: host-process\nservices:\n  web:\n    command: repo-cmd\n    portStrategy: fixed\n    port: 1111\n",
    );
    writeAcceptedServersConfig(root, laneCfg); // .telar tier
    const cfg = resolveServersConfig(root);
    expect(cfg.services.web.command).toBe("bun dev"); // .telar wins
    expect(cfg.services.web.port).toBe(3000);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("15. worktree caveat: .telar at manifest.root is seen from a distinct worktree dir", () => {
    const rootDir = tmpRoot();
    const wt = tmpRoot(); // a distinct dir with NO .telar (mimics a frozen worktree)
    writeAcceptedServersConfig(rootDir, laneCfg);
    const cfg = resolveServersConfig(wt, rootDir); // acceptedRoot = manifest.root
    expect(cfg.driver).toBe("host-process");
    expect(cfg.services.web.command).toBe("bun dev");
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  test("16. ENOENT falls through tiers; a malformed .telar/servers.yaml throws", () => {
    const root = tmpRoot();
    expect(resolveServersConfig(root).driver).toBe("none"); // both tiers absent → none
    fs.mkdirSync(path.join(root, ".telar"), { recursive: true });
    fs.writeFileSync(path.join(root, ".telar", "servers.yaml"), "services: [unterminated\n");
    expect(() => resolveServersConfig(root)).toThrow(/Malformed YAML/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── F. reject + moat ────────────────────────────────────────────────────────
describe("F. reject + moat", () => {
  test("17. rejectLoom from env-review → honest needs-review (no re-dispatch, no block)", async () => {
    const { name } = makeProject();
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "env-review";
    loom.proposedServers = laneCfg;
    saveLoom(loom);
    const f = fakeDeps();

    const out = await rejectLoom(loom.id, "not how we run this app", "you", f.deps);
    expect(out.state).toBe("needs-review");
    expect(out.state).not.toBe("done");
    expect(out.proposedServers).toBeUndefined();
    expect(f.calls).toBe(0); // terminal — does NOT re-trigger the gate
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "rejected").length).toBe(1);
  });

  test("18. moat: a green (re)verify lands ROOT `ready`; only acceptLoom + human `by` reaches `done`", () => {
    // A green verify routes through terminalStateForCompletedLoom for a root.
    expect(terminalStateForCompletedLoom({ parentLoomId: undefined })).toBe("ready");
    expect(decideVerifyLoom("pass", { parentLoomId: undefined }).state).toBe("ready");

    const { name } = makeProject();
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    loom.state = "ready";
    saveLoom(loom);
    // Nothing but acceptLoom + a human `by` promotes a green loom to done.
    const done = acceptLoom(loom.id, "you");
    expect(done.state).toBe("done");
    expect(done.acceptedOverride).toBeFalsy(); // clean accept of green
  });
});

// ── E10. root/child propagation on a weave-of-one (THE fix) ──────────────────
describe("E10. env-review lifts to the ROOT", () => {
  // A minimal fake Loom for the pure/fakes runWeave drive (mirrors weave.test).
  let fakeN = 0;
  function fakeLoom(overrides: Partial<Loom> = {}): Loom {
    fakeN++;
    return {
      id: `e10_${fakeN}`,
      project: "m7",
      kind: "custom",
      title: "t",
      prompt: "x",
      account: "personal",
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: [],
      error: null,
      ...overrides,
    };
  }
  function subGoal(id: string) {
    return {
      id,
      title: "title",
      detail: "detail",
      proofStrategy: "custom" as const,
      acceptanceCriteria: [],
      dependsOn: [],
      required: true,
      status: "pending" as const,
    };
  }

  test("19a. rollupWeave (pure): a required child in env-review → {state:'env-review'} (ordered before the generic needs-review fallthrough)", () => {
    const decomposition = [subGoal("s1")];
    const children = [fakeLoom({ subGoalId: "s1", state: "env-review", proposedServers: laneCfg })];
    expect(rollupWeave(children, decomposition)).toEqual({ state: "env-review" });
  });

  test("19b. runWeave (weave-of-one): the CHILD diverts to env-review → the ROOT lifts BOTH state AND proposedServers (so the human answers on the root)", async () => {
    const decomposition = [subGoal("s1")];
    const root = fakeLoom({ id: "e10_root" });
    const result = await runWeave(root, decomposition, {
      spawnChild: (sg) => fakeLoom({ subGoalId: sg.id, state: "queued" }),
      runChild: async (child) => {
        // the CHILD is what verifies + diverts (executor's proposeEnvOrNeedsReview)
        child.state = "env-review";
        child.proposedServers = laneCfg;
        return child;
      },
    });
    expect(result.state).toBe("env-review"); // lifted to the root
    expect(result.proposedServers).toEqual(laneCfg); // ...along with the draft (E10)
  });

  test("19c. reject on the ROOT is terminal AND resets the orphaned child (env-review → needs-review, drafts cleared, no re-dispatch, no servers.yaml)", async () => {
    const { name, root: projRoot } = makeProject({ envReview: true });
    const rootLoom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: "personal" });
    rootLoom.state = "env-review";
    rootLoom.proposedServers = laneCfg; // lifted from the child (E10)
    saveLoom(rootLoom);
    // the orphaned single child still parked in env-review
    const child = createLoom({ project: name, kind: "custom", title: "c", prompt: "x", account: "personal", parentLoomId: rootLoom.id, subGoalId: "s1" });
    child.state = "env-review";
    child.proposedServers = laneCfg;
    saveLoom(child);

    const f = fakeDeps();
    const out = await rejectLoom(rootLoom.id, "not how we run this app", "you", f.deps);

    expect(out.state).toBe("needs-review"); // root: honest terminal
    expect(out.proposedServers).toBeUndefined();
    expect(f.calls).toBe(0); // NO re-dispatch (else an infinite gate)
    const afterChild = getLoom(child.id)!;
    expect(afterChild.state).toBe("needs-review"); // child reset so a resume re-runs clean
    expect(afterChild.proposedServers).toBeUndefined();
    // the rejected draft was never persisted
    expect(fs.existsSync(path.join(projRoot, ".telar", "servers.yaml"))).toBe(false);
    fs.rmSync(projRoot, { recursive: true, force: true });
  });

  test("19d. a verify-kind loom is always a root — its divert lands env-review directly (no propagation needed)", () => {
    // rollupWeave never runs for a non-woven verify loom; the executor's divert
    // sets the loom's own state. Assert the divert target is a valid held gate.
    expect(decideVerifyLoom("skip", { parentLoomId: undefined }).state).toBe("needs-review");
    // (the env-review divert pre-empts decideVerifyLoom; see B/test 2 for the
    // executeLoom analogue — this documents that a verify root holds it directly.)
    expect(reconcileState("env-review")).toBe("leave");
  });
});

// ── G. exhaustiveness smoke ─────────────────────────────────────────────────
describe("G. exhaustiveness", () => {
  test("20. reconcileState('env-review') === 'leave' (awaiting a human)", () => {
    expect(reconcileState("env-review")).toBe("leave");
  });
});
