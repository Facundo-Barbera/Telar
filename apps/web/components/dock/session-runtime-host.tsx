"use client";

// One invisible effect-holder per docked session. It owns the HTTP/SSE wiring
// that turns a session id into live Runtime (message tail, working, park, cost)
// in the dock store, so heads + panels stay pure readers. Rendered once per
// docked id by <Dock> — never on its own.
//
// DATA SOURCES (all the app's existing HTTP surface — no server-only import):
//   · GET /api/chats/[id]            → the persisted tail + title/project/model/cost
//   · GET /api/chat/[id]/events (SSE) → live "working" detection; on close, refetch
//   · GET /api/looms/[id]            → park state (loom.state === "blocked")
//
// LIVE-STREAM FIDELITY (flagged): there is no shared in-memory session store to
// read the page's own streaming state from. Rather than re-implement the session
// page's ~1k-line SSE transcript reconstruction, this host uses the SSE tail to
// know WHEN a turn is running (working ring) and refetches the persisted tail on
// completion. So the dock panel updates a beat after a turn finishes rather than
// token-by-token — correct content, coarser cadence. Full live streaming into
// the panel would reuse the session view's applyServerEvent switch.

import { useCallback, useEffect, useRef } from "react";
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

export function SessionRuntimeHost({ id }: { id: string }) {
  const { setRuntime, runtime, dequeue } = useDock();
  // Keep the latest chat detail so the composer can send with the right
  // model/account/project without re-fetching.
  const detailRef = useRef<ChatDetail | null>(null);
  // In-flight guard so the queue-drain effect fires exactly one POST per turn.
  const sendingRef = useRef(false);
  // Latest runtime, read inside sendTurn's stable closure without widening deps
  // (so an optimistic user bubble appends to the current tail).
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  // Fire ONE queued message as a real turn on the same server surface the full
  // session page uses (POST /api/chat). Optimistically shows the user bubble +
  // working ring, drains the returned SSE stream to know when the turn ends,
  // then pulls the fresh persisted tail. Client-bundle-safe: plain HTTP only.
  const sendTurn = useCallback(
    async (text: string) => {
      const d = detailRef.current;
      if (!d || sendingRef.current) return;
      sendingRef.current = true;
      setRuntime(id, {
        working: true,
        messages: [
          ...(runtimeRef.current[id]?.messages ?? []),
          { role: "user", text },
        ],
      });
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId: id,
            runId: newRunId(),
            model: d.model,
            project: d.project,
            account: d.account,
            ...(d.permissionMode ? { permissionMode: d.permissionMode } : {}),
          }),
        });
        // Drain the SSE stream to completion (content is refetched from the
        // store below — we only need to know WHEN the turn is done).
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
      } catch {
        /* network drop — the tail refetch below still reconciles */
      } finally {
        sendingRef.current = false;
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
          messages: toCompact(chat.messages),
          assistantCount: countAssistant(chat.messages),
          cost: chat.costUsd,
          model: chat.model,
          account: chat.account,
          permissionMode: chat.permissionMode,
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

  // ── live "working" detection: tail the SSE, re-opening to catch new runs ──
  useEffect(() => {
    let alive = true;
    let abort: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const openTail = async () => {
      if (!alive) return;
      abort = new AbortController();
      let sawEvent = false;
      try {
        const res = await fetch(`/api/chat/${encodeURIComponent(id)}/events`, {
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error("no stream");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            if (!chunk.includes("event:")) continue;
            if (!sawEvent) {
              sawEvent = true;
              if (alive) setRuntime(id, { working: true });
            }
          }
        }
      } catch {
        /* not live / aborted / dropped — fall through to reschedule */
      } finally {
        if (alive) {
          if (sawEvent) {
            // A turn just ran to completion — settle + pull the fresh tail.
            setRuntime(id, { working: false });
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
