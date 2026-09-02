"use client";

/**
 * THE LOOM ROOM — master–detail, like the app's own session UI: a slim list
 * you scan, one pane that informs.
 *
 * The previous room was a single column restating the same facts at three
 * volumes (badge, subtitle, expansion). Now the LEFT RAIL is the loom's
 * population — conductor, origin, threads — one line each, in the session
 * rows' status grammar. The RIGHT PANE is the one selected thing, told
 * fully: the loom overview (gate, escalation, journal) by default, or a
 * member's contract, evidence and branch. Selection is local; entering a
 * transcript is an explicit "open" from the detail pane. The accept moat is
 * unchanged and lives in the header.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, GitBranchIcon, SparklesIcon } from "lucide-react";
import type { SessionActivity } from "@telar/engine-client";
import { PageHeader } from "@/components/common/page-header";
import { fmtAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoomStateBadge, statusHairline, ThreadStatusSlot, TierBadge } from "@/components/loom/thread-row";
import { SessionCockpit } from "@/components/session-cockpit";
import { MiniBraid } from "@/components/loom/mini-braid";

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

type Selection = "overview" | "conductor" | "origin" | { thread: string };

const CAPTION = "text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground/70";

function MemberRow({
  title,
  live,
  ghost,
  selected,
  onSelect,
  trailing,
}: {
  title: string;
  live: Liveness | null;
  ghost?: boolean;
  selected: boolean;
  onSelect: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        statusHairline(live),
        selected ? "bg-muted font-medium text-foreground" : "text-foreground/80 hover:bg-muted/60",
        ghost && "italic opacity-70",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {trailing}
      <span className="shrink-0">
        {ghost ? <span className="text-[0.6875rem] not-italic text-muted-foreground">planned</span> : <ThreadStatusSlot live={live} />}
      </span>
    </button>
  );
}

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className={cn(CAPTION, "pb-1")}>{label}</div>
      {children}
    </div>
  );
}

export function LoomRoom({ loomId }: { loomId: string }) {
  const [loom, setLoom] = useState<LoomDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>("overview");
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

  /** The human's recovery point — same lib and green-thread guard as the
   *  conductor's respawn move; the confirm names exactly what gets re-seeded. */
  const restart = useCallback(
    async (slugs?: string[]) => {
      const label = slugs ? `Restart thread "${slugs[0]}"` : "Restart every non-green thread";
      if (!window.confirm(`${label}? Dead sessions are retired and fresh ones spawn from the same plans. Green-verified threads are never touched.`)) return;
      setBusy("restart");
      try {
        const r = await fetch(`/api/looms/${loomId}/respawn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(slugs ? { threads: slugs } : {}),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `restart: ${r.status}`);
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

  /** v0 conductor trigger — see conduct route; server cooldown makes this free. */
  useEffect(() => {
    if (!loom) return;
    const quiet = loom.state === "working" && loom.threads.every((t) => !t.live || t.live.status !== "working");
    if (quiet && Date.now() - lastAutoConduct.current > 120_000) {
      lastAutoConduct.current = Date.now();
      void fetch(`/api/looms/${loomId}/conduct`, { method: "POST" }).then(() => void refresh());
    }
  }, [loom, loomId, refresh]);

  const waitingGate = loom?.phases?.find((p) => p.kind === "execute" && p.status === "waiting");
  const sortedThreads = loom
    ? [...loom.threads].sort((a, b) => {
        const rank = (t: LiveThread) => (t.live?.status === "working" ? 0 : t.live?.status === "waiting on you" ? 1 : t.sessionId ? 2 : 3);
        return rank(a) - rank(b);
      })
    : [];
  const selectedThread = typeof selection === "object" ? loom?.threads.find((t) => t.slug === selection.thread) : undefined;
  // The journal, parsed for reading: newest first, actor named once, no
  // markdown noise. The raw file stays the record; this is its digest.
  const journalEntries = (loom?.journal ?? "")
    .split("\n")
    .map((line) => /^- (\S+) \*\*(\w+)\*\*: (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ when: fmtAgo(Date.parse(m[1])), actor: m[2], text: m[3] }))
    .reverse();

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

      {loom === null ? (
        <div className="space-y-3 p-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : (
            <>
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* THE POPULATION — one line per member, nothing restated. */}
          <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border/60 p-2">
            <button
              type="button"
              onClick={() => setSelection("overview")}
              aria-pressed={selection === "overview"}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                selection === "overview" ? "bg-muted font-medium text-foreground" : "text-foreground/80 hover:bg-muted/60",
              )}
            >
              <span className="min-w-0 flex-1 truncate">Overview</span>
              {loom.attention ? <span className="size-2 shrink-0 rounded-full bg-warning" /> : null}
            </button>

            {loom.conductor || loom.origin ? (
              <div>
                <div className={cn(CAPTION, "px-2 pb-1")}>Steering</div>
                <div className="flex flex-col gap-0.5">
                  {loom.conductor ? (
                    <MemberRow
                      title="Conductor"
                      live={loom.conductor.live}
                      selected={selection === "conductor"}
                      onSelect={() => setSelection("conductor")}
                      trailing={<SparklesIcon className="size-3 shrink-0 text-verify" />}
                    />
                  ) : null}
                  {loom.origin ? (
                    <MemberRow
                      title={loom.origin.title}
                      live={loom.origin.live}
                      selected={selection === "origin"}
                      onSelect={() => setSelection("origin")}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}

            <div>
              <div className={cn(CAPTION, "px-2 pb-1")}>Threads · {loom.threads.length}</div>
              <div className="flex flex-col gap-0.5">
                {sortedThreads.map((thread) => (
                  <MemberRow
                    key={thread.slug}
                    title={thread.title}
                    live={thread.live}
                    ghost={!thread.sessionId}
                    selected={typeof selection === "object" && selection.thread === thread.slug}
                    onSelect={() => setSelection({ thread: thread.slug })}
                    trailing={
                      thread.verification ? (
                        <span className={cn("size-2 shrink-0 rounded-full", thread.verification.ok ? "bg-success" : "bg-destructive")} />
                      ) : undefined
                    }
                  />
                ))}
              </div>
            </div>

            <div className="mt-auto border-t border-border/40 pt-2">
              <div className={cn(CAPTION, "px-2 pb-1")}>History</div>
              <MiniBraid
                loomId={loomId}
                onPick={({ sessionId, threadSlug }) => {
                  if (threadSlug) setSelection({ thread: threadSlug });
                  else if (sessionId && sessionId === loom.conductorSessionId) setSelection("conductor");
                  else if (sessionId && sessionId === loom.origin?.sessionId) setSelection("origin");
                  else setSelection("overview");
                }}
              />
            </div>
          </div>

          {/* THE ONE SELECTED THING. A member with a session IS its session:
              the cockpit mounts right here, under a one-line loom strip that
              carries the contract facts — no summary page standing between
              you and the conversation. Only the overview and unspawned plans
              are summaries, because they have no session to be. */}
          {(() => {
            const memberSession =
              selection === "conductor"
                ? loom.conductor?.sessionId
                : selection === "origin"
                  ? loom.origin?.sessionId
                  : selectedThread?.sessionId;
            if (selection !== "overview" && memberSession) {
              return (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border/40 bg-muted/20 px-3 text-xs">
                    {selectedThread ? (
                      <>
                        <TierBadge {...(selectedThread.tier ? { tier: selectedThread.tier } : {})} />
                        {selectedThread.verification ? (
                          <span
                            className={cn(
                              "shrink-0 font-mono",
                              selectedThread.verification.ok ? "text-success" : "text-destructive",
                            )}
                            title={selectedThread.verification.detail}
                          >
                            {selectedThread.verification.tier} {selectedThread.verification.ok ? "green" : "red"}
                            {selectedThread.verification.commit ? ` @ ${selectedThread.verification.commit.slice(0, 7)}` : ""}
                          </span>
                        ) : null}
                        {(selectedThread.branch ?? selectedThread.live?.branch) ? (
                          <span className="flex min-w-0 shrink items-center gap-1 text-muted-foreground">
                            <GitBranchIcon className="size-3 shrink-0" />
                            <span className="truncate font-mono">{selectedThread.branch ?? selectedThread.live?.branch}</span>
                          </span>
                        ) : null}
                        {selectedThread.contract ? (
                          <span className="min-w-0 truncate text-muted-foreground" title={selectedThread.contract}>
                            <span className="text-verify">contract:</span> {selectedThread.contract}
                          </span>
                        ) : null}
                        {!selectedThread.verification?.ok && !loom.acceptedAt ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="ml-auto shrink-0"
                            title="Retire this session and spawn a fresh one from the same plan"
                            onClick={() => void restart([selectedThread.slug])}
                            disabled={busy !== null}
                          >
                            {busy === "restart" ? "Restarting…" : "Restart"}
                          </Button>
                        ) : null}
                      </>
                    ) : selection === "conductor" ? (
                      <>
                        <SparklesIcon className="size-3 shrink-0 text-verify" />
                        <span className="min-w-0 truncate text-muted-foreground">
                          steering — it proposes, the machine executes, it cannot accept. Reply here to steer.
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-auto shrink-0"
                          onClick={() => void act("conduct")}
                          disabled={busy !== null || Boolean(loom.acceptedAt)}
                        >
                          {busy === "conduct" ? "Conducting…" : "Conduct now"}
                        </Button>
                      </>
                    ) : (
                      <span className="min-w-0 truncate text-muted-foreground">
                        origin — the conversation this loom was spun from, still yours to talk in.
                      </span>
                    )}
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <SessionCockpit
                      key={memberSession}
                      projectId={loom.projectId}
                      sessionId={memberSession}
                      observe={Boolean(selectedThread)}
                    />
                  </div>
                </div>
              );
            }
            return (
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl space-y-5 px-6 py-6">
              {error ? (
                <Alert variant="destructive">
                  <AlertTitle>{error}</AlertTitle>
                </Alert>
              ) : null}

              {selection === "overview" ? (
                <>
                  {loom.attention ? (
                    /* THE ESCALATION, AS A HEADLINE — the conductor's full
                       reasoning lives in its transcript; the overview only
                       announces that it asked, in two lines at most. The
                       answer happens in the conductor's session, so the one
                       real action here is going there. */
                    <Alert>
                      <SparklesIcon className="text-warning" />
                      <AlertTitle className="text-warning">The conductor needs a decision from you</AlertTitle>
                      <AlertDescription>
                        <p className="line-clamp-2" title={loom.attention}>
                          {loom.attention}
                        </p>
                        <div className="mt-1.5 flex items-center gap-2">
                          <Button size="xs" variant="outline" onClick={() => setSelection("conductor")}>
                            Reply to the conductor
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            title="Stop flagging this — the escalation stays in the journal, and the conductor moves on"
                            onClick={() =>
                              void fetch(`/api/looms/${loomId}`, {
                                method: "PATCH",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ clearAttention: true }),
                              }).then(() => void refresh())
                            }
                          >
                            Dismiss
                          </Button>
                        </div>
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {waitingGate ? (
                    <p className="text-sm text-muted-foreground">
                      The weaver proposed {loom.threads.length} threads — plans, in the rail. Review them, then approve in the header to
                      spawn.
                    </p>
                  ) : null}

                  <DetailBlock label="Where it stands">
                    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60 text-center">
                      {[
                        { label: "working", value: loom.threads.filter((t) => t.live?.status === "working").length },
                        { label: "green", value: loom.threads.filter((t) => t.verification?.ok).length },
                        { label: "red", value: loom.threads.filter((t) => t.verification && !t.verification.ok).length },
                      ].map((stat) => (
                        <div key={stat.label} className="bg-card py-2">
                          <div className="text-sm font-semibold tabular-nums">{stat.value}</div>
                          <div className="text-[0.5625rem] uppercase tracking-wider text-muted-foreground">{stat.label}</div>
                        </div>
                      ))}
                    </div>
                  </DetailBlock>

                  {!loom.acceptedAt && loom.threads.some((t) => t.sessionId && !t.verification?.ok) ? (
                    <div>
                      <Button size="xs" variant="outline" onClick={() => void restart()} disabled={busy !== null}>
                        {busy === "restart" ? "Restarting…" : "Restart loom"}
                      </Button>
                      <span className="ml-2 text-xs text-muted-foreground">
                        re-seeds every non-green thread from its plan — green work is never touched
                      </span>
                    </div>
                  ) : null}

                  <DetailBlock label="Journal">
                    {journalEntries.length > 0 ? (
                      <ul className="max-h-[45vh] space-y-1.5 overflow-y-auto">
                        {journalEntries.map((entry, i) => (
                          <li key={i} className="flex items-baseline gap-2 text-xs">
                            <span className="w-14 shrink-0 text-right font-mono tabular-nums text-muted-foreground/60">{entry.when}</span>
                            <span
                              className={cn(
                                "w-16 shrink-0 font-mono text-[0.625rem] uppercase",
                                entry.actor === "human"
                                  ? "text-foreground"
                                  : entry.actor === "conductor"
                                    ? "text-verify"
                                    : "text-muted-foreground",
                              )}
                            >
                              {entry.actor}
                            </span>
                            <span className="min-w-0 flex-1 text-muted-foreground">{entry.text}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">Nothing decided yet.</p>
                    )}
                  </DetailBlock>

                  {loom.acceptedAt ? (
                    <p className="text-sm text-muted-foreground">Accepted {fmtAgo(loom.acceptedAt)} — this loom is done.</p>
                  ) : null}
                </>
              ) : null}

              {selectedThread && !selectedThread.sessionId ? (
                <>
                  <div className="flex items-center gap-2">
                    <h2 className="min-w-0 truncate text-base font-semibold">{selectedThread.title}</h2>
                    <TierBadge {...(selectedThread.tier ? { tier: selectedThread.tier } : {})} />
                  </div>
                  <p className="text-sm text-muted-foreground">A plan, not yet a session — approving the gate spawns it.</p>
                  <DetailBlock label="Brief">
                    <p className="text-sm text-muted-foreground">{selectedThread.brief}</p>
                  </DetailBlock>
                  {selectedThread.contract ? (
                    <DetailBlock label="Contract">
                      <p className="border-l-2 border-verify/50 pl-3 text-sm text-muted-foreground">{selectedThread.contract}</p>
                    </DetailBlock>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
