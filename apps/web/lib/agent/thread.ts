"use client";

/**
 * THE AGENT'S CONVERSATION, READ AND FOLLOWED (#531).
 *
 * TWO SOURCES FOR ONE LIST, and keeping them honest is this module's whole job.
 * The transcript is PAGED from `/api/agent/thread` — durable rows, forward from
 * a cursor — and then FOLLOWED on `/api/agent/stream`, which replays from that
 * same cursor inside its own response before going live. Rows arrive from both,
 * so everything here is keyed by row id and merged rather than appended.
 *
 * A DELTA IS NOT A ROW. Tokens are pushed live and stored nowhere; the row that
 * follows carries the whole text. So a delta accumulates into a buffer that is
 * DISCARDED the moment its run produces a durable row — a client that appended
 * both would show the sentence twice, which is the one bug this shape exists to
 * make impossible.
 *
 * ── WHY NOT `sessionConnection` ─────────────────────────────────────────────
 * The cockpit's own sync is built on a session journal: turns, items, tasks,
 * requests, a revision per session. The Agent has none of those — it has a flat
 * row log and one thread — and threading a second entity through that machinery
 * would make every future change to it a change to both. This is small because
 * the thing it reads is small.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentAnswer, AgentRow, AgentState, AgentStreamEvent } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, rewriteApiPath, LOCAL_HOST_ID } from "@/lib/hosts/client";

/**
 * HOW MANY ROWS THE FIRST READ ASKS FOR — the LAST that many, not the first.
 *
 * THIS USED TO BE A PAGE COUNT (`MAX_THREAD_PAGES = 40`), because the engine
 * only paged forward: `after` was exclusive and `0` was the beginning, so
 * opening a conversation meant walking it from the first thing it ever said,
 * and the ceiling existed only so that the walk could not hang the screen. The
 * engine reads backward now (#580), so the walk is gone and the number that is
 * left is the one that was always wanted: a screenful of the END.
 *
 * OLDER ROWS ARE A GESTURE, NOT A WALK — see `loadOlder`.
 */
export const THREAD_TAIL_ROWS = 50;

/** What the screen draws, one entry per thing that happened. Derived from rows
 *  rather than stored, so a re-read cannot produce a different transcript. */
export type AgentItem =
  | { kind: "user"; id: number; at: number; runId: string; text: string; origin?: string; wakeReason?: string }
  | { kind: "assistant"; id: number; at: number; runId: string; text: string; itemId?: string; streaming?: boolean }
  | { kind: "tool"; id: number; at: number; runId: string; name: string; input: unknown; output: string; status: "completed" | "failed" | "declined" }
  | { kind: "failure"; id: number; at: number; runId: string; status: "failed" | "stopped"; message?: string };

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/**
 * MERGE ROWS BY ID, newest paging and live push into one ordered list.
 *
 * BY ID AND NOT BY POSITION, because the same row legitimately arrives twice:
 * the stream replays from the caller's cursor, and a reconnect replays again
 * from wherever the client had got to. Appending would duplicate the overlap
 * every time the connection blinked.
 *
 * SORTED BY ID rather than by `at`, because ids are monotonic within a thread
 * and timestamps are not guaranteed to be — two rows written in the same
 * millisecond would otherwise swap places between reads and make the transcript
 * jitter.
 */
export function mergeAgentRows(existing: readonly AgentRow[], incoming: readonly AgentRow[]): AgentRow[] {
  if (incoming.length === 0) return existing as AgentRow[];
  const byId = new Map<number, AgentRow>();
  for (const row of existing) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

/**
 * ROWS INTO WHAT THE SCREEN DRAWS.
 *
 * ── THE ASSISTANT SPEAKS IN `assistant_message` ROWS, AND ONLY THOSE ────────
 * One row per finished text segment, so a turn that says something, calls a
 * tool and then says something else produces two bubbles with the tool between
 * them — which is the conversation that actually happened.
 *
 * `turn_done.detail.text` IS NOT DRAWN, and that is the part worth stating
 * because it looks like a field going unused. It carries the FINAL assistant
 * text, deliberately duplicating the last `assistant_message` row: it exists
 * for a reader that wants one answer per turn without folding the log. This
 * screen folds the log, so drawing both would print the closing sentence of
 * every turn twice.
 *
 * WHAT `turn_done` IS STILL READ FOR is the two ways a turn can end without
 * one: failed, and stopped.
 *
 * A FAILED TURN NOW CARRIES ITS REASON IN BOTH FIELDS (#602) — `message` for
 * this screen and `text` for the one-answer-per-turn reader that has no log to
 * fold, the voice client among them. This screen still draws only `message`, so
 * the duplication costs nothing here and buys the other reader a sentence where
 * it used to get silence.
 *
 * `turn_started` IS NOT DRAWN. It carries nothing a reader needs that the user
 * message above it does not already say, and a marker per turn would be noise
 * in a conversation that is mostly one exchange.
 *
 * A REQUEST IS NOT AN ITEM EITHER. The approval the Agent is parked on is LIVE
 * state off `/api/agent` — one card at the bottom, not a row in the history —
 * because a request that has been answered is over and its `request_resolved`
 * row says so. Drawing an open card from history would resurrect decided ones.
 */
export function agentItems(rows: readonly AgentRow[]): AgentItem[] {
  const items: AgentItem[] = [];
  for (const row of rows) {
    const { id, at, runId, detail } = row;
    if (row.kind === "user_message") {
      items.push({
        kind: "user",
        id,
        at,
        runId,
        text: str(detail.text) ?? "",
        ...(str(detail.origin) ? { origin: str(detail.origin)! } : {}),
        ...(str(detail.wakeReason) ? { wakeReason: str(detail.wakeReason)! } : {}),
      });
      continue;
    }
    if (row.kind === "assistant_message") {
      const text = str(detail.text);
      // `itemId` IS WHAT THE LIVE DELTAS ARE KEYED BY, carried onto the item so
      // a streamed bubble can be reconciled against the row that lands rather
      // than drawn beside it. See `liveAssistantItem`.
      if (text) items.push({ kind: "assistant", id, at, runId, text, ...(str(detail.itemId) ? { itemId: str(detail.itemId)! } : {}) });
      continue;
    }
    if (row.kind === "tool_call") {
      const status = detail.status === "failed" ? "failed" : detail.status === "declined" ? "declined" : "completed";
      items.push({
        kind: "tool",
        id,
        at,
        runId,
        name: str(detail.name) ?? "tool",
        input: detail.input,
        output: str(detail.output) ?? "",
        status,
      });
      continue;
    }
    if (row.kind === "turn_done") {
      // A COMPLETED TURN DRAWS NOTHING. Its `text` duplicates the last
      // `assistant_message` row on purpose — see the note above.
      if (detail.status === "completed") continue;
      // FAILED AND STOPPED ARE BOTH SHOWN, and differently. A person who
      // pressed Cancel knows why the turn ended and needs no error; a turn that
      // fell over owes them the sentence.
      items.push({
        kind: "failure",
        id,
        at,
        runId,
        status: detail.status === "stopped" ? "stopped" : "failed",
        ...(str(detail.message) ? { message: str(detail.message)! } : {}),
      });
    }
  }
  return items;
}

/**
 * THE LIVE SENTENCE, as an item the transcript can draw at its end.
 *
 * ── RECONCILED BY `itemId`, WHICH IS THE WHOLE OF THIS FUNCTION ─────────────
 * A delta and the row that follows it carry the SAME `itemId`, so the buffer is
 * dropped the instant its own row lands — not when the run ends, and not when
 * some other message in the same run lands.
 *
 * KEYING THIS BY RUN WOULD BE WRONG IN BOTH DIRECTIONS now that a turn can
 * produce several messages. A first message landing would silence the buffer
 * for a second one that is still streaming; and a reconnect mid-turn, which
 * replays every row the client missed, would find the earlier row and hide a
 * sentence still arriving. Keyed by message, both cases are simply the right
 * answer.
 *
 * ITS ID IS ABOVE EVERY REAL ROW so it sorts to the bottom without the caller
 * having to special-case it. Nothing persists it, so the id never collides.
 */
export function liveAssistantItem(rows: readonly AgentRow[], live: { runId: string; itemId: string; text: string } | undefined): AgentItem | undefined {
  if (!live || !live.text) return undefined;
  const landed = rows.some((row) => row.kind === "assistant_message" && row.detail.itemId === live.itemId);
  if (landed) return undefined;
  return { kind: "assistant", id: Number.MAX_SAFE_INTEGER, at: Date.now(), runId: live.runId, itemId: live.itemId, text: live.text, streaming: true };
}

export type AgentThreadHandle = {
  items: AgentItem[];
  state: AgentState | undefined;
  credential: AgentAnswer["credential"];
  /** True until the first read has answered. The screen shows nothing rather
   *  than an empty conversation it is about to contradict. */
  loading: boolean;
  /** Older rows exist above what is drawn (#580). The transcript offers to
   *  fetch them; it never fetches them on its own. */
  hasOlder: boolean;
  /** One page further back, prepended. Merged by id like everything else here,
   *  so a row already held cannot arrive twice. */
  loadOlder: () => Promise<void>;
  /** A backward page is in flight — the button says so rather than looking
   *  dead on a slow link. */
  loadingOlder: boolean;
  /** The engine refused or is not answering. Shown rather than swallowed. */
  error?: string;
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  resolve: (requestId: string, decision: "accept" | "decline") => Promise<void>;
  /** The composer's three pills — model, effort, access — writing `agent.json`
   *  through the same route Settings uses. `""` clears a field. */
  configure: (patch: { model?: string; effort?: string; access?: string }) => Promise<void>;
  sending: boolean;
  /**
   * BUMPED WHEN AN INBOX ROW LANDS ON THE STREAM (#541 A) — a counter, not the
   * row.
   *
   * The stream's `inbox` frame is a NUDGE: it says something arrived, and the
   * inbox route is the authoritative list (a reconnect replays transcript rows
   * and not these). So this hook forwards the fact and `useAgentInbox` re-reads,
   * rather than holding a second copy of a list it does not own.
   */
  inboxNudge: number;
};

/**
 * `hostId` DEFAULTS TO THIS MAC. `/agent` is this cockpit's own engine;
 * `/hosts/<id>/agent` passes the Mac in the address bar and every call below is
 * routed there — the same rule every other screen in this cockpit follows.
 */
export function useAgentThread(hostId: string = LOCAL_HOST_ID): AgentThreadHandle {
  const [rows, setRows] = useState<readonly AgentRow[]>([]);
  const [live, setLive] = useState<{ runId: string; itemId: string; text: string }>();
  const [state, setState] = useState<AgentState>();
  const [credential, setCredential] = useState<AgentAnswer["credential"]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  /** See `AgentThreadHandle.inboxNudge` — a count of `inbox` frames seen, which
   *  is all a reader of the inbox route needs from this connection. */
  const [inboxNudge, setInboxNudge] = useState(0);
  /** Older rows above what is drawn, and the id to ask for them with (#580).
   *  `oldest` is a ref for `cursor`'s reason: `loadOlder` must not be rebuilt
   *  on every row that lands. */
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const oldest = useRef<number | undefined>(undefined);
  /**
   * THE FIRST READ HAS LANDED, so the stream may open.
   *
   * IT IS A GATE, NOT A FLAG. The stream resumes from `cursor.current`, and
   * both effects mount together — so without this the connection would open at
   * `0` and the engine would replay the entire transcript down it, which is
   * exactly the cost the tail read exists to avoid.
   */
  const [opened, setOpened] = useState(false);
  const api = useMemo(() => createEngineApi(hostFetcher(hostId)), [hostId]);
  /** The highest row id this screen holds — where a reconnect resumes from.
   *  A ref rather than state because the stream effect must not re-run every
   *  time a row arrives; re-running it would reopen the connection per row. */
  const cursor = useRef(0);

  const remember = useCallback((incoming: readonly AgentRow[]) => {
    if (incoming.length === 0) return;
    for (const row of incoming) cursor.current = Math.max(cursor.current, row.id);
    setRows((held) => mergeAgentRows(held, incoming));
  }, []);

  // THE FIRST READ: the Agent's own state, then the LAST page of the
  // transcript (#580). Deferred a tick like every other loader here — setting
  // state from an effect BODY is the cascade this app's lint forbids.
  useEffect(() => {
    let cancelled = false;
    const task = window.setTimeout(() => {
      void (async () => {
        try {
          const answer = await api.agent();
          if (cancelled) return;
          setState(answer.agent);
          setCredential(answer.credential);
          const chunk = await api.agentThread({ tail: true, limit: THREAD_TAIL_ROWS });
          if (cancelled) return;
          remember(chunk.rows);
          // THE TIP, NOT THIS WINDOW'S TOP. An empty thread answers `0`, which
          // is where a forward poll starts anyway.
          cursor.current = Math.max(cursor.current, chunk.cursor);
          oldest.current = chunk.oldest;
          setHasOlder(chunk.more);
        } catch (cause) {
          if (!cancelled) setError(cause instanceof Error ? cause.message : "The engine is not answering.");
        } finally {
          if (!cancelled) {
            setLoading(false);
            setOpened(true);
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [api, hostId, remember]);

  /**
   * ONE PAGE FURTHER BACK, on a gesture.
   *
   * `oldest` IS THE CURSOR, not the count of what is held: a row that arrived
   * on the stream while the reader was scrolled up is newer than everything
   * here and must not move where the next backward page starts.
   */
  const loadOlder = useCallback(async () => {
    const before = oldest.current;
    if (before === undefined || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const chunk = await api.agentThread({ before, limit: THREAD_TAIL_ROWS });
      remember(chunk.rows);
      // A WINDOW THAT CAME BACK EMPTY IS THE TOP, whatever it says about
      // `more` — leaving `oldest` where it was would let the same empty read
      // be made for ever.
      oldest.current = chunk.oldest ?? undefined;
      setHasOlder(chunk.oldest !== undefined && chunk.more);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine is not answering.");
    } finally {
      setLoadingOlder(false);
    }
  }, [api, loadingOlder, remember]);

  /**
   * THE LIVE FEED, and it is `fetch` rather than `EventSource`.
   *
   * WHY NOT `EventSource`. It cannot send a header, and while the cockpit's own
   * `/api` needs none, the REMOTE hop does not change that — what it cannot do
   * is be ABORTED on unmount without leaving the browser to reconnect on its
   * own schedule, and it cannot resume from a cursor of our choosing. Reading
   * the body with a reader gives both: the cursor is ours, and the abort is
   * exact.
   *
   * RECONNECT IS THE NORMAL CASE, not the error case. A stream ends when a
   * proxy times it out, when the engine restarts, when a laptop sleeps. Each
   * time it reopens with `after` at the last row this screen holds, and the
   * engine replays from there inside the new response — so nothing is missed
   * and nothing is duplicated (rows merge by id).
   *
   * THE BACKOFF IS THERE FOR THE ENGINE THAT IS DOWN. Without it a reconnect
   * loop against a refused port is a tight spin; with it a browser left open
   * overnight against a stopped engine costs one request every few seconds.
   *
   * IT WAITS FOR `opened`, and that is load-bearing rather than tidy: this
   * resumes from `cursor.current`, so opening before the tail read has set it
   * would replay the whole transcript down the connection (#580).
   */
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    let stopped = false;
    let delay = 1_000;

    const follow = async (): Promise<void> => {
      while (!stopped) {
        try {
          const path = rewriteApiPath(`/api/agent/stream?after=${cursor.current}`, hostId);
          const response = await fetch(path, { signal: controller.signal, headers: { accept: "text/event-stream" } });
          if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
          delay = 1_000;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            buffer += value;
            // FRAMES ARE SPLIT ON THE BLANK LINE, which is SSE's own boundary.
            // A partial frame stays in the buffer until the rest of it arrives
            // — a chunk boundary falls wherever the network puts it, and
            // parsing half a JSON row would drop it.
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");
              // `: beat` is the engine's keep-alive. Not an event, and no
              // client has to know about it.
              if (!frame.startsWith("data:")) continue;
              let event: AgentStreamEvent;
              try {
                event = JSON.parse(frame.slice("data:".length).trim()) as AgentStreamEvent;
              } catch {
                continue;
              }
              if (event.type === "row") {
                remember([event.row]);
                // A ROW ENDS THE SENTENCE IT BELONGS TO — the one with its own
                // `itemId`, not merely one from the same run. A turn can say
                // several things, and an earlier message landing must not
                // silence a later one still arriving.
                setLive((held) => (held && event.row.kind === "assistant_message" && event.row.detail.itemId === held.itemId ? undefined : held));
                // AND A TURN THAT ENDS CLEARS WHATEVER IS LEFT. A run that
                // failed mid-sentence has a buffer no row will ever land for.
                if (event.row.kind === "turn_done") setLive((held) => (held && held.runId === event.row.runId ? undefined : held));
                // The Agent's own state moves on a turn boundary or an
                // approval — the cheapest place to notice is here.
                if (event.row.kind === "turn_done" || event.row.kind === "request_opened" || event.row.kind === "request_resolved") {
                  void api.agent().then((answer) => {
                    if (!stopped) {
                      setState(answer.agent);
                      setCredential(answer.credential);
                    }
                  }).catch(() => undefined);
                }
              } else if (event.type === "inbox") {
                // A NUDGE, NOT A FEED. The row itself is read back from
                // `/api/agent/inbox`, which is the list that survives a
                // reconnect — see `AgentThreadHandle.inboxNudge`.
                setInboxNudge((held) => held + 1);
              } else if (event.type === "delta") {
                // ACCUMULATED PER MESSAGE. A delta for a NEW `itemId` starts a
                // fresh buffer rather than appending to the last one — the
                // previous message has its own row on the way.
                setLive((held) =>
                  held && held.itemId === event.itemId
                    ? { runId: event.runId, itemId: event.itemId, text: held.text + event.text }
                    : { runId: event.runId, itemId: event.itemId, text: event.text },
                );
              }
            }
          }
        } catch {
          if (stopped) return;
        }
        if (stopped) return;
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    };

    const task = window.setTimeout(() => void follow(), 0);
    return () => {
      stopped = true;
      window.clearTimeout(task);
      controller.abort();
    };
  }, [api, hostId, opened, remember]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(undefined);
    try {
      const answer = await api.sendAgentTurn(trimmed);
      setState(answer.agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that message.");
    } finally {
      setSending(false);
    }
  }, [api]);

  const cancel = useCallback(async () => {
    const runId = state?.runId;
    if (!runId) return;
    try {
      const answer = await api.cancelAgentTurn(runId);
      setState(answer.agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that.");
    }
  }, [api, state?.runId]);

  const resolve = useCallback(async (requestId: string, decision: "accept" | "decline") => {
    setSending(true);
    try {
      const answer = await api.resolveAgentRequest(requestId, decision);
      setState(answer.agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that decision.");
    } finally {
      setSending(false);
    }
  }, [api]);

  /**
   * THE COMPOSER'S PILLS WRITE HERE (#539) — the same `PATCH /v2/agent` the
   * settings pane uses, so both read one value and cannot drift.
   *
   * THE ANSWER IS THE NEW STATE, so the pill repaints from the engine's word
   * rather than from an optimistic local copy. It is one small round trip on a
   * gesture nobody makes twice a second, and it means a refusal shows as a
   * refusal instead of a setting that silently reverted on the next poll.
   */
  const configure = useCallback(async (patch: { model?: string; effort?: string; access?: string }) => {
    try {
      setState((await api.setAgent(patch)).agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused that setting.");
    }
  }, [api]);

  const items = useMemo(() => {
    const drawn = agentItems(rows);
    const streaming = liveAssistantItem(rows, live);
    return streaming ? [...drawn, streaming] : drawn;
  }, [rows, live]);

  return {
    items,
    state,
    credential,
    loading,
    hasOlder,
    loadOlder,
    loadingOlder,
    send,
    cancel,
    resolve,
    configure,
    sending,
    inboxNudge,
    ...(error === undefined ? {} : { error }),
  };
}
