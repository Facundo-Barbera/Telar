"use client";

/**
 * THE SPIN LANDING — `?spin=<sessionId>` arrives here from a session's
 * "Spin into loom", the weaver reads the conversation, and the resulting
 * DRAFT LOOM (parked at its execute gate) is where you land. The proposal
 * lives in the loom's own room now, not in this page's React state — a
 * refresh can no longer eat the weaver's work.
 *
 * Arriving bare states the model instead of offering a form: a loom is born
 * from a conversation, and there is deliberately no other human entrance.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, MessageSquareIcon } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Shimmer } from "@/components/ui/shimmer";

export function NewLoom() {
  const router = useRouter();
  const [weaving, setWeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bare, setBare] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const initial = setTimeout(() => {
      const spin = new URLSearchParams(window.location.search).get("spin");
      if (!spin) {
        setBare(true);
        return;
      }
      setWeaving(true);
      void fetch("/api/looms/weave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: spin }),
      })
        .then(async (r) => {
          const body = (await r.json()) as { loomId?: string; error?: { message?: string } };
          if (!r.ok || !body.loomId) throw new Error(body.error?.message ?? `weave: ${r.status}`);
          router.replace(`/looms/${body.loomId}`);
        })
        .catch((e) => {
          setError(String(e));
          setWeaving(false);
          setBare(true);
        });
    }, 0);
    return () => clearTimeout(initial);
  }, [router]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={
          <Button variant="ghost" size="icon-sm" aria-label="Back to looms" render={<Link href="/looms" />}>
            <ArrowLeftIcon />
          </Button>
        }
        title="Spinning"
        description="The weaver turns a conversation into a loom proposal. You approve in the loom's room."
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

          {bare && !weaving ? (
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
        </div>
      </div>
    </div>
  );
}
