"use client";

/**
 * THE WEAVING ROOM — where a loom is proposed and approved, in the app's own
 * grammar: `PageHeader` introduces it, the form is the system's `Select` /
 * `Textarea` / `Button`, the proposal is `Card`s with the shared tier badges,
 * failure is `Alert`.
 *
 * Two entrances: `?spin=<sessionId>` (a conversation's "Spin into loom")
 * starts the weaver on that conversation immediately; arriving bare offers
 * the objective form. Either way the output is a PROPOSAL — nothing runs
 * until Approve is pressed here.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, WorkflowIcon } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Shimmer } from "@/components/ui/shimmer";
import { Textarea } from "@/components/ui/textarea";
import { TierBadge } from "@/components/loom/thread-row";

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
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={
          <Button variant="ghost" size="icon-sm" aria-label="Back to looms" render={<Link href="/looms" />}>
            <ArrowLeftIcon />
          </Button>
        }
        title="New loom"
        description="The weaver proposes threads with contracts and the tiers that prove them. Nothing runs until you approve."
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}

          {weaving === "spin" ? (
            <Card size="sm">
              <CardContent>
                <Shimmer>Spinning… the weaver is reading the origin conversation and the project.</Shimmer>
              </CardContent>
            </Card>
          ) : proposal === null ? (
            <Card size="sm">
              <CardContent className="space-y-3">
                <Textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="An objective, in your own words — or better: open a session, talk it through, and press “Spin into loom” there."
                  rows={4}
                />
                <div className="flex items-center gap-2">
                  <Select
                    value={projectId || null}
                    onValueChange={(value) => {
                      if (typeof value === "string") setProjectId(value);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="ml-auto"
                    onClick={() => void weave({ projectId, objective })}
                    disabled={weaving !== null || !projectId || objective.trim().length < 8}
                  >
                    <WorkflowIcon data-icon="inline-start" />
                    {weaving === "objective" ? "Weaving…" : "Weave a proposal"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card size="sm">
                <CardHeader>
                  <CardTitle>{proposal.title}</CardTitle>
                  <CardDescription>
                    {proposal.threads.length} threads proposed{proposal.originSessionId ? ", spun from your conversation" : ""} — nothing is
                    running yet. {proposal.objective}
                  </CardDescription>
                </CardHeader>
              </Card>
              {proposal.threads.map((t, i) => (
                <Card key={i} size="sm">
                  <CardHeader>
                    <CardTitle className="flex min-w-0 items-baseline gap-2 text-sm">
                      <span className="truncate">{t.title}</span>
                      <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">{t.slug}</span>
                    </CardTitle>
                    <CardAction>
                      <TierBadge {...(t.tier ? { tier: t.tier } : {})} />
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-muted-foreground">{t.brief}</p>
                    <p className="border-l-2 border-verify/50 pl-2 text-xs text-muted-foreground">
                      <span className="text-verify">Contract:</span> {t.contract}
                    </p>
                  </CardContent>
                </Card>
              ))}
              <div className="flex gap-2">
                <Button onClick={() => void approve()} disabled={approving}>
                  {approving ? "Spawning threads…" : "Approve — spawn the threads"}
                </Button>
                <Button variant="outline" onClick={() => setProposal(null)} disabled={approving}>
                  Discard
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
