import Link from "next/link";
import { ArrowLeftIcon, FolderGitIcon } from "lucide-react";
import { getProject, listAccounts } from "@telar/core";
import { getChat, listChats } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { SessionView } from "@/components/session/session-view";
import { SessionsRail } from "@/components/session/sessions-rail";

// The transcript is read straight from the store at request time.
export const dynamic = "force-dynamic";

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

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string; id: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  const { name, id } = await params;
  const { role: roleParam } = await searchParams;

  // The manifest fixes this project's default account. An unknown project is
  // a stable condition (it can't resolve mid-stream), so it's the one case
  // we surface as an error rather than a fresh session.
  let manifest;
  try {
    manifest = getProject(name).manifest;
  } catch {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader
          leading={<BackLink href="/projects" label="Back to projects" />}
          title="Session"
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={FolderGitIcon}
            title="This project isn't on the loom"
            description={
              <>
                No registered project named{" "}
                <span className="font-mono">{name}</span>. It may have been
                removed from the registry.
              </>
            }
            action={
              <Button variant="outline" size="sm" render={<Link href="/projects" />}>
                Back to projects
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // id "new" = a fresh session. For a real id we seed the transcript when the
  // store has it; a not-yet-persisted id (a session just minted mid-stream,
  // before its first turn is saved) resolves to `undefined` and is treated as
  // fresh, so rewriting the URL to the new id never tears the live stream down.
  const chat = id === "new" ? undefined : getChat(id);
  const initialChat = chat
    ? {
        id: chat.id,
        model: chat.model,
        effort: chat.effort,
        permissionMode: chat.permissionMode,
        messages: chat.messages,
        costUsd: chat.costUsd,
        inputTokens: chat.inputTokens ?? 0,
        outputTokens: chat.outputTokens ?? 0,
        cacheReadTokens: chat.cacheReadTokens ?? 0,
        cacheCreateTokens: chat.cacheCreateTokens ?? 0,
        contextTokens: chat.contextTokens ?? 0,
        loomId: chat.loomId,
        role: chat.role,
      }
    : undefined;

  // "Plan a loom" (the Looms tab's front door) links here with
  // `?role=planner` on a brand-new session — a hint SessionView uses to show
  // planning-mode framing before the chat's own Chat.role is ever persisted
  // (that only happens once the loom MCP server's draft_bundle_file actually
  // runs, see lib/loom-mcp.ts). Meaningless once a real chat exists — its own
  // persisted role (above) always wins.
  const initialRole = !chat && roleParam === "planner" ? "planner" : undefined;

  // An existing chat resumes with its own persisted account (the resume
  // transcript lives under that account's config dir — the manifest default
  // may have changed since); a fresh session falls back to the manifest.
  const account = chat?.account ?? manifest.account;

  // The rail lists every session anchored to this project, newest-first. It's
  // server-rendered from the store: a freshly-minted session (URL rewritten
  // mid-stream, first turn not yet persisted) simply isn't in the list until it
  // saves — no highlight, which is correct for a thread that doesn't exist yet.
  // Loom-born sessions (role "steerer"/"escalation") are excluded — same rule
  // as GET /api/chats — they're scoped to their loom's own UI, not this rail.
  // A direct link to one (e.g. from the loom page) still opens it via the pane
  // on the right; it just never appears in this list.
  const sessions = listChats(name).filter(
    (c) => c.role !== "steerer" && c.role !== "escalation",
  );

  // Display-only account metadata for the client picker — passed as plain
  // data so the client component never imports the server-only registry.
  const accounts = listAccounts().map((a) => ({
    name: a.name,
    displayTier: a.displayTier,
  }));

  // Rail on the left, chat pane on the right. The pane keeps SessionView's own
  // header inside it so a freshly-minted session shows its derived title live
  // (the store only persists the title on the later 'saved' event, after the
  // URL has already been rewritten to the new id).
  return (
    <div className="flex h-dvh overflow-hidden">
      <SessionsRail project={name} sessions={sessions} activeId={id} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <SessionView
          // Keyed on project+id (not just project) so a real Next.js
          // navigation between two sessions remounts SessionView and
          // re-seeds its state from the new initialChat/account/title.
          // The mid-stream `history.replaceState` rename (see session-view's
          // "session" event handler) never re-renders this server component,
          // so `id` here doesn't change then — only on an actual navigation,
          // which is exactly when a remount is wanted.
          key={`${name}:${id}`}
          project={name}
          account={account}
          accounts={accounts}
          initialChat={initialChat}
          initialTitle={chat?.title}
          initialRole={initialRole}
          // The route's session id (undefined for the "new" front door). Lets
          // SessionView seed a non-null sessionId on a cold reload of a
          // mid-turn session whose transcript hasn't persisted yet — so the
          // reconnect effect can tail the live stream instead of showing empty.
          routeSessionId={id === "new" ? undefined : id}
        />
      </div>
    </div>
  );
}
