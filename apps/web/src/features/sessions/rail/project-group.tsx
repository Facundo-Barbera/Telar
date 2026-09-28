"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FolderOpenIcon,
  FoldVerticalIcon,
  HardDriveIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import Link from "next/link";
import { ProjectAvatar } from "@/features/projects/index";
import {
  OpenerIcon,
  workspaceOpenBlocker,
  workspaceOpener,
  type WorkspaceOpenersAnswer,
  preferredOpenerSnapshot,
  remembersOpener,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  workspaceOpenerEntries,
  writePreferredOpener,
  type WorkspaceOpenerEntry,
} from "@/features/files";
import { SessionRow } from "./session-row";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import type { ProjectPlace } from "@/features/hosts";
import type { ProjectGroup as Group, RailJumpSlot } from "../session-groups";
import { canvasHref, sessionKey, type SessionBand, type SidebarSession } from "../session-list";
import type { SessionRowChanged } from "../session-mutations";
import { cn } from "@/lib/utils";

function useProjectFolder(place: Pick<ProjectPlace, "hostId" | "hostName">, root: string | undefined) {
  const [answer, setAnswer] = useState<WorkspaceOpenersAnswer>();
  const preferred = useSyncExternalStore(
    subscribePreferredOpener,
    useCallback(() => preferredOpenerSnapshot(place.hostId), [place.hostId]),
    serverPreferredOpenerSnapshot,
  );
  const bridge = workspaceOpener();
  const blocker = workspaceOpenBlocker({
    path: root,
    hostId: place.hostId,
    hostLabel: place.hostName,
    hasBridge: Boolean(bridge),
  });

  const load = useCallback(() => {
    if (blocker || !bridge?.openers) return;
    void bridge
      .openers()
      .then((found) => setAnswer(found))
      .catch(() => setAnswer({ openers: [] }));
  }, [blocker, bridge]);

  const entries = workspaceOpenerEntries({ openers: answer?.openers ?? [], preferred, revealIconDataUrl: answer?.revealIconDataUrl });
  const primary =
    answer === undefined
      ? undefined
      : (entries.find((entry) => entry.preferred && entry.kind === "opener") ?? entries.find((entry) => entry.kind === "opener"));

  const act = (entry: WorkspaceOpenerEntry | "reveal") => {
    if (blocker || !bridge || !root) return;
    if (entry !== "reveal" && remembersOpener(entry)) writePreferredOpener(place.hostId, entry.id);
    void (entry === "reveal" ? bridge.reveal(root) : bridge.open(root, entry.openerId))
      .then((result) => {
        if (!result.ok) window.alert(result.error ?? "That folder could not be opened.");
      })
      .catch((cause: unknown) => window.alert(cause instanceof Error ? cause.message : "That folder could not be opened."));
  };

  return {
    available: !blocker,
    load,
    label: primary?.primaryLabel ?? "Open",
    icon: primary?.icon,
    iconDataUrl: primary?.iconDataUrl,
    open: primary ? () => act(primary) : undefined,
    reveal: () => act("reveal"),
  };
}

export function ProjectGroupSection({
  group,
  open,
  onToggle,
  onNavigate,
  activeSessionId,
  renderedAt,
  bandFor,
  onRowChanged,
  dragging,
  insert,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  rowDrag,
  jumpSlot,
  root,
  places,
  onNewConversation,
  onProjectSettings,
  onCollapseOthers,
  onMoveUp,
  onMoveDown,
}: {
  group: Group;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  activeSessionId?: string;
  renderedAt: number;
  bandFor: (session: SidebarSession) => SessionBand;
  onRowChanged: SessionRowChanged;
  dragging: boolean;
  insert: "above" | "below" | null;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
  rowDrag: (key: string) => NonNullable<React.ComponentProps<typeof SessionRow>["drag"]>;
  jumpSlot?: (key: string) => RailJumpSlot | undefined;
  root?: string;
  places?: readonly ProjectPlace[];
  onNewConversation: (place: ProjectPlace) => void;
  onProjectSettings?: () => void;
  onCollapseOthers: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const headingId = `project-group-${group.key}`;
  const shown = group.sessions.length;
  const at: readonly ProjectPlace[] =
    places && places.length > 0
      ? places
      : [{ projectId: group.projectId, ...(group.hostId ? { hostId: group.hostId } : {}), ...(group.hostName ? { hostName: group.hostName } : {}) }];
  const primary = at[0]!;
  const badges = at.length > 1 ? at : at.filter((place) => place.hostId);
  const folder = useProjectFolder(primary, root);
  const [pickingHost, setPickingHost] = useState(false);
  const countLabel = `${shown} shown`;
  return (
    <SidebarGroup
      className={cn(
        "py-0 transition-opacity",
        dragging && "opacity-40",
        insert === "above" && "shadow-[inset_0_2px_0_0_var(--color-sidebar-primary)]",
        insert === "below" && "shadow-[inset_0_-2px_0_0_var(--color-sidebar-primary)]",
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="group/project flex items-center gap-1 pr-1">
        <button
          type="button"
          id={headingId}
          aria-expanded={open}
          aria-controls={`${headingId}-rows`}
          onClick={(event) => event.currentTarget.contains(event.target as Node) && onToggle()}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title="Drag to move this project"
          className="flex min-w-0 flex-1 cursor-grab rounded text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <ContextMenu onOpenChange={(next: boolean) => next && folder.load()}>
            <ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1.5" />}>
              <ChevronRightIcon className={cn("size-3.5 shrink-0 text-sidebar-foreground/45 transition-transform", open && "rotate-90")} />
              <ProjectAvatar
                name={group.name}
                projectId={group.projectId}
                {...(group.icon ? { icon: group.icon } : {})}
                {...(group.iconName ? { iconName: group.iconName } : {})}
                size={16}
              />
              <span className="min-w-0 truncate text-xs-plus font-semibold text-sidebar-foreground/90">{group.name}</span>
              {group.availability ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-accent px-1 text-3xs text-sidebar-foreground/60"
                  title={
                    group.availability === "unmounted"
                      ? `The drive holding ${group.name} is not connected. Plug it back in and this project comes back as it was.`
                      : `The folder for ${group.name} is not on this machine any more.`
                  }
                >
                  <HardDriveIcon className="size-2.5" />
                  <span className="max-w-20 truncate">{group.availability === "unmounted" ? "drive away" : "folder gone"}</span>
                </span>
              ) : null}
              {badges.map((place) => {
                const label = place.hostName ?? (place.hostId ? "another Mac" : "This Mac");
                return (
                  <span
                    key={`${place.hostId ?? "local"}:${place.projectId}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-accent px-1 text-3xs text-sidebar-foreground/60"
                    title={`On ${label}`}
                  >
                    <MonitorIcon className="size-2.5" />
                    <span className="max-w-16 truncate">{label}</span>
                  </span>
                );
              })}
              <span className="ml-auto shrink-0 tabular-nums text-2xs text-sidebar-foreground/45" title={countLabel} aria-label={countLabel}>
                {shown}
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              {at.length > 1 ? (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <MessageSquarePlusIcon />
                    New conversation
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-52">
                    {at.map((place) => (
                      <ContextMenuItem key={`${place.hostId ?? "local"}:${place.projectId}`} onClick={() => onNewConversation(place)}>
                        <MonitorIcon />
                        {place.hostName ?? "This Mac"}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              ) : (
                <ContextMenuItem onClick={() => onNewConversation(primary)}>
                  <MessageSquarePlusIcon />
                  New conversation here
                </ContextMenuItem>
              )}

              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!onProjectSettings}
                title={onProjectSettings ? undefined : "Project settings open on the Mac that owns the project."}
                {...(onProjectSettings ? { onClick: onProjectSettings } : {})}
              >
                <SlidersHorizontalIcon />
                Project settings
              </ContextMenuItem>
              {folder.available && (
                <>
                  <ContextMenuItem onClick={folder.reveal}>
                    <FolderOpenIcon />
                    Reveal in Finder
                  </ContextMenuItem>
                  <ContextMenuItem disabled={!folder.open} {...(folder.open ? { onClick: folder.open } : {})}>
                    <OpenerIcon icon={folder.icon} iconDataUrl={folder.iconDataUrl} />
                    {folder.label}
                  </ContextMenuItem>
                </>
              )}

              <ContextMenuSeparator />
              <ContextMenuItem onClick={onToggle}>
                <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
                {open ? "Collapse" : "Expand"}
              </ContextMenuItem>
              <ContextMenuItem onClick={onCollapseOthers}>
                <FoldVerticalIcon />
                Collapse others
              </ContextMenuItem>

              <ContextMenuSeparator />
              <ContextMenuItem disabled={!onMoveUp} {...(onMoveUp ? { onClick: onMoveUp } : {})}>
                <ChevronUpIcon />
                Move up
              </ContextMenuItem>
              <ContextMenuItem disabled={!onMoveDown} {...(onMoveDown ? { onClick: onMoveDown } : {})}>
                <ChevronDownIcon />
                Move down
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </button>
        {at.length > 1 ? (
          <DropdownMenu onOpenChange={setPickingHost}>
            <DropdownMenuTrigger
              aria-label={`New conversation in ${group.name}`}
              title={`New conversation in ${group.name} — asks which Mac`}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/45 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/project:opacity-100",
                pickingHost && "opacity-100",
              )}
            >
              <MessageSquarePlusIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>New conversation on</DropdownMenuLabel>
                {at.map((place) => (
                  <DropdownMenuItem key={`${place.hostId ?? "local"}:${place.projectId}`} onClick={() => onNewConversation(place)}>
                    <MonitorIcon />
                    {place.hostName ?? "This Mac"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Link
            href={canvasHref(primary.projectId, primary.hostId)}
            onClick={onNavigate}
            aria-label={`New conversation in ${group.name}`}
            title={`New conversation in ${group.name}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/45 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 group-hover/project:opacity-100"
          >
            <MessageSquarePlusIcon className="size-3.5" />
          </Link>
        )}
      </div>
      {open && (
        <SidebarGroupContent id={`${headingId}-rows`} role="group" aria-labelledby={headingId} className="space-y-0.5 pb-1 pl-2">
          {group.sessions.map((session) => {
            const key = sessionKey(session);
            const slot = jumpSlot?.(key);
            return (
              <SessionRow
                key={key}
                session={session}
                active={key === activeSessionId}
                showProject={false}
                variant="slim"
                band={bandFor(session)}
                renderedAt={renderedAt}
                onRowChanged={onRowChanged}
                drag={rowDrag(key)}
                {...(slot === undefined ? {} : { jumpSlot: slot })}
              />
            );
          })}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
