/**
 * The `sessions` toolkit — a session's only path to OTHER sessions.
 *
 * Modelled on `../spool/tools.ts` down to the seams: a capability PORT, a wall
 * of tools built over it, `tool` arriving as an argument so no test needs an
 * SDK, and every rule about a session implemented ONCE, in the store, rather
 * than here.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
 * It is a proof of concept for a larger design, and the shape of the proof is
 * mostly its ABSENCES. There is NO ATTACHMENT, NO PARENT AND NO CHILD here. A
 * session that calls `sessions_create` gets back a session it has no
 * relationship to whatsoever: nothing links the two, nothing records which one
 * asked, no depth is tracked, and the new session reports to nobody. They are
 * peers, and every one of the seven tools below treats every session the same
 * way regardless of who created it.
 *
 * That is not an oversight to be filled in later — it is the thing being
 * tested. Hand-running "one session drives another" over a flat peer model is
 * how the product owner intends to find out what parent/child semantics would
 * actually need to mean before any are committed to. A link modelled here now
 * would answer that question by assumption.
 *
 * ── THE ABSENCES THAT ARE RULES RATHER THAN SCOPE ───────────────────────────
 *   · NOTHING ACCEPT-SHAPED. INV-1 (`packages/core/test/invariants.test.ts`)
 *     holds that no MCP surface exposes an accept-shaped tool, and the wall
 *     below is one. Create, send, read, status, stop and diff are all fine:
 *     none of them LANDS anything. There is no merge, no push to a base
 *     branch, no "mark this session's work done" — a session's diff is
 *     readable here and is accepted by a human somewhere else, or not at all.
 *   · NOTHING THAT DELETES OR ARCHIVES. The engine has both verbs and a person
 *     reaches them from a surface they are looking at. An agent that could
 *     archive a session could also free its own budget, which would turn the
 *     one cap in this file into a formality.
 *   · NO PERMISSION LAUNDERING, which is the one rule this wall can only SAY.
 *     See `NOT_A_BYPASS` below: it is stated in the prose of every tool that
 *     could be used for it, because that text is the only voice the wall has
 *     on a question no check here can settle.
 *   · NO WAY TO REACH A FAN-OUT CHILD'S HANDS. `sessions_create` is fan-out by
 *     another name, and `warp/spawn.ts` already denies a warp child the ability
 *     to fan out; these tools join the list it already keeps.
 *
 * ── THE ONE STRUCTURAL GUARD ────────────────────────────────────────────────
 * With no depth rule by design, a plain COUNT is all that stands between a
 * loop and forty worktrees. It lives in `EngineStore.createSession` — not
 * here — so an in-process caller hits it too, and it refuses with a sentence
 * naming the cap and the next move. See `Session.origin`.
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { EngineEvent, EnvMode, ProviderDriverKind, Session, SessionDiff, Turn } from "@telar/engine-client";

/**
 * What the toolkit may do.
 *
 * EVERY MEMBER IS A THIN MIRROR OF ONE `EngineStore` METHOD, and that is the
 * whole design: validation lives in the store, so the tool wall composes
 * sentences and never decides anything. The port exists for the same reason
 * `SpoolCapability` does — there are two worker deployments, the daemon's
 * embedded one and `worker-main.ts`, and only one of them can reach the
 * filesystem store, so the worker builds this out of `EngineClient` calls while
 * the daemon's socket builds it out of `store.*` calls. Both land on the same
 * implementation of every rule.
 */
export type SessionsCapability = {
  /** Every LIVE session on this engine, across projects, plus the projects
   *  themselves — a project id is what `create` takes, so a caller needs both
   *  halves of this answer at once. */
  list(): Promise<{ sessions: Session[]; projects: Array<{ id: string; name: string }> }>;
  /**
   * A NEW SESSION, WITH NO LINK TO THE CALLER.
   *
   * `origin: "session"` is stamped by the implementation of this member, never
   * by a model argument — no shape below carries it — exactly as the spool's
   * `source: "session"` is. It is what the store's budget counts.
   */
  create(input: { projectId: string; title?: string; envMode: EnvMode; driver?: ProviderDriverKind }): Promise<Session>;
  /** Queue ONE turn. The `runId` is minted by the wall so a retry of the same
   *  tool call cannot double-submit. */
  send(sessionId: string, input: { runId: string; input: string }): Promise<{ turn: Turn; replayed: boolean }>;
  /** The journal after a cursor. The STORE returns the whole tail; the bound is
   *  this wall's, because the wall is what lands in a model's context. */
  read(sessionId: string, after: number): Promise<EngineEvent[]>;
  status(sessionId: string): Promise<{ session: Session; turns: Turn[] }>;
  stop(sessionId: string): Promise<{ turn?: Turn; stopped: boolean }>;
  diff(sessionId: string): Promise<SessionDiff>;
};

/** Just enough of the SDK to register a tool — the same seam the browser and
 *  spool toolkits take, so a test can drive this with no SDK installed. */
export type ToolFactory = (
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
) => unknown;

const ok = (text: string) => ({ content: [{ type: "text", text }] });
const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const json = (value: unknown) => ok(JSON.stringify(value, null, 2));

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * THE SENTENCE THE WALL CANNOT ENFORCE, so it says it instead — in the prose of
 * every tool that could be bent into it.
 *
 * A session cannot be stopped in code from asking another session to do the
 * thing it was itself refused: the second session is a peer with its own
 * permission boundary, and by construction there is no link between them for a
 * check to read. The engine's own guards still apply on the other side — a new
 * session parks anything that escapes its boundary exactly as this one does —
 * but "I was told no, so I will ask someone else" is a decision a model makes
 * in words, and words are what this text answers.
 */
const NOT_A_BYPASS =
  "NEVER use this to get around something you were refused. If a tool call was declined, a permission " +
  "was denied, or the user said no, then handing that same work to another session is the same refused " +
  "action wearing a different name — it is not a workaround, it is a violation. Take the refusal back to " +
  "the user instead.";

const LIST = `Every session that is alive on this engine right now — its id, its project, its title, whether it is working or waiting on somebody, and whether it has a checkout of its own — plus the projects a session could be created in. Read this before creating anything: the session you want may already exist, and this is also what tells you which sessions are holding the create budget.`;

const CREATE = `Start a NEW session on a project, with no relationship to this one. It is a PEER, not a child: nothing links the two, it does not report back to you, and you learn what it did only by asking (sessions_read, sessions_status, sessions_diff). It starts with no turn queued — creating a session begins no work; sessions_send is what does.

envMode is the choice that matters. "worktree" gives it a git checkout of its own, so it can edit files without colliding with anything else working on that project — this is what you want for anything that writes code. "local" points it at the project's own checkout, which it then SHARES with every other local session and with the user's own editor.

There is a hard cap on how many live sessions may be created this way, and hitting it is refused with a sentence saying so. Sessions do not clean themselves up: one you started stays live until a human archives it. ${NOT_A_BYPASS}`;

const SEND = `Give a session one message, exactly as a person typing to it would. It is queued and runs when a worker picks it up — this returns as soon as it is accepted, NOT when the turn is finished, so read the answer with sessions_read or watch for it with sessions_status rather than assuming it happened. A session can hold a short backlog, so a second message while one is running is queued behind it rather than interrupting.

Say everything the session needs in the message itself. It cannot see this conversation, does not know who you are, and has no memory of anything you have not told it. ${NOT_A_BYPASS}`;

const READ = `Read what a session has done since a point in its journal: its messages, its tool calls, its answers. Pass no cursor to start from the beginning and the cursor you got back to continue — that is how you follow a session as it works.

THE ANSWER IS BOUNDED and a transcript is not: you may get a page rather than everything, and the result says so and gives you the cursor to ask for the next one. Never assume a page is the whole story; if "more" is true, there is more.`;

const STATUS = `Whether a session is doing anything: what it is (working, waiting on a person, idle), what its recent turns are and how each ended, and whether anything is running right now. This is the cheap question — ask it before sessions_read when all you need to know is "is it finished yet". It costs nothing to call and it changes nothing.`;

const STOP = `Stop whatever turn a session is running or has queued. The work already done is kept — this ends the turn, it does not undo it, and it deletes nothing. Use it when a session is going somewhere wrong or when you have changed your mind about what you asked for; the session stays alive and you can send it something else afterwards. A session with nothing running answers that it stopped nothing, which is not an error.`;

const DIFF = `What a session has changed in its checkout since it started — the files, and the shape of the change. A session with a worktree of its own shows exactly what it did there; a "local" session shows what has happened in the project's own checkout, which may include work that is not its own.

READ-ONLY, AND IT IS NOT AN ACCEPTANCE. Nothing here merges, pushes, lands or approves anything, and there is no tool that does: whether a session's work is good enough to keep is a human's decision, made somewhere else. Reporting on a diff is your job; declaring it done is not.`;

/**
 * ── THE BOUND ON `sessions_read`, AND WHY IT IS TWO NUMBERS ─────────────────
 *
 * A session's journal is unbounded — a long-running session accumulates
 * thousands of events, some of them carrying whole files — and this output
 * lands in a model's context window. One number cannot bound it: a count alone
 * lets fifty events carrying a megabyte of patch through, and a byte budget
 * alone will happily return four thousand tiny events. So both, whichever is
 * reached first, plus a per-string clamp so ONE enormous event cannot fill the
 * page on its own and hide the twenty after it.
 *
 * THE CAPS ARE STATED IN THE ANSWER, not just applied to it. A page that
 * silently looked complete is how a model reports a session's first ten
 * minutes as its whole life.
 */
const MAX_EVENTS = 50;
const MAX_EVENT_CHARS = 24_000;
const MAX_STRING_CHARS = 2_000;

/** One event, with any oversized string inside it clamped and MARKED. Recursive
 *  because the payloads nest (an item's detail, a turn's observations) and a
 *  top-level-only clamp would miss every one that matters. */
function clamp(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS)}… [${value.length - MAX_STRING_CHARS} more characters, not shown]`;
  }
  if (Array.isArray(value)) return value.map(clamp);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, clamp(inner)]));
  }
  return value;
}

/**
 * A page of events, and the honest cursor for the next one.
 *
 * THE CURSOR IS THE LAST EVENT ACTUALLY RETURNED, never the last one read. A
 * cursor that ran ahead of the page would skip everything the budget trimmed,
 * which is the exact failure a bounded read exists to avoid: silent loss that
 * looks like completeness.
 */
export function pageEvents(events: readonly EngineEvent[]): { page: unknown[]; cursor: number; more: boolean } {
  const page: unknown[] = [];
  let cursor = 0;
  let chars = 0;
  for (const event of events) {
    if (page.length >= MAX_EVENTS) return { page, cursor, more: true };
    const trimmed = clamp(event);
    const size = JSON.stringify(trimmed)?.length ?? 0;
    // The FIRST event is always let through whatever it costs: a page of zero
    // with `more: true` is a caller that can never advance.
    if (page.length > 0 && chars + size > MAX_EVENT_CHARS) return { page, cursor, more: true };
    page.push(trimmed);
    chars += size;
    cursor = event.id;
  }
  return { page, cursor, more: false };
}

/** A session as a caller should read it — the fields a person scans a sidebar
 *  for, and nothing about who created it, because nothing records that. */
function summarise(session: Session, projects: Map<string, string>) {
  return {
    id: session.id,
    // ABSENT IS THE PROJECT-LESS MASTER, said out loud rather than left blank:
    // a caller reading no `project` key cannot tell it from a dropped field.
    project: session.projectId ? (projects.get(session.projectId) ?? session.projectId) : "no project",
    ...(session.projectId ? { projectId: session.projectId } : {}),
    title: session.title,
    state: session.state,
    envMode: session.envMode,
    activity: session.activity,
    driver: session.driver,
    // The branch, when it has one of its own. It is what a human will look for
    // when they come to review the work, so a report that omits it is harder
    // to act on than one that names it.
    ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
    updatedAt: session.updatedAt,
  };
}

/** The turn states a caller means by "is anything running". Named once so the
 *  status tool and its own `running` flag cannot disagree. */
const LIVE_TURN_STATES = new Set(["queued", "claimed", "running"]);

/**
 * Build the toolkit.
 *
 * THE `tool` FACTORY ARRIVES AS AN ARGUMENT rather than being imported, the
 * same seam the spool and browser toolkits take: the provider SDK is loaded
 * lazily on the first run, and a module that imported it at the top would pull
 * it into every unit test. `zod` is imported directly — it is the engine's own
 * dependency, not the provider's.
 */
export function sessionsTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_list",
      LIST,
      // NO ARGUMENTS. There is nothing a caller could usefully narrow that the
      // engine does not already know, and the whole live set is small by
      // construction — the budget is what keeps it so.
      {},
      async () => {
        const { sessions, projects } = await capability.list();
        const names = new Map(projects.map((project) => [project.id, project.name]));
        return json({
          sessions: sessions.map((session) => summarise(session, names)),
          projects: projects.map((project) => ({ id: project.id, name: project.name })),
          ...(sessions.length === 0 ? { note: "No sessions are live on this engine." } : {}),
          ...(projects.length === 0
            ? { note2: "No projects are registered, so nothing can be created — the user registers a project themselves." }
            : {}),
        });
      },
    ),
    tool(
      "sessions_create",
      CREATE,
      {
        projectId: z.string().min(1).describe("Which project, by id, from sessions_list's `projects`. Required — a session lives in a project."),
        title: z
          .string()
          .optional()
          .describe("What this session is for, in a few words, as a person would read it in a list. Write one — an untitled session is unidentifiable an hour later."),
        envMode: z
          .enum(["local", "worktree"])
          .describe(
            '"worktree" for anything that edits files: the session gets a git checkout of its own and collides with nobody. ' +
              '"local" shares the project\'s own checkout with every other local session and with the user\'s editor. Required — there is no safe default.',
          ),
        driver: z
          .enum(["claude", "codex"])
          .optional()
          .describe("Which provider runs it. Leave it off unless the user asked for a specific one."),
      },
      async (args) => {
        const projectId = String(args.projectId ?? "");
        const envMode = args.envMode === "worktree" ? "worktree" : "local";
        let session: Session;
        try {
          session = await capability.create({
            projectId,
            ...(typeof args.title === "string" && args.title.trim() ? { title: args.title } : {}),
            envMode,
            ...(args.driver === "claude" || args.driver === "codex" ? { driver: args.driver } : {}),
          });
        } catch (error) {
          /**
           * THE STORE'S OWN SENTENCE, CARRIED WHOLE. The budget refusal names
           * the cap and the next move, and a wall that replaced it with
           * "could not create session" would delete the only actionable part.
           */
          return err(`Could not create a session on "${projectId}": ${failure(error)}`);
        }
        const names = new Map<string, string>();
        return json({
          ...summarise(session, names),
          note:
            session.workspace.mode === "worktree"
              ? `Created with a checkout of its own on branch ${session.workspace.branch}. Nothing is queued and nothing has started — send it a message to give it work.`
              : `Created against the project's own checkout, which it shares with anything else working there. Nothing is queued and nothing has started — send it a message to give it work.`,
          note2: "This session is a peer, not yours: it does not report back, and nothing records that you created it.",
        });
      },
    ),
    tool(
      "sessions_send",
      SEND,
      {
        sessionId: z.string().min(1).describe("The session to message, from sessions_list."),
        input: z.string().min(1).describe("The whole message. The session cannot see this conversation, so say everything it needs."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const text = String(args.input ?? "");
        /**
         * THE RUN ID IS MINTED HERE, not taken as an argument.
         *
         * `submitTurn` is idempotent on it — a resubmitted id with the same
         * text replays rather than queueing twice — and that guarantee is only
         * worth anything if the id belongs to the CALL. A model-supplied id
         * would let two different messages share one, which the store refuses
         * loudly, and a model reusing one by accident would silently lose its
         * second message.
         */
        const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
        try {
          const { turn } = await capability.send(sessionId, { runId, input: text });
          return json({
            sessionId,
            runId: turn.runId,
            state: turn.state,
            note: "Queued, not answered. The turn runs when a worker picks it up — check sessions_status, or read the reply with sessions_read.",
          });
        } catch (error) {
          return err(`Could not send to "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_read",
      READ,
      {
        sessionId: z.string().min(1).describe("The session to read, from sessions_list."),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Continue from a cursor a previous read returned. Leave it off to start at the beginning of the journal."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const after = typeof args.after === "number" && Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : 0;
        let events: EngineEvent[];
        try {
          events = await capability.read(sessionId, after);
        } catch (error) {
          return err(`Could not read "${sessionId}": ${failure(error)}`);
        }
        const { page, cursor, more } = pageEvents(events);
        return json({
          sessionId,
          from: after,
          // The cursor is the last event ON THE PAGE — see `pageEvents`.
          cursor: page.length > 0 ? cursor : after,
          more,
          events: page,
          note: more
            ? `This is a PAGE, not the whole journal: ${page.length} of ${events.length} events waiting past cursor ${after}. Call sessions_read again with after: ${cursor} for the next page. Long strings inside an event are clamped and marked where that happened.`
            : page.length === 0
              ? "Nothing has happened past that cursor yet."
              : "Everything past that cursor, in one page. Long strings inside an event are clamped and marked where that happened.",
        });
      },
    ),
    tool(
      "sessions_status",
      STATUS,
      { sessionId: z.string().min(1).describe("The session to ask about, from sessions_list.") },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        let answer: { session: Session; turns: Turn[] };
        try {
          answer = await capability.status(sessionId);
        } catch (error) {
          return err(`Could not read the status of "${sessionId}": ${failure(error)}`);
        }
        const { session, turns } = answer;
        const live = turns.filter((turn) => LIVE_TURN_STATES.has(turn.state));
        return json({
          ...summarise(session, new Map()),
          // THE DIRECT ANSWER TO THE QUESTION THIS TOOL IS FOR, said as a
          // boolean rather than left to be inferred from a list of states.
          running: live.length > 0,
          turns: turns.map((turn) => ({
            runId: turn.runId,
            sequence: turn.sequence,
            state: turn.state,
            ...(turn.failure ? { failure: turn.failure } : {}),
          })),
          note:
            session.activity === "blocked"
              ? "It is WAITING ON A PERSON — a request is open and only a human can answer it. Nothing you send will unblock it."
              : live.length > 0
                ? "A turn is in flight. Read it with sessions_read, or stop it with sessions_stop."
                : "Nothing is running.",
        });
      },
    ),
    tool(
      "sessions_stop",
      STOP,
      { sessionId: z.string().min(1).describe("The session whose turn should stop, from sessions_list.") },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          const { turn, stopped } = await capability.stop(sessionId);
          return json({
            sessionId,
            stopped,
            ...(turn ? { runId: turn.runId, state: turn.state } : {}),
            note: stopped
              ? "The turn is stopped. Whatever it had already written is still there — stopping ends a turn, it never undoes one."
              : "Nothing was running, so nothing was stopped. The session is unchanged.",
          });
        } catch (error) {
          return err(`Could not stop "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_diff",
      DIFF,
      { sessionId: z.string().min(1).describe("The session whose changes to read, from sessions_list.") },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        let diff: SessionDiff;
        try {
          diff = await capability.diff(sessionId);
        } catch (error) {
          return err(`Could not read the diff for "${sessionId}": ${failure(error)}`);
        }
        if (!diff.repository) {
          return json({
            sessionId,
            note: "That session's checkout is not a git repository, so there is no diff to read. That is a supported configuration, not a fault.",
          });
        }
        return json({
          sessionId,
          ...(diff.branch ? { branch: diff.branch } : {}),
          // ABSENT MEANS THE DIFF IS AGAINST HEAD, which excludes committed
          // work — said out loud, because a file list that quietly omitted
          // every commit would read as "this session did nothing".
          ...(diff.base ? { base: diff.base } : { baseUnknown: true }),
          linesAdded: diff.linesAdded,
          linesRemoved: diff.linesRemoved,
          commits: diff.commits.map((commit) => ({ sha: commit.shortSha, subject: commit.subject })),
          files: diff.files.map((file) => ({
            path: file.path,
            status: file.status,
            ...(file.renamedFrom ? { renamedFrom: file.renamedFrom } : {}),
            // Absent rather than zero: git counts neither a binary nor an
            // untracked file, and `+0` here would be a fabrication.
            ...(file.linesAdded === undefined ? {} : { linesAdded: file.linesAdded }),
            ...(file.linesRemoved === undefined ? {} : { linesRemoved: file.linesRemoved }),
            ...(file.binary ? { binary: true } : {}),
          })),
          ...(diff.truncated ? { truncated: true } : {}),
          note: !diff.base
            ? "This session has no recorded base, so the diff is against HEAD and any work it has already COMMITTED is not in this list."
            : diff.files.length === 0 && diff.commits.length === 0
              ? "This session has changed nothing in its checkout."
              : "A read of what changed, and nothing more. Nothing here merges, lands or approves any of it — that is the user's decision, and it is made elsewhere.",
        });
      },
    ),
  ];
}
