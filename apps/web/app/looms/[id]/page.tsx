"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeftIcon,
  BanIcon,
  ClockIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Loom, LoomEvent } from "@telar/core";
import { isWoven } from "@/components/looms/utils";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { StateBadge } from "@/components/common/state-badge";
import { AttemptCard } from "@/components/looms/attempt-card";
import { LiveFeed } from "@/components/looms/live-feed";
import { WeaveGodView } from "@/components/looms/weave-god-view";
import { CharterReview, ScopingCharter } from "@/components/looms/charter-review";
import { SpecBundle } from "@/components/looms/spec-bundle";
import { AcceptancePanel } from "@/components/looms/acceptance-panel";
import {
  fmtDuration,
  isActive,
  isAwaitingOwner,
  isTerminal,
  sumCost,
} from "@/components/looms/utils";
import { fmtCost } from "@/lib/format";

function BackLink() {
  return (
    <Link
      href="/looms"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="Back to looms"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

export default function LoomDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [loom, setLoom] = useState<Loom | null>(null);
  const [feed, setFeed] = useState<LoomEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  const loomRef = useRef<Loom | null>(null);
  useEffect(() => {
    loomRef.current = loom;
  }, [loom]);

  // A missing/deleted loom id never errors the SSE stream (the route stays open,
  // polling for a dir that will never appear), so probe the loom endpoint — which
  // 404s for unknown ids — to surface the "can't open this loom" state.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/looms/${id}`)
      .then((res) => {
        if (cancelled) return;
        if (res.status === 404) setError("This loom doesn't exist.");
      })
      .catch(() => {
        /* transient — the event stream still governs the live view */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Subscribe to the loom's event stream. On "end" (terminal + drained) close the
  // EventSource — otherwise it silently auto-reconnects to a finished loom.
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/looms/${id}/events`);
    let ended = false;
    // The route replays every event from line 0 on each (re)connection, so rebuild
    // the feed from a per-connection buffer — clearing it on every `open` (fired
    // on the initial connect and each auto-reconnect) keeps drops from duplicating.
    let buffer: LoomEvent[] = [];

    es.addEventListener("open", () => {
      buffer = [];
      setFeed([]);
    });
    es.addEventListener("run", (e) => {
      setLoom(JSON.parse((e as MessageEvent).data) as Loom);
      setError(null);
    });
    es.addEventListener("ev", (e) => {
      buffer.push(JSON.parse((e as MessageEvent).data) as LoomEvent);
      setFeed([...buffer]);
    });
    es.addEventListener("end", (e) => {
      ended = true;
      setLoom(JSON.parse((e as MessageEvent).data) as Loom);
      es.close();
    });
    es.onerror = () => {
      const r = loomRef.current;
      if (ended || (r && isTerminal(r.state))) es.close();
    };

    return () => es.close();
  }, [id]);

  // Tick the elapsed clock while the loom is live. Settled looms (terminal or
  // awaiting the owner) freeze the displayed elapsed, so ticking is wasted work.
  useEffect(() => {
    if (!loom || isTerminal(loom.state) || isAwaitingOwner(loom.state)) return;
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [loom]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await fetch(`/api/looms/${id}/cancel`, { method: "POST" });
      window.dispatchEvent(new Event("telar:refresh"));
    } catch {
      /* ignore — the stream will reflect the real state */
    } finally {
      setCancelling(false);
    }
  }, [id]);

  if (error && !loom) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader title="Loom" leading={<BackLink />} />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <TriangleAlertIcon className="size-6 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Can&apos;t open this loom</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" render={<Link href="/looms" />}>
              Back to looms
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!loom) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader
          leading={<BackLink />}
          title={<Skeleton className="h-5 w-48" />}
          actions={<Skeleton className="h-5 w-20 rounded-full" />}
        />
        <div className="mx-auto w-full max-w-5xl space-y-3 p-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const nonTerminal = !isTerminal(loom.state);
  const settled = isTerminal(loom.state) || isAwaitingOwner(loom.state);
  const elapsedMs = settled
    ? loom.updatedAt - loom.createdAt
    : nowTs - loom.createdAt;
  const totalCost = sumCost(loom.attempts);
  const preparing = loom.attempts.length === 0 && isActive(loom.state);
  const showCancel = nonTerminal && !isAwaitingOwner(loom.state);

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        className="flex-wrap"
        leading={<BackLink />}
        title={loom.title}
        description={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="max-w-[220px]">
              <span className="truncate">{loom.project}</span>
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {loom.kind}
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {loom.account}
            </Badge>
          </div>
        }
        actions={
          <>
            <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <ClockIcon className="size-3.5" />
              {fmtDuration(elapsedMs)}
            </div>
            <Badge variant="outline" className="font-mono text-xs">
              {fmtCost(totalCost)}
            </Badge>
            <StateBadge state={loom.state} />
            {showCancel && (
              <Button
                variant="outline"
                size="sm"
                onClick={cancel}
                disabled={cancelling}
              >
                {cancelling ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <BanIcon />
                )}
                Cancel
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        {loom.state === "scoping" ? (
          <ScopingCharter />
        ) : loom.state === "charter-review" ? (
          <CharterReview loom={loom} />
        ) : (
          <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-4">
            {loom.state === "ready" && (
              <AcceptancePanel loom={loom} onAccepted={(l) => setLoom(l)} />
            )}
            <SpecBundle loomId={loom.id} />
            {isWoven(loom) ? (
              <WeaveGodView loom={loom} feed={feed} />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <section className="flex flex-col gap-3">
                  <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Attempts
                  </h2>
                  {loom.error && (
                    <div
                      className={cn(
                        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                        loom.state === "failed"
                          ? "border-destructive/30 bg-destructive/10 text-destructive"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-300",
                      )}
                    >
                      <TriangleAlertIcon className="mt-px size-4 shrink-0" />
                      <span className="leading-snug">{loom.error}</span>
                    </div>
                  )}
                  {loom.attempts.length === 0 ? (
                    preparing ? (
                      <Card size="sm">
                        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2Icon className="size-4 animate-spin" />
                          Preparing the first attempt…
                        </CardContent>
                      </Card>
                    ) : (
                      <p className="px-1 text-sm text-muted-foreground">
                        {loom.state === "queued"
                          ? "Queued — waiting to start."
                          : "No attempts recorded."}
                      </p>
                    )
                  ) : (
                    loom.attempts.map((attempt) => (
                      <AttemptCard key={attempt.n} attempt={attempt} loomId={loom.id} />
                    ))
                  )}
                </section>

                <section className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
                  <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Live feed
                  </h2>
                  <Card size="sm" className="min-w-0">
                    <CardContent className="min-w-0">
                      <LiveFeed events={feed} state={loom.state} />
                    </CardContent>
                  </Card>
                </section>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
