"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface LiveThread {
  sessionId: string;
  title: string;
  brief: string;
  contract?: string;
  verification?: { tier: string; ok: boolean; at: number; detail?: string };
  live: {
    status: string;
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
  title: string;
  objective: string;
  projectId: string;
  state: "working" | "verifying" | "ready" | "accepted";
  threads: LiveThread[];
  createdAt: number;
  acceptedAt?: number;
}

const STATE_STYLE: Record<LoomDetail["state"], string> = {
  working: "text-info border-info/40",
  verifying: "text-verify border-verify/40",
  ready: "text-success border-success/40",
  accepted: "text-muted-foreground border-border",
};

function ThreadDot({ thread }: { thread: LiveThread }) {
  const color = thread.verification
    ? thread.verification.ok
      ? "bg-success"
      : "bg-destructive"
    : thread.live?.status === "working"
      ? "bg-info animate-pulse"
      : "bg-muted-foreground";
  return <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
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
    async (action: "verify" | "accept", tier?: string) => {
      setBusy(action);
      try {
        const r = await fetch(`/api/looms/${loomId}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(tier ? { tier } : {}),
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

  if (loom === null) {
    return <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-muted-foreground">{error ?? "Loading…"}</div>;
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 text-foreground">
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <Link href="/looms" className="text-sm text-muted-foreground hover:text-foreground">
            ← Looms
          </Link>
          <span className={`ml-auto rounded-full border px-3 py-0.5 font-mono text-xs uppercase tracking-wide ${STATE_STYLE[loom.state]}`}>
            {loom.state}
          </span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold">{loom.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{loom.objective}</p>
      </header>

      {error ? <p className="mb-4 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="space-y-4">
        {loom.threads.map((thread) => (
          <section key={thread.sessionId} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <ThreadDot thread={thread} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-3">
                  <h2 className="truncate font-medium">{thread.title}</h2>
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                    {thread.live?.status ?? "unreachable"}
                    {thread.live && thread.live.openTasks > 0 ? ` · ${thread.live.openTasks} sub-agents` : ""}
                  </span>
                </div>

                {thread.live?.lastAct ? (
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">now: {thread.live.lastAct}</p>
                ) : null}

                {thread.contract ? (
                  <p className="mt-3 border-l-2 border-verify/50 pl-3 text-sm text-muted-foreground">
                    <span className="font-medium text-verify">Contract:</span> {thread.contract}
                  </p>
                ) : null}

                {thread.verification ? (
                  <p
                    className={`mt-3 border-l-2 pl-3 text-sm ${
                      thread.verification.ok ? "border-success/50 text-success" : "border-destructive/50 text-destructive"
                    }`}
                  >
                    {thread.verification.tier} {thread.verification.ok ? "green" : "red"} ·{" "}
                    {new Date(thread.verification.at).toLocaleTimeString()}
                    {thread.verification.detail ? (
                      <span className="mt-1 block whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                        {thread.verification.detail}
                      </span>
                    ) : null}
                  </p>
                ) : null}

                <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                  {thread.live?.branch ? <span className="font-mono">{thread.live.branch}</span> : null}
                  <Link
                    href={`/projects/${loom.projectId}/sessions/${thread.sessionId}`}
                    className="ml-auto shrink-0 hover:text-foreground"
                  >
                    open session →
                  </Link>
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>

      {loom.acceptedAt ? (
        <p className="mt-6 text-sm text-muted-foreground">Accepted {new Date(loom.acceptedAt).toLocaleString()} — this loom is done.</p>
      ) : (
        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={() => void act("verify", "unit")}
            disabled={busy !== null}
            className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-50"
          >
            {busy === "verify" ? "Verifying…" : "Verify (unit)"}
          </button>
          <button
            type="button"
            onClick={() => void act("accept")}
            disabled={busy !== null || loom.state !== "ready"}
            title={loom.state !== "ready" ? "Accept unlocks when every thread's verification is green" : undefined}
            className="rounded border border-success/50 px-3 py-1.5 text-sm text-success hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Accept
          </button>
        </div>
      )}
    </div>
  );
}
