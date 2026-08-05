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
import { readPreStreamError } from "@/components/conversation/pre-stream-error";
import { useDock, type CompactMsg } from "./dock-provider";

const newRunId = () =>
  globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);

interface StorePart {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: string;
  parentId?: string;
}
interface StoreMessage { role: "user" | "assistant"; parts: StorePart[] }
interface ChatDetail {
  id: string;
  title: string;
  project?: string;
  model: string;
  account: string;
  runtimeMode?: string;
  effort?: string;
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
  // The turn's own POST fetch (self-initiated sends) and the live tail's own
  // fetch — Stop aborts both as its local teardown, mirroring session-view's
  // abortRef.current?.abort().
  const sendAbortRef = useRef<AbortController | null>(null);
  const tailAbortRef = useRef<AbortController | null>(null);
  // The current self-initiated turn's runId (session-view.tsx parity): set the
  // instant sendTurn fires, cleared when it settles. Stop below prefers this
  // over sessionId so it resolves from t=0 — sessionId isn't attachable to the
  // run server-side until the SDK confirms init/resume (chat-runs.ts), a window
  // during which a sessionId-only stop silently finds nothing.
  const runIdRef = useRef<string | null>(null);

  const flushLiveTools = () => {
    if (pendingToolsRef.current.length) {
      liveMsgsRef.current = [...liveMsgsRef.current, { role: "tools", steps: pendingToolsRef.current }];
      pendingToolsRef.current = [];
    }
  };
  const resetLive = () => {
    liveMsgsRef.current = [];
    pendingToolsRef.current = [];
  };
  const commitLive = () => {
    const persisted = detailRef.current ? toCompact(detailRef.current.messages) : [];
    setRuntime(id, { messages: [...persisted, ...liveMsgsRef.current] });
  };
  const trailingMessage = (): CompactMsg | undefined => {
    if (liveMsgsRef.current.length) return liveMsgsRef.current[liveMsgsRef.current.length - 1];
    const persisted = detailRef.current ? toCompact(detailRef.current.messages) : [];
    return persisted[persisted.length - 1];
  };

  // Reduced applyServerEvent (session-view.tsx §1b) for the compact grammar —
  // see the file header for what's intentionally dropped.
  const applyLiveEvent = (event: string, payload: any) => {
    if (payload?.parent) return; // sub-agent stream — main thread only
    switch (event) {
      case "user": {
        const text = String(payload?.text ?? "").trim();
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
        const chunk = String(payload?.text ?? "");
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
        const text = String(payload?.text ?? "");
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
        pendingToolsRef.current = [
          ...pendingToolsRef.current,
          { tool: (payload?.name as string) ?? "Tool", target: toolTarget(payload?.input) },
        ];
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
  };

  // Fire ONE queued message as a real turn on the same server surface the full
  // session page uses (POST /api/chat). Shows the user bubble + working ring
  // at once via the live overlay; the tail below (a second, independent
  // connection to the same session's event log) streams the assistant's
  // reply as it's written. This response is only drained for lifecycle
  // (error surfacing, knowing when to settle) — not a second content path.
  const sendTurn = useCallback(
    async (text: string) => {
      const d = detailRef.current;
      if (!d || sendingRef.current) return;
      sendingRef.current = true;
      resetLive();
      liveMsgsRef.current = [{ role: "user", text }];
      // Clear any previous rejection as this attempt starts — a stale sentence
      // sitting above a turn that is now streaming reads as a fresh failure.
      // This is one of TWO clears; the other is in the live tail below, for a
      // turn this dock did not start (see the `sawEvent` arm in openTail).
      setRuntime(id, { working: true, error: undefined });
      commitLive();

      const sendAbort = new AbortController();
      sendAbortRef.current = sendAbort;
      const runId = newRunId();
      runIdRef.current = runId;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId: id,
            runId,
            model: d.model,
            project: d.project,
            account: d.account,
            // The session's own runtime mode, resent verbatim. The route's
            // fallback for a turn that says nothing is the MOST CAUTIOUS mode,
            // so dropping this field would not merely be untidy — it would
            // silently re-run a session at a posture nobody chose.
            ...(d.runtimeMode ? { runtimeMode: d.runtimeMode } : {}),
            // …and its reasoning effort, for the OPPOSITE reason: an omitted
            // effort means "Auto" rather than "unstated", so appendTurn writes
            // the absence through and a dock turn would erase a session's
            // reasoning level — the control on the session page then reads Auto
            // for a session the user set to Max. The two fields need resending
            // for different reasons; both need it.
            ...(d.effort ? { effort: d.effort } : {}),
          }),
          signal: sendAbort.signal,
        });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } else {
          // THE TURN WAS REJECTED BEFORE ANY STREAM EXISTED — a plain JSON 4xx
          // (an unknown project/account, or a profile that forbids this turn).
          // Until this arm existed the body was never read: nothing threw, the
          // sibling catch never fired, and the `finally` below dispatched a
          // refetch that reloaded the PERSISTED tail — which never contained the
          // turn, because it never ran. The user's typed message simply
          // disappeared. Surfacing the server's own sentence is the fix, and it
          // goes to a real field rather than being pushed into liveMsgsRef as a
          // synthetic assistant message: disguising a rejected turn as a model
          // reply is a worse failure than the silence it replaces.
          const detail = await readPreStreamError(res);
          if (detail) setRuntime(id, { error: detail });
        }
      } catch {
        /* network drop / stopped — the tail + refetch below still reconcile */
      } finally {
        sendAbortRef.current = null;
        sendingRef.current = false;
        if (runIdRef.current === runId) runIdRef.current = null;
        setRuntime(id, { working: false });
        window.dispatchEvent(new CustomEvent("telar:dock-refetch", { detail: id }));
      }
    },
    [id, setRuntime],
  );

  // Drain the queue whenever the session is idle and loaded — one head at a
  // time (sendTurn re-triggers this effect when working settles back to false).
  const rt = runtime[id];
  const queuedLen = rt?.queued.length ?? 0;
  const working = rt?.working ?? false;
  useEffect(() => {
    if (working || sendingRef.current) return;
    if (queuedLen === 0 || !detailRef.current) return;
    const next = dequeue(id);
    if (next !== undefined) void sendTurn(next);
  }, [id, working, queuedLen, dequeue, sendTurn]);

  // Stop an active turn — session-view parity (POST /api/chat/stop + local
  // teardown). Prefers the in-flight runId (resolvable from t=0, see
  // runIdRef above); falls back to sessionId (chat-runs.ts's fallback
  // lookup) for a turn this host didn't itself send — e.g. one already past
  // init that started from the full session view.
  useEffect(() => {
    const stop = () => {
      sendAbortRef.current?.abort();
      tailAbortRef.current?.abort();
      setRuntime(id, { working: false });
      const runId = runIdRef.current;
      void fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runId ? { runId, sessionId: id } : { sessionId: id }),
      }).catch(() => {});
    };
    registerStopHandler(id, stop);
    return () => registerStopHandler(id, null);
  }, [id, registerStopHandler, setRuntime]);

  // ── persisted tail + park state, refetched on demand and after each run ──
  useEffect(() => {
    let alive = true;
    const refetch = async () => {
      try {
        const res = await fetch(`/api/chats/${encodeURIComponent(id)}`);
        if (!res.ok || !alive) return;
        const chat = (await res.json()) as ChatDetail;
        detailRef.current = chat;
        setRuntime(id, {
          title: chat.title,
          project: chat.project ?? "",
          messages: [...toCompact(chat.messages), ...liveMsgsRef.current],
          assistantCount: countAssistant(chat.messages),
          cost: chat.costUsd,
          model: chat.model,
          account: chat.account,
          runtimeMode: chat.runtimeMode,
          effort: chat.effort,
          loaded: true,
        });
        // Park state rides along when the session drives a loom.
        if (chat.loomId) {
          try {
            const lr = await fetch(`/api/looms/${encodeURIComponent(chat.loomId)}`);
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
      }
    };
    void refetch();
    // A slow poll catches turns started elsewhere that the SSE loop missed.
    const poll = setInterval(refetch, 8000);
    // Expose a manual refetch for the SSE loop below via a custom event.
    const onRefetch = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) void refetch();
    };
    window.addEventListener("telar:dock-refetch", onRefetch);
    return () => {
      alive = false;
      clearInterval(poll);
      window.removeEventListener("telar:dock-refetch", onRefetch);
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

    const openTail = async () => {
      if (!alive) return;
      abort = new AbortController();
      tailAbortRef.current = abort;
      resetLive();
      let sawEvent = false;
      try {
        const res = await fetch(`/api/chat/${encodeURIComponent(id)}/events`, {
          signal: abort.signal,
        });
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
        if (alive) {
          if (sawEvent) {
            // A turn just ran to completion (or was stopped) — settle + pull
            // the now-authoritative persisted tail.
            setRuntime(id, { working: false });
            resetLive();
            commitLive();
            window.dispatchEvent(new CustomEvent("telar:dock-refetch", { detail: id }));
          }
          // Re-arm: a live run reconnects fast, an idle one polls lazily.
          timer = setTimeout(openTail, sawEvent ? 800 : 3500);
        }
      }
    };
    void openTail();
    return () => {
      alive = false;
      if (abort) abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, setRuntime]);

  return null;
}
