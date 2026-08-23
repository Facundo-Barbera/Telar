"use client";

/**
 * THE PROPOSAL ROOM — where a spin lands and a loom proposal is reviewed.
 *
 * THERE IS NO CREATION FORM, and there used to be. A loom is born from a
 * conversation (docs/loom-model-v1.md): you open a session, talk the work
 * through, and press "Spin into loom" — the weaver reads the conversation and
 * the project and proposes threads with contracts and tiers. The blank
 * objective textarea that lived here was a second door to the same place with
 * strictly less context behind it, and a degenerate case with its own door
 * becomes the default path. Arriving here without a spin now says so instead
 * of offering a form.
 *
 * The proposal is exactly that — a proposal. Nothing runs until Approve.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, MessageSquareIcon, WorkflowIcon } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Shimmer } from "@/components/ui/shimmer";
import { TierBadge } from "@/components/loom/thread-row";

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
  const [weaving, setWeaving] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bare, setBare] = useState(false);

  const weave = useCallback(async (sessionId: string) => {
    setWeaving(true);
    setError(null);
    try {
      const r = await fetch("/api/looms/weave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = (await r.json()) as Proposal & { error?: { message?: string } };
      if (!r.ok) throw new Error(payload.error?.message ?? `weave: ${r.status}`);
      setProposal(payload);
    } catch (e) {
      setError(String(e));
    } finally {
      setWeaving(false);
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => {
      const spin = new URLSearchParams(window.location.search).get("spin");
      if (spin) {
        window.history.replaceState(null, "", "/looms/new");
        void weave(spin);
      } else {
        // No spin, no form: this room only reviews what a conversation started.
        setBare(true);
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
        title="Proposal"
        description="The weaver read the conversation and the project. Nothing runs until you approve."
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}

          {weaving ? (
            <Card size="sm">
              <CardContent>
                <Shimmer className="text-sm">Spinning… the weaver is reading the origin conversation and the project.</Shimmer>
              </CardContent>
            </Card>
          ) : null}

          {bare && proposal === null && !weaving ? (
            <EmptyState
              icon={MessageSquareIcon}
              title="A loom is born from a conversation"
              description="Open a session, talk the work through, and press “Spin into loom” in its header — the weaver reads what you said and proposes the threads. There is no blank form on purpose."
              action={
                <Button variant="outline" render={<Link href="/" />}>
                  Go to your sessions
                </Button>
              }
            />
          ) : null}

          {proposal ? (
            <>
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <WorkflowIcon className="size-4 shrink-0" />
                    {proposal.title}
                  </CardTitle>
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
                <Button
                  variant="outline"
                  onClick={() => {
                    // A discarded proposal leaves the room bare — the honest
                    // state, and the one that names the way to try again.
                    setProposal(null);
                    setBare(true);
                  }}
                  disabled={approving}
                >
                  Discard
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
