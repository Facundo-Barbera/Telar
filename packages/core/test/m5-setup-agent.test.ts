// M5 setup agent — fake agent + fake lane + fake resolveServersConfig. No real
// agent runs, no lane spawns, no repo touched. Proves: lane bring-up, authoring
// a missing servers.yaml, bounded repair, validate-and-teardown, the tool wall,
// and the moat ({ready:false} carries an error and never claims success).
import { describe, expect, test } from "bun:test";
import { runSetupAgent, type SetupDeps } from "../src/setup/setup-agent";
import { ProjectManifest, type ServersConfig } from "../src/schemas";
import type { Lane } from "../src/run-server";
import type { Loom } from "../src/looms";

function manifest(root = "/proj", guardrails?: { disallowedTools?: string[]; protectedPaths?: string[] }) {
  return ProjectManifest.parse({ name: "p", root, ...(guardrails ? { guardrails } : {}) });
}
function loom(): Loom {
  return {
    id: "L1",
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state: "preparing",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
  };
}

const noneCfg: ServersConfig = { version: 1, driver: "none", services: {} };
const laneCfg: ServersConfig = {
  version: 1,
  driver: "host-process",
  services: {
    web: { command: "bun dev", portStrategy: "dynamic", env: {}, dependsOn: [], readyCheck: { kind: "http", path: "/", status: 200 } },
  },
};

// A fake agent capturing opts; scripted to return a wroteServersYaml result.
function fakeAgent(result: { wroteServersYaml: boolean; error?: string }) {
  const opts: unknown[] = [];
  const fn = (async (_task: string, o: unknown) => {
    opts.push(o);
    return result;
  }) as unknown as SetupDeps["agent"];
  return { fn, opts };
}

function fakeLane(): Lane & { stopped: number } {
  const lane = { services: {}, stopped: 0, stopAll: async () => { lane.stopped++; } };
  return lane;
}

describe("runSetupAgent", () => {
  test("lane comes up + readyCheck passes → {ready:true}; teardown in finally", async () => {
    const lane = fakeLane();
    let laneStarts = 0;
    const agent = fakeAgent({ wroteServersYaml: false });
    const res = await runSetupAgent(loom(), manifest(), {
      agent: agent.fn,
      resolveServersConfig: () => laneCfg,
      startLane: async () => { laneStarts++; return lane; },
    });
    expect(res).toEqual({ ready: true, wroteServersYaml: false });
    expect(laneStarts).toBe(1);
    expect(lane.stopped).toBe(1); // validate-and-teardown
    expect(agent.opts.length).toBe(0); // recipe already present → no agent
  });

  test("driver:none → agent authors servers.yaml, re-parse yields a lane → {ready:true, wroteServersYaml:true}", async () => {
    const lane = fakeLane();
    const agent = fakeAgent({ wroteServersYaml: true });
    let resolveCalls = 0;
    const res = await runSetupAgent(loom(), manifest(), {
      agent: agent.fn,
      // 1st resolve: no recipe → author. 2nd resolve (after author): a lane.
      resolveServersConfig: () => (++resolveCalls === 1 ? noneCfg : laneCfg),
      startLane: async () => lane,
    });
    expect(res).toEqual({ ready: true, wroteServersYaml: true });
    expect(agent.opts.length).toBe(1); // authored once
    expect(lane.stopped).toBe(1);
  });

  test("driver:none and no server needed (agent authors nothing) → {ready:true} with no lane", async () => {
    const agent = fakeAgent({ wroteServersYaml: false });
    let laneStarts = 0;
    const res = await runSetupAgent(loom(), manifest(), {
      agent: agent.fn,
      resolveServersConfig: () => noneCfg,
      startLane: async () => { laneStarts++; return fakeLane(); },
    });
    expect(res).toEqual({ ready: true, wroteServersYaml: false });
    expect(laneStarts).toBe(0); // nothing to bring up
  });

  test("startLane keeps failing → bounded agent repair, exhausts → {ready:false, error}", async () => {
    const agent = fakeAgent({ wroteServersYaml: true });
    let laneStarts = 0;
    const res = await runSetupAgent(loom(), manifest(), {
      agent: agent.fn,
      resolveServersConfig: () => laneCfg,
      startLane: async () => { laneStarts++; throw new Error(`lane: service "web" not ready`); },
      maxRepairs: 2,
    });
    expect(res.ready).toBe(false);
    expect(res.error).toMatch(/not ready/);
    expect(laneStarts).toBe(3); // initial + 2 repairs
    expect(agent.opts.length).toBe(2); // one fix agent per failed attempt (except the last)
  });

  test("tool wall (D9): Write+Bash, restrictTools, disallow Agent/Edit/MultiEdit + guardrails, pinned cwd", async () => {
    const agent = fakeAgent({ wroteServersYaml: true });
    await runSetupAgent(loom(), manifest("/proj", { disallowedTools: ["CustomBad"], protectedPaths: ["secrets/**"] }), {
      agent: agent.fn,
      resolveServersConfig: (() => {
        let c = 0;
        return () => (++c === 1 ? noneCfg : laneCfg);
      })(),
      startLane: async () => fakeLane(),
      cwd: "/proj/worktree",
    });
    const o = agent.opts[0] as {
      tools: string[];
      restrictTools: boolean;
      disallowedTools: string[];
      settingSources: unknown[];
      cwd: string;
    };
    expect(o.tools).toEqual(["Read", "Grep", "Glob", "Write", "Bash"]);
    expect(o.restrictTools).toBe(true);
    expect(o.disallowedTools).toEqual(["Agent", "Edit", "MultiEdit", "CustomBad"]);
    expect(o.settingSources).toEqual([]);
    expect(o.cwd).toBe("/proj/worktree"); // pinned to the loom worktree (off the telar repo/~/.telar)
  });
});
