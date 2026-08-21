#!/usr/bin/env bun
/**
 * The Loom loop, end to end, in a throwaway git repository — runnable by a human.
 *
 *   bun scripts/loom-demo.ts [--real-agent] [--keep]
 *
 * It builds a project with no GitHub, no tracker and no network: an `inbox/` of
 * markdown files, a tab-separated index, a `gate.sh`, and a second local
 * repository standing in for `origin`. It starts a REAL engine daemon, registers
 * the project, dry-runs, ticks, and lets the harness gate and publish. Then it
 * prints what the remote actually holds.
 *
 * WHAT IS REAL: the daemon, its HTTP routes, the typed client, the loom store,
 * the ledger, `defaultLoomExec` spawning real shells, `git`, the worktree the
 * engine cuts, the rebase onto a freshly fetched base, the never-touch check,
 * the gate, the `git push`.
 *
 * WHAT IS FAKED: two things, and only two. The orchestrator (`loomAgent`) is a
 * scripted decision, because a real one costs money — pass `--real-agent` to use
 * whatever agent this daemon actually wires. And the worker inside the worktree
 * (`loomSession`) is a function that writes a file and commits it, standing in
 * for Claude doing the work; the harness only ever reads its exit and its
 * commits, which is the whole contract.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Relative, not `@telar/engine-client`: the workspace root has no linked
// node_modules, so a script at the repo root cannot resolve the bare specifier.
import { EngineClient } from "../packages/engine-client/src/index";
import type { LoomRun, TickDecision } from "../packages/engine-client/src/index";
import { startEngine } from "../apps/engine/src/daemon";
import type { LoomAgent, LoomSessionPort } from "../apps/engine/src/loom/dispatch";

const args = new Set(process.argv.slice(2));
const realAgent = args.has("--real-agent");
const keep = args.has("--keep");
const PROJECT = "inbox";

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};
const rule = (title: string): void => {
  out();
  out(`── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
  out();
};

function git(cwd: string, ...gitArgs: string[]): string {
  return execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitOk(cwd: string, ...gitArgs: string[]): boolean {
  try {
    git(cwd, ...gitArgs);
    return true;
  } catch {
    return false;
  }
}

// ── the throwaway project ───────────────────────────────────────────────────

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-loom-demo-")));
const engineRoot = path.join(root, "engine");
const projectRoot = path.join(root, "project");
const remote = path.join(root, "remote.git");
const gateExit = path.join(root, "gate-exit");

fs.mkdirSync(engineRoot, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(gateExit, "0\n");

// A demo that dies halfway must not leave a temp tree and a daemon lock behind.
const bail = (error: unknown): never => {
  process.stderr.write(`\nloom-demo failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  else process.stderr.write(`Kept ${root}\n`);
  process.exit(1);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);

const PROGRAM = `# Loom program — ${PROJECT}

## Work source

\`\`\`probe
cat inbox/index.tsv inbox/*.md | cksum
\`\`\`

\`\`\`list
cat inbox/index.tsv
\`\`\`

\`\`\`detail
cat inbox/$ITEM.md
\`\`\`

\`\`\`publish
git push origin $BRANCH && echo "published http://localhost/branch/$BRANCH"
\`\`\`

## Gates

\`\`\`gate
bash ./gate.sh
0 pass
1 fail
2 unknown
\`\`\`

On unknown: hold

## Work

base: main
branch: loom/<slug>
concurrency: 2

## Never touch

.env*

## When stuck

1 re-read the item and everything said since it was dispatched  [on]
2 run the gate again — it may be flaky                          [on]
3 try a different approach from scratch                         [off]

## Ask me only when

- the gate has failed at every rung above

## When to look

every 300s, backing off to 3600s
`;

function write(relative: string, content: string): void {
  const target = path.join(projectRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

git(root, "init", "--bare", "remote.git");

write(
  "inbox/index.tsv",
  ["a1\t2026-08-20T01:00:00Z\tstrip the prefix", "a2\t2026-08-20T01:05:00Z\trename the widget", "a3\t2026-08-20T01:10:00Z\tfix the docs typo"].join("\n") + "\n",
);
write("inbox/a1.md", "# strip the prefix\n\nThe model id is sent with an `openai/` prefix and the server rejects it.\nRoot cause is named; small and self-contained.\n");
write("inbox/a2.md", "# rename the widget\n\nThe widget is called three different things and nobody has ruled on which wins.\n");
write("inbox/a3.md", "# fix the docs typo\n\n`recieve` should be `receive`.\n");
write("gate.sh", `#!/bin/sh\n# Steered by a file outside the repo, so a demo can move it without a commit.\nexit "$(cat ${gateExit} 2>/dev/null || echo 0)"\n`);
write("README.md", "# demo\n\nline one\nline two\nline three\n");
write(path.join(".telar", "loom.md"), PROGRAM);

git(projectRoot, "init");
git(projectRoot, "config", "user.email", "loom@example.invalid");
git(projectRoot, "config", "user.name", "Loom Demo");
git(projectRoot, "config", "commit.gpgsign", "false");
git(projectRoot, "add", "-A");
git(projectRoot, "commit", "-m", "chore: the project as it stands");
git(projectRoot, "branch", "-M", "main");
git(projectRoot, "remote", "add", "origin", remote);
git(projectRoot, "push", "-u", "origin", "main");

const mainAtStart = git(remote, "rev-parse", "main").trim();

// ── the two fakes ───────────────────────────────────────────────────────────

const decisions: TickDecision[] = [
  {
    triage: [
      { item: "a1", classification: "dispatchable", reason: "root cause named, no dependencies", ask: "strip the `openai/` prefix before sending" },
      { item: "a2", classification: "needs-decision", reason: "three names, no ruling on which wins", ask: "pick the name" },
      { item: "a3", classification: "dispatchable", reason: "a one-word typo", ask: "fix the typo" },
    ],
    dispatch: [{ item: "a1", title: "Strip the prefix", branchSlug: "strip-the-prefix", brief: "strip the `openai/` prefix before the request goes out" }],
    park: [],
    ask: [],
    note: "dispatched a1; a2 needs a human; a3 can wait behind a1",
  },
];
const EMPTY: TickDecision = { triage: [], dispatch: [], park: [], ask: [], note: "nothing new" };

const agent = { calls: 0 };
const loomAgent: LoomAgent = async () => {
  agent.calls += 1;
  // The dry run and the first tick get the same decision — a dry run is the same
  // question with nothing persisted.
  return { ok: true, value: agent.calls <= 2 ? (decisions[0] as TickDecision) : EMPTY };
};

const worker = { committed: [] as string[] };
const sessions = new Map<string, "running" | "done" | "gone">();
let sessionSeq = 0;
const loomSession: LoomSessionPort = {
  async start(input) {
    const sessionId = `worker-${(sessionSeq += 1)}`;
    sessions.set(sessionId, "running");
    // The stand-in for Claude: change a file, commit it, let go.
    fs.writeFileSync(path.join(input.worktree, "fix.txt"), "the prefix is stripped before the request goes out\n");
    git(input.worktree, "add", "-A");
    git(input.worktree, "commit", "-m", "fix: strip the openai/ prefix");
    worker.committed.push(`${sessionId} committed fix.txt in ${input.worktree}`);
    sessions.set(sessionId, "done");
    return { sessionId };
  },
  async create() {
    const sessionId = `orchestrator-${(sessionSeq += 1)}`;
    sessions.set(sessionId, "running");
    return { sessionId };
  },
  async status(sessionId) {
    return sessions.get(sessionId) ?? "gone";
  },
  async stop(sessionId) {
    sessions.set(sessionId, "gone");
  },
};

// ── a real engine ───────────────────────────────────────────────────────────

/** The daemon's clock, so the sentinel section can jump a Program's 300s cadence
 *  instead of making a person wait for it. Everything else reads real time. */
let clockOffset = 0;
let sweep: (() => void) | null = null;

const daemon = await startEngine({
  engineRoot,
  now: () => Date.now() + clockOffset,
  // The supervisor's 1s poll timer, fired by hand below for the same reason.
  loomInterval: (fn) => {
    sweep = fn;
    return { clear: () => undefined };
  },
  // `--real-agent` wires nothing of its own: the daemon's own orchestrator and
  // its own session port answer, and an embedded worker is started so the
  // sessions it opens actually execute.
  ...(realAgent ? { embeddedWorker: true } : { loomAgent, loomSession }),
});
const client = new EngineClient(daemon.discovery);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A scripted tick settles in milliseconds; a real one is a model call. */
const SETTLE_MS = realAgent ? 1_800_000 : 30_000;

async function settle(run: LoomRun): Promise<LoomRun> {
  const settleBy = Date.now() + SETTLE_MS;
  for (;;) {
    const found = (await client.loomWork()).runs.find((candidate) => candidate.id === run.id);
    if (found && found.state !== "running") return found;
    if (Date.now() > settleBy) throw new Error(`run ${run.id} never settled`);
    await delay(realAgent ? 2_000 : 20);
  }
}

out();
out("Loom demo — a project with no GitHub, no tracker and no network.");
out();
out(`  temp root    ${root}`);
out(`  project      ${projectRoot}`);
out(`  remote       ${remote}   (bare; stands in for origin)`);
out(`  engine root  ${engineRoot}   (looms, ledger, worktrees)`);
out(`  engine       ${daemon.discovery.host}:${daemon.discovery.port}`);
if (realAgent) {
  out();
  out("  --real-agent: nothing is faked. The daemon's own orchestrator decides and");
  out("  a real Telar session does the work in the worktree. This costs money and");
  out("  takes minutes.");
}

await client.registerProject({ id: PROJECT, name: "inbox demo", root: projectRoot });

// ── the Program ─────────────────────────────────────────────────────────────

rule("the Program the engine read (.telar/loom.md)");
const doc = await client.loomProgram(PROJECT);
const program = doc.program;
if (!program) throw new Error(`the Program did not parse: ${doc.warnings.join("; ")}`);
out(`  path       ${doc.path}`);
out(`  probe      ${program.commands.probe ?? "(none)"}`);
out(`  list       ${program.commands.list ?? "(none)"}`);
out(`  detail     ${program.commands.detail ?? "(none)"}`);
out(`  publish    ${program.commands.publish ?? "(none)"}`);
for (const gate of program.gates) {
  const codes = Object.entries(gate.exits)
    .map(([code, outcome]) => `${code} ${outcome}`)
    .join(" · ");
  out(`  gate       ${gate.command}   (${codes})   unknown → ${gate.onUnknown}`);
}
out(`  work       base ${program.work.base} · branch ${program.work.branchPrefix}<slug> · concurrency ${program.work.concurrency}`);
out(`  never      ${program.neverTouch.join(", ") || "(nothing)"}`);
out(`  ladder     ${program.ladder.map((rung) => `${rung.n} ${rung.enabled ? "on" : "off"}`).join(" · ")}`);
out(`  warnings   ${doc.warnings.length === 0 ? "none" : doc.warnings.join("; ")}`);

// ── the dry run ─────────────────────────────────────────────────────────────

rule("the dry run — nothing below was executed");
const dry = await settle((await client.dryRunLoom(PROJECT)).run);
if (dry.state === "failed") {
  out(`  the dry run failed: ${dry.error}`);
} else {
  for (const line of (dry.note ?? "").split("\n")) out(line);
}
out();
out(`  looms after the dry run: ${(await client.looms()).looms.length}   (a trust surface with side effects is not one)`);

// ── the tick ────────────────────────────────────────────────────────────────

rule("the tick — the same decision, this time acted on");
const ticked = await settle((await client.tickLoom(PROJECT)).run);
if (ticked.state === "failed") {
  out(`  the tick failed: ${ticked.error}`);
} else {
  out(`  note        ${ticked.note ?? ""}`);
  for (const loomId of ticked.dispatched) {
    const { loom } = await client.loom(loomId);
    out(`  dispatched  ${loom.id}  item ${loom.item}  ${loom.title}`);
    out(`    state     ${loom.state}`);
    out(`    branch    ${loom.branch}`);
    out(`    worktree  ${loom.worktreePath}`);
    out(`    session   ${loom.sessionId}`);
  }
  for (const line of worker.committed) out(`  worker      ${line}`);
}

// ── the harness ─────────────────────────────────────────────────────────────

rule("the harness — rebase onto a fresh base, boundaries, gate, publish");
// Every tick reconciles what is in flight before it decides anything, so a
// finished worker walks through gating to published without a new decision.
// With a scripted worker that is one more tick; with a real session it is a
// wait, so the loop is bounded by a budget rather than by a count.
const IN_FLIGHT = ["queued", "working", "gating", "publishing"];
const deadline = Date.now() + (realAgent ? 1_800_000 : 60_000);
for (;;) {
  await settle((await client.tickLoom(PROJECT)).run);
  const inFlight = (await client.looms()).looms.filter((loom) => IN_FLIGHT.includes(loom.state));
  if (inFlight.length === 0) break;
  if (Date.now() > deadline) {
    out(`  still in flight after the budget ran out: ${inFlight.map((loom) => `${loom.item} ${loom.state}`).join(", ")}`);
    break;
  }
  if (realAgent) out(`  waiting on ${inFlight.map((loom) => `${loom.item} ${loom.state}`).join(", ")}`);
  await delay(realAgent ? 20_000 : 0);
}

const overview = await client.looms();
for (const loom of overview.looms) {
  out(`  ${loom.item}  ${loom.state}`);
  if (loom.gate) out(`    gate      ${loom.gate.command} exited ${loom.gate.exitCode} → ${loom.gate.outcome}`);
  if (loom.publishedUrl) out(`    published ${loom.publishedUrl}`);
  if (loom.parkedReason) out(`    reason    ${loom.parkedReason}`);
}

rule("what the remote actually holds now");
const branches = git(remote, "for-each-ref", "--format=%(refname:short) %(objectname:short)", "refs/heads")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");
for (const branch of branches) out(`  ${branch}`);
out();
out(`  main is ${git(remote, "rev-parse", "main").trim() === mainAtStart ? "UNCHANGED" : "CHANGED"} since the demo started — nothing was merged, base was never pushed to.`);
const publishedLooms = overview.looms.filter((loom) => loom.state === "published");
const published = publishedLooms[0];
for (const loom of publishedLooms) {
  if (!loom.branch || !gitOk(remote, "rev-parse", "--verify", loom.branch)) continue;
  const files = git(remote, "diff", "--name-only", `main..${loom.branch}`).trim().split("\n").filter((line) => line !== "");
  // An EMPTY diff is worth printing rather than hiding: the harness's only
  // done-check is that the worktree gained a commit, and an empty commit passes
  // it. A branch published with nothing on it is a real outcome of that rule.
  out(`  ${loom.branch} changes ${files.length === 0 ? "NOTHING — the commit is empty against main" : `${files.join(", ")} and nothing else`}.`);
}

// ── the ledger ──────────────────────────────────────────────────────────────

rule("the ledger — what an agent that deliberately does not remember left behind");
const ledger = await client.loomLedger(PROJECT, 40);
for (const entry of [...ledger.entries].reverse()) {
  const when = new Date(entry.at).toISOString().slice(11, 19);
  out(`  ${when}  ${entry.kind.padEnd(9)} ${entry.summary}`);
}

rule("the deck");
for (const project of overview.projects) {
  out(`  ${project.projectId}  ${Object.entries(project.counts).filter(([, n]) => n > 0).map(([state, n]) => `${state} ${n}`).join(" · ") || "no looms"}`);
}
const triage = await client.loomTriage(PROJECT);
for (const entry of triage.entries) out(`  seen  ${entry.item}  ${entry.classification}: ${entry.reason}`);

// ── the sentinel ────────────────────────────────────────────────────────────

rule("idle is free — the sentinel, five passes, no agent");
await client.setLoomWatch(PROJECT, true);

/**
 * Orchestrator invocations, read off the LEDGER rather than off a counter in
 * this file — so the number means the same thing with `--real-agent`, where
 * nothing here is in the call path. Every tick writes exactly one `tick` entry
 * carrying its note; a wake writes a `tick` entry whose summary starts `woken:`.
 */
async function orchestratorCalls(): Promise<number> {
  const entries = (await client.loomLedger(PROJECT, 200)).entries;
  return entries.filter((entry) => entry.kind === "tick" && !entry.summary.startsWith("woken:")).length;
}

async function sentinelPass(): Promise<void> {
  if (!sweep) throw new Error("the supervisor never armed a timer");
  const watchOf = async (): Promise<{ lastProbeAt?: number; quietChecks: number; intervalSec: number } | undefined> =>
    (await client.looms()).projects.find((project) => project.projectId === PROJECT)?.watch;
  const before = (await watchOf())?.lastProbeAt;
  sweep();
  const passBy = Date.now() + SETTLE_MS;
  for (;;) {
    const watch = await watchOf();
    const idle = (await client.loomWork()).runs.every((run) => run.state !== "running");
    if (watch && watch.lastProbeAt !== before && idle) return;
    if (Date.now() > passBy) throw new Error("a sentinel pass never landed");
    await delay(realAgent ? 1_000 : 20);
  }
}

const callsBeforeSentinel = await orchestratorCalls();
await sentinelPass();
out(`  pass 1  this project had never been probed, so it woke.   orchestrator calls: ${(await orchestratorCalls()) - callsBeforeSentinel}`);

const callsAfterFirstPass = await orchestratorCalls();
for (let pass = 2; pass <= 6; pass += 1) {
  clockOffset += 7_200_000;
  await sentinelPass();
}
const quietWatch = (await client.looms()).projects.find((project) => project.projectId === PROJECT)?.watch;
out(`  passes 2-6  the inbox did not move.   orchestrator calls: ${(await orchestratorCalls()) - callsAfterFirstPass}`);
out(`  quiet checks ${quietWatch?.quietChecks} · interval now ${quietWatch?.intervalSec}s · cost: five probe commands, nothing else`);
if (quietWatch?.quietChecks === 0) {
  out("  (quiet checks is 0 because a loom is still in flight — the supervisor advanced it with git, not with an agent.)");
}

const callsBeforeChange = await orchestratorCalls();
fs.appendFileSync(path.join(projectRoot, "inbox", "a1.md"), "\nA line nobody had seen before.\n");
clockOffset += 7_200_000;
await sentinelPass();
out(`  pass 7  one inbox file changed.   orchestrator calls: ${(await orchestratorCalls()) - callsBeforeChange}`);
out(`  total orchestrator calls this whole demo: ${await orchestratorCalls()}`);

rule("what was real and what was faked");
out("  real    the daemon, its routes, the typed client, the loom store and ledger,");
out("          defaultLoomExec spawning real shells, git, the worktree the engine cut,");
out("          the rebase onto a freshly fetched base, the never-touch check, the gate,");
out("          and the git push that published the branch.");
out(realAgent ? "  faked   nothing — --real-agent was passed." : "  faked   the orchestrator's decision, and the worker inside the worktree.");
out("          Nothing else. No network was used and no GitHub concept exists anywhere");
out("          in this Program or in the engine that ran it.");

// ── teardown ────────────────────────────────────────────────────────────────

await daemon.close();
out();
if (keep) {
  out(`Kept. Go and look:  ${root}`);
  out(`  worktree   ${published?.worktreePath ?? "(none)"}`);
  out(`  ledger     ${path.join(engineRoot, "looms", PROJECT, "ledger.jsonl")}`);
} else {
  fs.rmSync(root, { recursive: true, force: true });
  out(`Cleaned up ${root}. Pass --keep to leave it behind and look at the worktree and the ledger.`);
}
