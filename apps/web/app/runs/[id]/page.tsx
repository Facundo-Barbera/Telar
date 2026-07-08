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
import type { Run, RunEvent } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { StateBadge } from "@/components/common/state-badge";
import { AttemptCard } from "@/components/runs/attempt-card";
import { LiveFeed } from "@/components/runs/live-feed";
import { fmtDuration, isActive, isTerminal, sumCost } from "@/components/runs/utils";
import { fmtCost } from "@/lib/format";

function BackLink() {
  return (
    <Link
      href="/runs"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="Back to runs"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [run, setRun] = useState<Run | null>(null);
  const [feed, setFeed] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  const runRef = useRef<Run | null>(null);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // A missing/deleted run id never errors the SSE stream (the route stays open,
  // polling for a dir that will never appear), so probe the run endpoint — which
  // 404s for unknown ids — to surface the "can't open this run" state.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/runs/${id}`)
      .then((res) => {
        if (cancelled) return;
        if (res.status === 404) setError("This run doesn't exist.");
      })
      .catch(() => {
        /* transient — the event stream still governs the live view */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Subscribe to the run's event stream. On "end" (terminal + drained) close the
  // EventSource — otherwise it silently auto-reconnects to a finished run.
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/runs/${id}/events`);
    let ended = false;
    // The route replays every event from line 0 on each (re)connection, so rebuild
    // the feed from a per-connection buffer — clearing it on every `open` (fired
    // on the initial connect and each auto-reconnect) keeps drops from duplicating.
    let buffer: RunEvent[] = [];

    es.addEventListener("open", () => {
      buffer = [];
      setFeed([]);
    });
    es.addEventListener("run", (e) => {
      setRun(JSON.parse((e as MessageEvent).data) as Run);
      setError(null);
    });
    es.addEventListener("ev", (e) => {
      buffer.push(JSON.parse((e as MessageEvent).data) as RunEvent);
      setFeed([...buffer]);
    });
    es.addEventListener("end", (e) => {
      ended = true;
      setRun(JSON.parse((e as MessageEvent).data) as Run);
      es.close();
    });
    es.onerror = () => {
      const r = runRef.current;
      if (ended || (r && isTerminal(r.state))) es.close();
    };

    return () => es.close();
  }, [id]);

  // Tick the elapsed clock while the run is live.
  useEffect(() => {
    if (!run || isTerminal(run.state)) return;
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
      window.dispatchEvent(new Event("telar:refresh"));
    } catch {
      /* ignore — the stream will reflect the real state */
    } finally {
      setCancelling(false);
    }
  }, [id]);

  if (error && !run) {
    return (
      <div className="flex h-dvh flex-col">
        <PageHeader title="Run" leading={<BackLink />} />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <TriangleAlertIcon className="size-6 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Can&apos;t open this run</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" render={<Link href="/runs" />}>
              Back to runs
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!run) {
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

  const nonTerminal = !isTerminal(run.state);
  const elapsedMs = nonTerminal
    ? nowTs - run.createdAt
    : run.updatedAt - run.createdAt;
  const totalCost = sumCost(run.attempts);
  const preparing = run.attempts.length === 0 && isActive(run.state);

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        className="flex-wrap"
        leading={<BackLink />}
        title={run.title}
        description={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="max-w-[220px]">
              <span className="truncate">{run.project}</span>
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {run.kind}
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {run.account}
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
            <StateBadge state={run.state} />
            {nonTerminal && (
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
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="flex flex-col gap-3">
            <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Attempts
            </h2>
            {run.error && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                  run.state === "failed"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-300",
                )}
              >
                <TriangleAlertIcon className="mt-px size-4 shrink-0" />
                <span className="leading-snug">{run.error}</span>
              </div>
            )}
            {run.attempts.length === 0 ? (
              preparing ? (
                <Card size="sm">
                  <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2Icon className="size-4 animate-spin" />
                    Preparing the first attempt…
                  </CardContent>
                </Card>
              ) : (
                <p className="px-1 text-sm text-muted-foreground">
                  {run.state === "queued"
                    ? "Queued — waiting to start."
                    : "No attempts recorded."}
                </p>
              )
            ) : (
              run.attempts.map((attempt) => (
                <AttemptCard key={attempt.n} attempt={attempt} />
              ))
            )}
          </section>

          <section className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
            <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Live feed
            </h2>
            <Card size="sm" className="min-w-0">
              <CardContent className="min-w-0">
                <LiveFeed events={feed} state={run.state} />
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
