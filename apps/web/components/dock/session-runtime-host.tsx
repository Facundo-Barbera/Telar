"use client";

// One invisible effect-holder per docked session. It owns the HTTP/SSE wiring
// that turns a session id into live Runtime (message tail, working, park, cost)
// in the dock store, so heads + panels stay pure readers. Rendered once per
// docked id by <Dock> — never on its own.
//
// DATA SOURCES (all the app's existing HTTP surface — no server-only import):
//   · GET /api/chats/[id]             → the persisted tail + title/project/model/cost
//   · GET /api/chat/[id]/events (SSE) → the SAME §1b reconnect tail session-view.tsx
//                                        uses to watch a running turn — reused here
//                                        verbatim (same endpoint, same consumeSSE
//                                        parser from @/lib/sse), not a second protocol
//   · POST /api/chat/stop             → stop an active turn (session-view parity)
//   · GET /api/looms/[id]             → park state (loom.state === "blocked")
//
// LIVE CONTENT: applyLiveEvent below is a reduced version of session-view's
// applyServerEvent, scoped to what the compact CompactMsg grammar renders
// (user / assistant text / grouped tool steps, main thread only — sub-agent
// parts are skipped exactly like toCompact already does for the persisted
// tail). Thinking blocks, permission cards, plan/loom events etc. have no
// compact shape and are ignored live; they still land once the turn
// completes and the persisted tail is refetched. The live overlay
// (liveMsgsRef) is layered on top of the last persisted fetch and reset once
// a turn's tail closes and the fresh persisted tail is pulled in.
//
// EACH RECONNECT REPLAYS FROM THE TURN'S START: the /events route hands a
// fresh reader the whole current in-flight block from its own line 0, so
// resetLive() at the top of every openTail() attempt is correct — a
// reconnect rebuilds the same content, it doesn't duplicate it. Within one
// connection's lifetime the server only ever sends NEW events (its own
// cursor advances), so no dedupe is needed there.

import { useCallback, useEffect, useRef } from "react";
import { consumeSSE } from "@/lib/sse";
// Imported from the MODULE rather than components/conversation's barrel on
// purpose: this host renders null and only needs one pure helper, and the barrel
// would drag the whole shell (and the 1465-line composer kit) into the dock's
// graph for no benefit.
import { diagnosticFetch } from "@/lib/client-request-diagnostics";
import {
  cancelIdleRequest,
  enqueueIdleRequest,
} from "@/lib/client-request-budget";
import {
  dispatchTelarSessionRun,
  refreshIncludes,
  TELAR_REFRESH_EVENT,
  TELAR_SESSION_RUN_EVENT,
  type TelarRefreshDetail,
} from "@/lib/telar-refresh";
import { useDock, type CompactMsg, type DockQueuedMessage } from "./dock-provider";

const DETAIL_SAFETY_POLL_MS = 60_000;
const IDLE_TAIL_RETRY_MS = 30_000;
const ACTIVE_TAIL_RETRY_MS = 800;
const TURN_START_GRACE_MS = 10_000;

interface StorePart {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: string;
  parentId?: string;
  agent?: unknown;
  taskStatus?: "completed" | "failed" | "stopped";
}
interface StoreMessage { role: "user" | "assistant"; parts: StorePart[] }
interface ChatDetail {
  id: string;
  title: string;
  project?: string;
  model: string;
  account: string;
  permissionMode?: string;
  costUsd: number;
  loomId?: string;
  messages: StoreMessage[];
}

// A tool part's human-facing target: the most identifying field, clipped.
function toolTarget(input?: Record<string, unknown>): string {
  if (!input) return "";
  const pick =
    (input.file_path as string) ??
    (input.path as string) ??
    (input.pattern as string) ??
    (input.command as string) ??
    (input.url as string) ??
    "";
  const s = String(pick);
  return s.length > 48 ? `${s.slice(0, 48)}…` : s;
}

// Flatten the persisted transcript to the compact dock grammar: user bubbles,
// assistant text, and runs of tool calls folded into one tools row. Sub-agent
// parts (parentId) are skipped — the dock shows the main thread only.
function toCompact(messages: StoreMessage[]): CompactMsg[] {
  const out: CompactMsg[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.parts
        .filter((p) => p.type === "text" && !p.parentId)
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      if (text) out.push({ role: "user", text });
      continue;
    }
    let tools: { tool: string; target: string }[] = [];
    const flushTools = () => {
      if (tools.length) {
        out.push({ role: "tools", steps: tools });
        tools = [];
      }
    };
    for (const p of m.parts) {
      if (p.parentId) continue; // main thread only
      if (p.type === "text") {
        flushTools();
        const t = (p.text ?? "").trim();
        if (t) out.push({ role: "assistant", text: t });
      } else if (p.type === "tool") {
        tools.push({ tool: p.name ?? "Tool", target: toolTarget(p.input) });
      }
    }
    flushTools();
  }
  return out;
}

const countAssistant = (messages: StoreMessage[]): number =>
  messages.filter((m) => m.role === "assistant").length;

const countRunningAgents = (messages: StoreMessage[]): number => {
  let count = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.agent && !part.parentId && !part.taskStatus) count += 1;
    }
  }
  return count;
};

export function SessionRuntimeHost({ id }: { id: string }) {
  const { setRuntime, runtime, dequeue, registerStopHandler } = useDock();
  // Keep the latest chat detail so the composer can send with the right
  // model/account/project without re-fetching, and so the live overlay below
  // has something to layer on top of.
  const detailRef = useRef<ChatDetail | null>(null);
  // In-flight guard so the queue-drain effect fires exactly one POST per turn.
  const sendingRef = useRef(false);

  // ── live overlay: the in-flight turn's CompactMsg entries, rebuilt from
  // SSE events and rendered on top of the last persisted fetch. `messages` in
  // the store is always `[...persisted, ...live]` (see commitLive). ──
  const liveMsgsRef = useRef<CompactMsg[]>([]);
  const pendingToolsRef = useRef<{ tool: string; target: string }[]>([]);
  const liveAgentsRef = useRef<Set<string>>(new Set());
  // The turn's own POST fetch (self-initiated sends) and the live tail's own
  // fetch — Stop aborts both as its local teardown, mirroring session-view's
  // abortRef.current?.abort().
  const tailAbortRef = useRef<AbortController | null>(null);
  // The current self-initiated turn's runId (session-view.tsx parity): set the
  // instant sendTurn fires, cleared when it settles. Stop below prefers this
  // over sessionId so it resolves from t=0 — sessionId isn't attachable to the
  // run server-side until the SDK confirms init/resume (chat-runs.ts), a window
  // during which a sessionId-only stop silently finds nothing.

  const flushLiveTools = useCallback(() => {
    if (pendingToolsRef.current.length) {
      liveMsgsRef.current = [...liveMsgsRef.current, { role: "tools", steps: pendingToolsRef.current }];
      pendingToolsRef.current = [];
    }
  }, []);
  const resetLive = useCallback(() => {
    liveMsgsRef.current = [];
    pendingToolsRef.current = [];
    liveAgentsRef.current.clear();
    setRuntime(id, { agentsRunning: 0 });
  }, [id, setRuntime]);
  const commitLive = useCallback(() => {
    const persisted = detailRef.current ? toCompact(detailRef.current.messages) : [];
    setRuntime(id, { messages: [...persisted, ...liveMsgsRef.current] });
  }, [id, setRuntime]);
  const trailingMessage = useCallback((): CompactMsg | undefined => {
    if (liveMsgsRef.current.length) return liveMsgsRef.current[liveMsgsRef.current.length - 1];
    const persisted = detailRef.current ? toCompact(detailRef.current.messages) : [];
    return persisted[persisted.length - 1];
  }, []);

  // Reduced applyServerEvent (session-view.tsx §1b) for the compact grammar —
  // see the file header for what's intentionally dropped.
  const applyLiveEvent = useCallback((event: string, payload: unknown) => {
    const data = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    if (data.parent) return; // sub-agent stream — main thread only
    switch (event) {
      case "user": {
        const text = String(data.text ?? "").trim();
        if (!text) break;
        const last = trailingMessage();
        // Self-initiated sends already show this bubble optimistically
        // (sendTurn) — the tail's replay of the same "user" line is a dedupe,
        // not a second copy.
        if (last?.role === "user" && last.text === text) break;
        flushLiveTools();
        liveMsgsRef.current = [...liveMsgsRef.current, { role: "user", text }];
        break;
      }
      case "delta": {
        const chunk = String(data.text ?? "");
        const last = liveMsgsRef.current[liveMsgsRef.current.length - 1];
        if (last?.role === "assistant") {
          liveMsgsRef.current = [
            ...liveMsgsRef.current.slice(0, -1),
            { role: "assistant", text: last.text + chunk },
          ];
        } else {
          flushLiveTools();
          liveMsgsRef.current = [...liveMsgsRef.current, { role: "assistant", text: chunk }];
        }
        break;
      }
      case "text": {
        // Block finalize — authoritative full text, replacing whatever the
        // deltas above accumulated (mirrors applyServerEvent's "text" case).
        const text = String(data.text ?? "");
        const last = liveMsgsRef.current[liveMsgsRef.current.length - 1];
        if (last?.role === "assistant") {
          liveMsgsRef.current = [...liveMsgsRef.current.slice(0, -1), { role: "assistant", text }];
        } else {
          flushLiveTools();
          liveMsgsRef.current = [...liveMsgsRef.current, { role: "assistant", text }];
        }
        break;
      }
      case "tool": {
        if (data.agent && typeof data.id === "string") {
          liveAgentsRef.current.add(data.id);
          setRuntime(id, { agentsRunning: liveAgentsRef.current.size });
        }
        pendingToolsRef.current = [
          ...pendingToolsRef.current,
          {
            tool: typeof data.name === "string" ? data.name : "Tool",
            target: toolTarget(
              data.input && typeof data.input === "object"
                ? data.input as Record<string, unknown>
                : undefined,
            ),
          },
        ];
        break;
      }
      case "task_status": {
        if (typeof data.id === "string") {
          liveAgentsRef.current.delete(data.id);
          setRuntime(id, { agentsRunning: liveAgentsRef.current.size });
        }
        break;
      }
      case "interrupted":
      case "done":
      case "error":
        flushLiveTools();
        break;
      default:
        // thinking/thinking_delta/tool_result/task_status/permission*/plan/
        // title/session/saved — no compact-grammar shape, skip the commit.
        return;
    }
    commitLive();
  }, [commitLive, flushLiveTools, id, setRuntime, trailingMessage]);

  // Hand ONE local pre-ack item to the durable engine queue. Only a 202 removes
  // it from this bridge; execution and FIFO draining happen server-side even if
  // this host unmounts immediately afterwards.
  const sendTurn = useCallback(
    async (queued: DockQueuedMessage) => {
      const d = detailRef.current;
      if (!d || sendingRef.current) return;
      sendingRef.current = true;
      try {
        const res = await diagnosticFetch(`/api/chat/${encodeURIComponent(id)}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: queued.id,
            payload: {
              message: queued.text,
              sessionId: id,
              runId: queued.id,
              model: d.model,
              project: d.project,
              account: d.account,
              ...(d.permissionMode ? { permissionMode: d.permissionMode } : {}),
            },
          }),
        }, "dock queued turn");
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const body = await res.json().catch(() => null);
        dequeue(id);
        const engineItems = Array.isArray(body?.queue?.items) ? body.queue.items : [];
        setRuntime(id, {
          queuePaused: Boolean(body?.queue?.paused),
          queuedEngineCount: engineItems.filter(
            (item: { state?: string }) => item.state !== "committed" && item.state !== "cancelled",
          ).length,
        });
        dispatchTelarSessionRun(id);
      } catch (error) {
        setRuntime(id, {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        sendingRef.current = false;
      }
    },
    [dequeue, id, setRuntime],
  );

  // This is an acceptance bridge, not a scheduler: it may run while the session
  // is busy because the engine decides when the accepted item executes.
  const rt = runtime[id];
  const queuedLen = rt?.queued.length ?? 0;
  const queuedHead = rt?.queued[0];
  useEffect(() => {
    if (sendingRef.current) return;
    if (queuedLen === 0 || !detailRef.current) return;
    if (queuedHead !== undefined) void sendTurn(queuedHead);
  }, [id, queuedLen, queuedHead, sendTurn]);

  // Stop an active turn — session-view parity (POST /api/chat/stop + local
  // teardown). Prefers the in-flight runId (resolvable from t=0, see
  // runIdRef above); falls back to sessionId (chat-runs.ts's fallback
  // lookup) for a turn this host didn't itself send — e.g. one already past
  // init that started from the full session view.
  useEffect(() => {
    const stop = () => {
      tailAbortRef.current?.abort();
      setRuntime(id, { working: false });
      void diagnosticFetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      }, "dock stop turn").catch(() => {});
    };
    registerStopHandler(id, stop);
    return () => registerStopHandler(id, null);
  }, [id, registerStopHandler, setRuntime]);

  // ── persisted tail + park state, refetched on demand and after each run ──
  useEffect(() => {
    let alive = true;
    let refetching = false;
    const budgetKey = `dock:${id}:detail`;
    const refetch = async () => {
      if (refetching) return;
      refetching = true;
      try {
        const res = await diagnosticFetch(
          `/api/chats/${encodeURIComponent(id)}`,
          undefined,
          "dock session detail",
        );
        if (!res.ok || !alive) return;
        const chat = (await res.json()) as ChatDetail;
        detailRef.current = chat;
        setRuntime(id, {
          title: chat.title,
          project: chat.project ?? "",
          messages: [...toCompact(chat.messages), ...liveMsgsRef.current],
          assistantCount: countAssistant(chat.messages),
          agentsRunning: countRunningAgents(chat.messages),
          cost: chat.costUsd,
          model: chat.model,
          account: chat.account,
          permissionMode: chat.permissionMode,
          loaded: true,
        });
        try {
          const qr = await diagnosticFetch(
            `/api/chat/${encodeURIComponent(id)}/queue`,
            undefined,
            "dock queue snapshot",
          );
          if (qr.ok && alive) {
            const queue = await qr.json();
            const items = Array.isArray(queue?.items) ? queue.items : [];
            setRuntime(id, {
              queuePaused: Boolean(queue?.paused),
              queuedEngineCount: items.filter(
                (item: { state?: string }) => item.state !== "committed" && item.state !== "cancelled",
              ).length,
            });
          }
        } catch {
          /* queue projection is recovered by the next detail refresh */
        }
        // Park state rides along when the session drives a loom.
        if (chat.loomId) {
          try {
            const lr = await diagnosticFetch(
              `/api/looms/${encodeURIComponent(chat.loomId)}`,
              undefined,
              "dock loom park state",
            );
            if (lr.ok && alive) {
              const { loom } = await lr.json();
              setRuntime(id, { parked: loom?.state === "blocked" });
            }
          } catch {
            /* park is best-effort */
          }
        }
      } catch {
        /* transient — a later tick retries */
      } finally {
        refetching = false;
      }
    };
    void refetch();
    // Events handle normal writes. This minute-scale check is only a recovery
    // net for changes made in another browser or process.
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") {
        enqueueIdleRequest(budgetKey, refetch);
      }
    }, DETAIL_SAFETY_POLL_MS);
    // Expose a manual refetch for the SSE loop below via a custom event.
    const onRefetch = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) void refetch();
    };
    const onRefresh = (event: Event) => {
      if (!refreshIncludes(event, "chats")) return;
      const detail = (event as CustomEvent<TelarRefreshDetail | undefined>).detail;
      if (detail?.sessionId && detail.sessionId !== id) return;
      void refetch();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    window.addEventListener("telar:dock-refetch", onRefetch);
    window.addEventListener(TELAR_REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(poll);
      cancelIdleRequest(budgetKey);
      window.removeEventListener("telar:dock-refetch", onRefetch);
      window.removeEventListener(TELAR_REFRESH_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, setRuntime]);

  // ── live tail: the SAME /events endpoint + consumeSSE parser session-view's
  // §1b reconnect uses, re-opened to catch new runs. While a turn streams,
  // this connection stays open (the route only closes it on "closed"/drain),
  // so content lands as it's written; once it closes, drop the live overlay
  // (the persisted store already has the finished turn — route.ts saves
  // before emitting "closed") and pull the fresh tail. ──
  useEffect(() => {
    let alive = true;
    let abort: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wakeUntil = 0;
    const budgetKey = `dock:${id}:tail`;

    const schedule = (delay: number, budgeted = false) => {
      if (!alive || document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (budgeted) enqueueIdleRequest(budgetKey, openTail);
        else void openTail();
      }, delay);
    };

    const openTail = async () => {
      if (!alive || abort || document.visibilityState !== "visible") return;
      abort = new AbortController();
      tailAbortRef.current = abort;
      resetLive();
      let sawEvent = false;
      try {
        const res = await diagnosticFetch(
          `/api/chat/${encodeURIComponent(id)}/events`,
          { signal: abort.signal },
          "dock live tail",
        );
        if (!res.ok || !res.body) throw new Error("no stream");
        await consumeSSE(res.body.getReader(), (event, payload) => {
          if (!alive) return;
          if (!sawEvent) {
            sawEvent = true;
            // A TURN IS NOW STREAMING FOR THIS SESSION — whoever started it.
            // The rejection banner describes a turn that never ran, so it must
            // not sit above one that is running: `sendTurn` clears it for
            // dock-initiated sends, and this clears it for a turn started from
            // the full session view. Both clears are at the same moment (a turn
            // begins), which is what keeps the field honest from either side.
            // It stays put while the session is IDLE — this arm only runs when
            // the tail actually delivers an event, which the /events route only
            // does for an in-flight block — so the sentence is still durable
            // long after the failure, as AC9 requires.
            setRuntime(id, { working: true, error: undefined });
          }
          applyLiveEvent(event, payload);
        });
      } catch {
        /* not live / aborted (incl. an explicit Stop) / dropped — reschedule */
      } finally {
        if (tailAbortRef.current === abort) tailAbortRef.current = null;
        abort = null;
        if (alive) {
          if (sawEvent) {
            // A turn just ran to completion (or was stopped) — settle + pull
            // the now-authoritative persisted tail.
            setRuntime(id, { working: false });
            resetLive();
            commitLive();
            window.dispatchEvent(new CustomEvent("telar:dock-refetch", { detail: id }));
          }
          // A locally announced turn gets a short grace window because the
          // wake may beat server-side run registration. Truly idle sessions
          // use a minute-scale safety net instead of hammering this endpoint.
          const active = sawEvent || Date.now() < wakeUntil;
          schedule(active ? ACTIVE_TAIL_RETRY_MS : IDLE_TAIL_RETRY_MS, !active);
        }
      }
    };
    const onRun = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) return;
      wakeUntil = Date.now() + TURN_START_GRACE_MS;
      cancelIdleRequest(budgetKey);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void openTail();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule(0, true);
      else if (timer) {
        clearTimeout(timer);
        timer = null;
        cancelIdleRequest(budgetKey);
      }
    };
    window.addEventListener(TELAR_SESSION_RUN_EVENT, onRun);
    document.addEventListener("visibilitychange", onVisibility);
    schedule(1_500, true);
    return () => {
      alive = false;
      if (abort) abort.abort();
      if (timer) clearTimeout(timer);
      cancelIdleRequest(budgetKey);
      window.removeEventListener(TELAR_SESSION_RUN_EVENT, onRun);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [applyLiveEvent, commitLive, id, resetLive, setRuntime]);

  return null;
}
