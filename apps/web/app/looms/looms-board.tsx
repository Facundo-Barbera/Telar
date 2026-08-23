"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface ThreadView {
  sessionId: string;
  title: string;
  verification?: { tier: string; ok: boolean };
  session?: { status?: string } | null;
}

interface LoomView {
  id: string;
  title: string;
  objective: string;
  projectId: string;
  state: "working" | "verifying" | "ready" | "accepted";
  threads: ThreadView[];
  acceptedAt?: number;
}

interface ProjectView {
  id: string;
  name: string;
}

interface Proposal {
  projectId: string;
  objective: string;
  title: string;
  threads: Array<{ title: string; brief: string; contract: string }>;
}

const STATE_STYLE: Record<LoomView["state"], string> = {
  working: "text-info border-info/40",
  verifying: "text-verify border-verify/40",
  ready: "text-success border-success/40",
  accepted: "text-muted-foreground border-border",
};

export function LoomsBoard() {
  const [looms, setLooms] = useState<LoomView[] | null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState("");
  const [objective, setObjective] = useState("");
  const [weaving, setWeaving] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [approving, setApproving] = useState(false);

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
    const initial = setTimeout(() => {
      void refresh();
      void fetch("/api/projects")
        .then((r) => r.json())
        .then((d: { projects: ProjectView[] }) => {
          setProjects(d.projects);
          setProjectId((current) => current || (d.projects[0]?.id ?? ""));
        })
        .catch(() => undefined);
    }, 0);
    const poll = setInterval(() => void refresh(), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  const weave = useCallback(async () => {
    setWeaving(true);
    setError(null);
    try {
      const r = await fetch("/api/looms/weave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, objective }),
      });
      const body = (await r.json()) as Proposal & { error?: { message?: string } };
      if (!r.ok) throw new Error(body.error?.message ?? `weave: ${r.status}`);
      setProposal(body);
    } catch (e) {
      setError(String(e));
    } finally {
      setWeaving(false);
    }
  }, [projectId, objective]);

  const approve = useCallback(async () => {
    if (!proposal) return;
    setApproving(true);
    try {
      const r = await fetch("/api/looms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: proposal.projectId,
          title: proposal.title,
          objective: proposal.objective,
          threads: proposal.threads,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `create: ${r.status}`);
      }
      setProposal(null);
      setObjective("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setApproving(false);
    }
  }, [proposal, refresh]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 text-foreground">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Looms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Objective → threads in their own worktrees → verification → a human accepts. There is no accept an agent can call.
        </p>
      </header>

      {error ? <p className="mb-4 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <section className="mb-8 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium">New loom</h2>
        {proposal === null ? (
          <div className="mt-3 space-y-3">
            <div className="flex gap-2">
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="The objective, in your own words. The weaver reads the project and proposes threads with verification contracts — nothing runs until you approve."
              rows={3}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              onClick={() => void weave()}
              disabled={weaving || !projectId || objective.trim().length < 8}
              className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {weaving ? "Weaving… (the weaver is reading the project)" : "Weave a proposal"}
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-sm">
              <span className="font-medium">{proposal.title}</span>
              <span className="text-muted-foreground"> — {proposal.threads.length} threads proposed. Nothing is running yet.</span>
            </p>
            <ul className="space-y-2">
              {proposal.threads.map((t, i) => (
                <li key={i} className="rounded border border-border bg-background p-3 text-sm">
                  <p className="font-medium">{t.title}</p>
                  <p className="mt-1 text-muted-foreground">{t.brief}</p>
                  <p className="mt-2 border-l-2 border-verify/50 pl-2 text-xs text-muted-foreground">
                    <span className="text-verify">Contract:</span> {t.contract}
                  </p>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void approve()}
                disabled={approving}
                className="rounded border border-success/50 px-3 py-1.5 text-sm text-success hover:bg-success/10 disabled:opacity-50"
              >
                {approving ? "Spawning threads…" : "Approve — spawn the threads"}
              </button>
              <button
                type="button"
                onClick={() => setProposal(null)}
                disabled={approving}
                className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </section>

      {looms === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {looms?.length === 0 ? <p className="text-sm text-muted-foreground">No looms yet.</p> : null}

      <div className="space-y-3">
        {looms?.map((loom) => (
          <Link
            key={loom.id}
            href={`/looms/${loom.id}`}
            className="block rounded-lg border border-border bg-card p-4 hover:border-muted-foreground/40"
          >
            <div className="flex items-center gap-4">
              <div className="min-w-0">
                <h2 className="truncate font-medium">{loom.title}</h2>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{loom.objective}</p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <span className="flex gap-1">
                  {loom.threads.map((t) => (
                    <span
                      key={t.sessionId}
                      className={`h-2 w-2 rounded-full ${
                        t.verification ? (t.verification.ok ? "bg-success" : "bg-destructive") : "bg-info"
                      }`}
                    />
                  ))}
                </span>
                <span className={`rounded-full border px-3 py-0.5 font-mono text-xs uppercase tracking-wide ${STATE_STYLE[loom.state]}`}>
                  {loom.state}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
