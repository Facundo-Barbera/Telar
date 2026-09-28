"use client";

import Link from "next/link";
import { SquarePenIcon, XIcon } from "lucide-react";
import { canvasHref } from "../session-list";

export function DraftRow({
  projectId,
  projectName,
  text,
  active,
  showProject,
  onNavigate,
  onDiscard,
}: {
  projectId: string;
  projectName?: string;
  text: string;
  active: boolean;
  showProject: boolean;
  onNavigate: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={`group/draft relative flex items-center rounded-md ${
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      }`}
    >
      <Link
        href={canvasHref(projectId)}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SquarePenIcon aria-hidden className="size-3 shrink-0 text-sidebar-foreground/50" />
        <span className="sr-only">Draft: </span>
        {showProject && projectName ? (
          <>
            <span className="shrink-0 truncate text-2xs text-sidebar-foreground/50">{projectName}</span>
            <span aria-hidden className="shrink-0 text-2xs text-sidebar-foreground/25">
              ·
            </span>
          </>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground/60 group-hover/draft:text-sidebar-foreground">
          {text}
        </span>
      </Link>
      <button
        type="button"
        aria-label={`Discard draft${projectName ? ` in ${projectName}` : ""}`}
        title="Discard draft"
        onClick={onDiscard}
        className="absolute right-1 rounded p-0.5 text-sidebar-foreground/45 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-focus-within/draft:opacity-100 group-hover/draft:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
