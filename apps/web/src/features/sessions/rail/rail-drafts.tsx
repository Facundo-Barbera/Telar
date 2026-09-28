import { useEffect, useState } from "react";
import type { Project } from "@telar/engine-client";
import { DraftRow } from "@/components/session/draft-row";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { DRAFTS_CHANGED_EVENT, listCanvasDrafts, writeDraft, type CanvasDraft } from "@/features/composer";
import { projectFilterKey } from "@/lib/project-filter";

export function RailDrafts({
  projects,
  projectsShown,
  query,
  openCanvasProject,
  onNavigate,
}: {
  projects: readonly Project[];
  projectsShown: ReadonlySet<string>;
  query: string;
  openCanvasProject: string | undefined;
  onNavigate: () => void;
}) {
  const [drafts, setDrafts] = useState<CanvasDraft[]>([]);

  useEffect(() => {
    const reread = () => setDrafts(listCanvasDrafts());
    const task = window.setTimeout(reread, 0);
    window.addEventListener(DRAFTS_CHANGED_EVENT, reread);
    window.addEventListener("storage", reread);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(DRAFTS_CHANGED_EVENT, reread);
      window.removeEventListener("storage", reread);
    };
  }, []);

  const needle = query.trim().toLocaleLowerCase();
  const rows = drafts
    .filter((draft) => projectsShown.size === 0 || projectsShown.has(projectFilterKey(draft.projectId)))
    .filter((draft) => (needle ? draft.text.toLocaleLowerCase().includes(needle) : true))
    .map((draft) => ({ ...draft, projectName: projects.find((project) => project.id === draft.projectId)?.name }))
    .filter((draft) => draft.projectName !== undefined);
  if (rows.length === 0) return null;

  return (
    <SidebarGroup className="shrink-0 pb-0">
      <SidebarGroupContent className="space-y-0.5">
        {rows.map((draft) => (
          <DraftRow
            key={draft.projectId}
            projectId={draft.projectId}
            projectName={draft.projectName}
            text={draft.text}
            active={draft.projectId === openCanvasProject}
            showProject
            onNavigate={onNavigate}
            onDiscard={() => writeDraft(undefined, draft.projectId, "")}
          />
        ))}
      </SidebarGroupContent>
      <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />
    </SidebarGroup>
  );
}
