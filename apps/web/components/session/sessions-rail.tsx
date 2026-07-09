import Link from "next/link";
import { ArrowLeftIcon, MessageSquarePlusIcon } from "lucide-react";
import { fmtAgo, fmtCost } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArchiveButton } from "@/components/session/archive-button";

// The rail only needs a session's identity, title, recency, and spend — a
// structural subset of the store's chat meta, so listChats(project) passes
// through as-is.
type RailSession = {
  id: string;
  title: string;
  updatedAt: number;
  costUsd: number;
};

// The chat-workspace rail: this project's sessions, newest-first, with a
// "New session" affordance up top and a back-link to the project. Server-
// rendered (data fetched by the page); items are plain Links so switching
// sessions is ordinary navigation — no client-side transcript swapping.
export function SessionsRail({
  project,
  sessions,
  activeId,
}: {
  project: string;
  sessions: RailSession[];
  activeId: string;
}) {
  const projectHref = `/projects/${encodeURIComponent(project)}`;
  const newHref = `${projectHref}/sessions/new`;

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r md:flex">
      <div className="flex flex-col gap-2.5 border-b p-3">
        <Link
          href={projectHref}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{project}</span>
        </Link>
        <Button size="sm" className="w-full" nativeButton={false} render={<Link href={newHref} />}>
          <MessageSquarePlusIcon />
          New session
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No sessions yet. Start one to plan a change.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((s) => {
              const active = s.id === activeId;
              return (
                <li key={s.id} className="group/rail-item relative">
                  <Link
                    href={`${projectHref}/sessions/${s.id}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-lg px-2.5 py-2 pr-9 transition-colors",
                      active ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <div
                      className={cn(
                        "truncate text-sm",
                        active
                          ? "font-medium text-foreground"
                          : "text-foreground/80",
                      )}
                    >
                      {s.title || "Untitled session"}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{fmtAgo(s.updatedAt)}</span>
                      <span className="font-mono">{fmtCost(s.costUsd)}</span>
                    </div>
                  </Link>
                  <ArchiveButton
                    id={s.id}
                    className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/rail-item:opacity-100 focus-visible:opacity-100"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
