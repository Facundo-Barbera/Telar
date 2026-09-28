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

import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import type { ClaudeConversation } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { fmtAgo, formatBytes } from "@/lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** The bold half of a row — the NAME the CLI's own `/resume` shows (a
 *  `/rename`, else its auto-title), because that is what a person searches for
 *  after seeing it in their terminal. Leading with the opening prompt instead
 *  hid `triage-2` behind "/clear" and made it unfindable by the name they knew. */
function titleOf(conversation: ClaudeConversation): string {
  return conversation.customTitle?.trim() || conversation.title.trim() || conversation.firstPrompt?.trim() || conversation.sessionId;
}

/** The opening prompt, shown under the name only when it says something the
 *  name does not — which is what still tells six "PINEAPPLE-7742"s apart. */
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
  const [query, setQuery] = useState("");

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

  /**
   * TITLE AND PATH, CLIENT-SIDE — the whole list is already loaded (#616), so
   * a second round trip to filter it would be a network request standing in
   * for a string comparison. Six identically-titled rows is exactly the case
   * a title-only search would fail on too, so the path is searched as well:
   * it is the other fact that tells two "PINEAPPLE-7742"s apart.
   */
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
          {/* ONE SENTENCE FOR ONE FACT — what picking a row does. Everything
              else a person might want to know (why a row looks the way it
              does) lives in this file's own header comment, not in front of
              them every time the dialog opens. */}
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

        {/* SEARCH ONLY WHEN THERE IS SOMETHING TO NARROW. An empty list has
            nothing for it to filter, and a one-row list has nothing worth
            typing for. */}
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
  const title = titleOf(conversation);
  const prompt = promptOf(conversation);
  // Age, branch, size — the three facts on one muted line, joined only where
  // each one actually exists. A conversation from `main` with no branch
  // recorded must not read as a stray dot.
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
      {/* THE NAME THE CLI SHOWS, then the person's opening words under it.
          `truncate` cuts wherever the box ends, so the FULL text lives in
          `title=` for hovering (or a screen reader). */}
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
      {/* AGE · BRANCH · SIZE — one muted line, not three facts run together
          with no separator. */}
      {meta.length > 0 && <span className="truncate text-3xs text-muted-foreground tabular-nums">{meta.join(" · ")}</span>}
      {/* THE PATH, TRUNCATED FROM THE LEFT — the project it belongs to is the
          TAIL of the path (`…/Telar/dev-build-fixed-place`), not the drive
          root every checkout shares. `dir="rtl"` with `text-align: left` is
          what makes the browser's own ellipsis eat the front of the string
          instead of the back; ordinary `truncate` would show the least useful
          half of every row. */}
      {conversation.cwd && (
        <span dir="rtl" title={conversation.cwd} className="block min-w-0 truncate text-left font-mono text-3xs text-muted-foreground/70">
          {conversation.cwd}
        </span>
      )}
    </button>
  );
}

