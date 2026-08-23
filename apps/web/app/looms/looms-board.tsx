"use client";

import { useCallback, useEffect, useState } from "react";

interface ThreadView {
  sessionId: string;
  title: string;
  brief: string;
  verification?: { tier: string; ok: boolean; at: number; detail?: string };
  session?: { status?: string; title?: string } | null;
}

interface LoomView {
  id: string;
  title: string;
  objective: string;
  projectId: string;
  state: "working" | "verifying" | "ready" | "accepted";
  threads: ThreadView[];
  createdAt: number;
  acceptedAt?: number;
}

const STATE_STYLE: Record<LoomView["state"], string> = {
  working: "text-info border-info/40",
  verifying: "text-verify border-verify/40",
  ready: "text-success border-success/40",
  accepted: "text-muted-foreground border-border",
};

export function LoomsBoard() {
  const [looms, setLooms] = useState<LoomView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
    const poll = setInterval(() => void refresh(), 8000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  const act = useCallback(
    async (loomId: string, action: "verify" | "accept", tier?: string) => {
      setBusy(`${loomId}:${action}`);
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
    [refresh],
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 text-foreground">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Looms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Objective → threads in their own worktrees → verification through the environment pool → a human accepts.
          There is no accept an agent can call.
        </p>
      </header>

      {error ? <p className="mb-4 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {looms === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {looms?.length === 0 ? <p className="text-sm text-muted-foreground">No looms yet. Create one from the API or adopt running sessions.</p> : null}

      <div className="space-y-6">
        {looms?.map((loom) => (
          <section key={loom.id} className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-medium">{loom.title}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{loom.objective}</p>
              </div>
              <span className={`shrink-0 rounded-full border px-3 py-0.5 font-mono text-xs uppercase tracking-wide ${STATE_STYLE[loom.state]}`}>
                {loom.state}
              </span>
            </div>

            <ul className="mt-4 space-y-2">
              {loom.threads.map((thread) => (
                <li key={thread.sessionId} className="flex items-center gap-3 rounded border border-border bg-background px-3 py-2 text-sm">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      thread.verification ? (thread.verification.ok ? "bg-success" : "bg-destructive") : "bg-info"
                    }`}
                  />
                  <span className="truncate">{thread.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                    {thread.verification
                      ? `${thread.verification.tier} ${thread.verification.ok ? "green" : "red"}`
                      : (thread.session?.status ?? "…")}
                  </span>
                </li>
              ))}
            </ul>

            {loom.acceptedAt ? (
              <p className="mt-4 text-xs text-muted-foreground">accepted {new Date(loom.acceptedAt).toLocaleString()}</p>
            ) : (
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => void act(loom.id, "verify", "unit")}
                  disabled={busy !== null}
                  className="rounded border border-border px-3 py-1 text-sm text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {busy === `${loom.id}:verify` ? "Verifying…" : "Verify (unit)"}
                </button>
                <button
                  type="button"
                  onClick={() => void act(loom.id, "accept")}
                  disabled={busy !== null || loom.state !== "ready"}
                  title={loom.state !== "ready" ? "Accept unlocks when every thread's verification is green" : undefined}
                  className="rounded border border-success/50 px-3 py-1 text-sm text-success hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Accept
                </button>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
