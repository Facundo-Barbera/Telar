"use client";

/**
 * THE WEAVING ROOM — where a loom is proposed and approved.
 *
 * Two entrances: arrive with `?spin=<sessionId>` (a conversation's "Spin into
 * loom") and the weaver starts on it immediately; or arrive bare and write an
 * objective. Either way, the output is a PROPOSAL — threads with briefs,
 * contracts and tiers — and nothing runs until "Approve" is pressed here.
 * Its own room rather than a form on the board, so "All looms" and "New loom"
 * stopped being two links to the same place.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface ProjectView {
  id: string;
  name: string;
}

interface Proposal {
  projectId: string;
  objective: string;
  title: string;
  threads: Array<{ title: string; slug: string; brief: string; contract: string; tier: string | null }>;
  tiers: string[];
  originSessionId?: string;
}

export function NewLoom() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectId, setProjectId] = useState("");
  const [objective, setObjective] = useState("");
  const [weaving, setWeaving] = useState<"objective" | "spin" | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const weave = useCallback(async (body: { projectId?: string; objective?: string; sessionId?: string }) => {
    setWeaving(body.sessionId ? "spin" : "objective");
    setError(null);
    try {
      const r = await fetch("/api/looms/weave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await r.json()) as Proposal & { error?: { message?: string } };
      if (!r.ok) throw new Error(payload.error?.message ?? `weave: ${r.status}`);
      setProposal(payload);
    } catch (e) {
      setError(String(e));
    } finally {
      setWeaving(null);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => {
      void fetch("/api/projects")
        .then((r) => r.json())
        .then((d: { projects: ProjectView[] }) => {
          setProjects(d.projects);
          setProjectId((current) => current || (d.projects[0]?.id ?? ""));
        })
        .catch(() => undefined);
      const spin = new URLSearchParams(window.location.search).get("spin");
      if (spin) {
        window.history.replaceState(null, "", "/looms/new");
        void weave({ sessionId: spin });
      }
    }, 0);
    return () => clearTimeout(initial);
  }, [weave]);

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
          threads: proposal.threads.map((t) => ({ ...t, tier: t.tier ?? undefined })),
          ...(proposal.originSessionId ? { originSessionId: proposal.originSessionId } : {}),
        }),
      });
      const body = (await r.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
      if (!r.ok) throw new Error(body?.error?.message ?? `create: ${r.status}`);
      // The loom exists now — go stand in its room rather than back at a form.
      router.push(body?.id ? `/looms/${body.id}` : "/looms");
    } catch (e) {
      setError(String(e));
      setApproving(false);
    }
  }, [proposal, router]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 text-foreground">
      <header className="mb-6">
        <Link href="/looms" className="text-sm text-muted-foreground hover:text-foreground">
          ← Looms
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">New loom</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The weaver reads the project and proposes threads — each with a contract and the tier that proves it. Nothing runs until you
          approve.
        </p>
      </header>

      {error ? <p className="mb-4 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      {weaving === "spin" ? (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Spinning… the weaver is reading the origin conversation and the project.
        </p>
      ) : proposal === null ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
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
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="An objective, in your own words — or better: open a session, talk it through, and press “Spin into loom” there."
            rows={4}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={() => void weave({ projectId, objective })}
            disabled={weaving !== null || !projectId || objective.trim().length < 8}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {weaving === "objective" ? "Weaving… (the weaver is reading the project)" : "Weave a proposal"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm">
              <span className="font-medium">{proposal.title}</span>
              <span className="text-muted-foreground">
                {" "}
                — {proposal.threads.length} threads proposed{proposal.originSessionId ? ", spun from your conversation" : ""}. Nothing is
                running yet.
              </span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{proposal.objective}</p>
          </div>
          <ul className="space-y-2">
            {proposal.threads.map((t, i) => (
              <li key={i} className="rounded-lg border border-border bg-card p-3 text-sm">
                <div className="flex items-baseline gap-2">
                  <p className="font-medium">{t.title}</p>
                  <span className="font-mono text-xs text-muted-foreground">{t.slug}</span>
                  {t.tier ? (
                    <span className="ml-auto rounded border border-verify/40 px-1.5 py-0.5 font-mono text-[10px] uppercase text-verify">
                      {t.tier}
                    </span>
                  ) : (
                    <span className="ml-auto rounded border border-warning/40 px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning">
                      no tier
                    </span>
                  )}
                </div>
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
    </div>
  );
}
