"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderGit2Icon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ProjectManifest, RegistryEntry } from "@telar/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { RegisterProjectDialog } from "@/components/projects/register-dialog";
import {
  ProjectCard,
  ProjectErrorCard,
} from "@/components/projects/project-card";

type ProjectEntry = {
  entry: RegistryEntry;
  manifest: ProjectManifest | null;
  error: string | null;
};

function CardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-4 w-32" />
        <div className="flex gap-1.5 pt-1">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </CardContent>
      <CardFooter className="justify-between">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-3 w-16" />
      </CardFooter>
    </Card>
  );
}

export default function ProjectsPage() {
  const [entries, setEntries] = useState<ProjectEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`Couldn't load projects (${res.status})`);
      const data = await res.json();
      setEntries(Array.isArray(data.projects) ? data.projects : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries((prev) => prev ?? null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <PageHeader
        title="Projects"
        description="Repos on the loom — each carries its gates, guardrails, and account in a telar.yaml."
        actions={<RegisterProjectDialog onRegistered={load} />}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
          {/* Loading */}
          {entries === null && !error && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          )}

          {/* First-load failure */}
          {entries === null && error && (
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't reach the registry"
              description={
                <span className="font-mono text-xs break-words">{error}</span>
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void load()}
                >
                  <RotateCwIcon />
                  Retry
                </Button>
              }
            />
          )}

          {/* Empty */}
          {entries !== null && entries.length === 0 && (
            <EmptyState
              icon={FolderGit2Icon}
              title="No projects on the loom yet"
              description="A telar.yaml in a repo declares its gates, guardrails, and account — register one to let Telar weave changes there."
              action={<RegisterProjectDialog onRegistered={load} />}
            />
          )}

          {/* Populated */}
          {entries !== null && entries.length > 0 && (
            <>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  <TriangleAlertIcon />
                  <AlertTitle>Refresh failed</AlertTitle>
                  <AlertDescription className="font-mono text-xs break-words">
                    {error}
                  </AlertDescription>
                </Alert>
              )}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {entries.map(({ entry, manifest, error: manifestError }) =>
                  manifest && !manifestError ? (
                    <ProjectCard
                      key={entry.name}
                      entry={entry}
                      manifest={manifest}
                      onChanged={load}
                    />
                  ) : (
                    <ProjectErrorCard
                      key={entry.name}
                      entry={entry}
                      error={manifestError ?? "Unknown manifest error."}
                      onChanged={load}
                    />
                  ),
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
