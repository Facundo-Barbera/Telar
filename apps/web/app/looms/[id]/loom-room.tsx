"use client";

/**
 * THE LOOM ROOM — the loom's header facts up top, and below them a ROSTER,
 * not furniture.
 *
 * A loom is a POPULATION of sessions: an origin sometimes, a conductor that
 * materialises mid-life, threads that appear when a gate clears, more later
 * when re-seeds land, replacements when the conductor reincarnates. The old
 * room drew four permanent cards as if the page had thread slots; this one
 * draws whoever is alive right now as rows in the session-list idiom the
 * sidebar already taught — rows appear, expand for their contract and
 * evidence, and leave. A planned thread is visibly a ghost until approval
 * makes it real. The accept moat is unchanged.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ChevronRightIcon, GitBranchIcon, NetworkIcon, SparklesIcon } from "lucide-react";
import type { SessionActivity } from "@telar/engine-client";
import { PageHeader } from "@/components/common/page-header";
import { fmtAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoomStateBadge, statusHairline, ThreadStatusSlot, TierBadge } from "@/components/loom/thread-row";

interface Liveness {
  status: string;
  activity?: SessionActivity;
  activityAt?: number | null;
  updatedAt?: number;
  title?: string;
  worktree: string | null;
  branch: string | null;
  lastAct: string | null;
  lastActAt: number | null;
  openTasks: number;
  itemCount: number;
}

interface LiveThread {
  sessionId?: string;
  slug: string;
  title: string;
  brief: string;
  contract?: string;
  tier?: string;
  branch?: string;
  verification?: { tier: string; ok: boolean; at: number; detail?: string; commit?: string };
  live: Liveness | null;
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
  origin: { sessionId: string; title: string; live: Liveness | null } | null;
  conductor: { sessionId: string; live: Liveness | null } | null;
  attention?: string;
  journal?: string;
  createdAt: number;
  acceptedAt?: number;
}

const CAPTION = "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

/**
 * One inhabitant of the loom, one row. The session-list grammar: status
 * hairline on the leading edge, title carries the line, activity badge in the
 * timestamp slot, detail one click away — never permanently occupying the
 * column.
 */
function RosterRow({
  href,
  title,
  live,
  ghost,
  badges,
  subtitle,
  expanded,
  onToggle,
  children,
}: {
  href?: string;
  title: string;
  live: Liveness | null;
  /** A planned member: visible, clearly not yet real. */
  ghost?: boolean;
  badges?: React.ReactNode;
  subtitle?: string | null;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("relative", statusHairline(live), ghost && "opacity-70")}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/40" aria-expanded={expanded}>
        <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("min-w-0 truncate text-sm font-medium", ghost && "italic")}>{title}</span>
            {badges}
            <span className="ml-auto shrink-0">
              {ghost ? <span className="text-[11px] text-muted-foreground">planned</span> : <ThreadStatusSlot live={live} />}
            </span>
          </span>
          {subtitle ? <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{subtitle}</span> : null}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border/40 bg-muted/20 px-9 py-3 text-sm">
          {children}
          {href ? (
            <div className="flex">
              <Link href={href} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
                open session →
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LoomRoom({ loomId }: { loomId: string }) {
  const [loom, setLoom] = useState<LoomDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
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
  const toggle = (key: string) => setExpanded((current) => (current === key ? null : key));

  // The living first: a roster is an inbox, not an org chart.
  const sortedThreads = loom
    ? [...loom.threads].sort((a, b) => {
        const rank = (t: LiveThread) => (t.live?.status === "working" ? 0 : t.live?.status === "waiting on you" ? 1 : t.sessionId ? 2 : 3);
        return rank(a) - rank(b);
      })
    : [];

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
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Causality graph" title="Causality graph" render={<Link href={`/looms/${loomId}/graph`} />}>
              <NetworkIcon />
            </Button>
            {loom && !loom.acceptedAt ? (
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
            ) : null}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
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
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </>
          ) : null}

          {waitingGate ? (
            <p className="text-sm text-muted-foreground">
              The weaver proposed {loom?.threads.length} threads. Nothing is running — the rows below are plans until you clear the gate.
            </p>
          ) : null}

          {/* THE ROSTER: whoever is alive in this loom right now. Rows appear
              when the population grows; nothing here is layout. */}
          {loom ? (
            <div className="space-y-4">
              {loom.conductor || loom.origin ? (
                <div>
                  <div className={cn(CAPTION, "px-1 pb-1.5")}>Steering</div>
                  <div className="divide-y divide-border/40 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
                    {loom.conductor ? (
                      <RosterRow
                        title="Conductor"
                        live={loom.conductor.live}
                        badges={<SparklesIcon className="size-3 shrink-0 text-verify" />}
                        subtitle={loom.conductor.live?.lastAct ? `now: ${loom.conductor.live.lastAct}` : null}
                        expanded={expanded === "conductor"}
                        onToggle={() => toggle("conductor")}
                        href={`/looms/${loom.id}/threads/${loom.conductor.sessionId}`}
                      >
                        <p className="text-xs text-muted-foreground">
                          The agent that steers this loom. Reply in its session to steer it — the next episode reads what you say.
                        </p>
                      </RosterRow>
                    ) : null}
                    {loom.origin ? (
                      <RosterRow
                        title={loom.origin.title}
                        live={loom.origin.live}
                        subtitle="origin — the conversation this loom was spun from"
                        expanded={expanded === "origin"}
                        onToggle={() => toggle("origin")}
                        href={`/looms/${loom.id}/threads/${loom.origin.sessionId}`}
                      >
                        <p className="text-xs text-muted-foreground">It lives here now — detached from the ordinary sessions surface.</p>
                      </RosterRow>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div>
                <div className={cn(CAPTION, "px-1 pb-1.5")}>
                  Threads
                  <span className="ml-1.5 font-mono text-muted-foreground/60">{loom.threads.length}</span>
                </div>
                <div className="divide-y divide-border/40 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
                  {sortedThreads.map((thread) => (
                    <RosterRow
                      key={thread.slug}
                      title={thread.title}
                      live={thread.live}
                      ghost={!thread.sessionId}
                      badges={<TierBadge {...(thread.tier ? { tier: thread.tier } : {})} />}
                      subtitle={
                        thread.live?.lastAct
                          ? `now: ${thread.live.lastAct}`
                          : thread.verification
                            ? `${thread.verification.tier} ${thread.verification.ok ? "green" : "red"} · ${fmtAgo(thread.verification.at)}`
                            : null
                      }
                      expanded={expanded === thread.slug}
                      onToggle={() => toggle(thread.slug)}
                      {...(thread.sessionId ? { href: `/looms/${loom.id}/threads/${thread.sessionId}` } : {})}
                    >
                      <p className="text-sm text-muted-foreground">{thread.brief}</p>
                      {thread.contract ? (
                        <p className="border-l-2 border-verify/50 pl-3 text-sm text-muted-foreground">
                          <span className="font-medium text-verify">Contract:</span> {thread.contract}
                        </p>
                      ) : null}
                      {thread.verification ? (
                        <div
                          className={cn(
                            "border-l-2 pl-3 text-sm",
                            thread.verification.ok ? "border-success/50 text-success" : "border-destructive/50 text-destructive",
                          )}
                        >
                          {thread.verification.tier} {thread.verification.ok ? "green" : "red"} · clean checkout
                          {thread.verification.commit ? ` of ${thread.verification.commit.slice(0, 7)}` : ""}
                          {thread.verification.detail ? (
                            <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{thread.verification.detail}</p>
                          ) : null}
                        </div>
                      ) : null}
                      {(thread.branch ?? thread.live?.branch) ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <GitBranchIcon className="size-3 shrink-0" />
                          <span className="min-w-0 truncate font-mono">{thread.branch ?? thread.live?.branch}</span>
                        </p>
                      ) : null}
                    </RosterRow>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {loom && !waitingGate && loom.journal !== undefined ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  Conductor journal
                </CardTitle>
                <CardAction>
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
