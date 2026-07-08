"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderGit2Icon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ProjectManifest, RegistryEntry } from "@telar/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
      <header className="shrink-0 border-b px-6 py-4">
        <div className="mx-auto flex w-full max-w-6xl items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mt-0.5 h-4" />
            <div className="space-y-1">
              <h1 className="font-heading text-lg font-semibold tracking-tight">
                Projects
              </h1>
              <p className="text-sm text-muted-foreground">
                Repos on the loom — each carries its gates, guardrails, and
                account in a telar.yaml.
              </p>
            </div>
          </div>
          <RegisterProjectDialog onRegistered={load} />
        </div>
      </header>

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
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
              <TriangleAlertIcon className="size-8 text-destructive/60" />
              <h2 className="mt-4 font-heading text-base font-medium">
                Couldn&apos;t reach the registry
              </h2>
              <p className="mt-1 max-w-sm font-mono text-xs break-words text-muted-foreground">
                {error}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => void load()}
              >
                <RotateCwIcon />
                Retry
              </Button>
            </div>
          )}

          {/* Empty */}
          {entries !== null && entries.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
              <FolderGit2Icon className="size-8 text-muted-foreground/50" />
              <h2 className="mt-4 font-heading text-base font-medium">
                No projects on the loom yet
              </h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                A telar.yaml in a repo declares its gates, guardrails, and
                account — register one to let Telar weave changes there.
              </p>
              <div className="mt-5">
                <RegisterProjectDialog onRegistered={load} />
              </div>
            </div>
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
