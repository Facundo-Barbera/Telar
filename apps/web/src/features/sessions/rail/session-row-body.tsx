"use client";

import type { ReactNode, RefObject } from "react";
import Link from "next/link";
import { GitBranchIcon } from "lucide-react";
import { HostMark } from "@/features/hosts";
import { ProjectAvatar } from "@/features/projects";
import { ProviderIcon } from "@/features/providers";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card";
import { cn } from "@/ui/utils";
import { rowSubtitle } from "../session-activity";
import type { SidebarSession } from "../session-list";

function RowAvatar({ session, size }: { session: SidebarSession & { projectName: string }; size: number }) {
  return (
    <ProjectAvatar
      name={session.projectName}
      {...(session.projectId ? { projectId: session.projectId } : {})}
      {...(session.hostId ? { hostId: session.hostId } : {})}
      {...(session.projectIcon ? { icon: session.projectIcon } : {})}
      {...(session.projectIconName ? { iconName: session.projectIconName } : {})}
      size={size}
    />
  );
}

export function CardBody({
  session,
  showProject,
  marks,
  trailing,
  reserve = false,
}: {
  session: SidebarSession;
  showProject: boolean;
  marks: ReactNode;
  trailing: ReactNode;
  reserve?: boolean;
}) {
  const room = reserve ? <span aria-hidden className="w-7 shrink-0" /> : null;
  const subtitle = rowSubtitle(session, { projectShown: showProject });
  return (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <HostMark hostId={session.hostId} hostName={session.hostName} />
        {marks}
        {showProject && session.projectName ? (
          <>
            <RowAvatar session={{ ...session, projectName: session.projectName }} size={12} />
            <span className="min-w-0 flex-1 truncate text-2xs text-sidebar-foreground/50">{session.projectName}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {trailing}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-snug text-sidebar-foreground">
          {session.title || "Untitled session"}
        </span>
        {!subtitle && room}
        {!subtitle && (
          <span className="shrink-0 opacity-50">
            <ProviderIcon provider={session.driver} size={11} />
          </span>
        )}
      </span>
      {subtitle && (
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-sidebar-foreground/45">
          {subtitle.kind === "branch" ? <GitBranchIcon className="size-3 shrink-0" /> : null}
          <span className="min-w-0 flex-1 truncate">{subtitle.text}</span>
          {room}
          <span className="shrink-0 opacity-60">
            <ProviderIcon provider={session.driver} size={11} />
          </span>
        </span>
      )}
    </span>
  );
}

export function SlimBody({
  session,
  recedes,
  marks,
  trailing,
}: {
  session: SidebarSession;
  recedes: boolean;
  marks: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <>
      <HostMark hostId={session.hostId} hostName={session.hostName} size={14} />
      {marks}
      <span className={cn("shrink-0", recedes && "opacity-50 grayscale transition group-hover/session:opacity-100 group-hover/session:grayscale-0")}>
        {session.projectName ? (
          <RowAvatar session={{ ...session, projectName: session.projectName }} size={14} />
        ) : (
          <ProviderIcon provider={session.driver} size={13} />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left text-xs-plus text-sidebar-foreground",
          recedes && "text-sidebar-foreground/70 group-hover/session:text-sidebar-foreground",
        )}
      >
        {session.title || "Untitled session"}
      </span>
      {trailing}
    </>
  );
}

export function RowLink({
  id,
  href,
  warm,
  searchable,
  searchSelected,
  active,
  slim,
  plain,
  details,
  anchor,
  onRename,
  children,
}: {
  id: string;
  href: string;
  warm: boolean;
  searchable: boolean;
  searchSelected: boolean;
  active: boolean;
  slim: boolean;
  plain: boolean;
  details: ReactNode;
  anchor: RefObject<HTMLDivElement | null>;
  onRename: () => void;
  children: ReactNode;
}) {
  const linkProps = {
    href,
    prefetch: warm ? null : false,
    draggable: false,
    role: searchable ? "option" : undefined,
    "aria-selected": searchable ? searchSelected : undefined,
    "aria-current": active ? ("page" as const) : undefined,
    onDoubleClick: (event: React.MouseEvent) => {
      event.preventDefault();
      onRename();
    },
    className: `flex min-w-0 flex-1 items-center gap-2 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
      slim ? "py-1.5" : "py-2.5"
    }`,
  };
  if (plain) {
    return (
      <Link id={id} {...linkProps}>
        {children}
      </Link>
    );
  }
  return (
    <HoverCard>
      <HoverCardTrigger id={id} render={<Link {...linkProps} />}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        anchor={anchor}
        side="right"
        align="start"
        sideOffset={8}
        positionMethod="fixed"
        collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
        className="w-64 overflow-hidden p-0 duration-150"
      >
        {details}
      </HoverCardContent>
    </HoverCard>
  );
}
