"use client";

/**
 * THE REACT HALF OF A PLUGIN'S PANEL SURFACES — which component draws each
 * surface id `lib/plugins/registry.ts` declares. The components themselves are
 * the plugins' own and unchanged; this only binds them to an id, so the panel
 * renders "whatever surface this is" rather than naming Data or LaTeX.
 *
 * Loaded with `dynamic` for the reason every surface in the panel is: the panel
 * starts closed, and a surface's chunk should not be on screen until its tab is.
 */
import { Suspense, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { EngineEvent, TurnState } from "@telar/engine-client";
import type { PluginPanelSource } from "@/lib/plugins/panels";
import type { PluginSurfaceId } from "@/lib/plugins/registry";

const DataSurface = dynamic(() => import("@/components/session/data-surface").then((mod) => mod.DataSurface));
const LatexSurface = dynamic(() => import("@/components/session/latex-surface").then((mod) => mod.LatexSurface));
const PluginPanelsSurface = dynamic(() => import("@/components/plugins/plugin-panels-surface").then((mod) => mod.PluginPanelsSurface));

/** What the panel can hand any plugin surface. Each takes what it needs. */
export type PluginSurfaceProps = {
  sessionId?: string;
  projectId?: string;
  active?: TurnState;
  /** The session's journal, for a surface that folds a live fact out of it. */
  events: readonly EngineEvent[];
  onOpenImage?: (attachmentId: string) => void;
  /** Open a file through the panel's one route into the Editor. */
  onOpenFile: (path: string) => void;
  /** The enabled installed plugins' panels, for the shared "Plugins" tab. */
  panels?: readonly PluginPanelSource[];
};

const SURFACES: Record<PluginSurfaceId, (props: PluginSurfaceProps) => ReactNode> = {
  data: ({ sessionId, projectId, active, events, onOpenImage }) => (
    <DataSurface
      {...(sessionId ? { sessionId } : {})}
      {...(projectId ? { projectId } : {})}
      {...(active ? { active } : {})}
      // The kernel announces every transition on the journal; the pill folds
      // them rather than asking once and believing the answer all turn (#356).
      events={events}
      {...(onOpenImage ? { onOpenImage } : {})}
    />
  ),
  latex: ({ sessionId, active, onOpenFile }) => (
    <LatexSurface {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} onOpenFile={onOpenFile} />
  ),
  "plugin-panels": ({ sessionId, active, panels }) => (
    <PluginPanelsSurface {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} panels={panels ?? []} />
  ),
};

/**
 * INSIDE ITS OWN BOUNDARY (#896): a bare `dynamic` adds none, so a chunk not yet
 * fetched would suspend up to the route's `loading.tsx` and redraw the page.
 */
export function PluginSurface({ id, ...props }: PluginSurfaceProps & { id: PluginSurfaceId }) {
  return <Suspense fallback={null}>{SURFACES[id](props)}</Suspense>;
}
