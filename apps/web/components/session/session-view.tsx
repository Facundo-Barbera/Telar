"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, PlayIcon, UserRoundIcon, WrenchIcon } from "lucide-react";
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
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtCost, shortId } from "@/lib/format";
import { DEFAULT_MODEL, MODELS, modelById } from "@/lib/models";

// The transcript shape the store persists (see lib/store.ts). Text parts stream
// with a `done` flag on the client; persisted parts are always finished.
type StorePart =
  | { type: "text"; text: string }
  | { type: "tool"; name: string };
type StoreMessage = { role: "user" | "assistant"; parts: StorePart[] };

type Part =
  | { type: "text"; text: string; done: boolean }
  | { type: "tool"; name: string };
type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };
type Status = "ready" | "submitted" | "streaming" | "error";

export type InitialChat = {
  id: string;
  model: string;
  messages: StoreMessage[];
};

const refresh = () => window.dispatchEvent(new Event("telar:refresh"));

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

function seedMessages(chat: InitialChat | undefined): ChatMessage[] {
  if (!chat) return [];
  return chat.messages.map((m, i) => ({
    id: `seed-${i}`,
    role: m.role,
    parts: m.parts.map((p) =>
      p.type === "text"
        ? { type: "text" as const, text: p.text, done: true }
        : { type: "tool" as const, name: p.name },
    ),
  }));
}

// A project-anchored Claude session. cwd + account are fixed by the project's
// manifest (the account chip is read-only); the tools stay read-only (Read /
// Grep / Glob) — sessions explore and prepare, runs do the writing.
export function SessionView({
  project,
  account,
  initialChat,
  initialTitle,
}: {
  project: string;
  account: string;
  initialChat?: InitialChat;
  initialTitle?: string;
}) {
  const router = useRouter();

  // Seed once from the server-resolved transcript. Later prop changes are
  // ignored on purpose: when a fresh session is minted mid-stream we rewrite
  // the URL to its new id, which re-renders this page with initialChat still
  // undefined — re-seeding would tear the live stream down.
  const [sessionId, setSessionId] = useState<string | null>(
    initialChat?.id ?? null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    seedMessages(initialChat),
  );
  // The header title lives here so a freshly-minted session shows its derived
  // thread title immediately — the server can't re-title mid-stream (getChat is
  // undefined until the first turn persists, long after the URL is rewritten).
  const [title, setTitle] = useState(initialTitle ?? "New session");
  const [model, setModel] = useState(initialChat?.model ?? DEFAULT_MODEL);
  const [status, setStatus] = useState<Status>("ready");
  const [thinking, setThinking] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const busy = status === "submitted" || status === "streaming";

  // Elapsed clock — runs only while a turn is in flight.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [busy]);

  // Abort any in-flight turn if the session is navigated away from.
  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  const send = useCallback(
    async (text: string) => {
      const userId = `m${nextId.current++}`;
      const asstId = `m${nextId.current++}`;
      // Fresh session (no id yet): the first user message names the thread,
      // mirroring the title the store derives on save.
      if (!sessionId) setTitle(text.slice(0, 60));
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
          body: JSON.stringify({ message: text, sessionId, model, project }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          // A project rejected server-side (unknown/removed) answers with a
          // plain JSON 400 before any SSE — surface its message.
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } catch {
            /* not JSON — keep the status line */
          }
          throw new Error(detail);
        }

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
                // A newly minted session id — reflect it in the URL without
                // reseeding (the page keeps initialChat undefined until the
                // first turn persists, so the live stream survives the rewrite).
                if (payload.sessionId !== sessionId) {
                  setSessionId(payload.sessionId);
                  router.replace(
                    `/projects/${encodeURIComponent(project)}/sessions/${payload.sessionId}`,
                  );
                }
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
    [sessionId, model, project, router],
  );

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    void send(text);
  };

  const activeModel = modelById(model);

  return (
    <>
      <PageHeader
        leading={
          <BackLink
            href={`/projects/${encodeURIComponent(project)}`}
            label={`Back to ${project}`}
          />
        }
        title={title}
        description={<span className="font-mono text-xs">{project}</span>}
      />

      {/* Live heartbeat for this session — account (fixed by the manifest),
          session id once minted, elapsed while working, running cost. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
        <Badge variant="outline" className="gap-1.5 font-mono text-xs">
          <UserRoundIcon className="size-3" />
          {account}
        </Badge>
        {sessionId && (
          <Badge variant="secondary" className="font-mono text-xs">
            {shortId(sessionId)}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {busy && (
            <Shimmer className="text-xs">
              {`${status === "submitted" ? "starting" : thinking ? "thinking" : "working"} · ${elapsed}s`}
            </Shimmer>
          )}
          <Badge variant="outline" className="font-mono text-xs">
            {fmtCost(sessionCost)}
          </Badge>
        </div>
      </div>

      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Read the workspace"
              description="This session explores the repo with Read · Grep · Glob to plan a change. When you're ready to write, start a run."
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
            <PromptInputTextarea placeholder={`Ask about ${project}…`} />
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  router.push(`/runs?new=1&project=${encodeURIComponent(project)}`)
                }
              >
                <PlayIcon />
                Start run
              </Button>
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
