import Link from "next/link";
import { ArrowLeftIcon, FolderGitIcon, WorkflowIcon } from "lucide-react";
import {
  isAccountAvailableForSessions,
  listAccounts,
  resolveEnabledAccount,
} from "@telar/core/accounts";
import { getProject } from "@telar/core/manifest";
import { getLoom } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { SessionView } from "@/components/session/session-view";

// Account/manifest resolution reads the registry + config dir fresh on every
// request — same contract as /projects/[name]/sessions/[id], which this
// route mirrors.
export const dynamic = "force-dynamic";

function BackLink() {
  return (
    <Link
      href="/looms"
      aria-label="Back to looms"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

// The Loom Session (docs/loom-model.md §5): a dedicated planning session that
// lives in the Looms tab, purpose-built to prepare exactly one Loom for
// `project`. The SESSION is always fresh — there's no chat id to resume; a real
// Chat record is only minted once the session's first turn actually runs,
// mirroring how /projects/[name]/sessions/[id] treats id === "new". SessionView
// is reused wholesale (composer, stream, tool rendering); the only
// planner-specific pieces are the thin banner below and the
// `planner`/`initialRole` props, which make SessionView auto-navigate to the
// god-view on `start_loom` and frame its empty state as "Plan a loom" instead
// of "Work in this repo".
//
// ── ?loom=<id> — ADOPTING AN EXISTING DRAFT ─────────────────────────────────
// A fresh session normally mints its draft lazily (loom-mcp's
// draft_bundle_file, first use). `?loom=` binds this session to a draft that
// ALREADY EXISTS instead, which is how a draft written by something other than
// a planning session gets a human and a start button: the workspace's weave
// (SPEC-organization-workspace CAP-11) hands a packet's premise + context to a
// draft loom and stops at the detach boundary — it may not write a Verification
// Contract, and startLoomFromBundle refuses a bundle without one. That draft
// would otherwise be unreachable by any start path in the app.
//
// VALIDATED, AND FAILING SAFE. The loom must exist, belong to THIS project, and
// still be a draft; anything else is ignored and the page opens a normal fresh
// planning session. A bad id in a URL is not worth an error page — and, exactly
// as the chat route's own steerer/escalation seed reasons, a gate that depends
// on a resent query param is a non-deterministic failure. The route only ever
// widens what this session may adopt to drafts of the project it is already
// scoped to, so it grants no reach it did not have.
export default async function LoomPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ loom?: string }>;
}) {
  const { project } = await params;
  const { loom: requestedLoomId } = await searchParams;

  // An unknown project can't resolve mid-stream, so — like the sessions
  // page — it's the one case surfaced as an error rather than a fresh
  // session.
  try {
    getProject(project);
  } catch {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader leading={<BackLink />} title="Plan a loom" />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={FolderGitIcon}
            title="This project isn't on the loom"
            description={
              <>
                No registered project named{" "}
                <span className="font-mono">{project}</span>. It may have
                been removed from the registry.
              </>
            }
            action={
              <Button variant="outline" size="sm" render={<Link href="/looms" />}>
                Back to looms
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // Display-only account metadata for the client picker (see SessionView) —
  // passed as plain data so the client component never imports the
  // server-only registry.
  const account = resolveEnabledAccount();
  if (!account) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <EmptyState
          icon={FolderGitIcon}
          title="No enabled account"
          description="Enable an account in Settings before starting a loom session."
          action={
            <Button variant="outline" size="sm" render={<Link href="/settings?section=providers" />}>
              Open provider settings
            </Button>
          }
        />
      </div>
    );
  }
  // See the header note: exists + same project + STILL A DRAFT, or it is as if
  // no id had been passed at all.
  const adopted = requestedLoomId ? getLoom(requestedLoomId) : null;
  const adoptedLoomId =
    adopted && adopted.project === project && adopted.draft === true ? adopted.id : undefined;

  const accounts = listAccounts()
    .filter(isAccountAvailableForSessions)
    .map((a) => ({
      name: a.name,
      provider: a.provider ?? "claude",
      displayTier: a.displayTier,
    }));

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* The only chrome this route adds on top of SessionView — a subtle
          "you are preparing a loom" cue (spec item 3). Everything below it
          (header, heartbeat bar, composer, stream) is SessionView, untouched
          from a normal project session. */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-primary/5 px-4 py-1.5 text-xs">
        <WorkflowIcon className="size-3.5 text-primary" />
        <span className="font-medium text-primary">Loom Session</span>
        <span className="text-muted-foreground">— preparing a loom for</span>
        <Badge
          variant="outline"
          className="border-primary/30 bg-primary/5 font-mono text-[10px] text-primary"
        >
          {project}
        </Badge>
        {adoptedLoomId && (
          <>
            <span className="text-muted-foreground">— continuing draft</span>
            <Link
              href={`/looms/${adoptedLoomId}`}
              className="font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {adoptedLoomId}
            </Link>
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <SessionView
          // The key carries the adopted id too: navigating from a fresh plan
          // page to an adopted one (or between two drafts) has to REMOUNT, or
          // the second render would keep the first session's state while
          // sending a different loomId.
          key={adoptedLoomId ? `${project}:${adoptedLoomId}` : project}
          project={project}
          account={account.name}
          accounts={accounts}
          initialRole="planner"
          planner
          {...(adoptedLoomId ? { loomId: adoptedLoomId } : {})}
        />
      </div>
    </div>
  );
}
