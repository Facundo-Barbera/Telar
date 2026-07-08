"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  AppSidebar,
  type ChatMeta,
  type PlanSnapshot,
  type UsageWindow,
} from "@/components/app-sidebar";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { DEFAULT_MODEL, MODELS, modelById } from "@/lib/models";

type Part =
  | { type: "text"; text: string; done: boolean }
  | { type: "tool"; name: string };
type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };
type Status = "ready" | "submitted" | "streaming" | "error";

const ACCOUNT_NAMES = ["personal", "work"];

export default function TelarPage() {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [plan, setPlan] = useState<Record<string, PlanSnapshot>>({});
  const [ledger, setLedger] = useState<{ session: UsageWindow; weekly: UsageWindow } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [account, setAccount] = useState("personal");
  const [status, setStatus] = useState<Status>("ready");
  const [thinking, setThinking] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const busy = status === "submitted" || status === "streaming";

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch("/api/chats");
      setChats((await res.json()).chats);
    } catch {
      /* ignore */
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      const data = await res.json();
      setPlan(data.plan ?? {});
      setLedger(data.ledger ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadChats();
    loadUsage();
  }, [loadChats, loadUsage]);

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
    const res = await fetch(`/api/chats/${id}`);
    if (!res.ok) return;
    const chat = await res.json();
    setActiveId(id);
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
    setActiveId(null);
    setMessages([]);
    setSessionCost(0);
    setStatus("ready");
    setThinking(false);
  }, []);

  const removeChat = useCallback(
    async (id: string) => {
      await fetch(`/api/chats/${id}`, { method: "DELETE" });
      if (id === activeId) newChat();
      loadChats();
    },
    [activeId, newChat, loadChats],
  );

  const send = useCallback(
    async (text: string) => {
      const userId = `m${nextId.current++}`;
      const asstId = `m${nextId.current++}`;
      setMessages((ms) => [
        ...ms,
        { id: userId, role: "user", parts: [{ type: "text", text, done: true }] },
        { id: asstId, role: "assistant", parts: [] },
      ]);
      setStatus("submitted");
      setThinking(false);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId: activeId, model, account }),
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
                setActiveId(payload.sessionId);
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
              case "plan": {
                const { account: acct, ...windows } = payload;
                setPlan((p) => ({
                  ...p,
                  [acct]: { ...p[acct], ...windows, capturedAt: Date.now() },
                }));
                break;
              }
              case "done":
                setSessionCost((c) => c + (payload.costUsd ?? 0));
                break;
              case "saved":
                loadChats();
                loadUsage();
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
    [activeId, model, account, loadChats, loadUsage],
  );

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    void send(text);
  };

  const activeModel = modelById(model);
  const activeTitle = chats.find((c) => c.id === activeId)?.title;

  return (
    <SidebarProvider>
      <AppSidebar
        chats={chats}
        activeId={activeId}
        plan={plan[account] ?? null}
        ledger={ledger}
        account={account}
        onSelect={selectChat}
        onNew={newChat}
        onDelete={removeChat}
      />
      <SidebarInset className="flex h-dvh flex-col">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="truncate text-sm font-medium">
            {activeTitle ?? "New thread"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {busy && (
              <Shimmer className="text-xs">
                {`${status === "submitted" ? "starting" : thinking ? "thinking" : "working"} · ${elapsed}s`}
              </Shimmer>
            )}
            <Badge variant="outline" className="font-mono text-xs">
              session ${sessionCost.toFixed(4)}
            </Badge>
            {activeId && (
              <Badge variant="secondary" className="font-mono text-xs">
                {activeId.slice(0, 8)}
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
      </SidebarInset>
    </SidebarProvider>
  );
}
