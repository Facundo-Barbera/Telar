"use client";

import { createContext, Suspense, useContext, useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { PanelRightOpenIcon, ShapesIcon } from "lucide-react";
import type { Artifact, Item } from "@telar/engine-client";
import { latestArtifacts } from "../artifacts";

const ArtifactView = dynamic(() => import("./artifact-view").then((mod) => mod.ArtifactView));

type Shelf = { latest: ReadonlyMap<string, Artifact>; hostId?: string; onOpen?: (artifactId: string) => void };

const ShelfContext = createContext<Shelf>({ latest: new Map() });

export function ArtifactShelf({ items, hostId, onOpen, children }: { items: Iterable<Pick<Item, "detail">>; hostId?: string; onOpen?: (artifactId: string) => void; children: ReactNode }) {
  const latest = useMemo(() => latestArtifacts(items), [items]);
  const shelf = useMemo(() => ({ latest, ...(hostId ? { hostId } : {}), ...(onOpen ? { onOpen } : {}) }), [latest, hostId, onOpen]);
  return <ShelfContext.Provider value={shelf}>{children}</ShelfContext.Provider>;
}

export function ArtifactCard({ sessionId, artifact }: { sessionId: string; artifact: Artifact }) {
  const { latest, hostId, onOpen } = useContext(ShelfContext);
  const newest = latest.get(artifact.id) ?? artifact;
  const superseded = newest.version > artifact.version;
  return (
    <figure aria-label={artifact.title} className="my-1 overflow-hidden rounded-lg border border-border bg-background">
      <figcaption className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
        <ShapesIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
        {newest.version > 1 && (
          <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">
            {superseded ? `v${artifact.version} · now v${newest.version}` : `v${newest.version}`}
          </span>
        )}
        {onOpen && (
          <button type="button" onClick={() => onOpen(artifact.id)} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <PanelRightOpenIcon className="size-3.5" />
            Open in panel
          </button>
        )}
      </figcaption>
      {!superseded && (
        <div className="border-t border-border">
          <Suspense fallback={null}>
            <ArtifactView {...(hostId ? { hostId } : {})} sessionId={sessionId} artifact={newest} />
          </Suspense>
        </div>
      )}
    </figure>
  );
}

export function ArtifactSurface({ hostId, sessionId, artifact }: { hostId?: string; sessionId: string; artifact: Artifact | undefined }) {
  if (!artifact) return <p className="px-4 py-3 text-xs text-muted-foreground">This artifact is not in the loaded conversation.</p>;
  return (
    <div className="h-full overflow-auto">
      <Suspense fallback={null}>
        <ArtifactView {...(hostId ? { hostId } : {})} sessionId={sessionId} artifact={artifact} fill />
      </Suspense>
    </div>
  );
}
