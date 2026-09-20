"use client";

/**
 * PICK UP A CLAUDE CODE CONVERSATION — `/resume`'s picker (#616).
 *
 * ── WHY EVERY ROW CARRIES FOUR FACTS ────────────────────────────────────────
 *
 * The obvious picker is a list of titles, and it was measured to fail. The
 * CLI's own auto-titles do NOT distinguish conversations: six identically
 * titled sessions were produced deliberately in one directory, and the CLI
 * ITSELF refused to choose between them —
 *
 *     Error: --resume "PINEAPPLE-7742" matches 6 sessions.
 *     Pass one of these session IDs to disambiguate:
 *
 * That is a list of rows a person cannot tell apart, in their own tool. So a
 * row here never rests on the title: the person's own opening words say what
 * the conversation was about, the time says when they were last in it, the
 * project path says which work it belongs to, and the size says whether it is
 * a long thread or a one-line question. Any two real conversations differ in
 * at least one of the four.
 *
 * ── WHAT IT DOES NOT FILTER ─────────────────────────────────────────────────
 *
 * NOT scoped to the current project. Resume finds a conversation by id from any
 * directory, so hiding conversations from elsewhere would hide ones that adopt
 * perfectly well. The project path is shown instead, and the person decides.
 *
 * Conversations Telar has already adopted are absent — that filtering is the
 * engine's, by where the fork lives. Adopting an adoption is something a person
 * could otherwise do without ever being told that is what it was.
 *
 * ── WHAT PICKING ONE MEANS ──────────────────────────────────────────────────
 *
 * It copies. Telar forks rather than continuing in place, so the conversation
 * in the person's own Claude Code history is left exactly as it was — and the
 * dialog says so, because "it was copied" is the kind of thing somebody should
 * be told rather than discover.
 */

import { useEffect, useState } from "react";
import { DownloadIcon, FolderGit2Icon } from "lucide-react";
import type { ClaudeConversation } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { fmtAgo, formatBytes } from "@/lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function ResumePicker({
  open,
  onOpenChange,
  onPick,
  api = createEngineApi(),
  instanceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Adopting is the CALLER's — it has to create the session first, and only it
   *  knows which project and checkout that session belongs in. */
  onPick: (conversation: ClaudeConversation) => Promise<void> | void;
  api?: Pick<ReturnType<typeof createEngineApi>, "claudeConversations">;
  /** Whose history to read. Absent is the built-in login, which is where a
   *  terminal `claude` writes. */
  instanceId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* MOUNTED ONLY WHILE OPEN, which is what makes the list below need no
          resetting: every opening is a fresh component with empty state, so
          there is no stale answer from the last time and no effect clearing one.
          It also means a closed picker costs no request. */}
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

  useEffect(() => {
    let live = true;
    void api
      .claudeConversations(instanceId)
      .then((answer) => {
        if (live) setConversations(answer.conversations);
      })
      .catch((cause: unknown) => {
        // THE REASON, NOT A BLANK LIST. "No conversations" and "the store could
        // not be read" look identical in an empty picker, and only one of them
        // is something the person can act on.
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

  return (
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pick up a Claude Code conversation</DialogTitle>
          <DialogDescription>
            Telar copies the conversation and continues the copy, so the one in your own Claude Code history is left
            exactly as it is.
          </DialogDescription>
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
          <ul className="-mx-1 max-h-[24rem] overflow-y-auto">
            {conversations.map((conversation) => (
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

/**
 * ONE ROW, AND ITS OWN COMPONENT so it can be rendered — and asserted on —
 * without the dialog around it. A portalled dialog produces no markup under a
 * static render, so the four facts that make a row choosable would otherwise be
 * pinned only against source text.
 */
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
      {/* THE PERSON'S OWN OPENING WORDS FIRST, because that is what a
          conversation IS to them. A name they CHOSE is second; a generated one
          repeated across six rows is the thing this picker exists to survive. */}
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">
          {conversation.firstPrompt?.trim() || conversation.customTitle || conversation.title || conversation.sessionId}
        </span>
        {busy && <Spinner className="shrink-0" />}
      </span>
      {conversation.customTitle && conversation.firstPrompt?.trim() && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{conversation.customTitle}</span>
      )}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-3xs text-muted-foreground">
        <span className="tabular-nums">{fmtAgo(conversation.lastActivityAt)}</span>
        {conversation.cwd && (
          <span className="flex min-w-0 items-center gap-1">
            <FolderGit2Icon className="size-3 shrink-0" />
            <span className="min-w-0 truncate font-mono">{conversation.cwd}</span>
          </span>
        )}
        {conversation.gitBranch && <span className="font-mono">{conversation.gitBranch}</span>}
        {conversation.bytes !== undefined && (
          <span className="font-mono tabular-nums">{formatBytes(conversation.bytes)}</span>
        )}
      </span>
    </button>
  );
}

/** The line that opens the picker, for the empty composer. */
export function ResumePickerTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <DownloadIcon className="size-3.5 shrink-0" />
      Pick up a Claude Code conversation
    </button>
  );
}
