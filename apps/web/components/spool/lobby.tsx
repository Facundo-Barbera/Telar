"use client";

/**
 * THE LOBBY — `docs/spool-loops.md` §13.2, the room's default landing, and
 * §13.8 ("the map is content, not chrome"), 2026-08-19: the lobby IS now the
 * home screen — Today and Scheduled ride as two smart tiles at its top, and
 * the full area structure fills the content pane beneath them. Walking INTO
 * a container (clicking its name, not its chevron) opens that same content
 * pane scoped to the subtree — `areaPath` below — with a breadcrumb back out.
 * This one component renders both: the home screen when `areaPath` is
 * absent, an area page when it is present. Two shapes of ONE screen, not two
 * components that could drift.
 *
 * MISSION CONTROL, RANKED NEVER ENUMERATED. This is a pure read of
 * `GET /v2/spool/lobby` (`lib/engine/*` → `/api/spool/lobby`): the engine
 * already decided which subjects earn a card and which fold — see
 * `SpoolLobbySubject.folded` in `packages/engine-client`'s protocol — so
 * this file renders that answer. It never re-derives urgency, never sorts
 * by a clock, and it holds no local idea of which subject "matters more"
 * than another; the fold IS the ranking.
 *
 * EVERY SUBJECT IS A ROW; A CARD IS A ROW EXPANDED — §13.8, 2026-08-19,
 * supersedes §13.2's "one quiet line per area" wording (`docs/spool-loops.md`
 * already says so). §13.2's fold sentence hid every subject the engine
 * didn't rank — that made a folded subject UNREACHABLE from the map, exactly
 * what §13.8 rules out: "everything else sits folded as plain structure you
 * can stand on," never invisible. So `LobbyNode` renders EVERY entry in
 * `node.lines`: `!entry.folded` floats the full `LobbyCard` (dot, name,
 * needs-you count, moved line, pin); `entry.folded` renders the plain
 * `LobbyRow` — dot, name, a needs-you count that stays quiet because it is
 * always zero by the engine's own invariant. Never a card AND a row for the
 * same subject, never neither. Both are the SAME drag source, keyed the
 * same way, and a container remains a drag source and a drop target
 * regardless of what its subjects render as.
 *
 * ── §13.7, 2026-08-18: THE SAME CONTAINER GRAMMAR THE RAIL LEARNED ────────
 * `SpoolLobbyArea.name` is a PATH the same way `SpoolRoomAreaLine.area` is —
 * "Work / Focaltec" is one area's stored word, split by
 * `lib/spool-area-tree.ts`'s `buildAreaTree` into nested containers, never a
 * second structure the engine maintains. Every area-path node is a real
 * container (chevron, collapsible via `lib/spool-area-collapse.ts`,
 * weight/size that never drops below a card's own), and the un-areaed tail
 * sits under the SAME ghost container ("No area yet") the rail used to use,
 * never bare.
 *
 * A CONTAINER'S ROLLUP LINE, ONLY WHEN COLLAPSED. The engine's own per-
 * subject `folded` flag (row vs. card, above) is unaffected by this — that
 * is still the ranking. What is new is the CONTAINER's own line, computed
 * from what sits beneath it (`rollupCount`) and shown only once the user's
 * own chevron has collapsed that subtree by hand: "N subjects, nothing
 * needs you" when nothing there needs attention, or an honest "N subjects ·
 * M need you" when something does — collapsing must never make a claim on
 * the hand disappear, only fold its cards and rows away.
 *
 * `SpoolLobbyArea.ceiling` (a RAW FACT, per its own doc comment: "the
 * rollup sentence is the web's to write") rides on the node whose joined
 * path matches that area's own `name` exactly — a container built from a
 * deeper subject's area never inherits an ancestor's ceiling text, the same
 * "never assume" law `tray.tsx`'s `clampedBy` fix restates for the exact
 * same shape.
 *
 * ── §13.8, 2026-08-19: THE STRUCTURE GESTURES MOVED HERE FROM THE RAIL ────
 * `warehouse-nav.tsx` used to own drag-a-subject-onto-a-container,
 * drag-a-container-onto-a-container (renames a prefix), drag-to-reorder,
 * the new-area drop zone and the container/subject context menus. §13.8
 * retires the rail's tree outright — the map is content, not chrome, so it
 * belongs in the content pane, not the rail — and this file is where all of
 * it lands now, over `SpoolLobbySubject` (which already carries `rank` and
 * `color` beside `area`, so no second fetch of the subject registry is
 * needed to drive the SAME drag machinery `warehouse-nav.tsx` had). Every
 * law that machinery kept still holds here: `pendingAreas`/`pendingRanks`
 * optimistic overlays, a `requestSeq` last-drop-wins guard, revert-on-
 * failure with the engine's own sentence, drop-zone borders that are ALWAYS
 * present (never conditionally added, so a drag starting never shoves a row
 * beneath it — that layout-shift bug was real, see `warehouse-nav.tsx`'s
 * git history), and `stopPropagation` at every level so the deepest target
 * under the pointer always wins.
 *
 * NAVIGATION IS THE NAME, COLLAPSE IS THE CHEVRON. A container row used to
 * have ONE click target (the whole row toggled collapse); §13.8 splits it —
 * the chevron alone toggles, the label alone walks into the area page
 * (`onEnterArea`). Both still live on the SAME draggable row.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { SpoolLane, SpoolLobby, SpoolLobbySubject, SpoolSubjectPermits } from "@telar/engine-client";
import { SubjectDot } from "@/components/spool/chips";
import { todayDay } from "@/lib/spool-today";
import { AddTaskDialog } from "@/components/spool/add-task";
import { AskOneThing } from "@/components/spool/prompt-card";
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
  type AreaTreeNode,
  buildAreaTree,
  findAreaNode,
  pathIsPrefixOf,
  renameAreaPrefixAcrossSubjects,
  renamePathPrefix,
  rollupCount,
  splitAreaPath,
} from "@/lib/spool-area-tree";
import { useAreaCollapse } from "@/lib/spool-area-collapse";
import { SUBJECT_COLORS, subjectColorVar } from "@/components/spool/subject-color";
import { cn } from "@/lib/utils";

function SessionLiveMark({ live }: { live: boolean | null }) {
  if (!live) return null;
  // Quiet text, never a badge — §13.2's own wording for a live session.
  return <span className="shrink-0 text-2xs text-muted-foreground/70">session running</span>;
}

/** THE RAIL'S OWN CEILING VOCABULARY, PORTED — the same four levels
 *  `tray.tsx`'s `PermitsFace` offers, restated here so the "Set ceiling ▸"
 *  submenu can list them without importing a component. */
const CEILING_MENU_OPTIONS: Array<{ value: SpoolSubjectPermits | null; label: string }> = [
  { value: null, label: "no ceiling" },
  { value: "read", label: "may read" },
  { value: "draft", label: "may draft" },
  { value: "propose", label: "may propose" },
];

/** Every non-ghost node's own joined path, recursively — used by "Collapse
 *  others" (needs every path to fold) and "Move to ▸" (needs every existing
 *  area to list). */
function collectPaths(nodes: AreaTreeNode<SpoolLobbySubject>[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.ghost) continue;
    out.push(node.key);
    out.push(...collectPaths(node.children));
  }
  return out;
}

/** WITHIN A NODE, RANK-ASCENDING, UNRANKED TRAILING — ported verbatim from
 *  `warehouse-nav.tsx`'s own `sortByRank`. A subject nobody has ever dragged
 *  carries no `rank` at all, and it keeps its place at the tail rather than
 *  the grouping inventing a position for it. */
function sortByRank(lines: SpoolLobbySubject[]): SpoolLobbySubject[] {
  return [...lines].sort((a, b) => {
    if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
    if (a.rank !== undefined) return -1;
    if (b.rank !== undefined) return 1;
    return 0;
  });
}

/** A CONTAINER's own weight/size — descends with depth, but never drops
 *  below a card's own weight (`font-medium text-foreground` on `LobbyCard`'s
 *  name). */
function containerTextClass(depth: number, ghost: boolean): string {
  return cn(
    "truncate text-sm",
    ghost && "text-muted-foreground/60",
    !ghost && depth === 0 && "font-semibold text-foreground",
    !ghost && depth === 1 && "font-semibold text-foreground/90",
    !ghost && depth >= 2 && "font-medium text-foreground/90",
    ghost && "font-medium",
  );
}

/** A NODE'S OWN COLLAPSED SENTENCE — shown only once the user has collapsed
 *  a container by hand: collapsing must never make a claim on the hand
 *  disappear, only fold its cards and rows away, so a subtree with
 *  something needing attention still says so. */
function collapsedRollupLine(subjects: number, needs: number): string {
  if (needs === 0) return `${subjects} ${subjects === 1 ? "subject" : "subjects"}, nothing needs you`;
  return `${subjects} ${subjects === 1 ? "subject" : "subjects"} · ${needs} ${needs === 1 ? "needs" : "need"} you`;
}

/**
 * THE CARD'S OWN CONTEXT MENU — widened, §13.8: alongside "Enter room" and
 * "Add a task…" (the card's own click, and the same `AddTaskDialog` the
 * header button opens), the card now also carries "Move to ▸", "Color ▸"
 * and "Move up/down" — the exact verbs `warehouse-nav.tsx`'s subject row
 * offered, reusing the SAME `assignArea`/`setSubjectColor`/`reorderSubject`
 * this file already calls for its drag gestures, never a second write path.
 * Omitted, and named here rather than faked: "Resume session" (the brief's
 * `candidateItemId` is computed inside `SubjectRoom` once the subject's own
 * brief has loaded — no route resumes a bare subject key from the lobby) and
 * "Noted all" (`SpoolLobbySubject.moved` carries only a `count` and a quoted
 * `line`, never the `observationIds` the bulk ack route needs — that list
 * only exists once a subject's own look has loaded inside its room).
 */
function LobbyCard({
  subject,
  onEnter,
  onAddTask,
  onDragStart,
  onDragEnd,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
  insertPosition,
  paths,
  onMoveTo,
  onColor,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  subject: SpoolLobbySubject;
  onEnter: (key: string) => void;
  onAddTask: (key: string) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onRowDragOver: (event: React.DragEvent) => void;
  onRowDragLeave: () => void;
  onRowDrop: (event: React.DragEvent) => void;
  insertPosition: "above" | "below" | null;
  paths: string[];
  onMoveTo: (path: string | null) => void;
  onColor: (color: string | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const card = (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onRowDragOver}
      onDragLeave={onRowDragLeave}
      onDrop={onRowDrop}
      onClick={() => onEnter(subject.key)}
      className={cn(
        "flex w-full cursor-grab flex-col gap-1 rounded-lg bg-card px-4 py-3 text-left shadow-1 ring-1 ring-foreground/10 transition-colors outline-none hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
        insertPosition === "above" && "border-t-2 border-spool/60",
        insertPosition === "below" && "border-b-2 border-spool/60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SubjectDot color={subject.color} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{subject.name}</span>
        <SessionLiveMark live={subject.sessionLive} />
      </div>
      {subject.needsYou > 0 && (
        <p className="text-xs text-muted-foreground">
          {subject.needsYou} {subject.needsYou === 1 ? "thing needs" : "things need"} you
        </p>
      )}
      {subject.moved.line && (
        <p className="truncate text-xs leading-relaxed text-muted-foreground/80">“{subject.moved.line}”</p>
      )}
      {subject.nextPin && (
        <p className="text-xs text-muted-foreground/70">pinned — {subject.nextPin.label}</p>
      )}
    </button>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onEnter(subject.key)}>Enter room</ContextMenuItem>
        <ContextMenuItem onClick={() => onAddTask(subject.key)}>Add a task…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={() => onMoveTo(null)}>No area</ContextMenuItem>
            {paths.map((path) => (
              <ContextMenuItem key={path} onClick={() => onMoveTo(path)}>
                {path}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Color</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {SUBJECT_COLORS.map((token) => (
              <ContextMenuItem key={token} onClick={() => onColor(token)}>
                <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: subjectColorVar(token) }} aria-hidden />
                {token}
              </ContextMenuItem>
            ))}
            <ContextMenuItem onClick={() => onColor(null)}>none</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canMoveUp} onClick={onMoveUp}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={!canMoveDown} onClick={onMoveDown}>
          Move down
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A PLAIN ROW — §13.8, 2026-08-19. `LobbyNode` renders one of these for
 * every `entry.folded` subject, the same footprint `LobbyCard` above
 * renders for every subject that needs you: a dot, a name, and a needs-you
 * count that this defensive rendering keeps quiet rather than assumes zero
 * — `folded` already guarantees `needsYou === 0` for every member, so a
 * nonzero count here would mean the engine's own invariant broke, not
 * something this file decides. Same drag source, same click-to-enter, same
 * context menu as the card beside it: "folded" changes what a subject looks
 * like, never whether the map can reach it.
 */
function LobbyRow({
  subject,
  onEnter,
  onAddTask,
  onDragStart,
  onDragEnd,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
  insertPosition,
  paths,
  onMoveTo,
  onColor,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  subject: SpoolLobbySubject;
  onEnter: (key: string) => void;
  onAddTask: (key: string) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onRowDragOver: (event: React.DragEvent) => void;
  onRowDragLeave: () => void;
  onRowDrop: (event: React.DragEvent) => void;
  insertPosition: "above" | "below" | null;
  paths: string[];
  onMoveTo: (path: string | null) => void;
  onColor: (color: string | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const row = (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onRowDragOver}
      onDragLeave={onRowDragLeave}
      onDrop={onRowDrop}
      onClick={() => onEnter(subject.key)}
      className={cn(
        "flex w-full cursor-grab items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
        insertPosition === "above" && "border-t-2 border-spool/60",
        insertPosition === "below" && "border-b-2 border-spool/60",
      )}
    >
      <SubjectDot color={subject.color} />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{subject.name}</span>
      <SessionLiveMark live={subject.sessionLive} />
      {subject.needsYou > 0 && (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{subject.needsYou}</span>
      )}
    </button>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onEnter(subject.key)}>Enter room</ContextMenuItem>
        <ContextMenuItem onClick={() => onAddTask(subject.key)}>Add a task…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={() => onMoveTo(null)}>No area</ContextMenuItem>
            {paths.map((path) => (
              <ContextMenuItem key={path} onClick={() => onMoveTo(path)}>
                {path}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Color</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {SUBJECT_COLORS.map((token) => (
              <ContextMenuItem key={token} onClick={() => onColor(token)}>
                <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: subjectColorVar(token) }} aria-hidden />
                {token}
              </ContextMenuItem>
            ))}
            <ContextMenuItem onClick={() => onColor(null)}>none</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canMoveUp} onClick={onMoveUp}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={!canMoveDown} onClick={onMoveDown}>
          Move down
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The drag payload's type keys — ported verbatim from `warehouse-nav.tsx`,
 *  distinct from `board.tsx`'s own so a stray drop from one surface is never
 *  misread as the other's. */
const DRAG_TYPE = "application/x-spool-subject";
const DRAG_TYPE_AREA = "application/x-spool-area";

type NavigateArea = (path: string) => void;

function LobbyNode({
  node,
  ceilingByPath,
  isCollapsed,
  toggle,
  onEnter,
  onAddTask,
  onEnterArea,
  tree,
  dragActive,
  dragging,
  draggingArea,
  dragOver,
  setDragOver,
  containerRefs,
  renamingKey,
  setRenamingKey,
  submitRenameContainer,
  setAreaCeiling,
  collapseOthers,
  nodeDropProps,
  rowInsert,
  onSubjectDragStart,
  onSubjectDragEnd,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
  assignArea,
  setSubjectColor,
  reorderSubject,
  containerDragStart,
  containerDragEnd,
}: {
  node: AreaTreeNode<SpoolLobbySubject>;
  ceilingByPath: Map<string, string>;
  isCollapsed: (path: string) => boolean;
  toggle: (path: string) => void;
  onEnter: (key: string) => void;
  onAddTask: (key: string) => void;
  onEnterArea: NavigateArea;
  tree: AreaTreeNode<SpoolLobbySubject>[];
  dragActive: boolean;
  dragging: string | null;
  draggingArea: string | null;
  dragOver: string | null;
  setDragOver: (key: string | null) => void;
  containerRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  renamingKey: string | null;
  setRenamingKey: (key: string | null) => void;
  submitRenameContainer: (fromKey: string, typed: string) => void;
  setAreaCeiling: (name: string, ceiling: SpoolSubjectPermits | null) => void;
  collapseOthers: (keep: string, allPaths: string[]) => void;
  nodeDropProps: (node: AreaTreeNode<SpoolLobbySubject>) => Record<string, unknown>;
  rowInsert: { subject: string; position: "above" | "below" } | null;
  onSubjectDragStart: (subject: string) => (event: React.DragEvent) => void;
  onSubjectDragEnd: () => void;
  onRowDragOver: (subject: SpoolLobbySubject) => (event: React.DragEvent) => void;
  onRowDragLeave: (subject: string) => () => void;
  onRowDrop: (subject: SpoolLobbySubject) => (event: React.DragEvent) => void;
  assignArea: (subject: string, area: string | null) => void;
  setSubjectColor: (subject: string, color: string | null) => void;
  reorderSubject: (subject: string, target: SpoolLobbySubject, position: "above" | "below") => void;
  containerDragStart: (node: AreaTreeNode<SpoolLobbySubject>) => (event: React.DragEvent) => void;
  containerDragEnd: () => void;
}) {
  const collapsed = !node.ghost && isCollapsed(node.key);
  const rollup = rollupCount(node, (entry) => entry.needsYou);
  const ceiling = ceilingByPath.get(node.key);
  // EVERY SUBJECT RENDERS — §13.8 (2026-08-19). One rank-ordered pass, never
  // a `!entry.folded` filter that would drop the rest off the map.
  const entries = sortByRank(node.lines);
  const showGhostAtRest = node.ghost && (node.lines.length > 0 || node.children.length > 0);
  if (node.ghost && !showGhostAtRest && !dragActive) return null;

  const containerMenu = node.ghost ? null : (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => setRenamingKey(node.key)}>Rename…</ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Set ceiling</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {CEILING_MENU_OPTIONS.map((option) => (
            <ContextMenuItem key={option.label} onClick={() => setAreaCeiling(node.key, option.value)}>
              {option.label}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => collapseOthers(node.key, collectPaths(tree))}>Collapse others</ContextMenuItem>
    </ContextMenuContent>
  );

  const containerRow = (
    <div
      ref={(el) => {
        if (el) containerRefs.current.set(node.key, el);
        else containerRefs.current.delete(node.key);
      }}
      {...nodeDropProps(node)}
      draggable={!node.ghost}
      onDragStart={node.ghost ? undefined : containerDragStart(node)}
      onDragEnd={containerDragEnd}
      style={{ paddingLeft: `${node.depth * 12}px` }}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-left transition-colors",
        // THE RECEIVING BORDER IS ALWAYS PRESENT (§13.8, ported from
        // `warehouse-nav.tsx`) — only its colour toggles when a drag goes
        // live, so a node's own box never changes size and never shoves a
        // sibling row beneath it down at dragstart.
        dragActive ? "border-border/60" : "border-transparent",
        dragOver === node.key && "bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          toggle(node.key);
        }}
        aria-label={collapsed ? "Expand" : "Collapse"}
        className="flex shrink-0 items-center justify-center rounded p-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 text-muted-foreground/50 transition-transform", !collapsed && "rotate-90")}
          aria-hidden
        />
      </button>
      {node.ghost ? (
        <span className={containerTextClass(node.depth, node.ghost)}>{node.label}</span>
      ) : (
        // NAVIGATION IS THE NAME — clicking the label walks into the area
        // page; the chevron above is the only thing that folds it in place.
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onEnterArea(node.key);
          }}
          className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={containerTextClass(node.depth, node.ghost)}>{node.label}</span>
        </button>
      )}
      {ceiling && <span className="shrink-0 text-2xs text-muted-foreground/50">ceiling: {ceiling}</span>}
      {collapsed ? (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground/60">
          {collapsedRollupLine(rollup.subjects, rollup.needs)}
        </span>
      ) : (
        <span className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground/45">
          {rollup.subjects} {rollup.subjects === 1 ? "subject" : "subjects"}
          {rollup.needs > 0 ? ` · ${rollup.needs} need you` : ""}
        </span>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      {containerMenu ? (
        <ContextMenu>
          <ContextMenuTrigger>{containerRow}</ContextMenuTrigger>
          {containerMenu}
        </ContextMenu>
      ) : (
        containerRow
      )}
      <AskOneThing
        open={renamingKey === node.key}
        onOpenChange={(next) => {
          if (!next) setRenamingKey(null);
        }}
        anchor={containerRefs.current.get(node.key) ?? null}
        label="Rename this area (its full path)"
        initialValue={node.key}
        onSubmit={(typed) => submitRenameContainer(node.key, typed)}
      />
      {!collapsed && (
        <div className="space-y-2 border-l border-border/60 pl-3">
          {node.children.map((child) => (
            <LobbyNode
              key={child.key}
              node={child}
              ceilingByPath={ceilingByPath}
              isCollapsed={isCollapsed}
              toggle={toggle}
              onEnter={onEnter}
              onAddTask={onAddTask}
              onEnterArea={onEnterArea}
              tree={tree}
              dragActive={dragActive}
              dragging={dragging}
              draggingArea={draggingArea}
              dragOver={dragOver}
              setDragOver={setDragOver}
              containerRefs={containerRefs}
              renamingKey={renamingKey}
              setRenamingKey={setRenamingKey}
              submitRenameContainer={submitRenameContainer}
              setAreaCeiling={setAreaCeiling}
              collapseOthers={collapseOthers}
              nodeDropProps={nodeDropProps}
              rowInsert={rowInsert}
              onSubjectDragStart={onSubjectDragStart}
              onSubjectDragEnd={onSubjectDragEnd}
              onRowDragOver={onRowDragOver}
              onRowDragLeave={onRowDragLeave}
              onRowDrop={onRowDrop}
              assignArea={assignArea}
              setSubjectColor={setSubjectColor}
              reorderSubject={reorderSubject}
              containerDragStart={containerDragStart}
              containerDragEnd={containerDragEnd}
            />
          ))}
          {/* FOLDED → A PLAIN ROW; NOT FOLDED → A CARD, THAT ROW EXPANDED —
              §13.8 (2026-08-19). Never both, never neither; both share the
              exact same props, so a subject's own place in the rank order
              never shifts when its fold state does. */}
          {entries.map((entry, idx) =>
            entry.folded ? (
              <LobbyRow
                key={entry.key}
                subject={entry}
                onEnter={onEnter}
                onAddTask={onAddTask}
                onDragStart={onSubjectDragStart(entry.key)}
                onDragEnd={onSubjectDragEnd}
                onRowDragOver={onRowDragOver(entry)}
                onRowDragLeave={onRowDragLeave(entry.key)}
                onRowDrop={onRowDrop(entry)}
                insertPosition={rowInsert?.subject === entry.key ? rowInsert.position : null}
                paths={collectPaths(tree)}
                onMoveTo={(path) => assignArea(entry.key, path)}
                onColor={(color) => setSubjectColor(entry.key, color)}
                canMoveUp={idx > 0}
                canMoveDown={idx < entries.length - 1}
                onMoveUp={() => idx > 0 && reorderSubject(entry.key, entries[idx - 1], "above")}
                onMoveDown={() => idx < entries.length - 1 && reorderSubject(entry.key, entries[idx + 1], "below")}
              />
            ) : (
              <LobbyCard
                key={entry.key}
                subject={entry}
                onEnter={onEnter}
                onAddTask={onAddTask}
                onDragStart={onSubjectDragStart(entry.key)}
                onDragEnd={onSubjectDragEnd}
                onRowDragOver={onRowDragOver(entry)}
                onRowDragLeave={onRowDragLeave(entry.key)}
                onRowDrop={onRowDrop(entry)}
                insertPosition={rowInsert?.subject === entry.key ? rowInsert.position : null}
                paths={collectPaths(tree)}
                onMoveTo={(path) => assignArea(entry.key, path)}
                onColor={(color) => setSubjectColor(entry.key, color)}
                canMoveUp={idx > 0}
                canMoveDown={idx < entries.length - 1}
                onMoveUp={() => idx > 0 && reorderSubject(entry.key, entries[idx - 1], "above")}
                onMoveDown={() => idx < entries.length - 1 && reorderSubject(entry.key, entries[idx + 1], "below")}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** ONE SMART TILE — Today or Scheduled, a live count and a click into that
 *  room. §13.8's home-screen header; the count is whatever the room itself
 *  already counts (`stance.tsx`'s `wideModel`), never a second derivation
 *  kept here. */
function SmartTile({ label, count, hint, onClick }: { label: string; count: number; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 flex-col items-start gap-0.5 rounded-lg bg-card px-4 py-3 text-left shadow-1 ring-1 ring-foreground/10 transition-colors outline-none hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-foreground">{count}</span>
      <span className="text-2xs text-muted-foreground/70">{hint}</span>
    </button>
  );
}

/** THE BREADCRUMB — an area page's own header, §13.8. Every segment is its
 *  own button: "Lobby" walks all the way out, and each named segment walks
 *  to the path ending there — clicking "Work" from "Work / Focaltec / Deep"
 *  goes straight to "Work", not one step at a time. */
function Breadcrumb({ path, onEnterLobby, onEnterArea }: { path: string[]; onEnterLobby: () => void; onEnterArea: NavigateArea }) {
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
      <button type="button" onClick={onEnterLobby} className="rounded px-1 py-0.5 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Lobby
      </button>
      {path.map((segment, idx) => {
        const target = path.slice(0, idx + 1).join(" / ");
        return (
          <span key={target} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <button type="button" onClick={() => onEnterArea(target)} className="rounded px-1 py-0.5 transition-colors outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {segment}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function Lobby({
  onEnterSubject,
  onChanged,
  onEnterArea,
  onEnterLobby,
  onEnterToday,
  onEnterScheduled,
  todayCount,
  scheduledCount,
  areaPath,
}: {
  onEnterSubject: (key: string) => void;
  /** Fired after the add-task dialog lands one, or a structure gesture
   *  lands — the room's own reload, never a second store the lobby keeps
   *  for itself. */
  onChanged?: () => void;
  /** WALK INTO A CONTAINER — §13.8. Absent means the home screen has
   *  nowhere further to hand a click; present on both the home screen (every
   *  container name) and an area page (its own children's names, and the
   *  breadcrumb). */
  onEnterArea?: NavigateArea;
  /** THE BREADCRUMB'S "Lobby" segment — walks all the way back out. Only
   *  meaningful (and only rendered) when `areaPath` is set. */
  onEnterLobby?: () => void;
  onEnterToday?: () => void;
  onEnterScheduled?: () => void;
  /** THE TWO TILES' OWN LIVE COUNTS — computed by `stance.tsx` from the same
   *  derivation Today/Scheduled already render, never re-derived here.
   *  Absent on an area page, where the tiles do not render. */
  todayCount?: number;
  scheduledCount?: number;
  /** WHICH SUBTREE THIS SCREEN SHOWS — absent renders the home screen (tiles
   *  plus the whole tree); present renders an area page: the breadcrumb plus
   *  that one node's own children and subjects, same container grammar. */
  areaPath?: string;
}) {
  const [lobby, setLobby] = useState<SpoolLobby | null>(null);
  const [lanes, setLanes] = useState<SpoolLane[]>([]);
  /** `null` closed; `{}` open blank (the header button); `{ subject }` open
   *  prefilled (a card's own "Add a task…" context-menu verb) — one dialog,
   *  one state, the header button and every card's menu share it rather
   *  than each owning a copy. */
  const [adding, setAdding] = useState<{ subject?: string } | null>(null);
  const { isCollapsed, toggle, collapseOthers } = useAreaCollapse();

  /** THE OPTIMISTIC OVERLAYS — ported from `warehouse-nav.tsx`'s
   *  `pendingAreas`/`pendingRanks`: painted over the published lobby before
   *  the tree is built, retired inside `load` once the published snapshot
   *  agrees, `requestSeq` making the LAST drop win. Retirement stays a WRITE
   *  rather than a render-time filter deliberately: a settled overlay must be
   *  forgotten, not merely skipped, or a later move of the same subject would
   *  disagree with it again and resurrect a value the human already saw land.
   *
   *  DECLARED ABOVE `load`, not beside the other drag state, because `load`
   *  retires them and a callback may not close over a binding declared after
   *  it. */
  const [pendingAreas, setPendingAreas] = useState<Map<string, string | null>>(new Map());
  const [pendingRanks, setPendingRanks] = useState<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    try {
      const today = todayDay();
      const [lobbyRes, laneRes] = await Promise.all([
        fetch(`/api/spool/lobby?today=${encodeURIComponent(today)}`),
        fetch("/api/spool/lanes"),
      ]);
      if (lobbyRes.ok) {
        const published = (await lobbyRes.json()).lobby as SpoolLobby;
        setLobby(published);
        // RETIRED HERE, AGAINST THE SNAPSHOT THAT EARNED IT — see the overlay
        // comment below. This ran as an effect on `[lobby]` until the React
        // compiler flagged it: a setState called synchronously from an effect
        // is a second render pass over data the first pass already had. The
        // published lobby is in hand right here, so the overlay is retired in
        // the same update that publishes the snapshot agreeing with it.
        const byKey = new Map(
          [...published.areas.flatMap((area) => area.subjects), ...published.unareaed].map(
            (line) => [line.key, line] as const,
          ),
        );
        setPendingAreas((prev) => {
          if (prev.size === 0) return prev;
          let changed = false;
          const next = new Map(prev);
          for (const [subject, area] of prev) {
            const line = byKey.get(subject);
            if (line && (line.area ?? null) === area) {
              next.delete(subject);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        setPendingRanks((prev) => {
          if (prev.size === 0) return prev;
          let changed = false;
          const next = new Map(prev);
          for (const [subject, rank] of prev) {
            const line = byKey.get(subject);
            if (line && line.rank === rank) {
              next.delete(subject);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      if (laneRes.ok) setLanes(((await laneRes.json()).lanes ?? []) as SpoolLane[]);
    } catch {
      // Pull-based, like every other Spool surface — a dropped read leaves
      // the last good lobby up.
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const requestSeq = useRef<Map<string, number>>(new Map());
  const containerRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [draggingArea, setDraggingArea] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [newAreaDraft, setNewAreaDraft] = useState<{ subject: string; name: string } | null>(null);
  const [rowInsert, setRowInsert] = useState<{ subject: string; position: "above" | "below" } | null>(null);
  const dragActive = dragging !== null;

  const flatEntries: SpoolLobbySubject[] = lobby ? [...lobby.areas.flatMap((area) => area.subjects), ...lobby.unareaed] : [];

  const effectiveLines: SpoolLobbySubject[] = flatEntries.map((line) => {
    const withArea = pendingAreas.has(line.key) ? { ...line, area: pendingAreas.get(line.key) ?? undefined } : line;
    return pendingRanks.has(line.key) ? { ...withArea, rank: pendingRanks.get(line.key) } : withArea;
  });

  const tree = buildAreaTree<SpoolLobbySubject>(effectiveLines, (entry) => entry.area);
  /** THE GHOST NODE IS ALSO THE CLEARING TARGET — §13.7 (2026-08-18), ported
   *  into the lobby with the rest of the tree §13.8 (2026-08-19).
   *  `buildAreaTree` only mints a ghost node once real un-areaed subjects
   *  exist; this fallback keeps "drop here to clear the area" reachable by
   *  hand even while it holds nothing, for as long as a subject is mid-drag. */
  const ghostFromTree = tree.find((node) => node.ghost);
  const treeWithGhost =
    dragActive && !ghostFromTree
      ? [...tree, { key: "__ghost", path: [], label: "No area yet", depth: 0, ghost: true, lines: [], children: [] }]
      : tree;
  const ceilingByPath = new Map<string, string>((lobby?.areas ?? []).filter((area) => area.ceiling).map((area) => [area.name, area.ceiling as string]));

  /** PATCH `/api/spool/subjects/:key` — the same route and body shape every
   *  other identity write in the module uses. Painted into `pendingAreas`
   *  FIRST, before the request is even sent. */
  const assignArea = (subject: string, area: string | null) => {
    setDragging(null);
    setDragOver(null);
    setPendingAreas((prev) => new Map(prev).set(subject, area));
    const seq = (requestSeq.current.get(subject) ?? 0) + 1;
    requestSeq.current.set(subject, seq);
    const isLatest = () => requestSeq.current.get(subject) === seq;
    void fetch(`/api/spool/subjects/${encodeURIComponent(subject)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ area }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        if (isLatest()) setRefused(null);
        void load();
        onChanged?.();
      })
      .catch((err) => {
        if (!isLatest()) return;
        setPendingAreas((prev) => {
          const next = new Map(prev);
          next.delete(subject);
          return next;
        });
        setRefused(err instanceof Error ? err.message : String(err));
      });
  };

  const patchRank = (subject: string, rank: number, area?: string | null) => {
    setPendingRanks((prev) => new Map(prev).set(subject, rank));
    if (area !== undefined) setPendingAreas((prev) => new Map(prev).set(subject, area));
    const seq = (requestSeq.current.get(subject) ?? 0) + 1;
    requestSeq.current.set(subject, seq);
    const isLatest = () => requestSeq.current.get(subject) === seq;
    void fetch(`/api/spool/subjects/${encodeURIComponent(subject)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(area !== undefined ? { area, rank } : { rank }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        if (isLatest()) setRefused(null);
        void load();
        onChanged?.();
      })
      .catch((err) => {
        if (!isLatest()) return;
        setPendingRanks((prev) => {
          const next = new Map(prev);
          next.delete(subject);
          return next;
        });
        if (area !== undefined) {
          setPendingAreas((prev) => {
            const next = new Map(prev);
            next.delete(subject);
            return next;
          });
        }
        setRefused(err instanceof Error ? err.message : String(err));
      });
  };

  const reorderSubject = (subject: string, target: SpoolLobbySubject, position: "above" | "below") => {
    setDragging(null);
    setDragOver(null);
    setRowInsert(null);
    if (subject === target.key) return;
    const targetArea = target.area ?? null;
    const draggedLine = effectiveLines.find((l) => l.key === subject);
    const crossedArea = (draggedLine?.area ?? null) !== targetArea;
    const rest = sortByRank(effectiveLines.filter((l) => (l.area ?? null) === targetArea && l.key !== subject));
    const targetIndex = rest.findIndex((l) => l.key === target.key);
    const insertAt = position === "above" ? targetIndex : targetIndex + 1;
    const ordered = [...rest];
    ordered.splice(insertAt, 0, draggedLine ?? target);
    ordered.forEach((line, rank) => {
      if (line.rank === rank && !(line.key === subject && crossedArea)) return;
      patchRank(line.key, rank, line.key === subject && crossedArea ? targetArea : undefined);
    });
  };

  const renameAreaPrefix = (fromKey: string, toKey: string) => {
    const from = splitAreaPath(fromKey);
    const to = splitAreaPath(toKey);
    const affected = effectiveLines.filter((line) => line.area && pathIsPrefixOf(from, splitAreaPath(line.area)));
    if (affected.length === 0) return;
    const renamed = new Map(affected.map((line) => [line.key, renamePathPrefix(line.area as string, from, to)]));
    setPendingAreas((prev) => {
      const next = new Map(prev);
      for (const [subject, area] of renamed) next.set(subject, area);
      return next;
    });
    void renameAreaPrefixAcrossSubjects(
      effectiveLines.map((line) => ({ key: line.key, ...(line.area ? { area: line.area } : {}) })),
      fromKey,
      toKey,
    ).then(({ error }) => {
      if (!error) {
        setRefused(null);
        void load();
        onChanged?.();
        return;
      }
      setPendingAreas((prev) => {
        const next = new Map(prev);
        for (const subject of renamed.keys()) next.delete(subject);
        return next;
      });
      setRefused(error);
    });
  };

  const submitRenameContainer = (fromKey: string, typed: string) => {
    setRenamingKey(null);
    const trimmed = typed.trim();
    if (!trimmed || trimmed === fromKey) return;
    renameAreaPrefix(fromKey, trimmed);
  };

  const setSubjectColor = (subject: string, color: string | null) => {
    void fetch(`/api/spool/subjects/${encodeURIComponent(subject)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        setRefused(null);
        void load();
        onChanged?.();
      })
      .catch((err) => setRefused(err instanceof Error ? err.message : String(err)));
  };

  const setAreaCeiling = (name: string, ceiling: SpoolSubjectPermits | null) => {
    void fetch(`/api/spool/areas/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ceiling }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        setRefused(null);
        void load();
      })
      .catch((err) => setRefused(err instanceof Error ? err.message : String(err)));
  };

  const nodeDropProps = (node: AreaTreeNode<SpoolLobbySubject>) => ({
    onDragOver: (event: React.DragEvent) => {
      const isSubjectDrag = event.dataTransfer.types.includes(DRAG_TYPE);
      const isAreaDrag = event.dataTransfer.types.includes(DRAG_TYPE_AREA);
      if (!isSubjectDrag && !isAreaDrag) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragOver !== node.key) setDragOver(node.key);
    },
    onDragLeave: () => setDragOver((current) => (current === node.key ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const subject = event.dataTransfer.getData(DRAG_TYPE) || dragging;
      if (subject) {
        assignArea(subject, node.ghost ? null : node.key);
        return;
      }
      const fromKey = event.dataTransfer.getData(DRAG_TYPE_AREA) || draggingArea;
      if (fromKey && !node.ghost && fromKey !== node.key) renameAreaPrefix(fromKey, node.key);
      setDraggingArea(null);
      setDragOver(null);
    },
  });

  const newAreaDropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      if (dragOver !== "__new-area") setDragOver("__new-area");
    },
    onDragLeave: () => setDragOver((current) => (current === "__new-area" ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const subject = event.dataTransfer.getData(DRAG_TYPE) || dragging;
      setDragging(null);
      setDragOver(null);
      if (subject) setNewAreaDraft({ subject, name: "" });
    },
  };

  const onSubjectDragStart = (subject: string) => (event: React.DragEvent) => {
    event.dataTransfer.setData(DRAG_TYPE, subject);
    event.dataTransfer.effectAllowed = "move";
    setDragging(subject);
  };
  const onSubjectDragEnd = () => {
    setDragging(null);
    setDragOver(null);
    setRowInsert(null);
  };
  const onRowDragOver = (line: SpoolLobbySubject) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    if (dragging === line.key) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setRowInsert((current) => (current?.subject === line.key && current.position === position ? current : { subject: line.key, position }));
  };
  const onRowDragLeave = (subject: string) => () => setRowInsert((current) => (current?.subject === subject ? null : current));
  const onRowDrop = (line: SpoolLobbySubject) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const subject = event.dataTransfer.getData(DRAG_TYPE) || dragging;
    const position = rowInsert?.subject === line.key ? rowInsert.position : "below";
    if (subject) reorderSubject(subject, line, position);
  };
  const containerDragStart = (node: AreaTreeNode<SpoolLobbySubject>) => (event: React.DragEvent) => {
    event.dataTransfer.setData(DRAG_TYPE_AREA, node.key);
    event.dataTransfer.effectAllowed = "move";
    setDraggingArea(node.key);
  };
  const containerDragEnd = () => {
    setDraggingArea(null);
    setDragOver(null);
  };

  const subjectNames = flatEntries.map((s) => s.key);

  // §13.8: AN AREA PAGE SHOWS ONE SUBTREE, SAME GRAMMAR. `findAreaNode`
  // (already `lib/spool-area-tree.ts`'s own helper, unused until now) locates
  // the node whose path this screen was asked to show; its own children and
  // subject lines render exactly the way the home screen's tree does, one
  // level shallower.
  const scopedNode = areaPath ? findAreaNode(tree, areaPath) : undefined;
  const scopedNodes = areaPath ? (scopedNode ? [scopedNode] : []) : treeWithGhost;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      {areaPath && onEnterLobby && onEnterArea && (
        <Breadcrumb path={splitAreaPath(areaPath)} onEnterLobby={onEnterLobby} onEnterArea={onEnterArea} />
      )}

      {/* THE TWO SMART TILES — §13.8, home screen only. */}
      {!areaPath && (todayCount !== undefined || scheduledCount !== undefined) && (
        <div className="mb-6 flex gap-3">
          <SmartTile label="Today" count={todayCount ?? 0} hint="pinned for today" onClick={() => onEnterToday?.()} />
          <SmartTile label="Scheduled" count={scheduledCount ?? 0} hint="pinned ahead" onClick={() => onEnterScheduled?.()} />
        </div>
      )}

      {/* §13.8 (2026-08-19): the home screen's own caption used to claim
          "nothing else is enumerated" — true of §13.2's stance, false now
          that every subject renders. Dropped rather than replaced with a
          new claim: the map speaks for itself. The area page's own caption
          still holds, so it stays. */}
      <div className={cn("mb-4 flex items-center px-1", areaPath ? "justify-between" : "justify-end")}>
        {areaPath && (
          <p className="text-xs leading-relaxed text-muted-foreground">This area&apos;s own subjects and its own containers.</p>
        )}
        <button
          type="button"
          onClick={() => setAdding({})}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors outline-none hover:border-spool/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Add a task
        </button>
      </div>

      {!lobby && <p className="px-1 text-xs text-muted-foreground/60">Reading…</p>}

      {lobby && scopedNodes.length === 0 && (
        <p className="px-1 text-xs leading-relaxed text-muted-foreground/60">{areaPath ? "Nothing filed here yet." : "Nothing filed yet."}</p>
      )}

      {lobby && scopedNodes.length > 0 && (
        <div className="space-y-6">
          {(areaPath ? scopedNodes[0]?.children ?? [] : scopedNodes).map((node) => (
            <LobbyNode
              key={node.key}
              node={node}
              ceilingByPath={ceilingByPath}
              isCollapsed={isCollapsed}
              toggle={toggle}
              onEnter={onEnterSubject}
              onAddTask={(key) => setAdding({ subject: key })}
              onEnterArea={onEnterArea ?? (() => undefined)}
              tree={tree}
              dragActive={dragActive}
              dragging={dragging}
              draggingArea={draggingArea}
              dragOver={dragOver}
              setDragOver={setDragOver}
              containerRefs={containerRefs}
              renamingKey={renamingKey}
              setRenamingKey={setRenamingKey}
              submitRenameContainer={submitRenameContainer}
              setAreaCeiling={setAreaCeiling}
              collapseOthers={collapseOthers}
              nodeDropProps={nodeDropProps}
              rowInsert={rowInsert}
              onSubjectDragStart={onSubjectDragStart}
              onSubjectDragEnd={onSubjectDragEnd}
              onRowDragOver={onRowDragOver}
              onRowDragLeave={onRowDragLeave}
              onRowDrop={onRowDrop}
              assignArea={assignArea}
              setSubjectColor={setSubjectColor}
              reorderSubject={reorderSubject}
              containerDragStart={containerDragStart}
              containerDragEnd={containerDragEnd}
            />
          ))}
          {/* AN AREA PAGE'S OWN SUBJECTS — same law as `LobbyNode`'s: every
              entry renders, folded as a row, needing-you as a card. §13.8
              (2026-08-19). */}
          {areaPath &&
            sortByRank(scopedNodes[0]?.lines ?? []).map((entry, idx, arr) =>
              entry.folded ? (
                <LobbyRow
                  key={entry.key}
                  subject={entry}
                  onEnter={onEnterSubject}
                  onAddTask={(key) => setAdding({ subject: key })}
                  onDragStart={onSubjectDragStart(entry.key)}
                  onDragEnd={onSubjectDragEnd}
                  onRowDragOver={onRowDragOver(entry)}
                  onRowDragLeave={onRowDragLeave(entry.key)}
                  onRowDrop={onRowDrop(entry)}
                  insertPosition={rowInsert?.subject === entry.key ? rowInsert.position : null}
                  paths={collectPaths(tree)}
                  onMoveTo={(path) => assignArea(entry.key, path)}
                  onColor={(color) => setSubjectColor(entry.key, color)}
                  canMoveUp={idx > 0}
                  canMoveDown={idx < arr.length - 1}
                  onMoveUp={() => idx > 0 && reorderSubject(entry.key, arr[idx - 1], "above")}
                  onMoveDown={() => idx < arr.length - 1 && reorderSubject(entry.key, arr[idx + 1], "below")}
                />
              ) : (
                <LobbyCard
                  key={entry.key}
                  subject={entry}
                  onEnter={onEnterSubject}
                  onAddTask={(key) => setAdding({ subject: key })}
                  onDragStart={onSubjectDragStart(entry.key)}
                  onDragEnd={onSubjectDragEnd}
                  onRowDragOver={onRowDragOver(entry)}
                  onRowDragLeave={onRowDragLeave(entry.key)}
                  onRowDrop={onRowDrop(entry)}
                  insertPosition={rowInsert?.subject === entry.key ? rowInsert.position : null}
                  paths={collectPaths(tree)}
                  onMoveTo={(path) => assignArea(entry.key, path)}
                  onColor={(color) => setSubjectColor(entry.key, color)}
                  canMoveUp={idx > 0}
                  canMoveDown={idx < arr.length - 1}
                  onMoveUp={() => idx > 0 && reorderSubject(entry.key, arr[idx - 1], "above")}
                  onMoveDown={() => idx < arr.length - 1 && reorderSubject(entry.key, arr[idx + 1], "below")}
                />
              ),
            )}
        </div>
      )}

      {/* THE NEW-AREA ZONE — home screen only; an area page already has a
          full path to file INTO by dropping on the page's own breadcrumb-
          named subtree, so no second naming zone is offered there. */}
      {!areaPath && (dragActive || newAreaDraft) && (
        <div className="mt-4" {...(newAreaDraft ? {} : newAreaDropProps)}>
          {newAreaDraft ? (
            <input
              autoFocus
              value={newAreaDraft.name}
              onChange={(event) => setNewAreaDraft({ ...newAreaDraft, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setNewAreaDraft(null);
                  return;
                }
                if (event.key === "Enter") {
                  const name = newAreaDraft.name.trim();
                  if (name) assignArea(newAreaDraft.subject, name);
                  setNewAreaDraft(null);
                }
              }}
              onBlur={() => setNewAreaDraft(null)}
              placeholder="Name this area…"
              aria-label="Name this area"
              className="w-full rounded-md border border-dashed border-border/60 bg-transparent px-2 py-1 text-center text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
            />
          ) : (
            <div
              className={cn(
                "rounded-md border border-dashed border-border/60 px-2 py-1 text-center text-xs text-muted-foreground/40 transition-colors",
                dragOver === "__new-area" && "border-spool/60 bg-muted/60 text-foreground",
              )}
            >
              Drop to start a new area&hellip;
            </div>
          )}
        </div>
      )}

      {refused && <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground/70">{refused}</p>}

      <AddTaskDialog
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
        subjects={subjectNames}
        lanes={lanes}
        {...(adding?.subject ? { defaultSubject: adding.subject } : {})}
        onCreated={() => {
          setAdding(null);
          void load();
          onChanged?.();
        }}
      />
    </div>
  );
}
