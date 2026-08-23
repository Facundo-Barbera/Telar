"use client";

/**
 * THE BOARD — the looms place's lobby, wearing the app's own chrome.
 *
 * Composed ENTIRELY from the shared vocabulary: `PageHeader` introduces the
 * surface the way every top-level surface introduces itself, looms are
 * `Card`s, states are `Badge`s, threads speak the session rows' status
 * language (components/loom/thread-row.tsx), emptiness is `EmptyState`,
 * loading is `Skeleton`, failure is `Alert`. Nothing here is hand-rolled —
 * the idiom test pins that.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MessageSquareIcon, WorkflowIcon } from "lucide-react";
import type { SessionActivity } from "@telar/engine-client";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoomStateBadge, ThreadStatusSlot, TierBadge, VerificationBadge } from "@/components/loom/thread-row";

interface ThreadView {
  sessionId: string;
  slug?: string;
  title: string;
  tier?: string;
  branch?: string;
  verification?: { tier: string; ok: boolean; commit?: string };
  session?: { status?: string; activity?: SessionActivity; activityAt?: number | null; updatedAt?: number } | null;
}

interface LoomView {
  id: string;
  slug?: string;
  title: string;
  objective: string;
  projectId: string;
  state: "working" | "idle" | "verifying" | "ready" | "accepted";
  threads: ThreadView[];
  acceptedAt?: number;
}

export function LoomsBoard() {
  const [looms, setLooms] = useState<LoomView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/looms");
      if (!r.ok) throw new Error(`looms: ${r.status}`);
      setLooms((await r.json()).looms);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  const open = looms?.filter((loom) => loom.state !== "accepted") ?? [];
  const accepted = looms?.filter((loom) => loom.state === "accepted") ?? [];
  const ready = open.filter((loom) => loom.state === "ready").length;

  const card = (loom: LoomView) => (
    <Link key={loom.id} href={`/looms/${loom.id}`} className="block outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card size="sm" className="transition-colors hover:ring-foreground/20">
        <CardHeader>
          <CardTitle className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{loom.title}</span>
            {loom.slug ? <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">loom/{loom.slug}</span> : null}
          </CardTitle>
          <CardDescription className="truncate">{loom.objective}</CardDescription>
          <CardAction>
            <LoomStateBadge state={loom.state} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5">
            {loom.threads.map((thread) => (
              <li key={thread.sessionId} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 truncate text-foreground/90">{thread.title}</span>
                <TierBadge {...(thread.tier ? { tier: thread.tier } : {})} />
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <VerificationBadge {...(thread.verification ? { verification: thread.verification } : {})} />
                  <ThreadStatusSlot live={thread.session ?? null} />
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </Link>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <WorkflowIcon className="size-4 shrink-0" />
            Looms
          </span>
        }
        description={
          looms === null
            ? "Conversation → threads → verification → a human accepts."
            : `${looms.length} loom${looms.length === 1 ? "" : "s"}${ready > 0 ? ` · ${ready} ready to accept` : ""}`
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-3 px-6 py-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}

          {looms === null ? (
            <>
              <Skeleton className="h-28 w-full rounded-xl" />
              <Skeleton className="h-28 w-full rounded-xl" />
            </>
          ) : null}

          {looms?.length === 0 ? (
            <EmptyState
              icon={MessageSquareIcon}
              title="Nothing on the loom"
              description="A loom is born from a conversation: open a session, talk the work through, and press “Spin into loom” in its header."
              action={
                <Button variant="outline" render={<Link href="/" />}>
                  Go to your sessions
                </Button>
              }
            />
          ) : null}

          {open.map(card)}

          {accepted.length > 0 ? (
            <>
              <h2 className="pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Accepted</h2>
              <div className="space-y-3 opacity-70">{accepted.map(card)}</div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
