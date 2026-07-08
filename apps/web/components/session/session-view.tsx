"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  PlayIcon,
  ShieldAlertIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
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
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
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
import { cn } from "@/lib/utils";

// The transcript shape the store persists (see lib/store.ts). Text parts stream
// with a `done` flag on the client; persisted parts are always finished.
type StorePart =
  | { type: "text"; text: string }
  | { type: "tool"; name: string };
type StoreMessage = { role: "user" | "assistant"; parts: StorePart[] };

// Permission cards are live-stream-only artifacts (resolved by "permission_result"
// or the server's 120s timeout deny) — they never round-trip through the store,
// so StorePart above stays exactly as persisted.
type Part =
  | { type: "text"; text: string; done: boolean }
  | { type: "tool"; name: string }
  | {
      type: "permission";
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      rule: string;
      status: "pending" | "allowed" | "denied";
    };
type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };
type Status = "ready" | "submitted" | "streaming" | "error";

type ProjectCommand = {
  name: string;
  description: string;
  kind: "command" | "skill";
};

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

// Best-effort salient preview of a tool call's input: the path/command a human
// actually cares about, or a capped JSON dump for anything else.
function permissionPreview(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

function PermissionCard({
  part,
  onRespond,
}: {
  part: Extract<Part, { type: "permission" }>;
  onRespond: (id: string, behavior: "allow" | "deny", always: boolean) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <ShieldAlertIcon className="size-3.5 text-muted-foreground" />
        {part.toolName}
      </div>
      <div className="overflow-x-auto rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="whitespace-pre-wrap break-all">
          {permissionPreview(part.input)}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        rule <span className="font-mono text-foreground/80">{part.rule}</span>
      </div>
      {part.status === "pending" ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onRespond(part.id, "allow", false)}
          >
            Allow once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-auto flex-col items-start gap-0 py-1"
            onClick={() => onRespond(part.id, "allow", true)}
          >
            <span>Always allow</span>
            <span className="font-mono text-[9px] font-normal text-muted-foreground">
              {part.rule}
            </span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            onClick={() => onRespond(part.id, "deny", false)}
          >
            Deny
          </Button>
        </div>
      ) : (
        <Badge
          variant={part.status === "allowed" ? "secondary" : "destructive"}
          className="w-fit text-[10px]"
        >
          {part.status === "allowed" ? "Allowed" : "Denied"}
        </Badge>
      )}
    </div>
  );
}

// A project-anchored Claude session. cwd is fixed by the project's manifest.
// The account is choosable up front (contract: an SDK session's resume
// transcript lives under the account's config dir, so it's only choosable
// before the first turn — sessionId === null); once a session exists it's
// locked and shown read-only in the heartbeat bar. Tools stay read-only
// (Read / Grep / Glob) — sessions explore and prepare, runs do the writing.
export function SessionView(props: {
  project: string;
  account: string;
  accounts: Array<{ name: string; displayTier?: string }>;
  initialChat?: InitialChat;
  initialTitle?: string;
}) {
  // The slash-command menu and account lock both need to read/drive the
  // composer's text value from outside <PromptInput> itself — the provider
  // lifts that state so this component and the composer share one source.
  return (
    <PromptInputProvider>
      <SessionViewInner {...props} />
    </PromptInputProvider>
  );
}

function SessionViewInner({
  project,
  account,
  accounts,
  initialChat,
  initialTitle,
}: {
  project: string;
  account: string;
  accounts: Array<{ name: string; displayTier?: string }>;
  initialChat?: InitialChat;
  initialTitle?: string;
}) {
  const router = useRouter();
  const textInput = usePromptInputController().textInput;

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
  // The caller already resolves the effective account (chat.account for an
  // existing session, the manifest default for a fresh one — contract #5:
  // resume transcripts live under the account's config dir, so an existing
  // chat must never drift to a since-changed manifest default). We just seed
  // from it once and lock further edits once a session exists (below).
  const [activeAccount, setActiveAccount] = useState(account);
  const [status, setStatus] = useState<Status>("ready");
  const [thinking, setThinking] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Slash-command autocomplete. `projectCommands` comes from the project's
  // .claude/commands scan (has descriptions); `sdkSlashCommands` narrows it to
  // what the live SDK session actually reports once a turn's "session" event
  // arrives (that list also contains built-ins we deliberately don't show).
  const [projectCommands, setProjectCommands] = useState<ProjectCommand[]>([]);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<string[] | null>(
    null,
  );
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

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

  // Non-200 (including a project scan with no .claude/commands dir, which the
  // endpoint itself answers with an empty list) is treated as "no commands" —
  // autocomplete is a nicety, never worth an error UI.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(project)}/commands`)
      .then((res) => (res.ok ? res.json() : { commands: [] }))
      .then((data: { commands?: ProjectCommand[] }) => {
        if (!cancelled) setProjectCommands(data.commands ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjectCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  const respondPermission = useCallback(
    (id: string, behavior: "allow" | "deny", always: boolean) => {
      // Optimistic — the "permission_result" SSE event (or the server's 120s
      // timeout deny) is authoritative and will overwrite this regardless.
      setMessages((ms) =>
        ms.map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === "permission" && p.id === id
              ? { ...p, status: behavior === "allow" ? "allowed" : "denied" }
              : p,
          ),
        })),
      );
      fetch("/api/chat/permission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, behavior, always }),
      }).catch(() => {
        // Fire-and-forget: the SSE event / server timeout still resolves this.
      });
    },
    [],
  );

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
          body: JSON.stringify({
            message: text,
            sessionId,
            model,
            project,
            account: activeAccount,
          }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          // A project/account rejected server-side (unknown/removed) answers
          // with a plain JSON 400 before any SSE — surface its message.
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
        // Set by the "error" case below instead of throwing there — throwing
        // mid-loop would unwind out of the read loop and skip the server's
        // trailing "saved"/"done" events (still sent from its finally block
        // after a mid-turn error). We keep reading to the natural end of the
        // stream and only surface the error once it actually closes.
        let streamErrorMessage: string | null = null;

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
                // A newly minted session id — reflect it in the URL shallowly.
                // router.replace here would be a real App Router navigation:
                // it remounts the page, cancels this fetch, and the abort kills
                // the SDK turn server-side. history.replaceState updates the
                // address bar only; the next real navigation loads the
                // persisted transcript from the new URL.
                if (payload.sessionId !== sessionId) {
                  setSessionId(payload.sessionId);
                  window.history.replaceState(
                    null,
                    "",
                    `/projects/${encodeURIComponent(project)}/sessions/${payload.sessionId}`,
                  );
                }
                if (Array.isArray(payload.slashCommands)) {
                  setSdkSlashCommands(payload.slashCommands);
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
              case "permission":
                // The turn stays in flight while the card is pending — status
                // mirrors the "tool" case so the busy shimmer keeps showing.
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => ({
                  ...m,
                  parts: [
                    ...m.parts,
                    {
                      type: "permission",
                      id: payload.id,
                      toolName: payload.toolName,
                      input: payload.input ?? {},
                      rule: payload.rule,
                      status: "pending",
                    },
                  ],
                }));
                break;
              case "permission_result":
                setMessages((ms) =>
                  ms.map((m) => ({
                    ...m,
                    parts: m.parts.map((p) =>
                      p.type === "permission" && p.id === payload.id
                        ? { ...p, status: payload.behavior === "allow" ? "allowed" : "denied" }
                        : p,
                    ),
                  })),
                );
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
                streamErrorMessage = payload.message;
                break;
            }
          }
        }
        if (streamErrorMessage) {
          patch(asstId, (m) => ({
            ...m,
            parts: [...m.parts, { type: "text", text: `**Error:** ${streamErrorMessage}`, done: true }],
          }));
          setStatus("error");
        } else {
          setStatus("ready");
        }
      } catch (err) {
        // The server's teardown fail-closed-denies any permission still open
        // on this stream once we stop reading it (client abort, unmount, or a
        // dropped connection) — mirror that locally so a stale card doesn't
        // keep showing live Allow/Deny buttons for a turn that's already
        // finished server-side.
        setMessages((ms) =>
          ms.map((m) => ({
            ...m,
            parts: m.parts.map((p) =>
              p.type === "permission" && p.status === "pending"
                ? { ...p, status: "denied" as const }
                : p,
            ),
          })),
        );
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
    [sessionId, model, project, activeAccount, router],
  );

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    void send(text);
  };

  const activeModel = modelById(model);

  // Merge project's scanned commands+skills with what the live SDK session
  // actually reports (once known) — the SDK's slash_commands list includes
  // repo skills alongside .claude/commands entries, so a name match here
  // keeps skills exactly like commands. The SDK list also carries built-ins
  // and plugin commands we don't advertise, so this only ever narrows, never
  // adds names the project scan didn't already find.
  const availableCommands = useMemo(() => {
    if (sdkSlashCommands === null) return projectCommands;
    const known = new Set(sdkSlashCommands);
    return projectCommands.filter((c) => known.has(c.name));
  }, [projectCommands, sdkSlashCommands]);

  const slashQuery =
    textInput.value.startsWith("/") && !textInput.value.includes(" ")
      ? textInput.value.slice(1)
      : null;

  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return availableCommands.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [availableCommands, slashQuery]);

  // The menu also opens on a genuinely empty project (zero commands AND zero
  // skills) so it can show the "how to add some" hint below instead of just
  // silently doing nothing — that read as a broken feature to users. A query
  // that merely doesn't match anything (project has commands, none start
  // with what's typed) still closes the menu as before.
  const slashMenuOpen =
    slashQuery !== null &&
    !menuDismissed &&
    (filteredCommands.length > 0 || projectCommands.length === 0);

  // Reset the selection whenever the query text changes so it never points
  // past a shrunk list or feels stale after typing.
  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  const acceptCommand = useCallback(
    (c: ProjectCommand) => {
      textInput.setInput(`/${c.name} `);
    },
    [textInput],
  );

  // No focus() anywhere here — navigation and acceptance are driven entirely
  // by the textarea's own keydown, so the textarea never loses focus.
  const handleComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!slashMenuOpen) return;
    // Escape always dismisses, including the empty-project hint panel. The
    // rest only make sense once there's something to navigate/accept — the
    // hint panel has no items, so leave those keys to behave normally
    // (e.g. Enter still submits the composer).
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuDismissed(true);
      return;
    }
    if (filteredCommands.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filteredCommands.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        acceptCommand(filteredCommands[selectedIndex] ?? filteredCommands[0]);
        break;
    }
  };

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

      {/* Live heartbeat for this session — active account (editable pre-session,
          locked once one exists), session id once minted, elapsed while
          working, running cost. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
        <Badge variant="outline" className="gap-1.5 font-mono text-xs">
          <UserRoundIcon className="size-3" />
          {activeAccount}
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
                  {m.parts.map((p, i) => {
                    if (p.type === "text") {
                      return <MessageResponse key={i}>{p.text}</MessageResponse>;
                    }
                    if (p.type === "permission") {
                      return (
                        <PermissionCard key={i} part={p} onRespond={respondPermission} />
                      );
                    }
                    return (
                      <Badge variant="secondary" className="w-fit font-mono text-xs" key={i}>
                        <WrenchIcon className="size-3" />
                        {p.name}
                      </Badge>
                    );
                  })}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="relative mx-auto w-full max-w-3xl px-4 pb-4">
        {slashMenuOpen && (
          <div className="absolute inset-x-4 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            {filteredCommands.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                No commands — add .claude/commands/*.md or skills to this repo.
              </p>
            ) : (
              filteredCommands.map((c, i) => (
                <button
                  type="button"
                  key={c.name}
                  // preventDefault on mousedown keeps focus on the textarea — no
                  // .focus() call, just skipping the browser's default click-to-
                  // focus so the composer stays the active element.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => acceptCommand(c)}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                    i === selectedIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-xs">/{c.name}</span>
                    {c.kind === "skill" && (
                      <Badge variant="outline" className="px-1 py-0 text-[10px]">
                        skill
                      </Badge>
                    )}
                  </span>
                  {c.description && (
                    <span className="text-[11px] text-muted-foreground">
                      {c.description}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={`Ask about ${project}… ("/" for commands)`}
              onKeyDown={handleComposerKeyDown}
              onChange={() => setMenuDismissed(false)}
            />
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
                <SelectContent className="w-[min(340px,calc(100vw-2rem))]">
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="py-2">
                      <div className="flex w-full min-w-0 flex-col gap-0.5 whitespace-normal">
                        <div className="flex flex-wrap items-center gap-2">
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
              {sessionId === null && !busy && (
                <Select
                  value={activeAccount}
                  onValueChange={(v) => v && setActiveAccount(v)}
                >
                  <SelectTrigger className="h-8 w-[140px] text-xs" size="sm">
                    <SelectValue>
                      <span className="flex items-center gap-1.5">
                        <UserRoundIcon className="size-3" />
                        {activeAccount}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className="w-[min(220px,calc(100vw-2rem))]">
                    {accounts.map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        <div className="flex w-full min-w-0 items-center gap-1.5 whitespace-normal">
                          <span className="truncate">{a.name}</span>
                          {a.displayTier && (
                            <Badge variant="outline" className="ml-auto shrink-0 px-1 py-0 text-[10px]">
                              {a.displayTier}
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
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
