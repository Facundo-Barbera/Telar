"use client";

import Link from "next/link";
import { useState } from "react";
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
import { OpenerIcon, type WorkspaceOpenerEntry } from "@/features/files";
import type { ProjectPlace } from "@/features/hosts";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/ui/utils";
import type { ProjectGroup as Group } from "../session-groups";
import { canvasHref } from "../session-list";

export type ProjectFolder = {
  available: boolean;
  label: string;
  icon: WorkspaceOpenerEntry["icon"] | undefined;
  iconDataUrl: string | undefined;
  open: (() => void) | undefined;
  reveal: () => void;
};

export function ProjectGroupBadges({ group, badges }: { group: Group; badges: readonly ProjectPlace[] }) {
  return (
    <>
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
        const label = place.hostName ?? (place.hostId ? "another computer" : "This computer");
        return (
          <span
            key={`${place.hostId ?? "local"}:${place.projectId}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-accent px-1 text-3xs text-sidebar-foreground/60"
            title={place.hostName || place.hostId ? `On ${label}` : "On this computer"}
          >
            <MonitorIcon className="size-2.5" />
            <span className="max-w-16 truncate">{label}</span>
          </span>
        );
      })}
    </>
  );
}

export function ProjectGroupMenu({
  at,
  open,
  folder,
  onNewConversation,
  onProjectSettings,
  onToggle,
  onCollapseOthers,
  onMoveUp,
  onMoveDown,
}: {
  at: readonly ProjectPlace[];
  open: boolean;
  folder: ProjectFolder;
  onNewConversation: (place: ProjectPlace) => void;
  onProjectSettings: (() => void) | undefined;
  onToggle: () => void;
  onCollapseOthers: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
}) {
  const primary = at[0]!;
  return (
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
                {place.hostName ?? "This computer"}
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
        title={onProjectSettings ? undefined : "Project settings open on the computer that owns the project."}
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
  );
}

export function NewConversationButton({
  group,
  at,
  onNavigate,
  onNewConversation,
}: {
  group: Group;
  at: readonly ProjectPlace[];
  onNavigate: () => void;
  onNewConversation: (place: ProjectPlace) => void;
}) {
  const [pickingHost, setPickingHost] = useState(false);
  const primary = at[0]!;
  return at.length > 1 ? (
    <DropdownMenu onOpenChange={setPickingHost}>
      <DropdownMenuTrigger
        aria-label={`New conversation in ${group.name}`}
        title={`New conversation in ${group.name} — asks which computer`}
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
              {place.hostName ?? "This computer"}
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
  );
}
