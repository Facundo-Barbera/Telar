"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FolderOpenIcon,
  FoldVerticalIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import Link from "next/link";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { OpenerIcon } from "@/components/session/opener-icon";
import { SessionRow } from "@/components/session/session-row";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import type { ProjectGroup as Group } from "@/lib/session-groups";
import { canvasHref, sessionKey, type SessionBand, type SidebarSession } from "@/lib/session-list";
import { workspaceOpenBlocker, workspaceOpener, type WorkspaceOpener } from "@/lib/workspace-open";
import {
  preferredOpenerSnapshot,
  remembersOpener,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  workspaceOpenerEntries,
  workspaceOpenerPrimary,
  writePreferredOpener,
  type WorkspaceOpenerEntry,
} from "@/lib/workspace-opener-preference";
import { cn } from "@/lib/utils";

/**
 * THE PROJECT FOLDER, IN THE APPS THIS MACHINE ACTUALLY HAS — the same bridge,
 * the same remembered opener and the same three fallbacks as the cockpit's
 * `OpenWorkspaceButton`, reached from a menu instead of a split button.
 *
 * NOTHING NEW IS OFFERED HERE. `workspaceOpenBlocker` is the one place that
 * decides whether a folder can be opened from this window at all — no bridge (a
 * browser tab), another Mac, or no path — and the two rows are ABSENT rather
 * than disabled when it says no. A disabled "Reveal in Finder" in a browser tab
 * would be a row explaining the platform on every project header forever.
 *
 * THE LIST IS ASKED FOR WHEN THE MENU OPENS, not on mount. A rail with eight
 * project groups would otherwise make eight IPC round trips per paint to fill
 * in a label nobody is looking at. Until it lands the row reads "Open", which is
 * the split button's own first-run wording.
 */
function useProjectFolder(group: Pick<Group, "hostId" | "hostName">, root: string | undefined) {
  const [openers, setOpeners] = useState<WorkspaceOpener[]>();
  const preferred = useSyncExternalStore(
    subscribePreferredOpener,
    useCallback(() => preferredOpenerSnapshot(group.hostId), [group.hostId]),
    serverPreferredOpenerSnapshot,
  );
  const bridge = workspaceOpener();
  const blocker = workspaceOpenBlocker({
    path: root,
    hostId: group.hostId,
    hostLabel: group.hostName,
    hasBridge: Boolean(bridge),
  });

  const load = useCallback(() => {
    if (blocker || !bridge?.openers) return;
    void bridge
      .openers()
      .then((answer) => setOpeners(answer.openers))
      .catch(() => setOpeners([]));
  }, [blocker, bridge]);

  const entries = workspaceOpenerEntries({ openers: openers ?? [], preferred });
  /**
   * A MACHINE WITH NO EDITOR STILL GETS A ROW THAT NAMES WHAT IT WILL DO.
   * `workspaceOpenerPrimary` answers `undefined` there — the split button
   * responds by showing its list, which a menu row cannot — so the system
   * default stands in, and it says so in its own words ("Open in the default
   * app") rather than hiding behind a bare "Open".
   */
  const primary =
    openers === undefined ? undefined : (workspaceOpenerPrimary(entries) ?? entries.find((entry) => entry.kind === "system"));

  /** The shell's refusal is reported, never swallowed — this rail has no error
   *  surface of its own, which is the argument `runSessionPatch` makes for the
   *  same alert one file over. */
  const act = (entry: WorkspaceOpenerEntry | "reveal") => {
    if (blocker || !bridge || !root) return;
    if (entry !== "reveal" && remembersOpener(entry)) writePreferredOpener(group.hostId, entry.id);
    void (entry === "reveal" ? bridge.reveal(root) : bridge.open(root, entry.openerId))
      .then((result) => {
        if (!result.ok) window.alert(result.error ?? "That folder could not be opened.");
      })
      .catch((cause: unknown) => window.alert(cause instanceof Error ? cause.message : "That folder could not be opened."));
  };

  return {
    /** Both rows are hidden together: they answer one question, and half an
     *  answer is worse than none. */
    available: !blocker,
    load,
    label: primary?.primaryLabel ?? "Open",
    icon: primary?.icon,
    /** Nothing to open with until the shell has answered; the row is disabled
     *  for that beat rather than opening whatever it guesses. */
    open: primary ? () => act(primary) : undefined,
    reveal: () => act("reveal"),
  };
}

/**
 * One project's active sessions under a collapsible header. The header is
 * one button (name + chevron) that folds the group; scoping stays with the
 * existing project picker above, which is host-aware.
 *
 * THE HEADER IS THE HANDLE. Grab it and the whole group comes along; drop it
 * on another group and it lands above or below, by which half of that group
 * the pointer was in. The drag is the platform's own (`draggable` and
 * `dataTransfer`, the app's one drag idiom — see `lib/drag-reference.ts`), the
 * handlers arrive as bare prop references the way the Spool's lobby takes
 * them, and the sidebar owns the state, because the drop lands on a DIFFERENT
 * group than the one that started the drag.
 *
 * THE INSERT MARK IS A SHADOW, NOT A BORDER. A border added on drag-over would
 * change the group's height the instant it appeared and shove every row under
 * the pointer — the exact mechanism behind a lobby bug this app already fixed
 * once. An inset shadow draws the same 2px line and changes no box.
 *
 * RIGHT-CLICK IS THE HEADER'S OWN MENU, and every row in it fires a callback
 * this component was already given — the `+`'s canvas, the picker's settings
 * route, the chevron's fold, the drag's reorder. The one thing it adds is a
 * SECOND GESTURE for each, which is the whole point: the reorder was
 * drag-or-nothing, and "collapse others" had no control at all.
 *
 * THE TRIGGER WRAPS THE LABEL, NEVER THE BUTTON. That button is the drag
 * handle, and base-ui's trigger renders an element of its own — one carrying
 * `draggable` would make a right-press and a grab compete for the same node,
 * which is the race the Spool's board card avoids the same way.
 */
export function ProjectGroupSection({
  group,
  open,
  onToggle,
  onNavigate,
  activeSessionId,
  renderedAt,
  bandFor,
  onRefresh,
  dragging,
  insert,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  root,
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
  /** The rail's own banding — a paired Mac's row is banded by that Mac's
   *  clock, and the group must not re-derive it with this Mac's. */
  bandFor: (session: SidebarSession) => SessionBand;
  onRefresh: () => void;
  /** This group is the one being carried. */
  dragging: boolean;
  /** Where the carried group would land relative to this one, while over it. */
  insert: "above" | "below" | null;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
  /**
   * THE PROJECT'S CHECKOUT, from the registry rather than from a session: a
   * session's `workspacePath` is its own worktree, and revealing that when
   * somebody asked for the project would open a folder they did not name.
   * Absent for a paired Mac's project — this cockpit reads its id and its name,
   * never its path — which is the same case `workspaceOpenBlocker` refuses.
   */
  root?: string;
  onNewConversation: () => void;
  /** Absent where there is no page to send anyone to: per-project settings are
   *  a local-only route, exactly as the session menu's own item states. */
  onProjectSettings?: () => void;
  onCollapseOthers: () => void;
  /** Absent at the end of the list, which is what disables the row. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const headingId = `project-group-${group.key}`;
  const shown = group.sessions.length;
  const folder = useProjectFolder(group, root);
  /**
   * WHICH "+N FOLLOWING" CHIPS ARE OPEN. Local, transient and per group: this is
   * a reveal, not a fold — nothing about it is worth remembering across a reload
   * the way `useCollapsedGroups` remembers a collapsed project, and a chip that
   * stayed expanded would quietly re-create the duplicate row it exists to
   * replace every time the rail re-mounted.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const withheld = group.withheld ?? [];
  const withheldCount = withheld.reduce((total, entry) => total + entry.sessions.length, 0);
  // A COLLAPSED GROUP STILL TELLS THE TRUTH. The chips live in the body, so the
  // header's own count is the only thing a folded group says about itself.
  const countLabel = withheldCount ? `${shown} shown, ${withheldCount} under Following` : `${shown} shown`;
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
          onClick={onToggle}
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title="Drag to move this project"
          className="flex min-w-0 flex-1 cursor-grab rounded text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          {/*
            THE TRIGGER IS THE HEADER'S FLEX ROW, PADDING AND ALL — it took the
            button's own layout classes rather than adding a box beside them.

            IT CANNOT BE `display: contents`, AND THAT COST A SCREENSHOT TO
            LEARN. A `contents` box is not painted and is therefore never an
            event target: only its CHILDREN are, so a right-press landing in the
            row's padding or in a gap between the chevron and the name had the
            <button> as its target, bubbled straight past this menu and opened
            the rail's instead. The row now has one hit area and it is this
            element.

            STILL A SPAN, AND STILL INSIDE THE BUTTON. The button is the drag
            handle — base-ui renders the trigger as an element of its own, and
            one carrying `draggable` would put a right-press and a grab on the
            same node — and a <button>'s content model is phrasing, which a div
            is not.

            `onOpenChange` is where the installed-app list is asked for; see
            `useProjectFolder` for why it waits until the menu opens.
          */}
          <ContextMenu onOpenChange={(next: boolean) => next && folder.load()}>
            <ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1.5" />}>
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
            </ContextMenuTrigger>
            {/* `w-(--anchor-width)` is the primitive's default and would size the
                popup to the header it was opened from. A rail is not a menu
                width — the same fix `SessionActionContextMenu` makes. */}
            <ContextMenuContent className="w-56">
              <ContextMenuItem onClick={onNewConversation}>
                <MessageSquarePlusIcon />
                New conversation here
              </ContextMenuItem>

              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!onProjectSettings}
                title={onProjectSettings ? undefined : "Project settings open on the Mac that owns the project."}
                {...(onProjectSettings ? { onClick: onProjectSettings } : {})}
              >
                <SlidersHorizontalIcon />
                Project settings
              </ContextMenuItem>
              {/* ABSENT, NOT DISABLED, without the bridge: see `useProjectFolder`. */}
              {folder.available && (
                <>
                  <ContextMenuItem onClick={folder.reveal}>
                    <FolderOpenIcon />
                    Reveal in Finder
                  </ContextMenuItem>
                  <ContextMenuItem disabled={!folder.open} {...(folder.open ? { onClick: folder.open } : {})}>
                    <OpenerIcon icon={folder.icon} />
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
          {/*
            "+N FOLLOWING <COORDINATOR>" — the rows this group is not drawing
            because a pinned coordinator's Following already lists them (see
            `withholdFollowedRows`). The count is not decoration: without it the
            group would silently be short, which is a worse lie than the
            duplicate it replaces.

            ABOVE THE ROWS AND NOT IN THE HEADER ITSELF. The header is one
            <button> that doubles as the drag handle, and a <button> cannot
            contain another — so the chip sits at the top of the group's body,
            which is also where its rows appear when it is opened.

            EXPANDS IN PLACE, under its own chip: two coordinators claiming rows
            from one project is two chips, and a shared drawer would lose which
            rows were whose.
          */}
          {withheld.map((entry) => {
            const open = expanded.has(entry.coordinatorKey);
            const count = entry.sessions.length;
            const label = `${count} following ${entry.coordinatorTitle}`;
            return (
              <div key={entry.coordinatorKey} className="space-y-0.5">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (!next.delete(entry.coordinatorKey)) next.add(entry.coordinatorKey);
                      return next;
                    })
                  }
                  title={`${open ? "Hide" : "Show"} the ${label} — drawn under that conversation to keep them out of this list twice`}
                  aria-label={`${open ? "Hide" : "Show"} the ${label}`}
                  className="flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[0.6875rem] text-sidebar-foreground/45 hover:bg-sidebar-accent hover:text-sidebar-foreground/70"
                >
                  <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
                  <span className="shrink-0 tabular-nums">+{count}</span>
                  <span className="min-w-0 truncate">following {entry.coordinatorTitle}</span>
                </button>
                {open &&
                  entry.sessions.map((session) => (
                    <SessionRow
                      key={sessionKey(session)}
                      session={session}
                      active={sessionKey(session) === activeSessionId}
                      showProject={false}
                      variant="slim"
                      band={bandFor(session)}
                      renderedAt={renderedAt}
                      onRefresh={onRefresh}
                    />
                  ))}
              </div>
            );
          })}
          {group.sessions.map((session) => (
            <SessionRow
              key={sessionKey(session)}
              session={session}
              active={sessionKey(session) === activeSessionId}
              showProject={false}
              // Slim: the header already names the project, and a card's
              // status/branch lines are mostly empty on an idle row.
              variant="slim"
              band={bandFor(session)}
              renderedAt={renderedAt}
              onRefresh={onRefresh}
            />
          ))}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
