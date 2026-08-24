"use client";

/**
 * THE LOOM ROOM — one loom told in loom language, wearing the app's chrome.
 *
 * v2: the room renders the loom DOCUMENT — the same spec + journal the
 * episodic conductor reboots from. A waiting loom shows its open gate
 * (Approve/Discard for the execute gate); a running one shows live threads,
 * the conductor's decisions, and its escalations. The accept moat is
 * unchanged: Accept refuses until every thread has a loom-run green.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, GitBranchIcon, SparklesIcon } from "lucide-react";
import type { SessionActivity } from "@telar/engine-client";
import { PageHeader } from "@/components/common/page-header";
import { fmtAgo } from "@/lib/format";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoomStateBadge, statusHairline, ThreadStatusSlot, TierBadge } from "@/components/loom/thread-row";

interface LiveThread {
  sessionId?: string;
  slug: string;
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
  method?: string;
  conductorSessionId?: string;
  state: "waiting" | "working" | "idle" | "verifying" | "ready" | "accepted";
  phases?: Array<{ id: string; kind: string; gate: string; status: string }>;
  threads: LiveThread[];
  origin: { sessionId: string; title: string } | null;
  attention?: string;
  journal?: string;
  createdAt: number;
  acceptedAt?: number;
}

export function LoomRoom({ loomId }: { loomId: string }) {
  const [loom, setLoom] = useState<LoomDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastAutoConduct = useRef(0);

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
    async (action: "verify" | "accept" | "approve" | "conduct") => {
      setBusy(action);
      try {
        const r = await fetch(`/api/looms/${loomId}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!r.ok && r.status !== 202) {
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

  const discard = useCallback(async () => {
    setBusy("discard");
    try {
      const r = await fetch(`/api/looms/${loomId}`, { method: "DELETE" });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `discard: ${r.status}`);
      }
      window.location.href = "/looms";
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }, [loomId]);

  /**
   * THE v0 CONDUCTOR TRIGGER: the room's own poll wakes an episode when the
   * loom is running with nothing visibly moving. Client-initiated is honest
   * about what it is — an engine-event trigger replaces it when the
   * dispatcher lands. Server-side cooldown makes over-calling free.
   */
  useEffect(() => {
    if (!loom) return;
    const quiet = loom.state === "working" && loom.threads.every((t) => !t.live || t.live.status !== "working");
    if (quiet && Date.now() - lastAutoConduct.current > 120_000) {
      lastAutoConduct.current = Date.now();
      void fetch(`/api/looms/${loomId}/conduct`, { method: "POST" }).then(() => void refresh());
    }
  }, [loom, loomId, refresh]);

  const waitingGate = loom?.phases?.find((p) => p.kind === "execute" && p.status === "waiting");

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
            waitingGate ? (
              <>
                <Button size="sm" onClick={() => void act("approve")} disabled={busy !== null}>
                  {busy === "approve" ? "Spawning threads…" : "Approve — spawn the threads"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void discard()} disabled={busy !== null}>
                  Discard
                </Button>
              </>
            ) : (
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
            )
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

          {loom?.attention ? (
            <Alert>
              <SparklesIcon />
              <AlertTitle className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-warning">Conductor: {loom.attention}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void fetch(`/api/looms/${loomId}`, {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ clearAttention: true }),
                    }).then(() => void refresh())
                  }
                >
                  Seen
                </Button>
              </AlertTitle>
            </Alert>
          ) : null}

          {loom === null ? (
            <>
              <Skeleton className="h-32 w-full rounded-xl" />
              <Skeleton className="h-32 w-full rounded-xl" />
            </>
          ) : null}

          {waitingGate ? (
            <p className="text-sm text-muted-foreground">
              The weaver proposed {loom?.threads.length} threads. Nothing is running — review the plans below and clear the gate.
            </p>
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
            <Card key={thread.slug} size="sm" className={`relative overflow-visible ${statusHairline(thread.live)}`}>
              <CardHeader>
                <CardTitle className="flex min-w-0 items-center gap-2">
                  {thread.sessionId ? (
                    <Link href={`/looms/${loom.id}/threads/${thread.sessionId}`} className="truncate hover:underline">
                      {thread.title}
                    </Link>
                  ) : (
                    <span className="truncate">{thread.title}</span>
                  )}
                  <TierBadge {...(thread.tier ? { tier: thread.tier } : {})} />
                </CardTitle>
                <CardAction>
                  {thread.sessionId ? (
                    <ThreadStatusSlot live={thread.live} />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">planned</span>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                {!thread.sessionId ? <p className="text-sm text-muted-foreground">{thread.brief}</p> : null}

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

                {thread.sessionId ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {(thread.branch ?? thread.live?.branch) ? (
                      <>
                        <GitBranchIcon className="size-3 shrink-0" />
                        <span className="min-w-0 truncate font-mono">{thread.branch ?? thread.live?.branch}</span>
                      </>
                    ) : null}
                    <Link href={`/looms/${loom.id}/threads/${thread.sessionId}`} className="ml-auto shrink-0 hover:text-foreground">
                      open thread →
                    </Link>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}

          {loom && !waitingGate && loom.journal !== undefined ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  Conductor journal
                </CardTitle>
                <CardAction className="flex items-center gap-1">
                  {loom.conductorSessionId ? (
                    <Button size="xs" variant="ghost" render={<Link href={`/looms/${loom.id}/threads/${loom.conductorSessionId}`} />}>
                      open session →
                    </Button>
                  ) : null}
                  <Button size="xs" variant="ghost" onClick={() => void act("conduct")} disabled={busy !== null || Boolean(loom.acceptedAt)}>
                    {busy === "conduct" ? "Conducting…" : "Conduct now"}
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                {loom.journal ? (
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{loom.journal}</pre>
                ) : (
                  <p className="text-xs text-muted-foreground">No entries yet — the conductor wakes when the loom goes quiet.</p>
                )}
                {loom.conductorSessionId ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    The journal is the record; the session is the reasoning. Reply in the session to steer — the next episode reads it.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {loom?.acceptedAt ? (
            <p className="text-sm text-muted-foreground">Accepted {fmtAgo(loom.acceptedAt)} — this loom is done.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
