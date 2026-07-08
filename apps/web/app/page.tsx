"use client";

import { useCallback, useRef, useState } from "react";
import { PlusIcon, WrenchIcon } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Part = { type: "text"; text: string } | { type: "tool"; name: string };
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  costUsd?: number;
};
type Status = "ready" | "submitted" | "streaming" | "error";

const MODELS = [
  { value: "haiku", label: "Haiku · fast" },
  { value: "sonnet", label: "Sonnet · dev" },
  { value: "opus", label: "Opus · careful" },
];
const ACCOUNT_NAMES = ["personal", "work"];

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = useState("sonnet");
  const [account, setAccount] = useState("personal");
  const [status, setStatus] = useState<Status>("ready");
  const nextId = useRef(0);

  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  const send = useCallback(
    async (text: string) => {
      const userId = `m${nextId.current++}`;
      const asstId = `m${nextId.current++}`;
      setMessages((ms) => [
        ...ms,
        { id: userId, role: "user", parts: [{ type: "text", text }] },
        { id: asstId, role: "assistant", parts: [] },
      ]);
      setStatus("submitted");

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, sessionId, model, account }),
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

            if (event === "session") setSessionId(payload.sessionId);
            if (event === "text") {
              setStatus("streaming");
              patch(asstId, (m) => ({
                ...m,
                parts: [...m.parts, { type: "text", text: payload.text }],
              }));
            }
            if (event === "tool") {
              setStatus("streaming");
              patch(asstId, (m) => ({
                ...m,
                parts: [...m.parts, { type: "tool", name: payload.name }],
              }));
            }
            if (event === "done") {
              patch(asstId, (m) => ({ ...m, costUsd: payload.costUsd }));
            }
            if (event === "error") throw new Error(payload.message);
          }
        }
        setStatus("ready");
      } catch (err) {
        patch(asstId, (m) => ({
          ...m,
          parts: [
            ...m.parts,
            { type: "text", text: `**Error:** ${String(err)}` },
          ],
        }));
        setStatus("error");
      }
    },
    [sessionId, model, account],
  );

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || status === "submitted" || status === "streaming") return;
    void send(text);
  };

  const newChat = () => {
    setMessages([]);
    setSessionId(null);
    setStatus("ready");
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-lg font-semibold tracking-tight">
            telar
          </h1>
          {sessionId && (
            <Badge variant="outline" className="font-mono text-xs">
              {sessionId.slice(0, 8)}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={newChat}>
          <PlusIcon className="size-4" />
          New thread
        </Button>
      </header>

      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Weave a thread"
              description="Telar drives the Claude Agent SDK on your subscription — same sessions, your loom."
            />
          ) : (
            messages.map((m) => (
              <Message from={m.role} key={m.id}>
                <MessageContent>
                  {m.parts.map((p, i) =>
                    p.type === "text" ? (
                      <MessageResponse key={i}>{p.text}</MessageResponse>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="w-fit font-mono text-xs"
                        key={i}
                      >
                        <WrenchIcon className="size-3" />
                        {p.name}
                      </Badge>
                    ),
                  )}
                  {m.role === "assistant" && m.costUsd !== undefined && (
                    <span className="font-mono text-xs text-muted-foreground">
                      ${m.costUsd.toFixed(4)}
                    </span>
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
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="h-8 w-[150px] text-xs" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={account} onValueChange={setAccount}>
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
            <PromptInputSubmit status={status === "ready" ? undefined : status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
