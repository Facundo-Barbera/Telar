"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { WrenchIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { DEFAULT_MODEL, MODELS, modelById } from "@/lib/models";

type Part =
  | { type: "text"; text: string; done: boolean }
  | { type: "tool"; name: string };
type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };
type Status = "ready" | "submitted" | "streaming" | "error";

const ACCOUNT_NAMES = ["personal", "work"];

const refresh = () => window.dispatchEvent(new Event("telar:refresh"));

function Chat() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatParam = searchParams.get("chat");

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [account, setAccount] = useState("personal");
  const [status, setStatus] = useState<Status>("ready");
  const [thinking, setThinking] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // The session id whose transcript is currently mounted. Kept in a ref so the
  // URL effect can tell a real navigation apart from our own router.replace
  // after a new session is minted mid-stream.
  const loadedIdRef = useRef<string | null>(null);

  const busy = status === "submitted" || status === "streaming";

  // Keep the sidebar's "Plan usage · <account>" footer in lockstep with the
  // composer account dropdown (they live in separate subtrees under the layout).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("telar:account", { detail: account }));
  }, [account]);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  const selectChat = useCallback(async (id: string) => {
    abortRef.current?.abort();
    loadedIdRef.current = id;
    const res = await fetch(`/api/chats/${id}`);
    if (!res.ok) return;
    const chat = await res.json();
    // A newer selectChat may have won the race while we awaited — drop this
    // stale result so the mounted transcript always matches loadedIdRef/URL.
    if (loadedIdRef.current !== id) return;
    setSessionId(id);
    setTitle(chat.title);
    setModel(chat.model);
    setAccount(chat.account);
    setSessionCost(chat.costUsd);
    setStatus("ready");
    setThinking(false);
    setMessages(
      chat.messages.map((m: { role: "user" | "assistant"; parts: Array<Record<string, unknown>> }) => ({
        id: `m${nextId.current++}`,
        role: m.role,
        parts: m.parts.map((p) => (p.type === "text" ? { ...p, done: true } : p)) as Part[],
      })),
    );
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    loadedIdRef.current = null;
    setSessionId(null);
    setTitle(null);
    setMessages([]);
    setSessionCost(0);
    setStatus("ready");
    setThinking(false);
  }, []);

  // Active chat = ?chat=<id>. Load it when the URL points somewhere new; skip
  // when it already matches what's mounted (e.g. our own replace mid-stream).
  useEffect(() => {
    if (chatParam === loadedIdRef.current) return;
    if (chatParam) void selectChat(chatParam);
    else newChat();
  }, [chatParam, selectChat, newChat]);

  const send = useCallback(
    async (text: string) => {
      const userId = `m${nextId.current++}`;
      const asstId = `m${nextId.current++}`;
      setMessages((ms) => [
        ...ms,
        { id: userId, role: "user", parts: [{ type: "text", text, done: true }] },
        { id: asstId, role: "assistant", parts: [] },
      ]);
      // New thread: derive the header title from the first message, matching the
      // slice the store uses when it persists the chat.
      if (!sessionId) setTitle(text.slice(0, 60));
      setStatus("submitted");
      setThinking(false);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId, model, account }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

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
            let event = "";
            let data = "";
            for (const line of chunk.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (!event || !data) continue;
            const payload = JSON.parse(data);

            switch (event) {
              case "session":
                // New session id — reflect it in the URL without reloading the
                // transcript (loadedIdRef guards the URL effect above).
                setSessionId(payload.sessionId);
                loadedIdRef.current = payload.sessionId;
                router.replace("/?chat=" + payload.sessionId);
                break;
              case "thinking":
                setThinking(true);
                break;
              case "delta":
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => {
                  const last = m.parts[m.parts.length - 1];
                  if (last?.type === "text" && !last.done) {
                    const parts = [...m.parts];
                    parts[parts.length - 1] = { ...last, text: last.text + payload.text };
                    return { ...m, parts };
                  }
                  return { ...m, parts: [...m.parts, { type: "text", text: payload.text, done: false }] };
                });
                break;
              case "text":
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => {
                  const last = m.parts[m.parts.length - 1];
                  if (last?.type === "text" && !last.done) {
                    const parts = [...m.parts];
                    parts[parts.length - 1] = { type: "text", text: payload.text, done: true };
                    return { ...m, parts };
                  }
                  return { ...m, parts: [...m.parts, { type: "text", text: payload.text, done: true }] };
                });
                break;
              case "tool":
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => ({
                  ...m,
                  parts: [...m.parts, { type: "tool", name: payload.name }],
                }));
                break;
              case "plan":
                refresh();
                break;
              case "done":
                setSessionCost((c) => c + (payload.costUsd ?? 0));
                refresh();
                break;
              case "saved":
                refresh();
                break;
              case "error":
                throw new Error(payload.message);
            }
          }
        }
        setStatus("ready");
      } catch (err) {
        if (abort.signal.aborted) {
          setStatus("ready");
        } else {
          patch(asstId, (m) => ({
            ...m,
            parts: [...m.parts, { type: "text", text: `**Error:** ${String(err)}`, done: true }],
          }));
          setStatus("error");
        }
      } finally {
        setThinking(false);
        abortRef.current = null;
      }
    },
    [sessionId, model, account, router],
  );

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    void send(text);
  };

  const activeModel = modelById(model);

  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4" />
        <span className="truncate text-sm font-medium">{title ?? "New thread"}</span>
        <div className="ml-auto flex items-center gap-2">
          {busy && (
            <Shimmer className="text-xs">
              {`${status === "submitted" ? "starting" : thinking ? "thinking" : "working"} · ${elapsed}s`}
            </Shimmer>
          )}
          <Badge variant="outline" className="font-mono text-xs">
            session ${sessionCost.toFixed(4)}
          </Badge>
          {sessionId && (
            <Badge variant="secondary" className="font-mono text-xs">
              {sessionId.slice(0, 8)}
            </Badge>
          )}
        </div>
      </header>

      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Weave a thread"
              description="Telar drives the Claude Agent SDK on your subscription — sessions, history, and usage all on your loom."
            />
          ) : (
            messages.map((m) => (
              <Message from={m.role} key={m.id}>
                <MessageContent>
                  {m.parts.length === 0 && m.role === "assistant" && busy && (
                    <Shimmer className="text-sm">
                      {thinking ? "Thinking…" : "Weaving…"}
                    </Shimmer>
                  )}
                  {m.parts.map((p, i) =>
                    p.type === "text" ? (
                      <MessageResponse key={i}>{p.text}</MessageResponse>
                    ) : (
                      <Badge variant="secondary" className="w-fit font-mono text-xs" key={i}>
                        <WrenchIcon className="size-3" />
                        {p.name}
                      </Badge>
                    ),
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask about this workspace…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <Select value={model} onValueChange={(v) => v && setModel(v)}>
                <SelectTrigger className="h-8 w-[170px] text-xs" size="sm">
                  <SelectValue>
                    <span className="flex items-center gap-1.5">
                      {activeModel?.name ?? model}
                      {activeModel && (
                        <Badge variant="outline" className="px-1 py-0 text-[10px]">
                          {activeModel.context}
                        </Badge>
                      )}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="w-[340px]">
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="py-2">
                      <div className="flex w-full flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{m.name}</span>
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
                            {m.context} ctx
                          </Badge>
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
                            {m.maxOutput} out
                          </Badge>
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            ${m.inputPerMTok}/{m.outputPerMTok} MTok
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">{m.blurb}</span>
                        {m.note && (
                          <span className="text-[10px] text-muted-foreground/70">{m.note}</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={account} onValueChange={(v) => v && setAccount(v)}>
                <SelectTrigger className="h-8 w-[110px] text-xs" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_NAMES.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </PromptInputTools>
            <PromptInputSubmit
              status={status === "ready" ? undefined : status}
              onStop={() => abortRef.current?.abort()}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </>
  );
}

function ChatFallback() {
  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4" />
        <span className="truncate text-sm font-medium text-muted-foreground">New thread</span>
      </header>
      <div className="flex-1" />
    </>
  );
}

export default function TelarPage() {
  return (
    <Suspense fallback={<ChatFallback />}>
      <Chat />
    </Suspense>
  );
}
