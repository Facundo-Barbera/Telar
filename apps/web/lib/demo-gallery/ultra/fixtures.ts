// LANE: ultra (NEW) — story fixtures for the round-26 v2 rebuild (§6 v2 of
// docs/plans/ultra-harness.md). A chat SESSION whose main agent launches
// several Ultra runs as side quests: "Quick-wins batch" (completed), a
// "Doc-staleness sweep" (still running), and a "Flaky-test triage" the agent
// STOPS by tool call. Everything is virtual-time (ms on ONE session clock); the
// demo's fake EventSource replays it. No budgets anywhere — spend is a readout
// only (USD, the session's cost language). Every agent() names model·effort.
// Pure data — no SDK/core imports.

export type AgentState =
  | "queued"
  | "running"
  | "retrying"
  | "done"
  | "failed"
  | "stopped";

export type RunState = "running" | "stopped" | "completed" | "failed";

export type JsonRecord = Record<string, unknown>;

export type TranscriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: string }
  | { kind: "tool-result"; text: string }
  | { kind: "result"; json: JsonRecord };

export interface AgentDef {
  ordinal: number; // THE key everywhere (§3) — assigned at issue order
  label: string;
  phaseId: string;
  model: string; // explicit per call (§4) — shown as a model·effort chip
  effort: string;
  startAt: number; // run-local ms (relative to the run's launch)
  endAt: number;
  endState: "done" | "failed";
  costUsd: number; // settled cost — cost VISIBILITY, never a budget
  tokensIn: number;
  tokensOut: number;
  snippets: { at: number; text: string }[];
  // executor-side validate-and-retry (K=2): emit_result returned null once.
  retry?: { failAt: number; retryAt: number; error: string };
  transcript: TranscriptStep[];
}

export interface PhaseDef {
  id: string;
  title: string;
  kind: "sequential" | "parallel";
  activateAt: number; // run-local ms
}

export interface LogLine {
  at: number; // run-local ms
  text: string;
}

export interface RunDef {
  id: string; // runId
  name: string;
  blurb: string;
  launchAt: number; // SESSION-clock ms when the anchor appears / run starts
  duration: number; // run-local ms to natural terminal
  terminal: RunState; // natural terminal if never stopped
  stopAt: number | null; // SESSION-clock ms the AGENT stops it by tool call
  phases: PhaseDef[];
  agents: AgentDef[]; // times run-local
  log: LogLine[]; // run-local
  script: string; // read-only source (model pins visible)
  result: JsonRecord | null; // completed result, reachable from the rail card
}

/* ------------------------------------------------------------ run A: batch */

const A_AGENTS: AgentDef[] = [
  {
    ordinal: 1,
    label: "recon-web",
    phaseId: "recon",
    model: "sonnet-4.5",
    effort: "med",
    startAt: 300,
    endAt: 1700,
    endState: "done",
    costUsd: 0.18,
    tokensIn: 14200,
    tokensOut: 2100,
    snippets: [
      { at: 300, text: "reading apps/web/app/**" },
      { at: 900, text: "grep TODO|FIXME across 82 files" },
      { at: 1400, text: "ranking 6 quick-win targets" },
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
    ordinal: 2,
    label: "recon-core",
    phaseId: "recon",
    model: "sonnet-4.5",
    effort: "med",
    startAt: 300,
    endAt: 2000,
    endState: "done",
    costUsd: 0.24,
    tokensIn: 20100,
    tokensOut: 3400,
    snippets: [
      { at: 300, text: "reading packages/core/src/**" },
      { at: 1100, text: "running tsc --noEmit to collect errors" },
      { at: 1700, text: "clustering 12 type errors by file" },
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
          flakyTests: ["journal.resume", "abort.propagate", "ordinal.hash"],
          risk: "low",
        },
      },
    ],
  },
  {
    ordinal: 3,
    label: "lane-types",
    phaseId: "lanes",
    model: "opus-4.8",
    effort: "high",
    startAt: 2300,
    endAt: 4400,
    endState: "done",
    costUsd: 0.42,
    tokensIn: 31800,
    tokensOut: 6900,
    snippets: [
      { at: 2300, text: "opening the 12 flagged type errors" },
      { at: 3200, text: "editing packages/core/src/ultra/journal.ts" },
      { at: 3900, text: "re-running tsc — 3 errors left" },
      { at: 4200, text: "tsc clean, 12/12 fixed" },
    ],
    transcript: [
      { kind: "text", text: "Fixing the 12 type errors recon flagged." },
      { kind: "tool", tool: "Edit", input: "journal.ts  narrow ordinal → number" },
      { kind: "tool", tool: "Edit", input: "executor.ts  emit path return type" },
      { kind: "tool", tool: "Bash", input: "bunx tsc -p packages/core --noEmit" },
      { kind: "tool-result", text: "exit 0" },
      { kind: "result", json: { fixes: 12, files: 4 } },
    ],
  },
  {
    ordinal: 4,
    label: "lane-tests",
    phaseId: "lanes",
    model: "opus-4.8",
    effort: "high",
    startAt: 2300,
    endAt: 5600,
    endState: "done",
    costUsd: 0.55,
    tokensIn: 40200,
    tokensOut: 8100,
    retry: {
      failAt: 3600,
      retryAt: 3900,
      error: "returned null — emit_result never fired; validate-and-retry (1/2)",
    },
    snippets: [
      { at: 2300, text: "reproducing 3 flaky tests" },
      { at: 3200, text: "patching a timing race in journal.resume" },
      { at: 3900, text: "re-spawn (1/2): correction appendix attached" },
      { at: 4600, text: "reproducing under --rerun-each=20" },
      { at: 5200, text: "3/3 green, 0 flakes in 20 runs" },
    ],
    transcript: [
      { kind: "text", text: "Stabilizing 3 flaky tests from recon." },
      { kind: "tool", tool: "Bash", input: "bun test --rerun-each=20 journal.resume" },
      { kind: "tool-result", text: "2/20 fail — timing race" },
      {
        kind: "text",
        text: "[attempt 1 returned null — no emit_result; validate-and-retry re-spawned]",
      },
      { kind: "tool", tool: "Edit", input: "journal.resume.test.ts  await flush()" },
      { kind: "tool-result", text: "20/20 pass" },
      { kind: "result", json: { flakesFixed: 3, retried: true } },
    ],
  },
  {
    ordinal: 5,
    label: "lane-docs",
    phaseId: "lanes",
    model: "sonnet-4.5",
    effort: "low",
    startAt: 2300,
    endAt: 3900,
    endState: "done",
    costUsd: 0.16,
    tokensIn: 12400,
    tokensOut: 4200,
    snippets: [
      { at: 2300, text: "reading docs/plans/ultra-harness.md" },
      { at: 3100, text: "syncing the injected-surface table" },
      { at: 3600, text: "2 files touched" },
    ],
    transcript: [
      { kind: "text", text: "Refreshing the two docs recon flagged as stale." },
      { kind: "tool", tool: "Edit", input: "docs/PRINCIPLES.md  §threads wording" },
      { kind: "tool", tool: "Edit", input: "README.md  ultra one-liner" },
      { kind: "result", json: { filesTouched: 2 } },
    ],
  },
  {
    ordinal: 6,
    label: "gate-tsc",
    phaseId: "gate",
    model: "haiku-4.5",
    effort: "low",
    startAt: 5700,
    endAt: 6900,
    endState: "done",
    costUsd: 0.09,
    tokensIn: 9800,
    tokensOut: 1400,
    snippets: [
      { at: 5700, text: "tsc -p packages/core --noEmit" },
      { at: 6300, text: "tsc -p apps/web --noEmit" },
      { at: 6700, text: "both clean" },
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
    ordinal: 7,
    label: "gate-test",
    phaseId: "gate",
    model: "haiku-4.5",
    effort: "low",
    startAt: 5700,
    endAt: 7200,
    endState: "done",
    costUsd: 0.13,
    tokensIn: 15600,
    tokensOut: 2200,
    snippets: [
      { at: 5700, text: "bun test packages/core" },
      { at: 6600, text: "148 pass, 0 fail" },
      { at: 7000, text: "suite green" },
    ],
    transcript: [
      { kind: "tool", tool: "Bash", input: "bun test packages/core" },
      { kind: "tool-result", text: "148 pass / 0 fail (11.2s)" },
      { kind: "result", json: { tests: "pass", count: 148 } },
    ],
  },
  {
    ordinal: 8,
    label: "commit",
    phaseId: "commit",
    model: "sonnet-4.5",
    effort: "low",
    startAt: 7400,
    endAt: 8000,
    endState: "done",
    costUsd: 0.08,
    tokensIn: 4200,
    tokensOut: 600,
    snippets: [
      { at: 7400, text: "staging 8 files" },
      { at: 7700, text: "writing conventional message" },
    ],
    transcript: [
      { kind: "tool", tool: "Bash", input: "git add -A && git commit -m …" },
      { kind: "tool-result", text: "[main 4f2a1c9] fix: quick-wins batch" },
      { kind: "result", json: { sha: "4f2a1c9", pushed: false } },
    ],
  },
];

const A_SCRIPT = `export const meta = {
  name: "Quick-wins batch",
  description: "recon → 3 lanes → gate → commit",
  phases: ["Recon", "Parallel lanes", "Gate", "Commit"],
};

// No budget global — bounded discovery is loop-until-dry, not a ceiling.
export default async function ({ agent, parallel, phase, log, args }) {
  phase("Recon");
  const [web, core] = await parallel([
    () => agent("Map quick-wins in apps/web",      { label:"recon-web",  model:"sonnet-4.5", effort:"med",  schema: Recon }),
    () => agent("Map quick-wins in packages/core", { label:"recon-core", model:"sonnet-4.5", effort:"med",  schema: Recon }),
  ]);
  log(\`recon settled — \${[web, core].filter(Boolean).length} modules mapped\`);

  phase("Parallel lanes");
  const [types, tests, docs] = await parallel([
    () => agent("Fix the type errors recon flagged", { label:"lane-types", model:"opus-4.8",   effort:"high", schema: Lane }),
    () => agent("Fix the flaky tests recon flagged", { label:"lane-tests", model:"opus-4.8",   effort:"high", schema: Lane }),
    () => agent("Refresh the docs recon flagged",    { label:"lane-docs",  model:"sonnet-4.5", effort:"low",  schema: Lane }),
  ]);

  phase("Gate");
  const [tsc, test] = await parallel([
    () => agent("Run tsc across the workspace", { label:"gate-tsc",  model:"haiku-4.5", effort:"low", schema: Gate }),
    () => agent("Run the core test suite",      { label:"gate-test", model:"haiku-4.5", effort:"low", schema: Gate }),
  ]);
  log("gate green — tsc + tests pass");

  phase("Commit");
  const commit = await agent("Commit the batch, conventional message", {
    label:"commit", model:"sonnet-4.5", effort:"low", schema: Commit,
  });

  return { batch: args.batch, recon: { web, core },
           lanes: { types, tests, docs }, gate: { tsc, test }, commit };
}`;

/* ---------------------------------------------------------- run B: doc sweep */

const B_AGENTS: AgentDef[] = [
  {
    ordinal: 1,
    label: "scan-docs",
    phaseId: "scan",
    model: "sonnet-4.5",
    effort: "low",
    startAt: 300,
    endAt: 2200,
    endState: "done",
    costUsd: 0.11,
    tokensIn: 9200,
    tokensOut: 1600,
    snippets: [
      { at: 300, text: "listing docs/** (24 files)" },
      { at: 1300, text: "ranking by last-touched vs code drift" },
    ],
    transcript: [
      { kind: "text", text: "Scanning docs/** for staleness." },
      { kind: "tool", tool: "Glob", input: "docs/**/*.md" },
      { kind: "tool-result", text: "24 files" },
      { kind: "result", json: { scanned: 24, stale: 6 } },
    ],
  },
  {
    ordinal: 2,
    label: "scan-readme",
    phaseId: "scan",
    model: "sonnet-4.5",
    effort: "low",
    startAt: 300,
    endAt: 2600,
    endState: "done",
    costUsd: 0.09,
    tokensIn: 7400,
    tokensOut: 1200,
    snippets: [
      { at: 300, text: "reading README + package docs" },
      { at: 1500, text: "diffing against current commands" },
    ],
    transcript: [
      { kind: "text", text: "Checking README against the current CLI." },
      { kind: "tool", tool: "Read", input: "README.md" },
      { kind: "result", json: { stale: ["install step", "ultra one-liner"] } },
    ],
  },
  {
    ordinal: 3,
    label: "rw-principles",
    phaseId: "rewrite",
    model: "opus-4.8",
    effort: "med",
    startAt: 3100,
    endAt: 7200,
    endState: "done",
    costUsd: 0.38,
    tokensIn: 28800,
    tokensOut: 6100,
    snippets: [
      { at: 3100, text: "reconciling §threads wording" },
      { at: 5200, text: "tightening the mediation rung prose" },
      { at: 6800, text: "1 file rewritten" },
    ],
    transcript: [
      { kind: "text", text: "Reconciling PRINCIPLES to the as-built engine." },
      { kind: "tool", tool: "Edit", input: "docs/PRINCIPLES.md  §threads" },
      { kind: "result", json: { file: "docs/PRINCIPLES.md", edits: 4 } },
    ],
  },
  {
    ordinal: 4,
    label: "rw-plans",
    phaseId: "rewrite",
    model: "opus-4.8",
    effort: "med",
    startAt: 3100,
    endAt: 8600,
    endState: "done",
    costUsd: 0.44,
    tokensIn: 33100,
    tokensOut: 7200,
    snippets: [
      { at: 3100, text: "opening docs/plans/*.md" },
      { at: 6000, text: "syncing the injected-surface table" },
      { at: 8200, text: "2 plans updated" },
    ],
    transcript: [
      { kind: "text", text: "Syncing plan docs to the shipped surface." },
      { kind: "tool", tool: "Edit", input: "docs/plans/ultra-harness.md  §3 table" },
      { kind: "result", json: { files: 2 } },
    ],
  },
  {
    ordinal: 5,
    label: "rw-readme",
    phaseId: "rewrite",
    model: "sonnet-4.5",
    effort: "low",
    startAt: 3100,
    endAt: 7800,
    endState: "done",
    costUsd: 0.14,
    tokensIn: 11200,
    tokensOut: 3400,
    snippets: [
      { at: 3100, text: "rewriting the install step" },
      { at: 6400, text: "fixing the ultra one-liner" },
    ],
    transcript: [
      { kind: "text", text: "Fixing the two README staleness hits." },
      { kind: "tool", tool: "Edit", input: "README.md  install + ultra line" },
      { kind: "result", json: { file: "README.md", edits: 2 } },
    ],
  },
  {
    ordinal: 6,
    label: "rw-changelog",
    phaseId: "rewrite",
    model: "sonnet-4.5",
    effort: "low",
    startAt: 8800,
    endAt: 12500,
    endState: "done",
    costUsd: 0.12,
    tokensIn: 9600,
    tokensOut: 2800,
    snippets: [
      { at: 8800, text: "wave 2 — queue not yet dry" },
      { at: 10800, text: "regenerating CHANGELOG entries" },
    ],
    transcript: [
      { kind: "text", text: "Loop-until-dry: a second wave picked up CHANGELOG." },
      { kind: "tool", tool: "Edit", input: "CHANGELOG.md  ultra section" },
      { kind: "result", json: { file: "CHANGELOG.md" } },
    ],
  },
  {
    ordinal: 7,
    label: "rw-agents",
    phaseId: "rewrite",
    model: "opus-4.8",
    effort: "med",
    startAt: 9200,
    endAt: 13800, // beyond duration 13000 → still running at rest
    endState: "done",
    costUsd: 0.31,
    tokensIn: 24000,
    tokensOut: 5200,
    snippets: [
      { at: 9200, text: "reading AGENTS.md against tool surface" },
      { at: 11200, text: "rewriting the child-posture section" },
      { at: 13000, text: "cross-checking §3 wording" },
    ],
    transcript: [
      { kind: "text", text: "Rewriting AGENTS.md to the fixed child posture." },
      { kind: "tool", tool: "Read", input: "AGENTS.md" },
      { kind: "tool", tool: "Edit", input: "AGENTS.md  child posture" },
    ],
  },
];

const B_SCRIPT = `export const meta = {
  name: "Doc-staleness sweep",
  description: "scan docs → rewrite, loop-until-dry",
  phases: ["Scan", "Rewrite"],
};

export default async function ({ agent, parallel, phase, log, args }) {
  phase("Scan");
  const stale = await parallel([
    () => agent("Rank docs/** by staleness", { label:"scan-docs",   model:"sonnet-4.5", effort:"low", schema: Scan }),
    () => agent("Check README vs the CLI",   { label:"scan-readme", model:"sonnet-4.5", effort:"low", schema: Scan }),
  ]);

  // loop-until-dry — no budget ceiling; iterate until the queue is empty.
  phase("Rewrite");
  let queue = flatten(stale);
  while (queue.length) {
    const wave = queue.splice(0, 3);
    await parallel(wave.map((f) =>
      () => agent(\`Rewrite \${f}\`, { label:\`rw-\${f}\`, model: pick(f), effort:"med", schema: Rewrite }),
    ));
    log(\`wave done — \${queue.length} left in queue\`);
  }
  return { swept: true, files: args.scope };
}`;

/* ------------------------------------------------------- run C: flake triage */

const C_AGENTS: AgentDef[] = [
  {
    ordinal: 1,
    label: "repro-journal",
    phaseId: "reproduce",
    model: "haiku-4.5",
    effort: "low",
    startAt: 300,
    endAt: 2400,
    endState: "done",
    costUsd: 0.08,
    tokensIn: 6800,
    tokensOut: 900,
    snippets: [
      { at: 300, text: "bun test --rerun-each=30 journal.resume" },
      { at: 1600, text: "3/30 fail — confirmed flaky" },
    ],
    transcript: [
      { kind: "text", text: "Reproducing the journal.resume flake." },
      { kind: "tool", tool: "Bash", input: "bun test --rerun-each=30 journal.resume" },
      { kind: "tool-result", text: "3/30 fail" },
      { kind: "result", json: { suite: "journal.resume", flaky: true } },
    ],
  },
  {
    ordinal: 2,
    label: "repro-abort",
    phaseId: "reproduce",
    model: "haiku-4.5",
    effort: "low",
    startAt: 300,
    endAt: 2600,
    endState: "done",
    costUsd: 0.07,
    tokensIn: 6100,
    tokensOut: 800,
    snippets: [
      { at: 300, text: "bun test --rerun-each=30 abort.propagate" },
      { at: 1700, text: "1/30 fail — rare race" },
    ],
    transcript: [
      { kind: "text", text: "Reproducing the abort.propagate flake." },
      { kind: "tool", tool: "Bash", input: "bun test --rerun-each=30 abort.propagate" },
      { kind: "tool-result", text: "1/30 fail" },
      { kind: "result", json: { suite: "abort.propagate", flaky: true } },
    ],
  },
  {
    ordinal: 3,
    label: "stab-abort",
    phaseId: "stabilize",
    model: "opus-4.8",
    effort: "high",
    startAt: 3100,
    endAt: 6800,
    endState: "done",
    costUsd: 0.36,
    tokensIn: 26400,
    tokensOut: 5400,
    snippets: [
      { at: 3100, text: "tracing the abort listener leak" },
      { at: 5200, text: "awaiting the controller settle" },
      { at: 6400, text: "30/30 green" },
    ],
    transcript: [
      { kind: "text", text: "Stabilizing abort.propagate." },
      { kind: "tool", tool: "Edit", input: "abort.test.ts  await settle()" },
      { kind: "tool-result", text: "30/30 pass" },
      { kind: "result", json: { suite: "abort.propagate", fixed: true } },
    ],
  },
  {
    ordinal: 4,
    label: "stab-journal",
    phaseId: "stabilize",
    model: "opus-4.8",
    effort: "high",
    startAt: 3100,
    endAt: 8200, // interrupted by the agent's stop (~run-local 7600)
    endState: "done",
    costUsd: 0.41,
    tokensIn: 30200,
    tokensOut: 6100,
    snippets: [
      { at: 3100, text: "isolating the journal.resume race" },
      { at: 5600, text: "patching the ordinal flush order" },
      { at: 7200, text: "re-running under load" },
    ],
    transcript: [
      { kind: "text", text: "Stabilizing journal.resume — in flight when stopped." },
      { kind: "tool", tool: "Edit", input: "journal.ts  flush before append" },
      { kind: "tool-result", text: "re-running…" },
    ],
  },
];

const C_SCRIPT = `export const meta = {
  name: "Flaky-test triage",
  description: "reproduce → stabilize",
  phases: ["Reproduce", "Stabilize"],
};

export default async function ({ agent, parallel, phase, log, args }) {
  phase("Reproduce");
  const flaky = await parallel(args.suites.map((s) =>
    () => agent(\`Reproduce \${s} under rerun\`, { label:\`repro-\${s}\`, model:"haiku-4.5", effort:"low", schema: Repro }),
  ));

  phase("Stabilize");
  const fixed = await parallel(flaky.filter(Boolean).map((f) =>
    () => agent(\`Stabilize \${f.suite}\`, { label:\`stab-\${f.suite}\`, model:"opus-4.8", effort:"high", schema: Fix }),
  ));
  return { triaged: fixed };
}`;

/* ------------------------------------------------------------------ the runs */

export const RUNS: RunDef[] = [
  {
    id: "ultra_a1c",
    name: "Quick-wins batch",
    blurb: "recon → 3 lanes → gate → commit",
    launchAt: 600,
    duration: 8400, // session end 9000 → completed
    terminal: "completed",
    stopAt: null,
    phases: [
      { id: "recon", title: "Recon", kind: "parallel", activateAt: 200 },
      { id: "lanes", title: "Parallel lanes", kind: "parallel", activateAt: 2200 },
      { id: "gate", title: "Gate", kind: "parallel", activateAt: 5600 },
      { id: "commit", title: "Commit", kind: "sequential", activateAt: 7400 },
    ],
    agents: A_AGENTS,
    log: [
      { at: 200, text: "phase → Recon" },
      { at: 2050, text: "recon settled — 2 modules, 12 type errors + 3 flaky tests" },
      { at: 2200, text: "phase → Parallel lanes (3)" },
      { at: 3650, text: "lane-tests returned null — validate-and-retry (1/2)" },
      { at: 4450, text: "lane-docs done · lane-types done" },
      { at: 5600, text: "phase → Gate" },
      { at: 7250, text: "gate green — tsc + tests pass" },
      { at: 7400, text: "phase → Commit" },
      { at: 8050, text: "committed 4f2a1c9 (not pushed)" },
    ],
    script: A_SCRIPT,
    result: {
      batch: "quick-wins",
      recon: { modules: ["apps/web", "packages/core"], findings: 15 },
      lanes: {
        types: { fixes: 12, files: 4 },
        tests: { flakesFixed: 3, retried: true },
        docs: { filesTouched: 2 },
      },
      gate: { tsc: "pass", tests: "pass" },
      commit: { sha: "4f2a1c9", pushed: false },
      spend: { usd: 1.95 },
      agents: 8,
    },
  },
  {
    id: "ultra_b2d",
    name: "Doc-staleness sweep",
    blurb: "scan docs → rewrite, loop-until-dry",
    launchAt: 2200,
    duration: 13000, // session end 15200 → still running at rest (14000)
    terminal: "completed",
    stopAt: null,
    phases: [
      { id: "scan", title: "Scan", kind: "parallel", activateAt: 200 },
      { id: "rewrite", title: "Rewrite", kind: "parallel", activateAt: 3000 },
    ],
    agents: B_AGENTS,
    log: [
      { at: 200, text: "phase → Scan" },
      { at: 2700, text: "scanned 24 docs — 6 stale, queued" },
      { at: 3000, text: "phase → Rewrite (loop-until-dry)" },
      { at: 7300, text: "wave 1 done — 3 rewritten, queue not dry" },
      { at: 8800, text: "wave 2 — CHANGELOG + AGENTS picked up" },
      { at: 12600, text: "CHANGELOG done — 1 left in queue" },
    ],
    script: B_SCRIPT,
    result: null,
  },
  {
    id: "ultra_c3f",
    name: "Flaky-test triage",
    blurb: "reproduce → stabilize",
    launchAt: 3400,
    duration: 9000,
    terminal: "completed",
    stopAt: 11000, // the AGENT stops it (duplicates the batch's tests lane)
    phases: [
      { id: "reproduce", title: "Reproduce", kind: "parallel", activateAt: 200 },
      { id: "stabilize", title: "Stabilize", kind: "parallel", activateAt: 3000 },
    ],
    agents: C_AGENTS,
    log: [
      { at: 200, text: "phase → Reproduce" },
      { at: 2700, text: "2 suites confirmed flaky" },
      { at: 3000, text: "phase → Stabilize" },
      { at: 6900, text: "abort.propagate green (30/30)" },
    ],
    script: C_SCRIPT,
    result: null,
  },
];

// The session's whole story fits in this window (§6.8 replay drives all of it).
export const SESSION_END = 14000;

// The first authored attempt omitted opts.model on one call — validation
// rejects it BEFORE returning {runId} (§4), teaching the explicit-model rule.
export const REJECTION = {
  tool: "ultra",
  error: "MissingModel",
  kind: "validation",
  detail: "agent() call 'lane-types' has no opts.model — every call must name it",
  line: 14,
};

// A run's SESSION-clock effective end + terminal, given a stop override.
export function runEnd(
  run: RunDef,
  effStop: number | null,
): { end: number; terminal: RunState } {
  const natural = run.launchAt + run.duration;
  if (effStop != null && effStop < natural) return { end: effStop, terminal: "stopped" };
  return { end: natural, terminal: run.terminal };
}
