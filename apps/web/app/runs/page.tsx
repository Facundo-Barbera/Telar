"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  PlusIcon,
  RotateCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Run } from "@telar/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { StateBadge } from "@/components/common/state-badge";
import { NewRunDialog } from "@/components/runs/new-run-dialog";
import { isTerminal, sumCost } from "@/components/runs/utils";
import { fmtAgo, fmtCost } from "@/lib/format";

function RunRow({ run }: { run: Run }) {
  const attempts = run.attempts.length;
  return (
    <Link
      href={`/runs/${run.id}`}
      className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/40"
    >
      <StateBadge state={run.state} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{run.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-mono">{run.kind}</span>
          <span className="text-border">·</span>
          <span className="truncate">{run.project}</span>
          <span className="text-border">·</span>
          <span className="shrink-0">
            {attempts} {attempts === 1 ? "attempt" : "attempts"}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xs">{fmtCost(sumCost(run.attempts))}</span>
        <span className="text-xs text-muted-foreground">
          {fmtAgo(run.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

function RunsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [runs, setRuns] = useState<Run[] | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultProject, setDefaultProject] = useState<string | null>(null);
  const autoOpened = useRef(false);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRuns(data.runs ?? []);
      setActive(data.active ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Keep null until a load succeeds so first-load failure is distinct from
      // "loaded, but empty" — mirrors the projects page's error handling.
      setRuns((prev) => prev ?? null);
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Sidebar and sibling mutations broadcast telar:refresh — refetch on it.
  useEffect(() => {
    const onRefresh = () => loadRuns();
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [loadRuns]);

  // Auto-open the New-run dialog once when arrived via ?new=1&project=<name>.
  useEffect(() => {
    if (autoOpened.current) return;
    if (searchParams.get("new") === "1") {
      autoOpened.current = true;
      setDefaultProject(searchParams.get("project"));
      setDialogOpen(true);
      router.replace("/runs");
    }
  }, [searchParams, router]);

  // Poll while anything is in flight.
  useEffect(() => {
    if (!runs) return;
    const inFlight = active.length > 0 || runs.some((r) => !isTerminal(r.state));
    if (!inFlight) return;
    const t = setInterval(loadRuns, 3000);
    return () => clearInterval(t);
  }, [runs, active, loadRuns]);

  const onCreated = useCallback(
    (id: string) => {
      setDialogOpen(false);
      router.push(`/runs/${id}`);
    },
    [router],
  );

  return (
    <div className="flex h-dvh flex-col">
      <PageHeader
        title="Runs"
        description="Autonomous work on your projects — attempt, verify, retry."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <PlusIcon />
            New run
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-4">
          {/* Loading */}
          {runs === null && !error && (
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
          {runs === null && error && (
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't load runs"
              description={
                <span className="font-mono text-xs break-words">{error}</span>
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadRuns()}
                >
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          )}

          {/* Empty */}
          {runs !== null && runs.length === 0 && (
            <EmptyState
              icon={SparklesIcon}
              title="No runs yet"
              description="Weave your first run — pick a project and describe the work."
              action={
                <Button variant="outline" onClick={() => setDialogOpen(true)}>
                  <PlusIcon />
                  New run
                </Button>
              }
            />
          )}

          {/* Populated */}
          {runs !== null && runs.length > 0 && (
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
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </div>
            </>
          )}

          {runs !== null && runs.length > 0 && (
            <p className="mt-3 flex items-center gap-1.5 px-1 text-xs text-muted-foreground/60">
              <Badge
                variant="outline"
                className="px-1.5 py-0 font-mono text-[10px]"
              >
                {runs.length}
              </Badge>
              {runs.length === 1 ? "run" : "runs"} on the loom
            </p>
          )}
        </div>
      </div>

      <NewRunDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultProject={defaultProject}
        onCreated={onCreated}
      />
    </div>
  );
}

export default function RunsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh flex-col">
          <PageHeader title="Runs" description="Loading…" />
        </div>
      }
    >
      <RunsInner />
    </Suspense>
  );
}
