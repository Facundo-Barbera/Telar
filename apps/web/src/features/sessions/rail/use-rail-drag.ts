import { useState } from "react";
import { moveProjectGroup, moveSessionRow, PINNED_ROW_SCOPE, PROJECT_GROUP_MIME, SESSION_ROW_MIME } from "../session-groups";
import type { useSidebarLayout } from "./sidebar-layout";

type Layout = Pick<
  ReturnType<typeof useSidebarLayout>,
  "order" | "setOrder" | "sessionOrder" | "setSessionOrder" | "pinnedOrder" | "setPinnedOrder"
>;

/** Drag-to-reorder for project groups and for rows within one band. */
export function useRailDrag(
  { order: projectOrder, setOrder: setProjectOrder, sessionOrder, setSessionOrder, pinnedOrder, setPinnedOrder }: Layout,
  grouped: boolean,
  drawnGroupKeys: readonly string[],
) {
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupInsert, setGroupInsert] = useState<{ key: string; position: "above" | "below" } | null>(null);
  const [draggingRow, setDraggingRow] = useState<{ scope: string; key: string } | null>(null);
  const [rowInsert, setRowInsert] = useState<{ key: string; position: "above" | "below" } | null>(null);

  const onGroupDragStart = (key: string) => (event: React.DragEvent) => {
    event.dataTransfer.setData(PROJECT_GROUP_MIME, key);
    event.dataTransfer.effectAllowed = "move";
    setDraggingGroup(key);
  };
  const onGroupDragEnd = () => {
    setDraggingGroup(null);
    setGroupInsert(null);
  };
  const onGroupDragOver = (key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(PROJECT_GROUP_MIME)) return;
    if (draggingGroup === key) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setGroupInsert((current) => (current?.key === key && current.position === position ? current : { key, position }));
  };
  const onGroupDragLeave = (key: string) => () => setGroupInsert((current) => (current?.key === key ? null : current));
  const onGroupDrop = (key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(PROJECT_GROUP_MIME)) return;
    event.preventDefault();
    const dragged = event.dataTransfer.getData(PROJECT_GROUP_MIME) || draggingGroup;
    const position = groupInsert?.key === key ? groupInsert.position : "below";
    setDraggingGroup(null);
    setGroupInsert(null);
    if (!dragged || dragged === key || !grouped) return;
    void setProjectOrder(moveProjectGroup(projectOrder, drawnGroupKeys, dragged, key, position));
  };

  const onRowDragStart = (scope: string, key: string) => (event: React.DragEvent) => {
    event.dataTransfer.setData(SESSION_ROW_MIME, key);
    event.dataTransfer.effectAllowed = "move";
    setDraggingRow({ scope, key });
  };
  const onRowDragEnd = () => {
    setDraggingRow(null);
    setRowInsert(null);
  };
  const onRowDragOver = (scope: string, key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(SESSION_ROW_MIME)) return;
    if (!draggingRow || draggingRow.scope !== scope || draggingRow.key === key) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setRowInsert((current) => (current?.key === key && current.position === position ? current : { key, position }));
  };
  const onRowDragLeave = (key: string) => () => setRowInsert((current) => (current?.key === key ? null : current));
  const onRowDrop = (scope: string, drawn: readonly string[]) => (key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(SESSION_ROW_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const dragged = event.dataTransfer.getData(SESSION_ROW_MIME) || draggingRow?.key;
    const sameBand = draggingRow?.scope === scope;
    const position = rowInsert?.key === key ? rowInsert.position : "below";
    setDraggingRow(null);
    setRowInsert(null);
    if (!dragged || dragged === key || !sameBand) return;
    const next = moveSessionRow(scope === PINNED_ROW_SCOPE ? pinnedOrder : (sessionOrder[scope] ?? []), drawn, dragged, key, position);
    void (scope === PINNED_ROW_SCOPE ? setPinnedOrder(next) : setSessionOrder(scope, next));
  };
  const rowDrag = (scope: string, drawn: readonly string[]) => {
    const drop = onRowDrop(scope, drawn);
    return (key: string) => ({
      dragging: draggingRow?.key === key,
      insert: rowInsert?.key === key ? rowInsert.position : null,
      onDragStart: onRowDragStart(scope, key),
      onDragEnd: onRowDragEnd,
      onDragOver: onRowDragOver(scope, key),
      onDragLeave: onRowDragLeave(key),
      onDrop: drop(key),
    });
  };

  return { draggingGroup, groupInsert, onGroupDragStart, onGroupDragEnd, onGroupDragOver, onGroupDragLeave, onGroupDrop, rowDrag };
}
