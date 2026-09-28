import { z } from "zod";
import type { EngineEvent, NotificationDetail, Session, Turn } from "@telar/engine-client";
import { STALLED_AFTER_MS } from "@telar/engine-client";
import { err, failure, json, type ToolFactory } from "../../agent-tools";
import { diffView } from "./control";
import { answerView, CHARS_DEFAULT, CHARS_MAX, grepView, outlineView, stepsView, STEPS_LIMIT_MAX, stepView } from "./query";
import { LIVE_TURN_STATES, MAX_EVENTS, MAX_RESULT_CHARS, MAX_RUN_ANSWER_CHARS, MAX_RUN_EVENT_CHARS, pageEvents, pageEventsFromEnd, quietNote, READ, readable, type SessionsCapability, STATUS, STATUS_TURNS_DEFAULT, STATUS_TURNS_MAX, summariseOne, summariseTurns, SUMMARY_TURNS_DEFAULT, SUMMARY_TURNS_MAX, TAIL_WINDOW, tailEvents, turnLine, WAITING_PHRASE, wholeNumber, withoutDuplicateBody } from "./shared";

const VIEWS = ["summary", "outline", "answer", "steps", "step", "events", "grep", "diff"] as const;

export function readTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_read",
      READ,
      {
        sessionId: z.string().min(1),
        view: z
          .enum(VIEWS)
          .optional()
          .describe('Default "summary". "outline" a row per turn, newest first; "answer" one turn\'s conclusion; "steps" what a turn did, with each step\'s byte cost; "step" one of them whole; "events" the raw journal; "grep" a phrase; "diff" what it changed.'),
        runId: z
          .string()
          .min(1)
          .optional()
          .describe("One turn — the id a wake gives you. summary/events: its events, its answer, and a peer message in full. answer: omit for the latest turn that left text. steps, step: required."),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("A cursor a previous read returned. events and a runId read: omit for the latest. steps: the `next` a previous page returned."),
        before: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("outline, grep: the `next` a previous page returned, so appends cannot shift the window."),
        from: z
          .enum(["start", "end"])
          .optional()
          .describe('events: "start" from the beginning; "end" (default) the latest. Ignored with `after`.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(STEPS_LIMIT_MAX)
          .optional()
          .describe(`Rows per page. events: default and max ${MAX_EVENTS}, and the byte budget may return fewer. outline, grep: default 20, max 100. steps: default 50, max ${STEPS_LIMIT_MAX}.`),
        turns: z
          .number()
          .int()
          .min(1)
          .max(SUMMARY_TURNS_MAX)
          .optional()
          .describe(`summary: default ${SUMMARY_TURNS_DEFAULT}.`),
        verbose: z
          .boolean()
          .optional()
          .describe("events and a runId read: keep usage rows and policy-resolved requests. Settled turns keep only their last usage row and no policy-resolved requests."),
        resultAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("A runId read, answer: continue the answer from this character offset."),
        messageAfter: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("A runId read: the same for a peer message's body."),
        step: z
          .union([z.number().int().min(0), z.string().min(1)])
          .optional()
          .describe('step: the index view "steps" gave, or an item id.'),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(CHARS_MAX)
          .optional()
          .describe(`step, answer: default ${CHARS_DEFAULT}, which is also the least answer sends; what is cut is marked.`),
        pattern: z
          .string()
          .min(1)
          .optional()
          .describe("grep: case-insensitive substring, matched anywhere in an event — not a regular expression."),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        switch (args.view) {
          case "outline":
            return outlineView(capability.query, sessionId, args);
          case "answer":
            return answerView(capability.query, sessionId, args);
          case "steps":
            return stepsView(capability.query, sessionId, args);
          case "step":
            return stepView(capability.query, sessionId, args);
          case "grep":
            return grepView(capability.query, sessionId, args);
          case "diff":
            return diffView(capability, sessionId);
          default:
            return journalView(capability, sessionId, args);
        }
      },
    ),
  ];
}

async function journalView(capability: SessionsCapability, sessionId: string, args: Record<string, unknown>) {
  const askedAfter = wholeNumber(args.after);
  const after = askedAfter ?? 0;
  const runId = typeof args.runId === "string" && args.runId.length > 0 ? args.runId : undefined;
  const verbose = args.verbose === true;
  const limit =
    typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit >= 1 ? Math.min(args.limit, MAX_EVENTS) : MAX_EVENTS;
  const resultAfter = wholeNumber(args.resultAfter);
  const messageAfter = wholeNumber(args.messageAfter);
  const wantsTail = askedAfter === undefined && runId === undefined && args.from !== "start";
  let events: EngineEvent[];
  let tailReached = true;
  try {
    if (wantsTail) {
      const found = await tailEvents(capability, sessionId, limit);
      events = found.events;
      tailReached = found.reached;
    } else {
      events = await capability.read(sessionId, after, runId === undefined ? { limit: TAIL_WINDOW } : undefined);
    }
  } catch (error) {
    return err(`Could not read "${sessionId}": ${failure(error)}`);
  }
  if (runId !== undefined) return readOneRun(capability, { sessionId, runId, events, verbose, limit, after, resultAfter, messageAfter });
  const kept = verbose ? events : events.filter(readable);
  const quiet = events.length - kept.length;
  if (args.view !== "events") {
    const wanted =
      typeof args.turns === "number" && Number.isSafeInteger(args.turns) && args.turns >= 1
        ? Math.min(args.turns, SUMMARY_TURNS_MAX)
        : SUMMARY_TURNS_DEFAULT;
    let turns: Turn[];
    let turnCount: number;
    try {
      const status = await capability.status(sessionId, { recent: wanted });
      turns = status.turns;
      turnCount = status.turnCount ?? turns.length;
    } catch (error) {
      return err(`Could not summarise "${sessionId}": ${failure(error)}`);
    }
    const summary = summariseTurns(turns, kept, wanted);
    return json({
      sessionId,
      view: "summary",
      turnCount,
      turns: summary,
      cursor: events.at(-1)?.id ?? 0,
      note:
        turnCount === 0
          ? "This session has taken no turns."
          : `The last ${summary.length} of ${turnCount} turns. "did" lists what a turn's items were called, for turns inside the page this read covered. For a turn's whole answer or its events, call sessions_read with its runId; for raw events, view: "events".`,
    });
  }
  const paged = wantsTail
    ? (() => {
        const tail = pageEventsFromEnd(kept, { limit });
        return { page: tail.page, cursor: tail.cursor, from: tail.from, more: false, earlier: tail.earlier || !tailReached };
      })()
    : (() => {
        const forward = pageEvents(kept, { limit });
        return { page: forward.page, cursor: forward.cursor, from: after, more: forward.more, earlier: false };
      })();
  const { page, cursor, more } = paged;
  return json({
    sessionId,
    from: paged.from,
    cursor: page.length > 0 ? cursor : after,
    more,
    ...(wantsTail ? { earlier: paged.earlier } : {}),
    ...(quiet > 0 ? { quietEvents: quiet } : {}),
    events: page,
    note: wantsTail
      ? page.length === 0
        ? "This session's journal is empty."
        : `The LATEST ${page.length} events${paged.earlier ? " — there is more behind them" : " (the whole journal)"}. Poll for what happens next with sessions_read(view: "events", after: ${cursor}); read from the beginning with from: "start"; get a turn-by-turn fold with view: "summary". Long strings inside an event are clamped and marked where that happened.`
      : more
        ? `A PAGE, not the whole journal: ${page.length} events past cursor ${after}, with more behind them. Call sessions_read again with view: "events", after: ${cursor}. Long strings inside an event are clamped and marked where that happened.`
        : page.length === 0
          ? "Nothing has happened past that cursor yet."
          : "Everything past that cursor, in one page. Long strings inside an event are clamped and marked where that happened.",
  });
}

async function readOneRun(
  capability: SessionsCapability,
  input: { sessionId: string; runId: string; events: EngineEvent[]; verbose: boolean; limit: number; after: number; resultAfter?: number; messageAfter?: number },
) {
  const { sessionId, runId, events, verbose, limit, after, resultAfter, messageAfter } = input;
    const scoped = events.filter((event) => event.runId === runId);
    const mine = verbose ? scoped : scoped.filter(readable);
    const quiet = scoped.length - mine.length;
    let turn: Turn | undefined;
    try {
      turn = capability.turn
        ? await capability.turn(sessionId, runId)
        : (await capability.status(sessionId)).turns.find((candidate) => candidate.runId === runId);
    } catch {
      turn = undefined;
    }
    const answer = turn?.resultText ?? "";
    const wantsResult = turn !== undefined && answer.length > 0 && (resultAfter !== undefined || after === 0);
    const from = Math.min(resultAfter ?? 0, answer.length);
    const slice = wantsResult ? answer.slice(from, from + MAX_RESULT_CHARS) : "";
    const resultMore = wantsResult && from + slice.length < answer.length;
    const nextResult = from + slice.length;
    const body = turn?.origin === "session" && turn.sender ? turn.input : "";
    const { page, cursor, more } = pageEvents(body.length > 0 ? mine.map(withoutDuplicateBody) : mine, {
      limit,
      chars: MAX_RUN_EVENT_CHARS,
    });
    const wantsMessage = body.length > 0 && (messageAfter !== undefined || after === 0);
    const messageFrom = Math.min(messageAfter ?? 0, body.length);
    const messageSlice = wantsMessage ? body.slice(messageFrom, messageFrom + MAX_RESULT_CHARS) : "";
    const messageMore = wantsMessage && messageFrom + messageSlice.length < body.length;
    const nextMessage = messageFrom + messageSlice.length;
    const nextCursor = page.length > 0 ? cursor : after;
    const continuation =
      more || resultMore || messageMore
        ? [
            `after: ${nextCursor}`,
            ...(resultMore ? [`resultAfter: ${nextResult}`] : []),
            ...(messageMore ? [`messageAfter: ${nextMessage}`] : []),
          ]
        : [];
    const messageNote = !body
      ? ""
      : wantsMessage
        ? messageMore
          ? ` The message that started this turn: characters ${messageFrom}-${nextMessage} of ${body.length}.`
          : ` The message that started this turn is here in full (${body.length} characters).`
        : ` The message that started this turn (${body.length} characters) is not on this page — ask with messageAfter: 0.`;
    return json({
      sessionId,
      runId,
      ...(turn
        ? {
            state: turn.state,
            ...(turn.failure ? { failure: turn.failure } : {}),
            ...(answer ? { resultChars: answer.length } : {}),
            ...(wantsResult ? { result: slice, resultFrom: from, resultMore } : {}),
            ...(body ? { messageChars: body.length, ...(turn.agentIntent ? { messageIntent: turn.agentIntent } : {}) } : {}),
            ...(wantsMessage ? { message: messageSlice, messageFrom, messageMore } : {}),
          }
        : {}),
      cursor: page.length > 0 ? cursor : after,
      more,
      events: page,
      ...(quiet > 0 ? { quietEvents: quiet } : {}),
      note: turn === undefined
        ? `No turn ${runId} on this session. Its events, if any, are above; sessions_status lists the turns this session has.`
        : continuation.length > 0
          ? `That run: ${page.length} events${more ? ` of ${mine.length} past cursor ${after}` : " (no more events)"}${
              wantsResult ? `, answer characters ${from}-${nextResult} of ${answer.length}` : answer ? `, answer not on this page (${answer.length} characters)` : ""
            }.${messageNote} Continue with sessions_read(sessionId: "${sessionId}", runId: "${runId}", ${continuation.join(", ")}).`
          : answer
            ? wantsResult
              ? `That run's events and its whole answer (${answer.length} characters). Nothing else was needed.${messageNote}`
              : `That run's events. Its answer (${answer.length} characters) is not on this page — ask with resultAfter: 0.${messageNote}`
            : `That run's events. It ended with no answer text.${messageNote}`,
    },
    MAX_RUN_ANSWER_CHARS);
}

export function statusTools(tool: ToolFactory, capability: SessionsCapability): unknown[] {
  return [
    tool(
      "sessions_status",
      STATUS,
      {
        sessionId: z.string().min(1),
        turns: z
          .number()
          .int()
          .min(1)
          .max(STATUS_TURNS_MAX)
          .optional()
          .describe(`Default ${STATUS_TURNS_DEFAULT}; live turns are always included.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        const wanted =
          typeof args.turns === "number" && Number.isSafeInteger(args.turns) && args.turns >= 1
            ? Math.min(args.turns, STATUS_TURNS_MAX)
            : STATUS_TURNS_DEFAULT;
        let answer: { session: Session; turns: Turn[]; turnCount?: number; pendingNotifications?: NotificationDetail[] };
        try {
          answer = await capability.status(sessionId, { recent: wanted });
        } catch (error) {
          return err(`Could not read the status of "${sessionId}": ${failure(error)}`);
        }
        const { session, turns } = answer;
        const pending = answer.pendingNotifications ?? [];
        const live = turns.filter((turn) => LIVE_TURN_STATES.has(turn.state));
        const withLive = turns.slice(-wanted);
        for (const turn of live) if (!withLive.some((candidate) => candidate.runId === turn.runId)) withLive.push(turn);
        withLive.sort((left, right) => left.sequence - right.sequence);
        const turnCount = answer.turnCount ?? turns.length;
        const dropped = turnCount - withLive.length;
        const unclaimable = session.preparation !== undefined;
        return json({
          ...summariseOne(session, new Map()),
          running: live.length > 0 && !unclaimable,
          turnCount,
          turns: withLive.map(turnLine),
          ...(dropped > 0 ? { turnsNotShown: dropped } : {}),
          ...(pending.length > 0 ? { pendingNotifications: pending.map((detail) => detail.summary) } : {}),
          ...(session.activityDetail ? { activityDetail: session.activityDetail } : {}),
          note: session.preparation?.state === "failed"
            ? `It has NO CHECKOUT — creating one failed, so nothing in its queue can run and nothing you send will start. Git said: ${
                session.preparation.error ?? "no reason was recorded"
              }`
            : session.preparation?.state === "preparing"
              ? "Its checkout is still being made. Nothing has started yet; anything queued runs once the checkout lands."
              : session.activity === "blocked"
              ? "It is WAITING ON A PERSON — a request is open and only a human can answer it. Nothing you send will unblock it."
              : live.some((turn) => turn.stalled)
                ?
                  `A turn is in flight but has journalled NOTHING for over ${Math.round(STALLED_AFTER_MS / 60_000)} minutes. That may be a long command and may be a wedge — read it with sessions_read before deciding. Nothing has been stopped.`
              : live.length > 0
                ? `${session.activityDetail?.kind === "tool" ? `A turn is in flight, but it is only waiting ${WAITING_PHRASE[session.activityDetail.waitingOn]}.` : "A turn is in flight."} Read it with sessions_read, or stop it with sessions_stop.${pending.length > 0 ? ` ${pending.length} notification${pending.length === 1 ? "" : "s"} are waiting for it to finish.` : ""}`
                : pending.length > 0
                  ? `Nothing is running, and ${pending.length} notification${pending.length === 1 ? "" : "s"} are waiting to be delivered.`
                  : quietNote(session),
        });
      },
    ),
  ];
}
