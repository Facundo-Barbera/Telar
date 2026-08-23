"use client";

/**
 * THE LOOM ROOM — one loom told in loom language, wearing the app's chrome.
 *
 * `PageHeader` carries the way back, the loom's name, its state, and the two
 * verbs (Verify, Accept) in the actions cluster where every surface keeps its
 * verbs. Each thread is a `Card` wearing the session rows' own status
 * language — hairline, activity badge, ticking duration — because a thread IS
 * a session and must read like one. The accept moat is unchanged: the button
 * refuses until every thread has a loom-run green.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, GitBranchIcon } from "lucide-react";
import type { SessionActivity } from "@telar/engine-client";
import { PageHeader } from "@/components/common/page-header";
import { fmtAgo } from "@/lib/format";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoomStateBadge, statusHairline, ThreadStatusSlot, TierBadge } from "@/components/loom/thread-row";

interface LiveThread {
  sessionId: string;
  slug?: string;
  title: string;
  brief: string;
  contract?: string;
  tier?: string;
  branch?: string;
  verification?: { tier: string; ok: boolean; at: number; detail?: string; commit?: string };
  live: {
    status: string;
    activity?: SessionActivity;
    activityAt?: number | null;
    updatedAt?: number;
    worktree: string | null;
    branch: string | null;
    lastAct: string | null;
    lastActAt: number | null;
    openTasks: number;
    itemCount: number;
  } | null;
}

interface LoomDetail {
  id: string;
  slug?: string;
  title: string;
  objective: string;
  projectId: string;
  state: "working" | "idle" | "verifying" | "ready" | "accepted";
  threads: LiveThread[];
  origin: { sessionId: string; title: string } | null;
  createdAt: number;
  acceptedAt?: number;
}

export function LoomRoom({ loomId }: { loomId: string }) {
  const [loom, setLoom] = useState<LoomDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/looms/${loomId}`);
      if (!r.ok) throw new Error(`loom: ${r.status}`);
      setLoom(await r.json());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [loomId]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), 6000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  const act = useCallback(
    async (action: "verify" | "accept") => {
      setBusy(action);
      try {
        const r = await fetch(`/api/looms/${loomId}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `${action}: ${r.status}`);
        }
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [loomId, refresh],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={
          <Button variant="ghost" size="icon-sm" aria-label="Back to looms" render={<Link href="/looms" />}>
            <ArrowLeftIcon />
          </Button>
        }
        title={
          <span className="flex items-center gap-2">
            <span className="truncate">{loom?.title ?? "Loom"}</span>
            {loom ? <LoomStateBadge state={loom.state} /> : null}
          </span>
        }
        description={loom ? loom.objective : undefined}
        actions={
          loom && !loom.acceptedAt ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                title="Checks out each thread's branch fresh and runs its tier — uncommitted work does not exist"
                onClick={() => void act("verify")}
              >
                {busy === "verify" ? "Verifying…" : "Verify"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-success"
                disabled={busy !== null || loom.state !== "ready"}
                title={loom.state !== "ready" ? "Accept unlocks when every thread's verification is green" : undefined}
                onClick={() => void act("accept")}
              >
                Accept
              </Button>
            </>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-3 px-6 py-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}

          {loom === null ? (
            <>
              <Skeleton className="h-32 w-full rounded-xl" />
              <Skeleton className="h-32 w-full rounded-xl" />
            </>
          ) : null}

          {loom?.origin ? (
            <p className="text-xs text-muted-foreground">
              Spun from{" "}
              <Link href={`/looms/${loom.id}/threads/${loom.origin.sessionId}`} className="underline decoration-dotted hover:text-foreground">
                {loom.origin.title}
              </Link>{" "}
              — that conversation now lives here.
            </p>
          ) : null}

          {loom?.threads.map((thread) => (
            <Card key={thread.sessionId} size="sm" className={`relative overflow-visible ${statusHairline(thread.live)}`}>
              <CardHeader>
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <Link href={`/looms/${loom.id}/threads/${thread.sessionId}`} className="truncate hover:underline">
                    {thread.title}
                  </Link>
                  <TierBadge {...(thread.tier ? { tier: thread.tier } : {})} />
                </CardTitle>
                <CardAction>
                  <ThreadStatusSlot live={thread.live} />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                {thread.live?.lastAct ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">now: {thread.live.lastAct}</p>
                ) : null}

                {thread.contract ? (
                  <p className="border-l-2 border-verify/50 pl-3 text-sm text-muted-foreground">
                    <span className="font-medium text-verify">Contract:</span> {thread.contract}
                  </p>
                ) : null}

                {thread.verification ? (
                  <div
                    className={`border-l-2 pl-3 text-sm ${
                      thread.verification.ok ? "border-success/50 text-success" : "border-destructive/50 text-destructive"
                    }`}
                  >
                    {thread.verification.tier} {thread.verification.ok ? "green" : "red"} · clean checkout
                    {thread.verification.commit ? ` of ${thread.verification.commit.slice(0, 7)}` : ""}
                    {thread.verification.detail ? (
                      <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{thread.verification.detail}</p>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {(thread.branch ?? thread.live?.branch) ? (
                    <>
                      <GitBranchIcon className="size-3 shrink-0" />
                      <span className="min-w-0 truncate font-mono">{thread.branch ?? thread.live?.branch}</span>
                    </>
                  ) : null}
                  <Link
                    href={`/looms/${loom.id}/threads/${thread.sessionId}`}
                    className="ml-auto shrink-0 hover:text-foreground"
                  >
                    open thread →
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}

          {loom?.acceptedAt ? (
            <p className="text-sm text-muted-foreground">Accepted {fmtAgo(loom.acceptedAt)} — this loom is done.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
