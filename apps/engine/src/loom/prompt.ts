/**
 * PROMPT ASSEMBLY — pure, and that purity is load-bearing.
 *
 * Nothing here reads a file, runs a command or calls a model. Every input
 * arrives as an argument, which is what lets a test assert the exact sentence a
 * worker is told without a subprocess, and what lets the bound on a tick's size
 * be checked by reading rather than by measuring a bill.
 *
 * ── BOUNDED BY CONSTRUCTION, NOT BY DISCIPLINE ──────────────────────────────
 * `orchestrator.md` §3.2's central claim is that a tick's cost does not grow
 * with uptime. That claim is either true here or it is false everywhere, because
 * this is the only place a tick's context is assembled. So every section below
 * is bounded by something that does not accumulate:
 *
 *   · the Program — a file a human maintains, small because a human reads it
 *   · `probe` / `list` output — the current world, truncated by `exec`
 *   · current looms — bounded by `concurrency`
 *   · stale item details — capped per tick by the caller (§7's cap, 8)
 *   · the ledger — the LAST 40 ENTRIES, never the whole journal
 *
 * There is no "history", no transcript, no summary-of-a-summary. A tick that ran
 * on day 300 assembles the same size prompt as one that ran on day 1.
 *
 * ── THE WORKER'S BRIEF IS A LIST OF THINGS IT MAY NOT DO ────────────────────
 * §3.4: prompting an agent to "always run the gate" is weak, because agents skip
 * things under pressure, especially late in a long task. The design's answer is
 * to take the gate away from the worker entirely — the harness runs it after the
 * session exits, so the worker CANNOT skip what it was never holding. The prompt
 * still says so explicitly, but as an explanation of a fact rather than as a
 * rule being trusted: a worker that knows the gate runs afterward writes
 * differently than one that thinks it can decide the gate never ran.
 */
import type { LedgerEntry, Loom, LoomProgram, TickDecision } from "@telar/engine-client";
import { renderProgram } from "./program";

/** §7's decided N. The ledger slice, not the ledger. */
export const LEDGER_WINDOW = 40;

export type OrchestratorContext = {
  projectId: string;
  now: Date;
  program: LoomProgram;
  /** The Program's own markdown, verbatim, when the caller has it. Falls back to
   *  a render, which round-trips by `program.ts`'s contract. */
  markdown?: string;
  probe: { output: string; changed: boolean } | null;
  list: { output: string; code: number } | null;
  looms: Loom[];
  /** Only the items whose triage is stale, and only up to the caller's cap. */
  details: Array<{ item: string; detail: string }>;
  /** How many stale items existed, and how many did not fit under the cap. */
  staleCount: number;
  skipped: number;
  ledger: LedgerEntry[];
};

export type WorkerContext = {
  program: LoomProgram;
  loom: Loom;
  base: string;
  branch: string;
  worktree: string;
  /** `detail`'s output for this item. Free text by contract. */
  detail: string;
  /** The orchestrator's own brief for this dispatch, if it wrote one. */
  brief?: string;
  /** Set when this session is a ladder retry rather than a first attempt. */
  rung?: { n: number; label: string };
  /** Why the previous attempt stopped, when there was one. */
  reason?: string;
  /** A human's answer to an `asking` loom. */
  answer?: string;
};

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim() === "" ? "(nothing)" : body.trim()}\n`;
}

function loomLine(loom: Loom): string {
  const bits = [
    `${loom.id}`,
    `item ${loom.item}`,
    loom.state,
    // Rungs consumed, not sessions started — see `provisionLoom`.
    `${loom.attempts} rung(s) tried`,
    `at rung ${loom.ladderRung}`,
  ];
  if (loom.gate) bits.push(`gate ${loom.gate.outcome} (exit ${loom.gate.exitCode ?? "none"})`);
  if (loom.parkedReason) bits.push(`reason: ${loom.parkedReason}`);
  if (loom.question) bits.push(`asked: ${loom.question}`);
  if (loom.publishedUrl) bits.push(loom.publishedUrl);
  return `- ${bits.join(" · ")}`;
}

/**
 * The tick's prompt. §7's six inputs, in that order, because the order is the
 * argument: policy first so everything after it is read through the policy.
 */
export function orchestratorPrompt(ctx: OrchestratorContext): string {
  const { program } = ctx;
  const active = ctx.looms.filter((loom) => !["published", "parked", "cancelled"].includes(loom.state));
  const room = Math.max(0, program.work.concurrency - active.length);

  const parts: string[] = [];

  parts.push(
    [
      `You are the Loom orchestrator for project "${ctx.projectId}". It is ${ctx.now.toISOString()}.`,
      "",
      "You decide WHAT SHOULD BE WORKED ON. You never edit code, never run a gate,",
      "never open a pull request, and never touch a worktree. Dispatched workers do the",
      "editing; the harness runs the gates and publishes. Your entire output is one",
      "structured decision.",
      "",
      "You are a FRESH INSTANCE. You remember nothing from the last tick and you do not",
      "need to: everything that matters is below. Read it, decide, and stop.",
      "",
      "TRIAGE IS YOUR MOST VALUABLE OUTPUT, not a side effect of dispatching. Most items",
      "in a real backlog cannot be worked by an agent, and nothing in the repository says",
      "which. A tick that dispatches nothing and correctly classifies six new items was a",
      "good tick. Classify every item you were given detail for, with a reason a human",
      "can argue with, and an `ask` that distils what the item CURRENTLY wants — the",
      "newest comment may have retracted the body.",
    ].join("\n"),
  );

  parts.push(
    section(
      "Policy — the Program, verbatim",
      [
        "This file is the human's instructions. It outranks your judgement. If it is",
        "silent on something, say so in your note rather than inventing a rule.",
        "",
        "```markdown",
        ctx.markdown ?? renderProgram(program),
        "```",
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      "Did anything change",
      ctx.probe
        ? `${ctx.probe.changed ? "YES — the probe fingerprint moved since the last pass." : "No — the probe fingerprint is unchanged; you were woken for another reason."}\n\nprobe output:\n\`\`\`\n${ctx.probe.output.trim()}\n\`\`\``
        : "The Program declares no probe, so this tick is a plain heartbeat. Nothing is known about what changed.",
    ),
  );

  parts.push(
    section(
      "The work items — `list` output",
      ctx.list
        ? ctx.list.code === 0
          ? `\`\`\`\n${ctx.list.output.trim()}\n\`\`\``
          : `The \`list\` command exited ${ctx.list.code}. Treat this as UNKNOWN, not as "there is no work". Do not dispatch on the strength of an empty list you could not read.\n\n\`\`\`\n${ctx.list.output.trim()}\n\`\`\``
        : "The Program declares no `list` command, so there is no backlog to read. You can still park, ask, or note.",
    ),
  );

  parts.push(
    section(
      "Looms right now",
      [
        active.length === 0 ? "Nothing is in flight." : active.map(loomLine).join("\n"),
        "",
        `Concurrency is ${program.work.concurrency}; ${active.length} in flight; you may dispatch at most ${room}.`,
        "A dispatch beyond that, or for an item that already has a non-terminal loom, is",
        "dropped by the harness and reported as a drop — it is not silently ignored, and",
        "it wastes the tick.",
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      "Items whose classification is stale",
      [
        ctx.staleCount === 0
          ? "None. Every item in the list has a current classification in the triage cache."
          : `${ctx.staleCount} item(s) changed since they were last classified.` +
            (ctx.skipped > 0
              ? ` Detail was fetched for ${ctx.details.length} of them; **${ctx.skipped} were NOT read this tick** and you have no detail for them. Do not classify what you did not read — leave them alone and they will be read next tick.`
              : ""),
        "",
        ctx.details
          .map((entry) => `### item ${entry.item}\n\n\`\`\`\n${entry.detail.trim()}\n\`\`\``)
          .join("\n\n"),
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      `Recent ledger (last ${LEDGER_WINDOW})`,
      ctx.ledger.length === 0
        ? "Empty — nothing has happened on this project yet."
        : ctx.ledger
            .slice(-LEDGER_WINDOW)
            .map((entry) => `- ${new Date(entry.at).toISOString()} ${entry.kind}${entry.item ? ` item ${entry.item}` : ""}${entry.loomId ? ` ${entry.loomId}` : ""}: ${entry.summary}`)
            .join("\n"),
    ),
  );

  parts.push(
    section(
      "Your decision",
      [
        "Emit one object:",
        "",
        "- `triage`: `{ item, classification, reason, ask }` for every item you read detail for.",
        "  `classification` is one of dispatchable · needs-decision · needs-credentials ·",
        "  needs-split · never · done.",
        "- `dispatch`: `{ item, title, branchSlug, brief }` — only `dispatchable` items, at",
        `  most ${room}. \`brief\` is what the worker is told; be concrete about scope and`,
        "  about what NOT to change.",
        "- `park`: `{ loomId, reason }` — a loom that should stop being retried.",
        "- `ask`: `{ loomId?, item?, question, why }` — only when the Program's \"ask me only",
        "  when\" says so, or the ladder is exhausted. The human is asleep; a question that",
        "  could have been answered by reading is a wasted night.",
        "- `note`: one line for the ledger. What you did and why, not a summary of this prompt.",
      ].join("\n"),
    ),
  );

  return parts.join("\n");
}

/**
 * The brief a dispatched worker gets.
 *
 * The prohibitions are stated as facts about the harness, not as rules, for the
 * reason in the header: a worker that believes it can skip the gate reasons
 * differently from one that knows the gate will run either way.
 */
export function workerPrompt(ctx: WorkerContext): string {
  const { program, loom } = ctx;
  const parts: string[] = [];

  parts.push(
    [
      `You are working on one item: **${loom.item} — ${loom.title}**.`,
      "",
      `You are in a dedicated git worktree at \`${ctx.worktree}\`, on branch \`${ctx.branch}\`,`,
      `cut from \`${ctx.base}\`. Nobody else is editing this checkout.`,
      "",
      "YOUR JOB ENDS AT: the changes are committed to this branch, in this worktree.",
      "That is the whole deliverable. Commit your work before you finish — a worktree",
      "with uncommitted changes and no commits is read by the harness as \"the worker",
      "exited without doing anything\", and the item goes back in the queue.",
    ].join("\n"),
  );

  parts.push(
    section(
      "What happens after you exit — and what you therefore must not do",
      [
        "The harness takes over the moment your session ends. It rebases this branch onto a",
        "freshly fetched `" + ctx.base + "`, checks the diff against the forbidden paths, runs",
        "the project's gates, and opens the pull request. All of that is machinery. None of",
        "it is yours.",
        "",
        "So, concretely:",
        "",
        "- **Do NOT run the gate.** " +
          (program.gates.length > 0
            ? "The harness runs `" + program.gates.map((gate) => gate.command).join("`, `") + "` after you exit, in this worktree, and records the result. "
            : "The harness runs the project's declared gates after you exit. ") +
          "Running it yourself proves nothing about the state the harness will measure, and a",
        "  green run of your own is not permission to consider the item finished.",
        "- **Do NOT commit to `" + ctx.base + "`.** Stay on `" + ctx.branch + "`. Never `git",
        "  checkout " + ctx.base + "`, never merge into it, never push to it, never force-push",
        "  anything.",
        "- **Do NOT open a pull request** and do not push. The harness publishes, and it opens",
        "  a draft PR that a human reviews. A PR you open bypasses the gate result entirely.",
        "- **Do NOT touch these paths.** A diff that touches any of them causes the whole",
        "  attempt to be parked rather than published, so the work is lost:",
        program.neverTouch.length > 0
          ? program.neverTouch.map((glob) => "  - `" + glob + "`").join("\n")
          : "  - (the Program lists none — but never touch secrets, credentials or lockfiles by hand)",
        "- **Do NOT start other work.** One item, this item. If you find something else that",
        "  is broken, say so in your final message; do not fix it here.",
      ].join("\n"),
    ),
  );

  if (ctx.rung) {
    parts.push(
      section(
        `This is a retry — escalation rung ${ctx.rung.n}`,
        [
          `A previous attempt on this item did not get through the gate.`,
          ctx.reason ? `\nWhat stopped it:\n\n\`\`\`\n${ctx.reason.trim()}\n\`\`\`` : "",
          "",
          `The human's own instruction for this rung, verbatim, is:`,
          "",
          `> ${ctx.rung.label}`,
          "",
          "Enact that instruction. It is their words, not a template — read it literally and",
          "do what it says rather than what a generic retry would do. If it does not apply to",
          "what actually went wrong, say so in your final message rather than inventing a",
          "different approach.",
        ].join("\n"),
      ),
    );
  }

  if (ctx.answer) {
    parts.push(
      section(
        "The human answered",
        [
          "This item was escalated and a human has replied. Their answer decides it:",
          "",
          `> ${ctx.answer.split("\n").join("\n> ")}`,
        ].join("\n"),
      ),
    );
  }

  if (ctx.brief) parts.push(section("The brief", ctx.brief));

  parts.push(section("The item", `\`\`\`\n${ctx.detail.trim() || "(the detail command produced no output)"}\n\`\`\``));

  if (program.notes.trim() !== "") {
    parts.push(
      section(
        "What the Program says about this project",
        `The human wrote this. It outranks any convention you infer from the code.\n\n${program.notes.trim()}`,
      ),
    );
  }

  if (program.work.setup) {
    parts.push(
      section(
        "Setup",
        `\`${program.work.setup}\` has already been run in this worktree. You do not need to run it again.`,
      ),
    );
  }

  return parts.join("\n");
}

export type DryRunContext = OrchestratorContext & { rejected?: string[] };

/**
 * §4.2's report, and its job is stated there in one sentence: it is not to look
 * competent, it is to **surface the thing the human did not think to say**.
 *
 * So the last section is the one that matters, and it is computed rather than
 * asked for — an agent asked "anything else?" says "no". What it lists are gaps
 * between the Program and what the world actually contains: items the decision
 * never mentions, policy the Program leaves unstated, and every assumption the
 * Program itself still marks unconfirmed.
 */
export function dryRunReport(decision: TickDecision, ctx: DryRunContext): string {
  const { program } = ctx;
  const lines: string[] = [];
  const seen = new Map(decision.triage.map((entry) => [entry.item, entry]));

  lines.push(`${ctx.projectId} · dry run at ${ctx.now.toISOString()} · nothing below was executed`);
  lines.push("");

  for (const item of decision.dispatch) {
    lines.push(`  dispatch  ${item.item}  ${item.title}`);
  }
  for (const entry of decision.triage) {
    if (decision.dispatch.some((d) => d.item === entry.item)) continue;
    const verb = entry.classification === "never" ? "never" : entry.classification === "done" ? "done" : "skip";
    lines.push(`  ${verb.padEnd(8)}  ${entry.item}  ${entry.classification}: ${entry.reason}`);
  }
  for (const park of decision.park) lines.push(`  park      ${park.loomId}  ${park.reason}`);
  for (const ask of decision.ask) lines.push(`  ask       ${ask.loomId ?? ask.item ?? "-"}  ${ask.question}`);
  if (decision.dispatch.length + decision.triage.length + decision.park.length + decision.ask.length === 0) {
    lines.push("  (it would do nothing at all right now)");
  }

  lines.push("");
  const gateSummary =
    program.gates.length === 0
      ? "gate: none declared"
      : program.gates
          .map((gate) => {
            const codes = Object.entries(gate.exits)
              .map(([code, outcome]) => `${code} ${outcome}`)
              .join(" · ");
            return `gate: ${gate.command}  (${codes || "no exit codes declared"}) unknown → ${gate.onUnknown}`;
          })
          .join("\n");
  lines.push(gateSummary);
  lines.push(
    `base: ${program.work.base}   branch: ${program.work.branchPrefix}<slug>   concurrency: ${program.work.concurrency}   never merges, never pushes to base`,
  );

  // ── the part that earns the report ────────────────────────────────────────
  const notable: string[] = [];

  if (ctx.skipped > 0) {
    notable.push(
      `${ctx.skipped} stale item(s) were NOT read this tick (the per-tick detail cap is ${ctx.details.length + ctx.skipped > 0 ? ctx.details.length : 0} and ${ctx.staleCount} were stale). They are unclassified, not clean.`,
    );
  }
  if (ctx.list && ctx.list.code !== 0) {
    notable.push(`the \`list\` command exited ${ctx.list.code}, so this whole report was built on output that may be incomplete.`);
  }
  const unmentioned = countUnmentioned(ctx, seen);
  if (unmentioned > 0) {
    notable.push(`${unmentioned} item(s) appear in \`list\` but in neither the triage nor the dispatch — the tick had no opinion about them.`);
  }
  const blocked = decision.triage.filter((entry) =>
    ["needs-decision", "needs-credentials", "needs-split"].includes(entry.classification),
  );
  if (blocked.length > 0) {
    notable.push(
      `${blocked.length} item(s) are blocked on something no agent can supply (${[...new Set(blocked.map((entry) => entry.classification))].join(", ")}). Nothing in the tracker says so; only this classification does.`,
    );
  }
  if (!program.commands.probe) {
    notable.push("the Program declares no `probe`, so there is no sentinel — every wake will be a plain heartbeat and idle is not free.");
  }
  if (!program.commands.publish) {
    notable.push("the Program declares no `publish`, so finished work will sit in a worktree and never become visible to anyone.");
  }
  if (!program.commands.detail) {
    notable.push("the Program declares no `detail`, so items are classified from the `list` line alone — which is how a `needs-credentials` item gets dispatched.");
  }
  if (program.gates.length === 0) {
    notable.push("the Program declares no gate, so nothing verifies a worker's changes before the PR opens.");
  }
  if (program.gates.some((gate) => gate.onUnknown === "publish")) {
    notable.push("a gate is set to publish on `unknown` — a gate that could not run will still open a PR. That is a choice, but make it deliberately.");
  }
  if (program.neverTouch.length === 0) {
    notable.push("the Program lists no never-touch paths, so nothing stops a worker committing `.env` or a lockfile.");
  }
  if (program.ladder.filter((rung) => rung.enabled).length === 0) {
    notable.push("no escalation rung is enabled, so the first gate failure goes straight to you.");
  }
  for (const assumption of program.assumed) notable.push(`still assumed, never confirmed: ${assumption}`);
  for (const rejection of ctx.rejected ?? []) notable.push(`the harness dropped part of the decision: ${rejection}`);

  if (notable.length > 0) {
    lines.push("");
    for (const item of notable) lines.push(`⚠  ${item}`);
  }

  if (decision.note.trim() !== "") {
    lines.push("");
    lines.push(`note: ${decision.note.trim()}`);
  }

  return lines.join("\n");
}

/**
 * How many items the `list` output names that the decision never mentions.
 *
 * A COUNT, NOT A LIST OF IDS, because `list` is free text by contract and any
 * id extraction from it is a guess. Counting `#\d+`-shaped tokens over-reports
 * on some projects and under-reports on others — but "the tick had no opinion
 * about roughly N of these" is still the sentence a human needs, and claiming
 * to name them would be claiming an accuracy this cannot have.
 */
function countUnmentioned(ctx: DryRunContext, seen: Map<string, unknown>): number {
  if (!ctx.list) return 0;
  const tokens = new Set<string>();
  for (const match of ctx.list.output.matchAll(/(?:^|[\s"',[])#?(\d{1,7})(?=[\s"',\]}]|$)/g)) {
    if (match[1]) tokens.add(match[1]);
  }
  let count = 0;
  for (const token of tokens) {
    if (!seen.has(token) && !seen.has(`#${token}`)) count += 1;
  }
  return count;
}

// ── the conversational surface ──────────────────────────────────────────────

export type SetupContext = {
  projectId: string;
  projectRoot: string;
  now: Date;
  /** `.telar/loom.md` as it stands, when there is one. Setup is not only a
   *  first-run act — §4.3's correction loop returns here forever. */
  existingMarkdown?: string;
  /** A starting block of text for a project whose tracker we can guess at. */
  preset?: string;
};

/**
 * The seed turn for the ORCHESTRATOR SESSION — the second agent surface, and
 * the one the human actually talks to.
 *
 * NOT THE TICK. The tick is headless, fresh every time, structured, and holds no
 * transcript, which is the whole reason cost does not grow with uptime. This is
 * an ordinary Telar session pinned to the project, where "listen for the issues
 * in hito 1" is said, the dry run is read, a misreading is corrected, and the
 * Program is rewritten. §4.3: correction is the loop, and it stays open forever
 * because the understanding lives in a file rather than in a context window.
 *
 * ── LOOK FIRST. ASK ONLY WHAT CANNOT BE DETERMINED. ─────────────────────────
 * §4.1's rule, and it is stated as hard as it is here because it is the whole
 * character test. Nearly everything a setup interview would ask for is sitting
 * in the repository or one API call away: the milestone list, the default
 * branch, the gate, the label vocabulary, whether there is a tracker at all.
 * **An agent that asks the human for what it could have looked up has told them
 * it will not be resourceful at 3am either** — and 3am, unsupervised, is the
 * only condition this system runs in.
 */
export function setupPrompt(ctx: SetupContext): string {
  const parts: string[] = [];

  parts.push(
    [
      `You are the Loom orchestrator session for project "${ctx.projectId}", checked out at \`${ctx.projectRoot}\`. It is ${ctx.now.toISOString()}.`,
      "",
      "Your job in this conversation is to produce, and then keep correcting, ONE FILE:",
      "`.telar/loom.md` in this repository. That file is the whole program — it says how",
      "this project declares work, what its gates are, what must never be touched, and",
      "what to do when a run gets stuck. A headless tick reads it every few minutes and",
      "dispatches from it. You are not that tick. You do not dispatch, you do not edit",
      "code, and you do not refactor anything: your only outputs are this file and what",
      "you tell the human.",
    ].join("\n"),
  );

  parts.push(
    section(
      "Look first. Ask only what you cannot determine.",
      [
        "This is the rule, not a preference. Almost everything an interview would ask for",
        "is already here or one command away:",
        "",
        "- the default branch — `git symbolic-ref refs/remotes/origin/HEAD`, or `git remote show origin`",
        "- whether there is a tracker at all — is there a remote? does `gh` work here?",
        "- milestones, labels, the actual vocabulary the humans use — read the issue list",
        "  and see what words are really on the issues, rather than asking what they mean",
        "- the gate — `package.json` scripts, `Makefile`, `scripts/ci.*`, the CI workflow.",
        "  Read what the gate's exit codes actually mean; a project whose CI script returns",
        "  2 for \"a suite was skipped\" is telling you something no default can know",
        "- concurrency — what does the project's own tooling say it can run at once? A",
        "  worktree that starts a Docker stack has a ceiling that is RAM, not policy",
        "- what must never be touched — `.gitignore`, `.env*`, anything the repo treats as",
        "  a secret",
        "",
        "Every question you ask that you could have answered by looking is a question the",
        "human has to answer at their desk, about their own repository, for an agent that",
        "will be running it unsupervised at 3am. Ask about intent, judgement and access.",
        "Never about facts.",
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      "Then produce three things, in this order",
      [
        "1. **A draft `.telar/loom.md`** that is about 80% right. Fill in what you found.",
        "   Anything you had to guess goes under `## Assumed — confirm` — that heading is",
        "   how a guess stays visible instead of hardening into a fact.",
        "",
        "2. **A dry run.** What would it dispatch RIGHT NOW, against the live list? Which",
        "   items would it skip, and for which of the three reasons — needs a human",
        "   decision, needs credentials you do not have, needs decomposition? A backlog's",
        "   items are usually blocked on one of those and nothing in the repository says",
        "   which; working that out is the most valuable thing this system does.",
        "",
        "3. **What the human did not think to say.** This is the part that matters and the",
        "   part that is easy to skip because it feels like overstepping. A complete-sounding",
        "   instruction can silently exclude the entire week's real work — \"listen for hito",
        "   1\" is a perfectly clear sentence that skips six brand-new urgent issues nobody",
        "   put in a milestone. Say so. Name the specific thing, with the specific items.",
      ].join("\n"),
    ),
  );

  parts.push(
    section(
      "What the Program looks like",
      [
        "Fenced blocks under known headings; everything else in the file is prose that is",
        "passed to the tick verbatim. The four command slots are shell, run in the project",
        "root, and are the ONLY way the engine reaches the outside world — there is no",
        "GitHub integration, only commands you write:",
        "",
        "- `probe` — **hard contract**: prints ONE line, cheaply, with no model involved.",
        "  That line is the fingerprint; unchanged means nothing happened and nothing is",
        "  spent. Getting this cheap is what makes idle free.",
        "- `list` — free text, the candidate work items.",
        "- `detail` — free text, receives `$ITEM`, prints everything needed to understand one.",
        "- `publish` — receives `$BRANCH`, `$TITLE`, `$BODY`, `$BASE`. Exit 0 means published.",
        "",
        "Gates are TRI-STATE. You declare what each exit code means for this project. An",
        "exit code you do not declare is `unknown`, never `fail`, and `unknown` is a policy",
        "question the file must answer: hold, or publish and let remote CI adjudicate.",
        "",
        "The system opens draft pull requests and never merges, never pushes to the base",
        "branch, and never force-pushes. Say so if the human expects otherwise.",
      ].join("\n"),
    ),
  );

  if (ctx.existingMarkdown) {
    parts.push(
      section(
        "There is already a Program — this is a correction, not a first run",
        [
          "Read it before you look at anything else, and do not rewrite what is already",
          "right. The human's words in it outrank your judgement; change the smallest thing",
          "that fixes what they raised.",
          "",
          "```markdown",
          ctx.existingMarkdown,
          "```",
        ].join("\n"),
      ),
    );
  } else if (ctx.preset) {
    parts.push(
      section(
        "A starting point",
        ["This is a preset, not an answer. Verify every line of it against this repository before you offer it.", "", "```markdown", ctx.preset, "```"].join("\n"),
      ),
    );
  }

  return parts.join("\n");
}
