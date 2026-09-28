"use client";

import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import type { ClaudeConversation } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { fmtAgo, formatBytes } from "@/ui/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";
import { cn } from "@/ui/utils";

function titleOf(conversation: ClaudeConversation): string {
  return conversation.customTitle?.trim() || conversation.title.trim() || conversation.firstPrompt?.trim() || conversation.sessionId;
}

function promptOf(conversation: ClaudeConversation): string | undefined {
  const prompt = conversation.firstPrompt?.trim();
  return prompt && prompt !== titleOf(conversation) ? prompt : undefined;
}

export function ResumePicker({
  open,
  onOpenChange,
  onPick,
  api = createEngineApi(),
  instanceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (conversation: ClaudeConversation) => Promise<void> | void;
  api?: Pick<ReturnType<typeof createEngineApi>, "claudeConversations">;
  instanceId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <ConversationList
          api={api}
          onPick={onPick}
          onDone={() => onOpenChange(false)}
          {...(instanceId ? { instanceId } : {})}
        />
      )}
    </Dialog>
  );
}

function ConversationList({
  api,
  onPick,
  onDone,
  instanceId,
}: {
  api: Pick<ReturnType<typeof createEngineApi>, "claudeConversations">;
  onPick: (conversation: ClaudeConversation) => Promise<void> | void;
  onDone: () => void;
  instanceId?: string;
}) {
  const [conversations, setConversations] = useState<ClaudeConversation[]>();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState<string>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    void api
      .claudeConversations(instanceId)
      .then((answer) => {
        if (live) setConversations(answer.conversations);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "Your Claude Code conversations could not be read.");
      });
    return () => {
      live = false;
    };
  }, [api, instanceId]);

  const pick = async (conversation: ClaudeConversation) => {
    setPicking(conversation.sessionId);
    setError(undefined);
    try {
      await onPick(conversation);
      onDone();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That conversation could not be brought in.");
    } finally {
      setPicking(undefined);
    }
  };

  const filtered = useMemo(() => {
    if (!conversations) return conversations;
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((conversation) =>
      [titleOf(conversation), conversation.firstPrompt, conversation.cwd, conversation.sessionId].some((field) => field?.toLowerCase().includes(needle)),
    );
  }, [conversations, query]);

  return (
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pick up a Claude Code conversation</DialogTitle>
          <DialogDescription>Telar forks the conversation; your Claude Code history is left as it is.</DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}

        {conversations === undefined && !error && (
          <p className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Spinner /> Reading your conversations…
          </p>
        )}

        {conversations?.length === 0 && (
          <p className="px-1 py-6 text-sm text-muted-foreground">
            No Claude Code conversations on this Mac for this login — or every one of them is already open in Telar.
          </p>
        )}

        {conversations !== undefined && conversations.length > 0 && (
          <div className="relative">
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title or path"
              aria-label="Search conversations"
              className="pl-8"
            />
          </div>
        )}

        {conversations !== undefined && conversations.length > 0 && filtered?.length === 0 && (
          <p className="px-1 py-6 text-sm text-muted-foreground">No conversation matches &ldquo;{query.trim()}&rdquo;.</p>
        )}

        {filtered !== undefined && filtered.length > 0 && (
          <ul className="-mx-1 max-h-[24rem] overflow-y-auto">
            {filtered.map((conversation) => (
              <li key={conversation.sessionId}>
                <ConversationRow
                  conversation={conversation}
                  disabled={picking !== undefined}
                  busy={picking === conversation.sessionId}
                  onPick={() => void pick(conversation)}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
  );
}

export function ConversationRow({
  conversation,
  disabled,
  busy,
  onPick,
}: {
  conversation: ClaudeConversation;
  disabled?: boolean;
  busy?: boolean;
  onPick: () => void;
}) {
  const title = titleOf(conversation);
  const prompt = promptOf(conversation);
  const meta = [fmtAgo(conversation.lastActivityAt), conversation.gitBranch, conversation.bytes !== undefined ? formatBytes(conversation.bytes) : undefined].filter(
    (part): part is string => Boolean(part),
  );

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none transition-colors",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm" title={title}>
          {title}
        </span>
        {busy && <Spinner className="shrink-0" />}
      </span>
      {prompt && (
        <span className="truncate text-xs text-muted-foreground" title={prompt}>
          {prompt}
        </span>
      )}
      {meta.length > 0 && <span className="truncate text-3xs text-muted-foreground tabular-nums">{meta.join(" · ")}</span>}
      {conversation.cwd && (
        <span dir="rtl" title={conversation.cwd} className="block min-w-0 truncate text-left font-mono text-3xs text-muted-foreground/70">
          {conversation.cwd}
        </span>
      )}
    </button>
  );
}

