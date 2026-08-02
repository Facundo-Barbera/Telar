import Link from "next/link";
import { ArrowLeftIcon, FolderGitIcon } from "lucide-react";
import {
  getAccount,
  resolveEnabledAccount,
} from "@telar/core/accounts";
import { getProject } from "@telar/core/manifest";
import { getChat } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { SessionView } from "@/components/session/session-view";
import { RightPanel } from "@/components/right-panel/right-panel";
import { readAccountsEnvelope } from "@/lib/accounts-server";

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
  // Story 4.2 / AC7 — `run` joins `role`. THE DOCK'S TAP LANDS HERE with
  // `?run=<runId>` and SessionView selects that run in the rail's Workflows
  // section ("focus" is STATE, never a programmatic `element.focus()`).
  //
  // WHY A PROP AND NOT `useSearchParams()` IN THE CLIENT COMPONENT. Both shapes
  // work; this one carries no framework risk. Per
  // `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md`:
  // "If a route is prerendered, calling `useSearchParams` will cause the Client
  // Component tree up to the closest Suspense boundary to be client-side
  // rendered", and Next recommends a `<Suspense>` wrapper. This page is
  // `dynamic = "force-dynamic"` so it is never prerendered TODAY — but that
  // makes the constraint a property of a route-segment config someone could
  // change, enforced at `next build`, which this repo's gate does not run.
  // Threading the value costs one key and cannot break a build.
  //
  // SessionView is keyed `${name}:${id}`, so a query-only change does NOT
  // remount it — the new value arrives as an ordinary re-render, which is the
  // behaviour AC7 wants (a remount would tear down the live stream).
  searchParams: Promise<{ role?: string; run?: string }>;
}) {
  const { name, id } = await params;
  const { role: roleParam, run: runParam } = await searchParams;

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
  const freshAccount = chat ? undefined : resolveEnabledAccount(manifest.account);
  if (!chat && !freshAccount) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <EmptyState
          icon={FolderGitIcon}
          title="No enabled account"
          description="Enable the project account or another account in Settings before starting a session."
          action={
            <Button variant="outline" size="sm" render={<Link href="/settings?section=providers" />}>
              Open provider settings
            </Button>
          }
        />
      </div>
    );
  }
  const account = chat?.account ?? freshAccount!.name;
  // Seed the persisted harness explicitly so a resumed Codex chat does not
  // visually fall back to Claude when its account is currently unavailable.
  const initialProvider = getAccount(account)?.provider ?? "claude";

  // Display-only account metadata for the client picker — passed as plain
  // data so the client component never imports the server-only registry.
  const accounts = readAccountsEnvelope().accounts
    .filter((account) => account.available)
    .map((a) => ({
      name: a.name,
      provider: a.provider ?? "claude",
      displayTier: a.displayTier,
      runtimeRouted: a.runtimeRouted,
    }));

  // The app sidebar owns session navigation. This pane keeps SessionView's own
  // header inside it so a freshly-minted session shows its derived title live
  // (the store only persists the title on the later 'saved' event, after the
  // URL has already been rewritten to the new id).
  return (
    <div className="flex h-dvh overflow-hidden">
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
          initialProvider={initialProvider}
          accounts={accounts}
          initialChat={initialChat}
          initialTitle={chat?.title}
          initialRole={initialRole}
          // The route's session id (undefined for the "new" front door). Lets
          // SessionView seed a non-null sessionId on a cold reload of a
          // mid-turn session whose transcript hasn't persisted yet — so the
          // reconnect effect can tail the live stream instead of showing empty.
          routeSessionId={id === "new" ? undefined : id}
          rightPanelScopeKey={`${name}:${id}`}
          // Story 4.2 / AC7 — the run to focus in the rail on arrival.
          focusRunId={runParam}
        />
      </div>
      <RightPanel project={name} scopeKey={`${name}:${id}`} />
    </div>
  );
}
