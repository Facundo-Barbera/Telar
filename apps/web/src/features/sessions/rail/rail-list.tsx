import { useState } from "react";
import { FolderPlusIcon, FoldVerticalIcon, MessageSquareIcon, MessageSquarePlusIcon, MonitorIcon, UnfoldVerticalIcon } from "lucide-react";
import { FlatSessionList } from "./flat-session-list";
import { ProjectGroupSection } from "./project-group";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SidebarGroup, SidebarGroupContent } from "@/components/ui/sidebar";
import { projectPlaces } from "@/features/hosts";
import { CAPTION } from "@/lib/idiom";
import { sessionKey, type SidebarSession } from "../session-list";
import { cn } from "@/lib/utils";
import { jumpProp, SessionShelf, SidebarEmpty, type RowEnv } from "./rail-parts";
import { SessionRow } from "./session-row";
import type { RailData } from "./use-rail-data";
import type { RailView } from "./use-rail-view";

type ComposerTarget = { projectId: string; hostId?: string };

type ListProps = {
  data: RailData;
  view: RailView;
  query: string;
  selectedSearchIndex: number;
  onShowMore: () => void;
  onNavigate: () => void;
  startSession: (target?: ComposerTarget) => void;
  openProjectSettings: (projectId: string) => void;
};

export function AttentionRows({ rows, env }: { rows: readonly SidebarSession[]; env: RowEnv }) {
  if (rows.length === 0) return null;
  return (
    <SidebarGroup className="shrink-0 pb-0">
      <div className={cn("flex items-center gap-2 px-2 pb-1", CAPTION)}>
        <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
        <span>Needs you</span>
        <span className="ml-auto tabular-nums">{rows.length}</span>
      </div>
      <SidebarGroupContent className="space-y-0.5" role="group" aria-label="Needs you">
        {rows.map((session) => (
          <SessionRow
            key={sessionKey(session)}
            session={session}
            active={sessionKey(session) === env.activeSessionId}
            showProject
            variant="card"
            band={env.bandFor(session)}
            renderedAt={env.renderedAt}
            onRowChanged={env.onRowChanged}
            {...jumpProp(env, sessionKey(session))}
          />
        ))}
      </SidebarGroupContent>
      <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />
    </SidebarGroup>
  );
}

export function RailSessionList(props: ListProps & { canStart: boolean; onAddProject: () => void }) {
  const { view, canStart, onAddProject, startSession } = props;
  const grouped = view.layout.mode === "grouped";
  const keys = view.drawnGroupKeys;
  return (
    <SidebarGroup className="min-h-0 flex-1">
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>
          <SidebarGroupContent
            id="sidebar-session-results"
            role={props.query ? "listbox" : undefined}
            className="min-h-0 space-y-0.5 overflow-y-auto"
          >
            <RailRows {...props} />
          </SidebarGroupContent>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem disabled={!canStart} onClick={() => startSession()}>
            <MessageSquarePlusIcon />
            New conversation
          </ContextMenuItem>
          <ContextMenuItem onClick={onAddProject}>
            <FolderPlusIcon />
            Add project
          </ContextMenuItem>
          {grouped && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={keys.length === 0} onClick={() => view.collapsed.collapseAll(keys)}>
                <FoldVerticalIcon />
                Collapse all projects
              </ContextMenuItem>
              <ContextMenuItem disabled={keys.length === 0} onClick={() => view.collapsed.expandAll(keys)}>
                <UnfoldVerticalIcon />
                Expand all
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </SidebarGroup>
  );
}

function RailRows(props: ListProps) {
  const { data, view, query } = props;
  const { list, grouped, flatEntries, env } = view;
  const pinned = grouped ? grouped.pinned : list.pinned;
  return (
    <>
      {view.showingStale ? (
        <p className="px-2 pb-1 pt-0.5 text-2xs leading-4 text-sidebar-foreground/55">The engine did not answer — retrying. Showing the last read.</p>
      ) : null}

      {!list.flat && !flatEntries && pinned.length > 0 && (
        <div className="space-y-0.5" role="group" aria-label="Pinned">
          {pinned.map((session) => (
            <SessionRow
              key={sessionKey(session)}
              session={session}
              active={sessionKey(session) === env.activeSessionId}
              showProject
              variant="card"
              band="pinned"
              renderedAt={env.renderedAt}
              onRowChanged={env.onRowChanged}
              {...(grouped ? { drag: view.pinnedRowDrag(sessionKey(session)) } : {})}
              {...jumpProp(env, sessionKey(session))}
            />
          ))}
          <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />
        </div>
      )}

      {data.unavailable && !view.showingStale ? (
        <SidebarEmpty icon={MessageSquareIcon} title="Engine unavailable" detail="Start the local engine, then this list refills itself." />
      ) : !view.showingStale && data.projects.length === 0 ? (
        <SidebarEmpty icon={FolderPlusIcon} title="No projects yet" detail="Register a project to start a session." />
      ) : list.sessions.length === 0 && (list.flat || !(list.settledCount || list.snoozedCount || list.pinned.length)) ? (
        <SidebarEmpty
          icon={MessageSquareIcon}
          title={query ? "No sessions found" : view.projectsShown.size ? "No sessions in the selected projects" : "No sessions yet"}
          detail={
            query
              ? "Try another title or project."
              : view.projectsShown.size
                ? "Clear the filter at the head of the field to see the rest."
                : "Start one from the button above."
          }
        />
      ) : grouped ? (
        <GroupSections {...props} />
      ) : flatEntries ? (
        <FlatSessionList
          entries={flatEntries}
          expanded={view.expanded.expanded}
          onToggle={view.expanded.toggle}
          {...(env.activeSessionId ? { activeSessionId: env.activeSessionId } : {})}
          renderedAt={env.renderedAt}
          bandFor={env.bandFor}
          onRowChanged={env.onRowChanged}
          jumpSlot={env.jumpSlotFor}
        />
      ) : (
        list.sessions.map((session, index) => (
          <SessionRow
            key={sessionKey(session)}
            session={session}
            active={sessionKey(session) === env.activeSessionId}
            showProject
            variant={query ? "slim" : "card"}
            band={env.bandFor(session)}
            searchSelected={Boolean(query) && index === props.selectedSearchIndex}
            searchable={Boolean(query)}
            renderedAt={env.renderedAt}
            onRowChanged={env.onRowChanged}
            {...jumpProp(env, sessionKey(session))}
          />
        ))
      )}
      {list.hasMoreSessions && (
        <button
          type="button"
          className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          onClick={props.onShowMore}
        >
          Show more
        </button>
      )}
      <UnreachableHosts data={data} env={env} />
    </>
  );
}

function GroupSections({ data, view, onNavigate, startSession, openProjectSettings }: ListProps) {
  const { env, drag } = view;
  return view.drawnGroups.map((group) => {
    const places = projectPlaces(group.sessions);
    const here = places.find((place) => !place.hostId);
    const root = here ? data.projects.find((project) => project.id === here.projectId)?.root : undefined;
    const moveUp = view.moveGroup(group.key, "up");
    const moveDown = view.moveGroup(group.key, "down");
    return (
      <ProjectGroupSection
        key={group.key}
        group={group}
        open={!view.collapsed.collapsed.has(group.key)}
        onToggle={() => view.collapsed.toggle(group.key)}
        onNavigate={onNavigate}
        {...(env.activeSessionId ? { activeSessionId: env.activeSessionId } : {})}
        renderedAt={env.renderedAt}
        bandFor={env.bandFor}
        onRowChanged={env.onRowChanged}
        dragging={drag.draggingGroup === group.key}
        insert={drag.groupInsert?.key === group.key ? drag.groupInsert.position : null}
        onDragStart={drag.onGroupDragStart(group.key)}
        onDragEnd={drag.onGroupDragEnd}
        onDragOver={drag.onGroupDragOver(group.key)}
        onDragLeave={drag.onGroupDragLeave(group.key)}
        onDrop={drag.onGroupDrop(group.key)}
        rowDrag={drag.rowDrag(group.key, group.sessions.map((session) => sessionKey(session)))}
        jumpSlot={env.jumpSlotFor}
        {...(root ? { root } : {})}
        places={places}
        onNewConversation={(place) => startSession({ projectId: place.projectId, ...(place.hostId ? { hostId: place.hostId } : {}) })}
        {...(here ? { onProjectSettings: () => openProjectSettings(here.projectId) } : {})}
        onCollapseOthers={() => view.collapsed.collapseOthers(group.key, view.drawnGroupKeys)}
        {...(moveUp ? { onMoveUp: moveUp } : {})}
        {...(moveDown ? { onMoveDown: moveDown } : {})}
      />
    );
  });
}

function UnreachableHosts({ data, env }: { data: RailData; env: RowEnv }) {
  return data.hosts
    .filter((host) => data.unreachable.has(host.id))
    .map((host) => (
      <div key={host.id}>
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-2xs text-muted-foreground" role="status">
          <MonitorIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{host.name} did not answer — retrying</span>
        </div>
        {(data.staleByHost.get(host.id) ?? []).map((session) => (
          <SessionRow
            key={sessionKey(session)}
            session={session}
            active={sessionKey(session) === env.activeSessionId}
            showProject
            variant="slim"
            band={env.bandFor(session)}
            renderedAt={env.renderedAt}
            onRowChanged={env.onRowChanged}
          />
        ))}
      </div>
    ));
}

export function RailShelves({
  data,
  view,
  settledLimit,
  onMoreSettled,
}: {
  data: RailData;
  view: RailView;
  settledLimit: number;
  onMoreSettled: () => void;
}) {
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const { list, env } = view;
  const active = env.activeSessionId ? { activeSessionId: env.activeSessionId } : {};
  return (
    <>
      <SessionShelf
        label="Snoozed"
        count={list.snoozedCount}
        rows={list.snoozed}
        open={snoozedOpen}
        onToggle={() => setSnoozedOpen((open) => !open)}
        {...active}
        renderedAt={env.renderedAt}
        bandFor={env.bandFor}
        onRowChanged={env.onRowChanged}
      />
      <SessionShelf
        label="Settled"
        count={data.settledOpen ? list.settledCount : Math.max(list.settledCount, data.shelvedOnEngines)}
        rows={list.settled}
        open={data.settledOpen}
        onToggle={data.toggleSettled}
        hasMore={list.hasMoreSettled && settledLimit < list.settledCount}
        onShowMore={onMoreSettled}
        limit={settledLimit}
        {...active}
        renderedAt={env.renderedAt}
        bandFor={env.bandFor}
        onRowChanged={env.onRowChanged}
      />
    </>
  );
}
