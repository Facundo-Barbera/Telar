// M5 setup agent — the scoped agent that runs in the `preparing` window (before
// any build child spawns): brings the project's env lane up and, if there is no
// recipe yet, authors a `servers.yaml` and verifies the readyCheck. It composes
// EXISTING primitives only (resolveServersConfig, startLane, the agent() seam) —
// no re-implemented port/topo/readyCheck logic.
//
// Ownership = validate-and-teardown (D8): bring the lane up → confirm ready →
// tear it down in `finally`. The ONLY persistent side effect is an authored
// servers.yaml. Build/verify phases keep owning their own lanes.
//
// MOAT: this is a PRE-BUILD phase. It never runs at verify time, never touches
// who-accepts, and on failure returns { ready:false } so the weave lands
// needs-review/failed — NEVER done.
import { z } from "zod";
import { agent as defaultAgent, type AgentOpts } from "../engine";
import { startLane as defaultStartLane, type Lane, type StartLaneOpts } from "../run-server";
import { resolveServersConfig as defaultResolveServersConfig } from "../servers";
import type { Loom } from "../looms";
import type { AccountProfile, ProjectManifest, ServersConfig } from "../schemas";

export type SetupResult = { ready: boolean; wroteServersYaml?: boolean; error?: string };

// Injectable seams — tests swap ALL of these for fakes so no real agent runs,
// no lane spawns, and no repo is touched.
export type SetupDeps = {
  agent?: typeof defaultAgent;
  startLane?: (config: ServersConfig, root: string, opts?: StartLaneOpts) => Promise<Lane>;
  resolveServersConfig?: (root: string) => ServersConfig;
  account?: AccountProfile;
  model?: string;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  cwd?: string; // pinned agent cwd — loom worktree under isolation, else manifest.root
  maxRepairs?: number; // bounded lane-bring-up repair attempts (default 3)
};

// What the agent emits when it authors/repairs the lane recipe.
const SetupAgentResult = z.object({
  wroteServersYaml: z.boolean().default(false),
  error: z.string().optional(),
});

// D9 tool wall — NOT read-only (unlike scoping/verifier): Write + Bash + reads,
// hard-restricted, no sub-agents / arbitrary edits, cwd pinned off the telar
// repo/~/.telar, project guardrails folded in.
function setupAgentOpts(
  manifest: ProjectManifest,
  deps: SetupDeps,
  cwd: string,
): Omit<AgentOpts<typeof SetupAgentResult.shape>, "schema"> & { schema: typeof SetupAgentResult } {
  return {
    schema: SetupAgentResult,
    tools: ["Read", "Grep", "Glob", "Write", "Bash"],
    restrictTools: true,
    // No sub-agents, no arbitrary edits (writes only via Write), plus the
    // project's own guardrail disallows.
    disallowedTools: ["Agent", "Edit", "MultiEdit", ...manifest.guardrails.disallowedTools],
    settingSources: [],
    cwd,
    account: deps.account,
    model: deps.model,
    onEvent: deps.onEvent as AgentOpts<typeof SetupAgentResult.shape>["onEvent"],
  };
}

function guardrailsBlock(manifest: ProjectManifest): string {
  const protectedPaths = manifest.guardrails.protectedPaths;
  return protectedPaths.length
    ? `\nGuardrails — do NOT write, move, or delete these protected paths:\n${protectedPaths.map((p) => `- ${p}`).join("\n")}\n`
    : "";
}

const AUTHOR_TASK = (manifest: ProjectManifest) => `You are the Telar SETUP AGENT preparing this project's dev environment.
There is currently NO servers.yaml recipe. Probe the repository (package.json
scripts, framework config, existing docs) to determine how to start the dev
server: the start command, the port it binds, and a real readiness signal.

Author a servers.yaml at the repo root that conforms to Telar's ServersConfig:
- driver: host-process
- one service with: command, portStrategy (fixed|dynamic), and (for fixed) port
- a DECLARED readyCheck — either { kind: http, path, status } or
  { kind: command, run } — NOT a "any response = up" fallback.
Only write servers.yaml (via the Write tool). Do not start long-lived servers.
${guardrailsBlock(manifest)}
Emit { wroteServersYaml: true } if you wrote the file, else
{ wroteServersYaml: false, error: <why you could not> }.`;

const REPAIR_TASK = (manifest: ProjectManifest, error: string) => `You are the Telar SETUP AGENT. Bringing the lane up from servers.yaml FAILED:

${error}

Diagnose and FIX servers.yaml (command, env, port, or readyCheck) so the lane
comes up. Only edit servers.yaml via the Write tool; do not start long-lived
servers yourself.
${guardrailsBlock(manifest)}
Emit { wroteServersYaml: true } once you have rewritten servers.yaml.`;

// Bring the lane up once. startLane awaits each service's declared readyCheck
// internally, so a resolved lane == ready. Returns the lane (caller tears it
// down) or throws the structured bring-up error.
async function bringUp(
  startLaneFn: NonNullable<SetupDeps["startLane"]>,
  cfg: ServersConfig,
  cwd: string,
): Promise<Lane> {
  return startLaneFn(cfg, cwd, { captureLogs: true });
}

export async function runSetupAgent(loom: Loom, manifest: ProjectManifest, deps: SetupDeps = {}): Promise<SetupResult> {
  const runAgent = deps.agent ?? defaultAgent;
  const startLaneFn = deps.startLane ?? defaultStartLane;
  const resolveCfg = deps.resolveServersConfig ?? defaultResolveServersConfig;
  const emit = deps.onEvent ?? (() => {});
  const cwd = deps.cwd ?? manifest.root;
  const maxRepairs = deps.maxRepairs ?? 3;

  let wroteServersYaml = false;
  emit({ type: "setup-started" });

  let cfg = resolveCfg(manifest.root);

  // (1) No recipe yet → author one via the agent, then re-parse from disk.
  if (cfg.driver === "none") {
    emit({ type: "setup-authoring-servers-yaml" });
    const res = await runAgent(AUTHOR_TASK(manifest), setupAgentOpts(manifest, deps, cwd));
    if (res?.wroteServersYaml) {
      wroteServersYaml = true;
      cfg = resolveCfg(manifest.root);
      emit({ type: "setup-authored-servers-yaml" });
    }
  }

  // No lane to bring up (no recipe authored, or the project genuinely needs no
  // server) → the environment is "ready" as-is. Nothing to tear down.
  if (cfg.driver === "none") {
    emit({ type: "setup-ready", wroteServersYaml, lane: false });
    return { ready: true, wroteServersYaml };
  }

  // (2) Bring the lane up, with bounded agent-assisted repair on failure.
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    let lane: Lane | null = null;
    try {
      lane = await bringUp(startLaneFn, cfg, cwd);
      emit({ type: "setup-ready", wroteServersYaml, lane: true });
      return { ready: true, wroteServersYaml };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "setup-bring-up-failed", attempt, message });
      if (attempt >= maxRepairs) {
        return { ready: false, wroteServersYaml, error: message };
      }
      // Feed the structured error to the agent to fix the recipe, then re-parse.
      const res = await runAgent(REPAIR_TASK(manifest, message), setupAgentOpts(manifest, deps, cwd));
      if (res?.wroteServersYaml) wroteServersYaml = true;
      cfg = resolveCfg(manifest.root);
      if (cfg.driver === "none") {
        // The repair removed the recipe entirely — treat as no lane needed.
        emit({ type: "setup-ready", wroteServersYaml, lane: false });
        return { ready: true, wroteServersYaml };
      }
    } finally {
      // Validate-and-teardown (D8): the lane is a probe, not a persistent side
      // effect. Idempotent; a teardown error never masks the setup result.
      if (lane) await lane.stopAll().catch(() => {});
    }
  }

  return { ready: false, wroteServersYaml, error: "setup: exhausted lane bring-up repair attempts" };
}
