"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Loom } from "@telar/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { LoomCard } from "@/components/looms/loom-card";
import { NewLoomDialog } from "@/components/looms/new-loom-dialog";
import { PlanLoomButton } from "@/components/looms/plan-loom-button";
import { isTerminal } from "@/components/looms/utils";

function LoomsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [looms, setLooms] = useState<Loom[] | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultProject, setDefaultProject] = useState<string | null>(null);
  const autoOpened = useRef(false);

  const loadLooms = useCallback(async () => {
    try {
      const res = await fetch("/api/looms");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLooms(data.looms ?? []);
      setActive(data.active ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep null until a load succeeds so first-load failure is distinct from
      // "loaded, but empty" — mirrors the projects page's error handling.
      setLooms((prev) => prev ?? null);
    }
  }, []);

  useEffect(() => {
    loadLooms();
  }, [loadLooms]);

  // Sidebar and sibling mutations broadcast telar:refresh — refetch on it.
  useEffect(() => {
    const onRefresh = () => loadLooms();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [loadLooms]);

  // Auto-open the New-loom dialog once when arrived via ?new=1&project=<name>.
  useEffect(() => {
    if (autoOpened.current) return;
    if (searchParams.get("new") === "1") {
      autoOpened.current = true;
      setDefaultProject(searchParams.get("project"));
      setDialogOpen(true);
      router.replace("/looms");
    }
  }, [searchParams, router]);

  // Poll while anything is in flight.
  useEffect(() => {
    if (!looms) return;
    const inFlight = active.length > 0 || looms.some((r) => !isTerminal(r.state));
    if (!inFlight) return;
    const t = setInterval(loadLooms, 3000);
    return () => clearInterval(t);
  }, [looms, active, loadLooms]);

  const onCreated = useCallback(
    (id: string) => {
      setDialogOpen(false);
      router.push(`/looms/${id}`);
    },
    [router],
  );

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        title="Looms"
        description="Autonomous work on your projects — attempt, verify, retry."
        actions={
          <>
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              <PlusIcon />
              New loom
            </Button>
            <PlanLoomButton />
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-4">
          {/* Loading */}
          {looms === null && !error && (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          )}

          {/* First-load failure */}
          {looms === null && error && (
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't load looms"
              description={
                <span className="font-mono text-xs break-words">{error}</span>
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadLooms()}
                >
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          )}

          {/* Empty */}
          {looms !== null && looms.length === 0 && (
            <EmptyState
              icon={SparklesIcon}
              title="No looms yet"
              description="A loom begins from a planning session — describe what you want, then make it real."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <PlanLoomButton />
                  <Button variant="outline" onClick={() => setDialogOpen(true)}>
                    <PlusIcon />
                    New loom
                  </Button>
                </div>
              }
            />
          )}

          {/* Populated */}
          {looms !== null && looms.length > 0 && (
            <>
              {error && (
                <Alert variant="destructive" className="mb-3">
                  <TriangleAlertIcon />
                  <AlertTitle>Refresh failed</AlertTitle>
                  <AlertDescription className="font-mono text-xs break-words">
                    {error}
                  </AlertDescription>
                </Alert>
              )}
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {looms.map((loom) => (
                  <LoomCard key={loom.id} loom={loom} layout="row" />
                ))}
              </div>
            </>
          )}

          {looms !== null && looms.length > 0 && (
            <p className="mt-3 flex items-center gap-1.5 px-1 text-xs text-muted-foreground/60">
              <Badge
                variant="outline"
                className="px-1.5 py-0 font-mono text-[10px]"
              >
                {looms.length}
              </Badge>
              {looms.length === 1 ? "loom" : "looms"}
            </p>
          )}
        </div>
      </div>

      <NewLoomDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultProject={defaultProject}
        onCreated={onCreated}
      />
    </div>
  );
}

export default function LoomsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh flex-col">
          <PageHeader title="Looms" description="Loading…" />
        </div>
      }
    >
      <LoomsInner />
    </Suspense>
  );
}
