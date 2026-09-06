"use client";

import { ChevronRightIcon, MessageSquarePlusIcon, MonitorIcon } from "lucide-react";
import Link from "next/link";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { SessionRow } from "@/components/session/session-row";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import type { ProjectGroup as Group } from "@/lib/session-groups";
import { bandOf, canvasHref, sessionKey } from "@/lib/session-list";
import { cn } from "@/lib/utils";

/**
 * One project's active sessions under a collapsible header. The header is
 * one button (name + chevron) that folds the group; scoping stays with the
 * existing project picker above, which is host-aware.
 */
export function ProjectGroupSection({
  group,
  open,
  onToggle,
  onNavigate,
  activeSessionId,
  renderedAt,
  autoSettleAfterHours,
  onRefresh,
}: {
  group: Group;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  activeSessionId?: string;
  renderedAt: number;
  autoSettleAfterHours: number | null;
  onRefresh: () => void;
}) {
  const headingId = `project-group-${group.key}`;
  const shown = group.sessions.length;
  const countLabel = `${shown} shown`;
  return (
    <SidebarGroup className="py-0">
      <div className="group/project flex items-center gap-1 pr-1">
        <button
          type="button"
          id={headingId}
          aria-expanded={open}
          aria-controls={`${headingId}-rows`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 text-sidebar-foreground/45 transition-transform", open && "rotate-90")} />
          <ProjectAvatar name={group.name} projectId={group.projectId} {...(group.icon ? { icon: group.icon } : {})} size={16} />
          <span className="min-w-0 truncate text-[0.8125rem] font-semibold text-sidebar-foreground/90">{group.name}</span>
          {group.hostName && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-accent px-1 text-[0.625rem] text-sidebar-foreground/60" title={`On ${group.hostName}`}>
              <MonitorIcon className="size-2.5" />
              <span className="max-w-16 truncate">{group.hostName}</span>
            </span>
          )}
          <span className="ml-auto shrink-0 tabular-nums text-[0.6875rem] text-sidebar-foreground/45" title={countLabel} aria-label={countLabel}>
            {shown}
          </span>
        </button>
        <Link
          href={canvasHref(group.projectId, group.hostId)}
          onClick={onNavigate}
          aria-label={`New conversation in ${group.name}`}
          title={`New conversation in ${group.name}`}
          className="flex size-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/45 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/project:opacity-100"
        >
          <MessageSquarePlusIcon className="size-3.5" />
        </Link>
      </div>
      {open && (
        <SidebarGroupContent id={`${headingId}-rows`} role="group" aria-labelledby={headingId} className="space-y-0.5 pb-1 pl-2">
          {group.sessions.map((session) => (
            <SessionRow
              key={sessionKey(session)}
              session={session}
              active={sessionKey(session) === activeSessionId}
              showProject={false}
              // Slim: the header already names the project, and a card's
              // status/branch lines are mostly empty on an idle row.
              variant="slim"
              band={bandOf(session, { now: renderedAt, autoSettleAfterHours })}
              renderedAt={renderedAt}
              onRefresh={onRefresh}
            />
          ))}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
