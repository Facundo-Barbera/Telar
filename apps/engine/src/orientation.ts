/**
 * WHAT THE AGENT IS TOLD ABOUT WHERE IT IS.
 *
 * Nothing in a provider's context said the agent was running inside Telar. What
 * it had was tool names (`mcp__telar__*`, `telar-browser`) and one MCP
 * instruction block about the browser — so "the browser" read as this Mac's
 * Chrome, "session" as the CLI's own history, and "the panel", "the rail",
 * "Looks", "a surface" meant nothing at all. The confusion was
 * structural: the harness never stated where the agent was, so every session
 * re-derived it from tool names or got it wrong. The owner's words for the
 * failure: "when I say browser I most of the time mean the Telar browser and
 * not the actual computer browser."
 *
 * TWO THINGS LIVE HERE, AND THEY ARE DIFFERENT SIZES ON PURPOSE:
 *
 *   - `TELAR_ORIENTATION` — a paragraph, injected into EVERY turn through the
 *     seam each driver already uses for `BROWSER_BRIEFING` / `RUN_BRIEFING`.
 *     It is short because it is paid for on every turn of every session: it
 *     buys the vocabulary and nothing else.
 *   - `TELAR_SKILL` — the depth, written to disk ONCE and read only when the
 *     model decides it needs it. A skill is the right shape for "the panel has
 *     these tabs, a Warp is this, a peer session settles like that": nobody
 *     pays for it until somebody asks.
 *
 * BOTH ARE BEHIND A TOGGLE (`AgentOrientation`), because this is Telar putting
 * words in the agent's mouth and a person is entitled to say no. Off means
 * NOTHING Telar-authored is injected or installed. The per-surface briefings
 * are not covered by it: those are tool contracts — how to drive tabs a session
 * actually has — rather than orientation.
 *
 * VERSIONED so the disclosure in Settings, the skill on disk and the paragraph
 * in a transcript can be told apart across releases.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Bumped whenever the words below change. The skill's front matter carries it,
 *  so a file on disk says which release wrote it. */
export const ORIENTATION_VERSION = 2;

/** The skill's name, which is also its directory and the `$telar` a person or a
 *  model types. One constant so the writer, the remover and the preamble that
 *  points at it cannot drift. */
export const TELAR_SKILL_NAME = "telar";

/**
 * THE PARAGRAPH, and every sentence in it earns its place by naming a word that
 * has been read wrong.
 *
 * IT TEACHES VOCABULARY, NOT BEHAVIOUR. There is no "always do X" here: a
 * standing instruction injected into every turn of every session is a way to
 * quietly change how an agent works, and that is not what this is for. It says
 * what the words mean and where to read more.
 *
 * IT ENDS BY SAYING "ASK". The failure this exists to fix is an agent acting
 * confidently on the wrong reading; the cheapest fix for the residue is one
 * question.
 */
export const TELAR_ORIENTATION =
  "You are running inside Telar, an agent cockpit — a desktop app the person you are talking to is looking at right now. " +
  "Read their words in Telar's vocabulary rather than your own. " +
  '"The browser" is Telar\'s own integrated browser, driven by the `telar-browser` tools and sharing its tabs with them — not this Mac\'s Chrome or Safari, unless they say so outright. ' +
  'A "session" or "conversation" is a Telar session, reached through the `mcp__telar` tools, not this CLI\'s own history. ' +
  'The "panel" is the cockpit\'s right pane, the "rail" its list of sessions, and a "surface" one thing drawn in either; ' +
  '"Looks" are the cockpit\'s themes, and a "Warp" a fan-out of sub-agents. ' +
  `The \`${TELAR_SKILL_NAME}\` skill has the detail. When one of these words could mean two things here, ask which.`;

/**
 * THE DEPTH, as a skill file.
 *
 * WHY EVERY TOOL NAME IS SPELLED OUT. `orientation.test.ts` builds each core
 * toolkit with a recording factory and asserts that every name it reports
 * appears below — so a tool added, renamed or removed fails the suite instead
 * of leaving a reference that quietly lies. That test is the reason this is a
 * list rather than prose about "the notebook verbs".
 *
 * THE FRONT MATTER CARRIES `telar:` — the marker `syncTelarSkill` checks before
 * it overwrites or deletes anything. A person who wrote their own `telar` skill
 * keeps it; Telar declines to touch a file it did not write.
 */
export const TELAR_SKILL = `---
name: ${TELAR_SKILL_NAME}
description: What Telar is and what its words mean — the cockpit's panel, rail and surfaces, sessions and how they are assigned and settled, Warps, the integrated browser's tab rules, and the project notebook. Read this when a request uses a word like "the browser", "the panel", "a session" or "a Look" and you are not certain it means what you would assume outside Telar.
telar: generated v${ORIENTATION_VERSION}
---

# Telar

Telar is an agent cockpit: a desktop app in which a person runs many coding
agents at once, across projects, and watches them work. You are one of those
agents. Everything below is about THIS app, not about the machine it runs on.

## The window

- **The rail** — the left sidebar. Every live session, grouped by project.
  Settled ones are shelved out of it rather than deleted.
- **The panel** — the right pane beside the conversation. It has tabs: the
  files the session changed, the browser, the run output, whatever the session
  opened. \`display_open\` is how you put one file in front of the
  person there; it is deliberate foreground, so use it for something you made
  FOR them to look at, not for a file you are merely editing.
- **A surface** — one thing drawn in the window: a session, a panel tab, a
  browser tab. The word says "a pane of the cockpit", never "a Mac window".
- **Looks** — the cockpit's themes. A Look is appearance only. It carries no
  state, no urgency, no meaning about the work.

## Sessions

A Telar session is a conversation with its own checkout, provider and history.
It is not this CLI's own notion of a session, and not a chat thread.

- **\`local\` vs \`worktree\`** — a worktree session gets a git checkout of its
  own and collides with nobody; a local one shares the project's checkout with
  every other local session and with the person's editor. Anything that writes
  code wants a worktree.
- **Sessions are PEERS.** One you create is not your child: nothing links the
  two, it does not report back, and you learn what it did by asking.
- **Assignment** — \`sessions_send\` with \`intent: "task"\` is what starts work;
  creating a session starts none. \`report\` is passive, \`result\` wakes an
  awaiting coordinator, \`blocker\` asks for intervention.
- **A message arrives as a NOTICE, not as text.** The recipient is handed one
  line — who sent it, which run holds it, how long it is, its opening — and
  fetches the body with \`sessions_read\`. Put the point in the first line.
- **Settling** is shelving, not acceptance. A settled session is still live and
  resumable; nothing is deleted, and nothing about the work is approved by it.
  Whether work is good enough to keep is a human's decision, made elsewhere:
  there is no tool here that merges, lands or accepts anything.
- **Creating costs the person something.** There is no cap, so the discipline is
  yours: sessions do not clean themselves up — one you start stays live until a
  human archives it — and every worktree session is a whole checkout on their
  disk. Create what the work needs and nothing more.
- **Do not acknowledge acknowledgements.** A \`report\` back saying "received" is
  a turn somebody pays for. Completion already arrives on its own.

Tools: \`sessions_list\`, \`sessions_create\`, \`sessions_send\`, \`sessions_read\`,
\`sessions_status\`, \`sessions_diff\`, \`sessions_stop\`, \`sessions_settle\`,
\`sessions_subscribe\`, \`sessions_unsubscribe\`, \`sessions_subscriptions\`,
\`sessions_requests\`, \`sessions_resolve_request\`.

### Reading a peer without spending your context on it

Every answer these tools give lands in YOUR context window, so each one is
bounded and each says where its bound fell. Read the notes in the answers; they
name the exact next call.

- \`sessions_list\` answers the UNSETTLED sessions, 50 at a time. \`settled: true\`
  adds the shelf, \`projectId\` narrows, \`after\` pages. An engine with hundreds
  of conversations is ordinary and almost all of them are shelved.
- \`sessions_status\` is the cheap "is it finished yet": an activity, a turn
  count, and the last few turns. Ask it before you read anything.
- \`sessions_read\` FOLDS by default: recent turns, a line each — what it was
  asked, what it did, how it answered — which is what "what has it been doing"
  means, and a fifth of the size of the journal it stands in for. \`mode:
  "events"\` is the raw journal, for debugging a run's tool trace; within it,
  \`from: "start"\` reads from the beginning, \`after\` walks forward from a
  cursor, and \`verbose: true\` restores the token counts and auto-approved
  requests that are dropped by default.
- **A wake or a peer's message is a PING.** It names a session and a run and
  carries no body. \`sessions_read(sessionId, runId)\` fetches the whole thing —
  the answer, and a peer's message in full — and long ones come back in verbatim
  slices on \`resultAfter\` / \`messageAfter\` that concatenate exactly. Fetch when
  it matters; skip when it does not.

### What a coordinating session can and cannot do

CAN: create peers, assign them work, read their journals and diffs, subscribe
to be woken when they finish, answer an approval another session parked
(\`sessions_resolve_request\`), and stop a session that is going wrong.

CANNOT: merge, land or approve anybody's work; archive or delete a session;
answer a secret-access request; or do — through a peer — anything that was
refused here. A tool call you were denied is still denied when another session
makes it for you. Take the refusal back to the person instead.

## Warps

A Warp is a fan-out: a JavaScript script that spawns sub-agents and combines
their results. The structure lives in the script — loops, conditionals, the
plain code between stages — so it runs deterministically rather than being
decided turn by turn. Reach for it when work is wide (many files, many angles)
or when confidence matters more than speed (independent attempts, adversarial
verification). It spawns a real process per concurrent child, so a single
straight line of work should stay a single straight line of work. Tool: \`warp\`.

### Writing the script

The script must begin with a pure object literal — no variables, no calls, no
interpolation:

    export const meta = { name: 'find-flaky-tests', description: 'Find flaky tests and propose fixes', phases: [{ title: 'Scan' }, { title: 'Fix' }] }

Then write statements at the top level. Top-level \`await\` and top-level
\`return\` both work; whatever you return becomes the tool's result.
Available as globals:

- \`agent(prompt, opts?)\` -> Promise<any>. One sub-agent. Resolves to its
  final text, or — with \`opts.schema\` (a JSON Schema) — to a validated
  object, which is what makes the code between stages ordinary code instead of
  another agent hired to read the last one's paragraphs. Resolves to
  \`null\` if the child died, so \`.filter(Boolean)\` before using
  results. \`opts\`: { model, effort, schema, label, phase, maxTurns,
  agentType }. Omit \`model\` to inherit the session's.
- \`parallel(thunks)\` -> Promise<any[]>. Concurrent, WITH A BARRIER:
  everything settles before it resolves. Correct only when the next step
  genuinely needs all of the previous one at once — a dedupe across the whole
  set, an early exit on a total, a prompt that compares one finding against the
  others.
- \`pipeline(items, ...stages)\` -> Promise<any[]>. Each item through every
  stage independently, NO barrier. This is the default for multi-stage work:
  item A can be in stage 3 while item B is still in stage 1, so the run costs
  the slowest single chain rather than the sum of the slowest-per-stage. Every
  stage receives \`(previousResult, originalItem, index)\`. A stage that
  throws drops that item to \`null\` and keeps the others flowing.
- \`phase(title)\` opens a progress group; \`log(message)\` narrates to
  the human; \`args\` is the JSON value passed alongside the script.

### What a script cannot do

\`Date.now()\`, \`new Date()\` and \`Math.random()\` THROW — a
script that branched on the clock could not be replayed. \`require\`,
\`import\`, \`process\` and \`fs\` are absent; a script orchestrates
agents and does not touch the host. A script that cannot parse, is missing its
\`meta\`, or reaches for a banned name is refused before anything is spent,
with the line number.

A Warp child may not create work that outlives the run or escapes the script:
fan-out (Agent, Task, Workflow), scheduling (cron, wake-ups), messaging other
sessions, and switching worktrees are all withheld from it. So the script is the
only place parallelism is expressed. Children run in the same checkout as this
session and inherit its permissions.

## The browser

Telar has its OWN integrated browser, shared between you and the person. When
they say "the browser" in Telar, this is what they mean.

- **You get your own tab.** \`browser_tabs\` new/select moves YOU without moving
  what they are looking at, and every tool takes an optional \`tabId\`.
  \`browser_list_tabs\` marks their tab \`(current)\` and yours \`(yours)\`.
- **List tabs before acting** on a page they referred to.
- Never substitute Chrome, Safari, another profile, or a headless browser.
- \`browser_fill_secret\` fills a login from their 1Password without the value
  ever entering this conversation. Use it instead of asking them to paste one.

## The project notebook

The quick notes kept beside the code — deploy incantations, constraints, the
decisions somebody wrote down so they would not be asked twice. A note belongs
to a PROJECT, so every session on it opens the same notebook. It is THEIRS:
write one when the person asks you to keep something, not to log what you did.

- A note you write is stamped as an agent's, permanently.
- \`notes_delete\` removes only notes an agent wrote. The person's own are
  theirs; say so rather than asking another session to delete one for you.
- \`notes_list\` shows titles and the first 120 characters. \`notes_read\` gives
  one note whole — ask for the ones you actually need.

Tools: \`notes_list\`, \`notes_read\`, \`notes_write\`, \`notes_delete\`,
\`notes_projects\`.

## Showing and running

- \`display_open\` — show one file from this session's checkout in the panel,
  rendered. At most once or twice a turn.
- The Run menu — a project's saved commands, owned by the daemon so a dev
  server outlives the conversation that started it. A project with no run
  configuration can be given one rather than being told it lacks the
  capability. Tools: \`run_configs\`, \`run_save_config\`, \`run_delete_config\`,
  \`run_start\`, \`run_stop\`, \`run_restart\`, \`run_status\`, \`run_output\`,
  \`run_release\`.

A project may also opt into data science (\`ds_*\`, \`notebook_*\`) and LaTeX
(\`latex_*\`). Those toolkits exist only where the project turned them on, and
each tool's own description carries its contract.
`;

/** The content hash the installer compares against. Exported so a test and the
 *  installer agree on what "changed" means. */
export function telarSkillDigest(text: string = TELAR_SKILL): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * THE MARKER THAT MAKES THIS SAFE TO OVERWRITE AND SAFE TO DELETE.
 *
 * `~/.claude/skills/telar/SKILL.md` is a path a person could have written
 * themselves. Telar rewrites or removes only a file that says Telar wrote it,
 * so the worst case for somebody who already had a `telar` skill is that ours
 * is not installed — never that theirs is gone.
 */
const GENERATED_MARKER = "\ntelar: generated v";

export function isTelarGenerated(text: string): boolean {
  return text.includes(GENERATED_MARKER);
}

/* ------------------------------------------------------------------ *
 * Installing it.
 * ------------------------------------------------------------------ */

export type SkillSyncOutcome = "written" | "unchanged" | "removed" | "absent" | "foreign" | "failed";
export type SkillSyncResult = { root: string; file: string; outcome: SkillSyncOutcome };

const skillFile = (root: string): string => path.join(root, TELAR_SKILL_NAME, "SKILL.md");

async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Put the skill where each provider reads skills from, or take it away.
 *
 * WRITTEN ONLY WHEN THE CONTENT HASH MOVED. This runs on every engine start,
 * and rewriting an identical file each time would churn the directory mtime
 * that `provider-skills.ts` caches its menu against — every launch would
 * invalidate every session's `$` menu for no reason.
 *
 * A ROOT THAT CANNOT BE WRITTEN IS NOT AN ERROR. A provider that is not
 * installed has no home directory, and the engine must start anyway; the
 * outcome says `failed` for that root and the others still install.
 */
export async function syncTelarSkill(input: {
  install: boolean;
  roots: readonly string[];
  text?: string;
}): Promise<SkillSyncResult[]> {
  const text = input.text ?? TELAR_SKILL;
  return Promise.all(
    input.roots.map(async (root): Promise<SkillSyncResult> => {
      const file = skillFile(root);
      const existing = await readOrUndefined(file);
      // SOMEBODY ELSE'S FILE UNDER OUR NAME. Left exactly as it is, in both
      // directions: not overwritten when installing, not deleted when removing.
      if (existing !== undefined && !isTelarGenerated(existing)) return { root, file, outcome: "foreign" };
      if (!input.install) {
        if (existing === undefined) return { root, file, outcome: "absent" };
        try {
          await fs.rm(path.dirname(file), { recursive: true, force: true });
          return { root, file, outcome: "removed" };
        } catch {
          return { root, file, outcome: "failed" };
        }
      }
      if (existing !== undefined && telarSkillDigest(existing) === telarSkillDigest(text)) {
        return { root, file, outcome: "unchanged" };
      }
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text, "utf8");
        return { root, file, outcome: "written" };
      } catch {
        return { root, file, outcome: "failed" };
      }
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The OpenCode instructions file.
 * ------------------------------------------------------------------ */

/**
 * WHERE THE OPENCODE PREAMBLE IS WRITTEN.
 *
 * OpenCode has no per-turn instructions parameter the way Claude Code and Codex
 * do. What it has is `instructions` in its config: a list of FILES whose
 * contents it prepends. So the preamble has to exist as a file, and that file
 * must be Telar's — never a line appended to the user's own `opencode.json`,
 * and never a file dropped in their checkout.
 *
 * MIRRORS `engineRootFromEnv`'s LAYOUT (`<TELAR_HOME>/engine`) WITHOUT
 * IMPORTING THE STORE. This module is read by the drivers, which run in the
 * worker and deliberately hold no store handle. A worker started without
 * `TELAR_HOME` (a test) gets a temporary directory instead of a throw: the
 * preamble is worth a file in `/tmp`, never a turn that cannot start.
 */
export function engineOwnedRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.TELAR_HOME?.trim();
  return home && path.isAbsolute(home) ? path.join(home, "engine") : path.join(os.tmpdir(), "telar-engine");
}

/**
 * NAMED BY ITS OWN CONTENT, and that is what makes one path safe for every
 * session. A single `TELAR.md` would be rewritten by each OpenCode session as
 * it started, and two sessions with different capabilities carry different
 * briefings — so one would have been reading the other's file while the server
 * it was starting for read a third. A content address makes the write
 * idempotent, the read stable, and identical briefings share one file.
 */
export function orientationInstructionsPath(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(engineOwnedRoot(env), "orientation", `${telarSkillDigest(text).slice(0, 16)}.md`);
}

/** Put the briefings on disk for a provider that can only read them from a
 *  file, and hand back the path. Idempotent: identical text is the same path,
 *  already written. */
export async function writeOrientationInstructions(text: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = orientationInstructionsPath(text, env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  return file;
}
