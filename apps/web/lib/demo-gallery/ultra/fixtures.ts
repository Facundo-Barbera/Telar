// LANE: ultra (NEW) — the story fixture for round 26: a believable Ultra run
// authored by a chat session's main agent — "Quick-wins batch: recon → 3
// parallel lanes → gate → commit" — with 8 subagents, a narrator log, per-agent
// token/cost, one agent that fails and is retried, a reservation-based budget,
// and the final structured result. All virtual-time (ms); the demo's fake
// EventSource replays it. No SDK/core imports — pure data.

export type AgentState =
  | "queued"
  | "running"
  | "retrying"
  | "done"
  | "failed"
  | "stopped";

export type RunState = "running" | "stopped" | "completed" | "failed";

export type Provider = "claude" | "codex";

export type JsonRecord = Record<string, unknown>;

export type TranscriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: string }
  | { kind: "tool-result"; text: string }
  | { kind: "result"; json: JsonRecord };

export interface AgentDef {
  id: string;
  label: string;
  phaseId: string;
  startAt: number;
  endAt: number;
  endState: "done" | "failed";
  reservedUsd: number; // the per-agent max reserved before spawn (§3)
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  snippets: { at: number; text: string }[];
  // lane-tests: emit_result returned null → executor-side validate-and-retry.
  retry?: { failAt: number; retryAt: number; error: string };
  transcript: TranscriptStep[];
}

export interface PhaseDef {
  id: string;
  title: string;
  kind: "sequential" | "parallel";
  activateAt: number;
}

export interface LogLine {
  at: number;
  text: string;
}

export interface Scenario {
  endClock: number; // clock at which the run freezes into its terminal state
  terminal: RunState;
  budgetUsd: number; // USD ceiling for this scenario
  error?: string; // terminal error for `failed`
}

export const RUN_META = {
  name: "Quick-wins batch",
  description: "recon → 3 parallel lanes → gate → commit",
  phases: ["Recon", "Parallel lanes", "Gate", "Commit"],
} as const;

export const RUN_ARGS: JsonRecord = { batch: "quick-wins" };

export const END_CLOCK = 12000;
export const RESULT_AT = 12000;
export const AGENT_RESERVE = 0.6; // run-default per-agent reservation

export const PHASES: PhaseDef[] = [
  { id: "recon", title: "Recon", kind: "parallel", activateAt: 300 },
  { id: "lanes", title: "Parallel lanes", kind: "parallel", activateAt: 3200 },
  { id: "gate", title: "Gate", kind: "parallel", activateAt: 8400 },
  { id: "commit", title: "Commit", kind: "sequential", activateAt: 11000 },
];

export const AGENTS: AgentDef[] = [
  {
    id: "recon-web",
    label: "recon-web",
    phaseId: "recon",
    startAt: 500,
    endAt: 2600,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.18,
    tokensIn: 14200,
    tokensOut: 2100,
    snippets: [
      { at: 500, text: "reading apps/web/app/**" },
      { at: 1300, text: "grep TODO|FIXME across 82 files" },
      { at: 2100, text: "ranking 6 quick-win targets" },
    ],
    transcript: [
      { kind: "text", text: "Scanning apps/web for low-risk quick-wins." },
      { kind: "tool", tool: "Grep", input: "TODO|FIXME  apps/web  -n" },
      { kind: "tool-result", text: "47 hits across 18 files" },
      { kind: "tool", tool: "Read", input: "apps/web/lib/format.ts" },
      {
        kind: "result",
        json: {
          module: "apps/web",
          targets: ["type-narrowing in format.ts", "unused imports x3"],
          risk: "low",
        },
      },
    ],
  },
  {
    id: "recon-core",
    label: "recon-core",
    phaseId: "recon",
    startAt: 500,
    endAt: 3000,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.24,
    tokensIn: 20100,
    tokensOut: 3400,
    snippets: [
      { at: 500, text: "reading packages/core/src/**" },
      { at: 1600, text: "running tsc --noEmit to collect errors" },
      { at: 2500, text: "clustering 12 type errors by file" },
    ],
    transcript: [
      { kind: "text", text: "Mapping packages/core quick-wins." },
      { kind: "tool", tool: "Bash", input: "bunx tsc -p packages/core --noEmit" },
      { kind: "tool-result", text: "12 errors, 3 flaky tests flagged" },
      {
        kind: "result",
        json: {
          module: "packages/core",
          typeErrors: 12,
          flakyTests: ["journal.resume", "budget.reserve", "abort.propagate"],
          risk: "low",
        },
      },
    ],
  },
  {
    id: "lane-types",
    label: "lane-types",
    phaseId: "lanes",
    startAt: 3400,
    endAt: 6400,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.42,
    tokensIn: 31800,
    tokensOut: 6900,
    snippets: [
      { at: 3400, text: "opening the 12 flagged type errors" },
      { at: 4400, text: "editing packages/core/src/ultra/budget.ts" },
      { at: 5400, text: "re-running tsc — 3 errors left" },
      { at: 6100, text: "tsc clean, 12/12 fixed" },
    ],
    transcript: [
      { kind: "text", text: "Fixing the 12 type errors recon flagged." },
      { kind: "tool", tool: "Edit", input: "budget.ts  reserved(): number" },
      { kind: "tool", tool: "Edit", input: "journal.ts  narrow ordinal → number" },
      { kind: "tool", tool: "Bash", input: "bunx tsc -p packages/core --noEmit" },
      { kind: "tool-result", text: "exit 0" },
      { kind: "result", json: { fixes: 12, files: 4 } },
    ],
  },
  {
    id: "lane-tests",
    label: "lane-tests",
    phaseId: "lanes",
    startAt: 3400,
    endAt: 8200,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.55,
    tokensIn: 40200,
    tokensOut: 8100,
    retry: {
      failAt: 5200,
      retryAt: 5500,
      error: "agent returned null — emit_result never fired (no structured output)",
    },
    snippets: [
      { at: 3400, text: "reproducing 3 flaky tests" },
      { at: 4600, text: "patching a timing race in journal.resume" },
      { at: 5500, text: "re-spawn (1/2): correction appendix attached" },
      { at: 6400, text: "reproducing under --rerun-each=20" },
      { at: 7600, text: "3/3 green, 0 flakes in 20 runs" },
    ],
    transcript: [
      { kind: "text", text: "Stabilizing 3 flaky tests from recon." },
      { kind: "tool", tool: "Bash", input: "bun test --rerun-each=20 journal.resume" },
      { kind: "tool-result", text: "2/20 fail — timing race" },
      {
        kind: "text",
        text: "[attempt 1 returned null — no emit_result; re-spawned with correction]",
      },
      { kind: "tool", tool: "Edit", input: "journal.resume.test.ts  await flush()" },
      { kind: "tool-result", text: "20/20 pass" },
      { kind: "result", json: { flakesFixed: 3, retried: true } },
    ],
  },
  {
    id: "lane-docs",
    label: "lane-docs",
    phaseId: "lanes",
    startAt: 3400,
    endAt: 5900,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.16,
    tokensIn: 12400,
    tokensOut: 4200,
    snippets: [
      { at: 3400, text: "reading docs/plans/ultra-harness.md" },
      { at: 4600, text: "syncing the injected-surface table" },
      { at: 5500, text: "2 files touched" },
    ],
    transcript: [
      { kind: "text", text: "Refreshing the two docs recon flagged as stale." },
      { kind: "tool", tool: "Edit", input: "docs/PRINCIPLES.md  §threads wording" },
      { kind: "tool", tool: "Edit", input: "README.md  ultra one-liner" },
      { kind: "result", json: { filesTouched: 2 } },
    ],
  },
  {
    id: "gate-tsc",
    label: "gate-tsc",
    phaseId: "gate",
    startAt: 8600,
    endAt: 10200,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.21,
    tokensIn: 9800,
    tokensOut: 1400,
    snippets: [
      { at: 8600, text: "tsc -p packages/core --noEmit" },
      { at: 9400, text: "tsc -p apps/web --noEmit" },
      { at: 10000, text: "both clean" },
    ],
    transcript: [
      { kind: "tool", tool: "Bash", input: "bunx tsc -p packages/core --noEmit" },
      { kind: "tool-result", text: "exit 0" },
      { kind: "tool", tool: "Bash", input: "bunx tsc -p apps/web --noEmit" },
      { kind: "tool-result", text: "exit 0" },
      { kind: "result", json: { tsc: "pass" } },
    ],
  },
  {
    id: "gate-test",
    label: "gate-test",
    phaseId: "gate",
    startAt: 8600,
    endAt: 10800,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.28,
    tokensIn: 15600,
    tokensOut: 2200,
    snippets: [
      { at: 8600, text: "bun test packages/core" },
      { at: 9800, text: "148 pass, 0 fail" },
      { at: 10500, text: "suite green" },
    ],
    transcript: [
      { kind: "tool", tool: "Bash", input: "bun test packages/core" },
      { kind: "tool-result", text: "148 pass / 0 fail (11.2s)" },
      { kind: "result", json: { tests: "pass", count: 148 } },
    ],
  },
  {
    id: "commit",
    label: "commit",
    phaseId: "commit",
    startAt: 11100,
    endAt: 11900,
    endState: "done",
    reservedUsd: AGENT_RESERVE,
    costUsd: 0.08,
    tokensIn: 4200,
    tokensOut: 600,
    snippets: [
      { at: 11100, text: "staging 8 files" },
      { at: 11500, text: "writing conventional message" },
    ],
    transcript: [
      { kind: "tool", tool: "Bash", input: "git add -A && git commit -m …" },
      { kind: "tool-result", text: "[main 4f2a1c9] fix: quick-wins batch" },
      { kind: "result", json: { sha: "4f2a1c9", pushed: false } },
    ],
  },
];

export const LOG_LINES: LogLine[] = [
  { at: 300, text: "phase → Recon" },
  { at: 3050, text: "recon settled — 2 modules mapped, 12 type errors + 3 flaky tests" },
  { at: 3200, text: "phase → Parallel lanes (3)" },
  { at: 5210, text: "lane-tests returned null — re-spawning with correction (1/2)" },
  { at: 6450, text: "lane-types done · lane-docs done" },
  { at: 8250, text: "lanes settled — all 3 landed" },
  { at: 8400, text: "phase → Gate" },
  { at: 10850, text: "gate green — tsc + tests pass" },
  { at: 11000, text: "phase → Commit" },
  { at: 11950, text: "committed 4f2a1c9 (not pushed)" },
];

export const FINAL_RESULT: JsonRecord = {
  batch: "quick-wins",
  recon: { modules: ["apps/web", "packages/core"], findings: 15 },
  lanes: {
    types: { fixes: 12, files: 4 },
    tests: { flakesFixed: 3, retried: true },
    docs: { filesTouched: 2 },
  },
  gate: { tsc: "pass", tests: "pass" },
  commit: { sha: "4f2a1c9", pushed: false },
  spentUsd: 2.12,
  agents: 8,
};

// The script the session's main agent authored — shown read-only in the
// inspector's Script view. Mirrors the frozen injected surface (§3).
export const SCRIPT_SOURCE = `export const meta = {
  name: "Quick-wins batch",
  description: "recon → 3 parallel lanes → gate → commit",
  phases: ["Recon", "Parallel lanes", "Gate", "Commit"],
};

export default async function ({ agent, parallel, phase, log, budget, args }) {
  phase("Recon");
  const [web, core] = await parallel([
    () => agent("Map quick-win targets in apps/web",     { label: "recon-web",  schema: Recon }),
    () => agent("Map quick-win targets in packages/core", { label: "recon-core", schema: Recon }),
  ]);
  log(\`recon settled — \${[web, core].filter(Boolean).length} modules mapped\`);

  phase("Parallel lanes");
  const [types, tests, docs] = await parallel([
    () => agent("Fix the type errors recon flagged",  { label: "lane-types", schema: Lane }),
    () => agent("Fix the flaky tests recon flagged",  { label: "lane-tests", schema: Lane }),
    () => agent("Refresh the docs recon flagged",     { label: "lane-docs",  schema: Lane }),
  ]);

  phase("Gate");
  const [tsc, test] = await parallel([
    () => agent("Run tsc across the workspace", { label: "gate-tsc",  schema: Gate }),
    () => agent("Run the core test suite",      { label: "gate-test", schema: Gate }),
  ]);
  log("gate green");

  phase("Commit");
  const commit = await agent("Commit the batch with a conventional message", {
    label: "commit", schema: Commit,
  });

  return { batch: args.batch, recon: { web, core },
           lanes: { types, tests, docs }, gate: { tsc, test }, commit,
           spentUsd: budget.spent(), agents: 8 };
}`;

// The three reachable terminal outcomes (contract §6.4). `completed` runs the
// whole timeline; `stopped`/`failed` freeze partway.
export const SCENARIOS: Record<"completed" | "stopped" | "failed", Scenario> = {
  completed: { endClock: END_CLOCK, terminal: "completed", budgetUsd: 5 },
  stopped: { endClock: 7000, terminal: "stopped", budgetUsd: 5 },
  failed: {
    endClock: 5300,
    terminal: "failed",
    budgetUsd: 1.5,
    error:
      "BudgetExhausted — reservation $0.60 won't fit in remaining $0.24 (total $1.50). Unwound past the parallel barrier; 3 lanes clamped.",
  },
};
