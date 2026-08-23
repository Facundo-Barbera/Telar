"use client";

/**
 * THE BOARD — the looms place's lobby. An overview and nothing else: every
 * loom as a card whose thread rows tell you at a glance what is running, what
 * is verified, and what is stuck. Creation moved to its own room (/looms/new),
 * so the rail's two entries stopped being two links to the same page.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface ThreadView {
  sessionId: string;
  slug?: string;
  title: string;
  tier?: string;
  branch?: string;
  verification?: { tier: string; ok: boolean };
  session?: { status?: string } | null;
}

interface LoomView {
  id: string;
  slug?: string;
  title: string;
  objective: string;
  projectId: string;
  state: "working" | "verifying" | "ready" | "accepted";
  threads: ThreadView[];
  acceptedAt?: number;
}

const STATE_STYLE: Record<LoomView["state"], string> = {
  working: "text-info border-info/40",
  verifying: "text-verify border-verify/40",
  ready: "text-success border-success/40",
  accepted: "text-muted-foreground border-border",
};

function threadDot(thread: ThreadView): string {
  if (thread.verification) return thread.verification.ok ? "bg-success" : "bg-destructive";
  if (thread.session?.status === "working") return "bg-info animate-pulse";
  return "bg-muted-foreground/50";
}

function threadStatus(thread: ThreadView): string {
  if (thread.verification) return thread.verification.ok ? `${thread.verification.tier} green` : `${thread.verification.tier} red`;
  return thread.session?.status ?? "unreachable";
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

  const card = (loom: LoomView) => (
    <Link
      key={loom.id}
      href={`/looms/${loom.id}`}
      className="block rounded-lg border border-border bg-card p-4 hover:border-muted-foreground/40"
    >
      <div className="flex items-center gap-4">
        <div className="min-w-0">
          <h2 className="truncate font-medium">
            {loom.title}
            {loom.slug ? <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">loom/{loom.slug}</span> : null}
          </h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{loom.objective}</p>
        </div>
        <span
          className={`ml-auto shrink-0 rounded-full border px-3 py-0.5 font-mono text-xs uppercase tracking-wide ${STATE_STYLE[loom.state]}`}
        >
          {loom.state}
        </span>
      </div>
      {/* The thread rows ARE the overview: one line per thread, its dot, its
          name, its tier, its live status. Bare dots said "four of something";
          these say what. */}
      <ul className="mt-3 space-y-1">
        {loom.threads.map((thread) => (
          <li key={thread.sessionId} className="flex items-center gap-2 text-xs">
            <span className={`h-2 w-2 shrink-0 rounded-full ${threadDot(thread)}`} />
            <span className="min-w-0 truncate text-foreground/90">{thread.title}</span>
            {thread.tier ? (
              <span className="shrink-0 rounded border border-verify/40 px-1 py-px font-mono text-[9px] uppercase text-verify">
                {thread.tier}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 font-mono text-muted-foreground">{threadStatus(thread)}</span>
          </li>
        ))}
      </ul>
    </Link>
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 text-foreground">
      <header className="mb-6 flex items-start gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Looms</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Born from a conversation, detached into their own home. Verification runs on a clean checkout; only a human accepts.
          </p>
        </div>
        <Link
          href="/looms/new"
          className="ml-auto shrink-0 rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          New loom
        </Link>
      </header>

      {error ? <p className="mb-4 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      {looms === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {looms?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No looms yet. Open a session, talk the work through, and press “Spin into loom” — or start from an objective with New loom.
        </p>
      ) : null}

      <div className="space-y-3">{open.map(card)}</div>

      {accepted.length > 0 ? (
        <>
          <h2 className="mb-2 mt-8 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Accepted</h2>
          <div className="space-y-3 opacity-70">{accepted.map(card)}</div>
        </>
      ) : null}
    </div>
  );
}
