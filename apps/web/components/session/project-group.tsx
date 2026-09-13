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
import type { ProjectPlace } from "@/lib/hosts/project-places";
import type { ProjectGroup as Group } from "@/lib/session-groups";
import { canvasHref, sessionKey, type SessionBand, type SidebarSession } from "@/lib/session-list";
import { workspaceOpenBlocker, workspaceOpener, type WorkspaceOpenersAnswer } from "@/lib/workspace-open";
import {
  preferredOpenerSnapshot,
  remembersOpener,
  serverPreferredOpenerSnapshot,
  subscribePreferredOpener,
  workspaceOpenerEntries,
  writePreferredOpener,
  type WorkspaceOpenerEntry,
} from "@/lib/workspace-opener-preference";
import { cn } from "@/lib/utils";

/**
 * THE PROJECT FOLDER, IN THE APPS THIS MACHINE ACTUALLY HAS — the same bridge,
 * the same remembered opener as the cockpit's `OpenWorkspaceButton`, reached
 * from a menu instead of a split button. Which app the "Open in…" row names is
 * decided a little differently here — see `primary` below.
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
  /**
   * AN EDITOR, OR NOTHING — which is where this menu parts company with the
   * split button. `workspaceOpenerPrimary` falls back to the reveal (#384),
   * because the button's left half must always name something it can do; this
   * menu already carries "Reveal in Finder" as its own row one line up, so
   * taking that fallback would draw the same row twice.
   *
   * So: the app you last opened with, else the first editor the machine has
   * — which is a guess the split button deliberately no longer makes, and is
   * safe here because a MENU ROW names the app in full and is read before it
   * is pressed. With no editor at all the row is disabled and reads "Open".
   */
  const primary =
    answer === undefined
      ? undefined
      : (entries.find((entry) => entry.preferred && entry.kind === "opener") ?? entries.find((entry) => entry.kind === "opener"));

  /** The shell's refusal is reported, never swallowed — this rail has no error
   *  surface of its own, which is the argument `runSessionPatch` makes for the
   *  same alert one file over. */
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
    /** Both rows are hidden together: they answer one question, and half an
     *  answer is worse than none. */
    available: !blocker,
    load,
    label: primary?.primaryLabel ?? "Open",
    icon: primary?.icon,
    /** The app's real icon when the shell could read one (#398); `icon` above
     *  is the vector fallback for when it could not. */
    iconDataUrl: primary?.iconDataUrl,
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
  rowDrag,
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
   * WHAT EACH ROW NEEDS TO BE ITS OWN HANDLE, by row key. Forwarded rather than
   * built here for the same reason the group's own handlers are: a drop lands
   * on a DIFFERENT row than the one that started the drag, so the rail owns
   * both ends of the gesture and this component only hands them out.
   */
  rowDrag: (key: string) => NonNullable<React.ComponentProps<typeof SessionRow>["drag"]>;
  /**
   * THE PROJECT'S CHECKOUT, from the registry rather than from a session: a
   * session's `workspacePath` is its own worktree, and revealing that when
   * somebody asked for the project would open a folder they did not name.
   * Absent for a paired Mac's project — this cockpit reads its id and its name,
   * never its path — which is the same case `workspaceOpenBlocker` refuses.
   */
  root?: string;
  /**
   * EVERY MAC THIS GROUP LIVES ON, this Mac first. One entry is the ordinary
   * case; two means the reader has this repository checked out on two machines
   * and the rail folded them into one group, which is the whole reason this is
   * a list rather than the group's own `hostId`. Each carries THAT Mac's own
   * project id — ids are minted per engine — so every destination below is
   * built from a place rather than from the group.
   *
   * OMITTED IS "WHEREVER THE GROUP SAYS IT IS": the group's own `projectId` and
   * `hostId` are one place's worth of identity already, and falling back to
   * them is what makes a caller that has no row list — or a group drawn with no
   * rows at all — render exactly as it did before any of this.
   */
  places?: readonly ProjectPlace[];
  /** Which Mac, answered by the reader when there is more than one. */
  onNewConversation: (place: ProjectPlace) => void;
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
  /**
   * WHERE THE HEADER'S OWN CONTROLS POINT. `projectPlaces` puts this Mac first,
   * so an ordinary group and the local half of a merged one both resolve to the
   * checkout that opens without a hop — and a group that lives only on a paired
   * Mac resolves to that Mac, which is what `workspaceOpenBlocker` then refuses
   * a folder for.
   */
  const at: readonly ProjectPlace[] =
    places && places.length > 0
      ? places
      : [{ projectId: group.projectId, ...(group.hostId ? { hostId: group.hostId } : {}), ...(group.hostName ? { hostName: group.hostName } : {}) }];
  const primary = at[0]!;
  /** ONE HEADER, EVERY MAC IT LIVES ON. A single local place wears no badge —
   *  "this Mac" is the rail's default and saying so on every group would be
   *  noise — but the moment a group spans two machines, both are named, because
   *  then which Mac a row is on is the thing the reader cannot infer. */
  const badges = at.length > 1 ? at : at.filter((place) => place.hostId);
  const folder = useProjectFolder(primary, root);
  /**
   * WHICH "+N FOLLOWING" CHIPS ARE OPEN. Local, transient and per group: this is
   * a reveal, not a fold — nothing about it is worth remembering across a reload
   * the way `useCollapsedGroups` remembers a collapsed project, and a chip that
   * stayed expanded would quietly re-create the duplicate row it exists to
   * replace every time the rail re-mounted.
   */
  /** Whether the `+`'s which-Mac menu is open — see the trigger below. */
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
              <ProjectAvatar
                name={group.name}
                projectId={group.projectId}
                {...(group.icon ? { icon: group.icon } : {})}
                {...(group.iconName ? { iconName: group.iconName } : {})}
                size={16}
              />
              <span className="min-w-0 truncate text-[0.8125rem] font-semibold text-sidebar-foreground/90">{group.name}</span>
              {badges.map((place) => {
                const label = place.hostName ?? (place.hostId ? "another Mac" : "This Mac");
                return (
                  <span
                    key={`${place.hostId ?? "local"}:${place.projectId}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-accent px-1 text-[0.625rem] text-sidebar-foreground/60"
                    title={`On ${label}`}
                  >
                    <MonitorIcon className="size-2.5" />
                    <span className="max-w-16 truncate">{label}</span>
                  </span>
                );
              })}
              <span className="ml-auto shrink-0 tabular-nums text-[0.6875rem] text-sidebar-foreground/45" title={countLabel} aria-label={countLabel}>
                {shown}
              </span>
            </ContextMenuTrigger>
            {/* `w-(--anchor-width)` is the primitive's default and would size the
                popup to the header it was opened from. A rail is not a menu
                width — the same fix `SessionActionContextMenu` makes. */}
            <ContextMenuContent className="w-56">
              {/* "HERE" IS A QUESTION ONCE A GROUP SPANS TWO MACS, so it stops
                  being the answer and becomes a submenu. With one place the row
                  is exactly what it was. */}
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
              {/* ABSENT, NOT DISABLED, without the bridge: see `useProjectFolder`. */}
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
        {/*
          THE `+` IS A LINK WHILE THERE IS ONE ANSWER, AND A MENU WHEN THERE IS
          NOT. A group spanning two Macs has two canvases and no default worth
          guessing — picking one silently would start work on a machine the
          reader did not choose, which is the wrong-host mistake this whole
          change exists to stop. A link is kept for the ordinary case because a
          link can be middle-clicked, copied and opened in a new window, and a
          button cannot.
        */}
        {at.length > 1 ? (
          <DropdownMenu onOpenChange={setPickingHost}>
            {/* HELD VISIBLE WHILE ITS OWN MENU IS OPEN. The `+` appears on
                hover of the header, and the menu opens in a portal beside it —
                so the pointer moving into the menu leaves the header, and the
                control the menu belongs to would fade out from under it. */}
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
          {/*
            ONE ROW PER CONVERSATION, ALL AT THIS GROUP'S OWN LEVEL — issue #381.

            A delegate used to be drawn as its coordinator's child, behind an
            elbow (#324), which made a separate conversation read as a sub-agent
            of the one above it. It is not one: it has its own transcript, its
            own worktree and its own life after the errand. Who asked whom for
            what is a fact about the pair, and it is stated where a pair can be
            described — the panel's Agents surface — rather than in an indent
            every reader has to interpret.
          */}
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
              drag={rowDrag(sessionKey(session))}
            />
          ))}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
