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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { StateBadge } from "@/components/common/state-badge";
import { CharterReview, ScopingCharter } from "@/components/looms/charter-review";
import { EnvReview } from "@/components/looms/env-review";
import { LoomGodView } from "@/components/looms/god-view";
import { AgentViewDrawer } from "@/components/looms/agent-view";
import { SpecDrawer } from "@/components/looms/spec-bundle";
import { ScopingFeed, WorkstreamsPreview } from "@/components/looms/scoping-view";
import { deriveGodView, deriveThreadOperator } from "@/components/looms/godview";
import {
  fmtDuration,
  isAwaitingOwner,
  isTerminal,
  isWoven,
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
  const [threads, setThreads] = useState<Loom[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  // Drawer state — owned here, exposed for the Drawers stage:
  //   • openOperatorId → the agent-view drawer (keyed by operator id; null = closed)
  //   • specOpen       → the spec-bundle drawer
  // The god-view frame only sets these (card click, "View spec"); the drawers
  // that consume them mount at this level in the Drawers stage.
  const [openOperatorId, setOpenOperatorId] = useState<string | null>(null);
  const [specOpen, setSpecOpen] = useState(false);

  // Bumped when the owner acts on a Thread from its drawer (accept/steer/reject/
  // resume) — forces an immediate /threads refetch so the child's new state
  // shows without waiting out the 2.5s poll tick.
  const [threadRefresh, setThreadRefresh] = useState(0);

  // The open woven child's own event tail — see the second EventSource below.
  const [threadFeed, setThreadFeed] = useState<LoomEvent[]>([]);
  const [childLoom, setChildLoom] = useState<Loom | null>(null);

  const loomRef = useRef<Loom | null>(null);
  useEffect(() => {
    loomRef.current = loom;
  }, [loom]);

  // Latest threads read via a ref so the child-tail effect below can key on the
  // open operator id ALONE — without resubscribing every 2.5s poll tick.
  const threadsRef = useRef<Loom[]>(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  // Load the loom via a plain GET and then poll it. This is resilient to the
  // SSE stream being starved when a loom executes in-process (the build agent
  // hammers the same Node event loop), which otherwise left the god-view on
  // skeletons forever — the SSE was the ONLY setter of `loom`. The event
  // stream still drives the live feed; this guarantees the loom itself renders
  // and keeps current (and 404s surface the "can't open this loom" state).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/looms/${id}`);
        if (cancelled) return;
        if (res.status === 404) {
          setError("This loom doesn't exist.");
          return;
        }
        const data = (await res.json()) as { loom?: Loom };
        if (data.loom) {
          setLoom(data.loom);
          setError(null);
        }
      } catch {
        /* transient — the next poll retries */
      }
    };
    void load();
    const t = setInterval(() => {
      if (loomRef.current && isTerminal(loomRef.current.state)) {
        clearInterval(t);
        return;
      }
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
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

  // Poll the weave's child threads — the operators of a WOVEN loom. Coarser
  // than the loom/event polls because listChildLooms does a full directory
  // scan; only runs while the weave is live. A single (non-woven) loom simply
  // returns no threads, and the god-view derives its one operator from `loom`.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const fetchThreads = () => {
      fetch(`/api/looms/${id}/threads`)
        .then((res) => res.json())
        .then((data: { threads?: Loom[] }) => {
          if (!cancelled) setThreads(data.threads ?? []);
        })
        .catch(() => {
          /* transient — the next poll recovers */
        });
    };
    fetchThreads();
    const t = setInterval(() => {
      if (loomRef.current && isTerminal(loomRef.current.state)) {
        clearInterval(t);
        return;
      }
      fetchThreads();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id, threadRefresh]);

  // Second event tail: the OPEN woven child's own stream. A woven child writes
  // its per-agent events to its OWN log (/api/looms/<childId>/events), never the
  // root feed — so its drawer would otherwise read "transcript not captured
  // yet". Mirrors the root tail's buffer pattern (clear on open, push on ev,
  // capture the child Loom, close on end). Keyed on the open operator id alone
  // (threads/loom read via refs) so it only (re)subscribes when a DIFFERENT
  // child opens, and stays idle for a non-woven operator — whose transcript
  // already rides the root feed.
  useEffect(() => {
    const child = threadsRef.current.find((t) => t.id === openOperatorId);
    const isWovenChild = !!openOperatorId && isWoven(loomRef.current) && !!child;
    if (!isWovenChild) {
      setThreadFeed([]);
      setChildLoom(null);
      return;
    }
    setChildLoom(child ?? null);
    const es = new EventSource(`/api/looms/${openOperatorId}/events`);
    let ended = false;
    let buffer: LoomEvent[] = [];

    es.addEventListener("open", () => {
      buffer = [];
      setThreadFeed([]);
    });
    es.addEventListener("run", (e) => {
      setChildLoom(JSON.parse((e as MessageEvent).data) as Loom);
    });
    es.addEventListener("ev", (e) => {
      buffer.push(JSON.parse((e as MessageEvent).data) as LoomEvent);
      setThreadFeed([...buffer]);
    });
    es.addEventListener("end", (e) => {
      ended = true;
      setChildLoom(JSON.parse((e as MessageEvent).data) as Loom);
      es.close();
    });
    es.onerror = () => {
      if (ended) es.close();
    };

    return () => es.close();
  }, [openOperatorId]);

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

  // Owner acted on a Thread from its drawer — force an immediate /threads
  // refetch so the child's post-intervention state (queued/…) shows at once.
  const refreshThreads = useCallback(() => setThreadRefresh((n) => n + 1), []);

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

  // Run-accurate elapsed: anchor to the CURRENT run, not first creation. The
  // last attempt's start wins; before any attempt (queued/scoping) fall back to
  // the last state/started event, then creation. On settle, freeze against the
  // last attempt's end (the moment work stopped) rather than updatedAt.
  const lastAttempt = loom.attempts.at(-1);
  const scopingAnchor =
    [...feed].reverse().find((e) => e.type === "state" || e.type === "started")
      ?.ts ?? loom.updatedAt;
  const runStart = lastAttempt?.startedAt ?? scopingAnchor ?? loom.createdAt;
  const runEnd = settled ? (lastAttempt?.endedAt ?? loom.updatedAt) : nowTs;
  const elapsedMs = runEnd - runStart;

  // Fold live scoping spend into the header total: the weave-planner appends
  // `result` events (each with costUsd) to the feed while scoping, before any
  // attempt exists to carry that cost. Updates live via the SSE feed.
  const scopingCost = feed.reduce((sum, e) => {
    if (e.type !== "result") return sum;
    const c = (e as { costUsd?: number }).costUsd;
    return sum + (typeof c === "number" ? c : 0);
  }, 0);
  // A WOVEN root never builds itself — its `attempts` is empty and ALL spend
  // lives in the child Threads. Fold those in so the header reads the true weave
  // cost instead of $0; a single loom adds nothing (threads is empty).
  const totalCost =
    sumCost(loom.attempts) +
    scopingCost +
    (isWoven(loom) ? threads.reduce((s, t) => s + sumCost(t.attempts), 0) : 0);
  const showCancel = nonTerminal && !isAwaitingOwner(loom.state);

  // The whole running/verifying/ready/terminal surface is now ONE unified
  // god-view — a single loom is a weave of one operator, a woven loom weaves
  // its child threads. deriveGodView guards missing data (no attempts, no
  // panel, no charter, empty threads) so this never throws.
  const view = deriveGodView(loom, threads, feed);

  // When a woven child's drawer is open, prefer its live-tailed operator (with a
  // real transcript from the child's own stream) over the roster's transcript-
  // less one. Guarded on the open id so it clears cleanly the moment we close.
  const liveThreadOp =
    childLoom && childLoom.id === openOperatorId
      ? deriveThreadOperator(childLoom, threadFeed)
      : null;

  // The RAW loom behind the open operator — the root for a single loom, else the
  // polled child Thread. The 2.5s /threads poll keeps this current, so it beats
  // the live-tailed childLoom (whose EventSource ends on settle) as the source
  // the intervention panel gates on. null when nothing's open.
  const openLoom =
    openOperatorId === loom.id
      ? loom
      : (threads.find((t) => t.id === openOperatorId) ?? null);

  // Who accepted — read off the durable "accepted" event so the done
  // confirmation can name them; the server fixes this to "you" today.
  const acceptedBy =
    (feed.findLast((e) => e.type === "accepted")?.by as string | undefined) ??
    undefined;

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
          <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-8">
            <ScopingCharter />
            <WorkstreamsPreview loomId={loom.id} />
            <ScopingFeed events={feed} />
          </div>
        ) : loom.state === "charter-review" ? (
          <CharterReview loom={loom} />
        ) : loom.state === "env-review" ? (
          <EnvReview loom={loom} />
        ) : (
          <>
            {/* The unified god-view frame. The owner's intervention panel
                (accept/steer/reject) lives inside it, in the right rail. */}
            <LoomGodView
              view={view}
              loom={loom}
              threads={threads}
              onOpenOperator={setOpenOperatorId}
              onViewSpec={() => setSpecOpen(true)}
              onIntervened={(l) => setLoom(l)}
              acceptedBy={acceptedBy}
            />
            {/* Non-invasive overlay drawers — the agent view slides in over a
                scrim; the spec drawer is separate. */}
            <AgentViewDrawer
              operator={
                liveThreadOp ??
                view.operators.find((o) => o.id === openOperatorId) ??
                null
              }
              loom={openLoom}
              onIntervened={refreshThreads}
              onClose={() => setOpenOperatorId(null)}
            />
            <SpecDrawer loomId={loom.id} open={specOpen} onClose={() => setSpecOpen(false)} />
          </>
        )}
      </div>
    </div>
  );
}
