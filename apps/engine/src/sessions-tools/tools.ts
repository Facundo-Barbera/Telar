/**
 * The `sessions` toolkit — a session's only path to OTHER sessions.
 *
 * Modelled on `../spool/tools.ts` down to the seams: a capability PORT, a wall
 * of tools built over it, `tool` arriving as an argument so no test needs an
 * SDK, and every rule about a session implemented ONCE, in the store, rather
 * than here.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
 * There is NO PARENT AND NO CHILD here. A session that calls `sessions_create`
 * gets back a session it has no relationship to: nothing links the two,
 * nothing records which one asked on either session, no depth is tracked.
 * They are peers, and every tool below treats every session the same way
 * regardless of who created it.
 *
 * WHAT A SESSION CAN HAVE INSTEAD IS A SUBSCRIPTION: an explicit, revocable,
 * one-directional wish to be WOKEN when a peer finishes a turn, fails, is
 * stopped, or parks a request. It is recorded on the subscription and on
 * neither session, it is the subscriber's to remove, and it makes no claim
 * about who owns whom — an orchestrator subscribed to ten workers and a
 * worker subscribed to its orchestrator are the same shape. The wake is a
 * real turn in the subscriber's own session (`Turn.origin: "session"`), so an
 * orchestrator that ended its turn is woken by the engine rather than left
 * polling.
 *
 * AND A SESSION CAN ANSWER A PEER'S PARKED REQUEST — a question, an approval
 * — through `sessions_resolve_request`, recorded as answered by a session so
 * the audit trail never says a person did. The one thing it cannot answer is
 * a secret pick: that is a vault item the answering session cannot see.
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
 *     archive a session could erase another agent's work with one call.
 *     `sessions_settle` is deliberately NOT one of these: it moves a session
 *     out of (or back into) the list and touches nothing else — the same
 *     reversible switch as the sidebar's Settle button, so an orchestrator
 *     can tidy the peers it finished with without being handed a verb that
 *     destroys anything.
 *   · NO PERMISSION LAUNDERING, which is the one rule this wall can only SAY.
 *     See `NOT_A_BYPASS` below: it is stated in the prose of every tool that
 *     could be used for it, because that text is the only voice the wall has
 *     on a question no check here can settle.
 *   · NO WAY TO REACH A FAN-OUT CHILD'S HANDS. `sessions_create` is fan-out by
 *     another name, and `warp/spawn.ts` already denies a warp child the ability
 *     to fan out; these tools join the list it already keeps.
 *
 * ── NO CAP, AND WHY ─────────────────────────────────────────────────────────
 * There used to be a live-session budget in `EngineStore.createSession`, and
 * it was removed when a session was allowed to ORCHESTRATE many: an agent
 * driving ten worktrees is the use, not the abuse. What bounds creation now is
 * the person — archive and delete are theirs and nobody else's — and the
 * prose of `sessions_create`, which is the only voice this wall has on a
 * question no count can settle. See `Session.origin`, which still says who
 * asked.
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { EngineEvent, EngineRequest, EnvMode, ProviderDriverKind, Session, SessionDiff, Subscription, Turn, WakeKind } from "@telar/engine-client";

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
   * `source: "session"` is. Provenance a list can show; nothing counts it.
   */
  create(input: { projectId: string; title?: string; envMode: EnvMode; driver?: ProviderDriverKind }): Promise<Session>;
  /** Queue ONE turn. The `runId` is minted by the wall so a retry of the same
   *  tool call cannot double-submit. */
  send(sessionId: string, input: { runId: string; input: string; intent?: Turn["agentIntent"] }): Promise<{ turn: Turn; replayed: boolean }>;
  /** The journal after a cursor. The STORE returns the whole tail; the bound is
   *  this wall's, because the wall is what lands in a model's context. */
  read(sessionId: string, after: number): Promise<EngineEvent[]>;
  status(sessionId: string): Promise<{ session: Session; turns: Turn[] }>;
  /**
   * PAUSE, NOT A ONE-TURN STOP — `EngineStore.pauseSession`, stamped
   * `by: "session"`. A stop of one turn lets the worker take the next queued
   * message within a heartbeat, which is exactly what an agent asking a peer
   * to stop did not mean. Measured: a stop was followed within a second by a
   * new run on the same session. There is NO resume on this wall: a pause an
   * agent could lift is a pause a person cannot rely on.
   */
  /** Stop the session's work: `stopped` is every turn settled (the live one
   *  plus whatever was waiting), `live` the one that was actually running. No
   *  hold count and no `already` — there is no latch to be already in. */
  stop(sessionId: string): Promise<{ stopped: Turn[]; live?: Turn }>;
  /**
   * SHELVE OR UNSHELVE A SESSION IN THE LIST — `Session.settledOverride`, the
   * same switch the sidebar's Settle button flips. NOT an archive: the session
   * stays live and resumable, nothing is deleted, and a new message (or a
   * wake) lifts it again. It is the one housekeeping verb an orchestrator
   * needs when a peer it started has finished and is now only clutter.
   */
  settle(sessionId: string, settled: boolean): Promise<Session>;
  diff(sessionId: string): Promise<SessionDiff>;
  /**
   * WHO IS ASKING — present inside a turn, ABSENT on the outward socket. A
   * subscription needs a session to wake; a chat client on the socket is not
   * one, and the three subscription tools refuse there in words rather than
   * subscribing nobody.
   */
  self?: { sessionId: string };
  subscribe(subscriberSessionId: string, input: { targetSessionId: string; events?: WakeKind[]; once?: boolean }): Promise<Subscription>;
  unsubscribe(subscriptionId: string, subscriberSessionId: string): Promise<boolean>;
  subscriptions(subscriberSessionId: string): Promise<Subscription[]>;
  /** Every request a session has, open or resolved; the wall keeps the open ones. */
  requests(sessionId: string): Promise<EngineRequest[]>;
  /** The implementation stamps `resolvedBy: "session"`; no shape carries it. */
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: "accept" | "acceptForSession" | "decline"; reason?: string; answers?: Record<string, string> },
  ): Promise<EngineRequest>;
};

import { err, failure, json, ok, type ToolFactory } from "../tool-kit";
export type { ToolFactory };

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

const LIST = `Every session that is alive on this engine right now — its id, its project, its title, whether it is working or waiting on somebody, and whether it has a checkout of its own — plus the projects a session could be created in. Read this before creating anything: the session you want may already exist, and what you would otherwise create twice is on this list.`;

const CREATE = `Start a NEW session on a project, with no relationship to this one. It is a PEER, not a child: nothing links the two, it does not report back to you, and you learn what it did only by asking (sessions_read, sessions_status, sessions_diff). It starts with no turn queued — creating a session begins no work; sessions_send with intent: "task" is what does.

envMode is the choice that matters. "worktree" gives it a git checkout of its own, so it can edit files without colliding with anything else working on that project — this is what you want for anything that writes code. "local" points it at the project's own checkout, which it then SHARES with every other local session and with the user's own editor.

There is no cap on how many sessions you may create, so the discipline is yours: sessions do not clean themselves up — one you started stays live until a human archives it — and every worktree session is a whole checkout on the user's disk. Create what the work needs and nothing more. To be told when it finishes, sessions_subscribe to it. ${NOT_A_BYPASS}`;

const SEND = `Send a message to another session with an explicit intent. Routine report (the default) is passive: recorded as collapsed activity, never injected into a running model or queued for execution. Use result for a finished outcome: it wakes only a coordinator that is subscribed to this sender's completion. Use blocker only for an actionable issue requiring the recipient's intervention. Use task to explicitly assign new work, not to relay progress or acknowledgements. Task, awaited result, and blocker may steer a running recipient. A human Stop blocks all these until the human sends a new message.

Say everything needed; sessions cannot see each other's conversations. Do not acknowledge acknowledgements or send duplicate checkpoints alongside automatic completion notices. ${NOT_A_BYPASS}`;

const NO_SELF =
  "This door has no session to wake: subscriptions need a calling session, and this client is not one. Poll with sessions_status instead.";

const SUBSCRIBE = `Ask to be WOKEN when a session does something: finishes a turn, fails, is stopped, or parks a request (a question, an approval) that somebody has to answer. A wake is a real turn in YOUR session — a message beginning "[wake: completed]", "[wake: failed]", "[wake: stopped]" or "[wake: waiting]" that names the session, the run and what happened — so you can end your turn now and be woken later rather than polling.

A WAKE IS A PING, NOT A REPORT. It carries no result body and no request payload — only what happened, to which session and which run, because it lands in your context whether or not you need the detail. It names the call that fetches it: sessions_read(sessionId, runId). Read it when it matters and skip it when it does not. A parked request is the same: the notice gives its id, kind and a short title, and the fields you would answer from are one read away. If you are mid-turn when it arrives, it is delivered INTO that turn as a message, the way a person typing at you would be; if you are idle, it starts your next turn. One waiting wake per child turn: if that turn parks a request and then finishes before you have read the first wake, the waiting wake is rewritten with the newer state rather than a second one arriving. If sixteen turns are already waiting on you, a wake is dropped and your journal says so.

events narrows what wakes you (default: all four). Subscriptions are one-shot by default: the first matching wake removes them. Subscribe only when awaiting a concrete result or blocker. Explicit once: false opts into ongoing monitoring; unsubscribe when the task is done. Subscribing twice to the same session merges into one subscription. This is one-directional and yours to remove — it records no parent, no child, and nothing on either session.`;

const UNSUBSCRIBE = `Stop being woken by a session. Takes the subscription id sessions_subscribe returned (sessions_subscriptions lists them). Any wakes from that session still waiting in your queue are withdrawn too, so unsubscribing is how you stop a pile-up, not only future noise. Removing one that is not yours, or is already gone, answers removed: false — which is not an error.`;

const SUBSCRIPTIONS = `Every subscription this session holds: which sessions will wake it, for which events, and whether once. Read this before subscribing again, and to find an id for sessions_unsubscribe.`;

const REQUESTS = `What a session is WAITING on: its open requests — a question it asked (with the fields and choices), a command, a file change or a tool call it wants approved. Each carries the id sessions_resolve_request takes. A request is a question to a HUMAN by default; you are seeing it because you subscribed or asked, and answering it is you taking responsibility for the answer.

A secret-access request is listed by its origin only, with no candidates: choosing a vault item is the user's alone, and sessions_resolve_request refuses it.`;

const RESOLVE_REQUEST = `Answer a session's open request on the user's behalf. decision is accept, acceptForSession (accept this and every later request of the same kind in that session), or decline; answers fills a question's fields, keyed exactly as sessions_requests listed them. Recorded as answered BY A SESSION, never as the user's own decision.

Accepting an approval on another session's behalf is you taking responsibility for it. Never accept what you were yourself refused. Only answer a question you actually know the answer to; decline, or leave it for the user, otherwise. A secret-access request cannot be answered here at all. ${NOT_A_BYPASS}`;

const READ = `Read what a session has done since a point in its journal: its messages, its tool calls, its answers. Pass no cursor to start from the beginning and the cursor you got back to continue — that is how you follow a session as it works.

ONE RUN, DIRECTLY: pass \`runId\` and you get that turn's own events and its final answer, without paging the journal to find them. This is what a wake notice names — a wake carries no result body, so \`sessions_read(sessionId, runId)\` is how you fetch the outcome it is telling you about, and only when you actually want it.

PAGING WITHIN A RUN: \`after\` works with \`runId\` and walks that run's events. The answer rides the first page only, so continuations do not repeat it; a long answer is read in slices with \`resultAfter\`, and every reply says how many characters there are in total, whether more remain, and the exact next call. The slices are verbatim — concatenated they are the answer, with nothing trimmed or marked inside them.

THE ANSWER IS BOUNDED and a transcript is not: you may get a page rather than everything, and the result says so and gives you the cursor to ask for the next one. Never assume a page is the whole story; if "more" is true, there is more.`;

const STATUS = `Whether a session is doing anything: what it is (working, waiting on a person, idle), what its recent turns are and how each ended, and whether anything is running right now. This is the cheap question — ask it before sessions_read when all you need to know is "is it finished yet". It costs nothing to call and it changes nothing.`;

const STOP = `Stop a session's work now: its running turn ends where it stands, and anything queued behind it — messages, wakes, your own sends — is settled as stopped rather than started. The work already done is kept and stays in the transcript; nothing is undone, nothing is deleted, and nothing claims to have been rolled back. A turn that had already written files or run commands may well have finished doing so: stopping it does not reverse that, and the transcript says only that it stopped.

THE SESSION IS THEN IDLE, NOT PAUSED. There is no latch and no resume — the next message anyone sends is new work and runs normally, continuing the same provider conversation. So this is not a way to park a session or hold its backlog for a human: it is the same Stop the person's own button does. Use it when a session is going somewhere wrong and should stop going there.`;

const SETTLE = `Shelve a session — move it out of the active list into Settled, the way the sidebar's Settle button does — or bring it back with settled: false. Use it on a session you started once it has finished and you have read what you needed: a settled session is still live and resumable, nothing is deleted, and any new message (yours or a wake) lifts it back into the list. You may settle your own session as your last act. This is housekeeping, not acceptance: it says nothing about whether the work was good, and it archives nothing — archive and delete stay the user's.`;

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
/** A run-scoped read hands over the turn's answer whole, up to this. Larger
 *  than the per-string clamp on purpose: this IS what the caller asked for. */
const MAX_RESULT_CHARS = 8_000;

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
      // engine does not already know, and the live set is small in practice —
      // bounded by nothing but the person's own tidiness.
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
           * THE STORE'S OWN SENTENCE, CARRIED WHOLE. A missing project, a
           * repository that cannot take a worktree, a driver that is not
           * installed — each refusal names its cause, and a wall that replaced
           * it with "could not create session" would delete the only
           * actionable part.
           */
          return err(`Could not create a session on "${projectId}": ${failure(error)}`);
        }
        const names = new Map<string, string>();
        return json({
          ...summarise(session, names),
          note:
            session.workspace.mode === "worktree"
              ? `Created with a checkout of its own on branch ${session.workspace.branch}. Nothing is queued and nothing has started — send it a message with intent: task to give it work.`
              : `Created against the project's own checkout, which it shares with anything else working there. Nothing is queued and nothing has started — send it a message with intent: task to give it work.`,
          note2: "This session is a peer, not yours: it does not report back, and nothing records that you created it.",
        });
      },
    ),
    tool(
      "sessions_send",
      SEND,
      {
        sessionId: z.string().min(1).describe("The session to message, from sessions_list."),
        intent: z.enum(["task", "report", "result", "blocker"]).optional().describe("Default report is passive. task assigns work; result wakes only an awaiting subscriber; blocker requires intervention."),
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
          const { turn } = await capability.send(sessionId, { runId, input: text, intent: args.intent === "task" || args.intent === "result" || args.intent === "blocker" ? args.intent : "report" });
          return json({
            sessionId,
            runId: turn.runId,
            state: turn.state,
            delivery: turn.agentDelivery,
            note: turn.agentDelivery === "passive" ? "Recorded as passive activity. No model was started or steered; do not wait for an acknowledgement." : "Accepted for execution, not answered. Check sessions_status or sessions_read. This is an agent message, never human approval.",
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
        runId: z
          .string()
          .min(1)
          .optional()
          .describe("One turn only: its own events and its final answer text, without paging the journal. This is the id a wake notice gives you. Combines with `after` — the cursor then walks that run's events."),
        resultAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("With `runId`: continue the ANSWER from this character offset. The reply says how many characters there are in total and whether more remain, so a long answer can be read whole in slices."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const after = typeof args.after === "number" && Number.isSafeInteger(args.after) && args.after >= 0 ? args.after : 0;
        const runId = typeof args.runId === "string" && args.runId.length > 0 ? args.runId : undefined;
        const resultAfter =
          typeof args.resultAfter === "number" && Number.isSafeInteger(args.resultAfter) && args.resultAfter >= 0 ? args.resultAfter : undefined;
        let events: EngineEvent[];
        try {
          // `after` is a journal cursor either way: with `runId` it walks THAT
          // run's events, which is what a second page of the same run needs.
          events = await capability.read(sessionId, after);
        } catch (error) {
          return err(`Could not read "${sessionId}": ${failure(error)}`);
        }
        if (runId !== undefined) {
          /**
           * ONE RUN, ANSWERED WITHOUT PAGING THE JOURNAL. A wake names a run and
           * carries no result; this is the other half of that trade. The events
           * are filtered to the run and bounded by the same page budget, and the
           * turn's own answer is handed over rather than reconstructed out of
           * observations.
           *
           * THE ANSWER IS SENT ONCE, NOT PER PAGE. A caller walking a long run's
           * events does not want the answer repeated on every continuation, so it
           * rides the FIRST page (`after: 0`) or an explicit `resultAfter` — and
           * a long one is read whole in slices rather than clipped away.
           */
          const mine = events.filter((event) => event.runId === runId);
          let turn: Turn | undefined;
          try {
            turn = (await capability.status(sessionId)).turns.find((candidate) => candidate.runId === runId);
          } catch {
            turn = undefined;
          }
          const { page, cursor, more } = pageEvents(mine);
          // NOT TRIMMED. The slices are meant to concatenate into the answer
          // exactly as the turn wrote it, and a trim would silently drop
          // leading or trailing whitespace that belongs to it — the one edit a
          // "verbatim" contract cannot make.
          const answer = turn?.resultText ?? "";
          const wantsResult = turn !== undefined && answer.length > 0 && (resultAfter !== undefined || after === 0);
          const from = Math.min(resultAfter ?? 0, answer.length);
          // VERBATIM: the slice carries no ellipsis and no marker, so slices
          // concatenated are the answer exactly as the turn wrote it.
          const slice = wantsResult ? answer.slice(from, from + MAX_RESULT_CHARS) : "";
          const resultMore = wantsResult && from + slice.length < answer.length;
          const nextResult = from + slice.length;
          /**
           * THE EVENT CURSOR RIDES EVERY CONTINUATION, including one asked for
           * only to finish reading an answer. Omitting it when the events had
           * run out left the next call defaulting to `after: 0`, which replayed
           * the run's first page of events under a result-only read.
           */
          const nextCursor = page.length > 0 ? cursor : after;
          const continuation =
            more || resultMore
              ? [`after: ${nextCursor}`, ...(resultMore ? [`resultAfter: ${nextResult}`] : [])]
              : [];
          return json({
            sessionId,
            runId,
            ...(turn
              ? {
                  state: turn.state,
                  ...(turn.failure ? { failure: turn.failure } : {}),
                  // The total is always reported when there IS an answer, even
                  // on a page that does not carry it — otherwise a caller cannot
                  // tell "no answer" from "answer not on this page".
                  ...(answer ? { resultChars: answer.length } : {}),
                  ...(wantsResult ? { result: slice, resultFrom: from, resultMore } : {}),
                }
              : {}),
            cursor: page.length > 0 ? cursor : after,
            more,
            events: page,
            note: turn === undefined
              ? `No turn ${runId} on this session. Its events, if any, are above; sessions_status lists the turns this session has.`
              : continuation.length > 0
                ? `That run: ${page.length} events${more ? ` of ${mine.length} past cursor ${after}` : " (no more events)"}${
                    wantsResult ? `, answer characters ${from}-${nextResult} of ${answer.length}` : answer ? `, answer not on this page (${answer.length} characters)` : ""
                  }. Continue with sessions_read(sessionId: "${sessionId}", runId: "${runId}", ${continuation.join(", ")}).`
                : answer
                  ? wantsResult
                    ? `That run's events and its whole answer (${answer.length} characters). Nothing else was needed.`
                    : `That run's events. Its answer (${answer.length} characters) is not on this page — ask with resultAfter: 0.`
                  : "That run's events. It ended with no answer text.",
          });
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
          const { stopped, live } = await capability.stop(sessionId);
          const settled = stopped.length;
          const behind = live ? settled - 1 : settled;
          return json({
            sessionId,
            stopped: settled,
            ...(live ? { runId: live.runId, state: live.state } : {}),
            note:
              settled === 0
                ? "Nothing was running and nothing was waiting; the session was already idle."
                : `${live ? "The turn is stopped" : "Nothing was running"}${behind > 0 ? ` and ${behind} waiting message${behind === 1 ? "" : "s"} ${behind === 1 ? "was" : "were"} settled rather than started` : ""}. Whatever it had already written is still there — stopping ends work, it never undoes it, and a command it had already run may have finished. The session is IDLE now, not paused: the next message runs normally.`,
          });
        } catch (error) {
          return err(`Could not stop "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_settle",
      SETTLE,
      {
        sessionId: z.string().min(1).describe("The session to shelve or unshelve, from sessions_list."),
        settled: z.boolean().optional().describe("Default true. false returns a settled session to the active list."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const settled = args.settled !== false;
        try {
          const session = await capability.settle(sessionId, settled);
          return json({
            sessionId,
            settled,
            title: session.title,
            note: settled
              ? "Settled. It is out of the active list but still live: a message to it, or a wake it receives, brings it back. Nothing was archived."
              : "Back in the active list.",
          });
        } catch (error) {
          return err(`Could not settle "${sessionId}": ${failure(error)}`);
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
    /**
     * THE SUBSCRIPTION TOOLS — appended after the original seven so the
     * pinned name list in the tests grows rather than reorders. Each begins
     * by asking whether there IS a self: on the outward socket there is not,
     * and the refusal is the tool's whole answer there.
     */
    tool(
      "sessions_subscribe",
      SUBSCRIBE,
      {
        sessionId: z.string().min(1).describe("The session to be woken by, from sessions_list or sessions_create."),
        events: z
          .array(z.enum(["turn_completed", "turn_failed", "turn_stopped", "request_opened"]))
          .optional()
          .describe("Which happenings wake you. Omit for all four."),
        once: z.boolean().optional().describe("Defaults to true: remove after the first wake. Set false only for intentional ongoing monitoring."),
      },
      async (args) => {
        if (!capability.self) return err(NO_SELF);
        const targetSessionId = String(args.sessionId ?? "");
        const events = Array.isArray(args.events) ? (args.events.filter((each) => typeof each === "string") as WakeKind[]) : undefined;
        try {
          const subscription = await capability.subscribe(capability.self.sessionId, {
            targetSessionId,
            ...(events && events.length > 0 ? { events } : {}),
            once: args.once !== false,
          });
          return json({
            ...subscription,
            note: `You will be woken with a "[wake: …]" turn when ${targetSessionId} does any of: ${subscription.events.join(", ")}${subscription.once ? " — once" : ""}. End your turn whenever you like; the wake queues. The notice is a ping — fetch an outcome with sessions_read(sessionId: "${targetSessionId}", runId) when you want it.`,
          });
        } catch (error) {
          return err(`Could not subscribe to "${targetSessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_unsubscribe",
      UNSUBSCRIBE,
      { subscriptionId: z.string().min(1).describe("The id sessions_subscribe returned.") },
      async (args) => {
        if (!capability.self) return err(NO_SELF);
        const subscriptionId = String(args.subscriptionId ?? "");
        try {
          const removed = await capability.unsubscribe(subscriptionId, capability.self.sessionId);
          return json({ subscriptionId, removed, ...(removed ? {} : { note: "No subscription of yours has that id — it was already removed, or it was never yours." }) });
        } catch (error) {
          return err(`Could not unsubscribe "${subscriptionId}": ${failure(error)}`);
        }
      },
    ),
    tool("sessions_subscriptions", SUBSCRIPTIONS, {}, async () => {
      if (!capability.self) return err(NO_SELF);
      try {
        const subscriptions = await capability.subscriptions(capability.self.sessionId);
        return json({
          subscriptions,
          ...(subscriptions.length === 0 ? { note: "This session is not subscribed to anything." } : {}),
        });
      } catch (error) {
        return err(`Could not list subscriptions: ${failure(error)}`);
      }
    }),
    tool(
      "sessions_requests",
      REQUESTS,
      { sessionId: z.string().min(1).describe("The session whose open requests to read.") },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        let requests: EngineRequest[];
        try {
          requests = (await capability.requests(sessionId)).filter((request) => request.state === "open");
        } catch (error) {
          return err(`Could not read requests of "${sessionId}": ${failure(error)}`);
        }
        return json({
          sessionId,
          requests: requests.map(describeRequest),
          ...(requests.length === 0 ? { note: "This session is not waiting on anything." } : {}),
        });
      },
    ),
    tool(
      "sessions_resolve_request",
      RESOLVE_REQUEST,
      {
        sessionId: z.string().min(1).describe("The session that opened the request."),
        requestId: z.string().min(1).describe("The request id, from sessions_requests or the wake that told you about it."),
        decision: z
          .enum(["accept", "acceptForSession", "decline"])
          .describe('"accept" this once; "acceptForSession" this and every later request of the same kind in that session; "decline".'),
        answers: z
          .record(z.string(), z.string())
          .optional()
          .describe("For a question: each field's answer, keyed exactly as sessions_requests listed the field."),
        reason: z.string().optional().describe("One sentence the session and the user will read beside the decision."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const requestId = String(args.requestId ?? "");
        const decision = args.decision === "acceptForSession" ? "acceptForSession" : args.decision === "decline" ? "decline" : "accept";
        // THE ONE REFUSAL THE WALL MAKES ITSELF: a vault pick. The store
        // would accept it — resolving is resolving — but the answer names an
        // item the deciding session cannot see, and nothing here should let
        // a model choose a password by index.
        try {
          const open = (await capability.requests(sessionId)).find((request) => request.id === requestId);
          if (open && open.detail.kind === "secret_access") {
            return err(`Request "${requestId}" is a secret-access request. Choosing a vault item is the user's alone; leave it for them.`);
          }
        } catch (error) {
          return err(`Could not read requests of "${sessionId}": ${failure(error)}`);
        }
        const answers =
          args.answers && typeof args.answers === "object"
            ? Object.fromEntries(Object.entries(args.answers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
            : undefined;
        try {
          const request = await capability.resolveRequest(sessionId, requestId, {
            decision,
            ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason } : {}),
            ...(answers ? { answers } : {}),
          });
          return json({
            ...describeRequest(request),
            decision: request.decision,
            resolvedBy: request.resolvedBy,
            note: "Recorded as answered by a session. The session that asked continues with this answer.",
          });
        } catch (error) {
          return err(`Could not resolve request "${requestId}" on "${sessionId}": ${failure(error)}`);
        }
      },
    ),
  ];
}

/**
 * A request as a model should see it: enough to answer, and for a secret
 * pick, deliberately less — origin only, never the candidates.
 */
function describeRequest(request: EngineRequest): Record<string, unknown> {
  const base = { id: request.id, runId: request.runId, kind: request.detail.kind, state: request.state, openedAt: request.openedAt };
  const detail = request.detail;
  switch (detail.kind) {
    case "user_input":
      return {
        ...base,
        prompt: detail.prompt,
        fields: detail.fields.map((field) => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(field.choices && field.choices.length > 0 ? { choices: field.choices } : {}),
          ...(field.required ? { required: true } : {}),
        })),
      };
    case "command_execution":
      return { ...base, command: detail.command.command };
    case "file_change":
      return { ...base, change: `${detail.change.kind} ${detail.change.path}` };
    case "file_read":
      return { ...base, path: detail.read.path };
    case "tool_call":
      return { ...base, tool: detail.call.name };
    case "secret_access":
      return { ...base, origin: detail.secret.origin, note: "A vault pick — the user's alone. sessions_resolve_request refuses it." };
  }
}
